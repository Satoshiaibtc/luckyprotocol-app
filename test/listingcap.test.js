// The per-address listing cap (PROTOCOL.md §7.4 "Per-seller cap"): the
// counter behind "N of 10 listings used", the check the sell form makes
// before the wallet signs (a new listing vs listing an already-listed
// outpoint again), the mapping of the order book's 400 to plain words, and
// the mock order book enforcing the same cap with the indexer's exact text.
// Plain Node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The mock's dev knob, read when its world is first built: the simulated
// wallet gets 9 open BLOK listings plus two unlisted BLOK carriers. Set
// before the mock module is loaded (and before its first call).
const store = new Map([["lp.mock.myListings", "9"]]);
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  writable: true,
  value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
});

const { MAX_OPEN_LISTINGS_PER_ADDRESS, SELLER_CAP_RE, listingCapDecision, listingCapText, listingQuota, listingQuotaText, readSellerOrders, sellerCapError } = await import("../src/lib/listingRules.js");
const { listingRefusalText } = await import("../src/lib/market.js");
const { orderHttpError } = await import("../src/lib/indexer.js");
const { LISTING_SIGHASH, buildListingPsbt } = await import("../src/lib/swap.js");
const { MOCK_WALLET, mockGet, mockPostJson, mockSignPsbt } = await import("../src/lib/mock.js");

const NOW = 1_800_000_000;
const TX = (c) => c.repeat(64);
const ME = "bc1pme";
const row = (id, status = "open", extra = {}) => ({ id, seller: ME, ticker: "BLOK", status, expires_at: NOW + 3600, ...extra });

// ---- the number, in one place, equal to the indexer's ------------------------------------------------------------
{
  assert.equal(MAX_OPEN_LISTINGS_PER_ADDRESS, 10);
  assert.equal(sellerCapError(), "seller has 10 open orders (cap 10)", "the order book's exact text");
  assert.equal(sellerCapError(11, 10), "seller has 11 open orders (cap 10)", "the real count, above the cap");
  // The served spec states the same cap (test/web.test.js checks it against
  // this constant), and the indexer holds its own code to the spec.
  console.log("listing cap: 10, with the order book's exact refusal text");
}

// ---- the counter: open listings of this address, every ticker ----------------------------------------------------
{
  const orders = [
    row(`${TX("a")}:0`),
    row(`${TX("b")}:0`, "open", { ticker: "ORE" }), // another ticker counts too: the cap is per address
    row(`${TX("c")}:0`, "filling"), // the order book counts status open only
    row(`${TX("d")}:0`, "filled"),
    row(`${TX("e")}:0`, "cancelled"),
    row(`${TX("f")}:0`, "open", { seller: "bc1pother" }),
    row(`${TX("1")}:0`, "open", { expires_at: NOW }), // expired: the book drops it before it counts
    row(`${TX("2")}:1`, "open", { expires_at: null }), // no expiry known: counted
    row(`${TX("A")}:0`), // the same outpoint as TX("a") in upper case: one listing
  ];
  const q = listingQuota(orders, ME, { nowSec: NOW });
  assert.equal(q.used, 3);
  assert.equal(q.cap, 10);
  assert.equal(q.full, false);
  assert.equal(q.complete, true);
  assert.deepEqual([...q.ids].sort(), [`${TX("2")}:1`, `${TX("a")}:0`, `${TX("b")}:0`].sort());
  assert.equal(listingQuotaText(q), "3 of 10 listings used");
  assert.equal(listingQuotaText({ ...q, complete: false }), "At least 3 of 10 listings used", "a partial read is a lower bound");
  assert.equal(listingQuotaText(null), "");
  // a later row for the same id wins: the live book read after the per-address list
  assert.equal(listingQuota([row(`${TX("a")}:0`), row(`${TX("a")}:0`, "filling")], ME, { nowSec: NOW }).used, 0);
  assert.equal(listingQuota([row(`${TX("a")}:0`, "filling"), row(`${TX("a")}:0`)], ME, { nowSec: NOW }).used, 1);
  assert.equal(listingQuota(null, ME).used, 0);
  const ten = Array.from({ length: 10 }, (_, i) => row(`${TX("9")}:${i}`));
  const full = listingQuota(ten, ME, { nowSec: NOW });
  assert.deepEqual([full.used, full.full], [10, true]);
  assert.equal(listingQuotaText(full), "10 of 10 listings used");
  console.log("listing cap counter: open only (not filling / closed / expired / another seller), all tickers, one per outpoint");
}

