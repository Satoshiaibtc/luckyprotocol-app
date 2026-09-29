// Unsigned PSBT construction for LUCKY-20 DEPLOY / MINE / SEND
// (spec §2 + §4 + §6).
//
// The web app holds no keys. This module selects BTC inputs, lays out the
// protocol outputs in the exact order the indexer expects, and returns an
// UNSIGNED PSBT (hex) that the UniSat extension signs + finalizes.
//
// Every transaction built here has nLockTime = PROTOCOL_LOCKTIME (969,599)
// and every input nSequence = RBF_SEQUENCE (0xfffffffd):
// the lock time is only enforced when some input's sequence is below
// 0xffffffff, and 0xfffffffd also signals replace-by-fee, which "Speed up"
// (buildSpeedUpPsbt) relies on. Such a tx can only confirm in block
// 969,600 (ACTIVATION_HEIGHT) or later.
//
// DEPLOY layout (§2.1): vout0 546 → self (deployer proof)
//                       vout1 5,460 → PROJECT_FEE_ADDRESS
//                       vout2 OP_RETURN  {"p":"lucky-20","op":"deploy","tick":"<TICKER>"}
//                       vout3 change → self (omitted if < dust; folded into fee)
//
// MINE layout (§2.2):   vout0 546 → self (yield output)
//                       vout1 546 → PROJECT_FEE_ADDRESS
//                       vout2 OP_RETURN  {"p":"lucky-20","op":"mine","tick":"<TICKER>"}
//                       vout3 change → self (omitted if < dust; folded into fee)
//
// SEND layout (§2.3 — token carriers are ALWAYS 546-sat outputs):
//                       vout0 546 → PROJECT_FEE_ADDRESS
//                       vout1 546 → recipient          (SEND_TO_VOUT: receives AMT)
//                       vout2 546 → self               (SEND_RESIDUAL_VOUT: the residual
//                                                       output — ALWAYS present,
//                                                       even when the residual is 0)
//                       vout3 OP_RETURN  {"p":"lucky-20","op":"send","tick":"<TICKER>","amt":"<AMT>"}
//                       vout4 BTC change → self        (optional; folded into the fee
//                                                       when < 546)
//
// Builder obligation (§4): never spend a token-bearing UTXO as a fee input.
// Every UTXO with value ≤ 546 sats is dropped (all LUCKY-20 carriers are
// 546-sat outputs), and every outpoint the indexer reports as token-bearing
// is excluded explicitly. Under DEFAULT ROUTING a payload-less spend of a
// carrier does not destroy its tokens — it hands them to the tx's first
// non-OP_RETURN output — and a carrier spent as a fee input of a protocol
// tx lands on the proof output of a DEPLOY, vout0 of a MINE, or vout2 of a
// SEND: never lost, but never intended either.
//
// Mainnet only.

import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
  DUST_SATS,
  PROJECT_FEE_ADDRESS,
  DEPLOY_PROTOCOL_FEE_SATS,
  MINE_PROTOCOL_FEE_SATS,
  SEND_PROTOCOL_FEE_SATS,
  SEND_RESIDUAL_VOUT,
  SEND_TO_VOUT,
  PROTOCOL_LOCKTIME,
  buildDeployPayload,
  buildMinePayload,
  buildSendPayload,
  parsePayloadBytes,
  payloadToString,
} from "./payloads.js";

export const NETWORK = btc.NETWORK; // mainnet

/**
 * nSequence of every input this module adds: signals BIP125 replace-by-fee
 * (≤ 0xfffffffd) and enables nLockTime (< 0xffffffff).
 */
export const RBF_SEQUENCE = 0xfffffffd;

/** vout of the optional BTC change output of a DEPLOY (proof, fee, OP_RETURN, change). */
export const DEPLOY_CHANGE_VOUT = 3;

/**
 * Hard safety cap on the fee rate a builder will accept. The rate comes from
 * the indexer's /fees (bitcoind estimatesmartfee); a buggy or compromised
 * response of, say, 10⁶ sat/vB would otherwise turn a MINE into a wallet-
 * draining miner fee. Mainnet has never sustained anything near this; if a
 * real spike ever exceeds it, the user should wait — never auto-clamp to a
 * number that still overpays.
 */
export const MAX_FEE_RATE_SAT_VB = 1_000;

export function checkedFeeRate(feeRateSatVb) {
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
      `unsupported address type "${decoded.type}" — LuckyProtocol supports Native SegWit (bc1q) ` +
      `and Taproot (bc1p) only; switch the address type in your wallet`,
    );
  }
  return { type: decoded.type, script: btc.OutScript.encode(decoded) };
}

/**
 * The mainnet P2TR (bc1p…) address of a 32-byte x-only INTERNAL key (hex),
 * or null when the key is not a valid x-only point. Used to check a key a
 * wallet returns before trusting it for `tapInternalKey`.
 */
export function p2trAddressOfXOnly(xonlyHex) {
  const h = String(xonlyHex || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  try {
    return btc.p2tr(hex.decode(h), undefined, NETWORK).address || null;
  } catch {
    return null;
  }
}

/** Recipient address types a SEND may pay (any standard mainnet output; inputs stay bc1q / bc1p). */
export const RECIPIENT_TYPES = new Set(["pkh", "sh", "wpkh", "wsh", "tr"]);
const RECIPIENT_TYPE_LABEL = { pkh: "Legacy (1…)", sh: "Nested SegWit / P2SH (3…)", wpkh: "Native SegWit (bc1q…)", wsh: "SegWit script (bc1q…)", tr: "Taproot (bc1p…)" };

/**
 * Decode a mainnet RECIPIENT address (the other side of a SEND): P2PKH
 * (1…), P2SH (3…), P2WPKH / P2WSH (bc1q…) and P2TR (bc1p…) are accepted —
 * every one is a standard output with an address, so tokens routed to it
 * are never burnt (§4). → `{ type, script, label }`; throws in plain words.
 * The SENDER's own address must still pass decodeAddress (bc1q / bc1p).
 */
export function decodeRecipientAddress(address) {
  const a = typeof address === "string" ? address.trim() : "";
  if (!a) throw new Error("enter the recipient's Bitcoin address");
  let decoded;
  try {
    decoded = btc.Address(NETWORK).decode(a);
  } catch {
    throw new Error(`"${a.length > 24 ? `${a.slice(0, 24)}…` : a}" is not a valid Bitcoin mainnet address`);
  }
  if (!RECIPIENT_TYPES.has(decoded.type)) throw new Error(`addresses of type "${decoded.type}" cannot receive tokens here`);
  return { type: decoded.type, script: btc.OutScript.encode(decoded), label: RECIPIENT_TYPE_LABEL[decoded.type] };
}

/**
 * `{ ok, type, label, error }` for a recipient address — the Send form's
 * inline check (never throws). `self` (optional, the sender's address) adds
 * `isSelf: true` when the two are the same address.
 */
export function checkRecipientAddress(address, self = null) {
  try {
    const r = decodeRecipientAddress(address);
    return { ok: true, type: r.type, label: r.label, error: null, isSelf: !!self && String(address).trim() === self };
  } catch (e) {
    return { ok: false, type: null, label: null, error: String(e.message || e), isSelf: false };
  }
}

export function isP2tr(address) {
  return typeof address === "string" && address.startsWith("bc1p");
}

/** vB of an output paying `address` (8 value + 1 length + script). Unknown shapes count as P2TR (the largest). */
export function outputVsize(address) {
  if (isP2tr(address)) return VSIZE_P2TR_OUTPUT;
  if (typeof address === "string") {
    if (address.startsWith("1")) return 34;                         // P2PKH: 25-byte script
    if (address.startsWith("3")) return 32;                         // P2SH: 23-byte script
    if (address.startsWith("bc1q")) return address.length > 50 ? VSIZE_P2TR_OUTPUT : VSIZE_P2WPKH_OUTPUT; // P2WSH 34-byte / P2WPKH 22-byte script
  }
  return VSIZE_P2TR_OUTPUT;
}

export function inputVsize(type) {
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
 * An input the wallet signed but left unfinalized is finalized here from
 * its own signature (nothing new is signed); any other unfinished input
 * makes the extraction fail.
 */
export function extractRawTxHex(signedPsbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(signedPsbtHex));
  finalizeSignedInputs(tx);
  const raw = hex.encode(tx.extract());
  assertSingleOpReturn(raw);
  return raw;
}

/**
 * The transaction a PSBT carries, as the fields a signature must not
 * change: version, lock time, each input's outpoint and nSequence, each
 * output's script and amount.
 */
export function psbtTxShape(psbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
  const inputs = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    inputs.push({ txid: inp.txid ? hex.encode(inp.txid) : null, vout: inp.index ?? null, sequence: inp.sequence ?? 0xffffffff });
  }
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    outputs.push({ script: o.script ? hex.encode(o.script) : null, amount: o.amount === undefined ? null : String(o.amount) });
  }
  return { version: tx.version, lockTime: tx.lockTime, inputs, outputs };
}

