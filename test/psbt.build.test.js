// Structural test for src/lib/psbt.js — runs in plain Node, no framework.
// Builds MINE + SEND PSBTs for a P2TR and a P2WPKH wallet, parses them back
// with btc-signer, and asserts the spec §2/§4/§6 layout rules:
//   * dust (≤546) and token-bearing outpoints are never selected as inputs
//   * vout0 546 → self/recipient, vout1 546 → PROJECT_FEE_ADDRESS, vout2 OP_RETURN
//   * MINE folds sub-dust change into the fee
//   * SEND (H-1(A)): every token carrier is exactly 546 sats — vout0 recipient
//     slot, vout3 residual slot (ALWAYS present) — and BTC change is a separate
//     vout4 that folds into the fee when sub-dust; payload stays |0|3
//   * P2TR inputs carry tapInternalKey; P2WPKH inputs do not
//   * inputs − outputs == reported fee
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
  buildMinePsbt,
  buildSendPsbt,
  buildDeployPsbt,
  estimateMineFeeSats,
  estimateDeployFeeSats,
  estimateSendFeeSats,
  SEND_TO_OUT,
  SEND_CHANGE_OUT,
  SEND_BTC_CHANGE_VOUT,
  decodeAddress,
  extractRawTxHex,
  expectPsbtPayload,
  buildPayPsbt,
  filterSpendable,
  minFeeInputSats,
  MIN_FEE_INPUT_SATS_UNSAFE,
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
// A node's vsize is ceil(weight / 4): the preview must pay for the whole
// vbyte at every rate, for both input types (the estimate is fractional).
const RATES = [1, 1.01, 1.25, 2.5, 3, 10];
for (const feeRateSatVb of RATES) {
  for (const address of [p2trAddr, p2wpkhAddr]) {
    const p = estimateMineFeeSats({ address, ticker: "LUCKY", feeRateSatVb });
    assert.ok(p.feeSats >= p.vsize * feeRateSatVb - 1e-9, `preview ${address.slice(0, 4)} @ ${feeRateSatVb}: ${p.feeSats} ≥ ${p.vsize} × ${feeRateSatVb}`);
  }
}

// Decimal rates propagate into every ordinary transaction builder; totals
// and change stay integer satoshis suitable for PSBT serialization, and the
// fee is never below ceil(vsize) × rate (what the node actually charges for).
for (const feeRateSatVb of RATES) {
  for (const [address, pubkeyHex] of [[p2trAddr, P2TR_PUB], [p2wpkhAddr, P2WPKH_PUB]]) {
    const args = { address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb, ticker: "LUCKY" };
    const builds = [
      buildMinePsbt(args),
      buildDeployPsbt(args),
      buildPayPsbt({ ...args, toAddress: p2wpkhAddr, amountSats: 1000 }),
      buildSendPsbt({ ...args, tokenUtxos: [{ txid: T(3), vout: 0, sats: 20_000 }], toAddress: p2wpkhAddr, amount: 1 }),
    ];
    for (const built of builds) {
      assert.equal(built.feeRateSatVb, feeRateSatVb);
      assert.ok(Number.isInteger(built.feeSats));
      assert.ok(Number.isInteger(built.changeSats));
      assert.ok(Number.isInteger(built.estimatedVsize));
      assert.ok(built.feeSats >= Math.ceil(built.estimatedVsize) * feeRateSatVb - 1e-9, `${address.slice(0, 4)} @ ${feeRateSatVb}: fee ${built.feeSats} ≥ ${built.estimatedVsize} vB × ${feeRateSatVb}`);
      const { ins, outs } = parse(built.psbtHex);
      assert.equal(ins.reduce((s, i) => s + i.witnessUtxo.amount, 0n) - outs.reduce((s, o) => s + o.amount, 0n), BigInt(built.feeSats));
    }
  }
}

