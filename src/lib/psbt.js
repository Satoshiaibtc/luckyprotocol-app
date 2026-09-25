// Unsigned PSBT construction for HashMint MINE / SEND (spec §4 + §6).
//
// The web app holds no keys. This module selects BTC inputs, lays out the
// protocol outputs in the exact order the indexer expects, and returns an
// UNSIGNED PSBT (hex) that the UniSat extension signs + finalizes.
//
// MINE layout (§2.2):   vout0 546 → self (yield slot)
//                       vout1 546 → PROJECT_FEE_ADDRESS
//                       vout2 OP_RETURN  HASHMINT|MINE|<TICKER>
//                       vout3 change → self (omitted if < dust; folded into fee)
//
// SEND layout (§2.3):   vout0 546 → recipient
//                       vout1 546 → PROJECT_FEE_ADDRESS
//                       vout2 OP_RETURN  HASHMINT|SEND|<TICKER>|<AMT>|0|3
//                       vout3 change → self  (MUST exist — throws otherwise)
//
// Builder obligation (§4): never spend a token-bearing UTXO as a fee input.
// Every UTXO with value ≤ 546 sats is dropped (all HashMint carriers are
// 546-sat outputs), and every outpoint the indexer reports as token-bearing
// is excluded explicitly.
//
// Mainnet only.

import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
  DUST_SATS,
  PROJECT_FEE_ADDRESS,
  MINE_PROTOCOL_FEE_SATS,
  SEND_PROTOCOL_FEE_SATS,
  buildMinePayload,
  buildSendPayload,
} from "./payloads.js";

const NETWORK = btc.NETWORK; // mainnet

/**
 * Hard safety cap on the fee rate a builder will accept. The rate comes from
 * the indexer's /fees (bitcoind estimatesmartfee); a buggy or compromised
 * response of, say, 10⁶ sat/vB would otherwise turn a MINE into a wallet-
 * draining miner fee. Mainnet has never sustained anything near this; if a
 * real spike ever exceeds it, the user should wait — never auto-clamp to a
 * number that still overpays.
 */
export const MAX_FEE_RATE_SAT_VB = 1_000;

function checkedFeeRate(feeRateSatVb) {
  let satVb = Number(feeRateSatVb);
  if (!Number.isFinite(satVb) || satVb <= 0) satVb = 1;
  satVb = Math.max(1, satVb);
  if (satVb > MAX_FEE_RATE_SAT_VB) {
    throw new Error(
      `fee rate ${satVb} sat/vB exceeds the ${MAX_FEE_RATE_SAT_VB} sat/vB safety cap — ` +
      `the fee estimate looks wrong; wait for it to normalize and retry`,
    );
  }
  return satVb;
}

// ---- vsize model (BIP141 weights / 4) --------------------------------------------
//
// version(4) + locktime(4) + in-count(1) + out-count(1) = 10 vB, plus the
// segwit marker+flag (2 bytes at witness weight) = 0.5 vB.
export const VSIZE_TX_OVERHEAD = 10.5;
export const VSIZE_P2TR_INPUT = 57.5;    // key-path spend, 64-byte schnorr sig
export const VSIZE_P2WPKH_INPUT = 68;    // ~72-byte DER sig + 33-byte pubkey
export const VSIZE_P2WPKH_OUTPUT = 31;   // 8 value + 1 len + 22 script
export const VSIZE_P2TR_OUTPUT = 43;     // 8 value + 1 len + 34 script
const VSIZE_OPRETURN_BASE = 9;           // 8 value + 1 script-len; + script bytes

// ---- address helpers ---------------------------------------------------------------

/**
 * Decode a mainnet address into { type, script }. Only Native SegWit
 * (bc1q, P2WPKH) and Taproot (bc1p, P2TR) are supported — the two address
 * types the spec's wallet contract covers, and the two for which a
 * witnessUtxo-only PSBT input is sufficient.
 */
