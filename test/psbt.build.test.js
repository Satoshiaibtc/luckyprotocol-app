// Structural test for src/lib/psbt.js — runs in plain Node, no framework.
// Builds MINE + SEND PSBTs for a P2TR and a P2WPKH wallet, parses them back
// with btc-signer, and asserts the spec §2/§4/§6 layout rules:
//   * dust (≤546) and token-bearing outpoints are never selected as inputs
//   * vout0 546 → self/recipient, vout1 546 → PROJECT_FEE_ADDRESS, vout2 OP_RETURN
//   * MINE folds sub-dust change into the fee
//   * SEND (§2.3): every token carrier is exactly 546 sats — vout0 recipient
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
  buildCommitPsbt,
  buildRevealPsbt,
  buildSpeedUpPsbt,
  carrierScriptHex,
  checkRecipientAddress,
  decodeRecipientAddress,
  estimateMineFeeSats,
  estimateCommitFeeSats,
  estimateRevealFeeSats,
  estimateSendFeeSats,
  psbtFeeSats,
  psbtVsize,
  speedUpFloorRate,
  COMMIT_CARRIER_VOUT,
  COMMIT_CHANGE_VOUT,
  REVEAL_CHANGE_VOUT,
  REVEAL_CARRIER_SEQUENCE,
  RBF_SEQUENCE,
  SEND_TO_OUT,
  SEND_CHANGE_OUT,
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
import { PROJECT_FEE_ADDRESS, PROTOCOL_LOCKTIME, commitHashFor, payloadToString } from "../src/lib/payloads.js";

const SALT = "0123456789abcdef0123456789abcdef";
// H binds the carrier script (§2.1): the same ticker + salt gives another H for another address.
const hashFor = (address) => commitHashFor("NEWTKN", SALT, carrierScriptHex(address));
const CARRIER = { txid: "cd".repeat(32), vout: 0, sats: 546 };

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
      buildCommitPsbt({ ...args, ticker: "NEWTKN", salt: SALT }),
      buildRevealPsbt({ ...args, ticker: "NEWTKN", salt: SALT, carrier: CARRIER }),
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

// Rounding: a single-input P2WPKH MINE estimates 213.5 vB (→ 214 on
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

// ---- SEND layout (§2.3) -------------------------------------------------------------------------
//   vout0 546 → recipient · vout1 546 → fee · vout2 OP_RETURN |0|3 · vout3 546 → self (residual
//   slot, always) · vout4 BTC change → self (only when ≥ 546)
assert.equal(SEND_TO_OUT, 0);
assert.equal(SEND_CHANGE_OUT, 3);
assert.equal(SEND_BTC_CHANGE_VOUT, 4);

/** Assert the fixed part of the §2.3 SEND layout; returns the parsed tx parts. */
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

