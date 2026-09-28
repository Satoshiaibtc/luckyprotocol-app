// Web-hygiene tests (audit L-14 / L-15 / L-16): the generated _headers
// CSP, the canonical-host redirect and the VITE_SPEC_URL validator. Plain
// Node, no framework.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { buildHeaders, buildMiddleware, buildRoutes, FIXED_HEADERS, SECOND_SOURCE_ORIGIN, isAllowedIndexerUrl, parseDotenv } from "../scripts/gen-headers.mjs";
import { CANONICAL_HOST, canonicalRedirectTarget } from "../src/lib/canonicalHost.js";
import { isAllowedSpecUrl, resolveSpecUrl, DEFAULT_SPEC_URL } from "../src/lib/specUrl.js";
import { parseSpecConstants, specConstantMismatches, specUrlProblem } from "../scripts/check-spec.mjs";
import { MAX_OPEN_LISTINGS_PER_ADDRESS } from "../src/lib/listingRules.js";

// ---- L-14: _headers generated from VITE_INDEXER_URL ----------------------------------------------------
{
  const prod = buildHeaders({ indexerUrl: "https://app.luckyprotocolai.com/", mode: "production", strict: true });
  const csp = /Content-Security-Policy: (.*)/.exec(prod)[1];
  assert.equal(/connect-src ([^;]*)/.exec(csp)[1], "'self' https://app.luckyprotocolai.com https://mempool.space", "connect-src: self + the indexer + the M-12 second source, nothing else");
  assert.equal(/img-src ([^;]*)/.exec(csp)[1], "'self' data:", "img-src: no remote origin — token pictures are inline SVG identicons (avatars withdrawn, spec §8); neither the indexer nor mempool.space is an image origin");
  assert.equal(/style-src ([^;]*)/.exec(csp)[1], "'self'", "no 'unsafe-inline'");
  assert.equal(/script-src ([^;]*)/.exec(csp)[1], "'self'");
  assert.ok(!prod.includes("127.0.0.1") && !prod.includes("localhost"), "no loopback origins in a production CSP");
  assert.equal(SECOND_SOURCE_ORIGIN, "https://mempool.space");
  assert.equal((csp.match(/mempool\.space/g) || []).length, 1, "mempool.space appears in connect-src and nowhere else");
  assert.ok(!prod.includes("unsafe-inline"));
  assert.ok(prod.includes("Strict-Transport-Security") && prod.includes("frame-ancestors 'none'") && prod.includes("/assets/*"));
  // a loopback indexer is fine for a local / development build …
  const dev = buildHeaders({ indexerUrl: "http://127.0.0.1:8765", mode: "development" });
  assert.ok(/connect-src 'self' http:\/\/127\.0\.0\.1:8765 https:\/\/mempool\.space;/.test(dev));
  // … a warning (and loopback-only CSP) for a local production build, fatal on a deploy platform
  const warnings = [];
  const local = buildHeaders({ indexerUrl: "", mode: "production", strict: false, warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.ok(/connect-src 'self' http:\/\/127\.0\.0\.1:8765 https:\/\/mempool\.space;/.test(local));
  assert.throws(() => buildHeaders({ indexerUrl: "", mode: "production", strict: true }), /must name the real indexer/);
  assert.throws(() => buildHeaders({ indexerUrl: "http://evil.example", mode: "production", strict: true }), /must name the real indexer/, "http to a non-loopback host is rejected like the app does");
  assert.equal(isAllowedIndexerUrl("https://app.luckyprotocolai.com"), true);
  assert.equal(isAllowedIndexerUrl("http://localhost:8765"), true);
  assert.equal(isAllowedIndexerUrl("http://app.luckyprotocolai.com"), false);
  assert.equal(isAllowedIndexerUrl("javascript:alert(1)"), false);
  assert.deepEqual(parseDotenv('VITE_INDEXER_URL=https://x.example # c\nVITE_MOCK="1"\n# comment\nBAD LINE\nexport VITE_SPEC_URL=\'/spec.md\''), { VITE_INDEXER_URL: "https://x.example", VITE_MOCK: "1", VITE_SPEC_URL: "/spec.md" });
  console.log("headers: production CSP names the indexer origin in connect-src only (+ mempool.space); img-src same-origin; no loopback, no 'unsafe-inline'");
}

// ---- HTML document: the generated Pages Function = _headers + a per-response script-src nonce ------
{
  const opts = { indexerUrl: "https://app.luckyprotocolai.com/", mode: "production", strict: true };
  const src = buildMiddleware(opts);
  assert.ok(!src.includes("unsafe-inline") && !src.includes("127.0.0.1") && !src.includes("localhost"), "no 'unsafe-inline', no loopback in the production middleware");
  assert.ok(src.includes("https://app.luckyprotocolai.com"), "the indexer origin is baked in at build time");
  assert.deepEqual(JSON.parse(buildRoutes()), { version: 1, include: ["/"], exclude: [] }, "only the document invokes the Function (Pages 308-redirects /index.html to / before routing); assets keep the static _headers");
  assert.throws(() => buildMiddleware({ indexerUrl: "", mode: "production", strict: true }), /must name the real indexer/);
  const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  const seen = [];
  const html = async (req) => { seen.push(req); return new Response("<!doctype html><title>x</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=10, must-revalidate", "x-upstream": "kept" } }); };
  const conditional = () => new Request("https://luckyprotocolai.com/", { headers: { "if-none-match": '"etag"', "if-modified-since": "Fri, 26 Sep 2026 00:00:00 GMT", "accept": "text/html" } });
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
  assert.equal(CANONICAL_HOST, "luckyprotocolai.com");
  assert.equal(canonicalRedirectTarget({ hostname: "luckyprotocol-app.pages.dev", pathname: "/", search: "", hash: "#/token/LUCKY" }), "https://luckyprotocolai.com/#/token/LUCKY", "same path + hash on the canonical host");
  assert.equal(canonicalRedirectTarget({ hostname: "abc123.luckyprotocol-app.pages.dev", pathname: "/", hash: "#/me" }), "https://luckyprotocolai.com/#/me", "preview deployments too");
  assert.equal(canonicalRedirectTarget({ hostname: "LUCKYPROTOCOL-APP.PAGES.DEV", hash: "" }), "https://luckyprotocolai.com/", "case-insensitive");
  assert.equal(canonicalRedirectTarget({ hostname: "luckyprotocolai.com", hash: "#/x" }), null, "already canonical");
  assert.equal(canonicalRedirectTarget({ hostname: "localhost", hash: "#/x" }), null);
  assert.equal(canonicalRedirectTarget({ hostname: "evil.pages.dev.example", hash: "" }), null, "suffix match, not substring");
  assert.equal(canonicalRedirectTarget({ hostname: "luckyprotocol-app.pages.dev", dev: true }), null, "dev builds never redirect");
  assert.equal(canonicalRedirectTarget({ hostname: "luckyprotocol-app.pages.dev", mock: true }), null, "mock builds never redirect");
}

