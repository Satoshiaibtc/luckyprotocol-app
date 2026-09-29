// Structural test for src/lib/psbt.js — runs in plain Node, no framework.
// Builds DEPLOY, MINE and SEND PSBTs for a P2TR and a P2WPKH wallet, parses
// them back with btc-signer, and asserts the spec §2/§4/§6 layout rules:
//   * dust (≤546) and token-bearing outpoints are never selected as inputs
//   * DEPLOY: vout0 546 → self, vout1 5,460 → PROJECT_FEE_ADDRESS, vout2
//     OP_RETURN, vout3 change (optional)
//   * MINE: vout0 546 → self, vout1 546 → PROJECT_FEE_ADDRESS, vout2
//     OP_RETURN; sub-dust change folds into the fee
//   * SEND (§2.3): vout0 546 → PROJECT_FEE_ADDRESS, vout1 546 → recipient
//     (AMT), vout2 546 → self (the residual output, ALWAYS present), vout3
//     OP_RETURN, and BTC change is a separate vout4 that folds into the fee
//     when sub-dust
//   * every tx: version 2, nLockTime 969,599, every input RBF_SEQUENCE
//   * P2TR inputs carry tapInternalKey; P2WPKH inputs do not
//   * inputs − outputs == reported fee
//   * the sign-time guard (expectPsbtPayload) refuses a wrong payload, lock
//     time, sequence or output layout
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
  buildDeployPsbt,
  buildMinePsbt,
  buildSendPsbt,
  buildSpeedUpPsbt,
  checkRecipientAddress,
  decodeRecipientAddress,
  estimateDeployFeeSats,
  estimateMineFeeSats,
  estimateSendFeeSats,
  psbtFeeSats,
  psbtPayload,
  psbtVsize,
  speedUpCeilingRate,
  speedUpFloorRate,
  DEPLOY_CHANGE_VOUT,
  RBF_SEQUENCE,
  SEND_FEE_VOUT,
  SEND_TO_VOUT,
  SEND_RESIDUAL_VOUT,
  SEND_OP_RETURN_VOUT,
  SEND_BTC_CHANGE_VOUT,
  decodeAddress,
  extractRawTxHex,
  expectPsbtPayload,
  checkExpectedPayload,
  makeOpReturnScript,
  protocolPayloadOfScripts,
  filterSpendable,
  inputCostSats,
  minFeeInputSats,
  selectInputs,
  selectionOrderFor,
  MIN_FEE_INPUT_SATS_UNSAFE,
} from "../src/lib/psbt.js";
import { PROJECT_FEE_ADDRESS, PROTOCOL_LOCKTIME, payloadToString } from "../src/lib/payloads.js";

// BIP340 test-vector pubkey (valid x-only) → P2TR address.
const XONLY = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const P2TR_PUB = `02${XONLY}`;
const p2trAddr = btc.p2tr(hex.decode(XONLY), undefined, btc.NETWORK).address;
// secp256k1 generator point → P2WPKH address.
const P2WPKH_PUB = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const p2wpkhAddr = btc.p2wpkh(hex.decode(P2WPKH_PUB), btc.NETWORK).address;
// 2G (a key nobody here signs with) → another P2WPKH address.
const OTHER = btc.p2wpkh(hex.decode("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"), btc.NETWORK).address;

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
const pushText = (script) => payloadToString(script.slice(2)); // a direct push: OP_RETURN, length, data

function parse(psbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex));
  const ins = [];
  for (let i = 0; i < tx.inputsLength; i++) ins.push(tx.getInput(i));
  const outs = [];
  for (let i = 0; i < tx.outputsLength; i++) outs.push(tx.getOutput(i));
  return { tx, ins, outs };
}

/**
 * The same unsigned transaction with some parts changed: `outs(outputs)`
 * returns the new output list ({ script, amount }), `sequence(i, seq)` a new
 * nSequence, `lockTime` a new lock time.
 */
function variant(psbtHex, { outs = (o) => o, sequence = (_, s) => s, lockTime } = {}) {
  const src = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });
  const tx = new btc.Transaction({ version: src.version, lockTime: lockTime ?? src.lockTime, allowUnknownOutputs: true });
  for (let i = 0; i < src.inputsLength; i++) {
    const inp = src.getInput(i);
    tx.addInput({ txid: inp.txid, index: inp.index, sequence: sequence(i, inp.sequence), witnessUtxo: inp.witnessUtxo, ...(inp.tapInternalKey ? { tapInternalKey: inp.tapInternalKey } : {}) });
  }
  const list = [];
  for (let i = 0; i < src.outputsLength; i++) list.push({ script: src.getOutput(i).script, amount: src.getOutput(i).amount });
  for (const o of outs(list)) tx.addOutput(o);
  return hex.encode(tx.toPSBT());
}
const scriptOf = (address) => btc.OutScript.encode(btc.Address(btc.NETWORK).decode(address));

/** The inputs of `r` are plain BTC of `self`'s type (never dust, never a token outpoint), RBF-signalling. */
function checkInputs(label, r, { expectTap }) {
  const { tx, ins } = parse(r.psbtHex);
  assert.equal(tx.version, 2, `${label}: version 2`);
  assert.equal(tx.lockTime, PROTOCOL_LOCKTIME, `${label}: nLockTime 969,599`);
  assert.equal(ins.length, r.inputIndexes.length, `${label}: inputIndexes length`);
  r.inputIndexes.forEach((idx, i) => assert.equal(idx, i, `${label}: inputIndexes sequential`));
  for (const inp of ins) {
    assert.ok(inp.witnessUtxo, `${label}: witnessUtxo present`);
    assert.equal(inp.sequence, RBF_SEQUENCE, `${label}: every input signals RBF`);
    if (expectTap) assert.equal(hex.encode(inp.tapInternalKey), XONLY, `${label}: tapInternalKey = x-only pubkey`);
    else assert.equal(inp.tapInternalKey, undefined, `${label}: no tapInternalKey on P2WPKH`);
  }
}

