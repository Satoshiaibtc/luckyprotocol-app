// Paged lists the app relies on for correctness are read in full, and the
// mock pages them exactly like the indexer. Plain Node, no framework:
//
//   1. /txouts: at most 100 outpoints a request, one row per distinct
//      outpoint in the order asked, an answer that leaves one out is an
//      error; a spent row keeps no value; the carriers' values are read
//      once per outpoint, and a read that fails part-way keeps what it read;
//   2. the mock answers /txouts like the indexer: the simulated wallet's
//      list is checked in chunks of 100, and every carrier of the mock
//      wallet has its value;
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
import { MOCK_TOKENS_MAX_LIMIT, MOCK_WALLET, mockGet, mockWalletUtxos } from "../src/lib/mock.js";
import { UNKNOWN_VALUE_TEXT, readSellerOrders } from "../src/lib/listingRules.js";
import { ORDERS_INCOMPLETE_TEXT, autoPickCarriers, carrierNote, carriersToSpend, sendCarrierRows, sendFormHint, sendReviewModel } from "../src/lib/send.js";

const ADDR = MOCK_WALLET.address;
const txidOf = (tag, i) => `${tag}${i.toString(16).padStart(64 - tag.length, "0")}`;

/**
 * A fake indexer answering GET /txouts?o=… the indexer's way from `known`
 * ("txid:vout" → { sats, tokens? }). `drop`: an outpoint left out of the
 * answer; `stale`: an outpoint answered spent but still with a value,
 * script and confirmations; `failAt`: the request number (1-based) answered
 * 503 with Retry-After 10.
 */
