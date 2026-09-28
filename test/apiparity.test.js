// API envelope parity (audit F1). The indexer once answered the global
// `GET /mines` with `{ total, limit, offset, mines }` while its route
// table, this app and its mock all used `items`. The mock followed the
// table, so every test passed while the real site showed no mines at all.
// Three checks keep the three sides together:
//
//   1. every route the mock serves carries every top-level key the
//      indexer's route table names, read from the indexer checkout when
//      it sits beside this one; without it (a Pages build) this check is
//      skipped with a note;
//   2. the app's readers, fed the mock through the real HTTP code path,
//      return rows (a reader that reads a key the table does not name
//      gets none);
//   3. the global /mines envelope names its page `items`, never `mines`.
//
// Plain Node, no framework.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mockGet, MOCK_WALLET } from "../src/lib/mock.js";
import * as indexer from "../src/lib/indexer.js";

const API_DOC = new URL("../../luckyprotocol-indexer/docs/API.md", import.meta.url);
const TABLE = existsSync(API_DOC) ? readFileSync(API_DOC, "utf8") : null;

/** Top-level keys of the JSON object the route-table row for `GET <route>` documents. */
function specKeys(route) {
  const head = `| \`GET ${route}\` | \`{`;
  const row = TABLE.split("\n").find((l) => l.startsWith(head));
  assert.ok(row, `the indexer's route table has no row for GET ${route}`);
  const pieces = [""];
  let depth = 0;
  for (const ch of row.slice(head.length)) {
    if ((ch === "}" || ch === "]") && depth === 0) break;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      pieces.push("");
      continue;
    }
    pieces[pieces.length - 1] += ch;
  }
  const keys = pieces.map((p) => p.split(":")[0].trim()).filter((k) => k && k !== "…" && k !== "...");
  assert.ok(keys.length > 0, `the row for GET ${route} names no key`);
  return keys;
}

const ADDR = MOCK_WALLET.address;

// ---- 1. mock envelopes carry every key the spec row names -----------------------------------------
const ROUTES = [
  ["/mines?limit=5", "/mines?limit&offset&ticker"],
  ["/mines?ticker=LUCKY", "/mines?limit&offset&ticker"],
  [`/mines/${ADDR}?limit=5`, "/mines/:addr?limit&offset"],
  [`/transfers/${ADDR}`, "/transfers/:addr?limit&offset"],
  ["/tokens", "/tokens?limit&offset&deployer"],
  ["/tokens/LUCKY/holders", "/tokens/:ticker/holders?limit&offset"],
  ["/activity", "/activity?limit&offset&kind&address"],
  ["/activity/daily?days=7", "/activity/daily?days=N"],
  [`/balances/${ADDR}`, "/balances/:addr"],
  [`/utxos/${ADDR}`, "/utxos/:addr"],
  ["/orders", "/orders?ticker&status&limit&offset"],
  [`/orders/by-address/${ADDR}`, "/orders/by-address/:addr?limit&offset"],
  ["/trades", "/trades?ticker&limit&offset"],
  [`/trades/${ADDR}`, "/trades/:addr?limit&offset"],
  ["/blocks/recent?limit=4", "/blocks/recent?limit"],
];
for (const [path, route] of ROUTES) {
  const env = await mockGet(path);
  assert.ok(env && typeof env === "object" && !Array.isArray(env), `${path}: not an object`);
  if (!TABLE) continue;
  const missing = specKeys(route).filter((k) => !(k in env));
  assert.deepEqual(missing, [], `mock ${path} lacks ${missing.join(", ")} of the route-table row for GET ${route}`);
}
if (!TABLE) {
  console.log("apiparity: indexer checkout not beside the app — route-table key checks skipped (mock and reader checks still run)");
}

// ---- 3. the global feed is `items`, the per-address list is `mines` ----------------------------------
if (TABLE) {
  assert.deepEqual(specKeys("/mines?limit&offset&ticker").sort(), ["items", "limit", "offset", "total"]);
  assert.ok(specKeys("/mines/:addr?limit&offset").includes("mines"));
}
{
  const env = await mockGet("/mines?limit=5");
  assert.ok(Array.isArray(env.items) && env.items.length > 0, "the mock feed has rows");
  assert.equal("mines" in env, false, "the global feed never names its page `mines`");
}

// ---- 2. the readers get rows through the real HTTP path ----------------------------------------------
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const body = await mockGet(u.pathname + u.search);
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
};
{
  const feed = await indexer.minesFeed({ limit: 5 });
  assert.ok(feed.total > 0 && feed.items.length > 0, "minesFeed reads the rows of GET /mines");
  const byTicker = await indexer.minesFeed({ limit: 5, ticker: "LUCKY" });
  assert.ok(byTicker.items.length > 0 && byTicker.items.every((r) => r.ticker === "LUCKY"), "minesFeed with a ticker filter");
  const mine = await indexer.minesByAddress(ADDR, { limit: 5 });
  assert.ok(mine.items.length > 0, "minesByAddress reads `mines` of GET /mines/:addr");
  assert.ok((await indexer.tokens({ limit: 5 })).items.length > 0, "tokens reads `items`");
  assert.ok((await indexer.activity({ limit: 5 })).items.length > 0, "activity reads `items`");
  assert.ok((await indexer.trades({ limit: 5 })).items.length > 0, "trades reads `items`");
  assert.ok((await indexer.orders({ limit: 5 })).items.length > 0, "orders reads `items`");
  assert.ok((await indexer.tokenHolders("LUCKY", { limit: 5 })).holders.length > 0, "tokenHolders reads `holders`");
}

console.log(
  TABLE
    ? `apiparity: ${ROUTES.length} mock envelopes match the indexer's route table; readers return rows`
    : `apiparity: ${ROUTES.length} mock envelopes are objects; readers return rows`,
);