// ---- L-16: VITE_SPEC_URL validated like VITE_INDEXER_URL ---------------------------------------------------
{
  assert.equal(DEFAULT_SPEC_URL, "/PROTOCOL.md");
  assert.equal(isAllowedSpecUrl("/PROTOCOL.md"), true, "same-origin path");
  assert.equal(isAllowedSpecUrl("/docs/spec.md?v=3#s7"), true);
  assert.equal(isAllowedSpecUrl("https://docs.luckyprotocolai.com/PROTOCOL.md"), true, "https");
  assert.equal(isAllowedSpecUrl("http://docs.example/spec.md"), false, "plain http is not allowed");
  assert.equal(isAllowedSpecUrl("//evil.example/spec.md"), false, "protocol-relative is not a same-origin path");
  assert.equal(isAllowedSpecUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedSpecUrl("data:text/html,hi"), false);
  assert.equal(isAllowedSpecUrl("PROTOCOL.md"), false, "relative paths are not accepted");
  assert.equal(isAllowedSpecUrl("/a b"), false, "no whitespace");
  assert.equal(isAllowedSpecUrl(""), false);
  assert.equal(isAllowedSpecUrl(undefined), false);
  assert.equal(resolveSpecUrl("https://docs.luckyprotocolai.com/x.md"), "https://docs.luckyprotocolai.com/x.md");
  assert.equal(resolveSpecUrl("javascript:alert(1)"), DEFAULT_SPEC_URL, "invalid → default");
  assert.equal(resolveSpecUrl(""), DEFAULT_SPEC_URL);
  assert.equal(resolveSpecUrl(undefined), DEFAULT_SPEC_URL);
}