export function decodeAddress(address) {
  let decoded;
  try {
    decoded = btc.Address(NETWORK).decode(address);
  } catch (e) {
    throw new Error(`invalid mainnet address "${address}": ${e.message || e}`);
  }
  if (decoded.type !== "wpkh" && decoded.type !== "tr") {
    throw new Error(
      `unsupported address type "${decoded.type}" — HashMint supports Native SegWit (bc1q) ` +
      `and Taproot (bc1p) only; switch the address type in UniSat`,
    );
  }
  return { type: decoded.type, script: btc.OutScript.encode(decoded) };
}

export function isP2tr(address) {
  return typeof address === "string" && address.startsWith("bc1p");
}

function outputVsize(address) {
  return isP2tr(address) ? VSIZE_P2TR_OUTPUT : VSIZE_P2WPKH_OUTPUT;
}

function inputVsize(type) {
  return type === "tr" ? VSIZE_P2TR_INPUT : VSIZE_P2WPKH_INPUT;
}

/**
 * x-only (32-byte) form of UniSat's 33-byte compressed public key: drop the
 * 02/03 parity prefix. Required as `tapInternalKey` on every P2TR input so
 * the signer can derive the tweak.
 */
export function xOnlyFromCompressedHex(pubkeyHex) {
  if (typeof pubkeyHex !== "string" || !/^[0-9a-f]{66}$/i.test(pubkeyHex)) {
    throw new Error("pubkeyHex must be a 33-byte compressed public key (66 hex chars)");
  }
  return hex.decode(pubkeyHex.toLowerCase().slice(2));
}

// ---- OP_RETURN script -----------------------------------------------------------------

export function makeOpReturnScript(data) {
  if (!(data instanceof Uint8Array)) {
    throw new Error("OP_RETURN data must be a Uint8Array");
  }
  if (data.length > 80) {
    throw new Error(`OP_RETURN data length ${data.length} > 80 (standardness)`);
  }
  if (data.length <= 75) {
    // OP_RETURN(0x6a) + direct push(len) + data
    const out = new Uint8Array(2 + data.length);
    out[0] = 0x6a;
    out[1] = data.length;
    out.set(data, 2);
    return out;
  }
  // OP_RETURN(0x6a) + OP_PUSHDATA1(0x4c) + len + data
  const out = new Uint8Array(3 + data.length);
  out[0] = 0x6a;
  out[1] = 0x4c;
  out[2] = data.length;
  out.set(data, 3);
  return out;
}

/**
 * Extract the raw signed transaction (hex) from a FINALIZED PSBT — the
 * shape UniSat returns from `signPsbt({ autoFinalized: true })`. Used when
 * `unisat.pushPsbt` is unavailable or fails, to POST /broadcast instead.
 */
export function extractRawTxHex(signedPsbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(signedPsbtHex));
  return hex.encode(tx.extract());
}

// ---- fee estimate -----------------------------------------------------------------------

/**
 * Estimated vsize for a tx of `inputCount` inputs of `inputType`
 * ('tr' | 'wpkh'), the given address outputs, and one OP_RETURN script.
 */
export function estimateVsize({ inputCount, inputType, outputAddresses, opReturnScriptLen }) {
  let v = VSIZE_TX_OVERHEAD + inputCount * inputVsize(inputType);
  for (const a of outputAddresses) v += outputVsize(a);
  if (opReturnScriptLen > 0) v += VSIZE_OPRETURN_BASE + opReturnScriptLen;
  return v;
}

/**
 * Quick fee preview for the console (before any UTXO is fetched): one input
 * of the wallet's type, the three fixed MINE outputs, and a change output.
 */
export function estimateMineFeeSats({ address, ticker, feeRateSatVb, inputCount = 1 }) {
  const type = isP2tr(address) ? "tr" : "wpkh";
  const payload = buildMinePayload(ticker);
  const vsize = estimateVsize({
    inputCount,
    inputType: type,
    outputAddresses: [address, PROJECT_FEE_ADDRESS, address],
    opReturnScriptLen: makeOpReturnScript(payload).length,
  });
  // Display-only preview: clamp (don't throw) so the console can still render
  // a number; the builder itself refuses rates above MAX_FEE_RATE_SAT_VB.
  const rate = Math.min(MAX_FEE_RATE_SAT_VB, Math.max(1, Number(feeRateSatVb) || 1));
  return { vsize: Math.ceil(vsize), feeSats: Math.ceil(vsize * rate) };
}