/**
 * After-signing check: does the PSBT the wallet returned carry the very
 * transaction it was asked to sign? A wallet may sign only what it was
 * given — a changed lock time, nSequence (the RBF signal), input or output
 * would otherwise be broadcast as is. The signature TYPE is checked apart
 * (src/lib/sighash.js signedSighashMismatch).
 * → null when identical, else what differs (a short phrase).
 */
export function signedTxMismatch(unsignedPsbtHex, signedPsbtHex) {
  let a;
  let b;
  try {
    a = psbtTxShape(unsignedPsbtHex);
  } catch {
    return null; // not ours to judge: the flow built something this module cannot read
  }
  try {
    b = psbtTxShape(signedPsbtHex);
  } catch (e) {
    return `the signed result is not a readable PSBT (${e?.message || e})`;
  }
  if (a.version !== b.version) return `the version changed (${a.version} → ${b.version})`;
  if (a.lockTime !== b.lockTime) return `the lock time changed (${a.lockTime} → ${b.lockTime})`;
  if (a.inputs.length !== b.inputs.length) return `the input count changed (${a.inputs.length} → ${b.inputs.length})`;
  for (let i = 0; i < a.inputs.length; i++) {
    const x = a.inputs[i];
    const y = b.inputs[i];
    if (x.txid !== y.txid || x.vout !== y.vout) return `input ${i} changed`;
    if (x.sequence !== y.sequence) return `input ${i}'s sequence changed (${x.sequence} → ${y.sequence})`;
  }
  if (a.outputs.length !== b.outputs.length) return `the output count changed (${a.outputs.length} → ${b.outputs.length})`;
  for (let i = 0; i < a.outputs.length; i++) {
    if (a.outputs[i].script !== b.outputs[i].script) return `output ${i}'s script changed`;
    if (a.outputs[i].amount !== b.outputs[i].amount) return `output ${i}'s amount changed`;
  }
  return null;
}

/** The outpoints ("txid:vout") of the inputs at `indexes` of a PSBT (all of them when `indexes` is not a list). */
export function psbtInputKeys(psbtHex, indexes = null) {
  const { inputs } = psbtTxShape(psbtHex);
  const pick = Array.isArray(indexes) ? indexes.filter((i) => Number.isInteger(i) && i >= 0 && i < inputs.length) : inputs.map((_, i) => i);
  return pick.map((i) => `${inputs[i].txid}:${inputs[i].vout}`);
}

/** Finalize every input of `tx` whose status is "signed" (a signature present, no final witness yet). */
export function finalizeSignedInputs(tx) {
  for (let i = 0; i < tx.inputsLength; i++) {
    if (tx.inputStatus(i) !== "signed") continue;
    try {
      tx.finalizeIdx(i);
    } catch (e) {
      throw new Error(`input ${i} is signed but could not be finalized (${e?.message || e})`);
    }
  }
  return tx;
}

/**
 * `{ txid, inputs: [{ txid, vout }] }` of a raw signed tx (hex). The txid is
 * the one a node reports for it (witness-stripped hash, display order), so
 * a broadcast whose relay answer was lost can still be looked up by it.
 */
