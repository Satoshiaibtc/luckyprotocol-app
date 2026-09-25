// Structural test for src/lib/psbt.js — runs in plain Node, no framework.
// Builds MINE + SEND PSBTs for a P2TR and a P2WPKH wallet, parses them back
// with btc-signer, and asserts the spec §2/§4/§6 layout rules:
//   * dust (≤546) and token-bearing outpoints are never selected as inputs
//   * vout0 546 → self/recipient, vout1 546 → PROJECT_FEE_ADDRESS, vout2 OP_RETURN
//   * MINE folds sub-dust change into the fee; SEND refuses to build without change
//   * P2TR inputs carry tapInternalKey; P2WPKH inputs do not
//   * inputs − outputs == reported fee
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
  buildMinePsbt,
  buildSendPsbt,
  estimateMineFeeSats,
  decodeAddress,
  extractRawTxHex,
} from "../src/lib/psbt.js";
import { PROJECT_FEE_ADDRESS, payloadToString } from "../src/lib/payloads.js";

// BIP340 test-vector pubkey (valid x-only) → P2TR address.
const XONLY = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const P2TR_PUB = `02${XONLY}`;
const p2trAddr = btc.p2tr(hex.decode(XONLY), undefined, btc.NETWORK).address;
// secp256k1 generator point → P2WPKH address.
const P2WPKH_PUB = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const p2wpkhAddr = btc.p2wpkh(hex.decode(P2WPKH_PUB), btc.NETWORK).address;

const T = (i) => "ab".repeat(31) + String(i).padStart(2, "0");
const utxos = [
  { txid: T(1), vout: 0, sats: 546 },      // token carrier (dust) → must be dropped
  { txid: T(2), vout: 1, sats: 3_000 },
  { txid: T(3), vout: 0, sats: 20_000 },   // token-bearing per indexer → must be dropped
  { txid: T(4), vout: 2, sats: 90_000 },
];
const tokenOutpoints = [{ txid: T(3), vout: 0 }];

const addrOf = (script) => {
  try { return btc.Address(btc.NETWORK).encode(btc.OutScript.decode(script)); } catch { return null; }
};

function parse(psbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex));
  const ins = [];
  for (let i = 0; i < tx.inputsLength; i++) ins.push(tx.getInput(i));
  const outs = [];
  for (let i = 0; i < tx.outputsLength; i++) outs.push(tx.getOutput(i));
  return { tx, ins, outs };
}

function checkCommon(label, r, { expectOutputs, expectTap, self, vout0 }) {
  const { ins, outs } = parse(r.psbtHex);
  assert.equal(outs.length, expectOutputs, `${label}: output count`);
  assert.equal(ins.length, r.inputIndexes.length, `${label}: inputIndexes length`);
  r.inputIndexes.forEach((idx, i) => assert.equal(idx, i, `${label}: inputIndexes sequential`));
  for (const inp of ins) {
    assert.ok(inp.witnessUtxo, `${label}: witnessUtxo present`);
    assert.ok(inp.witnessUtxo.amount > 546n, `${label}: dust input selected`);
    assert.notEqual(hex.encode(inp.txid), T(3), `${label}: token outpoint selected`);
    if (expectTap) {
      assert.equal(hex.encode(inp.tapInternalKey), XONLY, `${label}: tapInternalKey = x-only pubkey`);
    } else {
      assert.equal(inp.tapInternalKey, undefined, `${label}: no tapInternalKey on P2WPKH`);
    }
  }
  assert.equal(addrOf(outs[0].script), vout0, `${label}: vout0 address`);
  assert.equal(outs[0].amount, 546n, `${label}: vout0 amount`);
  assert.equal(addrOf(outs[1].script), PROJECT_FEE_ADDRESS, `${label}: vout1 fee address`);
  assert.equal(outs[1].amount, 546n, `${label}: vout1 fee amount`);
  assert.equal(outs[2].script[0], 0x6a, `${label}: vout2 OP_RETURN`);
  assert.equal(outs[2].amount, 0n, `${label}: OP_RETURN value 0`);
  if (expectOutputs === 4) {
    assert.equal(addrOf(outs[3].script), self, `${label}: change → self`);
    assert.equal(outs[3].amount, BigInt(r.changeSats), `${label}: change amount`);
    assert.ok(outs[3].amount >= 546n, `${label}: change ≥ dust`);
  }
  const inSum = ins.reduce((s, i) => s + i.witnessUtxo.amount, 0n);
  const outSum = outs.reduce((s, o) => s + o.amount, 0n);
  assert.equal(inSum - outSum, BigInt(r.feeSats), `${label}: fee == inputs − outputs`);
  return { ins, outs };
}

