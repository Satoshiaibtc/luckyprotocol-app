// API envelope parity. An indexer that answers the global `GET /mines`
// with `{ total, limit, offset, mines }` while its route table, this app
// and its mock all use `items` lets every test pass (the mock follows the
// table) while the live site shows no mines at all. These checks keep the
// three sides together:
//
//   1. every route the mock serves carries every top-level key the
//      indexer's route table names, read from the local indexer checkout
//      that LP_INDEXER_DIR points at; without it (a Pages build) this
//      check is skipped with a note;
//   2. the app's readers, fed the mock through the real HTTP code path,
//      return rows (a reader that reads a key the table does not name
//      gets none);
//   3. the global /mines envelope names its page `items`, never `mines`;
//   4. the depth and finality values read back through the readers;
//   5. the depth / market-gate / health fields: every key the route table
//      and the documented MineView / OrderView / token rows name is served
//      by the mock on every route that serves that view;
//   6. GET /txouts: the mock's rows carry exactly the keys the route table
//      documents, one per distinct outpoint in request order, and its
//      refusals are the indexer's own words; the live transport shows a
//      refusal as that sentence and asks a busy node again (a budget 429
//      is waited out);
//   7. the mock's /txouts follows the simulated chain like the indexer: an
//      output a pending tx spends is still unspent, one spent in a block is
//      not (and a spent carrier carries no tokens), and depth is counted
//      from the indexed height (the `lp.mock.indexerLag` knob).
//
// Plain Node, no framework.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import * as mock from "../src/lib/mock.js";
import { mockGet, mockSignPsbt, mockWalletUtxos, simulateBroadcast, MOCK_WALLET, TXOUTS_REFUSALS } from "../src/lib/mock.js";
import * as indexer from "../src/lib/indexer.js";
import { buildSendPsbt } from "../src/lib/psbt.js";
import { mockSpendable } from "./mockspend.js";

const INDEXER_DIR = process.env.LP_INDEXER_DIR || "";
const API_DOC = INDEXER_DIR ? join(INDEXER_DIR, "docs", "API.md") : null;
const TABLE = API_DOC && existsSync(API_DOC) ? readFileSync(API_DOC, "utf8") : null;

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
  console.log("apiparity: LP_INDEXER_DIR not set — route-table key checks skipped (mock and reader checks still run)");
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