export function rawTxSummary(rawHex) {
  if (typeof rawHex !== "string" || !/^[0-9a-f]+$/i.test(rawHex) || rawHex.length % 2 !== 0) {
    throw new Error("raw tx must be an even-length hex string");
  }
  const bytes = hex.decode(rawHex);
  const tx = btc.Transaction.fromRaw(bytes, { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const parsed = btc.RawTx.decode(bytes);
  return { txid: tx.id, inputs: parsed.inputs.map((i) => ({ txid: hex.encode(i.txid), vout: i.index })) };
}

/**
 * Broadcast-time guard: count the OP_RETURN outputs (byte-0
 * 0x6a) of a raw tx and refuse more than one. A wallet or aggregator that
 * appends its own OP_RETURN (memo, runestone) to one of our protocol txs
 * would otherwise turn it into "not a protocol tx" for an indexer that
 * rejects multi-OP_RETURN transactions — and default routing would then
 * move the whole input pool to the tx's first output.
 * Zero OP_RETURNs is fine (a plain payment carries none).
 * → the count.
 */
export function assertSingleOpReturn(rawHex) {
  if (typeof rawHex !== "string" || !/^[0-9a-f]+$/i.test(rawHex) || rawHex.length % 2 !== 0) {
    throw new Error("raw tx must be an even-length hex string");
  }
  const parsed = btc.RawTx.decode(hex.decode(rawHex));
  const n = parsed.outputs.filter((o) => isOpReturnScript(o.script)).length;
  if (n > 1) {
    throw new Error(`refusing to broadcast: the transaction has ${n} OP_RETURN outputs (a protocol tx has exactly one)`);
  }
  return n;
}

// ---- OP_RETURN payload rule (mirrors the indexer, PROTOCOL.md §2) ------------------------
//
// An OP_RETURN output is any output whose scriptPubKey starts with 0x6a.
// The protocol payload is the LOWEST-index OP_RETURN output whose script
// is exactly `OP_RETURN <one push>` (direct push, PUSHDATA1/2/4, nothing
// after it) and whose push parses as a LUCKY-20 payload. Every other
// OP_RETURN output is ignored by the rule — but this app never signs or
// relays a tx with more than one (see expectPsbtPayload / assertSingleOpReturn),
// because an indexer applying the stricter "more than one ⇒ not a protocol
// tx" reading would default-route the input pool to the first output.

const OP_RETURN = 0x6a;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;

export const isOpReturnScript = (script) => script instanceof Uint8Array && script.length > 0 && script[0] === OP_RETURN;

/**
 * The data of an `OP_RETURN <single push>` script, or null when the script
 * is not an OP_RETURN, has no push, uses an opcode other than a data push
 * (e.g. `6a61` = OP_RETURN OP_NOP), is truncated, or carries anything after
 * the push.
 */
export function decodeOpReturnPush(script) {
  if (!isOpReturnScript(script) || script.length < 2) return null;
  const op = script[1];
  let start;
  let len;
  if (op >= 1 && op < OP_PUSHDATA1) {
    len = op;
    start = 2;
  } else if (op === OP_PUSHDATA1) {
    if (script.length < 3) return null;
    len = script[2];
    start = 3;
  } else if (op === OP_PUSHDATA2) {
    if (script.length < 4) return null;
    len = script[2] | (script[3] << 8);
    start = 4;
  } else if (op === OP_PUSHDATA4) {
    if (script.length < 6) return null;
    len = (script[2] | (script[3] << 8) | (script[4] << 16) | (script[5] << 24)) >>> 0;
    start = 6;
  } else {
    return null; // OP_0, OP_1..16, or a non-push opcode
  }
  if (start + len !== script.length) return null; // truncated, or trailing bytes
  return script.subarray(start, start + len);
}

/**
 * Apply the payload rule to a tx's output scripts (in vout order).
 * → { opReturnCount, payload, payloadText, payloadVout }
 */
export function protocolPayloadOfScripts(scripts) {
  let opReturnCount = 0;
  let payload = null;
  let payloadText = null;
  let payloadVout = null;
  (scripts || []).forEach((script, vout) => {
    if (!isOpReturnScript(script)) return;
    opReturnCount += 1;
    if (payload !== null) return;
    const data = decodeOpReturnPush(script);
    if (!data) return;
    const p = parsePayloadBytes(data);
    if (p) {
      payload = p;
      payloadText = payloadToString(data);
      payloadVout = vout;
    }
  });
  return { opReturnCount, payload, payloadText, payloadVout };
}

/** The output scripts of a PSBT's transaction, in vout order. */
export function psbtOutputScripts(psbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
  const scripts = [];
  for (let i = 0; i < tx.outputsLength; i++) scripts.push(tx.getOutput(i).script);
  return scripts;
}

/**
 * The LUCKY-20 payload a PSBT carries (`{ op, ticker, amount? }`, as
 * parsePayload), or null when it carries none or the PSBT does not read.
 * Never throws.
 */
export function psbtPayload(psbtHex) {
  try {
    return protocolPayloadOfScripts(psbtOutputScripts(psbtHex)).payload;
  } catch {
    return null;
  }
}

const hex8 = (n) => `0x${(Number(n) >>> 0).toString(16).padStart(8, "0")}`;

/** The mainnet scriptPubKey (hex) of `address`, or null when it does not decode. */
function scriptHexOfAddress(address) {
  try {
    return hex.encode(btc.OutScript.encode(btc.Address(NETWORK).decode(String(address))));
  } catch {
    return null;
  }
}

/**
 * The reference output layout of `op` (spec §2.1–§2.3), checked
 * against `outs` = [{ script (hex), amount (number) }]. `self` is the
 * builder's own address; `to` the SEND's recipient. Throws "refusing to
 * sign: output {n} is not …" on the first output that breaks it.
 *
 *   DEPLOY  546 → self · exactly 5,460 → fee · OP_RETURN · change ≥ 546 → self (optional)
 *   MINE    546 → self · exactly 546 → fee   · OP_RETURN · change ≥ 546 → self (optional)
 *   SEND    exactly 546 → fee · 546 → to · 546 → self · OP_RETURN · change ≥ 546 → self (optional)
 */
function checkLayout(op, outs, layout) {
  const selfHex = scriptHexOfAddress(layout?.self);
  if (!selfHex) throw new Error("refusing to sign: the layout check needs this wallet's own address");
  const feeHex = scriptHexOfAddress(PROJECT_FEE_ADDRESS);
  const isOpRet = (o) => !!o && /^6a/i.test(o.script || "");
  const need = (n, ok, what) => {
    if (!ok(outs[n])) throw new Error(`refusing to sign: output ${n} is not ${what}`);
  };
  const pays = (script, sats) => (o) => !!o && !isOpRet(o) && o.script === script && (sats === null || o.amount === sats);
  const change = (o) => pays(selfHex, null)(o) && o.amount >= DUST_SATS;
  let fixed;
  if (op === "SEND") {
    const toHex = layout.to ? scriptHexOfAddress(layout.to) : null;
    if (!toHex || toHex === feeHex) throw new Error("refusing to sign: a SEND needs its recipient, and the protocol fee address cannot be one");
    need(0, pays(feeHex, SEND_PROTOCOL_FEE_SATS), `exactly ${SEND_PROTOCOL_FEE_SATS} sats to the protocol fee address`);
    need(SEND_TO_VOUT, pays(toHex, DUST_SATS), `${DUST_SATS} sats to the recipient`);
    need(SEND_RESIDUAL_VOUT, pays(selfHex, DUST_SATS), `${DUST_SATS} sats back to this wallet (the residual output)`);
    need(3, isOpRet, "the OP_RETURN payload");
    fixed = 4;
  } else if (op === "DEPLOY" || op === "MINE") {
    const fee = op === "DEPLOY" ? DEPLOY_PROTOCOL_FEE_SATS : MINE_PROTOCOL_FEE_SATS;
    need(0, pays(selfHex, DUST_SATS), `${DUST_SATS} sats back to this wallet`);
    need(1, pays(feeHex, fee), `exactly ${fee.toLocaleString("en-US")} sats to the protocol fee address`);
    need(2, isOpRet, "the OP_RETURN payload");
    fixed = 3;
  } else {
    throw new Error(`refusing to sign: no reference layout for ${op}`);
  }
  if (outs.length > fixed + 1) throw new Error(`refusing to sign: output ${fixed + 1} is not part of the ${op} layout (${outs.length} outputs)`);
  if (outs.length === fixed + 1) need(fixed, change, `BTC change of at least ${DUST_SATS} sats back to this wallet`);
}

/**
 * Sign-time guard: before a PSBT goes to the wallet,
 * assert that its OP_RETURN says what the flow believes it says.
 *
 *   expectPsbtPayload(hex, { op: "DEPLOY", ticker, lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self } })
 *   expectPsbtPayload(hex, { op: "MINE", ticker, lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self } })
 *   expectPsbtPayload(hex, { op: "SEND", ticker, amount, lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self, to } })
 *   expectPsbtPayload(hex, { op: null })          // a plain payment: no OP_RETURN at all
 *
 * (`to = self` for a split, a withdraw or a cancel.) Throws on: more than
 * one OP_RETURN output, a missing / unparsable payload, the wrong opcode,
 * ticker or amount, and — when asked — the wrong nLockTime, an input whose
 * nSequence is not `inputsSequence`, or an output that breaks the reference
 * layout of `op` (checkLayout): with fixed positions, one misplaced output
 * would put tokens on the fee address or with someone else.
 * Returns the parsed payload (null for a plain payment).
 */
export function expectPsbtPayload(psbtHex, expect = {}) {
  const scripts = psbtOutputScripts(psbtHex);
  const found = protocolPayloadOfScripts(scripts);
  const payload = checkExpectedPayload(found, expect);
  const want = expect && typeof expect === "object" ? expect : {};
  if (want.lockTime !== undefined || want.inputsSequence !== undefined || want.layout !== undefined) {
    const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
    if (want.lockTime !== undefined && tx.lockTime !== want.lockTime) {
      throw new Error(`refusing to sign: nLockTime is ${tx.lockTime}, expected ${want.lockTime}`);
    }
    if (want.inputsSequence !== undefined) {
      for (let i = 0; i < tx.inputsLength; i++) {
        const seq = tx.getInput(i).sequence ?? 0xffffffff;
        if (seq !== want.inputsSequence) throw new Error(`refusing to sign: input ${i} has nSequence ${hex8(seq)}, expected ${hex8(want.inputsSequence)}`);
      }
    }
    if (want.layout !== undefined) {
      const outs = [];
      for (let i = 0; i < tx.outputsLength; i++) {
        const o = tx.getOutput(i);
        outs.push({ script: o.script ? hex.encode(o.script) : "", amount: o.amount === undefined ? null : Number(o.amount) });
      }
      checkLayout(payload?.op ?? want.op, outs, want.layout || {});
    }
  }
  return payload;
}

export function checkExpectedPayload(found, expect = {}) {
  const want = expect && typeof expect === "object" ? expect : {};
  if (found.opReturnCount > 1) {
    throw new Error(`refusing to sign: the transaction has ${found.opReturnCount} OP_RETURN outputs (a protocol tx has exactly one)`);
  }
  if (want.op === null) {
    if (found.opReturnCount !== 0) throw new Error("refusing to sign: a plain payment must not carry an OP_RETURN output");
    return null;
  }
  if (!found.payload) {
    throw new Error(
      found.opReturnCount === 0
        ? `refusing to sign: no OP_RETURN output — expected a ${want.op || "protocol"} payload`
        : "refusing to sign: the OP_RETURN output does not parse as a LUCKY-20 payload",
    );
  }
  if (want.op && found.payload.op !== want.op) {
    throw new Error(`refusing to sign: OP_RETURN is ${found.payload.op}, expected ${want.op}`);
  }
  if (want.ticker !== undefined && found.payload.ticker !== want.ticker) {
    throw new Error(`refusing to sign: OP_RETURN names ticker ${found.payload.ticker}, expected ${want.ticker}`);
  }
  if (want.amount !== undefined && Number(found.payload.amount) !== Number(want.amount)) {
    throw new Error(`refusing to sign: OP_RETURN moves ${found.payload.amount} tokens, expected ${want.amount}`);
  }
  return found.payload;
}

// ---- fee estimate -----------------------------------------------------------------------

/**
 * Estimated vsize for a tx of `inputCount` inputs of `inputType`
 * ('tr' | 'wpkh'), the given address outputs, and one OP_RETURN script.
 * Fractional (10.5 overhead, 57.5 per P2TR input). A node's real vsize is
 * ceil(weight / 4), so every fee below is ceil(ceil(vsize) × rate) — a
 * plain ceil(vsize × rate) can come in under the node's minimum (213.5 vB
 * at 3 sat/vB: 641 instead of 642).
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
  return { vsize: Math.ceil(vsize), feeSats: Math.ceil(Math.ceil(vsize) * rate) };
}

// ---- coin selection ------------------------------------------------------------------------

export const outpointKey = (u) => `${u.txid}:${u.vout}`;

/**
 * Fee-input floor when the UTXO list is NOT asset-safe (OKX Wallet and the
 * mock have no asset-aware list; the indexer's raw BTC view cannot tell an
 * inscription or rune carrier from plain BTC). ord's default postage is
 * 10,000 sats, so anything AT or below it is treated as a possible carrier
 * and never spent as a fee input (`<=`, not `<`: an output of exactly the
 * postage is the most likely carrier of all).
 * Runes are still not detectable this way — the notice says so.
 */
export const MIN_FEE_INPUT_SATS_UNSAFE = 10_000;

/** The `minInputSats` a builder should use for a UTXO list with this `assetSafe` flag. */
export function minFeeInputSats(assetSafe) {
  return assetSafe === true ? 0 : MIN_FEE_INPUT_SATS_UNSAFE;
}

/**
 * The selection order a builder should use for a UTXO list with this
 * `assetSafe` flag. An asset-safe list is consolidated smallest-first; on
 * any other list the LARGEST outputs are spent first, so postage-sized
 * outputs (possible Ordinals / Runes carriers above the floor) are a last
 * resort, not the first pick.
 */
export function selectionOrderFor(assetSafe) {
  return assetSafe === true ? "smallest" : "largest";
}

/** A builder given a fee-input floor (a list that is not asset-safe) selects largest-first unless told otherwise. */
function defaultOrder(minInputSats) {
  return Number(minInputSats) > 0 ? "largest" : "smallest";
}

/**
 * Apply the §4 builder obligation: drop every UTXO with value ≤ DUST_SATS
 * and every outpoint listed in `tokenOutpoints`; with `minSats`, also drop
 * everything at or below that floor (see MIN_FEE_INPUT_SATS_UNSAFE).
 * Returns spendable rows.
 */
export function filterSpendable(utxos, tokenOutpoints, { minSats = 0 } = {}) {
  const exclude = new Set((tokenOutpoints || []).map(outpointKey));
  const floor = Number.isFinite(Number(minSats)) ? Number(minSats) : 0;
  return (utxos || []).filter((u) => {
    const sats = Number(u.sats);
    if (!Number.isInteger(sats) || sats <= DUST_SATS) return false;
    if (floor > 0 && sats <= floor) return false;
    if (exclude.has(outpointKey(u))) return false;
    return true;
  });
}

/**
 * The "nothing to spend" error, naming the floor when one was applied.
 * Tagged `code: "no-spendable"` (+ `minSats`) so a flow can explain it in
 * plain words (src/lib/funding.js) — e.g. when the only plain BTC is still
 * unconfirmed.
 */
export function noSpendableError(address, minSats) {
  let err;
  if (minSats > DUST_SATS) {
    err = new Error(
      `no usable fee input at ${address}: this wallet has no asset-safe UTXO list, so only outputs larger than ` +
      `${minSats.toLocaleString("en-US")} sats that are not token-bearing are spent (smaller ones may carry Ordinals) — ` +
      `send more than ${minSats.toLocaleString("en-US")} sats of plain BTC to this address, or use a wallet with an asset-safe UTXO list`,
    );
  } else {
    err = new Error(`no spendable BTC at ${address} — every UTXO is either ≤ ${DUST_SATS} sats or token-bearing`);
  }
  err.code = "no-spendable";
  err.minSats = Number(minSats) || 0;
  return err;
}

/** An "insufficient funds" error tagged for src/lib/funding.js (`code`, `needSats`, `haveSats`). */
export function insufficientFundsError(needSats, haveSats, inputCount) {
  const n = Number(inputCount) || 0;
  const err = new Error(
    `insufficient funds: need ${Number(needSats).toLocaleString("en-US")} sats, ` +
    `have ${Number(haveSats).toLocaleString("en-US")} spendable (${n} UTXO${n === 1 ? "" : "s"})`,
  );
  err.code = "insufficient";
  err.needSats = Number(needSats);
  err.haveSats = Number(haveSats);
  return err;
}

/**
 * The fee an input of `type` costs at `satVb` — an output worth no more
 * than this adds nothing (or less than nothing) to a transaction.
 */
export function inputCostSats(type, satVb) {
  const rate = Number(satVb);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.ceil(inputVsize(type) * rate);
}

/**
 * Greedy selection with a deny-list of `excludeKeys` (outpoint strings
 * `txid:vout`).
 *
 *   order "smallest" (default) — consolidates small UTXOs on every MINE and
 *                                leaves large ones intact (asset-safe lists)
 *   order "largest"            — fewest inputs; used for fills and for any
 *                                list that is not asset-safe
 *   minEffectiveSats           — skip every output worth ≤ this (its own
 *                                input fee, inputCostSats): an uneconomic
 *                                output can never help fund a tx, it only
 *                                raises the fee
 */
export function selectInputs({ utxos, target, excludeKeys, order = "smallest", minEffectiveSats = 0 }) {
  const exclude = new Set(excludeKeys || []);
  const floor = Number(minEffectiveSats) > 0 ? Number(minEffectiveSats) : 0;
  const dir = order === "largest" ? -1 : 1;
  const remaining = utxos
    .filter((u) => !exclude.has(outpointKey(u)))
    .filter((u) => Number(u.sats) > floor)
    .sort((a, b) => dir * (Number(a.sats) - Number(b.sats)) || String(a.txid).localeCompare(String(b.txid)) || Number(a.vout) - Number(b.vout));

  const selected = [];
  let total = 0;
  for (const u of remaining) {
    if (total >= target) break;
    selected.push(u);
    total += Number(u.sats);
  }
  if (total < target) throw insufficientFundsError(target, total, selected.length);
  return { selected, total };
}

/**
 * The most fee inputs one transaction may take. A wallet whose BTC is
 * spread so thin that a single MINE or send needs more is asked to
 * consolidate first (`code: "too-many-inputs"`), never handed a
 * transaction whose fee is mostly the cost of its own inputs.
 */
export const MAX_FEE_INPUTS = 200;

/** Too many inputs would be needed (see MAX_FEE_INPUTS). */
export function tooManyInputsError(maxInputs = MAX_FEE_INPUTS) {
  const err = new Error(
    `this would need more than ${maxInputs} inputs: the wallet's BTC is spread over many small outputs — consolidate them in the wallet (send them to yourself in one transaction), or pick a lower fee rate`,
  );
  err.code = "too-many-inputs";
  err.maxInputs = maxInputs;
  return err;
}

/** Is `e` a selection that ran short (not enough value, or too many inputs needed) rather than a build error? */
export function isShortfall(e) {
  return !!e && (e.code === "insufficient" || e.code === "too-many-inputs");
}

/**
 * Select fee inputs until the fee they cost is covered. `targetFor(fee)` =
 * the value the inputs must reach when the fee is `fee` (≤ 0: none needed);
 * `feeFor(n)` = the fee with `n` selected inputs. Each pass selects a
 * PREFIX of one sorted list (selectInputs) for a target that only grows,
 * so the input count only grows, and the loop stops the first time it does
 * not (the fee is then the one the selection was made for): at most
 * spendable.length + 2 passes. Never a fixed number of passes — a stop
 * before convergence leaves a selection made for a smaller fee than it
 * pays. `onEmpty()` builds the error when inputs are needed and there are
 * none. → `{ selected, total, fee }` with total ≥ targetFor(fee).
 */
export function convergeSelection({ spendable, targetFor, feeFor, order, minEffectiveSats = 0, maxInputs = MAX_FEE_INPUTS, onEmpty = null }) {
  let fee = 0;
  let sel = { selected: [], total: 0 };
  const passes = spendable.length + 2;
  for (let pass = 0; pass < passes; pass++) {
    const target = targetFor(fee);
    if (target > 0) {
      if (spendable.length === 0 && onEmpty) throw onEmpty();
      sel = selectInputs({ utxos: spendable, target, excludeKeys: [], order, minEffectiveSats });
    } else {
      sel = { selected: [], total: 0 };
    }
    if (sel.selected.length > maxInputs) throw tooManyInputsError(maxInputs);
    const next = feeFor(sel.selected.length);
    if (next === fee) return { ...sel, fee };
    fee = next;
  }
  // Unreachable (the count cannot grow more often than there are inputs); fail closed.
  throw insufficientFundsError(targetFor(fee), sel.total, sel.selected.length);
}

/**
 * The selection plans for an order: largest-first as asked; smallest-first
 * (an asset-safe list consolidates) only over outputs worth at least TWICE
 * their own input fee — at a high fee rate a smaller one would cost the
 * transaction more than half of what it brings — and, when that runs short,
 * largest-first over every output worth more than its input fee.
 */
function selectionPlans(order, inputCost) {
  if (order === "largest") return [{ order: "largest", minEffectiveSats: inputCost }];
  return [
    { order: "smallest", minEffectiveSats: 2 * inputCost },
    { order: "largest", minEffectiveSats: inputCost },
  ];
}

/**
 * Run `attempt(plan, withChange)` over the plans: every plan with a change
 * output first, then — unless `requireChange` — every plan without one
 * (sub-dust change folded into the fee). The first that does not run short
 * wins; else the last shortfall is thrown.
 */
function firstFeasible(plans, attempt, { requireChange = false } = {}) {
  let last = null;
  for (const withChange of requireChange ? [true] : [true, false]) {
    for (const plan of plans) {
      try {
        return { sel: attempt(plan, withChange), changeOmitted: !withChange };
      } catch (e) {
        if (!isShortfall(e)) throw e;
        last = e;
      }
    }
  }
  throw last;
}

// ---- core builder --------------------------------------------------------------------------

/**
 * A new unsigned tx with this module's fixed header: version 2, nLockTime
 * PROTOCOL_LOCKTIME. allowUnknownOutputs: the OP_RETURN output is
 * "unknown" to btc-signer's OutScript classifier; the script is built by
 * makeOpReturnScript and the payload is pre-validated (ASCII + 80-byte
 * cap), so this is not a gate for arbitrary scripts.
 */
function newProtocolTx() {
  return new btc.Transaction({
    version: 2,
    lockTime: PROTOCOL_LOCKTIME,
    allowUnknownInputs: false,
    allowUnknownOutputs: true,
    disableScriptCheck: false,
  });
}

/** A PSBT input for one of the wallet's own outputs `u` ({ txid, vout, sats }), RBF-signalling. */
function protocolInput(u, script, tapInternalKey) {
  const input = {
    txid: u.txid,
    index: u.vout,
    sequence: RBF_SEQUENCE,
    witnessUtxo: { script, amount: BigInt(u.sats) },
  };
  if (tapInternalKey) input.tapInternalKey = tapInternalKey;
  return input;
}

/**
 * Shared pipeline. `outputs` are the fixed protocol outputs in final vout
 * order (excluding change). Change to `address` is appended last.
 *
 * `requireChange`: refuse to build unless the change output exists (≥
 * dust). No current caller needs it — DEPLOY / MINE route nothing
 * through their change output, and SEND has its own builder
 * whose residual output is a fixed 546-sat output — so sub-dust change folds
 * into the miner fee.
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
  minInputSats = 0,
  selectionOrder,
}) {
  const { type, script } = decodeAddress(address);
  const order = selectionOrder ?? defaultOrder(minInputSats);
  const tapInternalKey = type === "tr" ? xOnlyFromCompressedHex(pubkeyHex) : null;

  const spendable = filterSpendable(utxos, tokenOutpoints, { minSats: minInputSats });
  if (spendable.length === 0) throw noSpendableError(address, minInputSats);

  const satVb = checkedFeeRate(feeRateSatVb);

  // `opReturnData: null` would build a plain payment (no protocol output);
  // every current caller passes a payload.
  const opReturnScript = opReturnData ? makeOpReturnScript(opReturnData) : null;
  const opReturnLen = opReturnScript ? opReturnScript.length : 0;
  const fixedOutValue = outputs.reduce((s, o) => s + o.value, 0);
  const fixedAddresses = outputs.map((o) => o.address);

  // Selection + fee refinement until they agree (convergeSelection): the
  // input count drives vsize, vsize drives fee, fee drives the target.
  // `withChange` decides whether the estimate (and the +dust headroom on
  // the target) accounts for a change output.
  const attempt = (plan, withChange) => {
    const outputAddresses = withChange ? fixedAddresses.concat([address]) : fixedAddresses;
    const vsizeFor = (n) => estimateVsize({ inputCount: n, inputType: type, outputAddresses, opReturnScriptLen: opReturnLen });
    const sel = convergeSelection({
      spendable,
      targetFor: (fee) => fixedOutValue + fee + (withChange ? DUST_SATS : 0),
      feeFor: (n) => Math.ceil(Math.ceil(vsizeFor(n)) * satVb),
      order: plan.order,
      minEffectiveSats: plan.minEffectiveSats,
    });
    return { ...sel, vsize: vsizeFor(sel.selected.length) };
  };

  // Prefer a real change output. Only when the wallet cannot cover the
  // dust headroom do we fall back to folding sub-dust change into the
  // miner fee (unless the caller set requireChange).
  const run = firstFeasible(selectionPlans(order, inputCostSats(type, satVb)), attempt, { requireChange });
  const sel = run.sel;
  let changeOmitted = run.changeOmitted;
  const { selected, total, fee } = sel;

  const change = total - fixedOutValue - fee;
  if (change < 0) {
    // Cannot happen once the selection converged — guard it loudly.
    throw insufficientFundsError(fixedOutValue + fee, total, selected.length);
  }
  if (!changeOmitted && change < DUST_SATS) {
    // Cannot happen (target includes the headroom) — guard the invariant
    // loudly rather than silently dropping a required change output.
    if (requireChange) {
      throw new Error(
        `change output required (vout${outputs.length + (opReturnScript ? 1 : 0)}) but change is ` +
        `${change} sat < dust ${DUST_SATS} — refusing to build`,
      );
    }
    changeOmitted = true;
  }
  const finalFee = changeOmitted ? fee + change : fee;

  const tx = newProtocolTx();

  const inputIndexes = [];
  for (const u of selected) inputIndexes.push(tx.addInput(protocolInput(u, script, tapInternalKey)));

  for (const o of outputs) {
    tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
  }
  if (opReturnScript) tx.addOutput({ script: opReturnScript, amount: 0n });
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
    changeVout: changeOmitted ? null : outputs.length + (opReturnScript ? 1 : 0),
    outputCount: outputs.length + (opReturnScript ? 1 : 0) + (changeOmitted ? 0 : 1),
    estimatedVsize: Math.ceil(sel.vsize),
    feeRateSatVb: satVb,
  };
}

/**
 * Shared pipeline for a tx whose first inputs are PINNED — spent whatever
 * their value (a SEND's token carriers) — and whose fee is funded by
 * selected inputs. Output order: `preOutputs`, the OP_RETURN,
 * `postOutputs`, then the optional BTC change to `address` (folded into the
 * miner fee when it would be < dust, like MINE's). `pinned` rows must carry
 * their EXACT on-chain `sats`: the segwit / taproot sighash commits to
 * every input's amount. Every input gets RBF_SEQUENCE.
 */
function buildPinnedUnsigned({ address, pubkeyHex, pinned, utxos, tokenOutpoints, feeRateSatVb, preOutputs, opReturnScript, postOutputs = [], minInputSats = 0, selectionOrder }) {
  const { type, script } = decodeAddress(address);
  const tapInternalKey = type === "tr" ? xOnlyFromCompressedHex(pubkeyHex) : null;
  const pinnedKeys = new Set(pinned.map(outpointKey));
  const feeUtxos = (utxos || []).filter((u) => !pinnedKeys.has(outpointKey(u)));
  const spendable = filterSpendable(feeUtxos, tokenOutpoints, { minSats: minInputSats });
  const satVb = checkedFeeRate(feeRateSatVb);

  const fixed = [...preOutputs, ...postOutputs];
  const fixedOutValue = fixed.reduce((s, o) => s + o.value, 0);
  const fixedAddresses = fixed.map((o) => o.address);
  const pinnedValue = pinned.reduce((s, u) => s + u.sats, 0);

  // Selection + fee refinement until they agree (as buildUnsigned);
  // `withChange` says whether the BTC change output is in the estimate and
  // the target.
  const attempt = (plan, withChange) => {
    const outputAddresses = withChange ? fixedAddresses.concat([address]) : fixedAddresses;
    const vsizeFor = (n) => estimateVsize({ inputCount: pinned.length + n, inputType: type, outputAddresses, opReturnScriptLen: opReturnScript.length });
    const sel = convergeSelection({
      spendable,
      targetFor: (fee) => fixedOutValue + fee + (withChange ? DUST_SATS : 0) - pinnedValue,
      feeFor: (n) => Math.ceil(Math.ceil(vsizeFor(n)) * satVb),
      order: plan.order,
      minEffectiveSats: plan.minEffectiveSats,
      onEmpty: () => noSpendableError(address, minInputSats),
    });
    return { ...sel, vsize: vsizeFor(sel.selected.length) };
  };

  const run = firstFeasible(selectionPlans(selectionOrder ?? defaultOrder(minInputSats), inputCostSats(type, satVb)), attempt);
  const sel = run.sel;
  let changeOmitted = run.changeOmitted;
  const { selected, total, fee } = sel;
  const change = pinnedValue + total - fixedOutValue - fee;
  if (change < 0) throw insufficientFundsError(fixedOutValue + fee - pinnedValue, total, selected.length);
  if (!changeOmitted && change < DUST_SATS) changeOmitted = true;
  const finalFee = changeOmitted ? fee + change : fee;

  const tx = newProtocolTx();
  const inputIndexes = [];
  for (const u of [...pinned, ...selected]) inputIndexes.push(tx.addInput(protocolInput(u, script, tapInternalKey)));
  for (const o of preOutputs) tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
  tx.addOutput({ script: opReturnScript, amount: 0n });
  for (const o of postOutputs) tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
  if (!changeOmitted) tx.addOutputAddress(address, BigInt(change), NETWORK);

  const fixedCount = preOutputs.length + 1 + postOutputs.length;
  return {
    psbtHex: hex.encode(tx.toPSBT()),
    feeSats: finalFee,
    inputIndexes,
    inputs: [...pinned, ...selected].map((u) => ({ txid: u.txid, vout: u.vout, sats: Number(u.sats) })),
    changeSats: changeOmitted ? 0 : change,
    changeOmitted,
    changeVout: changeOmitted ? null : fixedCount,
    outputCount: fixedCount + (changeOmitted ? 0 : 1),
    estimatedVsize: Math.ceil(sel.vsize),
    feeRateSatVb: satVb,
  };
}

// ---- DEPLOY (§2.1) ---------------------------------------------------------------------------

/**
 * Build an unsigned DEPLOY PSBT (§2.1): vout0 546 → self (the deployer's
 * proof output), vout1 exactly 5,460 → PROJECT_FEE_ADDRESS (a consensus
 * rule), vout2 `{"p":"lucky-20","op":"deploy","tick":"<TICKER>"}`, vout3
 * optional change (DEPLOY_CHANGE_VOUT; sub-dust change folds into the fee,
 * `changeVout: null`). A DEPLOY names no output: a token UTXO spent here
 * would have its tokens default-routed to vout0 (the proof output) — moved,
 * not gone, but never intended — so the §4 filter applies as for every
 * builder. Every input signals replace-by-fee and the lock time is
 * PROTOCOL_LOCKTIME, like every tx this module builds; the change is what a
 * Speed up takes its extra fee from, so the Create page passes
 * `selectionOrder: "largest"` to leave as much of it as it can.
 */
export function buildDeployPsbt({ address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb, ticker, minInputSats = 0, selectionOrder }) {
  const payload = buildDeployPayload(ticker);
  return buildUnsigned({
    address,
    pubkeyHex,
    utxos,
    tokenOutpoints,
    feeRateSatVb,
    outputs: [
      { address, value: DUST_SATS }, //                                          vout0 deployer proof
      { address: PROJECT_FEE_ADDRESS, value: DEPLOY_PROTOCOL_FEE_SATS }, //      vout1 fee (5,460)
    ],
    opReturnData: payload, //                                                     vout2
    requireChange: false, //                                                      vout3 optional
    minInputSats,
    selectionOrder,
  });
}

/** Display-only fee preview for a DEPLOY (`inputCount` inputs of the wallet's type; proof, fee, OP_RETURN, change). Clamps instead of throwing. */
export function estimateDeployFeeSats({ address, ticker, feeRateSatVb, inputCount = 1 }) {
  const type = isP2tr(address) ? "tr" : "wpkh";
  const payload = buildDeployPayload(ticker);
  const vsize = estimateVsize({
    inputCount,
    inputType: type,
    outputAddresses: [address, PROJECT_FEE_ADDRESS, address],
    opReturnScriptLen: makeOpReturnScript(payload).length,
  });
  const rate = Math.min(MAX_FEE_RATE_SAT_VB, Math.max(1, Number(feeRateSatVb) || 1));
  return { vsize: Math.ceil(vsize), feeSats: Math.ceil(Math.ceil(vsize) * rate) };
}

// ---- Speed up (BIP125 replace-by-fee) ------------------------------------------------------

/** Script-byte vsize of one output (8 value + length prefix + script). */
function outputScriptVsize(script) {
  const n = script.length;
  return 8 + (n < 0xfd ? 1 : 3) + n;
}

/**
 * Estimated vsize of an UNSIGNED PSBT built by this module (same model as
 * estimateVsize: P2TR key-path 57.5 vB, P2WPKH 68 vB per input).
 */
export function psbtVsize(psbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });
  let v = VSIZE_TX_OVERHEAD;
  for (let i = 0; i < tx.inputsLength; i++) {
    const s = tx.getInput(i).witnessUtxo?.script;
    v += s && s.length === 34 && s[0] === 0x51 ? VSIZE_P2TR_INPUT : VSIZE_P2WPKH_INPUT;
  }
  for (let i = 0; i < tx.outputsLength; i++) v += outputScriptVsize(tx.getOutput(i).script);
  return v;
}