// ---- F7: a VITE_SPEC_URL that names no served file fails the build ---------------------------------------------
// The host answers an unknown path with the app page, so a stale same-origin
// value (an earlier spec file name) would open the app instead of the spec.
{
  const pub = join(dirname(fileURLToPath(import.meta.url)), "../public");
  assert.equal(specUrlProblem(undefined, pub), null, "unset: the default /PROTOCOL.md");
  assert.equal(specUrlProblem("", pub), null);
  assert.equal(specUrlProblem("/PROTOCOL.md", pub), null, "the served spec");
  assert.equal(specUrlProblem("/PROTOCOL.md#s7", pub), null, "a fragment is fine");
  assert.equal(specUrlProblem("https://docs.example/spec.md", pub), null, "another host is not checked");
  assert.match(specUrlProblem("/PROTOCOL-old.md", pub), /names no file in public/, "a stale file name fails");
  assert.match(specUrlProblem("/wallets", pub), /names no file in public/, "a directory is not the spec");
  assert.match(specUrlProblem("/", pub), /names no file in public/);
  assert.match(specUrlProblem("/../package.json", pub), /leaves public/);
  assert.match(specUrlProblem("http://docs.example/spec.md", pub), /neither an https URL/);
  assert.match(specUrlProblem("PROTOCOL.md", pub), /neither an https URL/);
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

// ---- the served spec is the indexer's canonical one ------------------------------------------------------
// public/PROTOCOL.md (DEFAULT_SPEC_URL) is a byte-identical copy of the
// indexer repo's PROTOCOL.md. When the sibling checkout is present (the
// LUCKY-20 workspace), a drifted copy fails the check; a lone app checkout
// (e.g. the Pages build) skips it.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const served = join(here, "../public/PROTOCOL.md");
  const canonical = join(here, "../../luckyprotocol-indexer/PROTOCOL.md");
  let canon = null;
  try {
    canon = readFileSync(canonical);
  } catch {
    console.log("spec copy: indexer checkout not beside the app — byte-identity check skipped");
  }
  if (canon) {
    assert.ok(readFileSync(served).equals(canon), "public/PROTOCOL.md must be a byte-identical copy of luckyprotocol-indexer/PROTOCOL.md");
    console.log("spec copy: public/PROTOCOL.md is byte-identical to the indexer's");
  }
}

