// Order-book acceptance rules the app checks before signing / publishing a
// listing, the buyer's carrier-amount check, and the mock order book
// applying the same rules so the preview walks them. Plain Node.
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import { COMMIT_CARRIER_LISTING_TEXT, COMMIT_CARRIER_PLAIN_TEXT, LISTING_VERSIONS, SEQUENCE_DISABLE_FLAG, WITHDRAW_FIRST_TEXT, commitCarrierProblem, listingSequenceOk, listingShapeProblems, relistDecision } from "../src/lib/listingRules.js";
import { LISTING_SIGHASH, buildListingPsbt, parseListing, verifyListing } from "../src/lib/swap.js";
import { RAISE_PRICE_TEXT, listingRefusalText } from "../src/lib/market.js";
import { orderHttpError } from "../src/lib/indexer.js";
import { carrierRowOf, sellerCarrierCheck } from "../src/lib/buyChecks.js";
import { MOCK_WALLET, mockCheckSecondSource, mockGet, mockPostJson } from "../src/lib/mock.js";
import { decodeAddress, xOnlyFromCompressedHex } from "../src/lib/psbt.js";

const TX = (c) => c.repeat(64);
const ADDR = MOCK_WALLET.address;
const utxo = { txid: TX("d"), vout: 0, sats: 546 };

/** A 1-in / 1-out listing like buildListingPsbt's, with an explicit version / sequence. */
function listingWith({ version = 2, sequence = 0xffffffff, lockTime = 0 } = {}) {
  const { script } = decodeAddress(ADDR);
  const tx = new btc.Transaction({ version, lockTime, allowUnknownOutputs: false });
  tx.addInput({ txid: utxo.txid, index: 0, sequence, witnessUtxo: { script, amount: 546n }, sighashType: LISTING_SIGHASH, tapInternalKey: xOnlyFromCompressedHex(MOCK_WALLET.pubkeyHex) });
  tx.addOutput({ script, amount: 60_000n });
  return hex.encode(tx.toPSBT());
}

// ---- a listing no fill could relay ---------------------------------------------------------------------
{
  assert.deepEqual(LISTING_VERSIONS, [1, 2]);
  assert.equal(SEQUENCE_DISABLE_FLAG, 0x80000000);
  for (const s of [0x80000000, 0xfffffffd, 0xfffffffe, 0xffffffff]) assert.equal(listingSequenceOk(s), true, s.toString(16));
  for (const s of [0, 1, 0x7fffffff, 0x0040ffff, -1, 2 ** 32, null]) assert.equal(listingSequenceOk(s), false, String(s));

  const ours = buildListingPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: utxo, priceSats: 60_000, amount: 100 });
  assert.deepEqual(listingShapeProblems(ours.psbtHex), [], "the app's own listing passes (version 2, sequence 0xffffffff, lock time 0)");
  const L = parseListing(ours.psbtHex);
  assert.deepEqual([L.version, L.input0.sequence, L.lockTime], [2, 0xffffffff, 0]);
  assert.deepEqual(listingShapeProblems(listingWith({ version: 1, sequence: 0xfffffffd })), [], "version 1 + an RBF sequence is fine");
  const badVersion = listingShapeProblems(listingWith({ version: 3 }));
  assert.equal(badVersion.length, 1);
  assert.match(badVersion[0], /version is 3; only version 1 or 2/);
  const rel = listingShapeProblems(listingWith({ sequence: 10 }));
  assert.match(rel[0], /input 0 has sequence 0x0000000A, which sets a relative time lock; it must be 0x80000000 or higher/);
  assert.match(listingShapeProblems(listingWith({ lockTime: 5 }))[0], /lock time is 5/);
  assert.match(listingShapeProblems("zz")[0], /does not decode/);

  // the buyer's check 1 refuses the same listings (the 0x83 signature commits to both)
  const order = { id: `${utxo.txid}:0`, ticker: "LUCKY", amount: 100, price_sats: 60_000, seller: ADDR, carrier_sats: 546 };
  const shape = (psbt) => verifyListing({ psbtHex: psbt, order }).checks.find((c) => c.id === "shape");
  assert.equal(shape(ours.psbtHex).ok, true);
  assert.equal(shape(listingWith({ version: 3 })).ok, false);
  assert.match(shape(listingWith({ sequence: 10 })).detail, /no fill of it could be relayed/);
  console.log("listing rules: version 1/2 + sequence ≥ 0x80000000 + lock time 0, on the seller's and the buyer's side");
}