/** The fee an unsigned PSBT pays: Σ witnessUtxo amounts − Σ outputs (sats). */
export function psbtFeeSats(psbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });
  let fee = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).witnessUtxo;
    if (!w) throw new Error(`input ${i} has no witnessUtxo — the fee cannot be computed`);
    fee += w.amount;
  }
  for (let i = 0; i < tx.outputsLength; i++) fee -= tx.getOutput(i).amount;
  return Number(fee);
}

/** Bitcoin Core's default incremental relay fee (sat/vB) when the indexer does not report one. */
export const DEFAULT_INCREMENTAL_RELAY_FEE = 1;

/**
 * "Speed up" a pending transaction this app built (BIP125 replace-by-fee):
 * the SAME inputs (same sequences), the SAME outputs and the same lock
 * time, with a higher fee taken from the BTC change output at `changeVout`.
 * `psbtHex` is the UNSIGNED PSBT of the pending tx (the flow keeps it);
 * the result must be signed and broadcast again, and it replaces the
 * pending tx in the mempool.
 *
 * The new fee is max(ceil(vsize × feeRateSatVb), old fee + ceil(increment
 * × vsize)) — BIP125 rules 3 and 4 (a replacement pays more in total AND
 * for its own relay). Throws `code: "speedup-no-change"` when there is no
 * change output, `code: "speedup-change-too-small"` when the change cannot
 * pay the difference and stay ≥ 546 sats (the tx would need another input
 * — not a "same inputs" replacement), `code: "speedup-not-rbf"` when an
 * input does not signal replace-by-fee.
 *
 * → { psbtHex, feeSats, oldFeeSats, feeRateSatVb, oldFeeRateSatVb, vsize, changeSats, minFeeSats, inputIndexes }
 */