// ---- the served spec's §1 table is what the app builds with (every build, audit web-2) --------------------
// scripts/check-spec.mjs runs in `prebuild`, so a Pages build fails when the
// code and the served spec copy disagree on a consensus constant — the gate
// that still holds where the byte-identity check above is skipped.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const payloads = await import("../src/lib/payloads.js");
  const served = readFileSync(join(here, "../public/PROTOCOL.md"), "utf8");
  assert.deepEqual(specConstantMismatches(served, payloads), [], "public/PROTOCOL.md §1 must match src/lib/payloads.js");
  const parsed = parseSpecConstants(served);
  assert.equal(parsed.SNAPSHOT_VERSION, payloads.SNAPSHOT_VERSION);
  assert.equal(parsed.ACTIVATION_HEIGHT, 969_300);
  // A stale copy (the pre-withdrawal revision) is caught by the constant it changed.
  const stale = served.replace(/\| `SNAPSHOT_VERSION` \| \d+ \|/, "| `SNAPSHOT_VERSION` | 15 |");
  assert.deepEqual(specConstantMismatches(stale, payloads), [`SNAPSHOT_VERSION: spec 15, code ${payloads.SNAPSHOT_VERSION}`]);
  assert.deepEqual(specConstantMismatches(served, { ...payloads, DEPLOY_PROTOCOL_FEE_SATS: 546 }), ["DEPLOY_PROTOCOL_FEE_SATS: spec 5460, code 546"]);
  assert.equal(payloads.FINAL_DEPTH, 6, "the finality depth is checked like every §1 constant");
  assert.deepEqual(specConstantMismatches(served, { ...payloads, FINAL_DEPTH: 3 }), ["FINAL_DEPTH: spec 6, code 3"]);
  assert.deepEqual(specConstantMismatches(served.replace(/\| `FINAL_DEPTH` \| 6 \|/, "| `FINAL_DEPTH` | 12 |"), payloads), ["FINAL_DEPTH: spec 12, code 6"], "a spec edit alone fails too");
  assert.throws(() => parseSpecConstants("# no constants"), /constants section/);
  console.log("spec constants: the served spec's §1 table matches payloads.js; a drifted constant fails the build");
}

// ---- the served spec states the protocol only ----------------------------------------------------------------
// The indexer's HTTP interface is not part of the protocol and is not
// published (PROTOCOL.md §5): no route, HTTP header or pointer to the
// indexer's private API notes may appear in the served spec.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const served = readFileSync(join(here, "../public/PROTOCOL.md"), "utf8");
  const DENY = [
    "GET /", "POST /", "HEAD /", "OPTIONS /", "Retry-After", "Cache-Control", "Access-Control", "CORS",
    "docs/API.md", "robots.txt", "ALLOWED_ORIGINS", "/health", "/balances", "/utxos", "/btc-utxos",
    "/mines", "/transfers", "/commits", "/tokens", "/activity", "/price", "/tx-status", "/block-",
    "/blocks", "/digits", "/fees", "/broadcast", "/orders", "/trades", "/deploys", "/avatars",
  ];
  const hits = [];
  served.split("\n").forEach((line, i) => {
    for (const d of DENY) if (line.includes(d)) hits.push(`public/PROTOCOL.md:${i + 1}: ${d}`);
  });
  assert.deepEqual(hits, [], "the served spec names no HTTP route or header");
  assert.ok(served.includes("\n## 5. Indexer interface\n"), "§5 keeps its number and says the interface is not part of the protocol");
  console.log("spec scope: the served spec names no indexer route or HTTP header");
}

