#!/usr/bin/env node
// Generate the Cloudflare Pages deployment files for the build output from
// the SAME environment Vite built with (audit L-14):
//
//   npm run build   →   vite build && node scripts/gen-headers.mjs
//
//   dist/_headers             security headers for every static response
//   dist/_routes.json         which paths invoke the Pages Function ("/" only)
//   functions/_middleware.js  the Pages Function that serves the HTML
//                             document with the same headers plus a fresh
//                             per-response CSP nonce (generated, gitignored)
//
// The Content-Security-Policy's connect-src / img-src list exactly one
// remote origin: the indexer named by VITE_INDEXER_URL. Nothing else is
// ever fetched or loaded (fonts are self-hosted; mempool.space is a link
// target only and needs no CSP entry). A production build therefore
// carries no loopback origins; a loopback VITE_INDEXER_URL (a local
// build pointed at a local indexer) is listed as such. style-src is
// 'self' without 'unsafe-inline': React writes the few dynamic styles
// through the CSSOM (element.style), which CSP does not restrict, and
// there are no <style> elements or style="" attributes in the markup.
//
// Why the HTML document is served by a Pages Function: Bot Fight Mode's
// JavaScript Detections inject an inline bootstrap <script> into every HTML
// response (it loads /cdn-cgi/challenge-platform/scripts/jsd/main.js). A
// nonce-less `script-src 'self'` blocks that bootstrap — a CSP error on
// every page load and no bot signal. Cloudflare's documented fix is a CSP
// nonce: it parses the nonce from the response's Content-Security-Policy
// header and stamps it on the script it injects; 'unsafe-inline' is
// explicitly discouraged and a hash cannot work because the bootstrap
// embeds a per-request ray id. A nonce must be fresh per response, which a
// static _headers file cannot provide, and _headers rules are not applied
// to responses that pass through a Pages Function — so the generated
// middleware sets the complete header set itself, with the nonce, for the
// one route it owns. Static assets never touch the Function (_routes.json)
// and keep the plain _headers rules, including the immutable cache.
//
// Operator note: "/" is now a Pages Function request and counts toward the
// account's Workers plan quota (Workers Free: 100,000 requests/day,
// account-wide; when exceeded Cloudflare answers error 1027 and the
// document is unavailable until the daily reset; static assets are
// unaffected). Fallback if that ever bites: temporarily stop generating
// functions/_middleware.js + _routes.json (or upgrade to Workers Paid).
//
// Env resolution mirrors Vite (.env, .env.<mode>, .env.local,
// .env.<mode>.local; process.env wins). Mode: --mode <m>, else MODE, else
// "production". Output: --out <path> (default dist/_headers; _routes.json
// goes next to it), --functions-out <path> (default functions/_middleware.js).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_INDEXER_URL = "http://127.0.0.1:8765";

/** https with a hostname, or http to a loopback host — same rule as src/lib/indexer.js. */
export function isAllowedIndexerUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.hostname.length === 0) return false;
  if (u.protocol === "https:") return true;
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return u.protocol === "http:" && loopback;
}

/** Minimal .env parser (KEY=value, optional quotes, # comments). */
export function parseDotenv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/** Vite's precedence: .env < .env.<mode> < .env.local < .env.<mode>.local < process.env. */
export function loadEnv(mode, dir, processEnv = process.env) {
  const files = [".env", `.env.${mode}`, ".env.local", `.env.${mode}.local`];
  let env = {};
  for (const f of files) {
    const p = join(dir, f);
    if (existsSync(p)) env = { ...env, ...parseDotenv(readFileSync(p, "utf8")) };
  }
  for (const [k, v] of Object.entries(processEnv)) if (k.startsWith("VITE_")) env[k] = v;
  return env;
}

/**
 * The origin the CSP names. `indexerUrl` is validated exactly like the app
 * validates it; an invalid or missing value falls back to the app's default
 * (loopback) — which in production mode is an error, because such a bundle
 * talks to nothing: fatal when `strict` (a deploy platform: Cloudflare Pages
 * sets CF_PAGES, most CI sets CI), otherwise a loud warning, because a local
 * `npm run build` only ever runs against a local indexer.
 */