// ---- the check before signing: a new listing vs listing a listed outpoint again ----------------------------------
{
  const nine = listingQuota(Array.from({ length: 9 }, (_, i) => row(`${TX("9")}:${i}`)), ME, { nowSec: NOW });
  const ten = listingQuota(Array.from({ length: 10 }, (_, i) => row(`${TX("9")}:${i}`)), ME, { nowSec: NOW });
  assert.deepEqual(listingCapDecision(nine, `${TX("8")}:0`), { ok: true, kind: "new", used: 9, cap: 10 }, "the 10th listing is allowed");
  assert.deepEqual(listingCapDecision(ten, `${TX("8")}:0`), { ok: false, kind: "cap", used: 10, cap: 10 }, "an 11th is refused before signing");
  assert.deepEqual(listingCapDecision(ten, `${TX("9")}:3`), { ok: true, kind: "replace", used: 10, cap: 10 }, "re-pricing a listed outpoint takes no new place");
  assert.equal(listingCapDecision(ten, `${TX("9").toUpperCase()}:3`).kind, "replace", "outpoint ids compare case-insensitively");
  assert.deepEqual(listingCapDecision(null, `${TX("8")}:0`), { ok: true, kind: "unknown" }, "an unknown count never blocks: the book decides");
  // a filling listing is not an open one: listing that outpoint would be new (the book refuses it as a pending spend first)
  const withFilling = listingQuota([...Array.from({ length: 10 }, (_, i) => row(`${TX("9")}:${i}`)), row(`${TX("7")}:0`, "filling")], ME, { nowSec: NOW });
  assert.equal(listingCapDecision(withFilling, `${TX("7")}:0`).kind, "cap");
  // an expired listing of the same outpoint: the book drops it first, so this is a new listing
  const expired = listingQuota([...Array.from({ length: 10 }, (_, i) => row(`${TX("9")}:${i}`)), row(`${TX("6")}:0`, "open", { expires_at: NOW - 1 })], ME, { nowSec: NOW });
  assert.equal(listingCapDecision(expired, `${TX("6")}:0`).kind, "cap");
  console.log("listing cap check: at 10 a new listing is refused before the wallet signs; the same outpoint again is allowed");
}

// ---- reading every page of the per-address list -------------------------------------------------------------------
{
  const pager = (total, { drop = 0 } = {}) => {
    const calls = [];
    const all = Array.from({ length: total }, (_, i) => row(`${TX("5")}:${i}`, i === total - 1 ? "open" : "filled"));
    const fetchPage = async (offset, limit) => {
      calls.push([offset, limit]);
      return { total: total + drop, items: all.slice(offset, offset + limit) };
    };
    return { calls, fetchPage };
  };
  const p1 = pager(450);
  const r1 = await readSellerOrders(p1.fetchPage, { pageSize: 200 });
  assert.deepEqual(p1.calls, [[0, 200], [200, 200], [400, 200]]);
  assert.equal(r1.items.length, 450);
  assert.equal(r1.complete, true);
  assert.equal(listingQuota(r1.items, ME, { nowSec: NOW }).used, 1, "the one open listing behind 449 closed rows is found");
  const p2 = pager(450);
  const r2 = await readSellerOrders(p2.fetchPage, { pageSize: 200, maxPages: 2 });
  assert.deepEqual([p2.calls.length, r2.items.length, r2.complete], [2, 400, false], "stopped early: a lower bound");
  const p3 = pager(20);
  const r3 = await readSellerOrders(p3.fetchPage, { pageSize: 200 });
  assert.deepEqual([p3.calls.length, r3.complete], [1, true]);
  const p4 = pager(150, { drop: 300 }); // total says 450, the rows end at 150: an empty page before the end
  const r4 = await readSellerOrders(p4.fetchPage, { pageSize: 100 });
  assert.deepEqual([p4.calls.length, r4.items.length, r4.complete], [3, 150, false]);
  const r5 = await readSellerOrders(async () => ({ items: [row(`${TX("4")}:0`)] }), { pageSize: 200 });
  assert.deepEqual([r5.items.length, r5.complete], [1, true], "no total: a short page is the last one");
  console.log("listing cap reader: every page of the per-address list, a partial read flagged");
}

