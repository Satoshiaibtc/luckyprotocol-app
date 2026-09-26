// End-to-end structural test for src/lib/swap.js (PROTOCOL-v3.md §7).
// Plain Node, no framework. Two deterministic key pairs play seller and
// buyer in both address-type combinations (P2TR seller / P2WPKH buyer and
// the reverse):
//   * buildListingPsbt → seller signs input0 with SINGLE|ANYONECANPAY (0x83)
//   * verifyListing passes, and fails with the right check id when the
//     listing is tampered (output value / sighashType dropped / 2nd output)
//   * buildFillPsbt appends only §4-clean buyer inputs + the §7.2 outputs
//   * buyer signs inputs 1..n, finalizeFill finalizes input0 from the
//     seller's signature and extracts a raw tx
//   * output0 is byte-identical to the listing, OP_RETURN payload is
//     LUCKY-20|SEND|<T>|<AMT>|1|4, vout1 (token slot) and vout4 (residual
//     slot) are ALWAYS 546-sat outputs, vout5 BTC change is optional and
//     folds into the fee when sub-dust (H-1(A)), inputs − outputs == feeSats
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import {
  buildListingPsbt,
  verifyListing,
  buildFillPsbt,
  finalizeFill,
  decodeRawTx,
  estimateFillCost,
  checkFillLayout,
  LISTING_SIGHASH,
  FILL_TO_OUT,
  FILL_CHANGE_OUT,
  FILL_BTC_CHANGE_VOUT,
  FILL_SLOT_SATS,
} from "../src/lib/swap.js";
import { PROJECT_FEE_ADDRESS, buildAvatarPayload, buildSendPayload, payloadToString } from "../src/lib/payloads.js";
import { assertSingleOpReturn, decodeOpReturnPush, expectPsbtPayload, makeOpReturnScript } from "../src/lib/psbt.js";
import { mockSignPsbt, MOCK_WALLET } from "../src/lib/mock.js";

const enc = (s) => new TextEncoder().encode(s);
function keyFor(seed, type) {
  const priv = sha256(enc(`swap-test:${seed}`));
  const pub = pubECDSA(priv, true);
  if (type === "wpkh") {
    const p = btc.p2wpkh(pub, btc.NETWORK);
    return { priv, pubkeyHex: hex.encode(pub), address: p.address, script: p.script, type };
  }
  const p = btc.p2tr(pubSchnorr(priv), undefined, btc.NETWORK);
  return { priv, pubkeyHex: hex.encode(pub), address: p.address, script: p.script, type: "tr" };
}

const T = (i) => "cd".repeat(31) + String(i).padStart(2, "0");
const addrOf = (script) => {
  try { return btc.Address(btc.NETWORK).encode(btc.OutScript.decode(script)); } catch { return null; }
};
const parse = (psbtHex) => btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });

assert.equal(LISTING_SIGHASH, btc.SigHash.SINGLE_ANYONECANPAY, "0x83 == SigHash.SINGLE_ANYONECANPAY");
assert.equal(FILL_TO_OUT, 1);
assert.equal(FILL_CHANGE_OUT, 4);
assert.equal(FILL_BTC_CHANGE_VOUT, 5);
assert.equal(FILL_SLOT_SATS, 546 * 3, "token slot + protocol fee + residual slot");

