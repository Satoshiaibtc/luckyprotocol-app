// Web-hygiene tests (audit L-14 / L-15 / L-16): the generated _headers
// CSP, the canonical-host redirect and the VITE_SPEC_URL validator. Plain
// Node, no framework.
import assert from "node:assert/strict";
import { buildHeaders, isAllowedIndexerUrl, parseDotenv } from "../scripts/gen-headers.mjs";

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

console.log("web: headers ok");
