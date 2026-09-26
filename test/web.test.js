// Web-hygiene tests (audit L-14 / L-15 / L-16): the generated _headers
// CSP, the canonical-host redirect and the VITE_SPEC_URL validator. Plain
// Node, no framework.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { buildHeaders, buildMiddleware, buildRoutes, FIXED_HEADERS, isAllowedIndexerUrl, parseDotenv } from "../scripts/gen-headers.mjs";
import { CANONICAL_HOST, canonicalRedirectTarget } from "../src/lib/canonicalHost.js";
import { isAllowedSpecUrl, resolveSpecUrl, DEFAULT_SPEC_URL } from "../src/lib/specUrl.js";

// ---- L-14: _headers generated from VITE_INDEXER_URL ----------------------------------------------------
{
  const prod = buildHeaders({ indexerUrl: "https://luckyprotocolai.com/", mode: "production", strict: true });
  const csp = /Content-Security-Policy: (.*)/.exec(prod)[1];
  assert.equal(/connect-src ([^;]*)/.exec(csp)[1], "'self' https://luckyprotocolai.com", "connect-src: self + the indexer, nothing else");
  assert.equal(/img-src ([^;]*)/.exec(csp)[1], "'self' data: blob: https://luckyprotocolai.com");
  assert.equal(/style-src ([^;]*)/.exec(csp)[1], "'self'", "no 'unsafe-inline'");
  assert.equal(/script-src ([^;]*)/.exec(csp)[1], "'self'");
  assert.ok(!prod.includes("127.0.0.1") && !prod.includes("localhost"), "no loopback origins in a production CSP");
  assert.ok(!prod.includes("mempool.space"), "mempool.space is a link target only — not in the CSP");
  assert.ok(!prod.includes("unsafe-inline"));
  assert.ok(prod.includes("Strict-Transport-Security") && prod.includes("frame-ancestors 'none'") && prod.includes("/assets/*"));
  // a loopback indexer is fine for a local / development build …
  const dev = buildHeaders({ indexerUrl: "http://127.0.0.1:8765", mode: "development" });
  assert.ok(/connect-src 'self' http:\/\/127\.0\.0\.1:8765;/.test(dev));
  // … a warning (and loopback-only CSP) for a local production build, fatal on a deploy platform
  const warnings = [];
  const local = buildHeaders({ indexerUrl: "", mode: "production", strict: false, warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.ok(/connect-src 'self' http:\/\/127\.0\.0\.1:8765;/.test(local));
  assert.throws(() => buildHeaders({ indexerUrl: "", mode: "production", strict: true }), /must name the real indexer/);
  assert.throws(() => buildHeaders({ indexerUrl: "http://evil.example", mode: "production", strict: true }), /must name the real indexer/, "http to a non-loopback host is rejected like the app does");
  assert.equal(isAllowedIndexerUrl("https://luckyprotocolai.com"), true);
  assert.equal(isAllowedIndexerUrl("http://localhost:8765"), true);
  assert.equal(isAllowedIndexerUrl("http://luckyprotocolai.com"), false);
  assert.equal(isAllowedIndexerUrl("javascript:alert(1)"), false);
  assert.deepEqual(parseDotenv('VITE_INDEXER_URL=https://x.example # c\nVITE_MOCK="1"\n# comment\nBAD LINE\nexport VITE_SPEC_URL=\'/spec.md\''), { VITE_INDEXER_URL: "https://x.example", VITE_MOCK: "1", VITE_SPEC_URL: "/spec.md" });
  console.log("headers: production CSP names only the indexer origin; no loopback, no mempool.space, no 'unsafe-inline'");
}

// ---- HTML document: the generated Pages Function = _headers + a per-response script-src nonce ------
{
  const opts = { indexerUrl: "https://luckyprotocolai.com/", mode: "production", strict: true };
  const src = buildMiddleware(opts);
  assert.ok(!src.includes("unsafe-inline") && !src.includes("127.0.0.1") && !src.includes("localhost"), "no 'unsafe-inline', no loopback in the production middleware");
  assert.ok(src.includes("https://luckyprotocolai.com"), "the indexer origin is baked in at build time");
  assert.deepEqual(JSON.parse(buildRoutes()), { version: 1, include: ["/"], exclude: [] }, "only the document invokes the Function (Pages 308-redirects /index.html to / before routing); assets keep the static _headers");
  assert.throws(() => buildMiddleware({ indexerUrl: "", mode: "production", strict: true }), /must name the real indexer/);
  const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  const seen = [];
  const html = async (req) => { seen.push(req); return new Response("<!doctype html><title>x</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=10, must-revalidate", "x-upstream": "kept" } }); };
  const conditional = () => new Request("https://app.luckyprotocolai.com/", { headers: { "if-none-match": '"etag"', "if-modified-since": "Fri, 26 Sep 2026 00:00:00 GMT", "accept": "text/html" } });
  const a = await mod.onRequest({ request: conditional(), next: html });
  const b = await mod.onRequest({ request: conditional(), next: html });
  assert.equal(seen.length, 2);
  for (const req of seen) {
    assert.equal(req.headers.get("if-none-match"), null, "conditional headers are stripped so a revalidating cache never gets a 304 with a stale nonce");
    assert.equal(req.headers.get("if-modified-since"), null);
    assert.equal(req.headers.get("accept"), "text/html", "other request headers survive");
  }
  const cspA = a.headers.get("content-security-policy");
  const nonceA = /script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/.exec(cspA)?.[1];
  const nonceB = /script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/.exec(b.headers.get("content-security-policy"))?.[1];
  assert.ok(nonceA && nonceB && nonceA !== nonceB, "a fresh nonce on every response");
  assert.equal(nonceA.length, 24, "16 random bytes, base64");
  assert.equal((cspA.match(/nonce-/g) || []).length, 1, "the nonce extends script-src only");
  const staticCsp = /Content-Security-Policy: (.*)/.exec(buildHeaders(opts))[1];
  assert.equal(cspA.replace(` 'nonce-${nonceA}'`, ""), staticCsp, "otherwise byte-identical to the static CSP");
  for (const [name, value] of FIXED_HEADERS) assert.equal(a.headers.get(name), value, `${name} set by the Function`);
  assert.equal(a.headers.get("x-upstream"), "kept", "upstream headers survive");
  assert.equal(a.headers.get("cache-control"), "no-store", "a nonce is single-use: Pages' public max-age=10 (edge-shared) is replaced");
  assert.equal(a.status, 200);
  assert.equal(await a.text(), "<!doctype html><title>x</title>", "body passes through");
  const asset = new Response("body{}", { headers: { "content-type": "text/css" } });
  assert.equal(await mod.onRequest({ request: conditional(), next: async () => asset }), asset, "non-HTML responses are returned untouched");
  const redirect = new Response(null, { status: 301, headers: { location: "/" } });
  assert.equal(await mod.onRequest({ request: conditional(), next: async () => redirect }), redirect, "redirects too");
  const notModified = new Response(null, { status: 304, headers: { "content-type": "text/html; charset=utf-8", etag: '"x"' } });
  assert.equal(await mod.onRequest({ request: conditional(), next: async () => notModified }), notModified, "a 304 keeps the browser's stored nonce pair (body + CSP) intact");
  console.log("middleware: the document gets the static header set plus a per-response script-src nonce; assets untouched");
}