/** Assert the H-1(A) fill layout on a PSBT / tx: 5 outputs (change folded) or 6. */
function checkFillOutputs(label, tx, fill, { seller, buyer, price, payload }) {
  const o = (i) => tx.getOutput(i);
  assert.ok(tx.outputsLength === 5 || tx.outputsLength === 6, `${label}: 5 or 6 outputs, got ${tx.outputsLength}`);
  assert.equal(addrOf(o(0).script), seller, `${label}: vout0 → seller`);
  assert.equal(o(0).amount, BigInt(price), `${label}: vout0 untouched`);
  assert.equal(addrOf(o(1).script), buyer, `${label}: vout1 → buyer`);
  assert.equal(o(1).amount, 546n, `${label}: vout1 token slot is exactly 546`);
  assert.equal(addrOf(o(2).script), PROJECT_FEE_ADDRESS, `${label}: vout2 → fee`);
  assert.equal(o(2).amount, 546n, `${label}: vout2 exact protocol fee`);
  assert.equal(o(3).script[0], 0x6a, `${label}: vout3 OP_RETURN`);
  assert.equal(payloadToString(o(3).script.slice(2)), payload, `${label}: payload unchanged (|1|4)`);
  assert.equal(addrOf(o(4).script), buyer, `${label}: vout4 residual slot → buyer`);
  assert.equal(o(4).amount, 546n, `${label}: vout4 residual slot is exactly 546 (always present)`);
  assert.equal(fill.residualVout, 4);
  if (tx.outputsLength === 6) {
    assert.equal(fill.changeOmitted, false, `${label}: changeOmitted false with 6 outputs`);
    assert.equal(fill.changeVout, 5);
    assert.equal(addrOf(o(5).script), buyer, `${label}: vout5 BTC change → buyer`);
    assert.equal(o(5).amount, BigInt(fill.changeSats), `${label}: vout5 == changeSats`);
    assert.ok(o(5).amount >= 546n, `${label}: vout5 ≥ dust`);
  } else {
    assert.equal(fill.changeOmitted, true, `${label}: changeOmitted true with 5 outputs`);
    assert.equal(fill.changeVout, null);
    assert.equal(fill.changeSats, 0);
  }
  assert.deepEqual(checkFillLayout(tx), { outputCount: tx.outputsLength, hasChange: tx.outputsLength === 6 });
  let inSum = 0n;
  for (let i = 0; i < tx.inputsLength; i++) inSum += tx.getInput(i).witnessUtxo.amount;
  let outSum = 0n;
  for (let i = 0; i < tx.outputsLength; i++) outSum += o(i).amount;
  assert.equal(inSum - outSum, BigInt(fill.feeSats), `${label}: fee == inputs − outputs`);
}

