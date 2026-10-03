// Sell-form and buy-sheet rules, pure: the unit-price box never reads a
// thousands separator as a decimal point, a price far below the market
// needs a tick, a closed or off-book listing never reads as sold, a
// carrier this browser is already spending is never "listable", a fill's
// fee covers the seller's 65-byte signature, the sheet shows what really
// leaves the wallet, a fill whose listing was taken by another spend says
// so, the book is re-read right before signing, and the fill finalizes
// only the seller's own signature. Plain Node.
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import {
  LOW_PRICE_RATIO,
  fillOutcome,
  fillOutcomeText,
  fillQuote,
  fillingRowTitle,
  listingRefusalText,
  lowPriceCheck,
  orderSelectable,
  parseTotalInput,
  parseUnitInput,
  signTimeOrderProblem,
  slowFillWarning,
  unitInputProblem,
} from "../src/lib/market.js";
import {
  OWN_PENDING_SPEND_TEXT,
  isOffBook,
  listingCapText,
  listingStatusView,
  offBookText,
  readSellerOrders,
  relistDecision,
  sellRowState,
  smallCarrierText,
  splitBlockedReason,
} from "../src/lib/listingRules.js";
import { LISTING_SIGHASH, buildFillPsbt, buildListingPsbt, estimateFillCost, finalizeFill, verifyListing } from "../src/lib/swap.js";
import { extractRawTxHex, finalizeSignedInputs } from "../src/lib/psbt.js";
import { fmtExpires } from "../src/lib/format.js";
import { orderHttpError } from "../src/lib/indexer.js";

const TX = (c) => c.repeat(64);
const enc = (s) => new TextEncoder().encode(s);
function keyFor(seed, type) {
  const priv = sha256(enc(`sellbuy-test:${seed}`));
  const pub = pubECDSA(priv, true);
  if (type === "wpkh") {
    const p = btc.p2wpkh(pub, btc.NETWORK);
    return { priv, pub, pubkeyHex: hex.encode(pub), address: p.address, script: p.script, type };
  }
  const p = btc.p2tr(pubSchnorr(priv), undefined, btc.NETWORK);
  return { priv, pub, pubkeyHex: hex.encode(pub), address: p.address, script: p.script, type: "tr" };
}

// ---- the unit-price box ----------------------------------------------------------------------
{
  for (const t of ["1,000", "12,345", "1,000,000", "2,500", "1,000.5", "100,000"]) {
    assert.equal(parseUnitInput(t), null, `"${t}" is never read as a small number`);
    assert.match(unitInputProblem(t), /without thousands separators.*1000, not 1,000/, `"${t}" says why`);
  }
  assert.equal(parseUnitInput("15,5"), 15.5, "a single decimal comma stays a decimal comma");
  assert.equal(parseUnitInput("1,5"), 1.5);
  assert.equal(parseUnitInput("0,125"), 0.125, "a leading 0 makes it a decimal, never thousands");
  assert.equal(parseUnitInput("1000"), 1000);
  assert.equal(parseUnitInput("1000.25"), 1000.25);
  assert.equal(unitInputProblem("15x"), "Enter the price as a number of sats per token, e.g. 15.5.");
  assert.equal(unitInputProblem("15,5"), null);
  assert.equal(unitInputProblem(""), null);
  // The total box: whole sats — thousands separators laid out as such are just dropped.
  assert.equal(parseTotalInput("5,000,000"), 5_000_000);
  assert.equal(parseTotalInput("5000000"), 5_000_000);
  assert.ok(Number.isNaN(parseTotalInput("5,5")), "a decimal comma in a total is no whole number");
  assert.ok(Number.isNaN(parseTotalInput("12,34,567")), "separators not laid out as thousands");
  assert.ok(Number.isNaN(parseTotalInput("")));
  console.log("sell form: \"1,000\" is refused with a reason, never read as 1; \"15,5\" stays 15.5; a total may carry thousands separators");
}