// ---- coin selection ------------------------------------------------------------------------

const outpointKey = (u) => `${u.txid}:${u.vout}`;

/**
 * Apply the §4 builder obligation: drop every UTXO with value ≤ DUST_SATS
 * and every outpoint listed in `tokenOutpoints`. Returns spendable rows.
 */
export function filterSpendable(utxos, tokenOutpoints) {
  const exclude = new Set((tokenOutpoints || []).map(outpointKey));
  return (utxos || []).filter((u) => {
    const sats = Number(u.sats);
    if (!Number.isInteger(sats) || sats <= DUST_SATS) return false;
    if (exclude.has(outpointKey(u))) return false;
    return true;
  });
}

/**
 * Greedy smallest-first selection with a deny-list of `excludeKeys`
 * (outpoint strings `txid:vout`). Smallest-first consolidates small UTXOs
 * on every MINE and leaves large ones intact.
 */
export function selectInputs({ utxos, target, excludeKeys }) {
  const exclude = new Set(excludeKeys || []);
  const remaining = utxos
    .filter((u) => !exclude.has(outpointKey(u)))
    .sort((a, b) => Number(a.sats) - Number(b.sats));

  const selected = [];
  let total = 0;
  for (const u of remaining) {
    if (total >= target) break;
    selected.push(u);
    total += Number(u.sats);
  }
  if (total < target) {
    throw new Error(
      `insufficient funds: need ${target.toLocaleString("en-US")} sats, ` +
      `have ${total.toLocaleString("en-US")} spendable (${selected.length} UTXOs)`,
    );
  }
  return { selected, total };
}

// ---- core builder --------------------------------------------------------------------------

/**
 * Shared pipeline. `outputs` are the fixed protocol outputs in final vout
 * order (excluding change). Change to `address` is appended last.
 *
 * `requireChange`: SEND commits change_out_idx = outputs.length in its
 * payload, so the change output MUST exist (≥ dust) or we refuse to build.
 * MINE routes everything to vout0, so sub-dust change can safely fold into
 * the miner fee.
 */