function runScenario(label, sellerType, buyerType) {
  const seller = keyFor(`seller-${label}`, sellerType);
  const buyer = keyFor(`buyer-${label}`, buyerType);
  const tokenUtxo = { txid: T(1), vout: 0, sats: 546 };
  const order = {
    id: `${T(1)}:0`,
    ticker: "LUCKY",
    amount: 1200,
    price_sats: 60_000,
    unit_price: 50,
    seller: seller.address,
    carrier_sats: 546,
    status: "open",
  };

  // ---- seller: listing ---------------------------------------------------------------
  assert.throws(() => buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo, priceSats: 545 }), /≥ 546/, `${label}: refuses price < 546`);
  const listing = buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo, priceSats: 60_000, amount: 1200 });
  assert.deepEqual(listing.inputIndexes, [0]);
  assert.equal(listing.unitPrice, 50);
  {
    const tx = parse(listing.psbtHex);
    assert.equal(tx.inputsLength, 1);
    assert.equal(tx.outputsLength, 1);
    assert.equal(tx.lockTime, 0);
    const in0 = tx.getInput(0);
    assert.equal(in0.sighashType, 0x83, `${label}: sighashType field = 0x83`);
    assert.equal(in0.witnessUtxo.amount, 546n);
    if (sellerType === "tr") assert.ok(in0.tapInternalKey, "P2TR input carries tapInternalKey");
    else assert.equal(in0.tapInternalKey, undefined);
    assert.equal(addrOf(tx.getOutput(0).script), seller.address);
    assert.equal(tx.getOutput(0).amount, 60_000n);
    // Unsigned listing must NOT verify (check 2)
    const v0 = verifyListing({ psbtHex: listing.psbtHex, order });
    assert.equal(v0.ok, false);
    assert.equal(v0.checks.find((c) => c.id === "signature").ok, false, `${label}: unsigned fails signature check`);
  }
  const signedListing = (() => {
    const tx = parse(listing.psbtHex);
    tx.signIdx(seller.priv, 0, [btc.SigHash.SINGLE_ANYONECANPAY]);
    assert.equal(tx.inputStatus(0), "signed");
    return hex.encode(tx.toPSBT());
  })();

  // ---- buyer: verification -----------------------------------------------------------
  const v = verifyListing({ psbtHex: signedListing, order });
  assert.equal(v.ok, true, `${label}: signed listing verifies: ${JSON.stringify(v.checks)}`);
  assert.deepEqual(v.checks.map((c) => c.id), ["shape", "signature", "output", "carrier"]);
  assert.ok(v.checks.every((c) => c.ok));

  // tamper: output value
  {
    const tx = parse(signedListing);
    tx.updateOutput(0, { amount: 1_000n }, true);
    const r = verifyListing({ psbtHex: hex.encode(tx.toPSBT()), order });
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c) => c.id === "output").ok, false, `${label}: tampered value fails 'output'`);
    assert.equal(r.checks.find((c) => c.id === "signature").ok, true);
  }
  // tamper: drop sighashType
  {
    const tx = parse(signedListing);
    tx.updateInput(0, { sighashType: undefined }, true);
    const r = verifyListing({ psbtHex: hex.encode(tx.toPSBT()), order });
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c) => c.id === "signature").ok, false, `${label}: missing sighashType fails 'signature'`);
  }
  // tamper: second output
  {
    const tx = parse(signedListing);
    tx.addOutput({ script: buyer.script, amount: 1_000n }, true);
    const r = verifyListing({ psbtHex: hex.encode(tx.toPSBT()), order });
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c) => c.id === "shape").ok, false, `${label}: extra output fails 'shape'`);
  }
  // wrong order (price mismatch) → output check
  {
    const r = verifyListing({ psbtHex: signedListing, order: { ...order, price_sats: 59_999 } });
    assert.equal(r.checks.find((c) => c.id === "output").ok, false);
  }
  // wrong carrier_sats → carrier check
  {
    const r = verifyListing({ psbtHex: signedListing, order: { ...order, carrier_sats: 600 } });
    assert.equal(r.checks.find((c) => c.id === "carrier").ok, false);
  }
  // wrong outpoint → shape
  {
    const r = verifyListing({ psbtHex: signedListing, order: { ...order, id: `${T(9)}:0` } });
    assert.equal(r.checks.find((c) => c.id === "shape").ok, false);
  }
  // H-3: a carrier worth more than the price hands its surplus to the buyer.
  {
    const fat = { txid: T(6), vout: 3, sats: 12_345 };
    assert.throws(
      () => buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo: fat, priceSats: 2_000, amount: 700 }),
      /below the UTXO's own BTC value/,
      `${label}: seller side refuses price < carrier sats`,
    );
    // price == carrier is the floor and builds
    const atFloor = buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo: fat, priceSats: 12_345, amount: 700 });
    assert.equal(parse(atFloor.psbtHex).getOutput(0).amount, 12_345n);
    // buyer side: a listing built under the old rule (output0 < witnessUtxo) fails check 4, even when the order agrees with it
    const tx = new btc.Transaction({ lockTime: 0 });
    const input = { txid: T(6), index: 3, witnessUtxo: { script: seller.script, amount: 12_345n }, sighashType: 0x83 };
    if (sellerType === "tr") input.tapInternalKey = pubSchnorr(seller.priv);
    tx.addInput(input);
    tx.addOutput({ script: seller.script, amount: 2_000n });
    tx.signIdx(seller.priv, 0, [btc.SigHash.SINGLE_ANYONECANPAY]);
    const under = hex.encode(tx.toPSBT());
    const fatOrder = { ...order, id: `${T(6)}:3`, amount: 700, price_sats: 2_000, carrier_sats: 12_345 };
    const r = verifyListing({ psbtHex: under, order: fatOrder });
    assert.equal(r.ok, false, `${label}: under-priced fat carrier is refused`);
    assert.equal(r.checks.find((c) => c.id === "output").ok, false);
    assert.match(r.checks.find((c) => c.id === "output").detail, /price must be ≥ carrier value/);
    assert.equal(r.checks.find((c) => c.id === "carrier").ok, true, "carrier check itself still agrees with the indexer");
    assert.throws(
      () => buildFillPsbt({ listingPsbtHex: under, order: fatOrder, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: [{ txid: T(8), vout: 0, sats: 5_000_000 }], tokenOutpoints: [], feeRateSatVb: 8 }),
      /failed verification/,
      `${label}: fill refuses the under-priced listing`,
    );
    // …and the same carrier priced at its value verifies (missing witnessUtxo fails closed)
    tx.updateOutput(0, { amount: 12_345n }, true);
    tx.updateInput(0, { tapKeySig: undefined, partialSig: undefined }, true);
    tx.signIdx(seller.priv, 0, [btc.SigHash.SINGLE_ANYONECANPAY]);
    const ok = verifyListing({ psbtHex: hex.encode(tx.toPSBT()), order: { ...fatOrder, price_sats: 12_345 } });
    assert.equal(ok.ok, true, `${label}: fat carrier priced at its value verifies: ${JSON.stringify(ok.checks)}`);
  }
  // DEFAULT-signed listing (no 0x83) → signature
  {
    const tx = new btc.Transaction({ lockTime: 0 });
    const input = { txid: T(1), index: 0, witnessUtxo: { script: seller.script, amount: 546n } };
    if (sellerType === "tr") input.tapInternalKey = pubSchnorr(seller.priv);
    tx.addInput(input);
    tx.addOutput({ script: seller.script, amount: 60_000n });
    tx.signIdx(seller.priv, 0);
    const r = verifyListing({ psbtHex: hex.encode(tx.toPSBT()), order });
    assert.equal(r.checks.find((c) => c.id === "signature").ok, false, `${label}: DEFAULT sighash fails 'signature'`);
  }

  // ---- buyer: fill -------------------------------------------------------------------
  const utxos = [
    { txid: T(2), vout: 0, sats: 546 },       // dust → excluded
    { txid: T(3), vout: 1, sats: 40_000 },    // token-bearing per indexer → excluded
    { txid: T(4), vout: 0, sats: 30_000 },
    { txid: T(5), vout: 2, sats: 90_000 },
  ];
  const tokenOutpoints = [{ txid: T(3), vout: 1 }];
  const est = estimateFillCost({ order, address: buyer.address, feeRateSatVb: 8 });
  assert.ok(est.feeSats > 500 && est.feeSats < 4_000, `${label}: fee preview plausible ${est.feeSats}`);
  assert.equal(est.slotSats, 3 * 546);
  assert.equal(est.totalSats, 60_000 + 3 * 546 + est.feeSats, "price + token slot + fee + residual slot + network fee");
  assert.ok(est.feeSats >= est.vsize * 8, `${label}: preview fee covers ceil(vsize) × rate`);

  // Decimal rates: integer satoshis, and the fee is never below
  // ceil(vsize) × rate — the node charges for whole vbytes.
  for (const feeRateSatVb of [1, 1.01, 1.25, 2.5, 3, 10]) {
    const fractional = buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb });
    assert.equal(fractional.feeRateSatVb, feeRateSatVb);
    assert.ok(Number.isInteger(fractional.feeSats));
    assert.ok(Number.isInteger(fractional.estimatedVsize));
    assert.ok(fractional.feeSats >= Math.ceil(fractional.estimatedVsize) * feeRateSatVb - 1e-9, `${label} @ ${feeRateSatVb}: fee ${fractional.feeSats} ≥ ${fractional.estimatedVsize} vB × ${feeRateSatVb}`);
    const decoded = parse(fractional.psbtHex);
    let total = 0n;
    for (let i = 0; i < decoded.inputsLength; i++) total += decoded.getInput(i).witnessUtxo.amount;
    for (let i = 0; i < decoded.outputsLength; i++) total -= decoded.getOutput(i).amount;
    assert.equal(total, BigInt(fractional.feeSats));
  }

  const fill = buildFillPsbt({
    listingPsbtHex: signedListing,
    order,
    address: buyer.address,
    pubkeyHex: buyer.pubkeyHex,
    utxos,
    tokenOutpoints,
    feeRateSatVb: 8,
  });
  assert.equal(fill.priceSats, 60_000);
  assert.equal(fill.slotSats, 3 * 546);
  assert.equal(fill.totalSats, 60_000 + 3 * 546 + fill.feeSats);
  assert.ok(fill.inputIndexes.length >= 1 && fill.inputIndexes[0] === 1, `${label}: buyer inputs start at 1`);
  {
    const tx = parse(fill.psbtHex);
    assert.equal(tx.inputStatus(0), "signed", "seller sig preserved on input0");
    // Seller's input untouched
    const in0 = tx.getInput(0);
    assert.equal(hex.encode(in0.txid), T(1));
    assert.equal(in0.sighashType, 0x83);
    // Buyer inputs are §4-clean
    for (let i = 1; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      assert.ok(inp.witnessUtxo.amount > 546n, "no dust buyer input");
      assert.notEqual(hex.encode(inp.txid), T(3), "no token-bearing buyer input");
      assert.equal(addrOf(inp.witnessUtxo.script), buyer.address);
      if (buyerType === "tr") assert.ok(inp.tapInternalKey, "P2TR buyer input carries tapInternalKey");
      else assert.equal(inp.tapInternalKey, undefined);
    }
    assert.equal(tx.inputsLength, 1 + fill.inputIndexes.length);
    // §7.2 layout (H-1(A)): 6 outputs here — the 30,000 / 90,000-sat inputs leave real change
    checkFillOutputs(label, tx, fill, { seller: seller.address, buyer: buyer.address, price: 60_000, payload: "LUCKY-20|SEND|LUCKY|1200|1|4" });
    assert.equal(tx.outputsLength, 6, "vout5 BTC change present when ≥ dust");
    assert.ok(payloadToString(tx.getOutput(3).script.slice(2)).endsWith("|1|4"), "TO_OUT=1, CHANGE_OUT=4 (distinct — equal indices do not parse)");
  }

  // finalizeFill must refuse an unsigned buyer input
  assert.throws(() => finalizeFill(fill.psbtHex), /unsigned|not sign/i, `${label}: unsigned buyer inputs rejected`);

  // buyer signs 1..n (what UniSat does with autoFinalized:true), then finalizeFill
  const signedFill = (() => {
    const tx = parse(fill.psbtHex);
    for (const i of fill.inputIndexes) {
      tx.signIdx(buyer.priv, i);
      tx.finalizeIdx(i);
    }
    assert.equal(tx.inputStatus(0), "signed", "input0 still only signed");
    return hex.encode(tx.toPSBT());
  })();
  const rawHex = finalizeFill(signedFill);
  assert.match(rawHex, /^[0-9a-f]+$/);
  const d = decodeRawTx(rawHex);
  assert.equal(d.inputs[0].txid, T(1));
  assert.equal(d.inputs[0].vout, 0);
  assert.equal(d.outputs[0].address, seller.address);
  assert.equal(d.outputs[0].sats, 60_000);
  assert.equal(d.outputs[1].address, buyer.address);
  assert.equal(d.outputs[3].address, null);
  assert.deepEqual(d.payload, { op: "SEND", ticker: "LUCKY", amount: 1200, toOutIdx: 1, changeOutIdx: 4 });
  assert.equal(d.payloadText, "LUCKY-20|SEND|LUCKY|1200|1|4");
  assert.equal(d.outputs[1].sats, 546, "raw tx vout1 token slot = 546");
  assert.equal(d.outputs[4].address, buyer.address, "raw tx vout4 residual slot → buyer");
  assert.equal(d.outputs[4].sats, 546, "raw tx vout4 residual slot = 546");
  assert.equal(d.outputs[5].address, buyer.address, "raw tx vout5 BTC change → buyer");
  assert.ok(d.outputs[5].sats >= 546, "raw tx vout5 ≥ dust");
  const fin = parse(signedFill);
  fin.finalizeIdx(0);
  assert.equal(d.txid, fin.id, `${label}: decodeRawTx txid == finalized tx id`);
  const inSum = d.inputs.length; // sanity: inputs count matches
  assert.equal(inSum, 1 + fill.inputIndexes.length);
  const outSum = d.outputs.reduce((s, o) => s + o.sats, 0);
  assert.equal(546 + utxosSelectedSum(fill, utxos) - outSum, fill.feeSats, `${label}: raw tx fee matches`);
  assert.equal(outSum, 60_000 + 3 * 546 + fill.changeSats, `${label}: outputs = price + 3 slots + change`);

  // finalizeFill is idempotent on an already-finalized input0
  assert.equal(finalizeFill(hex.encode(fin.toPSBT())), rawHex);

  // M-1: a fill whose OP_RETURN is not the SEND is never extracted, even
  // when every input is signed (the seller's bearer signature would
  // otherwise authorize e.g. an AVATAR for their token).
  {
    const avatar = makeOpReturnScript(buildAvatarPayload("LUCKY"));
    const tampered = parse(signedFill);
    tampered.updateOutput(3, { script: avatar }, true);
    assert.throws(() => finalizeFill(hex.encode(tampered.toPSBT())), /OP_RETURN is AVATAR, expected SEND/, `${label}: AVATAR riding on the listing is refused`);
    const wrongTicker = parse(signedFill);
    wrongTicker.updateOutput(3, { script: makeOpReturnScript(buildSendPayload({ ticker: "OTHER", amount: 1200, toOutIdx: 1, changeOutIdx: 4 })) }, true);
    assert.throws(() => finalizeFill(hex.encode(wrongTicker.toPSBT()), { op: "SEND", ticker: "LUCKY" }), /names ticker OTHER/, `${label}: wrong ticker refused`);
    const noPayload = parse(signedFill);
    noPayload.updateOutput(3, { script: new Uint8Array([0x6a, 0x04, 0x74, 0x65, 0x73, 0x74]) }, true);
    assert.throws(() => finalizeFill(hex.encode(noPayload.toPSBT())), /does not parse as a LUCKY-20 payload/, `${label}: non-protocol OP_RETURN refused`);
    // the sign-time guard sees the same PSBT the wallet would
    assert.deepEqual(expectPsbtPayload(fill.psbtHex, { op: "SEND", ticker: "LUCKY", amount: 1200 }), { op: "SEND", ticker: "LUCKY", amount: 1200, toOutIdx: 1, changeOutIdx: 4 });
    assert.throws(() => expectPsbtPayload(fill.psbtHex, { op: "SEND", amount: 1199 }), /moves 1200 tokens, expected 1199/);
    assert.throws(() => expectPsbtPayload(fill.psbtHex, { op: null }), /plain payment must not carry an OP_RETURN/);
  }

  // Buyer with only dust / token UTXOs cannot fill
  assert.throws(
    () => buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: utxos.slice(0, 2), tokenOutpoints, feeRateSatVb: 8 }),
    /no spendable BTC/,
  );
  // M-8: on a non-asset-safe list the fee-input floor applies to the buyer's inputs too
  {
    const floored = buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 8, minInputSats: 50_000 });
    assert.deepEqual(floored.inputs, [{ txid: T(5), vout: 2, sats: 90_000 }], `${label}: only the 90,000-sat output clears a 50,000-sat floor`);
    assert.throws(
      () => buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 8, minInputSats: 100_000 }),
      /no asset-safe UTXO list/,
    );
  }
  // Fee-rate safety cap applies to fills too
  assert.throws(
    () => buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 5_000 }),
    /safety cap/,
  );
  // Sub-dust BTC change folds into the fee; the 546-sat residual slot (vout4) stays
  {
    // Learn the single-buyer-input fee from a generous build, then fund the
    // buyer with exactly price + 3 slots + network fee − carrier + 100:
    // change would be 100 sats < 546 → folded, 5 outputs.
    const one = buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: [{ txid: T(8), vout: 0, sats: 5_000_000 }], tokenOutpoints: [], feeRateSatVb: 8 });
    assert.equal(one.inputIndexes.length, 1);
    const tight = [{ txid: T(8), vout: 0, sats: 60_000 + 3 * 546 - 546 + one.feeSats + 100 }];
    const folded = buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: tight, tokenOutpoints: [], feeRateSatVb: 8 });
    const ftx = parse(folded.psbtHex);
    checkFillOutputs(`${label} folded`, ftx, folded, { seller: seller.address, buyer: buyer.address, price: 60_000, payload: "LUCKY-20|SEND|LUCKY|1200|1|4" });
    assert.equal(ftx.outputsLength, 5, `${label}: sub-dust change folded — vout4 residual slot still present`);
    assert.equal(folded.changeOmitted, true);
    assert.equal(folded.totalSats, 60_000 + 3 * 546 + folded.feeSats);
    assert.ok(folded.feeSats >= one.feeSats && folded.feeSats <= one.feeSats + 200, `${label}: folded fee absorbs the remainder`);
    // …and with the dust headroom present it builds with vout5 == 546 + 100.
    const ok = buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: [{ txid: T(8), vout: 0, sats: tight[0].sats + 546 }], tokenOutpoints: [], feeRateSatVb: 8 });
    assert.equal(ok.changeSats, 646, `${label}: change accounted exactly`);
    assert.equal(ok.changeVout, 5);
    assert.equal(parse(ok.psbtHex).outputsLength, 6);
    // a buyer who cannot even cover the three slots is refused
    assert.throws(
      () => buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: [{ txid: T(8), vout: 0, sats: 60_000 }], tokenOutpoints: [], feeRateSatVb: 8 }),
      /insufficient funds/,
      `${label}: cannot fund the slots`,
    );
    // finalizeFill refuses a fill whose residual slot was tampered to a non-546 value
    {
      const bad = parse(signedFill);
      bad.updateOutput(4, { amount: 1_000n }, true);
      assert.throws(() => finalizeFill(hex.encode(bad.toPSBT())), /vout4 \(residual slot\) is 1000 sats/, `${label}: tampered residual slot refused`);
      const badSlot = parse(signedFill);
      badSlot.updateOutput(1, { amount: 600n }, true);
      assert.throws(() => finalizeFill(hex.encode(badSlot.toPSBT())), /vout1 \(token slot\) is 600 sats/, `${label}: tampered token slot refused`);
    }
  }
  // A tampered listing is refused before any input is added
  {
    const tx = parse(signedListing);
    tx.updateOutput(0, { amount: 1_000n }, true);
    assert.throws(
      () => buildFillPsbt({ listingPsbtHex: hex.encode(tx.toPSBT()), order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 8 }),
      /failed verification/,
    );
  }
  console.log(`swap ${label}: listing → verify → fill → finalize ok (${fill.inputIndexes.length} buyer input(s), fee ${fill.feeSats} sats)`);
}