// The regression: a single-input P2WPKH MINE estimates 213.5 vB (→ 214 on
// the node). ceil(213.5 × 3) = 641 is one sat under the node's 214 × 3.
{
  const r = buildMinePsbt({ address: p2wpkhAddr, pubkeyHex: P2WPKH_PUB, utxos: [{ txid: T(4), vout: 2, sats: 90_000 }], tokenOutpoints: [], feeRateSatVb: 3, ticker: "LUCKY" });
  assert.equal(r.inputIndexes.length, 1);
  assert.equal(r.estimatedVsize, 214);
  assert.equal(r.feeSats, 642, "fee == ceil(vsize) × rate, not ceil(vsize × rate)");
}

// ---- MINE p2tr ---------------------------------------------------------------------------
{
  const r = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  const { outs } = checkCommon("MINE p2tr", r, { expectOutputs: 4, expectTap: true, self: p2trAddr, vout0: p2trAddr });
  assert.equal(payloadToString(outs[2].script.slice(2)), "LUCKY-20|MINE|LUCKY");
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

// ---- SEND layout (H-1(A)) -------------------------------------------------------------------------
//   vout0 546 → recipient · vout1 546 → fee · vout2 OP_RETURN |0|3 · vout3 546 → self (residual
//   slot, always) · vout4 BTC change → self (only when ≥ 546)
assert.equal(SEND_TO_OUT, 0);
assert.equal(SEND_CHANGE_OUT, 3);
assert.equal(SEND_BTC_CHANGE_VOUT, 4);

/** Assert the fixed part of the H-1(A) SEND layout; returns the parsed tx parts. */
function checkSendLayout(label, r, { self, to, payload }) {
  const { ins, outs } = parse(r.psbtHex);
  assert.ok(outs.length === 4 || outs.length === 5, `${label}: 4 outputs (change folded) or 5 (with change), got ${outs.length}`);
  assert.equal(outs.length, r.outputCount, `${label}: outputCount reported`);
  assert.equal(addrOf(outs[0].script), to, `${label}: vout0 → recipient`);
  assert.equal(outs[0].amount, 546n, `${label}: vout0 recipient slot is exactly 546`);
  assert.equal(addrOf(outs[1].script), PROJECT_FEE_ADDRESS, `${label}: vout1 → fee address`);
  assert.equal(outs[1].amount, 546n, `${label}: vout1 exact protocol fee`);
  assert.equal(outs[2].script[0], 0x6a, `${label}: vout2 OP_RETURN`);
  assert.equal(outs[2].amount, 0n);
  assert.equal(payloadToString(outs[2].script.slice(2)), payload, `${label}: payload string unchanged (|0|3)`);
  assert.equal(addrOf(outs[3].script), self, `${label}: vout3 residual slot → sender`);
  assert.equal(outs[3].amount, 546n, `${label}: vout3 residual slot is exactly 546 (always present)`);
  assert.equal(r.residualVout, 3);
  if (outs.length === 5) {
    assert.equal(r.changeOmitted, false, `${label}: changeOmitted false with 5 outputs`);
    assert.equal(r.changeVout, 4);
    assert.equal(addrOf(outs[4].script), self, `${label}: vout4 BTC change → sender`);
    assert.equal(outs[4].amount, BigInt(r.changeSats), `${label}: vout4 == changeSats`);
    assert.ok(outs[4].amount >= 546n, `${label}: vout4 ≥ dust`);
  } else {
    assert.equal(r.changeOmitted, true, `${label}: changeOmitted true with 4 outputs`);
    assert.equal(r.changeVout, null);
    assert.equal(r.changeSats, 0);
  }
  // every carrier output is exactly 546 sats
  for (const i of [0, 1, 3]) assert.equal(outs[i].amount, 546n, `${label}: vout${i} is a 546-sat output`);
  const inSum = ins.reduce((s, i) => s + i.witnessUtxo.amount, 0n);
  const outSum = outs.reduce((s, o) => s + o.amount, 0n);
  assert.equal(inSum - outSum, BigInt(r.feeSats), `${label}: fee == inputs − outputs`);
  return { ins, outs };
}

// ---- SEND p2tr → p2wpkh, with BTC change (5 outputs) ------------------------------------------------
{
  const r = buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints,
    tokenUtxos: [{ txid: T(3), vout: 0 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 100, toAddress: p2wpkhAddr,
  });
  const { ins, outs } = checkSendLayout("SEND p2tr→p2wpkh", r, { self: p2trAddr, to: p2wpkhAddr, payload: "LUCKY-20|SEND|LUCKY|100|0|3" });
  assert.equal(outs.length, 5, "SEND: 5 outputs when change is ≥ dust");
  assert.equal(hex.encode(ins[0].txid), T(3), "SEND: token carrier pinned as input 0");
  // The carrier here is a 20_000-sat token-bearing UTXO (a third-party
  // builder's fat carrier). It MUST be spent at its real value: the
  // segwit/taproot sighash commits to the input amount, so signing it as
  // 546 would produce an invalid signature. Resolved from `utxos` by outpoint.
  assert.equal(ins[0].witnessUtxo.amount, 20_000n, "SEND: carrier spent at its real on-chain value");
  assert.equal(ins.length, 1, "SEND: the fat carrier alone funds 3 × 546 + fee, no fee input needed");
  // sign-time guard sees TO=0 / CHANGE=3
  assert.deepEqual(expectPsbtPayload(r.psbtHex, { op: "SEND", ticker: "LUCKY", amount: 100 }), { op: "SEND", ticker: "LUCKY", amount: 100, toOutIdx: 0, changeOutIdx: 3 });
}

// ---- SEND p2wpkh → p2tr with a 546-sat carrier: fee inputs get selected ----------------------------
{
  const r = buildSendPsbt({
    address: p2wpkhAddr, pubkeyHex: P2WPKH_PUB, utxos, tokenOutpoints: [],
    tokenUtxos: [{ txid: T(1), vout: 0 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 7, toAddress: p2trAddr,
  });
  const { ins, outs } = checkSendLayout("SEND p2wpkh→p2tr", r, { self: p2wpkhAddr, to: p2trAddr, payload: "LUCKY-20|SEND|LUCKY|7|0|3" });
  assert.equal(outs.length, 5);
  assert.equal(hex.encode(ins[0].txid), T(1), "546-sat carrier pinned as input 0 at its real value");
  assert.equal(ins[0].witnessUtxo.amount, 546n);
  assert.ok(ins.length >= 2, "a fee input was added");
  for (const inp of ins.slice(1)) assert.ok(inp.witnessUtxo.amount > 546n, "fee inputs are never dust");
  assert.equal(ins[1].tapInternalKey, undefined, "no tapInternalKey on P2WPKH");
}

// ---- SEND folds sub-dust BTC change into the fee (residual slot stays) ----------------------------------
{
  // Learn the one-fee-input fee, then fund exactly 3 × 546 + fee + 100 − carrier:
  // change would be 100 sats < 546 → folded (4 outputs), never a missing slot.
  const probe = buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(5), vout: 0, sats: 500_000 }], tokenOutpoints: [],
    tokenUtxos: [{ txid: T(3), vout: 0, sats: 546 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr,
  });
  assert.equal(parse(probe.psbtHex).ins.length, 2);
  const feeWithChange = probe.feeSats;
  const tight = [{ txid: T(5), vout: 0, sats: 3 * 546 + feeWithChange + 100 - 546 }];
  const r = buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: tight, tokenOutpoints: [],
    tokenUtxos: [{ txid: T(3), vout: 0, sats: 546 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr,
  });
  const { outs } = checkSendLayout("SEND folded", r, { self: p2trAddr, to: p2wpkhAddr, payload: "LUCKY-20|SEND|LUCKY|1|0|3" });
  assert.equal(outs.length, 4, "sub-dust change folds into the fee — vout3 residual slot still present");
  assert.equal(r.changeOmitted, true);
  assert.ok(r.feeSats > feeWithChange - 50 && r.feeSats < feeWithChange + 200, `folded fee absorbs the remainder: ${r.feeSats}`);
  // …and with the dust headroom back it builds with vout4 == 546 + 100
  const ok = buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(5), vout: 0, sats: tight[0].sats + 546 }], tokenOutpoints: [],
    tokenUtxos: [{ txid: T(3), vout: 0, sats: 546 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr,
  });
  checkSendLayout("SEND +headroom", ok, { self: p2trAddr, to: p2wpkhAddr, payload: "LUCKY-20|SEND|LUCKY|1|0|3" });
  assert.equal(ok.changeSats, 646, "change accounted exactly");
  assert.equal(ok.changeVout, 4);
}

