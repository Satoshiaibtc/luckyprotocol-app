// API envelope parity (audit F1). The indexer once answered the global
// `GET /mines` with `{ total, limit, offset, mines }` while its route
// table, this app and its mock all used `items`. The mock followed the
// table, so every test passed while the real site showed no mines at all.
// These checks keep the three sides together:
//
//   1. every route the mock serves carries every top-level key the
//      indexer's route table names, read from the indexer checkout when
//      it sits beside this one; without it (a Pages build) this check is
//      skipped with a note;
//   2. the app's readers, fed the mock through the real HTTP code path,
//      return rows (a reader that reads a key the table does not name
//      gets none);
//   3. the global /mines envelope names its page `items`, never `mines`;
//   4. the depth and finality values read back through the readers;
//   5. the depth / market-gate / health fields: every key the route table
//      and the documented MineView / OrderView / token rows name is served
//      by the mock on every route that serves that view.
//
// Plain Node, no framework.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mockGet, MOCK_WALLET } from "../src/lib/mock.js";
import * as indexer from "../src/lib/indexer.js";

const API_DOC = new URL("../../luckyprotocol-indexer/docs/API.md", import.meta.url);
const TABLE = existsSync(API_DOC) ? readFileSync(API_DOC, "utf8") : null;

/**
 * Top-level keys of the JSON object the route-table row for `GET <route>`
 * documents (`cell` = the row's first cell when it says more than the route).
 */
function specKeys(route, cell = `\`GET ${route}\``) {
  const head = `| ${cell} | \`{`;
  const row = TABLE.split("\n").find((l) => l.startsWith(head));
  assert.ok(row, `the indexer's route table has no row for GET ${route}`);
  const keys = keysIn(row.slice(head.length));
  assert.ok(keys.length > 0, `the row for GET ${route} names no key`);
  return keys;
}

/** Keys of the row objects in `list: [{ … }]` of the route-table row for `GET <route>`. */
function specItemKeys(route, list) {
  const row = TABLE.split("\n").find((l) => l.startsWith(`| \`GET ${route}\` | `));
  const at = row ? row.indexOf(`${list}: [{`) : -1;
  assert.ok(at >= 0, `the row for GET ${route} documents no ${list} rows`);
  return keysIn(row.slice(at + list.length + 4));
}

/** Keys of the first JSON example after the line that introduces `name` in the indexer's API doc. */
function docJsonKeys(name) {
  const lines = TABLE.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`\`${name}\``));
  assert.ok(start >= 0, `the indexer's API doc does not introduce ${name}`);
  const open = lines.findIndex((l, i) => i > start && l.trim() === "```json");
  const close = lines.findIndex((l, i) => i > open && l.trim() === "```");
  assert.ok(open > start && close > open, `no JSON example for ${name}`);
  return [...lines.slice(open + 1, close).join("\n").matchAll(/"([a-z_]+)"\s*:/g)].map((m) => m[1]);
}

/** Top-level keys of the `{ … }` body that `text` continues (it starts just inside the brace). */
function keysIn(text) {
  const pieces = [""];
  let depth = 0;
  for (const ch of text) {
    if ((ch === "}" || ch === "]") && depth === 0) break;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      pieces.push("");
      continue;
    }
    pieces[pieces.length - 1] += ch;
  }
  return pieces.map((p) => p.split(":")[0].trim()).filter((k) => k && k !== "…" && k !== "...");
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
  ["/tokens/LUCKY/market", "/tokens/:ticker/market?window=24h\\|7d"],
  ["/fees", "/fees"],
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

