// The mock order book settles listings the way the indexer does, end to
// end through real PSBTs:
//
//   1. a fill is a spend signed with the listing's SIGHASH_SINGLE |
//      ANYONECANPAY signature that pays the seller at the listed input's
//      index — a withdrawal (a SEND to yourself, default sighash) of a
//      listing priced at the 546-sat minimum is cancelled, never a
//      self-trade;
//   2. a listing that left the book (its time ran out) is still shown to
//      its seller as "expired" while its outpoint is unspent, a higher
//      re-listing of it is refused, and a fill of its saved signature is
//      still recorded as a trade;
//   3. the stored listing is the canonical PSBT: extra partial signatures
//      in front of the seller's are gone, and a carrier under 546 sats is
//      refused with the book's own sentence;
//   4. GET /orders lists every status in the book's one order;
//   5. what the book serves reads as the indexer serves it: a canonical
//      P2TR listing without an internal key still fills, an internal key
//      that does not tweak to the output key is dropped (never a refusal),
//      the 546-sat and whole-balance refusals use the book's words, a
//      pending fill carries its fee / vsize / feerate without moving the
//      expiry (and the listing is open again once nothing in the mempool
//      spends it), and expired rows and trades carry exactly the API's keys.
//
// Plain Node, no framework.
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";

// The mock's dev knobs, read when its world is first built: one open BLOK
// listing of the simulated wallet plus two unlisted BLOK carriers, and a
// listing of it that already left the book.
const store = new Map([
  ["lp.mock.myListings", "1"],
  ["lp.mock.offBook", "1"],
]);
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  writable: true,
  value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
});

const mock = await import("../src/lib/mock.js");
const { MOCK_WALLET, mockGet, mockPostJson, mockSignPsbt, simulateBroadcast, SMALL_CARRIER_LISTING_TEXT } = mock;
const { mockSpendable } = await import("./mockspend.js");
const { LISTING_SIGHASH, buildFillPsbt, buildListingPsbt, finalizeFill, parseListing, verifyListing } = await import("../src/lib/swap.js");
const { buildSendPsbt } = await import("../src/lib/psbt.js");
const { WITHDRAW_FIRST_TEXT } = await import("../src/lib/listingRules.js");
const indexer = await import("../src/lib/indexer.js");

const ADDR = MOCK_WALLET.address;
const realNow = Date.now;
const past = () => Date.now() - 60_000; // a broadcast that has had time to confirm

/** The simulated wallet's spendable BTC (its own list checked with GET /txouts) and token outpoints, as a build reads them. */
async function walletRows() {
  const btcRows = (await mockSpendable(mock, ADDR)).utxos;
  const tokenRows = (await mockGet(`/utxos/${ADDR}`)).utxos;
  return { btcRows, tokenRows, tokenOutpoints: tokenRows.map(({ txid, vout }) => ({ txid, vout })) };
}

/** Sign and broadcast a SEND of `amount` BLOK from `carrier` back to the wallet (a withdrawal). */
async function withdraw(carrier, amount) {
  const { btcRows, tokenOutpoints } = await walletRows();
  const built = buildSendPsbt({
    address: ADDR,
    pubkeyHex: MOCK_WALLET.pubkeyHex,
    utxos: btcRows,
    tokenOutpoints,
    tokenUtxos: [{ txid: carrier.txid, vout: carrier.vout, sats: 546 }],
    feeRateSatVb: 2,
    ticker: "BLOK",
    amount,
    toAddress: ADDR,
  });
  const signed = mockSignPsbt(built.psbtHex, { toSignInputs: built.inputIndexes.map((index) => ({ index, address: ADDR })) });
  const tx = btc.Transaction.fromPSBT(hex.decode(signed));
  return simulateBroadcast(hex.encode(tx.extract()), { at: past() });
}