function buildUnsigned({
  address,
  pubkeyHex,
  utxos,
  tokenOutpoints,
  feeRateSatVb,
  outputs,
  opReturnData,
  requireChange,
}) {
  const { type, script } = decodeAddress(address);
  const tapInternalKey = type === "tr" ? xOnlyFromCompressedHex(pubkeyHex) : null;

  const spendable = filterSpendable(utxos, tokenOutpoints);
  if (spendable.length === 0) {
    throw new Error(
      `no spendable BTC at ${address} — every UTXO is either ≤ ${DUST_SATS} sats or token-bearing`,
    );
  }

  const satVb = checkedFeeRate(feeRateSatVb);

  const opReturnScript = makeOpReturnScript(opReturnData);
  const fixedOutValue = outputs.reduce((s, o) => s + o.value, 0);
  const fixedAddresses = outputs.map((o) => o.address);

  // Iterative selection + fee refinement: the input count drives vsize,
  // vsize drives fee, fee drives the selection target. Converges in ≤ 3.
  // `withChange` decides whether the estimate (and the +dust headroom on
  // the target) accounts for a change output.
  const attempt = (withChange) => {
    const outputAddresses = withChange ? fixedAddresses.concat([address]) : fixedAddresses;
    let selected, total;
    let fee = 0;
    for (let pass = 0; pass < 3; pass++) {
      const target = fixedOutValue + fee + (withChange ? DUST_SATS : 0);
      ({ selected, total } = selectInputs({ utxos: spendable, target, excludeKeys: [] }));
      const vsize = estimateVsize({
        inputCount: selected.length,
        inputType: type,
        outputAddresses,
        opReturnScriptLen: opReturnScript.length,
      });
      const newFee = Math.ceil(vsize * satVb);
      if (newFee === fee) break;
      fee = newFee;
    }
    return { selected, total, fee, vsize: estimateVsize({
      inputCount: selected.length, inputType: type, outputAddresses, opReturnScriptLen: opReturnScript.length,
    }) };
  };

  // Prefer a real change output. Only when the wallet cannot cover the
  // dust headroom do we (for MINE) fall back to folding sub-dust change
  // into the miner fee; SEND must never fold (its payload commits vout3).
  let sel;
  let changeOmitted = false;
  try {
    sel = attempt(true);
  } catch (e) {
    if (requireChange || !/insufficient funds/.test(String(e.message))) throw e;
    sel = attempt(false);
    changeOmitted = true;
  }
  const { selected, total, fee } = sel;

  const change = total - fixedOutValue - fee;
  if (change < 0) {
    throw new Error(`insufficient funds after fee (${fee.toLocaleString("en-US")} sats)`);
  }
  if (!changeOmitted && change < DUST_SATS) {
    // Cannot happen (target includes the headroom) — guard the invariant
    // loudly rather than silently burning a committed change slot.
    if (requireChange) {
      throw new Error(
        `change output required (payload commits change_out_idx=${outputs.length} for residual ` +
        `tokens) but change is ${change} sat < dust ${DUST_SATS} — refusing to build`,
      );
    }
    changeOmitted = true;
  }
  const finalFee = changeOmitted ? fee + change : fee;

  // allowUnknownOutputs: the OP_RETURN output is "unknown" to btc-signer's
  // OutScript classifier. The script is built by makeOpReturnScript and the
  // payload is pre-validated (ASCII + 80-byte cap), so this is not a gate
  // for arbitrary scripts.
  const tx = new btc.Transaction({
    allowUnknownInputs: false,
    allowUnknownOutputs: true,
    disableScriptCheck: false,
  });

  const inputIndexes = [];
  for (const u of selected) {
    const input = {
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script, amount: BigInt(u.sats) },
    };
    if (tapInternalKey) input.tapInternalKey = tapInternalKey;
    inputIndexes.push(tx.addInput(input));
  }

  for (const o of outputs) {
    tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
  }
  tx.addOutput({ script: opReturnScript, amount: 0n });
  if (!changeOmitted) {
    tx.addOutputAddress(address, BigInt(change), NETWORK);
  }

  return {
    psbtHex: hex.encode(tx.toPSBT()),
    feeSats: finalFee,
    inputIndexes,
    inputs: selected.map((u) => ({ txid: u.txid, vout: u.vout, sats: Number(u.sats) })),
    changeSats: changeOmitted ? 0 : change,
    changeOmitted,
    outputCount: outputs.length + 1 + (changeOmitted ? 0 : 1),
    estimatedVsize: Math.ceil(sel.vsize),
    feeRateSatVb: satVb,
  };
}

/**
 * Build an unsigned MINE PSBT.
 *
 * @returns {{ psbtHex: string, feeSats: number, inputIndexes: number[], ... }}
 */
export function buildMinePsbt({ address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb, ticker }) {
  const payload = buildMinePayload(ticker);
  return buildUnsigned({
    address,
    pubkeyHex,
    utxos,
    tokenOutpoints,
    feeRateSatVb,
    outputs: [
      { address, value: DUST_SATS },                               // vout0 yield slot
      { address: PROJECT_FEE_ADDRESS, value: MINE_PROTOCOL_FEE_SATS }, // vout1 fee
    ],
    opReturnData: payload,                                         // vout2
    requireChange: false,                                          // vout3 optional
  });
}

/**
 * Build an unsigned SEND PSBT. `tokenUtxos` are the sender's token-bearing
 * outpoints for `ticker` (from /utxos/:addr); they are spent as inputs so
 * their balances form the tx's input pool. The change output (vout3) is
 * mandatory — residual tokens route there — so this throws if change would
 * be sub-dust.
 */