/** DEPLOY / MINE: vout0 546 → self, vout1 exact fee → fee address, vout2 OP_RETURN, vout3 change (optional). */
function checkCommon(label, r, { expectOutputs, expectTap, self, fee = 546n }) {
  const { ins, outs } = parse(r.psbtHex);
  checkInputs(label, r, { expectTap });
  assert.equal(outs.length, expectOutputs, `${label}: output count`);
  for (const inp of ins) {
    assert.ok(inp.witnessUtxo.amount > 546n, `${label}: dust input selected`);
    assert.notEqual(hex.encode(inp.txid), T(3), `${label}: token outpoint selected`);
  }
  assert.equal(addrOf(outs[0].script), self, `${label}: vout0 address`);
  assert.equal(outs[0].amount, 546n, `${label}: vout0 amount`);
  assert.equal(addrOf(outs[1].script), PROJECT_FEE_ADDRESS, `${label}: vout1 fee address`);
  assert.equal(outs[1].amount, fee, `${label}: vout1 exact fee`);
  assert.equal(outs[2].script[0], 0x6a, `${label}: vout2 OP_RETURN`);
  assert.equal(outs[2].amount, 0n, `${label}: OP_RETURN value 0`);
  if (expectOutputs === 4) {
    assert.equal(r.changeVout, 3);
    assert.equal(addrOf(outs[3].script), self, `${label}: change → self`);
    assert.equal(outs[3].amount, BigInt(r.changeSats), `${label}: change amount`);
    assert.ok(outs[3].amount >= 546n, `${label}: change ≥ dust`);
  } else {
    assert.equal(r.changeVout, null);
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

// ---- fee previews ------------------------------------------------------------------------
const prev = estimateMineFeeSats({ address: p2trAddr, ticker: "LUCKY", feeRateSatVb: 8 });
assert.ok(prev.vsize > 150 && prev.vsize < 280, `preview vsize plausible: ${prev.vsize}`);
assert.equal(prev.feeSats, Math.ceil(prev.vsize * 8));
const prevD = estimateDeployFeeSats({ address: p2trAddr, ticker: "NEWTKN", feeRateSatVb: 8 });
assert.ok(prevD.vsize > 200 && prevD.vsize < 320, `DEPLOY preview vsize plausible: ${prevD.vsize}`);
assert.equal(prevD.feeSats, prevD.vsize * 8);
assert.ok(prevD.vsize > prev.vsize, "a DEPLOY payload is longer than a MINE's");
// A node's vsize is ceil(weight / 4): the preview must pay for the whole
// vbyte at every rate, for both input types (the estimate is fractional).
const RATES = [1, 1.01, 1.25, 2.5, 3, 10];
for (const feeRateSatVb of RATES) {
  for (const address of [p2trAddr, p2wpkhAddr]) {
    for (const p of [estimateMineFeeSats({ address, ticker: "LUCKY", feeRateSatVb }), estimateDeployFeeSats({ address, ticker: "LUCKY", feeRateSatVb })]) {
      assert.ok(p.feeSats >= p.vsize * feeRateSatVb - 1e-9, `preview ${address.slice(0, 4)} @ ${feeRateSatVb}: ${p.feeSats} ≥ ${p.vsize} × ${feeRateSatVb}`);
    }
  }
}

// Decimal rates propagate into every transaction builder; totals and change
// stay integer satoshis suitable for PSBT serialization, and the fee is
// never below ceil(vsize) × rate (what the node actually charges for).
for (const feeRateSatVb of RATES) {
  for (const [address, pubkeyHex] of [[p2trAddr, P2TR_PUB], [p2wpkhAddr, P2WPKH_PUB]]) {
    const args = { address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb, ticker: "LUCKY" };
    const builds = [
      buildMinePsbt(args),
      buildDeployPsbt({ ...args, ticker: "NEWTKN" }),
      buildSendPsbt({ ...args, tokenUtxos: [{ txid: T(3), vout: 0, sats: 20_000 }], toAddress: p2wpkhAddr === address ? p2trAddr : p2wpkhAddr, amount: 1 }),
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

// Rounding: a single-input P2WPKH MINE of LUCKY estimates a fractional
// vsize; the fee is ceil(vsize) × rate, never ceil(vsize × rate).
{
  const r = buildMinePsbt({ address: p2wpkhAddr, pubkeyHex: P2WPKH_PUB, utxos: [{ txid: T(4), vout: 2, sats: 90_000 }], tokenOutpoints: [], feeRateSatVb: 3, ticker: "LUCKY" });
  assert.equal(r.inputIndexes.length, 1);
  assert.equal(r.feeSats, r.estimatedVsize * 3, "fee == ceil(vsize) × rate");
  assert.equal(Math.ceil(psbtVsize(r.psbtHex)), r.estimatedVsize);
}

// ---- MINE p2tr ---------------------------------------------------------------------------
{
  const r = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  const { outs } = checkCommon("MINE p2tr", r, { expectOutputs: 4, expectTap: true, self: p2trAddr });
  assert.equal(pushText(outs[2].script), '{"p":"lucky-20","op":"mine","tick":"LUCKY"}');
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
  checkCommon("MINE p2wpkh", r, { expectOutputs: 4, expectTap: false, self: p2wpkhAddr });
}

// ---- MINE sub-dust change folds into fee ----------------------------------------------------
// 2_800 sats covers 1_092 fixed + the fee of 3 outputs but NOT the dust
// headroom for a change output → MINE falls back to folding the remainder.
{
  const tight = [{ txid: T(5), vout: 0, sats: 2_800 }];
  const r = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: tight, tokenOutpoints: [], feeRateSatVb: 8, ticker: "LUCKY" });
  checkCommon("MINE tight", r, { expectOutputs: 3, expectTap: true, self: p2trAddr });
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

// ---- DEPLOY (§2.1): vout0 546 proof → self, vout1 exactly 5,460 → fee, vout2 JSON, vout3 change ----
{
  assert.equal(DEPLOY_CHANGE_VOUT, 3);
  for (const [label, address, pubkeyHex, expectTap] of [["p2tr", p2trAddr, P2TR_PUB, true], ["p2wpkh", p2wpkhAddr, P2WPKH_PUB, false]]) {
    const r = buildDeployPsbt({ address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "NEWTKN" });
    const { outs } = checkCommon(`DEPLOY ${label}`, r, { expectOutputs: 4, expectTap, self: address, fee: 5_460n });
    assert.equal(pushText(outs[2].script), '{"p":"lucky-20","op":"deploy","tick":"NEWTKN"}');
    assert.equal(r.changeVout, DEPLOY_CHANGE_VOUT);
    assert.deepEqual(expectPsbtPayload(r.psbtHex, { op: "DEPLOY", ticker: "NEWTKN", lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self: address } }), { op: "DEPLOY", ticker: "NEWTKN" });
    assert.deepEqual(psbtPayload(r.psbtHex), { op: "DEPLOY", ticker: "NEWTKN" });
  }
  // Sub-dust change folds into the fee: no change output, changeVout null.
  const probe = buildDeployPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(5), vout: 0, sats: 500_000 }], tokenOutpoints: [], feeRateSatVb: 8, ticker: "NEWTKN" });
  const noChangeFee = Math.ceil(Math.ceil(psbtVsize(probe.psbtHex) - 43) * 8);
  const tight = buildDeployPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(5), vout: 0, sats: 546 + 5_460 + noChangeFee + 200 }], tokenOutpoints: [], feeRateSatVb: 8, ticker: "NEWTKN" });
  checkCommon("DEPLOY tight", tight, { expectOutputs: 3, expectTap: true, self: p2trAddr, fee: 5_460n });
  assert.equal(tight.changeOmitted, true);
  assert.equal(tight.changeVout, null, "no change output: nothing a Speed up could take a fee from");
  assert.equal(speedUpCeilingRate(tight.psbtHex, tight.changeVout), 0, "no change → no Speed up headroom");
  // Token outpoints and dust are never selected (checkCommon), and the ticker is validated.
  assert.throws(() => buildDeployPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "newtkn" }), /A-Z 0-9/);
  assert.throws(() => buildDeployPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(1), vout: 0, sats: 546 }], tokenOutpoints: [], feeRateSatVb: 8, ticker: "NEWTKN" }), /no spendable BTC/);
  console.log("psbt DEPLOY: proof / exact 5,460 fee / JSON deploy / change, version 2, nLockTime 969,599, RBF inputs; sub-dust change folds (changeVout null)");
}