// ---- SEND insufficient: a lone 546-sat carrier + 1,200 sats cannot pay 3 slots + fee -------------------------
assert.throws(
  () => buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(5), vout: 0, sats: 1_200 }], tokenOutpoints: [],
    tokenUtxos: [{ txid: T(3), vout: 0, sats: 546 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr,
  }),
  /insufficient funds/,
);

// ---- SEND fee preview ----------------------------------------------------------------------------------
{
  const prevS = estimateSendFeeSats({ address: p2trAddr, toAddress: p2wpkhAddr, ticker: "LUCKY", amount: 100, feeRateSatVb: 8 });
  assert.ok(prevS.vsize > 200 && prevS.vsize < 330, `send preview vsize plausible (2 inputs, 4 address outputs + OP_RETURN): ${prevS.vsize}`);
  assert.equal(prevS.feeSats, prevS.vsize * 8, "fee == rate × ceil(vsize): the node charges for whole vbytes");
  assert.equal(prevS.slotSats, 3 * 546, "recipient slot + protocol fee + residual slot");
}

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

// ---- DEPLOY (§2.1): vout0 546 → self, vout1 5,460 → fee, vout2 OP_RETURN, vout3 change ------------
{
  const prevD = estimateDeployFeeSats({ address: p2trAddr, ticker: "NEWTKN", feeRateSatVb: 8 });
  assert.ok(prevD.vsize > 150 && prevD.vsize < 250, `deploy preview vsize plausible: ${prevD.vsize}`);
  for (const [label, address, pubkeyHex, expectTap] of [["p2tr", p2trAddr, P2TR_PUB, true], ["p2wpkh", p2wpkhAddr, P2WPKH_PUB, false]]) {
    const r = buildDeployPsbt({ address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "NEWTKN" });
    const { ins, outs } = parse(r.psbtHex);
    assert.equal(outs.length, 4, `DEPLOY ${label}: 4 outputs`);
    for (const inp of ins) {
      assert.ok(inp.witnessUtxo.amount > 546n, `DEPLOY ${label}: dust input selected`);
      assert.notEqual(hex.encode(inp.txid), T(3), `DEPLOY ${label}: token outpoint selected (its tokens would be default-routed to vout0)`);
      if (expectTap) assert.equal(hex.encode(inp.tapInternalKey), XONLY);
      else assert.equal(inp.tapInternalKey, undefined);
    }
    assert.equal(addrOf(outs[0].script), address, `DEPLOY ${label}: vout0 → deployer`);
    assert.equal(outs[0].amount, 546n);
    assert.equal(addrOf(outs[1].script), PROJECT_FEE_ADDRESS, `DEPLOY ${label}: vout1 → fee address`);
    assert.equal(outs[1].amount, 5_460n, `DEPLOY ${label}: exact 5,460-sat protocol fee`);
    assert.equal(outs[2].script[0], 0x6a);
    assert.equal(payloadToString(outs[2].script.slice(2)), "LUCKY-20|DEPLOY|NEWTKN");
    assert.equal(addrOf(outs[3].script), address, `DEPLOY ${label}: change → self`);
    assert.ok(outs[3].amount >= 546n);
    const inSum = ins.reduce((s, i) => s + i.witnessUtxo.amount, 0n);
    const outSum = outs.reduce((s, o) => s + o.amount, 0n);
    assert.equal(inSum - outSum, BigInt(r.feeSats), `DEPLOY ${label}: fee == inputs − outputs`);
  }
  assert.throws(() => buildDeployPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "lucky" }), /A-Z 0-9/);
  assert.throws(() => buildDeployPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "TOOLONGTKN" }), /length/);
}