// ---- COMMIT (§2.1, step 1): vout0 546 → self (carrier), vout1 OP_RETURN COMMIT|H (80 bytes), vout2 change ----
{
  const prevC = estimateCommitFeeSats({ address: p2trAddr, feeRateSatVb: 8 });
  assert.ok(prevC.vsize > 150 && prevC.vsize < 260, `commit preview vsize plausible: ${prevC.vsize}`);
  for (const [label, address, pubkeyHex, expectTap] of [["p2tr", p2trAddr, P2TR_PUB, true], ["p2wpkh", p2wpkhAddr, P2WPKH_PUB, false]]) {
    const r = buildCommitPsbt({ address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "NEWTKN", salt: SALT });
    const { tx, ins, outs } = parse(r.psbtHex);
    const HASH = hashFor(address);
    // The builder computes H from the payload and the script of the carrier it builds.
    assert.equal(r.carrierScript, hex.encode(decodeAddress(address).script), `COMMIT ${label}: carrier script = the address's own script`);
    assert.equal(r.carrierScript, hex.encode(outs[COMMIT_CARRIER_VOUT].script), `COMMIT ${label}: … and it is vout0's script`);
    assert.equal(r.hash, HASH, `COMMIT ${label}: H = SHA-256(payload ‖ carrier script)`);
    assert.equal(r.hash, commitHashFor("NEWTKN", SALT, outs[0].script), "the same H from the built output's bytes");
    assert.notEqual(r.hash, hashFor(address === p2trAddr ? p2wpkhAddr : p2trAddr), `COMMIT ${label}: another address gives another H`);
    assert.equal(outs.length, 3, `COMMIT ${label}: 3 outputs`);
    assert.equal(r.changeVout, COMMIT_CHANGE_VOUT);
    for (const inp of ins) {
      assert.ok(inp.witnessUtxo.amount > 546n, `COMMIT ${label}: dust input selected`);
      assert.notEqual(hex.encode(inp.txid), T(3), `COMMIT ${label}: token outpoint selected`);
      assert.equal(inp.sequence, RBF_SEQUENCE, `COMMIT ${label}: input signals RBF`);
      if (expectTap) assert.equal(hex.encode(inp.tapInternalKey), XONLY);
      else assert.equal(inp.tapInternalKey, undefined);
    }
    assert.equal(tx.lockTime, PROTOCOL_LOCKTIME, `COMMIT ${label}: nLockTime 969,599`);
    assert.equal(addrOf(outs[COMMIT_CARRIER_VOUT].script), address, `COMMIT ${label}: vout0 carrier → committer`);
    assert.equal(outs[0].amount, 546n);
    assert.equal(outs[1].script[0], 0x6a);
    assert.equal(outs[1].script[1], 0x4c, "an 80-byte push uses PUSHDATA1");
    assert.equal(payloadToString(outs[1].script.slice(3)), `LUCKY-20|COMMIT|${HASH}`);
    assert.equal(addrOf(outs[2].script), address, `COMMIT ${label}: change → self`);
    const inSum = ins.reduce((a, i) => a + i.witnessUtxo.amount, 0n);
    assert.equal(inSum - outs.reduce((a, o) => a + o.amount, 0n), BigInt(r.feeSats), `COMMIT ${label}: fee == inputs − outputs`);
    assert.deepEqual(expectPsbtPayload(r.psbtHex, { op: "COMMIT", hash: HASH, vout0Script: r.carrierScript, lockTime: PROTOCOL_LOCKTIME }), { op: "COMMIT", hash: HASH });
    assert.throws(() => expectPsbtPayload(r.psbtHex, { op: "COMMIT", hash: "0".repeat(64) }), /COMMIT hash/);
    assert.throws(() => expectPsbtPayload(r.psbtHex, { op: "COMMIT", hash: HASH, vout0Script: "0014" + "bb".repeat(20) }), /first output is not the reservation output/);
    assert.throws(() => expectPsbtPayload(r.psbtHex, { op: "COMMIT", lockTime: 0 }), /nLockTime is 969599, expected 0/);
  }
  assert.throws(() => buildCommitPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "NEWTKN", salt: "xyz" }), /32 lowercase hex/);
  assert.throws(() => buildCommitPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "newtkn", salt: SALT }), /A-Z 0-9/);
  console.log("psbt COMMIT: carrier at vout0, 80-byte COMMIT|H at vout1 with H bound to vout0's script, nLockTime 969,599, RBF inputs");
}