// ---- the served spec's order-book caps agree with each other and with the app --------------------------------
// §7.4 states each cap once in bold; every other cap number or open-order
// count in §7.4 must be one of those (a stale number left in the conditions
// list fails here), and the per-seller cap is the one the sell form enforces.
// The indexer's own tests hold the same numbers to its constants.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const served = readFileSync(join(here, "../public/PROTOCOL.md"), "utf8");
  const start = served.indexOf("\n### 7.4 ");
  const end = served.indexOf("\n### 7.5 ", start);
  assert.ok(start >= 0 && end > start, "§7.4 and §7.5 exist");
  const s74 = served.slice(start, end).split(/\s+/).join(" ");
  const stated = (re, what) => {
    const m = re.exec(s74);
    assert.ok(m, `§7.4 states the ${what}`);
    return m[1];
  };
  const global = stated(/\*\*Global cap (\d[\d,]*)\*\* orders/, "global cap");
  const ticker = stated(/\*\*Per-ticker cap (\d[\d,]*) open orders\*\*/, "per-ticker cap");
  const seller = stated(/\*\*Per-seller cap (\d[\d,]*) open orders\*\*/, "per-seller cap");
  assert.equal(seller, MAX_OPEN_LISTINGS_PER_ADDRESS.toLocaleString("en-US"), "the spec's per-seller cap is the app's MAX_OPEN_LISTINGS_PER_ADDRESS");
  for (const needle of [`keeps a ticker's ${ticker} best asks`, `already has ${seller} open listings`, `has fewer than ${seller} open orders`]) {
    assert.ok(s74.includes(needle), `§7.4 states ${JSON.stringify(needle)}`);
  }
  const allowed = new Set([global, ticker, seller]);
  const clean = (n) => n.replace(/,+$/, "");
  for (const m of s74.matchAll(/\bcap \**(\d[\d,]*)/g)) assert.ok(allowed.has(clean(m[1])), `§7.4 names a cap of ${m[1]}`);
  for (const m of s74.matchAll(/(\d[\d,]*)\** open (?:orders|listings)/g)) assert.ok(allowed.has(clean(m[1])), `§7.4 counts ${m[0]}`);
  console.log(`spec caps: global ${global}, per ticker ${ticker}, per seller ${seller} (= the app's), no other cap number in §7.4`);
}

// ---- robots.txt: search engines only, served as a plain static file ------------------------------------------
{
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, "../public/robots.txt"), "utf8");
  // RFC 9309 groups: one or more user-agent lines, then that group's rules.
  const groups = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    assert.ok(m, `robots.txt: unparseable line ${JSON.stringify(raw)}`);
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!cur || cur.rules.length) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
    } else {
      assert.ok(cur, "robots.txt: a rule before any user-agent line");
      cur.rules.push(`${key}: ${value}`);
    }
  }
  const agents = groups.flatMap((g) => g.agents);
  assert.equal(new Set(agents).size, agents.length, "each user-agent is named once");
  // A crawler obeys the group naming it, else the `*` group.
  const rulesFor = (agent) => {
    const a = agent.toLowerCase();
    const g = groups.find((x) => x.agents.includes(a)) || groups.find((x) => x.agents.includes("*"));
    return g ? g.rules : [];
  };
  for (const a of ["Googlebot", "Bingbot", "Baiduspider"]) assert.deepEqual(rulesFor(a), ["allow: /"], a);
  const AI_AGENTS = ["Google-Extended", "GPTBot", "ChatGPT-User", "CCBot", "ClaudeBot", "anthropic-ai", "PerplexityBot", "Bytespider", "Amazonbot", "Applebot-Extended", "meta-externalagent"];
  for (const a of AI_AGENTS) {
    assert.ok(agents.includes(a.toLowerCase()), `${a} is named explicitly`);
    assert.deepEqual(rulesFor(a), ["disallow: /"], a);
  }
  assert.deepEqual(rulesFor("*"), ["disallow: /"], "the default group refuses everything");
  assert.deepEqual(rulesFor("SomeScraper/1.0"), ["disallow: /"], "any other crawler is refused");
  // Pages serves public/robots.txt from dist/ as a static asset: the Pages
  // Function owns "/" only (_routes.json), and no _redirects rule matches it.
  const routes = JSON.parse(buildRoutes());
  const pagesMatch = (pattern, path) => (pattern.endsWith("/*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path);
  assert.ok(!routes.include.some((p) => pagesMatch(p, "/robots.txt")), "the Pages Function never handles /robots.txt");
  const redirects = readFileSync(join(here, "../public/_redirects"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const rule of redirects) {
    const source = rule.split(/\s+/)[0];
    const re = new RegExp(`^${source.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    assert.ok(!re.test("/robots.txt"), `_redirects rule "${rule}" would catch /robots.txt`);
  }
  console.log(`robots: Googlebot, Bingbot, Baiduspider allowed; ${AI_AGENTS.length} AI agents and every other crawler refused; a static file outside the Function route`);
}

console.log("web: headers, canonical host, spec URL, spec scope, spec caps, robots ok");