export function buildSpeedUpPsbt({ psbtHex, changeVout, feeRateSatVb, incrementalRelayFee = DEFAULT_INCREMENTAL_RELAY_FEE }) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });
  for (let i = 0; i < tx.inputsLength; i++) {
    const seq = tx.getInput(i).sequence ?? 0xffffffff;
    if (seq > 0xfffffffd) {
      throw Object.assign(new Error("this transaction does not signal replace-by-fee, so it cannot be sped up"), { code: "speedup-not-rbf" });
    }
  }
  if (!Number.isInteger(changeVout) || changeVout < 0 || changeVout >= tx.outputsLength || isOpReturnScript(tx.getOutput(changeVout).script)) {
    throw Object.assign(new Error("this transaction has no change output to take a higher fee from, so it cannot be sped up — wait for it to confirm"), { code: "speedup-no-change" });
  }
  const vsize = Math.ceil(psbtVsize(psbtHex));
  const oldFee = psbtFeeSats(psbtHex);
  const rate = checkedFeeRate(feeRateSatVb);
  const inc = Number.isFinite(Number(incrementalRelayFee)) && Number(incrementalRelayFee) > 0 ? Number(incrementalRelayFee) : DEFAULT_INCREMENTAL_RELAY_FEE;
  const minFee = oldFee + Math.ceil(inc * vsize);
  const newFee = Math.max(Math.ceil(vsize * rate), minFee);
  const change = Number(tx.getOutput(changeVout).amount);
  const newChange = change - (newFee - oldFee);
  if (newChange < DUST_SATS) {
    throw Object.assign(
      new Error(
        `the change output (${change.toLocaleString("en-US")} sats) cannot pay a ${newFee.toLocaleString("en-US")}-sat fee and stay above ${DUST_SATS} sats — ` +
          "a faster version would need another input; wait for this one to confirm",
      ),
      { code: "speedup-change-too-small", minFeeSats: minFee },
    );
  }
  tx.updateOutput(changeVout, { amount: BigInt(newChange) });
  const round2 = (x) => Math.round(x * 100) / 100;
  return {
    psbtHex: hex.encode(tx.toPSBT()),
    feeSats: newFee,
    oldFeeSats: oldFee,
    feeRateSatVb: round2(newFee / vsize),
    oldFeeRateSatVb: round2(oldFee / vsize),
    vsize,
    changeSats: newChange,
    minFeeSats: minFee,
    inputIndexes: Array.from({ length: tx.inputsLength }, (_, i) => i),
  };
}