// ---- L-15: *.pages.dev → canonical host ------------------------------------------------------------------
{
  assert.equal(CANONICAL_HOST, "app.luckyprotocolai.com");
  assert.equal(canonicalRedirectTarget({ hostname: "luckyprotocol-app.pages.dev", pathname: "/", search: "", hash: "#/token/LUCKY" }), "https://app.luckyprotocolai.com/#/token/LUCKY", "same path + hash on the canonical host");
  assert.equal(canonicalRedirectTarget({ hostname: "abc123.luckyprotocol-app.pages.dev", pathname: "/", hash: "#/me" }), "https://app.luckyprotocolai.com/#/me", "preview deployments too");
  assert.equal(canonicalRedirectTarget({ hostname: "LUCKYPROTOCOL-APP.PAGES.DEV", hash: "" }), "https://app.luckyprotocolai.com/", "case-insensitive");
  assert.equal(canonicalRedirectTarget({ hostname: "app.luckyprotocolai.com", hash: "#/x" }), null, "already canonical");
  assert.equal(canonicalRedirectTarget({ hostname: "localhost", hash: "#/x" }), null);
  assert.equal(canonicalRedirectTarget({ hostname: "evil.pages.dev.example", hash: "" }), null, "suffix match, not substring");
  assert.equal(canonicalRedirectTarget({ hostname: "luckyprotocol-app.pages.dev", dev: true }), null, "dev builds never redirect");
  assert.equal(canonicalRedirectTarget({ hostname: "luckyprotocol-app.pages.dev", mock: true }), null, "mock builds never redirect");
}

