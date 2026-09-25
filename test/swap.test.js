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
//     LUCKYPROTOCOL|SEND|<T>|<AMT>|1|4, vout4 change is mandatory (≥ 546,
//     never folded), inputs − outputs == feeSats
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
  LISTING_SIGHASH,
} from "../src/lib/swap.js";
import { PROJECT_FEE_ADDRESS, payloadToString } from "../src/lib/payloads.js";
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
  assert.equal(est.totalSats, 60_000 + 546 + 546 + est.feeSats);

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
  assert.equal(fill.totalSats, 60_000 + 546 + 546 + fill.feeSats);
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
    // §7.2 layout
    const o = (i) => tx.getOutput(i);
    assert.equal(addrOf(o(0).script), seller.address, "vout0 → seller");
    assert.equal(o(0).amount, 60_000n, "vout0 untouched");
    assert.equal(addrOf(o(1).script), buyer.address, "vout1 → buyer");
    assert.equal(o(1).amount, 546n);
    assert.equal(addrOf(o(2).script), PROJECT_FEE_ADDRESS, "vout2 → fee");
    assert.equal(o(2).amount, 546n);
    assert.equal(o(3).script[0], 0x6a, "vout3 OP_RETURN");
    const payloadStr = payloadToString(o(3).script.slice(2));
    assert.equal(payloadStr, "LUCKYPROTOCOL|SEND|LUCKY|1200|1|4");
    assert.ok(payloadStr.endsWith("|1|4"), "TO_OUT=1, CHANGE_OUT=4 (distinct — equal indices do not parse)");
    assert.equal(tx.outputsLength, 5, "vout4 change is mandatory");
    assert.equal(addrOf(o(4).script), buyer.address, "vout4 change → buyer");
    assert.equal(o(4).amount, BigInt(fill.changeSats));
    assert.ok(o(4).amount >= 546n, "vout4 ≥ dust");
    assert.equal(fill.changeOmitted, undefined, "a fill never folds change");
    let inSum = 0n;
    for (let i = 0; i < tx.inputsLength; i++) inSum += tx.getInput(i).witnessUtxo.amount;
    let outSum = 0n;
    for (let i = 0; i < tx.outputsLength; i++) outSum += tx.getOutput(i).amount;
    assert.equal(inSum - outSum, BigInt(fill.feeSats), `${label}: fee == inputs − outputs`);
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
  assert.equal(d.payloadText, "LUCKYPROTOCOL|SEND|LUCKY|1200|1|4");
  assert.equal(d.outputs[4].address, buyer.address, "raw tx vout4 → buyer");
  assert.ok(d.outputs[4].sats >= 546, "raw tx vout4 ≥ dust");
  const fin = parse(signedFill);
  fin.finalizeIdx(0);
  assert.equal(d.txid, fin.id, `${label}: decodeRawTx txid == finalized tx id`);
  const inSum = d.inputs.length; // sanity: inputs count matches
  assert.equal(inSum, 1 + fill.inputIndexes.length);
  const outSum = d.outputs.reduce((s, o) => s + o.sats, 0);
  assert.equal(546 + utxosSelectedSum(fill, utxos) - outSum, fill.feeSats, `${label}: raw tx fee matches`);

  // finalizeFill is idempotent on an already-finalized input0
  assert.equal(finalizeFill(hex.encode(fin.toPSBT())), rawHex);

  // Buyer with only dust / token UTXOs cannot fill
  assert.throws(
    () => buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: utxos.slice(0, 2), tokenOutpoints, feeRateSatVb: 8 }),
    /no spendable BTC/,
  );
  // Fee-rate safety cap applies to fills too
  assert.throws(
    () => buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 5_000 }),
    /safety cap/,
  );
  // Sub-dust change → the build must THROW (vout4 is committed by the payload; never fold)
  {
    // Learn the single-buyer-input fee from a generous build, then fund the
    // buyer with exactly price + slot + fee output + network fee − carrier + 100:
    // change would be 100 sats < 546 → refuse (never fold into the fee).
    const one = buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: [{ txid: T(8), vout: 0, sats: 5_000_000 }], tokenOutpoints: [], feeRateSatVb: 8 });
    assert.equal(one.inputIndexes.length, 1);
    const tight = [{ txid: T(8), vout: 0, sats: 60_000 + 546 + 546 - 546 + one.feeSats + 100 }];
    assert.throws(
      () => buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: tight, tokenOutpoints: [], feeRateSatVb: 8 }),
      /change output required|insufficient funds/,
      `${label}: sub-dust change refused`,
    );
    // …and with the dust headroom present it builds, with vout4 == 546 + 100.
    const ok = buildFillPsbt({ listingPsbtHex: signedListing, order, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: [{ txid: T(8), vout: 0, sats: tight[0].sats + 546 }], tokenOutpoints: [], feeRateSatVb: 8 });
    assert.equal(ok.changeSats, 646, `${label}: change accounted exactly`);
    assert.equal(parse(ok.psbtHex).outputsLength, 5);
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

console.log("swap: all checks passed");
