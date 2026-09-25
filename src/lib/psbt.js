// Unsigned PSBT construction for LuckyProtocol DEPLOY / MINE / SEND (spec §4 + §6).
//
// The web app holds no keys. This module selects BTC inputs, lays out the
// protocol outputs in the exact order the indexer expects, and returns an
// UNSIGNED PSBT (hex) that the UniSat extension signs + finalizes.
//
// DEPLOY layout (§2.1): vout0 546 → self (deployer proof)
//                       vout1 5,460 → PROJECT_FEE_ADDRESS
//                       vout2 OP_RETURN  LUCKY-20|DEPLOY|<TICKER>
//                       vout3 change → self (omitted if < dust; folded into fee)
//
// MINE layout (§2.2):   vout0 546 → self (yield slot)
//                       vout1 546 → PROJECT_FEE_ADDRESS
//                       vout2 OP_RETURN  LUCKY-20|MINE|<TICKER>
//                       vout3 change → self (omitted if < dust; folded into fee)
//
// SEND layout (§2.3, H-1(A) — token carriers are ALWAYS 546-sat outputs):
//                       vout0 546 → recipient          (TO_OUT = 0)
//                       vout1 546 → PROJECT_FEE_ADDRESS
//                       vout2 OP_RETURN  LUCKY-20|SEND|<TICKER>|<AMT>|0|3
//                       vout3 546 → self               (CHANGE_OUT = 3: the residual
//                                                       token slot — ALWAYS present,
//                                                       even when the residual is 0)
//                       vout4 BTC change → self        (optional; folded into the fee
//                                                       when < 546)
//
// Builder obligation (§4): never spend a token-bearing UTXO as a fee input.
// Every UTXO with value ≤ 546 sats is dropped (all LuckyProtocol carriers are
// 546-sat outputs), and every outpoint the indexer reports as token-bearing
// is excluded explicitly. Under DEFAULT ROUTING a payload-less spend of a
// carrier does not destroy its tokens — it hands them to the tx's first
// non-OP_RETURN output — so a carrier spent as a fee input would GIFT its
// tokens to whoever that output pays.
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
  buildDeployPayload,
  buildMinePayload,
  buildSendPayload,
  parsePayload,
  payloadToString,
} from "./payloads.js";

export const NETWORK = btc.NETWORK; // mainnet

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

export function isP2tr(address) {
  return typeof address === "string" && address.startsWith("bc1p");
}

export function outputVsize(address) {
  return isP2tr(address) ? VSIZE_P2TR_OUTPUT : VSIZE_P2WPKH_OUTPUT;
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
 */
export function extractRawTxHex(signedPsbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(signedPsbtHex));
  const raw = hex.encode(tx.extract());
  assertSingleOpReturn(raw);
  return raw;
}

/**
 * Broadcast-time guard (audit M-3): count the OP_RETURN outputs (byte-0
 * 0x6a) of a raw tx and refuse more than one. A wallet or aggregator that
 * appends its own OP_RETURN (memo, runestone) to one of our protocol txs
 * would otherwise turn it into "not a protocol tx" for an indexer that
 * rejects multi-OP_RETURN transactions — and default routing would then
 * move the whole input pool to the tx's first output.
 * Zero OP_RETURNs is fine (plain payments, the avatar commit / sweep).
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

// ---- OP_RETURN payload rule (mirrors the indexer, PROTOCOL-v3.md §2) ------------------------
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
    const text = payloadToString(data);
    const p = parsePayload(text);
    if (p) {
      payload = p;
      payloadText = text;
      payloadVout = vout;
    }
  });
  return { opReturnCount, payload, payloadText, payloadVout };
}

function psbtOutputScripts(psbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
  const scripts = [];
  for (let i = 0; i < tx.outputsLength; i++) scripts.push(tx.getOutput(i).script);
  return scripts;
}

/**
 * Sign-time guard (audit M-1 / M-3): before a PSBT goes to the wallet,
 * assert that its OP_RETURN says what the flow believes it says.
 *
 *   expectPsbtPayload(hex, { op: "SEND", ticker: "LUCKY", amount: 100 })
 *   expectPsbtPayload(hex, { op: null })          // a plain payment: no OP_RETURN at all
 *
 * Throws on: more than one OP_RETURN output, a missing / unparsable
 * payload, the wrong opcode, ticker or amount. Returns the parsed payload
 * (null for a plain payment).
 */