// ---- the order book's refusal → the same plain words ---------------------------------------------------------------
{
  const e = orderHttpError("/orders", 400, JSON.stringify({ error: "seller has 10 open orders (cap 10)" }));
  assert.equal(e.message, "seller has 10 open orders (cap 10)");
  assert.equal(listingRefusalText(e), listingCapText(10));
  assert.equal(
    listingCapText(10),
    "This address already has 10 open listings, the most the order book allows for one address (all tokens together). To list another UTXO, withdraw one of your listings (the Portfolio page shows all of them), or wait until one sells or expires. A UTXO that is already listed can still be listed again at the same or a lower price.",
  );
  const generic = listingRefusalText(orderHttpError("/orders", 400, JSON.stringify({ error: "seller has 7 open orders (cap 7)" })));
  assert.equal(generic, listingCapText(7));
  assert.match(generic, /already has 7 open listings/);
  assert.deepEqual(SELLER_CAP_RE.exec("seller has 12 open orders (cap 12)").slice(1), ["12", "12"]);
  // above the cap (a fill that left the mempool turned a listing open again): the real count, the real cap
  const above = listingRefusalText(orderHttpError("/orders", 400, JSON.stringify({ error: "seller has 11 open orders (cap 10)" })));
  assert.equal(above, listingCapText(10, 11));
  assert.match(above, /^This address already has 11 open listings; the order book allows at most 10 for one address \(all tokens together\)\./);
  assert.equal(listingCapText(10, 10), listingCapText(10), "at the cap the text is unchanged");
  assert.equal(listingCapText(10, 3), listingCapText(10), "a count below the cap never shows (the refusal is at the cap)");
  // the per-TICKER cap is another rule with its own words — whatever the ticker is called
  for (const t of ["BLOK", "SELLER", "RESELLER", "XSELLER", "TIMELOCK", "NVERSION"]) {
    const msg = `${t} has 7500 open orders (cap 7500); a new ask must undercut the worst one (12.0000 sats/token)`;
    assert.equal(SELLER_CAP_RE.exec(msg), null, t);
    const perTicker = listingRefusalText(orderHttpError("/orders", 400, JSON.stringify({ error: msg })));
    assert.notEqual(perTicker, listingCapText(7500), t);
    assert.equal(perTicker, `The order book refused this listing: ${msg}.`, t);
  }
  for (const near of ["Seller has 10 open orders (cap 10)", "reseller has 10 open orders (cap 10)", "seller has 10 open orders (cap 10); more"]) {
    assert.equal(SELLER_CAP_RE.exec(near), null, near);
  }
  assert.equal(listingRefusalText(Object.assign(new Error("seller has 10 open orders (cap 10)"), { status: 502 })), null, "not a refusal of the book");
  console.log("listing cap refusal: the book's 400 text maps to the same plain words as the check before signing");
}