// ---- 4. depth and finality (the reorg audit's API contract), served by the mock ------------------------------
{
  const h = await indexer.health();
  assert.deepEqual([typeof h.last_poll_at, h.node_peers, typeof h.tip_time, h.rebuilding, h.final_depth, h.persist_ok, h.stalled], ["number", 8, "number", false, 6, true, false], "/health: last_poll_at, node_peers, tip_time, rebuilding, final_depth, persist_ok");
  assert.equal((await indexer.fees()).ok, true, "/fees: ok");
  const toks = (await indexer.tokens({ limit: 200 })).items;
  const blok = toks.find((t) => t.ticker === "BLOK");
  assert.deepEqual([blok.market_open, blok.market_opens_at_height], [true, 965_005], "minted out at 965,000: open from 965,005");
  const dune = toks.find((t) => t.ticker === "DUNE");
  assert.deepEqual([dune.minted_out, dune.market_open, dune.market_opens_at_height], [true, false, 969_803], "minted out two blocks ago: not open yet");
  assert.deepEqual([(await indexer.token("DUNE")).market_open, (await indexer.market("DUNE")).market_open, (await indexer.market("DUNE")).market_opens_at_height], [false, false, 969_803], "every token view carries the gate");
  const book = (await indexer.orders({ status: "open", limit: 200 })).items;
  assert.ok(book.length > 0 && book.every((o) => o.market_open === true), "order views carry market_open");
  const feed = (await indexer.minesFeed({ limit: 5 })).items;
  assert.ok(feed.every((r) => Number.isInteger(r.confirmations) && r.confirmations >= 1 && typeof r.final === "boolean"), "mine views carry confirmations / final");
  const ts = await indexer.txStatus(feed[0].txid);
  assert.deepEqual([ts.confirmed, ts.confirmations, ts.final], [true, feed[0].confirmations, feed[0].final], "/tx-status carries the same depth");
  const { mockPostJson } = await import("../src/lib/mock.js");
  await assert.rejects(mockPostJson("/orders", { psbt: "00", ticker: "DUNE", amount: 100, price_sats: 1_000 }), (e) => e.status === 409 && e.message === "market opens at block 969803", "POST /orders before the market opens: 409 market opens at block N");
  console.log("apiparity depth: health, fees.ok, market_open / market_opens_at_height, order market_open, mine + tx-status confirmations / final");
}

// ---- 5. every documented depth / gate / health key, on every route that serves the view ---------------------------------
if (TABLE) {
  const lacks = (row, keys) => keys.filter((k) => !(k in row));
  const health = await mockGet("/health");
  assert.deepEqual(lacks(health, specKeys("/", "`GET /` (alias `GET /health`)")), [], "mock /health lacks keys of the route table's row");
  const mineKeys = docJsonKeys("MineView");
  assert.ok(["reason", "confirmations", "final"].every((k) => mineKeys.includes(k)), "the MineView example names reason / confirmations / final");
  const feed = (await mockGet("/mines?limit=5")).items;
  const mine = (await mockGet(`/mines/${ADDR}?limit=5`)).mines;
  const one = await mockGet(`/mines/by-txid/${feed[0].txid}`);
  for (const [where, rows] of [["/mines", feed], ["/mines/:addr", mine], ["/mines/by-txid", [one]]]) {
    for (const r of rows) assert.deepEqual(lacks(r, mineKeys), [], `mock ${where} row lacks MineView keys`);
  }
  const status = await mockGet(`/tx-status/${feed[0].txid}`);
  assert.deepEqual(lacks(status, specKeys("/tx-status/:txid")), [], "mock /tx-status (confirmed) lacks keys of the route table's row");
  const orderKeys = docJsonKeys("OrderView").filter((k) => k !== "psbt");
  assert.ok(orderKeys.includes("market_open"), "the OrderView example names market_open");
  const book = (await mockGet("/orders?status=all&limit=200")).items;
  const mineOrders = (await mockGet(`/orders/by-address/${ADDR}`)).orders;
  const byId = await mockGet(`/orders/${book[0].id}`);
  for (const [where, rows] of [["/orders", book], ["/orders/by-address/:addr", mineOrders], ["/orders/:id", [byId]]]) {
    for (const r of rows) assert.deepEqual(lacks(r, orderKeys), [], `mock ${where} row lacks OrderView keys`);
  }
  assert.equal(typeof byId.psbt, "string", "/orders/:id carries the psbt");
  const tokenKeys = specItemKeys("/tokens?limit&offset&deployer", "items");
  assert.ok(["market_open", "market_opens_at_height"].every((k) => tokenKeys.includes(k)), "the /tokens row names the market gate");
  const toks = (await mockGet("/tokens?limit=200")).items;
  for (const t of [...toks, await mockGet("/tokens/DUNE")]) assert.deepEqual(lacks(t, tokenKeys), [], `mock token ${t.ticker} lacks /tokens row keys`);
  // A market that is not open shows no book: no live orders, 0 / null figures.
  const dune = await mockGet("/tokens/DUNE/market");
  assert.deepEqual([dune.market_open, dune.open_orders, dune.floor_unit_price, dune.listed_amount], [false, 0, null, 0]);
  const live = book.filter((o) => o.status === "open" || o.status === "filling");
  assert.ok(live.every((o) => o.market_open === true), "GET /orders lists no live order of a market that is not open");
  console.log("apiparity keys: /health, /fees, /tx-status, /tokens/:ticker/market, MineView, OrderView and /tokens rows carry every documented key");
}

console.log(
  TABLE
    ? `apiparity: ${ROUTES.length} mock envelopes match the indexer's route table; readers return rows`
    : `apiparity: ${ROUTES.length} mock envelopes are objects; readers return rows`,
);