export function expectPsbtPayload(psbtHex, expect = {}) {
  const found = protocolPayloadOfScripts(psbtOutputScripts(psbtHex));
  return checkExpectedPayload(found, expect);
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

export const outpointKey = (u) => `${u.txid}:${u.vout}`;

/**
 * Fee-input floor when the UTXO list is NOT asset-safe (OKX Wallet and the
 * mock have no asset-aware list; the indexer's raw BTC view cannot tell an
 * inscription or rune carrier from plain BTC). ord's default postage is
 * 10,000 sats, so anything below it is treated as a possible carrier and
 * never spent as a fee input (audit M-8). Runes are still not detectable
 * this way — the notice says so.
 */
export const MIN_FEE_INPUT_SATS_UNSAFE = 10_000;

/** The `minInputSats` a builder should use for a UTXO list with this `assetSafe` flag. */
export function minFeeInputSats(assetSafe) {
  return assetSafe === true ? 0 : MIN_FEE_INPUT_SATS_UNSAFE;
}

/**
 * Apply the §4 builder obligation: drop every UTXO with value ≤ DUST_SATS
 * and every outpoint listed in `tokenOutpoints`; with `minSats`, also drop
 * everything below that floor (see MIN_FEE_INPUT_SATS_UNSAFE). Returns
 * spendable rows.
 */
export function filterSpendable(utxos, tokenOutpoints, { minSats = 0 } = {}) {
  const exclude = new Set((tokenOutpoints || []).map(outpointKey));
  const floor = Number.isFinite(Number(minSats)) ? Number(minSats) : 0;
  return (utxos || []).filter((u) => {
    const sats = Number(u.sats);
    if (!Number.isInteger(sats) || sats <= DUST_SATS) return false;
    if (sats < floor) return false;
    if (exclude.has(outpointKey(u))) return false;
    return true;
  });
}

/** The "nothing to spend" error, naming the floor when one was applied. */
export function noSpendableError(address, minSats) {
  if (minSats > DUST_SATS) {
    return new Error(
      `no usable fee input at ${address}: this wallet has no asset-safe UTXO list, so only outputs of at least ` +
      `${minSats.toLocaleString("en-US")} sats that are not token-bearing are spent (smaller ones may carry Ordinals) — ` +
      `send more than ${minSats.toLocaleString("en-US")} sats of plain BTC to this address, or use a wallet with an asset-safe UTXO list`,
    );
  }
  return new Error(`no spendable BTC at ${address} — every UTXO is either ≤ ${DUST_SATS} sats or token-bearing`);
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
 * `requireChange`: refuse to build unless the change output exists (≥
 * dust). No current caller needs it — DEPLOY / MINE / the avatar commit
 * route nothing through their change output, and SEND has its own builder
 * whose residual slot is a fixed 546-sat output — so sub-dust change folds
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
}) {
  const { type, script } = decodeAddress(address);
  const tapInternalKey = type === "tr" ? xOnlyFromCompressedHex(pubkeyHex) : null;

  const spendable = filterSpendable(utxos, tokenOutpoints, { minSats: minInputSats });
  if (spendable.length === 0) throw noSpendableError(address, minInputSats);

  const satVb = checkedFeeRate(feeRateSatVb);

  // `opReturnData: null` → a plain payment (no protocol output; §8.5 commit).
  const opReturnScript = opReturnData ? makeOpReturnScript(opReturnData) : null;
  const opReturnLen = opReturnScript ? opReturnScript.length : 0;
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
        opReturnScriptLen: opReturnLen,
      });
      const newFee = Math.ceil(vsize * satVb);
      if (newFee === fee) break;
      fee = newFee;
    }
    return { selected, total, fee, vsize: estimateVsize({
      inputCount: selected.length, inputType: type, outputAddresses, opReturnScriptLen: opReturnLen,
    }) };
  };

  // Prefer a real change output. Only when the wallet cannot cover the
  // dust headroom do we fall back to folding sub-dust change into the
  // miner fee (unless the caller set requireChange).
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
    // loudly rather than silently dropping a required change slot.
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
 * Build an unsigned plain payment: one output of `amountSats` to `toAddress`
 * plus change to `address` (sub-dust change folds into the fee). No
 * OP_RETURN — this is NOT a protocol tx, which is exactly why the §4 filter
 * matters: a token-bearing input here would hand its tokens to vout0, the
 * commit address, where they would be stuck. Used for the §8.5 avatar
 * commit (paying the commit P2TR address).
 */