// ---- the mock order book: the same cap, the indexer's exact 400 --------------------------------------------------------
{
  const ADDR = MOCK_WALLET.address;
  const readQuota = async () => {
    const r = await readSellerOrders((offset, limit) => mockGet(`/orders/by-address/${ADDR}?limit=${limit}&offset=${offset}`).then((env) => ({ total: env.total, items: env.orders })), { pageSize: 200 });
    return listingQuota(r.items, ADDR, { complete: r.complete });
  };
  const q0 = await readQuota();
  assert.equal(q0.used, 9, "the knob's 9 open listings; the wallet's own filling listing is not counted");
  const utxos = (await mockGet(`/utxos/${ADDR}`)).utxos;
  const blokCarriers = utxos.filter((u) => Object.keys(u.balances).length === 1 && u.balances.BLOK > 0);
  const listed = blokCarriers.filter((u) => q0.ids.has(`${u.txid}:${u.vout}`));
  const unlisted = blokCarriers.filter((u) => !q0.ids.has(`${u.txid}:${u.vout}`));
  assert.equal(listed.length, 9);
  const floor = (await mockGet("/tokens/BLOK")).floor_unit_price;
  assert.ok(floor > 0, "BLOK has a floor");
  const sign = (u, priceSats) => {
    const built = buildListingPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: { txid: u.txid, vout: u.vout, sats: 546 }, priceSats, amount: u.balances.BLOK });
    return mockSignPsbt(built.psbtHex, { autoFinalized: false, toSignInputs: [{ index: 0, address: ADDR, sighashTypes: [LISTING_SIGHASH] }] });
  };
  const list = (u, priceSats) => mockPostJson("/orders", { psbt: sign(u, priceSats), ticker: "BLOK", amount: u.balances.BLOK, price_sats: priceSats });
  const fresh = unlisted.filter((u) => u.balances.BLOK < 1_921); // the knob's two carriers (not the wallet's filling one)
  assert.equal(fresh.length, 2);
  const [n10, n11] = fresh;
  const priceOf = (u) => Math.round(floor * 1.5 * u.balances.BLOK);

  // the 10th: allowed by the check and by the book
  assert.equal(listingCapDecision(q0, `${n10.txid}:${n10.vout}`).kind, "new");
  const tenth = await list(n10, priceOf(n10));
  assert.equal(tenth.status, "open");
  assert.equal(tenth.replaced, false, "a new listing replaces nothing (the flag is always present, like the live book's 201)");
  const q1 = await readQuota();
  assert.deepEqual([q1.used, q1.full], [10, true]);
  assert.equal(listingQuotaText(q1), "10 of 10 listings used");

  // the 11th: the check refuses it before signing, and the book answers the indexer's exact 400
  assert.deepEqual(listingCapDecision(q1, `${n11.txid}:${n11.vout}`), { ok: false, kind: "cap", used: 10, cap: 10 });
  await assert.rejects(list(n11, priceOf(n11)), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.message, "seller has 10 open orders (cap 10)");
    assert.deepEqual(JSON.parse(e.body), { error: "seller has 10 open orders (cap 10)" });
    assert.equal(listingRefusalText(e), listingCapText(10));
    return true;
  });

  // re-pricing (lower) and renewing (same price) a listed outpoint at the cap: a replace, not a new listing
  const target = listed[0];
  const cur = (await mockGet(`/orders/${target.txid}:${target.vout}`)).price_sats;
  assert.equal(listingCapDecision(q1, `${target.txid}:${target.vout}`).kind, "replace");
  const lower = await list(target, cur - 1);
  assert.deepEqual([lower.replaced, lower.price_sats], [true, cur - 1]);
  const renewed = await list(target, cur - 1);
  assert.equal(renewed.replaced, true);
  // a higher price is still the withdraw-first 409, not the cap
  await assert.rejects(list(target, cur + 10), (e) => e.status === 409 && /withdraw first/.test(e.message));
  // the wallet's own filling listing: the pending-spend refusal comes first, as in the order book
  const filling = unlisted.find((u) => u.balances.BLOK === 1_921);
  assert.ok(filling, "the wallet's filling BLOK carrier");
  await assert.rejects(list(filling, priceOf(filling)), (e) => e.status === 409 && /pending spend/.test(e.message));
  assert.equal((await readQuota()).used, 10, "still 10 after the replaces and refusals");
  console.log("mock order book: 10th listing accepted, 11th → 400 \"seller has 10 open orders (cap 10)\"; re-price / renew at the cap accepted");
}