/**
 * The lowest sat/vB a "Speed up" of `psbtHex` can use: the old fee plus the
 * relay increment, over its vsize, rounded UP to hundredths. Pure preview.
 */
export function speedUpFloorRate(psbtHex, incrementalRelayFee = DEFAULT_INCREMENTAL_RELAY_FEE) {
  const vsize = Math.ceil(psbtVsize(psbtHex));
  const inc = Number.isFinite(Number(incrementalRelayFee)) && Number(incrementalRelayFee) > 0 ? Number(incrementalRelayFee) : DEFAULT_INCREMENTAL_RELAY_FEE;
  const minFee = psbtFeeSats(psbtHex) + Math.ceil(inc * vsize);
  return Math.ceil((minFee / vsize) * 100) / 100;
}

/**
 * The highest sat/vB a "Speed up" of `psbtHex` can pay from its change
 * output at `changeVout` and still keep that output ≥ 546 sats: (old fee +
 * change − 546) over its vsize, rounded DOWN to hundredths. 0 when
 * `changeVout` is not a usable output (no change: no Speed up at all).
 * Pure preview, same inputs as buildSpeedUpPsbt.
 */
export function speedUpCeilingRate(psbtHex, changeVout) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });
  if (!Number.isInteger(changeVout) || changeVout < 0 || changeVout >= tx.outputsLength) return 0;
  const out = tx.getOutput(changeVout);
  if (isOpReturnScript(out.script)) return 0;
  const change = Number(out.amount);
  const vsize = Math.ceil(psbtVsize(psbtHex));
  const room = psbtFeeSats(psbtHex) + change - DUST_SATS;
  if (!(vsize > 0) || room <= 0) return 0;
  return Math.floor((room / vsize) * 100) / 100;
}