// ---- SEND layout (§2.3) -------------------------------------------------------------------------
//   vout0 546 → fee · vout1 546 → recipient (AMT) · vout2 546 → self (the residual output, always)
//   · vout3 OP_RETURN · vout4 BTC change → self (only when ≥ 546)
assert.equal(SEND_FEE_VOUT, 0);
assert.equal(SEND_TO_VOUT, 1);
assert.equal(SEND_RESIDUAL_VOUT, 2);
assert.equal(SEND_OP_RETURN_VOUT, 3);
assert.equal(SEND_BTC_CHANGE_VOUT, 4);

/** Assert the fixed part of the §2.3 SEND layout; returns the parsed tx parts. */
function checkSendLayout(label, r, { self, to, payload }) {
  const { ins, outs } = parse(r.psbtHex);
  checkInputs(label, r, { expectTap: self === p2trAddr });
  assert.ok(outs.length === 4 || outs.length === 5, `${label}: 4 outputs (change folded) or 5 (with change), got ${outs.length}`);
  assert.equal(outs.length, r.outputCount, `${label}: outputCount reported`);
  assert.equal(addrOf(outs[0].script), PROJECT_FEE_ADDRESS, `${label}: vout0 → fee address`);
  assert.equal(outs[0].amount, 546n, `${label}: vout0 exact protocol fee`);
  assert.equal(addrOf(outs[1].script), to, `${label}: vout1 → recipient`);
  assert.equal(outs[1].amount, 546n, `${label}: vout1 is exactly 546`);
  assert.equal(addrOf(outs[2].script), self, `${label}: vout2 residual → sender`);
  assert.equal(outs[2].amount, 546n, `${label}: vout2 residual is exactly 546 (always present)`);
  assert.equal(outs[3].script[0], 0x6a, `${label}: vout3 OP_RETURN`);
  assert.equal(outs[3].amount, 0n);
  assert.equal(pushText(outs[3].script), payload, `${label}: payload bytes`);
  assert.equal(r.residualVout, 2);
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
  const inSum = ins.reduce((s, i) => s + i.witnessUtxo.amount, 0n);
  const outSum = outs.reduce((s, o) => s + o.amount, 0n);
  assert.equal(inSum - outSum, BigInt(r.feeSats), `${label}: fee == inputs − outputs`);
  // The sign-time guard accepts exactly this layout.
  const want = { op: "SEND", ticker: JSON.parse(payload).tick, amount: Number(JSON.parse(payload).amt), lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self, to } };
  assert.deepEqual(expectPsbtPayload(r.psbtHex, want), { op: "SEND", ticker: want.ticker, amount: want.amount }, `${label}: the guard accepts the reference layout`);
  return { ins, outs };
}