// ---- above the cap: renewing and re-pricing still work, a new listing is refused with the real count ---------------
// An address can hold more open listings than the cap without adding any: a
// `filling` listing does not count, and when that fill leaves the mempool
// unconfirmed the listing is open again. A second mock world (its own module
// instance, built with the knob at 11) starts in that state.
{
  store.set("lp.mock.myListings", "11");
  const m2 = await import("../src/lib/mock.js?above-cap");
  const ADDR = m2.MOCK_WALLET.address;
  const r = await readSellerOrders((offset, limit) => m2.mockGet(`/orders/by-address/${ADDR}?limit=${limit}&offset=${offset}`).then((env) => ({ total: env.total, items: env.orders })), { pageSize: 200 });
  const q = listingQuota(r.items, ADDR, { complete: r.complete });
  assert.deepEqual([q.used, q.full], [11, true], "11 open listings, one above the cap");
  assert.equal(listingQuotaText(q), "11 of 10 listings used");
  const utxos = (await m2.mockGet(`/utxos/${ADDR}`)).utxos;
  const blok = utxos.filter((u) => Object.keys(u.balances).length === 1 && u.balances.BLOK > 0);
  const listed = blok.filter((u) => q.ids.has(`${u.txid}:${u.vout}`));
  const fresh = blok.filter((u) => !q.ids.has(`${u.txid}:${u.vout}`) && u.balances.BLOK < 1_921);
  assert.equal(listed.length, 11);
  assert.equal(fresh.length, 2);
  const sign = (u, priceSats) => {
    const built = buildListingPsbt({ address: ADDR, pubkeyHex: m2.MOCK_WALLET.pubkeyHex, tokenUtxo: { txid: u.txid, vout: u.vout, sats: 546 }, priceSats, amount: u.balances.BLOK });
    return m2.mockSignPsbt(built.psbtHex, { autoFinalized: false, toSignInputs: [{ index: 0, address: ADDR, sighashTypes: [LISTING_SIGHASH] }] });
  };
  const list = (u, priceSats) => m2.mockPostJson("/orders", { psbt: sign(u, priceSats), ticker: "BLOK", amount: u.balances.BLOK, price_sats: priceSats });
  const priceNow = async (u) => (await m2.mockGet(`/orders/${u.txid}:${u.vout}`)).price_sats;

  // renew (same price) and re-price (lower): the check allows them, and so does the book
  for (const [u, delta] of [[listed[0], 0], [listed[1], -1], [listed[10], -3]]) {
    assert.equal(listingCapDecision(q, `${u.txid}:${u.vout}`).kind, "replace");
    const cur = await priceNow(u);
    const view = await list(u, cur + delta);
    assert.deepEqual([view.replaced, view.price_sats], [true, cur + delta]);
  }
  // a new listing: refused before signing, and by the book with the real count
  const [n] = fresh;
  assert.deepEqual(listingCapDecision(q, `${n.txid}:${n.vout}`), { ok: false, kind: "cap", used: 11, cap: 10 });
  const floor = (await m2.mockGet("/tokens/BLOK")).floor_unit_price;
  await assert.rejects(list(n, Math.round(floor * 1.5 * n.balances.BLOK)), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.message, "seller has 11 open orders (cap 10)");
    assert.equal(listingRefusalText(e), listingCapText(10, 11));
    return true;
  });
  console.log("above the cap: renew and lower re-price accepted; a new listing → \"seller has 11 open orders (cap 10)\"");
}

console.log("listing cap: all checks passed");