/** Fill `listing` (an OrderView with its PSBT) from the simulated wallet. */
async function fillFromWallet(listing) {
  const { btcRows, tokenOutpoints } = await walletRows();
  const built = buildFillPsbt({ listingPsbtHex: listing.psbt, order: listing, sendAmount: listing.amount, address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: btcRows, tokenOutpoints, feeRateSatVb: 2 });
  const signed = mockSignPsbt(built.psbtHex, { toSignInputs: built.inputIndexes.map((index) => ({ index, address: ADDR })) });
  return simulateBroadcast(finalizeFill(signed, { op: "SEND", ticker: listing.ticker, amount: listing.amount }), { at: past() });
}

// ---- 1. a withdrawal at the minimum price is cancelled, not a fill ----------------------------------
{
  const floor = (await mockGet("/tokens/BLOK")).floor_unit_price;
  assert.ok(floor > 0);
  const mineRows = (await mockGet(`/orders/by-address/${ADDR}?limit=200`)).orders;
  const listedIds = new Set(mineRows.map((o) => o.id));
  const { tokenRows } = await walletRows();
  const free = tokenRows.filter((u) => Object.keys(u.balances).length === 1 && u.balances.BLOK > 0 && u.balances.BLOK < 400 && !listedIds.has(`${u.txid}:${u.vout}`));
  assert.ok(free.length >= 1, "an unlisted BLOK carrier of the simulated wallet");
  const c = free[0];
  const amount = c.balances.BLOK;
  const built = buildListingPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: { txid: c.txid, vout: c.vout, sats: 546 }, priceSats: 546, amount });
  const signed = mockSignPsbt(built.psbtHex, { autoFinalized: false, toSignInputs: [{ index: 0, address: ADDR, sighashTypes: [LISTING_SIGHASH] }] });
  const view = await mockPostJson("/orders", { psbt: signed, ticker: "BLOK", amount, price_sats: 546 });
  assert.equal(view.status, "open");
  const txid = await withdraw(c, amount);
  const after = await mockGet(`/orders/${c.txid}:${c.vout}`);
  assert.equal(after.status, "cancelled", "a SEND to yourself (default sighash) cancels — even when it pays yourself ≥ the 546-sat price");
  assert.equal(after.buyer, null);
  assert.equal(after.spent_txid, txid);
  const trades = (await mockGet("/trades?ticker=BLOK&limit=200")).items;
  assert.equal(trades.some((t) => t.txid === txid), false, "no trade row for a withdrawal");
  console.log("market settle: a withdrawal of a 546-sat listing is cancelled — no self-trade, no trade row");
}