// ---- SEND p2tr → p2wpkh, with BTC change (5 outputs) ------------------------------------------------
{
  const r = buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints,
    tokenUtxos: [{ txid: T(3), vout: 0 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 100, toAddress: p2wpkhAddr,
  });
  const { ins, outs } = checkSendLayout("SEND p2tr→p2wpkh", r, { self: p2trAddr, to: p2wpkhAddr, payload: '{"p":"lucky-20","op":"send","tick":"LUCKY","amt":"100"}' });
  assert.equal(outs.length, 5, "SEND: 5 outputs when change is ≥ dust");
  assert.equal(hex.encode(ins[0].txid), T(3), "SEND: token carrier pinned as input 0");
  // The carrier here is a 20_000-sat token-bearing UTXO (a third-party
  // builder's fat carrier). It MUST be spent at its real value: the
  // segwit/taproot sighash commits to the input amount, so signing it as
  // 546 would produce an invalid signature. Resolved from `utxos` by outpoint.
  assert.equal(ins[0].witnessUtxo.amount, 20_000n, "SEND: carrier spent at its real on-chain value");
  assert.equal(ins.length, 1, "SEND: the fat carrier alone funds 3 × 546 + fee, no fee input needed");
  assert.deepEqual(psbtPayload(r.psbtHex), { op: "SEND", ticker: "LUCKY", amount: 100 }, "no output index in the payload");
}

// ---- SEND p2wpkh → p2tr with a 546-sat carrier: fee inputs get selected ----------------------------
{
  const r = buildSendPsbt({
    address: p2wpkhAddr, pubkeyHex: P2WPKH_PUB, utxos, tokenOutpoints: [],
    tokenUtxos: [{ txid: T(1), vout: 0 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 7, toAddress: p2trAddr,
  });
  const { ins, outs } = checkSendLayout("SEND p2wpkh→p2tr", r, { self: p2wpkhAddr, to: p2trAddr, payload: '{"p":"lucky-20","op":"send","tick":"LUCKY","amt":"7"}' });
  assert.equal(outs.length, 5);
  assert.equal(hex.encode(ins[0].txid), T(1), "546-sat carrier pinned as input 0 at its real value");
  assert.equal(ins[0].witnessUtxo.amount, 546n);
  assert.ok(ins.length >= 2, "a fee input was added");
  for (const inp of ins.slice(1)) assert.ok(inp.witnessUtxo.amount > 546n, "fee inputs are never dust");
}

// ---- SEND to self (split / withdraw): vout1 is the new carrier ------------------------------------------
{
  const r = buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints,
    tokenUtxos: [{ txid: T(3), vout: 0 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 40, toAddress: p2trAddr,
  });
  checkSendLayout("SEND to self", r, { self: p2trAddr, to: p2trAddr, payload: '{"p":"lucky-20","op":"send","tick":"LUCKY","amt":"40"}' });
}

// ---- SEND folds sub-dust BTC change into the fee (the residual output stays) ----------------------------------
{
  // Learn the one-fee-input fee, then fund exactly 3 × 546 + fee + 100 − carrier:
  // change would be 100 sats < 546 → folded (4 outputs), never a missing vout2.
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
  const { outs } = checkSendLayout("SEND folded", r, { self: p2trAddr, to: p2wpkhAddr, payload: '{"p":"lucky-20","op":"send","tick":"LUCKY","amt":"1"}' });
  assert.equal(outs.length, 4, "sub-dust change folds into the fee — the vout2 residual output is still present");
  assert.equal(r.changeOmitted, true);
  assert.ok(r.feeSats > feeWithChange - 50 && r.feeSats < feeWithChange + 200, `folded fee absorbs the remainder: ${r.feeSats}`);
  // …and with the dust headroom back it builds with vout4 == 546 + 100
  const ok = buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(5), vout: 0, sats: tight[0].sats + 546 }], tokenOutpoints: [],
    tokenUtxos: [{ txid: T(3), vout: 0, sats: 546 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr,
  });
  checkSendLayout("SEND +headroom", ok, { self: p2trAddr, to: p2wpkhAddr, payload: '{"p":"lucky-20","op":"send","tick":"LUCKY","amt":"1"}' });
  assert.equal(ok.changeSats, 646, "change accounted exactly");
  assert.equal(ok.changeVout, 4);
}

// ---- SEND insufficient: a lone 546-sat carrier + 1,200 sats cannot pay 3 outputs + fee -------------------------
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
  assert.ok(prevS.vsize > 250 && prevS.vsize < 380, `send preview vsize plausible (2 inputs, 4 address outputs + OP_RETURN): ${prevS.vsize}`);
  assert.equal(prevS.feeSats, prevS.vsize * 8, "fee == rate × ceil(vsize): the node charges for whole vbytes");
  assert.equal(prevS.slotSats, 3 * 546, "protocol fee + recipient output + residual output");
}