export function buildSendPsbt({
  address,
  pubkeyHex,
  utxos,
  tokenOutpoints,
  tokenUtxos,
  feeRateSatVb,
  ticker,
  amount,
  toAddress,
}) {
  decodeAddress(toAddress);
  const payload = buildSendPayload({ ticker, amount, toOutIdx: 0, changeOutIdx: 3 });

  // Token carriers are pinned as inputs (their balances form the input pool)
  // and the fee selector funds the rest. They MUST be spent at their EXACT
  // on-chain value: the segwit/taproot sighash commits to each input's
  // amount, so a wrong witnessUtxo.amount yields an invalid signature (tx
  // rejected) and wrong fee/change math. Carriers are usually 546-sat dust,
  // but a SEND's vout3 change output carries residual tokens on top of
  // arbitrary BTC change — never assume 546. Resolve each carrier's sats
  // from the wallet's full UTXO list (the indexer's /btc-utxos includes
  // token dust; UniSat's own list may not) and refuse to build otherwise.
  const satsByKey = new Map((utxos || []).map((u) => [outpointKey(u), Number(u.sats)]));
  const carriers = (tokenUtxos || []).map((u) => {
    const own = Number(u.sats);
    const sats = Number.isInteger(own) && own > 0 ? own : satsByKey.get(outpointKey(u));
    if (!Number.isInteger(sats) || sats <= 0) {
      throw new Error(
        `token UTXO ${u.txid}:${u.vout} has no known BTC value — refresh UTXOs ` +
        `(indexer /btc-utxos) before sending`,
      );
    }
    return { txid: u.txid, vout: u.vout, sats };
  });
  if (carriers.length === 0) {
    throw new Error(`no ${ticker} token UTXOs at ${address} to spend`);
  }
  const carrierKeys = new Set(carriers.map(outpointKey));
  const feeUtxos = (utxos || []).filter((u) => !carrierKeys.has(outpointKey(u)));

  const { type, script } = decodeAddress(address);
  const tapInternalKey = type === "tr" ? xOnlyFromCompressedHex(pubkeyHex) : null;
  const spendable = filterSpendable(feeUtxos, tokenOutpoints);

  const satVb = checkedFeeRate(feeRateSatVb);

  const outputs = [
    { address: toAddress, value: DUST_SATS },                          // vout0 recipient
    { address: PROJECT_FEE_ADDRESS, value: SEND_PROTOCOL_FEE_SATS },   // vout1 fee
  ];
  const opReturnScript = makeOpReturnScript(payload);
  const fixedOutValue = outputs.reduce((s, o) => s + o.value, 0);
  const outputAddresses = outputs.map((o) => o.address).concat([address]);
  const carrierValue = carriers.reduce((s, u) => s + u.sats, 0);

  let selected = [];
  let total = 0;
  let fee = 0;
  for (let pass = 0; pass < 3; pass++) {
    const target = fixedOutValue + fee + DUST_SATS - carrierValue;
    if (target > 0) {
      ({ selected, total } = selectInputs({ utxos: spendable, target, excludeKeys: [] }));
    } else {
      selected = [];
      total = 0;
    }
    const vsize = estimateVsize({
      inputCount: carriers.length + selected.length,
      inputType: type,
      outputAddresses,
      opReturnScriptLen: opReturnScript.length,
    });
    const newFee = Math.ceil(vsize * satVb);
    if (newFee === fee) break;
    fee = newFee;
  }

  const change = carrierValue + total - fixedOutValue - fee;
  if (change < DUST_SATS) {
    throw new Error(
      `change output required (payload commits change_out_idx=3 for residual tokens) ` +
      `but change is ${change} sat < dust ${DUST_SATS} — refusing to build`,
    );
  }

  const tx = new btc.Transaction({
    allowUnknownInputs: false,
    allowUnknownOutputs: true,
    disableScriptCheck: false,
  });
  const inputIndexes = [];
  for (const u of [...carriers, ...selected]) {
    const input = {
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script, amount: BigInt(u.sats) },
    };
    if (tapInternalKey) input.tapInternalKey = tapInternalKey;
    inputIndexes.push(tx.addInput(input));
  }
  for (const o of outputs) tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
  tx.addOutput({ script: opReturnScript, amount: 0n });
  tx.addOutputAddress(address, BigInt(change), NETWORK); // vout3 — mandatory

  return {
    psbtHex: hex.encode(tx.toPSBT()),
    feeSats: fee,
    inputIndexes,
    changeSats: change,
    changeOmitted: false,
    feeRateSatVb: satVb,
  };
}
