// Paged lists the app relies on for correctness are read in full, and the
// mock pages them exactly like the indexer. Plain Node, no framework:
//
//   1. /btc-utxos: every page (500 a page, by `total`), merged by outpoint —
//      a wallet's 546-sat carriers sort LAST, so a first-page reader loses
//      exactly them; an answer without `total` is one list; a list that
//      changed between pages is read once more; the page cap says so;
//   2. the mock's /btc-utxos: sorted and paged like the indexer (default
//      200, at most 500, `total` / `limit` / `offset`), and read through
//      the live transport every carrier of the mock wallet has its value;
//   3. /tokens: the whole registry by `total` (500 a page); the mock clamps
//      and sorts like the indexer;
//   4. the Send page: every page of the seller's listings, so an old open
//      listing behind many closed ones still marks its carrier; an
//      incomplete read chooses nothing automatically; a carrier without a
//      known value is never chosen automatically;
//   5. the seller's listings are walked in full under a server that serves
//      fewer rows a page than asked, and the mock's other lists page like
//      the indexer's (global lists 100 / 500, the others 50 / 200).
import assert from "node:assert/strict";
import * as indexer from "../src/lib/indexer.js";
import { MOCK_BTC_UTXOS_MAX_LIMIT, MOCK_TOKENS_MAX_LIMIT, MOCK_WALLET, btcUtxoOrder, mockGet } from "../src/lib/mock.js";
import { readSellerOrders } from "../src/lib/listingRules.js";
import { ORDERS_INCOMPLETE_TEXT, autoPickCarriers, carrierNote, carriersToSpend, sendCarrierRows, sendFormHint, sendReviewModel } from "../src/lib/send.js";

const ADDR = MOCK_WALLET.address;
const txidOf = (tag, i) => `${tag}${i.toString(16).padStart(64 - tag.length, "0")}`;

/** A fake indexer answering GET /btc-utxos/:addr?limit&offset the indexer's way from `rows()`. */
function serveBtcUtxos(rows, { withTotal = true, maxLimit = 500, onRequest = null } = {}) {
  const requests = [];
  const fetch = async (url) => {
    const u = new URL(String(url));
    requests.push(u.pathname + u.search);
    onRequest?.(requests.length);
    const all = [...rows()].sort(btcUtxoOrder);
    const limit = Math.max(1, Math.min(maxLimit, Number(u.searchParams.get("limit") || 200)));
    const offset = Math.max(0, Number(u.searchParams.get("offset") || 0));
    const body = { address: ADDR, scanned_at_height: 969_800, utxos: all.slice(offset, offset + limit) };
    if (withTotal) Object.assign(body, { total: all.length, limit, offset });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, requests };
}