// ---- SEND must refuse a carrier whose on-chain value is unknown, and the fee address as a recipient ----------------
assert.throws(
  () => buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(4), vout: 2, sats: 90_000 }], tokenOutpoints: [],
    tokenUtxos: [{ txid: T(3), vout: 0 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr,
  }),
  /no known BTC value/,
);
assert.throws(
  () => buildSendPsbt({
    address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints,
    tokenUtxos: [{ txid: T(3), vout: 0, sats: 20_000 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: PROJECT_FEE_ADDRESS,
  }),
  /the protocol fee address cannot receive a SEND/,
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

// ---- SEND recipients: any standard mainnet address (the sender stays bc1q / bc1p) -------------------
{
  const legacy = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
  const p2sh = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
  assert.equal(decodeRecipientAddress(legacy).type, "pkh");
  assert.equal(decodeRecipientAddress(p2sh).type, "sh");
  assert.equal(decodeRecipientAddress(p2trAddr).type, "tr");
  assert.equal(checkRecipientAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx").ok, false, "testnet is refused");
  assert.equal(checkRecipientAddress(p2trAddr, p2trAddr).isSelf, true, "sending to self is flagged");
  for (const to of [legacy, p2sh]) {
    const r = buildSendPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, tokenUtxos: [{ txid: T(3), vout: 0, sats: 20_000 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: to });
    const { outs } = parse(r.psbtHex);
    assert.equal(addrOf(outs[1].script), to, `SEND to ${to.slice(0, 1)}…: vout1 pays the recipient`);
    assert.doesNotThrow(() => expectPsbtPayload(r.psbtHex, { op: "SEND", layout: { self: p2trAddr, to } }));
  }
  assert.throws(() => buildSendPsbt({ address: legacy, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, tokenUtxos: [{ txid: T(3), vout: 0, sats: 20_000 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2trAddr }), /unsupported address type/, "the SENDER must still be bc1q / bc1p");
  console.log("psbt recipients: P2PKH / P2SH / P2WPKH / P2TR recipients accepted on vout1, sender unchanged, the fee address refused");
}

// ---- Speed up (RBF) of a DEPLOY: same inputs, outputs 0–2 unchanged, fee from vout3 ------------------------
{
  const r = buildDeployPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 2, ticker: "NEWTKN" });
  const before = parse(r.psbtHex);
  assert.equal(psbtFeeSats(r.psbtHex), r.feeSats, "psbtFeeSats reads the builder's fee");
  assert.equal(Math.ceil(psbtVsize(r.psbtHex)), r.estimatedVsize, "psbtVsize matches the builder's estimate");
  const q = buildSpeedUpPsbt({ psbtHex: r.psbtHex, changeVout: r.changeVout, feeRateSatVb: 10, incrementalRelayFee: 1 });
  const after = parse(q.psbtHex);
  assert.equal(q.oldFeeSats, r.feeSats);
  assert.equal(q.feeSats, Math.ceil(q.vsize * 10), "at 10 sat/vB the rate, not the minimum bump, decides");
  assert.equal(psbtFeeSats(q.psbtHex), q.feeSats);
  assert.equal(after.tx.lockTime, PROTOCOL_LOCKTIME);
  assert.deepEqual(after.ins.map((i) => `${hex.encode(i.txid)}:${i.index}:${i.sequence}`), before.ins.map((i) => `${hex.encode(i.txid)}:${i.index}:${i.sequence}`), "same inputs, same sequences");
  after.outs.forEach((o, i) => {
    assert.equal(hex.encode(o.script), hex.encode(before.outs[i].script), `output ${i}: same script`);
    if (i !== DEPLOY_CHANGE_VOUT) assert.equal(o.amount, before.outs[i].amount, `output ${i}: same amount`);
  });
  assert.equal(before.outs[3].amount - after.outs[3].amount, BigInt(q.feeSats - r.feeSats), "the extra fee comes out of vout3, the change");
  assert.deepEqual(expectPsbtPayload(q.psbtHex, { op: "DEPLOY", ticker: "NEWTKN", lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self: p2trAddr } }), { op: "DEPLOY", ticker: "NEWTKN" }, "the faster DEPLOY passes the same guard");
  // BIP125 rule 4: at a rate at or below the old one, the minimum bump (old fee + increment × vsize) applies.
  const low = buildSpeedUpPsbt({ psbtHex: r.psbtHex, changeVout: r.changeVout, feeRateSatVb: 1, incrementalRelayFee: 1 });
  assert.equal(low.feeSats, r.feeSats + Math.ceil(low.vsize * 1));
  assert.ok(low.feeRateSatVb > r.feeRateSatVb, "the replacement's rate is higher");
  assert.ok(speedUpFloorRate(r.psbtHex, 1) >= low.feeSats / low.vsize - 0.01);
  // No change output → no same-inputs replacement.
  assert.throws(() => buildSpeedUpPsbt({ psbtHex: r.psbtHex, changeVout: null, feeRateSatVb: 10 }), (e) => e.code === "speedup-no-change");
  assert.throws(() => buildSpeedUpPsbt({ psbtHex: r.psbtHex, changeVout: 2, feeRateSatVb: 10 }), (e) => e.code === "speedup-no-change", "the OP_RETURN is never the change");
  // Change too small to pay the bump and stay ≥ 546.
  assert.throws(() => buildSpeedUpPsbt({ psbtHex: r.psbtHex, changeVout: r.changeVout, feeRateSatVb: 900 }), (e) => e.code === "speedup-change-too-small");
  // MINE (change vout3) and SEND (change vout4) speed up the same way.
  const m = buildMinePsbt({ address: p2wpkhAddr, pubkeyHex: P2WPKH_PUB, utxos: [{ txid: T(4), vout: 2, sats: 90_000 }], tokenOutpoints, feeRateSatVb: 2, ticker: "LUCKY" });
  const mq = buildSpeedUpPsbt({ psbtHex: m.psbtHex, changeVout: m.changeVout, feeRateSatVb: 6, incrementalRelayFee: 0.1 });
  assert.ok(mq.feeSats > m.feeSats);
  assert.equal(m.changeVout, 3);
  const s = buildSendPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, tokenUtxos: [{ txid: T(3), vout: 0, sats: 20_000 }], feeRateSatVb: 2, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr });
  assert.equal(s.changeVout, 4);
  const sq = buildSpeedUpPsbt({ psbtHex: s.psbtHex, changeVout: s.changeVout, feeRateSatVb: 6, incrementalRelayFee: 0.1 });
  assert.doesNotThrow(() => expectPsbtPayload(sq.psbtHex, { op: "SEND", ticker: "LUCKY", amount: 1, lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self: p2trAddr, to: p2wpkhAddr } }));
  console.log("psbt speed up: a DEPLOY keeps its inputs, outputs 0–2, lock time and sequences; the fee comes from the change; BIP125 minimum bump");
}