/**
 * Build an unsigned MINE PSBT.
 *
 * @returns {{ psbtHex: string, feeSats: number, inputIndexes: number[], ... }}
 */
export function buildMinePsbt({ address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb, ticker, minInputSats = 0, selectionOrder }) {
  const payload = buildMinePayload(ticker);
  return buildUnsigned({
    address,
    pubkeyHex,
    utxos,
    tokenOutpoints,
    feeRateSatVb,
    outputs: [
      { address, value: DUST_SATS },                               // vout0 yield output
      { address: PROJECT_FEE_ADDRESS, value: MINE_PROTOCOL_FEE_SATS }, // vout1 fee
    ],
    opReturnData: payload,                                         // vout2
    requireChange: false,                                          // vout3 optional
    minInputSats,
    selectionOrder,
  });
}

/** SEND reference layout (§2.3): vout0 is the 546-sat protocol fee output. */
export const SEND_FEE_VOUT = 0;
/** vout1 receives AMT, vout2 the rest of the input pool (every ticker) — fixed by the protocol (§1). */
export { SEND_TO_VOUT, SEND_RESIDUAL_VOUT };
/** vout of a SEND's OP_RETURN payload. */
export const SEND_OP_RETURN_VOUT = 3;
/** vout of the optional BTC change output of a SEND (present only when ≥ 546 sats). */
export const SEND_BTC_CHANGE_VOUT = 4;