function utxosSelectedSum(fill, utxos) {
  const tx = parse(fill.psbtHex);
  let s = 0;
  for (let i = 1; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const u = utxos.find((x) => x.txid === hex.encode(inp.txid) && x.vout === inp.index);
    s += u.sats;
  }
  return s;
}

runScenario("tr-seller/wpkh-buyer", "tr", "wpkh");
runScenario("wpkh-seller/tr-buyer", "wpkh", "tr");

// ---- mock wallet signer honors toSignInputs / sighashTypes / autoFinalized -------------------
{
  const tokenUtxo = { txid: T(7), vout: 0, sats: 546 };
  const listing = buildListingPsbt({ address: MOCK_WALLET.address, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo, priceSats: 10_000, amount: 100 });
  // Without sighashTypes the mock (like UniSat) refuses the non-default sighash.
  assert.throws(() => mockSignPsbt(listing.psbtHex, { autoFinalized: false, toSignInputs: [{ index: 0, address: MOCK_WALLET.address }] }), /not allowed sigHash/i);
  // Foreign address → refused.
  assert.throws(() => mockSignPsbt(listing.psbtHex, { autoFinalized: false, toSignInputs: [{ index: 0, address: "bc1qza32dpxm5kl8qp2yeu4x6fuw932xduh0w8yksg", sighashTypes: [0x83] }] }), /not the connected account/);
  const signed = mockSignPsbt(listing.psbtHex, { autoFinalized: false, toSignInputs: [{ index: 0, address: MOCK_WALLET.address, sighashTypes: [0x83] }] });
  const tx = parse(signed);
  assert.equal(tx.inputStatus(0), "signed", "mock listing signed but NOT finalized");
  const order = { id: `${T(7)}:0`, ticker: "ORE", amount: 100, price_sats: 10_000, seller: MOCK_WALLET.address, carrier_sats: 546 };
  assert.equal(verifyListing({ psbtHex: signed, order }).ok, true, "mock-signed listing verifies");
  console.log("swap mock signer: toSignInputs / sighashTypes / autoFinalized honored");
}