// ---- REVEAL (§2.1, step 2): input 0 = the carrier; vout0 546 proof, vout1 5,460 fee, vout2 DEPLOY|T|SALT, vout3 change ----
{
  const prevR = estimateRevealFeeSats({ address: p2trAddr, ticker: "NEWTKN", feeRateSatVb: 8 });
  assert.ok(prevR.vsize > 200 && prevR.vsize < 330, `reveal preview vsize plausible: ${prevR.vsize}`);
  for (const [label, address, pubkeyHex] of [["p2tr", p2trAddr, P2TR_PUB], ["p2wpkh", p2wpkhAddr, P2WPKH_PUB]]) {
    const r = buildRevealPsbt({ address, pubkeyHex, utxos: [...utxos, CARRIER], tokenOutpoints, feeRateSatVb: 8, ticker: "NEWTKN", salt: SALT, carrier: CARRIER });
    const { tx, ins, outs } = parse(r.psbtHex);
    assert.equal(hex.encode(ins[0].txid), CARRIER.txid, `REVEAL ${label}: input 0 is the COMMIT carrier`);
    assert.equal(ins[0].index, 0);
    assert.equal(ins[0].witnessUtxo.amount, 546n, "the carrier is spent at its exact value");
    assert.equal(ins.filter((i) => hex.encode(i.txid) === CARRIER.txid).length, 1, "the carrier is spent once (never also as a fee input)");
    for (const inp of ins.slice(1)) assert.ok(inp.witnessUtxo.amount > 546n && hex.encode(inp.txid) !== T(3), `REVEAL ${label}: fee inputs are plain BTC`);
    // input 0: a BIP68 relative lock of one block (version 2), so the REVEAL can never share its COMMIT's block
    assert.equal(REVEAL_CARRIER_SEQUENCE, 1);
    assert.equal(ins[0].sequence, REVEAL_CARRIER_SEQUENCE, `REVEAL ${label}: the carrier input has nSequence 1`);
    assert.equal(tx.version, 2, "BIP68 needs a version-2 transaction");
    for (const inp of ins.slice(1)) assert.equal(inp.sequence, RBF_SEQUENCE);
    assert.equal(tx.lockTime, PROTOCOL_LOCKTIME);
    assert.equal(outs.length, 4);
    assert.equal(addrOf(outs[0].script), address, `REVEAL ${label}: vout0 proof → deployer`);
    assert.equal(outs[0].amount, 546n);
    assert.equal(addrOf(outs[1].script), PROJECT_FEE_ADDRESS);
    assert.equal(outs[1].amount, 5_460n, "exact 5,460-sat protocol fee");
    assert.equal(payloadToString(outs[2].script.slice(2)), `LUCKY-20|DEPLOY|NEWTKN|${SALT}`);
    assert.equal(r.changeVout, REVEAL_CHANGE_VOUT);
    assert.equal(addrOf(outs[3].script), address);
    assert.equal(ins.reduce((a, i) => a + i.witnessUtxo.amount, 0n) - outs.reduce((a, o) => a + o.amount, 0n), BigInt(r.feeSats));
    assert.equal(expectPsbtPayload(r.psbtHex, { op: "DEPLOY", ticker: "NEWTKN", salt: SALT, input0: CARRIER, input0Sequence: REVEAL_CARRIER_SEQUENCE, lockTime: PROTOCOL_LOCKTIME }).salt, SALT);
    assert.throws(() => expectPsbtPayload(r.psbtHex, { op: "DEPLOY", input0Sequence: RBF_SEQUENCE }), /input 0 has nSequence 0x00000001, expected 0xfffffffd/);
    assert.throws(() => expectPsbtPayload(r.psbtHex, { op: "DEPLOY", salt: "f".repeat(32) }), /salt/);
    assert.throws(() => expectPsbtPayload(r.psbtHex, { op: "DEPLOY", input0: { txid: T(4), vout: 2 } }), /input 0 is/);
  }
  assert.throws(() => buildRevealPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "NEWTKN", salt: SALT, carrier: { ...CARRIER, vout: 1 } }), /vout 0/);
  assert.throws(() => buildRevealPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "lucky", salt: SALT, carrier: CARRIER }), /A-Z 0-9/);
  assert.throws(() => buildRevealPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "NEWTKN", salt: "00", carrier: CARRIER }), /32 lowercase hex/);
  console.log("psbt REVEAL: carrier as input 0 (nSequence 1: never in its COMMIT's block), proof / 5,460 fee / DEPLOY|T|SALT / change, nLockTime 969,599");
}

// ---- nLockTime + RBF on MINE and SEND too ---------------------------------------------
{
  const m = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  const sd = buildSendPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, tokenUtxos: [{ txid: T(3), vout: 0, sats: 20_000 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2wpkhAddr });
  for (const [label, r] of [["MINE", m], ["SEND", sd]]) {
    const { tx, ins } = parse(r.psbtHex);
    assert.equal(tx.lockTime, PROTOCOL_LOCKTIME, `${label}: nLockTime 969,599 — it cannot confirm before block 969,600`);
    for (const inp of ins) assert.equal(inp.sequence, 0xfffffffd, `${label}: sequence enables the lock time and signals RBF`);
  }
  console.log("psbt locktime: MINE and SEND carry nLockTime 969,599 with RBF sequences");
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
    assert.equal(addrOf(outs[0].script), to, `SEND to ${to.slice(0, 1)}…: vout0 pays the recipient`);
  }
  assert.throws(() => buildSendPsbt({ address: legacy, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, tokenUtxos: [{ txid: T(3), vout: 0, sats: 20_000 }], feeRateSatVb: 8, ticker: "LUCKY", amount: 1, toAddress: p2trAddr }), /unsupported address type/, "the SENDER must still be bc1q / bc1p");
  console.log("psbt recipients: P2PKH / P2SH / P2WPKH / P2TR recipients accepted, sender unchanged");
}