// ---- M-8: fee-input floor on non-asset-safe UTXO lists ----------------------------------------------
{
  assert.equal(MIN_FEE_INPUT_SATS_UNSAFE, 10_000);
  assert.equal(minFeeInputSats(true), 0, "asset-safe list: no floor");
  assert.equal(minFeeInputSats(false), 10_000);
  assert.equal(minFeeInputSats("inscriptions-only"), 10_000, "inscriptions-only still cannot see runes");
  assert.equal(minFeeInputSats(null), 10_000);
  // filterSpendable: the §4 rules always apply; the floor drops the 3,000-sat output too
  assert.deepEqual(filterSpendable(utxos, tokenOutpoints).map((u) => u.sats), [3_000, 90_000]);
  assert.deepEqual(filterSpendable(utxos, tokenOutpoints, { minSats: 10_000 }).map((u) => u.sats), [90_000]);
  assert.deepEqual(filterSpendable([{ txid: T(7), vout: 0, sats: 10_000 }], [], { minSats: 10_000 }).map((u) => u.sats), [10_000], "exactly the floor qualifies");
  // buildMinePsbt with the floor never selects the 3,000-sat output
  const r = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY", minInputSats: MIN_FEE_INPUT_SATS_UNSAFE });
  const ins = parse(r.psbtHex).ins;
  assert.equal(ins.length, 1);
  assert.equal(hex.encode(ins[0].txid), T(4), "only the 90,000-sat output qualifies");
  assert.deepEqual(r.inputs, [{ txid: T(4), vout: 2, sats: 90_000 }], "inputs are reported for the signing step");
  // nothing above the floor → a clear error naming the floor and the remedy
  assert.throws(
    () => buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(6), vout: 0, sats: 9_999 }], tokenOutpoints: [], feeRateSatVb: 8, ticker: "LUCKY", minInputSats: MIN_FEE_INPUT_SATS_UNSAFE }),
    /no asset-safe UTXO list.*10,000 sats/,
  );
  // SEND: the carrier is pinned regardless of the floor; the fee inputs obey it
  {
    const s = buildSendPsbt({
      address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints,
      tokenUtxos: [{ txid: T(3), vout: 0 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 100, toAddress: p2wpkhAddr, minInputSats: MIN_FEE_INPUT_SATS_UNSAFE,
    });
    const sIns = parse(s.psbtHex).ins.map((i) => hex.encode(i.txid));
    assert.ok(sIns.includes(T(3)), "carrier pinned");
    assert.ok(!sIns.includes(T(2)), "3,000-sat output never a fee input under the floor");
    checkSendLayout("SEND floored", s, { self: p2trAddr, to: p2wpkhAddr, payload: "LUCKY-20|SEND|LUCKY|100|0|3" });
    assert.throws(
      () => buildSendPsbt({
        address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(2), vout: 1, sats: 3_000 }], tokenOutpoints: [],
        tokenUtxos: [{ txid: T(3), vout: 0, sats: 546 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr, minInputSats: MIN_FEE_INPUT_SATS_UNSAFE,
      }),
      /no asset-safe UTXO list/,
    );
  }
  console.log("psbt floor: non-asset-safe lists never spend outputs under 10,000 sats");
}

// ---- M-1: sign-time payload guard ---------------------------------------------------------------
{
  const mine = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  assert.deepEqual(expectPsbtPayload(mine.psbtHex, { op: "MINE", ticker: "LUCKY" }), { op: "MINE", ticker: "LUCKY" });
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: "SEND" }), /OP_RETURN is MINE, expected SEND/);
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: "MINE", ticker: "ORE" }), /names ticker LUCKY, expected ORE/);
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: null }), /plain payment must not carry an OP_RETURN/);
  const dep = buildDeployPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "NEWTKN" });
  assert.equal(expectPsbtPayload(dep.psbtHex, { op: "DEPLOY", ticker: "NEWTKN" }).op, "DEPLOY");
  assert.throws(() => expectPsbtPayload(dep.psbtHex, { op: "MINE", ticker: "NEWTKN" }), /expected MINE/);
  const pay = buildPayPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, toAddress: p2wpkhAddr, amountSats: 10_000 });
  assert.equal(expectPsbtPayload(pay.psbtHex, { op: null }), null, "a plain payment has no OP_RETURN");
  assert.throws(() => expectPsbtPayload(pay.psbtHex, { op: "MINE" }), /no OP_RETURN output — expected a MINE payload/);
  console.log("psbt guard: expectPsbtPayload asserts op / ticker / amount before signing");
}

console.log("psbt build: all structural checks passed");