// ---- Speed-up headroom (speedUpCeilingRate): largest-first leaves the change a Speed up needs --------------------
{
  const wallet = [{ txid: T(40), vout: 0, sats: 15_000 }, { txid: T(41), vout: 0, sats: 300_000 }];
  const args = { address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: wallet, tokenOutpoints: [], feeRateSatVb: 30, ticker: "NEWTKN" };
  const big = buildDeployPsbt({ ...args, selectionOrder: "largest" });
  assert.deepEqual(big.inputs.map((u) => u.sats), [300_000], "largest-first spends the 300,000-sat output");
  const bigCeiling = speedUpCeilingRate(big.psbtHex, big.changeVout);
  assert.ok(bigCeiling >= 90, `ceiling ${bigCeiling} ≥ 3 × 30 sat/vB`);
  assert.doesNotThrow(() => buildSpeedUpPsbt({ psbtHex: big.psbtHex, changeVout: big.changeVout, feeRateSatVb: 90 }), "a speed-up to 90 sat/vB fits in its change");
  const small = buildDeployPsbt({ ...args, selectionOrder: "smallest" });
  assert.deepEqual(small.inputs.map((u) => u.sats), [15_000], "smallest-first stops at the 15,000-sat output");
  const smallCeiling = speedUpCeilingRate(small.psbtHex, small.changeVout);
  assert.ok(smallCeiling > 30 && smallCeiling < 40, `ceiling ${smallCeiling} barely above the rate`);
  assert.throws(() => buildSpeedUpPsbt({ psbtHex: small.psbtHex, changeVout: small.changeVout, feeRateSatVb: 90 }), (e) => e.code === "speedup-change-too-small");
  // The ceiling is exact: a speed-up at it builds, one hundredth above does not.
  assert.doesNotThrow(() => buildSpeedUpPsbt({ psbtHex: small.psbtHex, changeVout: small.changeVout, feeRateSatVb: smallCeiling }));
  assert.throws(() => buildSpeedUpPsbt({ psbtHex: small.psbtHex, changeVout: small.changeVout, feeRateSatVb: smallCeiling + 0.02 }), (e) => e.code === "speedup-change-too-small");
  assert.equal(speedUpCeilingRate(small.psbtHex, null), 0, "no change → 0");
  assert.equal(speedUpCeilingRate(small.psbtHex, 2), 0, "the OP_RETURN is no change");
  assert.equal(speedUpCeilingRate(small.psbtHex, 9), 0, "no such output");
  console.log(`psbt speed-up headroom: largest-first ${bigCeiling} sat/vB, smallest-first ${smallCeiling} sat/vB for the same 30 sat/vB DEPLOY`);
}

// ---- fee-input floor on non-asset-safe UTXO lists: an inscription or rune could sit on a small output ----------------------------------------------
{
  assert.equal(MIN_FEE_INPUT_SATS_UNSAFE, 10_000);
  assert.equal(minFeeInputSats(true), 0, "asset-safe list: no floor");
  assert.equal(minFeeInputSats(false), 10_000);
  assert.equal(minFeeInputSats("inscriptions-only"), 10_000, "inscriptions-only still cannot see runes");
  assert.equal(minFeeInputSats(null), 10_000);
  // filterSpendable: the §4 rules always apply; the floor drops the 3,000-sat output too
  assert.deepEqual(filterSpendable(utxos, tokenOutpoints).map((u) => u.sats), [3_000, 90_000]);
  assert.deepEqual(filterSpendable(utxos, tokenOutpoints, { minSats: 10_000 }).map((u) => u.sats), [90_000]);
  // ord's default postage IS 10,000 sats — an output of exactly the floor is excluded.
  assert.deepEqual(filterSpendable([{ txid: T(7), vout: 0, sats: 10_000 }], [], { minSats: 10_000 }).map((u) => u.sats), [], "exactly the floor is excluded");
  assert.deepEqual(filterSpendable([{ txid: T(7), vout: 0, sats: 10_001 }], [], { minSats: 10_000 }).map((u) => u.sats), [10_001], "one sat above qualifies");
  // …and on a list that is not asset-safe the builder selects largest-first,
  // so a postage-sized output above the floor is the last resort, not the first pick.
  assert.equal(selectionOrderFor(true), "smallest");
  assert.equal(selectionOrderFor(false), "largest");
  assert.equal(selectionOrderFor("inscriptions-only"), "largest");
  {
    const two = [{ txid: T(8), vout: 0, sats: 200_000 }, { txid: T(9), vout: 0, sats: 10_000 }];
    const m = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: two, tokenOutpoints: [], feeRateSatVb: 5, ticker: "LUCKY", minInputSats: minFeeInputSats(false) });
    assert.deepEqual(m.inputs.map((u) => u.sats), [200_000], "MINE on an unsafe list never touches the 10,000-sat output");
    const d = buildDeployPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: two, tokenOutpoints: [], feeRateSatVb: 5, ticker: "NEWTKN", minInputSats: minFeeInputSats(false) });
    assert.deepEqual(d.inputs.map((u) => u.sats), [200_000], "DEPLOY likewise");
    const three = [{ txid: T(8), vout: 0, sats: 500_000 }, { txid: T(9), vout: 0, sats: 10_500 }, { txid: T(10), vout: 0, sats: 12_000 }];
    const l = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: three, tokenOutpoints: [], feeRateSatVb: 5, ticker: "LUCKY", minInputSats: minFeeInputSats(false) });
    assert.deepEqual(l.inputs.map((u) => u.sats), [500_000], "largest-first: one input, the postage-sized ones stay untouched");
    const safe = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: three, tokenOutpoints: [], feeRateSatVb: 5, ticker: "LUCKY", minInputSats: minFeeInputSats(true) });
    assert.deepEqual(safe.inputs.map((u) => u.sats), [10_500], "an asset-safe list still consolidates smallest-first");
  }
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
    checkSendLayout("SEND floored", s, { self: p2trAddr, to: p2wpkhAddr, payload: '{"p":"lucky-20","op":"send","tick":"LUCKY","amt":"100"}' });
    assert.throws(
      () => buildSendPsbt({
        address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [{ txid: T(2), vout: 1, sats: 3_000 }], tokenOutpoints: [],
        tokenUtxos: [{ txid: T(3), vout: 0, sats: 546 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr, minInputSats: MIN_FEE_INPUT_SATS_UNSAFE,
      }),
      /no asset-safe UTXO list/,
    );
  }
  console.log("psbt floor: non-asset-safe lists never spend outputs of 10,000 sats or less, and select largest-first");
}