export function buildPayPsbt({ address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb, toAddress, amountSats, minInputSats = 0 }) {
  decodeAddress(toAddress);
  const amount = Number(amountSats);
  if (!Number.isInteger(amount) || amount < DUST_SATS) {
    throw new Error(`payment amount must be an integer ≥ ${DUST_SATS} sats`);
  }
  return buildUnsigned({
    address,
    pubkeyHex,
    utxos,
    tokenOutpoints,
    feeRateSatVb,
    outputs: [{ address: toAddress, value: amount }], // vout0 payment
    opReturnData: null,
    requireChange: false,                             // vout1 change, optional
    minInputSats,
  });
}

/** Display-only fee preview for a plain payment (one input of the wallet's type, payment + change). */
export function estimatePayFeeSats({ address, toAddress, feeRateSatVb, inputCount = 1 }) {
  const type = isP2tr(address) ? "tr" : "wpkh";
  const vsize = estimateVsize({ inputCount, inputType: type, outputAddresses: [toAddress, address], opReturnScriptLen: 0 });
  const rate = Math.min(MAX_FEE_RATE_SAT_VB, Math.max(1, Number(feeRateSatVb) || 1));
  return { vsize: Math.ceil(vsize), feeSats: Math.ceil(vsize * rate) };
}

/**
 * Build an unsigned DEPLOY PSBT (§2.1). The 5,460-sat protocol fee output
 * is a consensus rule; vout0 is the deployer's proof output. DEPLOY has no
 * token routing, so — like MINE — sub-dust change may fold into the fee.
 * The §4 filter matters here too: DEPLOY routes nothing, so a token UTXO
 * spent as a fee input would have its tokens default-routed to vout0 (the
 * deployer's proof output) — moved, not gone, but never intended.
 */
export function buildDeployPsbt({ address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb, ticker, minInputSats = 0 }) {
  const payload = buildDeployPayload(ticker);
  return buildUnsigned({
    address,
    pubkeyHex,
    utxos,
    tokenOutpoints,
    feeRateSatVb,
    outputs: [
      { address, value: DUST_SATS },                                    // vout0 deployer proof
      { address: PROJECT_FEE_ADDRESS, value: DEPLOY_PROTOCOL_FEE_SATS }, // vout1 fee (5,460)
    ],
    opReturnData: payload,                                              // vout2
    requireChange: false,                                               // vout3 optional
    minInputSats,
  });
}

/**
 * Display-only fee preview for the DEPLOY form (one input of the wallet's
 * type + three fixed outputs + change). Clamps instead of throwing.
 */
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
  return { vsize: Math.ceil(vsize), feeSats: Math.ceil(vsize * rate) };
}

/**
 * Build an unsigned MINE PSBT.
 *
 * @returns {{ psbtHex: string, feeSats: number, inputIndexes: number[], ... }}
 */
export function buildMinePsbt({ address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb, ticker, minInputSats = 0 }) {
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
    minInputSats,
  });
}

/** SEND payload indices (§2.3): TO_OUT = vout0, CHANGE_OUT = vout3 (the residual slot). */
export const SEND_TO_OUT = 0;
export const SEND_CHANGE_OUT = 3;
/** vout of the optional BTC change output of a SEND (present only when ≥ 546 sats). */
export const SEND_BTC_CHANGE_VOUT = 4;

/**
 * Display-only fee preview for a SEND (one carrier input + `inputCount` fee
 * inputs of the wallet's type; recipient slot, fee, OP_RETURN, residual slot
 * and a change output). Clamps instead of throwing.
 */
export function estimateSendFeeSats({ address, toAddress, ticker, amount = 1, feeRateSatVb, inputCount = 1, carrierCount = 1 }) {
  const type = isP2tr(address) ? "tr" : "wpkh";
  const payload = buildSendPayload({ ticker, amount, toOutIdx: SEND_TO_OUT, changeOutIdx: SEND_CHANGE_OUT });
  const vsize = estimateVsize({
    inputCount: carrierCount + inputCount,
    inputType: type,
    outputAddresses: [toAddress || address, PROJECT_FEE_ADDRESS, address, address],
    opReturnScriptLen: makeOpReturnScript(payload).length,
  });
  const rate = Math.min(MAX_FEE_RATE_SAT_VB, Math.max(1, Number(feeRateSatVb) || 1));
  return { vsize: Math.ceil(vsize), feeSats: Math.ceil(vsize * rate), slotSats: DUST_SATS * 2 + SEND_PROTOCOL_FEE_SATS };
}