async function withFetch(fetch, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

// ---- 1. /btc-utxos: every page -----------------------------------------------------------------
{
  // 10 plain outputs and 1,250 carriers of 546 sats: 1,260 rows, carriers on pages 1–3.
  const plain = Array.from({ length: 10 }, (_, i) => ({ txid: txidOf("aa", i), vout: 0, sats: 20_000 + i, confirmed: true, block_height: 969_700 }));
  const carriers = Array.from({ length: 1_250 }, (_, i) => ({ txid: txidOf("cc", i), vout: 0, sats: 546, confirmed: true, block_height: 969_701 }));
  const srv = serveBtcUtxos(() => [...plain, ...carriers]);
  const rows = await withFetch(srv.fetch, () => indexer.btcUtxos(ADDR));
  assert.equal(rows.length, 1_260, "every row");
  assert.deepEqual(srv.requests, [0, 499, 998].map((o) => `/btc-utxos/${ADDR}?limit=500&offset=${o}`), "500 a page, each page starting on the previous page's last row");
  const byKey = new Map(rows.map((u) => [`${u.txid}:${u.vout}`, u.sats]));
  assert.ok(carriers.every((c) => byKey.get(`${c.txid}:0`) === 546), "every carrier has its value");
  assert.equal(rows.complete, true);
  assert.equal(rows.total, 1_260);
  // …which is what the Send page's rows read the carriers' values from.
  const sendRows = sendCarrierRows({ tokenUtxos: carriers.slice(-3).map((c) => ({ txid: c.txid, vout: 0, balances: { LUCKY: 100 } })), btcUtxos: rows, orders: [], pendingSpent: new Set(), ticker: "LUCKY" });
  assert.ok(sendRows.every((r) => r.sats === 546), "the last carriers of the list have their value");

  // The first page only (a scan's warm-up): one request.
  const first = serveBtcUtxos(() => [...plain, ...carriers]);
  const one = await withFetch(first.fetch, () => indexer.btcUtxos(ADDR, undefined, { firstPageOnly: true }));
  assert.equal(first.requests.length, 1);
  assert.equal(one.length, 500);
  assert.equal(one.complete, false, "the rest was not read");

  // An answer without `total` is the whole list: one request.
  const old = serveBtcUtxos(() => plain, { withTotal: false });
  const oldRows = await withFetch(old.fetch, () => indexer.btcUtxos(ADDR));
  assert.equal(old.requests.length, 1);
  assert.equal(oldRows.length, 10);

  // A server that clamps harder (200 a page) is walked by what it returned.
  const small = serveBtcUtxos(() => [...plain, ...carriers.slice(0, 400)], { maxLimit: 200 });
  const smallRows = await withFetch(small.fetch, () => indexer.btcUtxos(ADDR));
  assert.equal(smallRows.length, 410);
  assert.deepEqual(small.requests.map((r) => Number(new URL(`http://x${r}`).searchParams.get("offset"))), [0, 199, 398]);

  // A block between two pages spends an output of page 1: the rows no longer add up to `total`,
  // so the list is read once more — and that read is the answer.
  let live = [...plain, ...carriers.slice(0, 700)];
  const moving = serveBtcUtxos(() => live, {
    onRequest: (n) => {
      if (n === 2) live = live.filter((u) => u.txid !== plain[0].txid);
    },
  });
  const moved = await withFetch(moving.fetch, () => indexer.btcUtxos(ADDR));
  assert.equal(moving.requests.length, 4, "two pages, then two pages again");
  assert.equal(moved.length, 709);
  assert.ok(!moved.some((u) => u.txid === plain[0].txid), "the spent output is gone from the answer");
  // A new large output arriving between the pages shifts the list the other way: caught the same way.
  let grow = [...plain, ...carriers.slice(0, 700)];
  const growing = serveBtcUtxos(() => grow, {
    onRequest: (n) => {
      if (n === 2) grow = [...grow, { txid: txidOf("ab", 1), vout: 2, sats: 5_000_000, confirmed: false, block_height: 0 }];
    },
  });
  const grown = await withFetch(growing.fetch, () => indexer.btcUtxos(ADDR));
  assert.equal(grown.length, 711, "every row of the list as it is now, none missed");

  // More outputs than the page cap reads: said, not hidden.
  const huge = serveBtcUtxos(() => Array.from({ length: 20_600 }, (_, i) => ({ txid: txidOf("dd", i), vout: 1, sats: 600, confirmed: true, block_height: 1 })));
  const capped = await withFetch(huge.fetch, () => indexer.btcUtxos(ADDR));
  assert.equal(huge.requests.length, indexer.BTC_UTXOS_MAX_PAGES);
  assert.equal(capped.complete, false);
  assert.equal(capped.length, indexer.BTC_UTXOS_PAGE + (indexer.BTC_UTXOS_MAX_PAGES - 1) * (indexer.BTC_UTXOS_PAGE - 1));
  assert.ok(capped.length >= 20_000, "the cap covers the most outputs the indexer tracks for one address");
  console.log("btc-utxos: every page by total, merged by outpoint; a moving list is read again; the cap is said");
}

// ---- 2. the mock pages /btc-utxos like the indexer -------------------------------------------------
{
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    store.set("lp.mock.manyUtxos", "600");
    const page1 = await mockGet(`/btc-utxos/${ADDR}`);
    assert.deepEqual([page1.limit, page1.offset, page1.utxos.length], [200, 0, 200], "default 200");
    assert.ok(page1.total > 600, `total counts every output (${page1.total})`);
    const clamped = await mockGet(`/btc-utxos/${ADDR}?limit=5000`);
    assert.equal(clamped.limit, MOCK_BTC_UTXOS_MAX_LIMIT, "at most 500");
    const sorted = [...clamped.utxos].sort(btcUtxoOrder);
    assert.deepEqual(clamped.utxos, sorted, "largest sats first, confirmed first, then txid and vout");
    // Through the live transport (a fake fetch answering from the mock): every page, and every carrier of the mock wallet has its value.
    const viaMock = async (url) => {
      const u = new URL(String(url));
      const body = await mockGet(u.pathname + u.search);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    };
    const rows = await withFetch(viaMock, () => indexer.btcUtxos(ADDR));
    assert.equal(rows.length, page1.total, "every output of the mock wallet");
    const tokens = (await mockGet(`/utxos/${ADDR}`)).utxos;
    assert.ok(tokens.length > 0);
    const carrierRows = sendCarrierRows({ tokenUtxos: tokens, btcUtxos: rows, orders: [], pendingSpent: new Set(), ticker: Object.keys(tokens[0].balances)[0] });
    assert.ok(carrierRows.length > 0 && carrierRows.every((r) => Number.isInteger(r.sats)), "no carrier reads 'value unknown'");
  } finally {
    delete globalThis.sessionStorage;
  }
  console.log("mock btc-utxos: sorted and paged like the indexer (200 / 500, total); read in full, every carrier has its value");
}