// ---- 3. the stored listing is canonical; a carrier under 546 sats is refused ------------------------
{
  const open = (await mockGet("/orders?ticker=BLOK&status=open&limit=200")).items;
  const mine = open.find((o) => o.seller === ADDR);
  assert.ok(mine, "the simulated wallet's open listing (the knob)");
  const full = await mockGet(`/orders/${mine.id}`);
  const [txid, vout] = full.id.split(":");
  // Re-listed at the same price: the book stores and serves the canonical PSBT (the unsigned tx,
  // input 0's witnessUtxo and sighash type, the seller's signature — nothing else).
  const b = buildListingPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: { txid, vout: Number(vout), sats: full.carrier_sats }, priceSats: full.price_sats, amount: full.amount });
  const signed = mockSignPsbt(b.psbtHex, { autoFinalized: false, toSignInputs: [{ index: 0, address: ADDR, sighashTypes: [LISTING_SIGHASH] }] });
  const renewed = await mockPostJson("/orders", { psbt: signed, ticker: "BLOK", amount: full.amount, price_sats: full.price_sats });
  assert.equal(renewed.replaced, true, "the same price renews it");
  const stored = await mockGet(`/orders/${full.id}`);
  const L = parseListing(stored.psbt);
  assert.equal(L.inputCount, 1);
  assert.equal(L.outputCount, 1);
  assert.equal(L.input0.sighashType, LISTING_SIGHASH);
  assert.ok(L.input0.tapKeySig && L.input0.tapKeySig.length === 65, "only the seller's key-path signature");
  assert.equal(verifyListing({ psbtHex: stored.psbt, order: stored }).ok, true, "the canonical PSBT passes the buyer's checks");
  console.log("market settle: the book stores the canonical listing PSBT");
}
{
  // A P2WPKH seller with a stranger's partial signature in front of its own: the web buyer picks the
  // seller's by its key, and the fill's witness carries only that one.
  const priv = new Uint8Array(32).fill(5);
  const pub = pubECDSA(priv, true);
  const pay = btc.p2wpkh(pub);
  const tx = new btc.Transaction({ lockTime: 0 });
  tx.addOutput({ script: pay.script, amount: 10_000n });
  tx.addInput({ txid: "ab".repeat(32), index: 0, witnessUtxo: { script: pay.script, amount: 546n }, sighashType: LISTING_SIGHASH });
  tx.signIdx(priv, 0, [LISTING_SIGHASH]);
  const own = tx.getInput(0).partialSig[0];
  const stranger = [pubECDSA(new Uint8Array(32).fill(6), true), own[1]];
  tx.updateInput(0, { partialSig: undefined }, true);
  tx.updateInput(0, { partialSig: [stranger, own] }, true);
  const psbtHex = hex.encode(tx.toPSBT());
  const order = { id: `${"ab".repeat(32)}:0`, ticker: "BLOK", amount: 10, price_sats: 10_000, carrier_sats: 546, seller: pay.address };
  const v = verifyListing({ psbtHex, order });
  assert.equal(v.ok, true, "the seller's signature is found by its key, not by its place");
  assert.equal(v.checks.find((c) => c.id === "signature").ok, true);
  const noOwn = btc.Transaction.fromPSBT(hex.decode(psbtHex));
  noOwn.updateInput(0, { partialSig: undefined }, true);
  noOwn.updateInput(0, { partialSig: [stranger] }, true);
  const noOwnCheck = verifyListing({ psbtHex: hex.encode(noOwn.toPSBT()), order });
  assert.equal(noOwnCheck.ok, false, "a partialSig from another key is no seller signature");
  assert.match(noOwnCheck.checks.find((c) => c.id === "signature").detail, /no partialSig from the key of the listed UTXO/);
  console.log("market settle: a P2WPKH listing's signature is the one from the listed UTXO's key");
}
{
  // The book refuses a listed output under 546 sats with its own sentence.
  assert.equal(SMALL_CARRIER_LISTING_TEXT, "listed output holds fewer than 546 sats; send the tokens to a 546-sat carrier first");
}