/**
 * Build an unsigned SEND PSBT (H-1(A) layout — see the header). `tokenUtxos`
 * are the sender's token-bearing outpoints for `ticker` (from /utxos/:addr);
 * they are spent as inputs so their balances form the tx's input pool.
 *
 * Every token slot is a 546-sat output: vout0 (recipient) and vout3 (the
 * residual slot, ALWAYS present — the payload commits CHANGE_OUT = 3 and
 * the indexer routes the residual pool there even when it is 0). BTC change
 * is a separate vout4 that exists only when it is ≥ 546 sats; below that it
 * folds into the miner fee exactly like MINE's change.
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
}) {
  decodeAddress(toAddress);
  const payload = buildSendPayload({ ticker, amount, toOutIdx: SEND_TO_OUT, changeOutIdx: SEND_CHANGE_OUT });

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
  const spendable = filterSpendable(feeUtxos, tokenOutpoints, { minSats: minInputSats });

  const satVb = checkedFeeRate(feeRateSatVb);

  // Fixed layout: the two slots before the OP_RETURN and the residual slot
  // after it. All three are 546-sat carriers.
  const preOutputs = [
    { address: toAddress, value: DUST_SATS },                          // vout0 recipient slot
    { address: PROJECT_FEE_ADDRESS, value: SEND_PROTOCOL_FEE_SATS },   // vout1 fee
  ];
  const residualOutput = { address, value: DUST_SATS };                // vout3 residual slot
  const opReturnScript = makeOpReturnScript(payload);
  const fixedOutValue = preOutputs.reduce((s, o) => s + o.value, 0) + residualOutput.value;
  const fixedAddresses = preOutputs.map((o) => o.address).concat([residualOutput.address]);
  const carrierValue = carriers.reduce((s, u) => s + u.sats, 0);

  // Same iterative selection + fee refinement as buildUnsigned; `withChange`
  // says whether vout4 (BTC change) is in the estimate and the target.
  const attempt = (withChange) => {
    const outputAddresses = withChange ? fixedAddresses.concat([address]) : fixedAddresses;
    let selected = [];
    let total = 0;
    let fee = 0;
    for (let pass = 0; pass < 3; pass++) {
      const target = fixedOutValue + fee + (withChange ? DUST_SATS : 0) - carrierValue;
      if (target > 0) {
        if (spendable.length === 0) throw noSpendableError(address, minInputSats);
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
    const vsize = estimateVsize({ inputCount: carriers.length + selected.length, inputType: type, outputAddresses, opReturnScriptLen: opReturnScript.length });
    return { selected, total, fee, vsize };
  };

  // Prefer a real BTC change output; when the wallet cannot cover the dust
  // headroom, fold the remainder into the fee. The residual TOKEN slot
  // (vout3) is part of the fixed layout and is never folded.
  let sel;
  let changeOmitted = false;
  try {
    sel = attempt(true);
  } catch (e) {
    if (!/insufficient funds/.test(String(e.message))) throw e;
    sel = attempt(false);
    changeOmitted = true;
  }
  const { selected, total, fee } = sel;

  const change = carrierValue + total - fixedOutValue - fee;
  if (change < 0) {
    throw new Error(`insufficient funds after fee (${fee.toLocaleString("en-US")} sats)`);
  }
  if (!changeOmitted && change < DUST_SATS) changeOmitted = true;
  const finalFee = changeOmitted ? fee + change : fee;

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
  for (const o of preOutputs) tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);      // vout0, vout1
  tx.addOutput({ script: opReturnScript, amount: 0n });                                        // vout2
  tx.addOutputAddress(residualOutput.address, BigInt(residualOutput.value), NETWORK);         // vout3 — always
  if (!changeOmitted) tx.addOutputAddress(address, BigInt(change), NETWORK);                  // vout4 — optional

  return {
    psbtHex: hex.encode(tx.toPSBT()),
    feeSats: finalFee,
    inputIndexes,
    inputs: [...carriers, ...selected].map((u) => ({ txid: u.txid, vout: u.vout, sats: Number(u.sats) })),
    changeSats: changeOmitted ? 0 : change,
    changeOmitted,
    changeVout: changeOmitted ? null : SEND_BTC_CHANGE_VOUT,
    residualVout: SEND_CHANGE_OUT,
    outputCount: 4 + (changeOmitted ? 0 : 1),
    estimatedVsize: Math.ceil(sel.vsize),
    feeRateSatVb: satVb,
  };
}