// ---- raising the price needs Withdraw first ------------------------------------------------------------
{
  const open = { id: "x:0", status: "open", amount: 100, price_sats: 5_000, unit_price: 50 };
  assert.deepEqual(relistDecision(null, 6_000, 100), { ok: true, kind: "new" });
  assert.deepEqual(relistDecision({ ...open, status: "filled" }, 6_000, 100), { ok: true, kind: "new" }, "a closed order is no listing");
  assert.deepEqual(relistDecision(open, 5_000, 100), { ok: true, kind: "same" });
  assert.deepEqual(relistDecision(open, 4_999, 100), { ok: true, kind: "lower" });
  const up = relistDecision(open, 5_001, 100);
  assert.deepEqual([up.ok, up.kind], [false, "raise"], "one sat more is a raise");
  assert.equal(relistDecision({ ...open, status: "filling" }, 1, 100).kind, "filling");
  assert.match(RAISE_PRICE_TEXT, /withdraw this listing first/i);
  assert.match(RAISE_PRICE_TEXT, /anyone who saved it can still complete it on-chain at that price/);
  // the book's own words map to the same plain text
  const e409 = orderHttpError("/orders", 409, JSON.stringify({ error: "withdraw first: the cheaper signed listing stays fillable on-chain" }));
  assert.equal(listingRefusalText(e409), RAISE_PRICE_TEXT);
  const eVer = orderHttpError("/orders", 400, JSON.stringify({ error: "listing nVersion must be 1 or 2 (got 3)" }));
  assert.match(listingRefusalText(eVer), /no buyer could ever complete it \(listing nVersion must be 1 or 2 \(got 3\)\)/);
  const eSeq = orderHttpError("/orders", 400, JSON.stringify({ error: "listing input 0 nSequence 0x0000000a enables a relative lock-time" }));
  assert.match(listingRefusalText(eSeq), /no buyer could ever complete it/);
  // the order book's EXACT texts (spec §7.4) map to the "no fill could relay" explanation.
  const liveVer = "listing tx version must be 1 or 2 (got 3): a listing with any other version can never be filled";
  const liveSeq = "input0 nSequence 0x0000000a sets a relative timelock: use 0xfffffffd, 0xfffffffe or 0xffffffff (any value >= 0x80000000) so the listing can be filled";
  for (const text of [liveVer, liveSeq]) {
    const out = listingRefusalText(orderHttpError("/orders", 400, JSON.stringify({ error: text })));
    assert.match(out, /^The order book refused this listing because no buyer could ever complete it/, text);
    assert.ok(out.includes(text.replace(/\.$/, "")), "the book's own words are kept");
  }
  assert.equal(WITHDRAW_FIRST_TEXT, "withdraw first: the cheaper signed listing stays fillable on-chain");
  console.log("listing rules: same / lower replaces, higher → Withdraw first (plain words, and the book's 409 maps to them)");
}

// ---- the first output of an open reservation is never listed ------------------------------------------------
{
  const open = { txid: TX("c"), status: "open", height: 969_400, expires_at_height: 971_416 };
  assert.equal(commitCarrierProblem(0, open), COMMIT_CARRIER_PLAIN_TEXT);
  assert.match(COMMIT_CARRIER_PLAIN_TEXT, /publish that reserved ticker with you named as its creator/);
  assert.equal(commitCarrierProblem(1, open), null, "only vout 0 is the reserved output");
  assert.equal(commitCarrierProblem(0, null), null, "not a recorded reservation (a MINE carrier, a SEND output…)");
  for (const status of ["revealed", "expired", "invalid"]) assert.equal(commitCarrierProblem(0, { ...open, status }), null, status);
  assert.equal(commitCarrierProblem(0, open, 971_416), null, "its window has passed at the tip");
  assert.equal(commitCarrierProblem(0, open, 971_415), COMMIT_CARRIER_PLAIN_TEXT);
  // the book's exact refusal maps to the same plain words
  const e = orderHttpError("/orders", 409, JSON.stringify({ error: COMMIT_CARRIER_LISTING_TEXT }));
  assert.equal(listingRefusalText(e), COMMIT_CARRIER_PLAIN_TEXT);
  console.log("listing rules: the first output of an open reservation (COMMIT) is refused, in plain words; the book's 409 maps to them");
}

// ---- the indexer's own carrier amount must be > 0 -------------------------------------------------------
{
  const order = { id: `${TX("a")}:1`, ticker: "LUCKY", amount: 300 };
  const row = (balances) => ({ txid: TX("a"), vout: 1, balances });
  assert.equal(carrierRowOf([row({ LUCKY: 300 }), { txid: TX("b"), vout: 1, balances: {} }], order.id).txid, TX("a"));
  assert.equal(carrierRowOf([{ txid: TX("a"), vout: 0, balances: {} }], order.id), null, "same txid, other vout");
  assert.equal(sellerCarrierCheck(row({ LUCKY: 300 }), order).ok, true);
  assert.match(sellerCarrierCheck(row({ LUCKY: 300 }), order).detail, /seller holds 300 LUCKY on aaaaaaaa…:1/);
  assert.match(sellerCarrierCheck(row({ LUCKY: 0 }), order).detail, /carries 0 LUCKY — a zero-token carrier is never buyable/);
  assert.match(sellerCarrierCheck(row({}), order).detail, /no tokens .* zero-token carrier/);
  assert.match(sellerCarrierCheck(row({ LUCKY: 300 }), { ...order, amount: 0 }).detail, /listing is for 0 LUCKY/);
  assert.match(sellerCarrierCheck(null, order).detail, /no longer holds/);
  assert.equal(sellerCarrierCheck(row({ LUCKY: 299 }), order).ok, false);
  assert.equal(sellerCarrierCheck(row({ LUCKY: 300, ORE: 1 }), order).ok, false, "whole-UTXO, single ticker");
  console.log("buy checks: the indexer's carrier row must hold exactly { TICKER: amount }, amount > 0");
}