// ---- 4. GET /orders: one order for every status ----------------------------------------------------
{
  for (const status of ["open", "all", "cancelled"]) {
    const items = (await mockGet(`/orders?ticker=BLOK&status=${status}&limit=200`)).items;
    const sorted = [...items].sort((a, b) => a.unit_price - b.unit_price || a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    assert.deepEqual(items.map((o) => o.id), sorted.map((o) => o.id), `status=${status}: unit price, then age, then id`);
  }
  console.log("market settle: GET /orders sorts every status by unit price, age, id");
}

// ---- 2. a listing that left the book --------------------------------------------------------------
{
  // The knob's listing of the simulated wallet that already left the book.
  const env = await mockGet(`/orders/by-address/${ADDR}?limit=200`);
  assert.equal(env.orders.some((o) => o.status === "expired"), false, "never among the paged book rows");
  const off = env.expired;
  assert.equal(off.length, 1, "the seller sees the listing that left the book");
  assert.equal(env.expired_total, 1);
  assert.deepEqual((await mockGet(`/orders/by-address/${ADDR}?limit=1&offset=5`)).expired.map((x) => x.id), off.map((x) => x.id), "sent with every page, outside the paging");
  const o = off[0];
  assert.equal(o.seller, ADDR);
  assert.ok(o.price_sats >= 546 && o.amount === 400);
  assert.equal(await mockGet(`/orders/${o.id}`).catch((e) => e.status), 404, "it is not on the book any more");
  // The reader keeps it (through the real HTTP path).
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const body = await mockGet(u.pathname + u.search);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const read = await indexer.ordersByAddress(ADDR, { limit: 200 });
  globalThis.fetch = savedFetch;
  assert.equal(read.items.some((x) => x.id === o.id), false, "kept apart from the paged rows, so an offset walk stays exact");
  const row = read.expired.find((x) => x.id === o.id);
  assert.equal(row.status, "expired", "ordersByAddress keeps an off-book row");
  assert.equal(read.expiredTotal, 1);
  // A higher re-listing is refused: its old signature is cheaper and still fillable.
  const [txid, vout] = o.id.split(":");
  const sign = (priceSats) => {
    const b = buildListingPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: { txid, vout: Number(vout), sats: 546 }, priceSats, amount: o.amount });
    return mockSignPsbt(b.psbtHex, { autoFinalized: false, toSignInputs: [{ index: 0, address: ADDR, sighashTypes: [LISTING_SIGHASH] }] });
  };
  await assert.rejects(mockPostJson("/orders", { psbt: sign(o.price_sats + 1), ticker: "BLOK", amount: o.amount, price_sats: o.price_sats + 1 }), (e) => e.status === 409 && e.message === WITHDRAW_FIRST_TEXT, "higher than the floor → withdraw first");
  const relisted = await mockPostJson("/orders", { psbt: sign(o.price_sats), ticker: "BLOK", amount: o.amount, price_sats: o.price_sats });
  assert.equal(relisted.replaced, false, "the same price is a new listing (it takes a place under the cap)");
  const again = await mockGet(`/orders/by-address/${ADDR}?limit=200`);
  assert.deepEqual(again.orders.filter((x) => x.id === o.id).map((x) => x.status), ["open"], "once listed again, the live row stands for it");
  assert.equal(again.expired.some((x) => x.id === o.id), false);
  console.log("market settle: an off-book listing is shown to its seller as expired, guards its price, and can be listed again at that price");
}
{
  // A seeded trader's listing whose PSBT a buyer saved leaves the book after
  // its time; a fill of the saved PSBT is still a trade.
  const open = (await mockGet("/orders?ticker=BLOK&status=open&limit=200")).items.filter((o) => o.seller !== ADDR);
  assert.ok(open.length > 0);
  const target = open[0];
  const saved = await mockGet(`/orders/${target.id}`);
  assert.ok(saved.psbt, "the book serves the PSBT to anyone");
  Date.now = () => realNow() + 15 * 86_400_000; // 15 days later
  try {
    assert.equal(await mockGet(`/orders/${target.id}`).catch((e) => e.status), 404, "its time ran out: off the book");
    const sellerRows = (await mockGet(`/orders/by-address/${target.seller}?limit=200`)).expired;
    assert.equal(sellerRows.find((x) => x.id === target.id)?.status, "expired", "its seller still sees it, as expired");
    const txid = await fillFromWallet(saved);
    const trades = (await mockGet("/trades?ticker=BLOK&limit=200")).items.filter((t) => t.txid === txid);
    assert.equal(trades.length, 1, "the fill of an off-book listing is one trade");
    assert.equal(trades[0].buyer, ADDR);
    assert.equal(trades[0].seller, target.seller);
    assert.equal(trades[0].order_id, target.id);
    assert.equal(trades[0].self_trade, false);
    assert.equal(trades[0].price_sats, saved.price_sats);
    const gone = (await mockGet(`/orders/by-address/${target.seller}?limit=200`)).expired.find((x) => x.id === target.id);
    assert.equal(gone, undefined, "spent: no longer shown as still fillable");
    const mineTrades = (await mockGet(`/trades/${ADDR}?limit=200`)).trades;
    assert.ok(mineTrades.some((t) => t.txid === txid), "the buyer's own trade list has it");
  } finally {
    Date.now = realNow;
  }
  console.log("market settle: a saved listing filled after it left the book is recorded as a trade");
}