// ---- decodeAddress ---------------------------------------------------------------------
assert.equal(decodeAddress(p2trAddr).type, "tr");
assert.equal(decodeAddress(p2wpkhAddr).type, "wpkh");
assert.throws(() => decodeAddress("1BoatSLRHtKNngkdXEeobR76b53LETtpyT"), /unsupported address type/);
assert.throws(() => decodeAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"), /invalid mainnet address/);

// ---- fee preview ------------------------------------------------------------------------
const prev = estimateMineFeeSats({ address: p2trAddr, ticker: "LUCKY", feeRateSatVb: 8 });
assert.ok(prev.vsize > 150 && prev.vsize < 250, `preview vsize plausible: ${prev.vsize}`);
assert.equal(prev.feeSats, Math.ceil(prev.vsize * 8));

// ---- MINE p2tr ---------------------------------------------------------------------------
{
  const r = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  const { outs } = checkCommon("MINE p2tr", r, { expectOutputs: 4, expectTap: true, self: p2trAddr, vout0: p2trAddr });
  assert.equal(payloadToString(outs[2].script.slice(2)), "LUCKYPROTOCOL|MINE|LUCKY");
  assert.equal(r.changeOmitted, false);
  // Smallest-first: 3_000 alone cannot cover 1_092 + fee (~1.8k) + dust headroom,
  // so the selector takes T(2) first and then T(4); T(1) (dust) and T(3) (token) never.
  const ins = parse(r.psbtHex).ins;
  assert.equal(ins.length, 2, "two inputs selected");
  assert.equal(hex.encode(ins[0].txid), T(2), "smallest spendable first");
  assert.equal(hex.encode(ins[1].txid), T(4), "then next smallest");
}

// ---- MINE p2wpkh --------------------------------------------------------------------------
{
  const r = buildMinePsbt({ address: p2wpkhAddr, pubkeyHex: P2WPKH_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  checkCommon("MINE p2wpkh", r, { expectOutputs: 4, expectTap: false, self: p2wpkhAddr, vout0: p2wpkhAddr });
}

// ---- MINE sub-dust change folds into fee ----------------------------------------------------
// 2_800 sats covers 1_092 fixed + ~1_464 fee (3 outputs) but NOT the dust
// headroom for a change output → MINE falls back to folding the remainder.
{
  const tight = [{ txid: T(5), vout: 0, sats: 2_800 }];
  const r = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: tight, tokenOutpoints: [], feeRateSatVb: 8, ticker: "LUCKY" });
  checkCommon("MINE tight", r, { expectOutputs: 3, expectTap: true, self: p2trAddr, vout0: p2trAddr });
  assert.equal(r.changeOmitted, true);
  assert.equal(r.changeSats, 0);
}

// ---- MINE insufficient -----------------------------------------------------------------------
assert.throws(
  () => buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(6), vout: 0, sats: 1_200 }], tokenOutpoints: [], feeRateSatVb: 8, ticker: "LUCKY" }),
  /insufficient funds/,
);
assert.throws(
  () => buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(1), vout: 0, sats: 546 }], tokenOutpoints: [], feeRateSatVb: 8, ticker: "LUCKY" }),
  /no spendable BTC/,
);

// ---- SEND p2tr → p2wpkh ----------------------------------------------------------------------
{
  const r = buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints,
    tokenUtxos: [{ txid: T(3), vout: 0 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 100, toAddress: p2wpkhAddr,
  });
  const { ins, outs } = parse(r.psbtHex);
  assert.equal(outs.length, 4, "SEND: 4 outputs");
  assert.equal(hex.encode(ins[0].txid), T(3), "SEND: token carrier pinned as input 0");
  // The carrier is a 20_000-sat token-bearing UTXO (a prior SEND's residual
  // change output, not dust). It MUST be spent at its real value: the
  // segwit/taproot sighash commits to the input amount, so signing it as
  // 546 would produce an invalid signature. Resolved from `utxos` by outpoint.
  assert.equal(ins[0].witnessUtxo.amount, 20_000n, "SEND: carrier spent at its real on-chain value");
  assert.equal(addrOf(outs[0].script), p2wpkhAddr, "SEND: vout0 recipient");
  assert.equal(addrOf(outs[1].script), PROJECT_FEE_ADDRESS);
  assert.equal(payloadToString(outs[2].script.slice(2)), "LUCKYPROTOCOL|SEND|LUCKY|100|0|3");
  assert.equal(addrOf(outs[3].script), p2trAddr, "SEND: vout3 change → self");
  assert.ok(outs[3].amount >= 546n, "SEND: change ≥ dust");
  const inSum = ins.reduce((s, i) => s + i.witnessUtxo.amount, 0n);
  const outSum = outs.reduce((s, o) => s + o.amount, 0n);
  assert.equal(inSum - outSum, BigInt(r.feeSats));
}

// ---- SEND must refuse when change would be sub-dust ------------------------------------------
// 2_500 funding + a 546-sat carrier covers the 1_092 fixed outputs + fee but
// leaves change < 546 → the committed vout3 would be missing → refuse.
assert.throws(
  () => buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(5), vout: 0, sats: 2_500 }], tokenOutpoints: [],
    tokenUtxos: [{ txid: T(3), vout: 0, sats: 546 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr,
  }),
  /change output required|insufficient funds/,
);

// ---- SEND must refuse a carrier whose on-chain value is unknown ----------------------------------
assert.throws(
  () => buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(4), vout: 2, sats: 90_000 }], tokenOutpoints: [],
    tokenUtxos: [{ txid: T(3), vout: 0 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr,
  }),
  /no known BTC value/,
);

// ---- fee-rate safety cap ------------------------------------------------------------------------
assert.throws(
  () => buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 5_000, ticker: "LUCKY" }),
  /safety cap/,
);

// ---- extractRawTxHex on an (unsigned) PSBT must fail loudly, not silently ----------------------
{
  const r = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  assert.throws(() => extractRawTxHex(r.psbtHex), /not finalized|finalize|sign/i);
}

console.log("psbt build: all structural checks passed");