// ---- the mock order book applies the same rules (what the preview walks) -----------------------------------------------
{
  const open = await mockGet("/orders?ticker=BLOK&status=open&limit=200");
  // a seeded seller whose key the mock derives from a public seed — re-derived here to sign a re-listing
  let seller = null;
  let row = null;
  for (let j = 0; j < 8 && !seller; j++) {
    const priv = sha256(new TextEncoder().encode(`luckyprotocol-mock-key:seller:BLOK:${j} (public seed, never fund)`));
    const address = btc.p2tr(pubSchnorr(priv), undefined, btc.NETWORK).address;
    const o = open.items.find((x) => x.seller === address);
    if (o) {
      seller = { priv, address, pubkeyHex: hex.encode(pubECDSA(priv, true)) };
      row = o;
    }
  }
  assert.ok(seller, "a seeded P2TR BLOK seller with an open ask");
  const [txid, vout] = row.id.split(":");
  const sign = (priceSats) => {
    const b = buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo: { txid, vout: Number(vout), sats: row.carrier_sats }, priceSats, amount: row.amount });
    const t = btc.Transaction.fromPSBT(hex.decode(b.psbtHex));
    t.signIdx(seller.priv, 0, [LISTING_SIGHASH]);
    return hex.encode(t.toPSBT());
  };
  await assert.rejects(mockPostJson("/orders", { psbt: sign(row.price_sats + 1), ticker: "BLOK", amount: row.amount, price_sats: row.price_sats + 1 }), (e) => e.status === 409 && e.message === WITHDRAW_FIRST_TEXT, "higher → 409 withdraw first (the book's exact text)");
  // the shape rules in the mock: the indexer's exact 400 texts — checked before the signature.
  const unsignedWith = ({ version = 2, sequence = 0xffffffff }) => {
    const { script } = decodeAddress(seller.address);
    const tx = new btc.Transaction({ version, lockTime: 0 });
    tx.addInput({ txid, index: Number(vout), sequence, witnessUtxo: { script, amount: BigInt(row.carrier_sats) }, sighashType: LISTING_SIGHASH });
    tx.addOutput({ script, amount: BigInt(row.price_sats) });
    return hex.encode(tx.toPSBT());
  };
  const post = (psbt) => mockPostJson("/orders", { psbt, ticker: "BLOK", amount: row.amount, price_sats: row.price_sats });
  await assert.rejects(post(unsignedWith({ version: 3 })), (e) => e.status === 400 && e.message === "listing tx version must be 1 or 2 (got 3): a listing with any other version can never be filled");
  await assert.rejects(
    post(unsignedWith({ sequence: 10 })),
    (e) => e.status === 400 && e.message === "input0 nSequence 0x0000000a sets a relative timelock: use 0xfffffffd, 0xfffffffe or 0xffffffff (any value >= 0x80000000) so the listing can be filled",
  );
  const lower = await mockPostJson("/orders", { psbt: sign(row.price_sats - 1), ticker: "BLOK", amount: row.amount, price_sats: row.price_sats - 1 });
  assert.equal(lower.replaced, true, "lower → replaces");
  assert.equal(lower.price_sats, row.price_sats - 1);
  const same = await mockPostJson("/orders", { psbt: sign(row.price_sats - 1), ticker: "BLOK", amount: row.amount, price_sats: row.price_sats - 1 });
  assert.equal(same.replaced, true, "same price (Renew) → replaces");

  // the partial-credit ask the preview's buy walk uses: a MINE carrier in the block that completed BLOK
  const cap = open.items.find((o) => o.amount === 300 && o.id.endsWith(":0") && o.seller !== MOCK_WALLET.address);
  assert.ok(cap, "a seeded 300-BLOK ask exists");
  const blok = await mockGet("/tokens/BLOK");
  const scriptOf = (a) => hex.encode(decodeAddress(a).script);
  const check = (o) => {
    const [t, v] = o.id.split(":");
    return mockCheckSecondSource({ txid: t, vout: Number(v), carrierSats: o.carrier_sats, scriptHex: scriptOf(o.seller), ticker: o.ticker, amount: o.amount, capHeight: blok.minted_out_height });
  };
  const partial = await check(cap);
  assert.equal(partial.verdict, "unverified", "the same comparison as mempool.space: amount not independently verified");
  assert.match(partial.notes[0], /completed the BLOK supply is credited only what was left/);
  const normal = await check(open.items.find((o) => o.id !== cap.id && o.seller !== MOCK_WALLET.address));
  assert.equal(normal.verdict, "agree", "an ordinary split carrier (SEND TO_OUT) is verified");
  const lying = await check({ ...cap, amount: 1100 });
  assert.equal(lying.verdict, "disagree");
  console.log("mock order book: higher re-listing → 409 withdraw first; same / lower replace; the seeded partial-credit ask is unverified, a split carrier agrees");
}

console.log("listing rules: all checks passed");