// ---- a price far below the market needs one explicit tick --------------------------------------
{
  const token = { floor_unit_price: 1000, last_trade: { unit_price: 800 } };
  assert.equal(LOW_PRICE_RATIO, 0.1);
  assert.deepEqual(lowPriceCheck(1, token), { ref: 1000, refKind: "floor", ratio: 0.001 }, "a thousand times too small");
  assert.equal(lowPriceCheck(99.99, token).refKind, "floor");
  assert.equal(lowPriceCheck(100, token), null, "a tenth of the floor is not flagged");
  assert.equal(lowPriceCheck(5_000, token), null);
  assert.deepEqual(lowPriceCheck(50, { floor_unit_price: null, last_trade: { unit_price: 800 } }), { ref: 800, refKind: "last trade", ratio: 50 / 800 }, "no open ask: the last trade");
  assert.equal(lowPriceCheck(0.001, { floor_unit_price: null, last_trade: null }), null, "nothing to compare with: no tick");
  assert.equal(lowPriceCheck(null, token), null);
  console.log("sell form: below a tenth of the floor (or last trade) a listing needs a tick before signing");
}

// ---- the book's refusals in plain words -------------------------------------------------------
{
  const refused = (text, status = 400) => listingRefusalText(orderHttpError("/orders", status, JSON.stringify({ error: text })));
  for (const t of ["TIMELOCK", "NVERSION"]) {
    const out = refused(`outpoint carries { LUCKY: 1200, ${t}: 5 }, listing must be its whole balance { LUCKY: 1200 }`);
    assert.doesNotMatch(out, /no buyer could ever complete it/, `a ticker named ${t} is not a timelock refusal`);
    assert.match(out, /this UTXO's tokens do not match it/);
    assert.doesNotMatch(refused(`market opens when ${t} is fully minted (minted 1 of 2)`, 409), /no buyer could ever complete it/);
  }
  assert.match(refused("listing tx version must be 1 or 2 (got 3): a listing with any other version can never be filled"), /no buyer could ever complete it/);
  assert.match(refused("input0 nSequence 0x0000000a sets a relative timelock: use 0xfffffffd, 0xfffffffe or 0xffffffff (any value >= 0x80000000) so the listing can be filled"), /no buyer could ever complete it/);
  assert.equal(refused("listed output holds fewer than 546 sats; send the tokens to a 546-sat carrier first"), "The order book refused this listing: listed output holds fewer than 546 sats; send the tokens to a 546-sat carrier first.");
  assert.doesNotMatch(listingCapText(10), /expires/, "the cap text never implies a listing is over when it leaves the book");
  console.log("sell form: refusals naming a ticker never read as timelock refusals; the small-carrier refusal is the book's sentence");
}

// ---- off-book listings, row states, split guard, status words ----------------------------------
{
  const off = { id: `${TX("a")}:0`, ticker: "BLOK", amount: 400, price_sats: 40_000, unit_price: 100, seller: "bc1pme", carrier_sats: null, status: "expired" };
  assert.equal(isOffBook(off), true);
  assert.deepEqual(relistDecision(off, 40_001, 400), { ok: false, kind: "raise", current: off, offBook: true }, "higher than the floor: Withdraw first");
  assert.deepEqual(relistDecision(off, 40_000, 400), { ok: true, kind: "same", offBook: true }, "the same price: a new listing");
  assert.deepEqual(relistDecision(off, 30_000, 400), { ok: true, kind: "lower", offBook: true });
  assert.match(offBookText({ amount: 400, ticker: "BLOK", unitText: "100" }), /^An earlier listing of this output can still be bought at 100 sats per token — withdraw to cancel it\./);
  const row = (x) => ({ key: `${TX("b")}:1`, amount: 10, multi: false, sats: 546, listing: null, offBook: null, pending: false, ...x });
  assert.equal(sellRowState(row({})), "listable");
  assert.equal(sellRowState(row({ offBook: off })), "offbook", "an off-book listing is never plainly listable");
  assert.equal(sellRowState(row({ listing: { status: "open" } })), "listed");
  assert.equal(sellRowState(row({ listing: { status: "filling" } })), "filling");
  assert.equal(sellRowState(row({ sats: 5_000 })), "fat");
  // The order book lists only a carrier of at least 546 sats: a smaller one is moved first, never "listable".
  assert.equal(sellRowState(row({ sats: 330 })), "small");
  assert.equal(sellRowState(row({ sats: 545 })), "small");
  assert.equal(sellRowState(row({ sats: null })), "unknown");
  assert.match(smallCarrierText(330), /^This UTXO holds 330 sats of BTC; the order book lists only a carrier of at least 546 sats. Move the tokens to a fresh 546-sat carrier/);
  {
    const k = keyFor("small-carrier", "tr");
    assert.throws(() => buildListingPsbt({ address: k.address, pubkeyHex: k.pubkeyHex, tokenUtxo: { txid: TX("c"), vout: 0, sats: 330 }, priceSats: 1_000, amount: 5 }), /holds 330 sats — the order book lists only a carrier of at least 546 sats/, "never signed: the book would refuse it");
  }
  assert.equal(sellRowState(row({ multi: true })), "multi");
  assert.equal(sellRowState(row({}), new Set([`${TX("b")}:1`])), "pending", "one of this browser's own transactions spends it");
  assert.equal(sellRowState(row({ listing: { status: "open" } }), new Set([`${TX("b")}:1`])), "pending", "pending wins over every other state");
  assert.equal(splitBlockedReason(row({})), null);
  assert.equal(splitBlockedReason(row({ listing: { status: "open" } })), null, "splitting an open listing withdraws it — allowed");
  assert.match(splitBlockedReason(row({ listing: { status: "filling" } })), /A fill of this listing is in the mempool — this UTXO cannot be split/);
  assert.match(splitBlockedReason(row({ listing: { status: "filling" } }), { ownPending: true }), /Your own transaction/);
  assert.equal(splitBlockedReason(row({ pending: true })), OWN_PENDING_SPEND_TEXT);
  // A withdrawn listing is never shown as sold.
  assert.deepEqual(listingStatusView({ status: "cancelled", spent_txid: TX("c") }).label, "withdrawn");
  assert.equal(listingStatusView({ status: "cancelled", spent_txid: null }).label, "cancelled");
  assert.equal(listingStatusView({ status: "filled", buyer: "bc1pme", seller: "bc1pme" }).label, "filled · self");
  assert.match(listingStatusView({ status: "filled", buyer: null, seller: "bc1pme" }).note, /burned/);
  assert.deepEqual(listingStatusView({ status: "filled", buyer: "bc1qother", seller: "bc1pme" }), { label: "filled", note: null });
  assert.equal(listingStatusView(off).label, "still buyable");
  assert.equal(listingStatusView({ status: "open" }), null);
  assert.equal(fmtExpires(1_000 + 3 * 86_400, 1_000), "leaves the book in 3d", "never \"expires\": the signature outlives the book");
  assert.equal(fmtExpires(1_000, 2_000), "leaving the book");
  // The expired rows travel beside the paged rows.
  const pages = [
    { total: 3, items: [{ id: "1" }, { id: "2" }], expired: [off] },
    { total: 3, items: [{ id: "3" }], expired: [off] },
  ];
  const read = await readSellerOrders(async (offset) => pages[offset / 2], { pageSize: 2 });
  assert.deepEqual(read.items.map((o) => o.id), ["1", "2", "3"], "an offset walk over the paged rows only");
  assert.deepEqual(read.expired, [off], "the off-book rows, once");
  assert.equal(read.complete, true);
  console.log("sell form: an off-book listing shows as still buyable with Withdraw, guards its price, and never reads as listable; a withdrawn one never as sold");
}

// ---- a fill that did not confirm: what became of it ---------------------------------------------
{
  const me = "bc1qbuyer";
  const mine = TX("1");
  const base = { id: `${TX("a")}:0`, seller: "bc1pseller", status: "open", spent_txid: null, spent_block: null, buyer: null, pending_spend_txid: null };
  assert.equal(fillOutcome(null, { txid: mine, address: me }), null, "no answer: nothing concluded");
  assert.equal(fillOutcome(base, { txid: mine, address: me }), null, "still open (the fill left the mempool): nothing concluded");
  assert.deepEqual(fillOutcome({ ...base, status: "filling", pending_spend_txid: TX("2") }, { txid: mine, address: me }), { kind: "replacing", txid: TX("2") });
  assert.equal(fillOutcome({ ...base, status: "filling", pending_spend_txid: mine }, { txid: mine, address: me }), null, "our own fill is the pending one");
  assert.deepEqual(fillOutcome({ ...base, status: "filled", spent_txid: TX("3"), spent_block: 970_396, buyer: "bc1qother" }, { txid: mine, address: me }), { kind: "other", txid: TX("3") });
  assert.deepEqual(fillOutcome({ ...base, status: "cancelled", spent_txid: TX("4"), spent_block: 970_396 }, { txid: mine, address: me }), { kind: "seller", txid: TX("4") });
  assert.deepEqual(fillOutcome({ ...base, status: "filled", spent_txid: TX("5"), spent_block: 970_396, buyer: "bc1pseller" }, { txid: mine, address: me }), { kind: "seller", txid: TX("5") }, "the seller's own fill of it");
  assert.deepEqual(fillOutcome({ ...base, status: "filled", spent_txid: TX("6"), spent_block: 970_396, buyer: me }, { txid: mine, address: me }), { kind: "mine", txid: TX("6") }, "our fill under another txid: followed, never \"your BTC did not move\"");
  assert.equal(fillOutcome({ ...base, status: "filled", spent_txid: mine, spent_block: 970_396, buyer: me }, { txid: mine, address: me }), null, "our own fill confirmed: the tx status says so");
  assert.equal(fillOutcome({ ...base, status: "cancelled", spent_txid: null }, { txid: mine, address: me }), null, "cancelled with no spend (a reorganization): our fill may still confirm");
  assert.match(fillOutcomeText({ kind: "other", txid: TX("3") }), /Another buyer's fill of this listing confirmed first.*your BTC did not move/);
  assert.match(fillOutcomeText({ kind: "seller", txid: TX("4") }), /The seller spent the listed UTXO first.*your BTC did not move/);
  assert.match(fillOutcomeText({ kind: "replacing", txid: TX("2") }), /has replaced yours in the mempool.*this page keeps checking/);
  console.log("buy sheet: a fill replaced by another buyer or by the seller says so, and that the BTC did not move");
}

// ---- right before signing, the book is read again ----------------------------------------------
{
  const shown = { id: `${TX("a")}:0`, status: "open", psbt: "70736274ff", price_sats: 60_000, amount: 1200, seller: "bc1pseller", carrier_sats: 546, market_open: true };
  assert.equal(signTimeOrderProblem(shown, shown), null);
  assert.match(signTimeOrderProblem({ ...shown, status: "filling" }, shown), /already in the mempool/);
  assert.match(signTimeOrderProblem({ ...shown, status: "filled" }, shown), /just been filled/);
  assert.match(signTimeOrderProblem({ ...shown, status: "cancelled" }, shown), /just been withdrawn/);
  assert.match(signTimeOrderProblem(null, shown), /no longer on the order book/);
  assert.match(signTimeOrderProblem({ ...shown, market_open: false }, shown), /market is not open/);
  assert.match(signTimeOrderProblem({ ...shown, price_sats: 59_000, psbt: "70736274ff00" }, shown), /changed since the sheet opened/);
  assert.match(signTimeOrderProblem({ ...shown, psbt: "70736274ff00" }, shown), /changed since the sheet opened/, "a new PSBT at the same price");
  console.log("buy sheet: signing re-reads the book — filling, closed, gone or changed listings are not signed");
}

// ---- the order book's filling rows, the slow-fee note --------------------------------------------
{
  assert.deepEqual(orderSelectable({ status: "filling" }, "x"), { ok: false, reason: "filling" });
  const title = fillingRowTitle({ pending_feerate: 2.5 });
  assert.match(title, /at 2\.5 sat\/vB/);
  assert.doesNotMatch(title, /double-spend/, "a higher-fee fill would replace it — never \"rejected as a double-spend\"");
  assert.match(slowFillWarning(1, { halfHourFee: 4 }), /below the Normal estimate \(4 sat\/vB\).*cannot be sped up/);
  assert.equal(slowFillWarning(4, { halfHourFee: 4 }), null);
  assert.equal(slowFillWarning(2, null), null, "no estimate: no note");
  console.log("buy sheet: a filling ask is explained truthfully; a rate below Normal is flagged before signing");
}

// ---- a fill's fee covers the seller's 65-byte signature; the sheet's net figure ------------------
{
  for (const [sellerType, buyerType, nIn, rate] of [
    ["tr", "tr", 2, 1],
    ["tr", "tr", 2, 1.5],
    ["tr", "tr", 4, 7],
    ["tr", "wpkh", 1, 3],
    ["tr", "wpkh", 1, 7],
    ["wpkh", "tr", 2, 1],
    ["wpkh", "wpkh", 2, 7],
  ]) {
    const seller = keyFor(`seller-${sellerType}-${buyerType}-${nIn}-${rate}`, sellerType);
    const buyer = keyFor(`buyer-${sellerType}-${buyerType}-${nIn}-${rate}`, buyerType);
    const order = { id: `${TX("d")}:0`, ticker: "LUCKY", amount: 1200, price_sats: 60_000, unit_price: 50, seller: seller.address, carrier_sats: 546, status: "open" };
    const listing = buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo: { txid: TX("d"), vout: 0, sats: 546 }, priceSats: 60_000, amount: 1200 });
    const lt = btc.Transaction.fromPSBT(hex.decode(listing.psbtHex));
    lt.signIdx(seller.priv, 0, [LISTING_SIGHASH]);
    const listingHex = hex.encode(lt.toPSBT());
    // nIn buyer inputs that each cover a share of the price (largest-first picks all of them)
    const each = Math.ceil(70_000 / nIn);
    const utxos = Array.from({ length: nIn }, (_, i) => ({ txid: TX(String((i % 9) + 1)), vout: i, sats: each, confirmed: true }));
    const fill = buildFillPsbt({ listingPsbtHex: listingHex, order, sendAmount: order.amount, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos, tokenOutpoints: [], feeRateSatVb: rate });
    assert.equal(fill.inputIndexes.length, nIn, "all buyer inputs used");
    const ft = btc.Transaction.fromPSBT(hex.decode(fill.psbtHex), { allowUnknownOutputs: true });
    for (const i of fill.inputIndexes) ft.signIdx(buyer.priv, i);
    for (const i of fill.inputIndexes) ft.finalizeIdx(i);
    const raw = finalizeFill(hex.encode(ft.toPSBT()));
    const real = btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true });
    assert.ok(fill.feeSats >= Math.ceil(real.vsize * rate), `${sellerType} seller / ${buyerType} buyer × ${nIn} @ ${rate}: fee ${fill.feeSats} ≥ ${real.vsize} vB × ${rate}`);
    // What leaves the wallet: the inputs minus the change — the gross total minus the listed UTXO's own BTC.
    const inSum = utxos.reduce((s, u) => s + u.sats, 0);
    assert.equal(inSum - fill.changeSats, fill.netSats, "net = buyer inputs − change");
    assert.equal(fill.netSats, fill.totalSats - 546);
    assert.equal(fill.carrierInSats, 546);
  }
  // The display quote carries the same split.
  const order = { id: `${TX("e")}:0`, ticker: "LUCKY", amount: 1200, price_sats: 20_000, seller: keyFor("fat", "tr").address, carrier_sats: 12_345 };
  const q = fillQuote({ order, address: keyFor("fatbuyer", "wpkh").address, feeRateSatVb: 2 });
  assert.equal(q.carrierInSats, 12_345, "a fat carrier's BTC comes back to the buyer");
  assert.equal(q.netSats, q.totalSats - 12_345);
  const est = estimateFillCost({ order: { ...order, carrier_sats: 546 }, address: keyFor("x", "tr").address, feeRateSatVb: 1 });
  assert.equal(est.netSats, est.totalSats - 546);
  console.log("fill: the fee covers the seller's 65-byte 0x83 signature at every rate; the net figure is what leaves the wallet");
}