// ---- M-3: decodeRawTx follows the indexer's OP_RETURN rule ---------------------------------------
{
  const enc2 = (s) => new TextEncoder().encode(s);
  const opret = (bytes) => makeOpReturnScript(bytes);
  const p2 = (bytes) => new Uint8Array([0x6a, 0x4d, bytes.length & 0xff, bytes.length >> 8, ...bytes]); // PUSHDATA2
  const p4 = (bytes) => new Uint8Array([0x6a, 0x4e, bytes.length & 0xff, (bytes.length >> 8) & 0xff, 0, 0, ...bytes]); // PUSHDATA4
  const pay = btc.p2wpkh(hex.decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"), btc.NETWORK);
  const raw = (scripts) =>
    hex.encode(
      btc.RawTx.encode({
        version: 2,
        segwitFlag: false,
        lockTime: 0,
        inputs: [{ txid: hex.decode(T(1)), index: 0, finalScriptSig: new Uint8Array(), sequence: 0xffffffff }],
        outputs: scripts.map((script, i) => ({ amount: BigInt(546 + i), script })),
      }),
    );
  const send = enc2("LUCKY-20|SEND|LUCKY|100|0|3");
  const memo = enc2("hello");
  // single OP_RETURN, direct push
  {
    const d = decodeRawTx(raw([pay.script, opret(send)]));
    assert.equal(d.opReturnCount, 1);
    assert.equal(d.payloadVout, 1);
    assert.deepEqual(d.payload, { op: "SEND", ticker: "LUCKY", amount: 100, toOutIdx: 0, changeOutIdx: 3 });
    assert.equal(d.outputs[0].address, pay.address);
    assert.equal(d.outputs[1].address, null);
  }
  // payload first, memo second → payload found, count 2
  {
    const d = decodeRawTx(raw([opret(send), pay.script, opret(memo)]));
    assert.equal(d.opReturnCount, 2);
    assert.equal(d.payloadVout, 0);
    assert.equal(d.payload.op, "SEND");
  }
  // memo first, payload second → lowest-index PARSING OP_RETURN wins
  {
    const d = decodeRawTx(raw([opret(memo), pay.script, opret(send)]));
    assert.equal(d.opReturnCount, 2);
    assert.equal(d.payloadVout, 2);
    assert.equal(d.payload.op, "SEND");
  }
  // PUSHDATA2 / PUSHDATA4 encodings of the same push parse
  assert.equal(decodeRawTx(raw([p2(send)])).payload.op, "SEND", "PUSHDATA2 payload parses");
  assert.equal(decodeRawTx(raw([p4(send)])).payload.op, "SEND", "PUSHDATA4 payload parses");
  // OP_RETURN OP_NOP (6a61): an OP_RETURN output (no address, counted) but no payload
  {
    const d = decodeRawTx(raw([new Uint8Array([0x6a, 0x61]), pay.script]));
    assert.equal(d.opReturnCount, 1);
    assert.equal(d.payload, null);
    assert.equal(d.outputs[0].address, null, "0x6a outputs never get an address");
  }
  // trailing bytes after the push, or a push followed by a second push → not `OP_RETURN <one push>`
  assert.equal(decodeRawTx(raw([new Uint8Array([...opret(send), 0x61])])).payload, null, "trailing opcode → no payload");
  assert.equal(decodeRawTx(raw([new Uint8Array([...opret(send), 0x01, 0x00])])).payload, null, "second push → no payload");
  assert.equal(decodeRawTx(raw([new Uint8Array([0x6a])])).payload, null, "bare OP_RETURN → no payload");
  assert.equal(decodeRawTx(raw([new Uint8Array([0x6a, 0x4c])])).payload, null, "truncated PUSHDATA1 → no payload");
  // broadcast guard: two OP_RETURN outputs are refused before any relay sees them
  assert.equal(assertSingleOpReturn(raw([pay.script, opret(send)])), 1);
  assert.equal(assertSingleOpReturn(raw([pay.script])), 0, "a plain payment passes");
  assert.throws(() => assertSingleOpReturn(raw([opret(send), pay.script, opret(memo)])), /2 OP_RETURN outputs/);
  assert.throws(() => assertSingleOpReturn(raw([opret(memo), opret(send)])), /2 OP_RETURN outputs/);
  // decodeOpReturnPush vectors
  assert.equal(hex.encode(decodeOpReturnPush(opret(send))), hex.encode(send));
  assert.equal(hex.encode(decodeOpReturnPush(p2(send))), hex.encode(send));
  assert.equal(decodeOpReturnPush(new Uint8Array([0x6a, 0x00])), null, "OP_0 is not a data push");
  assert.equal(decodeOpReturnPush(new Uint8Array([0x6a, 0x51])), null, "OP_1 is not a data push");
  assert.equal(decodeOpReturnPush(pay.script), null, "not an OP_RETURN");
  console.log("swap decodeRawTx: lowest-index single-push OP_RETURN rule, PUSHDATA1/2/4, multi-OP_RETURN broadcast guard");
}

console.log("swap: all checks passed");