function serveTxouts(known, { drop = null, stale = null, failAt = null } = {}) {
  const requests = [];
  const fetch = async (url) => {
    const u = new URL(String(url));
    requests.push(u.searchParams.get("o").split(","));
    if (requests.length === failAt) {
      return { ok: false, status: 503, headers: { get: (k) => (k === "Retry-After" ? "10" : null) }, text: async () => "the node did not answer in time; retry shortly" };
    }
    const keys = [...new Set(u.searchParams.get("o").split(","))].filter((k) => k !== drop);
    const body = keys.map((k) => {
      const [txid, v] = k.split(":");
      const r = known.get(k);
      if (k === stale) return { txid, vout: Number(v), unspent: false, sats: 500, script_hex: `5120${"ab".repeat(32)}`, address: ADDR, confirmations: 3, coinbase: true, token_carrier: false, tokens: null };
      if (!r) return { txid, vout: Number(v), unspent: false, sats: null, script_hex: null, address: null, confirmations: 0, coinbase: false, token_carrier: false, tokens: null };
      return { txid, vout: Number(v), unspent: true, sats: r.sats, script_hex: `5120${"ab".repeat(32)}`, address: ADDR, confirmations: 3, coinbase: false, token_carrier: !!r.tokens, tokens: r.tokens || null };
    });
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

// ---- 1. /txouts: at most 100 outpoints a request, every outpoint answered, in order --------------------------
{
  // 10 plain outputs and 240 carriers of 546 sats: 250 outpoints, three requests.
  const plain = Array.from({ length: 10 }, (_, i) => ({ txid: txidOf("aa", i), vout: 0, sats: 20_000 + i }));
  const carriers = Array.from({ length: 240 }, (_, i) => ({ txid: txidOf("cc", i), vout: 1, sats: 546, tokens: { LUCKY: 100 } }));
  const known = new Map([...plain, ...carriers].map((u) => [`${u.txid}:${u.vout}`, u]));
  const all = [...plain, ...carriers].map(({ txid, vout }) => ({ txid, vout }));
  const srv = serveTxouts(known);
  const rows = await withFetch(srv.fetch, () => indexer.txouts([...all, all[0], all[5]]));
  assert.equal(rows.length, 250, "one row per distinct outpoint (repeats asked once)");
  assert.deepEqual(srv.requests.map((r) => r.length), [100, 100, 50], "TXOUTS_MAX a request");
  assert.equal(indexer.TXOUTS_MAX, 100);
  assert.deepEqual(rows.map((r) => `${r.txid}:${r.vout}`), all.map((u) => `${u.txid}:${u.vout}`), "in the order asked");
  assert.ok(rows.slice(10).every((r) => r.token_carrier && r.tokens.LUCKY === 100 && r.sats === 546), "carriers carry their tokens");
  // Malformed outpoints are never sent.
  const bad = serveTxouts(known);
  await withFetch(bad.fetch, () => indexer.txouts([{ txid: "zz", vout: 0 }, { txid: plain[0].txid.toUpperCase(), vout: 0 }, { txid: plain[1].txid, vout: -1 }]));
  assert.deepEqual(bad.requests, [[`${plain[0].txid}:0`]], "upper-case txids are lower-cased; malformed entries dropped");
  // Nothing to ask: no request.
  const none = serveTxouts(known);
  assert.deepEqual(await withFetch(none.fetch, () => indexer.txouts([])), []);
  assert.equal(none.requests.length, 0);
  // An answer that leaves an outpoint out is an error, never a shorter list.
  const short = serveTxouts(known, { drop: `${plain[3].txid}:0` });
  await assert.rejects(withFetch(short.fetch, () => indexer.txouts(all.slice(0, 5))), /incomplete/);
  // A spent row is only `unspent: false`: whatever value, script or depth the answer still carries is dropped.
  const staleKey = `${plain[2].txid}:0`;
  const stale = serveTxouts(known, { stale: staleKey });
  const [spentRow] = await withFetch(stale.fetch, () => indexer.txouts([plain[2]]));
  assert.deepEqual(
    [spentRow.unspent, spentRow.sats, spentRow.script_hex, spentRow.address, spentRow.confirmations, spentRow.coinbase],
    [false, null, null, null, 0, false],
    "a spent row keeps no value, script, address or depth",
  );

  // The carriers' values, as the Send, Sell and Portfolio pages read them: asked once per outpoint.
  const vals = serveTxouts(known);
  const values = await withFetch(vals.fetch, () => indexer.outputValues(carriers));
  assert.equal(values.length, 240);
  assert.deepEqual([vals.requests.length, (await withFetch(vals.fetch, () => indexer.outputValues(carriers))).length, vals.requests.length], [3, 240, 3], "a value once read is not asked again");
  const gone = { txid: txidOf("dd", 1), vout: 0 };
  assert.deepEqual(await withFetch(vals.fetch, () => indexer.outputValues([gone, carriers[0]])), [{ txid: carriers[0].txid, vout: 1, sats: 546 }], "an outpoint the node does not have is left out");
  assert.deepEqual(vals.requests.at(-1), [`${gone.txid}:0`], "…and only it was asked");
  // A read that fails part-way keeps the chunks it already read: the next call asks only for the rest.
  const more = Array.from({ length: 300 }, (_, i) => ({ txid: txidOf("c7", i), vout: 1, sats: 546, tokens: { LUCKY: 1 } }));
  const moreKnown = new Map(more.map((u) => [`${u.txid}:${u.vout}`, u]));
  const flaky = serveTxouts(moreKnown, { failAt: 3 });
  await assert.rejects(withFetch(flaky.fetch, () => indexer.outputValues(more)), /did not answer in time/);
  assert.equal(flaky.requests.length, 3);
  const rest = serveTxouts(moreKnown);
  assert.equal((await withFetch(rest.fetch, () => indexer.outputValues(more))).length, 300);
  assert.deepEqual(rest.requests, [more.slice(200).map((u) => `${u.txid}:1`)], "only the chunk that failed is asked again");
  const sendRows = sendCarrierRows({ tokenUtxos: carriers.slice(-3).map((c) => ({ txid: c.txid, vout: 1, balances: { LUCKY: 100 } })), values, orders: [], pendingSpent: new Set(), ticker: "LUCKY" });
  assert.ok(sendRows.every((r) => r.sats === 546), "the last carriers of a long list have their value");
  console.log("txouts: at most 100 outpoints a request, every outpoint answered in order; values are read once per outpoint");
}

// ---- 2. the mock answers GET /txouts like the indexer; the simulated wallet's list is checked in chunks ------------
{
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    store.set("lp.mock.manyUtxos", "250");
    const listed = await mockWalletUtxos(ADDR);
    assert.ok(listed.length > 250, `the knob adds 250 outputs to the wallet's list (${listed.length})`);
    const viaMock = async (url) => {
      const u = new URL(String(url));
      const body = await mockGet(u.pathname + u.search);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    };
    let calls = 0;
    const counting = async (url) => {
      calls += 1;
      return viaMock(url);
    };
    const rows = await withFetch(counting, () => indexer.txouts(listed));
    assert.equal(rows.length, listed.length, "every listed output answered");
    assert.equal(calls, Math.ceil(listed.length / 100), "in chunks of 100");
    const extra = rows.filter((r) => r.sats === 546 && !r.token_carrier);
    assert.ok(extra.length >= 250 && extra.every((r) => r.unspent && r.confirmations >= 1), "the knob's outputs are confirmed plain outputs");
    const tokens = (await mockGet(`/utxos/${ADDR}`)).utxos;
    assert.ok(tokens.length > 0);
    const values = await withFetch(viaMock, () => indexer.outputValues(tokens));
    const carrierRows = sendCarrierRows({ tokenUtxos: tokens, values, orders: [], pendingSpent: new Set(), ticker: Object.keys(tokens[0].balances)[0] });
    assert.ok(carrierRows.length > 0 && carrierRows.every((r) => Number.isInteger(r.sats)), "no carrier reads 'value unknown'");
  } finally {
    delete globalThis.sessionStorage;
  }
  console.log("mock txouts: the simulated wallet's list is answered in chunks of 100; every carrier has its value");
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
  const rows = sendCarrierRows({ tokenUtxos, values: btc, orders: read.items, pendingSpent: new Set(), ticker: "LUCKY" });
  assert.equal(rows.find((r) => r.txid === CARRIER).blocked, "listed", "the listing on page 3 marks its carrier");
  assert.deepEqual(autoPickCarriers(rows, 100), [`${txidOf("f2", 1)}:0`], "and it is never chosen automatically");
  // Only the first page read (the old way): the carrier would have looked free.
  const firstOnly = sendCarrierRows({ tokenUtxos, values: btc, orders: all.slice(0, 200), pendingSpent: new Set(), ticker: "LUCKY" });
  assert.equal(firstOnly.find((r) => r.txid === CARRIER).blocked, null);
  // A read that could not finish: nothing is chosen automatically, and the page says why.
  assert.deepEqual(carriersToSpend({ mode: "auto", rows, amount: 100, manual: [], ordersComplete: false }), []);
  assert.deepEqual(carriersToSpend({ mode: "auto", rows, amount: 100, manual: [], ordersComplete: true }), [`${txidOf("f2", 1)}:0`]);
  assert.equal(sendFormHint({ connected: true, indexerOk: true, lagText: null, rcptState: "ok", amount: 100, amountErr: null, keysCount: 0, pickedTotal: 0, mode: "auto", freeTotal: 100, ticker: "LUCKY", ordersIncomplete: true }), ORDERS_INCOMPLETE_TEXT);
  // A carrier whose value the indexer could not read: said, and never chosen automatically.
  const unknown = sendCarrierRows({ tokenUtxos, values: [btc[0]], orders: [], pendingSpent: new Set(), ticker: "LUCKY" });
  const u = unknown.find((r) => r.txid === txidOf("f2", 1));
  assert.equal(u.sats, null);
  assert.match(carrierNote(u, "LUCKY"), /BTC value is not known/);
  assert.deepEqual(autoPickCarriers(unknown, 100), [`${CARRIER}:0`]);
  const unknownHint = sendFormHint({ connected: true, indexerOk: true, lagText: null, rcptState: "ok", amount: 100, amountErr: null, keysCount: 1, pickedTotal: 100, mode: "manual", freeTotal: 100, ticker: "LUCKY", unknownValue: true });
  assert.match(unknownHint, /no known BTC value/);
  // The value is read again on the next poll, not only after a block: the texts say "in a moment".
  for (const t of [carrierNote(u, "LUCKY"), unknownHint, UNKNOWN_VALUE_TEXT]) {
    assert.match(t, /try again in a moment/i);
    assert.ok(!/next block/.test(t), t);
  }
  // A listing that left the book but can still be filled: said on the row and on the review.
  const floor = { id: `${txidOf("f2", 1)}:0`, ticker: "LUCKY", amount: 100, price_sats: 5_000, unit_price: 50, status: "expired" };
  const off = sendCarrierRows({ tokenUtxos, values: btc, orders: [], expired: [floor], pendingSpent: new Set(), ticker: "LUCKY" });
  const o = off.find((r) => r.txid === txidOf("f2", 1));
  assert.equal(o.offBook, floor);
  assert.match(carrierNote(o, "LUCKY"), /can still be bought at 50.00 sats per token — transferring it cancels that listing/);
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