// ---- an output worth no more than its own input fee is never selected ------------------------
{
  // 20 sat/vB: a P2TR input costs ceil(57.5 × 20) = 1,150 sats, more than an 800-sat output is worth.
  assert.equal(inputCostSats("tr", 20), 1_150);
  assert.equal(inputCostSats("wpkh", 20), 1_360);
  const dust = Array.from({ length: 60 }, (_, i) => ({ txid: T(20 + i), vout: 0, sats: 800 }));
  const big = { txid: T(90), vout: 0, sats: 2_000_000 };
  const r = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [...dust, big], tokenOutpoints: [], feeRateSatVb: 20, ticker: "LUCKY" });
  assert.deepEqual(r.inputs.map((u) => u.sats), [2_000_000], "sixty uneconomic 800-sat outputs are skipped, not consolidated at a loss");
  // At 5 sat/vB (288 sats per input) an 800-sat output is economic again and smallest-first may use it.
  const low = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: [...dust.slice(0, 4), big], tokenOutpoints: [], feeRateSatVb: 5, ticker: "LUCKY" });
  assert.equal(low.inputs.filter((u) => u.sats === 800).length, 4, "economic small outputs still consolidate on an asset-safe list");
  // selectInputs directly: order + floor
  const rows = [{ txid: T(1), vout: 0, sats: 700 }, { txid: T(2), vout: 0, sats: 5_000 }, { txid: T(3), vout: 0, sats: 50_000 }];
  assert.deepEqual(selectInputs({ utxos: rows, target: 4_000, excludeKeys: [] }).selected.map((u) => u.sats), [700, 5_000]);
  assert.deepEqual(selectInputs({ utxos: rows, target: 4_000, excludeKeys: [], minEffectiveSats: 1_000 }).selected.map((u) => u.sats), [5_000]);
  assert.deepEqual(selectInputs({ utxos: rows, target: 4_000, excludeKeys: [], order: "largest" }).selected.map((u) => u.sats), [50_000]);
  console.log("psbt selection: uneconomic outputs skipped; largest-first available");
}

// ---- sign-time guard: payload, lock time, sequences ---------------------------------------------------------------
{
  const mine = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  assert.deepEqual(expectPsbtPayload(mine.psbtHex, { op: "MINE", ticker: "LUCKY", lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self: p2trAddr } }), { op: "MINE", ticker: "LUCKY" });
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: "SEND" }), /OP_RETURN is MINE, expected SEND/);
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: "MINE", ticker: "ORE" }), /names ticker LUCKY, expected ORE/, "another ticker");
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: null }), /plain payment must not carry an OP_RETURN/);
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: "MINE", lockTime: 0 }), /nLockTime is 969599, expected 0/);
  const oneFinal = variant(mine.psbtHex, { sequence: (i, s) => (i === 1 ? 0xffffffff : s) });
  assert.throws(() => expectPsbtPayload(oneFinal, { op: "MINE", inputsSequence: RBF_SEQUENCE }), /input 1 has nSequence 0xffffffff, expected 0xfffffffd/, "one input without RBF");
  // A `|`-separated push is not a payload: the guard refuses it, psbtPayload reads nothing.
  const pipe = variant(mine.psbtHex, { outs: (o) => o.map((x, i) => (i === 2 ? { script: makeOpReturnScript(new TextEncoder().encode("LUCKY-20|MINE|LUCKY")), amount: 0n } : x)) });
  assert.throws(() => expectPsbtPayload(pipe, { op: "MINE", ticker: "LUCKY" }), /does not parse as a LUCKY-20 payload/);
  assert.equal(psbtPayload(pipe), null, "psbtPayload of a pipe payload is null");
  assert.equal(psbtPayload("zz"), null, "psbtPayload never throws");
  // A tx with no OP_RETURN at all: fine only when a plain payment is expected.
  const none = { opReturnCount: 0, payload: null };
  assert.equal(checkExpectedPayload(none, { op: null }), null, "a plain payment has no OP_RETURN");
  assert.throws(() => checkExpectedPayload(none, { op: "MINE" }), /no OP_RETURN output — expected a MINE payload/);
  console.log("psbt guard: op / ticker / amount / lock time / every input's sequence checked before signing; a pipe push is refused");
}