export function resolveOrigin({ indexerUrl, mode = "production", strict = false, warn = () => {} } = {}) {
  const configured = String(indexerUrl || "").trim();
  const url = configured && isAllowedIndexerUrl(configured) ? configured : DEFAULT_INDEXER_URL;
  const origin = new URL(url).origin;
  if (mode === "production" && origin.startsWith("http:")) {
    const msg = `gen-headers: VITE_INDEXER_URL="${configured || "(unset)"}" is not an https origin — a production build must name the real indexer`;
    if (strict) throw new Error(msg);
    warn(`${msg} (writing a loopback-only CSP for this local build)`);
  }
  return origin;
}

/** `opts.origin` when the caller resolved it already, else resolveOrigin(opts). */
function originOf(opts) {
  return opts.origin || resolveOrigin(opts);
}

/** The script-src directive; the generated middleware appends its per-response nonce to exactly this. */
export const SCRIPT_SRC = "script-src 'self'";

/** CSP directives for a build. Pure: (origin, nonce?) → string[]; a nonce extends script-src only. */
export function cspDirectives(origin, nonce = null) {
  return [
    "default-src 'self'",
    nonce ? `${SCRIPT_SRC} 'nonce-${nonce}'` : SCRIPT_SRC,
    "style-src 'self'",
    `img-src 'self' data: blob: ${origin}`,
    "font-src 'self' data:",
    `connect-src 'self' ${origin}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ];
}

/** The non-CSP security headers — the same on every response, static or Function-served. */
export const FIXED_HEADERS = [
  ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=(), bluetooth=()"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
];

/** The `_headers` text for a build. Pure: { origin | indexerUrl, mode } → string. */
export function buildHeaders(opts = {}) {
  const origin = originOf(opts);
  const mode = opts.mode ?? "production";
  const csp = cspDirectives(origin).join("; ");
  return [
    "# GENERATED by scripts/gen-headers.mjs at build time — do not edit; change the script.",
    `# mode=${mode} indexer=${origin}`,
    "#",
    "# LuckyProtocol web holds NO keys (signing is delegated to the wallet),",
    "# but a strict CSP still matters: an XSS could swap the PSBT the user is",
    "# asked to sign, or repoint indexer reads at a poisoned origin. The bundle",
    "# is fully self-contained (fonts via @fontsource, no CDNs, no inline",
    "# scripts or styles), so script-src and style-src are 'self' only and the",
    "# only remote origin is the indexer (connect-src for reads, img-src for",
    "# token avatars served by it).",
    "#",
    "# The HTML document itself is served by functions/_middleware.js (see",
    "# _routes.json), which sets these same headers plus a per-response",
    "# script-src nonce for the script Cloudflare's bot detection injects.",
    "",
    "/*",
    `  Content-Security-Policy: ${csp}`,
    ...FIXED_HEADERS.map(([name, value]) => `  ${name}: ${value}`),
    "",
    "# Hashed JS/CSS chunks in /assets/ are content-addressed (Vite appends a",
    "# hash to the filename), so they can be cached forever.",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n");
}

/**
 * `_routes.json`: only the HTML document invokes the Pages Function. Every
 * other path (hashed assets, the spec, the favicon) is served as a plain
 * static asset with the _headers rules above and never counts against the
 * Functions quota. "/" alone: Pages 308-redirects /index.html to / at the
 * asset layer, so routing it too would only spend an invocation on a
 * redirect.
 */
export function buildRoutes() {
  return `${JSON.stringify({ version: 1, include: ["/"], exclude: [] }, null, 2)}\n`;
}

/**
 * `functions/_middleware.js` source for a build. Pure: the same inputs as
 * buildHeaders → JavaScript text (a Cloudflare Pages Function, Web APIs
 * only). The header set is baked in at build time so the Function needs no
 * runtime configuration; only the nonce is computed per response.
 */
export function buildMiddleware(opts = {}) {
  const origin = originOf(opts);
  const mode = opts.mode ?? "production";
  return [
    "// GENERATED by scripts/gen-headers.mjs at build time — do not edit; change the script.",
    `// mode=${mode} indexer=${origin}`,
    "//",
    "// Cloudflare Pages Function for the HTML document only (dist/_routes.json",
    '// sends "/" here; every other path is a plain static asset). _headers rules',
    "// are not applied to responses that pass through a Function, so this sets",
    "// the same security headers as dist/_headers itself — with a fresh CSP",
    "// nonce in script-src on every response. Cloudflare reads that nonce from",
    "// the Content-Security-Policy header and stamps it on the inline bootstrap",
    "// that Bot Fight Mode's JavaScript Detections inject (it then loads",
    "// /cdn-cgi/challenge-platform/scripts/jsd/main.js, allowed by 'self'). The",
    "// bundle has no inline scripts of its own; the nonce is the only widening.",
    `const CSP_DIRECTIVES = ${JSON.stringify(cspDirectives(origin))};`,
    `const SCRIPT_SRC = ${JSON.stringify(SCRIPT_SRC)};`,
    `const FIXED_HEADERS = ${JSON.stringify(FIXED_HEADERS)};`,
    "",
    "// 16 random bytes, base64 — the CSP nonce grammar (base64-value).",
    "function freshNonce() {",
    "  const bytes = new Uint8Array(16);",
    "  crypto.getRandomValues(bytes);",
    '  let bin = "";',
    "  for (const b of bytes) bin += String.fromCharCode(b);",
    "  return btoa(bin);",
    "}",
    "",
    "export async function onRequest(context) {",
    "  // Never answer a conditional request with a 304: a cache revalidating",
    "  // the document (the edge does, for every visitor) would otherwise keep",
    "  // its stale copy and its stale nonce. A fresh 200 carries a fresh nonce.",
    "  const request = new Request(context.request);",
    "  request.headers.delete(\"if-none-match\");",
    "  request.headers.delete(\"if-modified-since\");",
    "  const upstream = await context.next(request);",
    '  const type = (upstream.headers.get("content-type") || "").toLowerCase();',
    "  // Only a 200 HTML document gets a nonce. Redirects pass through, and so",
    "  // does a 304: the browser then keeps its stored copy, whose injected",
    "  // script and stored CSP already share one nonce (a new nonce on the 304",
    "  // alone would mismatch them).",
    '  if (upstream.status !== 200 || !type.startsWith("text/html")) return upstream;',
    "  const nonce = freshNonce();",
    "  const csp = CSP_DIRECTIVES.map((d) => (d === SCRIPT_SRC ? d + \" 'nonce-\" + nonce + \"'\" : d)).join(\"; \");",
    "  const headers = new Headers(upstream.headers);",
    '  headers.set("Content-Security-Policy", csp);',
    "  for (const [name, value] of FIXED_HEADERS) headers.set(name, value);",
    "  // A nonce is single-use: this response must never be served from a",
    "  // shared cache (Pages' default for HTML is public, max-age=10, which the",
    "  // edge does serve to other visitors). The document is under 1 KB.",
    '  headers.set("Cache-Control", "no-store");',
    "  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });",
    "}",
    "",
  ].join("\n");
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const mode = opt("--mode") || process.env.MODE || "production";
  const headersOut = resolve(root, opt("--out") || "dist/_headers");
  const routesOut = resolve(dirname(headersOut), "_routes.json");
  const functionsOut = resolve(root, opt("--functions-out") || "functions/_middleware.js");
  const env = loadEnv(mode, root);
  const strict = !!(process.env.CF_PAGES || process.env.CI);
  const origin = resolveOrigin({ indexerUrl: env.VITE_INDEXER_URL, mode, strict, warn: (m) => console.warn(m) });
  write(headersOut, buildHeaders({ origin, mode }));
  write(routesOut, buildRoutes());
  write(functionsOut, buildMiddleware({ origin, mode }));
  console.log(`gen-headers: wrote ${headersOut}, ${routesOut} and ${functionsOut} (mode=${mode}, indexer=${origin})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