// ---- finalizing: only the seller's own signature; signed-but-unfinalized buyer inputs --------------
{
  const seller = keyFor("wpkh-seller", "wpkh");
  const buyer = keyFor("tr-buyer", "tr");
  const order = { id: `${TX("f")}:0`, ticker: "LUCKY", amount: 1200, price_sats: 60_000, unit_price: 50, seller: seller.address, carrier_sats: 546, status: "open" };
  const listing = buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo: { txid: TX("f"), vout: 0, sats: 546 }, priceSats: 60_000, amount: 1200 });
  const lt = btc.Transaction.fromPSBT(hex.decode(listing.psbtHex));
  lt.signIdx(seller.priv, 0, [LISTING_SIGHASH]);
  const own = lt.getInput(0).partialSig[0];
  const stranger = keyFor("stranger", "wpkh");
  lt.updateInput(0, { partialSig: undefined }, true);
  lt.updateInput(0, { partialSig: [[stranger.pub, own[1]], own] }, true); // a stranger's entry in front, ending 0x83 too
  const listingHex = hex.encode(lt.toPSBT());
  assert.equal(verifyListing({ psbtHex: listingHex, order }).ok, true, "the seller's signature is found by its key");
  const fill = buildFillPsbt({ listingPsbtHex: listingHex, order, sendAmount: order.amount, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: [{ txid: TX("9"), vout: 1, sats: 100_000, confirmed: true }], tokenOutpoints: [], feeRateSatVb: 2 });
  const ft = btc.Transaction.fromPSBT(hex.decode(fill.psbtHex), { allowUnknownOutputs: true });
  for (const i of fill.inputIndexes) ft.signIdx(buyer.priv, i); // signed, NOT finalized (a wallet that ignores autoFinalized)
  const raw = finalizeFill(hex.encode(ft.toPSBT()));
  const out = btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true });
  const w0 = out.getInput(0).finalScriptWitness;
  assert.equal(hex.encode(w0[1]), hex.encode(seller.pub), "input 0's witness carries the seller's own key, never the stranger's");
  assert.equal(out.getInput(1).finalScriptWitness.length, 1, "the buyer's signed input was finalized here");
  // A finalized input 0 must be the seller's listing signature.
  const forged = btc.Transaction.fromPSBT(hex.decode(hex.encode(ft.toPSBT())), { allowUnknownOutputs: true });
  forged.updateInput(0, { partialSig: undefined }, true);
  forged.updateInput(0, { finalScriptWitness: [own[1], stranger.pub] }, true);
  assert.throws(() => finalizeFill(hex.encode(forged.toPSBT())), /not the seller's listing signature/);
  // An unsigned buyer input is still refused, in words that name no wallet brand.
  const unsigned = btc.Transaction.fromPSBT(hex.decode(fill.psbtHex), { allowUnknownOutputs: true });
  assert.throws(() => finalizeFill(hex.encode(unsigned.toPSBT())), (e) => /your wallet did not sign it/.test(e.message) && !/UniSat/.test(e.message));
  // The same finishing step for every other broadcast (MINE, SEND, DEPLOY).
  const plain = new btc.Transaction();
  plain.addInput({ txid: TX("8"), index: 0, witnessUtxo: { script: buyer.script, amount: 10_000n }, tapInternalKey: pubSchnorr(buyer.priv) });
  plain.addOutputAddress(buyer.address, 9_000n, btc.NETWORK);
  plain.signIdx(buyer.priv, 0);
  assert.equal(plain.inputStatus(0), "signed");
  const rawPlain = extractRawTxHex(hex.encode(plain.toPSBT()));
  assert.ok(rawPlain.length > 100, "a signed, unfinalized input is finalized before extraction");
  assert.equal(finalizeSignedInputs(plain).inputStatus(0), "finalized");
  console.log("fill: input 0 is finalized from the seller's own signature only; a wallet's signed-but-unfinalized inputs are finalized here");
}

console.log("sell / buy: all checks passed");