// ---- sign-time guard: the output layout -------------------------------------------------------------------
{
  const feeScript = scriptOf(PROJECT_FEE_ADDRESS);
  const setOut = (psbtHex, i, o) => variant(psbtHex, { outs: (list) => list.map((x, k) => (k === i ? { ...x, ...o } : x)) });
  const swap = (psbtHex, a, b) => variant(psbtHex, { outs: (list) => list.map((x, k) => (k === a ? list[b] : k === b ? list[a] : x)) });

  // SEND
  const send = buildSendPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, tokenUtxos: [{ txid: T(3), vout: 0, sats: 20_000 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 5, toAddress: p2wpkhAddr });
  const sendWant = { op: "SEND", ticker: "LUCKY", amount: 5, layout: { self: p2trAddr, to: p2wpkhAddr } };
  assert.doesNotThrow(() => expectPsbtPayload(send.psbtHex, sendWant));
  assert.throws(() => expectPsbtPayload(swap(send.psbtHex, 0, 1), sendWant), /output 0 is not exactly 546 sats to the protocol fee address/, "the fee not at vout0");
  assert.throws(() => expectPsbtPayload(send.psbtHex, { ...sendWant, layout: { self: p2trAddr, to: OTHER } }), /output 1 is not 546 sats to the recipient/, "vout1 not the intended recipient");
  assert.throws(() => expectPsbtPayload(setOut(send.psbtHex, 1, { script: feeScript }), sendWant), /output 1 is not 546 sats to the recipient/, "vout1 pays the fee address");
  assert.throws(() => expectPsbtPayload(send.psbtHex, { ...sendWant, layout: { self: p2trAddr, to: PROJECT_FEE_ADDRESS } }), /a SEND needs its recipient, and the protocol fee address cannot be one/);
  assert.throws(() => expectPsbtPayload(send.psbtHex, { ...sendWant, layout: { self: p2trAddr } }), /a SEND needs its recipient/, "a SEND guard without `to`");
  assert.throws(() => expectPsbtPayload(setOut(send.psbtHex, 2, { script: scriptOf(OTHER) }), sendWant), /output 2 is not 546 sats back to this wallet \(the residual output\)/, "vout2 not self");
  assert.throws(() => expectPsbtPayload(setOut(send.psbtHex, 2, { amount: 600n }), sendWant), /output 2 is not 546 sats back to this wallet/, "vout2 not 546");
  assert.throws(() => expectPsbtPayload(variant(send.psbtHex, { outs: (l) => [l[0], l[1], l[3], l[4]] }), sendWant), /output 2 is not 546 sats back to this wallet/, "vout2 dropped");
  assert.throws(() => expectPsbtPayload(setOut(send.psbtHex, 4, { script: scriptOf(OTHER) }), sendWant), /output 4 is not BTC change of at least 546 sats back to this wallet/, "change to someone else");
  assert.throws(() => expectPsbtPayload(variant(send.psbtHex, { outs: (l) => [...l, { script: scriptOf(p2trAddr), amount: 600n }] }), sendWant), /output 5 is not part of the SEND layout/, "an extra output");
  assert.throws(() => expectPsbtPayload(send.psbtHex, { ...sendWant, layout: { self: "nonsense", to: p2wpkhAddr } }), /needs this wallet's own address/);

  // DEPLOY
  const dep = buildDeployPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "NEWTKN" });
  const depWant = { op: "DEPLOY", ticker: "NEWTKN", layout: { self: p2trAddr } };
  assert.doesNotThrow(() => expectPsbtPayload(dep.psbtHex, depWant));
  assert.throws(() => expectPsbtPayload(setOut(dep.psbtHex, 1, { amount: 5_461n }), depWant), /output 1 is not exactly 5,460 sats to the protocol fee address/, "DEPLOY fee 5,461");
  assert.throws(() => expectPsbtPayload(setOut(dep.psbtHex, 1, { script: scriptOf(OTHER) }), depWant), /output 1 is not exactly 5,460 sats/, "DEPLOY fee to another address");
  assert.throws(() => expectPsbtPayload(setOut(dep.psbtHex, 0, { script: scriptOf(OTHER) }), depWant), /output 0 is not 546 sats back to this wallet/, "DEPLOY proof to someone else");
  assert.throws(() => expectPsbtPayload(dep.psbtHex, { ...depWant, op: "DEPLOY", layout: { self: p2wpkhAddr } }), /output 0 is not 546 sats back to this wallet/);

  // MINE
  const mine = buildMinePsbt({ address: p2wpkhAddr, pubkeyHex: P2WPKH_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  assert.doesNotThrow(() => expectPsbtPayload(mine.psbtHex, { op: "MINE", layout: { self: p2wpkhAddr } }));
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: "MINE", layout: { self: p2trAddr } }), /output 0 is not 546 sats back to this wallet/, "a MINE whose vout0 is not self");
  assert.throws(() => expectPsbtPayload(setOut(mine.psbtHex, 1, { amount: 545n }), { op: "MINE", layout: { self: p2wpkhAddr } }), /output 1 is not exactly 546 sats to the protocol fee address/);
  assert.throws(() => expectPsbtPayload(swap(mine.psbtHex, 2, 3), { op: "MINE", layout: { self: p2wpkhAddr } }), /output 2 is not the OP_RETURN payload/);
  console.log("psbt layout guard: SEND fee/recipient/residual/change, DEPLOY exact 5,460 fee and proof, MINE yield output — each misplaced output refused");
}

// ---- §8: an avatar push is an ignored OP_RETURN (never the payload, never hides one) --------
{
  const push = (s) => makeOpReturnScript(new TextEncoder().encode(s));
  const avatar = '{"p":"lucky-20","op":"avatar","tick":"LUCKY"}';
  const both = protocolPayloadOfScripts([push(avatar), push('{"p":"lucky-20","op":"mine","tick":"LUCKY"}')]);
  assert.deepEqual(both.payload, { op: "MINE", ticker: "LUCKY" }, "a later parseable push is still the payload");
  assert.equal(both.payloadVout, 1);
  assert.equal(both.opReturnCount, 2);
  assert.equal(both.payloadText, '{"p":"lucky-20","op":"mine","tick":"LUCKY"}');
  const alone = protocolPayloadOfScripts([push(avatar)]);
  assert.equal(alone.payload, null, "an avatar op alone: a plain BTC spend (default routing), nothing recorded");
  assert.throws(() => checkExpectedPayload(alone, { op: "DEPLOY" }), /does not parse as a LUCKY-20 payload/, "the sign-time guard refuses it");
  // PUSHDATA1 carries a payload too (the rule accepts every push form).
  const pd1 = new Uint8Array([0x6a, 0x4c, 43, ...new TextEncoder().encode('{"p":"lucky-20","op":"mine","tick":"LUCKY"}')]);
  assert.deepEqual(protocolPayloadOfScripts([pd1]).payload, { op: "MINE", ticker: "LUCKY" });
  console.log("psbt §8: an avatar push never becomes or hides the payload");
}

console.log("psbt build: all structural checks passed");