/**
 * Display-only fee preview for a SEND (`carrierCount` carrier inputs +
 * `inputCount` fee inputs of the wallet's type; fee, recipient, residual,
 * OP_RETURN and a change output). Clamps instead of throwing.
 */
export function estimateSendFeeSats({ address, toAddress, ticker, amount = 1, feeRateSatVb, inputCount = 1, carrierCount = 1 }) {
  const type = isP2tr(address) ? "tr" : "wpkh";
  const payload = buildSendPayload({ ticker, amount });
  const vsize = estimateVsize({
    inputCount: carrierCount + inputCount,
    inputType: type,
    outputAddresses: [PROJECT_FEE_ADDRESS, toAddress || address, address, address],
    opReturnScriptLen: makeOpReturnScript(payload).length,
  });
  const rate = Math.min(MAX_FEE_RATE_SAT_VB, Math.max(1, Number(feeRateSatVb) || 1));
  return { vsize: Math.ceil(vsize), feeSats: Math.ceil(Math.ceil(vsize) * rate), slotSats: DUST_SATS * 2 + SEND_PROTOCOL_FEE_SATS };
}

/**
 * Build an unsigned SEND PSBT (§2.3 layout — see the header). `tokenUtxos`
 * are the sender's token-bearing outpoints for `ticker` (from /utxos/:addr);
 * they are spent as inputs so their balances form the tx's input pool.
 *
 * Every token output is a 546-sat output: vout1 (the recipient, AMT) and
 * vout2 (the residual output, ALWAYS present — the protocol routes the rest
 * of the pool there even when it is 0; without it the rest would go to the
 * default output, which in this layout is the fee output at vout0). BTC
 * change is a separate vout4 that exists only when it is ≥ 546 sats; below
 * that it folds into the miner fee exactly like MINE's change. A SEND to
 * yourself (a split, a withdraw, a cancel) is the same builder with
 * `toAddress = address`: vout1 is then the new carrier.
 *
 * @returns {{ psbtHex, feeSats, inputIndexes, inputs, changeSats, changeOmitted, changeVout, residualVout, outputCount, feeRateSatVb }}
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
  minInputSats = 0,
  selectionOrder,
}) {
  decodeRecipientAddress(toAddress);
  if (scriptHexOfAddress(toAddress) === scriptHexOfAddress(PROJECT_FEE_ADDRESS)) {
    throw new Error("the protocol fee address cannot receive a SEND");
  }
  const payload = buildSendPayload({ ticker, amount });

  // Token carriers are pinned as inputs (their balances form the input pool)
  // and the fee selector funds the rest. They MUST be spent at their EXACT
  // on-chain value: the segwit/taproot sighash commits to each input's
  // amount, so a wrong witnessUtxo.amount yields an invalid signature (tx
  // rejected) and wrong fee/change math. This builder only ever makes
  // 546-sat carriers, but the indexer's settlement is index-agnostic and a
  // third-party builder may have parked tokens on a fatter output — never
  // assume 546. Resolve each carrier's sats from the wallet's full UTXO list
  // (the indexer's /btc-utxos includes token dust; UniSat's own list may
  // not) and refuse to build otherwise.
  const satsByKey = new Map((utxos || []).map((u) => [outpointKey(u), Number(u.sats)]));
  const carriers = (tokenUtxos || []).map((u) => {
    const own = Number(u.sats);
    const sats = Number.isInteger(own) && own > 0 ? own : satsByKey.get(outpointKey(u));
    if (!Number.isInteger(sats) || sats <= 0) {
      throw new Error(
        `token UTXO ${u.txid}:${u.vout} has no known BTC value: the indexer does not list it among this address's outputs right now ` +
          `(the signature commits to the exact value) — try again after the next block`,
      );
    }
    return { txid: u.txid, vout: u.vout, sats };
  });
  if (carriers.length === 0) {
    throw new Error(`no ${ticker} token UTXOs at ${address} to spend`);
  }
  // Fixed layout: the fee, the recipient and the residual output before the
  // OP_RETURN — the last two 546-sat carriers — then the optional BTC change
  // (vout4, folded into the fee when < 546). The residual output (vout2) is
  // part of the fixed layout and is never folded.
  const built = buildPinnedUnsigned({
    address,
    pubkeyHex,
    pinned: carriers,
    utxos,
    tokenOutpoints,
    feeRateSatVb,
    preOutputs: [
      { address: PROJECT_FEE_ADDRESS, value: SEND_PROTOCOL_FEE_SATS }, // vout0 fee
      { address: toAddress, value: DUST_SATS }, //                        vout1 recipient (AMT)
      { address, value: DUST_SATS }, //                                   vout2 residual output — always
    ],
    opReturnScript: makeOpReturnScript(payload), //                       vout3
    minInputSats, //                                                      vout4 optional BTC change
    selectionOrder,
  });
  return { ...built, residualVout: SEND_RESIDUAL_VOUT };
}