// ---- 3. /tokens: the whole registry --------------------------------------------------------------
{
  const reg = Array.from({ length: 1_234 }, (_, i) => ({ ticker: `T${i}`, supply: 21_000_000, minted: i, deployer: ADDR, deploy_txid: txidOf("ee", i), deploy_block: 969_600 + i }));
  const requests = [];
  const fetch = async (url) => {
    const u = new URL(String(url));
    requests.push(u.search);
    const limit = Math.max(1, Math.min(500, Number(u.searchParams.get("limit") || 10)));
    const offset = Math.max(0, Number(u.searchParams.get("offset") || 0));
    const body = { total: reg.length, offset, limit, items: reg.slice(offset, offset + limit) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const all = await withFetch(fetch, () => indexer.allTokens());
  assert.equal(all.items.length, 1_234, "every token, the 31st and the 1,234th included");
  assert.equal(all.complete, true);
  assert.equal(requests.length, 3);
  assert.ok(all.items.some((t) => t.ticker === "T1233"));
  // An indexer that clamps a page to 30 is still read in full (by what it served).
  const thirty = async (url) => {
    const u = new URL(String(url));
    const offset = Number(u.searchParams.get("offset") || 0);
    const body = { total: 95, offset, limit: 30, items: reg.slice(offset, Math.min(95, offset + 30)) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const walked = await withFetch(thirty, () => indexer.allTokens());
  assert.deepEqual([walked.items.length, walked.complete], [95, true]);
  // A page that comes back empty before `total`: incomplete, said so.
  const short = async (url) => {
    const u = new URL(String(url));
    const offset = Number(u.searchParams.get("offset") || 0);
    const body = { total: 800, offset, limit: 500, items: offset === 0 ? reg.slice(0, 500) : [] };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const part = await withFetch(short, () => indexer.allTokens());
  assert.deepEqual([part.items.length, part.total, part.complete], [500, 800, false]);
  // The mock clamps and sorts like the indexer.
  const dflt = await mockGet("/tokens");
  assert.equal(dflt.limit, 10, "default 10");
  const big = await mockGet("/tokens?limit=5000");
  assert.equal(big.limit, MOCK_TOKENS_MAX_LIMIT, "at most 500");
  const blocks = big.items.map((t) => t.deploy_block);
  assert.deepEqual(blocks, [...blocks].sort((a, b) => a - b), "oldest deploy first");
  console.log("tokens: the whole registry by total; an empty page before the end is incomplete; the mock clamps like the indexer");
}

// ---- 4. the Send page: every page of the seller's listings -----------------------------------------
{
  const CARRIER = txidOf("f0", 1);
  const history = Array.from({ length: 450 }, (_, i) => ({ id: `${txidOf("f1", i)}:0`, ticker: "LUCKY", status: i % 2 ? "filled" : "cancelled", seller: ADDR }));
  // The old open listing sits behind 450 newer closed ones: page 3.
  const all = [...history, { id: `${CARRIER}:0`, ticker: "LUCKY", status: "open", seller: ADDR, unit_price: 50, amount: 100 }];
  const page = async (offset, limit) => ({ total: all.length, items: all.slice(offset, offset + limit), expired: [] });
  const read = await readSellerOrders(page, { pageSize: 200 });
  assert.equal(read.complete, true);
  assert.equal(read.items.length, 451);
  const tokenUtxos = [
    { txid: CARRIER, vout: 0, balances: { LUCKY: 100 } },
    { txid: txidOf("f2", 1), vout: 0, balances: { LUCKY: 100 } },
  ];
  const btc = [
    { txid: CARRIER, vout: 0, sats: 546 },
    { txid: txidOf("f2", 1), vout: 0, sats: 546 },
  ];
  const rows = sendCarrierRows({ tokenUtxos, btcUtxos: btc, orders: read.items, pendingSpent: new Set(), ticker: "LUCKY" });
  assert.equal(rows.find((r) => r.txid === CARRIER).blocked, "listed", "the listing on page 3 marks its carrier");
  assert.deepEqual(autoPickCarriers(rows, 100), [`${txidOf("f2", 1)}:0`], "and it is never chosen automatically");
  // Only the first page read (the old way): the carrier would have looked free.
  const firstOnly = sendCarrierRows({ tokenUtxos, btcUtxos: btc, orders: all.slice(0, 200), pendingSpent: new Set(), ticker: "LUCKY" });
  assert.equal(firstOnly.find((r) => r.txid === CARRIER).blocked, null);
  // A read that could not finish: nothing is chosen automatically, and the page says why.
  assert.deepEqual(carriersToSpend({ mode: "auto", rows, amount: 100, manual: [], ordersComplete: false }), []);
  assert.deepEqual(carriersToSpend({ mode: "auto", rows, amount: 100, manual: [], ordersComplete: true }), [`${txidOf("f2", 1)}:0`]);
  assert.equal(sendFormHint({ connected: true, indexerOk: true, lagText: null, rcptState: "ok", amount: 100, amountErr: null, keysCount: 0, pickedTotal: 0, mode: "auto", freeTotal: 100, ticker: "LUCKY", ordersIncomplete: true }), ORDERS_INCOMPLETE_TEXT);
  // A carrier whose value the indexer does not list: said, and never chosen automatically.
  const unknown = sendCarrierRows({ tokenUtxos, btcUtxos: [btc[0]], orders: [], pendingSpent: new Set(), ticker: "LUCKY" });
  const u = unknown.find((r) => r.txid === txidOf("f2", 1));
  assert.equal(u.sats, null);
  assert.match(carrierNote(u, "LUCKY"), /BTC value is not known/);
  assert.deepEqual(autoPickCarriers(unknown, 100), [`${CARRIER}:0`]);
  assert.match(sendFormHint({ connected: true, indexerOk: true, lagText: null, rcptState: "ok", amount: 100, amountErr: null, keysCount: 1, pickedTotal: 100, mode: "manual", freeTotal: 100, ticker: "LUCKY", unknownValue: true }), /no known BTC value/);
  // A listing that left the book but can still be filled: said on the row and on the review.
  const floor = { id: `${txidOf("f2", 1)}:0`, ticker: "LUCKY", amount: 100, price_sats: 5_000, unit_price: 50, status: "expired" };
  const off = sendCarrierRows({ tokenUtxos, btcUtxos: btc, orders: [], expired: [floor], pendingSpent: new Set(), ticker: "LUCKY" });
  const o = off.find((r) => r.txid === txidOf("f2", 1));
  assert.equal(o.offBook, floor);
  assert.match(carrierNote(o, "LUCKY"), /can still be bought at 50.00 sats per token — sending it cancels that listing/);
  const review = sendReviewModel({ rows: off, keys: [o.key], ticker: "LUCKY", amount: 100, toAddress: ADDR, self: ADDR, payloadText: "" });
  assert.equal(review.offBook.length, 1);
  console.log("send page: every listing page read; an old open listing marks its carrier; incomplete reads and unknown values are never picked automatically");
}

// ---- 5. the other lists: the seller's listings under a lower server clamp, and the mock's clamps ------
{
  // A server that serves fewer rows a page than asked (its own `limit`) is still walked in full.
  const all = Array.from({ length: 130 }, (_, i) => ({ id: `${txidOf("f3", i)}:0`, ticker: "LUCKY", status: "cancelled", seller: ADDR }));
  const clamped = async (offset, limit) => ({ total: all.length, limit: Math.min(limit, 50), items: all.slice(offset, offset + Math.min(limit, 50)), expired: [] });
  const read = await readSellerOrders(clamped, { pageSize: 200 });
  assert.equal(read.complete, true);
  assert.deepEqual(read.items.map((o) => o.id), all.map((o) => o.id), "every row once, in order");
  // The mock's pages follow the indexer's: global lists 100 by default and at most 500
  // (limit=0 is an empty page there), per-address and book lists 50 and at most 200.
  const mines = await mockGet("/mines");
  assert.equal(mines.limit, 100, "/mines default 100");
  assert.equal((await mockGet("/mines?limit=5000")).limit, 500, "/mines at most 500");
  assert.deepEqual([(await mockGet("/mines?limit=0")).limit, (await mockGet("/mines?limit=0")).items.length], [0, 0]);
  assert.equal((await mockGet("/tokens/BLOK/holders")).limit, 100, "holders default 100");
  assert.equal((await mockGet("/tokens/BLOK/holders?limit=5000")).limit, 500);
  for (const p of [`/transfers/${ADDR}`, `/mines/${ADDR}`, `/orders/by-address/${ADDR}`, `/trades/${ADDR}`, "/orders", "/trades", "/activity"]) {
    assert.equal((await mockGet(p)).limit, 50, `${p} default 50`);
    assert.equal((await mockGet(`${p}${p.includes("?") ? "&" : "?"}limit=5000`)).limit, 200, `${p} at most 200`);
  }
  const transfers = await mockGet(`/transfers/${ADDR}?limit=1`);
  assert.ok(transfers.transfers.length <= 1 && Number.isInteger(transfers.total), "/transfers/:addr is paged");
  console.log("paging: a lower server clamp is walked in full; the mock's list pages match the indexer's");
}

console.log("paging: all checks passed");