// ---- 5. what the order book serves, as the buyer and the seller read it -----------------------------
{
  // The book keeps a P2TR listing's internal key only when it tweaks to the
  // output key; without it the listing still verifies, and the fill's input 0
  // is the seller's 65-byte key-path signature alone.
  const priv = new Uint8Array(32).fill(9);
  const xonly = pubSchnorr(priv);
  const pay = btc.p2tr(xonly);
  const id = `${"cd".repeat(32)}:0`;
  const tx = new btc.Transaction({ lockTime: 0 });
  tx.addInput({ txid: "cd".repeat(32), index: 0, witnessUtxo: { script: pay.script, amount: 546n }, sighashType: LISTING_SIGHASH, tapInternalKey: xonly });
  tx.addOutput({ script: pay.script, amount: 20_000n });
  tx.signIdx(priv, 0, [LISTING_SIGHASH]);
  const in0 = tx.getInput(0);
  const bare = new btc.Transaction({ version: tx.version, lockTime: 0 });
  bare.addOutput({ script: pay.script, amount: 20_000n });
  bare.addInput({ txid: in0.txid, index: in0.index, sequence: in0.sequence, witnessUtxo: in0.witnessUtxo, sighashType: LISTING_SIGHASH, tapKeySig: in0.tapKeySig });
  const listingHex = hex.encode(bare.toPSBT());
  const order = { id, ticker: "BLOK", amount: 40, price_sats: 20_000, carrier_sats: 546, seller: pay.address };
  assert.equal(parseListing(listingHex).input0.tapInternalKey, null);
  assert.equal(verifyListing({ psbtHex: listingHex, order }).ok, true, "no internal key: still a valid listing");
  const { btcRows, tokenOutpoints } = await walletRows();
  const built = buildFillPsbt({ listingPsbtHex: listingHex, order, sendAmount: order.amount, address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: btcRows, tokenOutpoints, feeRateSatVb: 2 });
  const signed = mockSignPsbt(built.psbtHex, { toSignInputs: built.inputIndexes.map((index) => ({ index, address: ADDR })) });
  const raw = btc.RawTx.decode(hex.decode(finalizeFill(signed, { op: "SEND", ticker: "BLOK", amount: 40 })));
  assert.deepEqual(raw.witnesses[0].map((w) => w.length), [65], "input 0: the seller's signature, nothing else");
  assert.equal(raw.witnesses[0][0][64], LISTING_SIGHASH);
  console.log("market settle: a canonical P2TR listing without an internal key still fills");
}
{
  // The mock book drops an internal key that does not tweak to the output
  // key (a submitted field the signature does not commit to), and refuses a
  // listed output under 546 sats before anything else about the UTXO — both
  // like the order book.
  // Neither listed nor a listing that left the book (a floor would refuse a higher price).
  const mineEnv = await mockGet(`/orders/by-address/${ADDR}?limit=200`);
  const listed = new Set([...mineEnv.orders.filter((o) => o.status === "open" || o.status === "filling"), ...mineEnv.expired].map((o) => o.id));
  const { tokenRows } = await walletRows();
  const free = tokenRows.filter((u) => Object.keys(u.balances).length === 1 && u.balances.BLOK > 0 && u.balances.BLOK < 400 && !listed.has(`${u.txid}:${u.vout}`));
  assert.ok(free.length >= 1, "an unlisted BLOK carrier");
  const c = free[0];
  const amount = c.balances.BLOK;
  const price = 546 * 40;
  const b = buildListingPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: { txid: c.txid, vout: c.vout, sats: 546 }, priceSats: price, amount });
  const signedHex = mockSignPsbt(b.psbtHex, { autoFinalized: false, toSignInputs: [{ index: 0, address: ADDR, sighashTypes: [LISTING_SIGHASH] }] });
  // A tapInternalKey that does not tweak to the output key (the app's PSBT
  // library will not even read such a PSBT) and bytes after the last map:
  // the book ignores both and stores the canonical listing.
  const ownKey = hex.encode(btc.Transaction.fromPSBT(hex.decode(signedHex)).getInput(0).tapInternalKey);
  assert.ok(signedHex.includes(`011720${ownKey}`));
  const junkHex = signedHex.replace(`011720${ownKey}`, `011720${hex.encode(pubSchnorr(new Uint8Array(32).fill(3)))}`) + "deadbeef";
  assert.throws(() => parseListing(junkHex), "a mismatched internal key: unreadable as it is");
  // A witnessUtxo under 546 sats: refused with the book's sentence, whatever the UTXO really holds.
  const small = btc.Transaction.fromPSBT(hex.decode(signedHex));
  small.updateInput(0, { witnessUtxo: { script: small.getInput(0).witnessUtxo.script, amount: 330n } }, true);
  await assert.rejects(mockPostJson("/orders", { psbt: hex.encode(small.toPSBT()), ticker: "BLOK", amount, price_sats: price }), (e) => e.status === 400 && e.message === SMALL_CARRIER_LISTING_TEXT, "a 330-sat carrier: the 546-sat rule");
  // The whole balance, in the book's words.
  await assert.rejects(mockPostJson("/orders", { psbt: signedHex, ticker: "BLOK", amount: amount + 1, price_sats: price }), (e) => e.status === 400 && e.message === `outpoint carries { BLOK: ${amount} }, listing must be its whole balance { BLOK: ${amount + 1} }`);
  const view = await mockPostJson("/orders", { psbt: junkHex, ticker: "blok", amount, price_sats: price });
  assert.equal(view.ticker, "BLOK", "the ticker is read upper-case, like the book reads it");
  const stored = await mockGet(`/orders/${c.txid}:${c.vout}`);
  assert.equal(parseListing(stored.psbt).input0.tapInternalKey, null, "a key that does not tweak to the output is not stored");
  assert.equal(verifyListing({ psbtHex: stored.psbt, order: stored }).ok, true);
  // A same-price renewal answers with the created_at the book keeps.
  const again = await mockPostJson("/orders", { psbt: stored.psbt, ticker: "BLOK", amount, price_sats: price });
  assert.equal(again.replaced, true);
  assert.equal(again.created_at, stored.created_at, "a renewal keeps its place");
  assert.equal(await mockGet("/orders?status=bogus").catch((e) => e.status), 400, "an unknown status is refused, like the book refuses it");
  console.log("market settle: the book's canonical listing, its 546-sat rule and whole-balance text, and its status list");
}
{
  // A fill in the mempool: the listing is `filling` with that spend's fee,
  // vsize and feerate (what a withdrawal has to out-bid), and its expiry
  // does not move.
  // (the listing of the block above: the 15-day look further up let every seeded one run out)
  const open = (await mockGet("/orders?ticker=BLOK&status=open&limit=200")).items;
  assert.ok(open.length > 0, "an open listing");
  const target = await mockGet(`/orders/${open[0].id}`);
  const { btcRows, tokenOutpoints } = await walletRows();
  const built = buildFillPsbt({ listingPsbtHex: target.psbt, order: target, sendAmount: target.amount, address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: btcRows, tokenOutpoints, feeRateSatVb: 3 });
  const signed = mockSignPsbt(built.psbtHex, { toSignInputs: built.inputIndexes.map((index) => ({ index, address: ADDR })) });
  const rawHex = finalizeFill(signed, { op: "SEND", ticker: target.ticker, amount: target.amount });
  const txid = simulateBroadcast(rawHex);
  const after = await mockGet(`/orders/${target.id}`);
  assert.equal(after.status, "filling");
  assert.equal(after.pending_spend_txid, txid);
  const vsize = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true }).vsize;
  assert.equal(after.pending_fee_sats, built.feeSats, "the pending spend's fee");
  assert.equal(after.pending_vsize, vsize);
  assert.equal(after.pending_feerate, Math.round((built.feeSats / vsize) * 100) / 100);
  assert.equal(after.updated_at, target.updated_at, "an observation, not a seller action: the expiry stays");
  assert.equal(after.expires_at, target.expires_at);
  // The buyer spends one of the fill's own inputs elsewhere at a higher fee: the fill leaves the
  // mempool, nothing spends the listed output any more, and the listing is open again.
  const inp = built.inputs[0];
  const script = btc.OutScript.encode(btc.Address(btc.NETWORK).decode(ADDR));
  const other = new btc.Transaction();
  other.addInput({ txid: inp.txid, index: inp.vout, witnessUtxo: { script, amount: BigInt(inp.sats) }, tapInternalKey: hex.decode(MOCK_WALLET.pubkeyHex).subarray(1) });
  other.addOutput({ script, amount: BigInt(inp.sats - 20_000) });
  const otherSigned = btc.Transaction.fromPSBT(hex.decode(mockSignPsbt(hex.encode(other.toPSBT()), { toSignInputs: [{ index: 0, address: ADDR }] })));
  simulateBroadcast(hex.encode(otherSigned.extract()));
  const reopened = await mockGet(`/orders/${target.id}`);
  assert.deepEqual([reopened.status, reopened.pending_spend_txid, reopened.pending_fee_sats, reopened.pending_feerate], ["open", null, null, null], "no spend in the mempool: open again");
  console.log("market settle: a pending fill shows its fee, vsize and feerate; the listing's expiry does not move; replaced elsewhere, it is open again");
}
if (process.env.LP_INDEXER_DIR) {
  // The rows the seller's list and the trade lists carry: exactly the keys
  // of the indexer API's own examples.
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const doc = join(process.env.LP_INDEXER_DIR, "docs", "API.md");
  assert.ok(existsSync(doc), "the indexer API doc");
  const lines = readFileSync(doc, "utf8").split("\n");
  const exampleKeys = (startsWith) => {
    const start = lines.findIndex((l) => l.startsWith(startsWith));
    assert.ok(start >= 0, `the API doc introduces ${startsWith}`);
    const open = lines.findIndex((l, i) => i > start && l.trim() === "```json");
    const close = lines.findIndex((l, i) => i > open && l.trim() === "```");
    return [...lines.slice(open + 1, close).join("\n").matchAll(/"([a-z_]+)"\s*:/g)].map((m) => m[1]).sort();
  };
  const expiredKeys = exampleKeys("**Listings that left the book.**");
  const tradeKeys = exampleKeys("`TradeView`");
  Date.now = () => realNow() + 15 * 86_400_000; // every seeded listing has left the book
  try {
    const sellers = [...new Set([ADDR, ...(await mockGet("/trades?limit=200")).items.map((t) => t.seller)])];
    let rows = [];
    for (const s of sellers) rows = rows.concat((await mockGet(`/orders/by-address/${s}?limit=200`)).expired);
    assert.ok(rows.length > 0, "listings that left the book");
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), expiredKeys, `expired row ${r.id}: the API's keys`);
    const trades = (await mockGet("/trades?limit=200")).items;
    assert.ok(trades.length > 0);
    for (const t of trades) assert.deepEqual(Object.keys(t).sort(), tradeKeys, `trade ${t.txid}: the API's keys`);
  } finally {
    Date.now = realNow;
  }
  console.log("market settle: expired rows and trade rows carry exactly the API's keys");
}

console.log("market settle: all checks passed");