// ---- L-16: VITE_SPEC_URL validated like VITE_INDEXER_URL ---------------------------------------------------
{
  assert.equal(DEFAULT_SPEC_URL, "/PROTOCOL-v3.md");
  assert.equal(isAllowedSpecUrl("/PROTOCOL-v3.md"), true, "same-origin path");
  assert.equal(isAllowedSpecUrl("/docs/spec.md?v=3#s7"), true);
  assert.equal(isAllowedSpecUrl("https://docs.luckyprotocolai.com/PROTOCOL-v3.md"), true, "https");
  assert.equal(isAllowedSpecUrl("http://docs.example/spec.md"), false, "plain http is not allowed");
  assert.equal(isAllowedSpecUrl("//evil.example/spec.md"), false, "protocol-relative is not a same-origin path");
  assert.equal(isAllowedSpecUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedSpecUrl("data:text/html,hi"), false);
  assert.equal(isAllowedSpecUrl("PROTOCOL-v3.md"), false, "relative paths are not accepted");
  assert.equal(isAllowedSpecUrl("/a b"), false, "no whitespace");
  assert.equal(isAllowedSpecUrl(""), false);
  assert.equal(isAllowedSpecUrl(undefined), false);
  assert.equal(resolveSpecUrl("https://docs.luckyprotocolai.com/x.md"), "https://docs.luckyprotocolai.com/x.md");
  assert.equal(resolveSpecUrl("javascript:alert(1)"), DEFAULT_SPEC_URL, "invalid → default");
  assert.equal(resolveSpecUrl(""), DEFAULT_SPEC_URL);
  assert.equal(resolveSpecUrl(undefined), DEFAULT_SPEC_URL);
}

// ---- fee-rate gates: fractional sat/vB must never be refused by an integer check ------------------------
// The indexer's /fees returns hundredths (1.02, 2.38); every spend gate goes
// through isUsableFeeRate (src/lib/feechoice.js). Walks src/**/*.{js,jsx}
// like test/vocab.test.js so a stale `Number.isInteger(rate)` cannot return.
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(js|jsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const INTEGER_GATES = [/Number\.isInteger\((feeRate|feeRateSatVb|satVb|rate)\b/, /Number\.isInteger\(v\) \|\| v < 1/];
  const hits = [];
  for (const p of walk(join(ROOT, "src"))) {
    const text = readFileSync(p, "utf8");
    for (const re of INTEGER_GATES) if (re.test(text)) hits.push(`${relative(ROOT, p).split(sep).join("/")}: ${re}`);
  }
  assert.deepEqual(hits, [], "integer fee-rate gates in src/ (use isUsableFeeRate)");
  console.log("fee gates: no Number.isInteger() fee-rate check in src/");
}

console.log("web: headers, canonical host, spec URL ok");