// ---- Speed up (RBF): same inputs, same outputs except the change, higher fee ------------------------
{
  const r = buildRevealPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 2, ticker: "NEWTKN", salt: SALT, carrier: CARRIER });
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
  assert.equal(after.ins[0].sequence, REVEAL_CARRIER_SEQUENCE, "a faster REVEAL keeps the carrier's relative lock");
  assert.equal(expectPsbtPayload(q.psbtHex, { op: "DEPLOY", salt: SALT, input0Sequence: REVEAL_CARRIER_SEQUENCE }).salt, SALT);
  after.outs.forEach((o, i) => {
    assert.equal(hex.encode(o.script), hex.encode(before.outs[i].script), `output ${i}: same script`);
    if (i !== r.changeVout) assert.equal(o.amount, before.outs[i].amount, `output ${i}: same amount`);
  });
  assert.equal(before.outs[r.changeVout].amount - after.outs[r.changeVout].amount, BigInt(q.feeSats - r.feeSats), "the extra fee comes out of the change");
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
  // A COMMIT speeds up the same way.
  const c = buildCommitPsbt({ address: p2wpkhAddr, pubkeyHex: P2WPKH_PUB, utxos, tokenOutpoints, feeRateSatVb: 2, ticker: "NEWTKN", salt: SALT });
  const cq = buildSpeedUpPsbt({ psbtHex: c.psbtHex, changeVout: c.changeVout, feeRateSatVb: 6, incrementalRelayFee: 0.1 });
  assert.ok(cq.feeSats > c.feeSats);
  assert.deepEqual(expectPsbtPayload(cq.psbtHex, { op: "COMMIT", hash: c.hash, vout0Script: c.carrierScript, lockTime: PROTOCOL_LOCKTIME }), { op: "COMMIT", hash: c.hash });
  console.log("psbt speed up: same inputs / outputs / lock time, fee from the change, BIP125 minimum bump");
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
    const d = buildCommitPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos: two, tokenOutpoints: [], feeRateSatVb: 5, ticker: "NEWTKN", salt: SALT, minInputSats: minFeeInputSats(false) });
    assert.deepEqual(d.inputs.map((u) => u.sats), [200_000], "COMMIT likewise");
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
    checkSendLayout("SEND floored", s, { self: p2trAddr, to: p2wpkhAddr, payload: "LUCKY-20|SEND|LUCKY|100|0|3" });
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

// ---- sign-time payload guard ---------------------------------------------------------------
{
  const mine = buildMinePsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  assert.deepEqual(expectPsbtPayload(mine.psbtHex, { op: "MINE", ticker: "LUCKY" }), { op: "MINE", ticker: "LUCKY" });
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: "SEND" }), /OP_RETURN is MINE, expected SEND/);
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: "MINE", ticker: "ORE" }), /names ticker LUCKY, expected ORE/);
  assert.throws(() => expectPsbtPayload(mine.psbtHex, { op: null }), /plain payment must not carry an OP_RETURN/);
  const dep = buildRevealPsbt({ address: p2trAddr, pubkeyHex: P2TR_PUB, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "NEWTKN", salt: SALT, carrier: CARRIER });
  assert.equal(expectPsbtPayload(dep.psbtHex, { op: "DEPLOY", ticker: "NEWTKN" }).op, "DEPLOY");
  assert.throws(() => expectPsbtPayload(dep.psbtHex, { op: "MINE", ticker: "NEWTKN" }), /expected MINE/);
  // A tx with no OP_RETURN at all: fine only when a plain payment is expected.
  const none = { opReturnCount: 0, payload: null };
  assert.equal(checkExpectedPayload(none, { op: null }), null, "a plain payment has no OP_RETURN");
  assert.throws(() => checkExpectedPayload(none, { op: "MINE" }), /no OP_RETURN output — expected a MINE payload/);
  console.log("psbt guard: expectPsbtPayload asserts op / ticker / amount before signing");
}

// ---- §8: the withdrawn AVATAR push is an ignored OP_RETURN (never the payload, never hides one) --------
{
  const push = (s) => makeOpReturnScript(new TextEncoder().encode(s));
  const both = protocolPayloadOfScripts([push("LUCKY-20|AVATAR|LUCKY"), push("LUCKY-20|MINE|LUCKY")]);
  assert.deepEqual(both.payload, { op: "MINE", ticker: "LUCKY" }, "a later parseable push is still the payload");
  assert.equal(both.payloadVout, 1);
  assert.equal(both.opReturnCount, 2);
  const alone = protocolPayloadOfScripts([push("LUCKY-20|AVATAR|LUCKY")]);
  assert.equal(alone.payload, null, "AVATAR alone: a plain BTC spend (default routing), nothing recorded");
  assert.throws(() => checkExpectedPayload(alone, { op: "DEPLOY" }), /does not parse as a LUCKY-20 payload/, "the sign-time guard refuses it");
  console.log("psbt §8: a withdrawn AVATAR push never becomes or hides the payload");
}

console.log("psbt build: all structural checks passed");