// ---- 4. depth and finality (the finality API contract), served by the mock ------------------------------
{
  const h = await indexer.health();
  assert.deepEqual([typeof h.last_poll_at, h.node_peers, typeof h.tip_time, h.rebuilding, h.final_depth, h.persist_ok, h.stalled], ["number", 8, "number", false, 6, true, false], "/health: last_poll_at, node_peers, tip_time, rebuilding, final_depth, persist_ok");
  // The raw /health keeps `rebuilding` always true (a build that reads that
  // key pauses every write); the rebuild flag is `state_rebuilding`, which
  // the reader returns as `rebuilding`.
  const rawHealth = await mockGet("/health");
  assert.deepEqual([rawHealth.rebuilding, rawHealth.state_rebuilding], [true, false], "the mock's raw /health: rebuilding true, state_rebuilding false");
  globalThis.sessionStorage = { getItem: (k) => (k === "lp.mock.health" ? '{"rebuilding":true}' : null), setItem() {}, removeItem() {} };
  try {
    assert.deepEqual([(await mockGet("/health")).rebuilding, (await mockGet("/health")).state_rebuilding], [true, true], "the lp.mock.health knob's `rebuilding` sets state_rebuilding");
    assert.equal((await indexer.health()).rebuilding, true, "…which the reader returns as rebuilding");
  } finally {
    delete globalThis.sessionStorage;
  }
  await assert.rejects(mockGet(`/commits/${"ab".repeat(32)}`), (e) => e.status === 404, "the mock serves no /commits route");
  if (TABLE) {
    assert.ok(specKeys("/", "`GET /` (alias `GET /health`)").includes("state_rebuilding"), "the route table's /health row names state_rebuilding");
    assert.ok(!TABLE.split(/\r?\n/).some((l) => l.startsWith("| `GET /commits")), "the route table has no /commits row");
  }
  assert.equal((await indexer.fees()).ok, true, "/fees: ok");
  const toks = (await indexer.tokens({ limit: 200 })).items;
  const blok = toks.find((t) => t.ticker === "BLOK");
  assert.deepEqual([blok.market_open, blok.market_opens_at_height], [true, 965_305], "minted out at 965,300: open from 965,305");
  const dune = toks.find((t) => t.ticker === "DUNE");
  assert.deepEqual([dune.minted_out, dune.market_open, dune.market_opens_at_height], [true, false, 970_103], "minted out two blocks ago: not open yet");
  assert.deepEqual([(await indexer.token("DUNE")).market_open, (await indexer.market("DUNE")).market_open, (await indexer.market("DUNE")).market_opens_at_height], [false, false, 970_103], "every token view carries the gate");
  const book = (await indexer.orders({ status: "open", limit: 200 })).items;
  assert.ok(book.length > 0 && book.every((o) => o.market_open === true), "order views carry market_open");
  const feed = (await indexer.minesFeed({ limit: 5 })).items;
  assert.ok(feed.every((r) => Number.isInteger(r.confirmations) && r.confirmations >= 1 && typeof r.final === "boolean"), "mine views carry confirmations / final");
  const ts = await indexer.txStatus(feed[0].txid);
  assert.deepEqual([ts.confirmed, ts.confirmations, ts.final], [true, feed[0].confirmations, feed[0].final], "/tx-status carries the same depth");
  const { mockPostJson } = await import("../src/lib/mock.js");
  await assert.rejects(mockPostJson("/orders", { psbt: "00", ticker: "DUNE", amount: 100, price_sats: 1_000 }), (e) => e.status === 409 && e.message === "market opens at block 970103", "POST /orders before the market opens: 409 market opens at block N");
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

// ---- 6. GET /txouts: the mock answers like the indexer — the documented row keys, request order, the refusals ----------
{
  const listed = await mockWalletUtxos(ADDR);
  const key = (u) => `${u.txid}:${u.vout}`;
  const missing = `${"ee".repeat(32)}:7`;
  const asked = [...listed.map(key), missing, key(listed[0])];
  const rows = await mockGet(`/txouts?o=${asked.join(",")}`);
  assert.ok(Array.isArray(rows), "a bare JSON array");
  assert.deepEqual(rows.map(key), asked.slice(0, -1), "one row per distinct outpoint, in request order");
  const gone = rows.find((r) => key(r) === missing);
  assert.deepEqual([gone.unspent, gone.sats, gone.script_hex, gone.address, gone.confirmations, gone.coinbase, gone.token_carrier, gone.tokens], [false, null, null, null, 0, false, false, null], "an outpoint the node does not have");
  const carrier = rows.find((r) => r.token_carrier);
  assert.ok(carrier && carrier.unspent && carrier.sats === 546 && Object.values(carrier.tokens).every((a) => a > 0), "a token carrier says so, with its tokens");
  const plain = rows.find((r) => r.unspent && !r.token_carrier && r.sats > 546);
  assert.ok(plain && plain.confirmations >= 1 && plain.address === ADDR && /^5120[0-9a-f]{64}$/.test(plain.script_hex), "a confirmed plain output: its value, script, address and depth");
  const pending = listed.find((u) => rows.find((r) => key(r) === key(u)).unspent === false);
  assert.ok(pending, "an output the wallet lists that has not confirmed is not in the confirmed set");
  if (TABLE) {
    const row = TABLE.split("\n").find((l) => l.startsWith("| `GET /txouts"));
    assert.ok(row, "the indexer's route table has a row for GET /txouts");
    const docKeys = keysIn(row.slice(row.indexOf("`[{") + 3));
    assert.deepEqual(docKeys, ["txid", "vout", "unspent", "sats", "script_hex", "address", "confirmations", "coinbase", "token_carrier", "tokens"]);
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), [...docKeys].sort(), `mock /txouts row ${key(r)} carries exactly the documented keys`);
    for (const text of [TXOUTS_REFUSALS.list, TXOUTS_REFUSALS.tooMany, TXOUTS_REFUSALS.entry("<n>")]) assert.ok(row.includes(text), `the route table names the refusal "${text}"`);
  }
  // Percent-encoded separators are read the same.
  assert.deepEqual((await mockGet(`/txouts?o=${encodeURIComponent(asked.slice(0, 2).join(","))}`)).map(key), asked.slice(0, 2));
  // The refusals, word for word.
  const refused = async (q) => (await mockGet(`/txouts${q}`).catch((e) => e)).detail;
  assert.equal(await refused(""), TXOUTS_REFUSALS.list, "o missing");
  assert.equal(await refused("?o="), TXOUTS_REFUSALS.list, "o empty");
  assert.equal(await refused(`?o=${asked[0]}&o=${asked[1]}`), TXOUTS_REFUSALS.list, "o twice");
  assert.equal(await refused(`?o=${Array.from({ length: 101 }, () => asked[0]).join(",")}`), TXOUTS_REFUSALS.tooMany, "101 entries, repeats counted");
  assert.equal(await refused(`?o=${asked[0]},${asked[1].toUpperCase()}`), TXOUTS_REFUSALS.entry(2), "upper-case hex");
  assert.equal(await refused(`?o=${asked[0]},,${asked[1]}`), TXOUTS_REFUSALS.entry(2), "an empty entry");
  assert.equal(await refused(`?o=${listed[0].txid}:4294967296`), TXOUTS_REFUSALS.entry(1), "a vout past u32");
  assert.equal((await mockGet(`/txouts?o=${listed[0].txid}:4294967295`)).length, 1, "the largest u32 vout is a valid entry");

  // The live transport: the server's refusal is the error's sentence, and a busy node is asked again.
  const answers = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const [status, headers, body] = answers.shift();
    return { ok: status === 200, status, headers: { get: (k) => headers[k] ?? null }, text: async () => body, json: async () => JSON.parse(body) };
  };
  try {
    answers.push([400, {}, TXOUTS_REFUSALS.entry(1)]);
    const e400 = await indexer.txouts([{ txid: listed[0].txid, vout: 0 }]).catch((e) => e);
    assert.deepEqual([e400.status, e400.message], [400, TXOUTS_REFUSALS.entry(1)], "a refusal: its own sentence, no request path");
    answers.push([503, { "Retry-After": "1" }, "node RPC busy; retry shortly"], [200, {}, JSON.stringify([rows[0]])]);
    assert.deepEqual((await indexer.txouts([rows[0]])).map(key), [key(rows[0])], "a busy node is asked again after its Retry-After");
    answers.push([503, { "Retry-After": "30" }, "the node did not answer in time; retry shortly"]);
    const slow = await indexer.txouts([rows[0]]).catch((e) => e);
    assert.deepEqual([slow.status, slow.message], [503, "the node did not answer in time; retry shortly"], "a long Retry-After is not waited out");
    // A budget 429: its Retry-After is the rest of the 10 s client window, waited out (the waits run at once here).
    const waits = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => (ms >= 1_000 && ms <= 10_000 ? (waits.push(ms), realSetTimeout(fn, 0, ...a)) : realSetTimeout(fn, ms, ...a));
    try {
      answers.push([429, { "Retry-After": "7" }, "too many requests; retry shortly"], [200, {}, JSON.stringify([rows[0]])]);
      assert.deepEqual((await indexer.txouts([rows[0]])).map(key), [key(rows[0])], "a budget 429 is waited out and asked again");
      assert.deepEqual(waits, [7_000]);
      answers.push(...Array.from({ length: 3 }, () => [429, { "Retry-After": "10" }, "too many requests; retry shortly"]));
      const over = await indexer.txouts([rows[0]]).catch((e) => e);
      assert.deepEqual([over.status, over.message, answers.length], [429, "too many requests; retry shortly", 0], "at most TXOUTS_RETRIES retries");
      assert.deepEqual(waits, [7_000, 10_000, 10_000]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
  console.log("apiparity txouts: the mock's rows carry the documented keys in request order; the refusals are the indexer's words");
}

// ---- 7. the mock's /txouts follows the simulated chain: pending and confirmed spends, indexer lag ----------------
{
  const key = (u) => `${u.txid}:${u.vout}`;
  const store = new Map();
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const rowOf = async (u) => (await mockGet(`/txouts?o=${key(u)}`))[0];
  try {
    // Depth is counted from the indexed height: an indexer that lags reports 0 confirmations.
    const plain = (await mockSpendable(mock, ADDR)).utxos[0];
    const depth = (await rowOf(plain)).confirmations;
    assert.ok(depth >= 1, "a listed confirmed output has depth");
    store.set("lp.mock.indexerLag", String(depth));
    assert.deepEqual([(await rowOf(plain)).unspent, (await rowOf(plain)).confirmations], [true, 0], "above the indexed height: 0 confirmations");
    store.delete("lp.mock.indexerLag");
    assert.equal((await rowOf(plain)).confirmations, depth, "the knob removed: its depth is back");

    // A SEND that spends a carrier and plain BTC.
    const spendable = (await mockSpendable(mock, ADDR)).utxos;
    const tokenRows = (await mockGet(`/utxos/${ADDR}`)).utxos;
    const carrier = tokenRows[0];
    const ticker = Object.keys(carrier.balances)[0];
    const built = buildSendPsbt({
      address: ADDR,
      pubkeyHex: MOCK_WALLET.pubkeyHex,
      utxos: spendable,
      tokenOutpoints: tokenRows.map(({ txid, vout }) => ({ txid, vout })),
      tokenUtxos: [{ txid: carrier.txid, vout: carrier.vout, sats: 546 }],
      feeRateSatVb: 2,
      ticker,
      amount: 1,
      toAddress: ADDR,
    });
    const tokenKeys = new Set(tokenRows.map(key));
    const spentPlain = built.inputs.find((u) => !tokenKeys.has(key(u)));
    assert.ok(spentPlain, "the SEND spends plain BTC for its fee");
    const signed = mockSignPsbt(built.psbtHex, { toSignInputs: built.inputIndexes.map((index) => ({ index, address: ADDR })) });
    simulateBroadcast(hex.encode(btc.Transaction.fromPSBT(hex.decode(signed)).extract()));
    // Pending: the node's confirmed set still has both (the carrier with its tokens).
    const [pendingPlain, pendingCarrier] = [await rowOf(spentPlain), await rowOf(carrier)];
    assert.deepEqual([pendingPlain.unspent, pendingCarrier.unspent, pendingCarrier.token_carrier], [true, true, true], "a pending spend leaves its inputs unspent");
    assert.equal(pendingCarrier.tokens[ticker], carrier.balances[ticker]);
    // Confirmed: both spent, and the spent carrier carries nothing any more.
    now += 20_001;
    const [gonePlain, goneCarrier] = [await rowOf(spentPlain), await rowOf(carrier)];
    assert.deepEqual([gonePlain.unspent, gonePlain.confirmations], [false, 0], "spent in a block: not in the confirmed set");
    assert.deepEqual(
      [goneCarrier.unspent, goneCarrier.sats, goneCarrier.confirmations, goneCarrier.token_carrier, goneCarrier.tokens],
      [false, null, 0, false, null],
      "a carrier spent in a block carries no tokens, as the indexer answers once it applied the spend",
    );
  } finally {
    Date.now = realNow;
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
    else delete globalThis.localStorage;
  }
  console.log("apiparity txouts: the mock follows pending and confirmed spends and the indexed height like the indexer");
}

console.log(
  TABLE
    ? `apiparity: ${ROUTES.length} mock envelopes match the indexer's route table; readers return rows`
    : `apiparity: ${ROUTES.length} mock envelopes are objects; readers return rows`,
);
