// The signature type (sighash byte) of a transaction input, read the way
// the indexer reads it from a block (PROTOCOL.md §2 "Signature type of an
// input"). Pure: plain data in, plain data out.
//
// Three rules depend on it:
//   - DEPLOY deployer attribution (§2.1) counts only inputs of type 0x00 or
//     0x01 — the inputs that signed the whole transaction;
//   - an input of type 0x83 (SIGHASH_SINGLE|ANYONECANPAY, the signature of
//     every §7 listing) whose paired output vout[i] exists and is not an
//     OP_RETURN is LISTING-SIGNED: its tokens move only through an applied
//     SEND of their ticker, and otherwise go to vout[i] (§4 rule 6);
//   - a spend of a listed outpoint is a fill only when that input is of
//     type 0x83 (§7.5).
//
// So the type decides balances, and a wallet that signs one of this app's
// DEPLOY, MINE or SEND transactions with 0x83 would move tokens to vout[i]
// (in the SEND layout, input 0 pairs with the fee output). After every
// signature the wallet layer compares the types with the ones it asked for
// (signedSighashMismatch).

import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";

/** SIGHASH_SINGLE | SIGHASH_ANYONECANPAY — the sighash of every listing signature. */
export const LISTING_SIGHASH_BYTE = 0x83;

/**
 * The script type of the output an address pays, as far as the signature
 * rules care: "tr" (P2TR, a 32-byte v1 program), "wpkh" (P2WPKH, a 20-byte
 * v0 program), or null for anything else.
 */
export function listedScriptType(address) {
  const a = String(address || "");
  if (/^bc1p[02-9ac-hj-np-z]{58}$/.test(a)) return "tr";
  if (/^bc1q[02-9ac-hj-np-z]{38}$/.test(a)) return "wpkh";
  return null;
}

/**
 * The script type of a scriptPubKey given as hex: "tr" for `5120` + 32
 * bytes, "wpkh" for `0014` + 20 bytes, else null (§2: only these two
 * yield a signature type).
 */
export function scriptTypeOfHex(spkHex) {
  const s = String(spkHex || "").toLowerCase();
  if (/^5120[0-9a-f]{64}$/.test(s)) return "tr";
  if (/^0014[0-9a-f]{40}$/.test(s)) return "wpkh";
  return null;
}

/**
 * The sighash byte an input's witness (hex elements, `decodeRawTx`
 * `witnesses[i]`) was signed with, read from its signature the way the
 * indexer reads it from the block, for the script type of the output it
 * spends (`prevoutType`, listedScriptType / scriptTypeOfHex):
 *   "tr" (key path) — one element once an annex (a last element starting
 *     0x50, when there are at least two) is set aside: a 64-byte
 *     signature is SIGHASH_DEFAULT (0x00), a 65-byte one ends with its
 *     sighash byte;
 *   "wpkh" — two elements, a DER signature of 9–73 bytes first: its last
 *     byte.
 * Null for any other shape or script type (null included: an input whose
 * spent output is neither P2TR nor P2WPKH has no type). Without
 * `prevoutType` (undefined) the type is guessed from the witness shape (a
 * 33-byte second element reads as a P2WPKH key) — the indexer never
 * guesses, so a consensus-shaped caller always passes a type.
 */
export function inputSighash(witness, prevoutType) {
  const w = Array.isArray(witness) ? witness.map((x) => String(x || "").toLowerCase()) : [];
  const bytes = (h) => h.length / 2;
  const type = prevoutType === undefined ? (w.length === 2 && bytes(w[1]) === 33 && !w[1].startsWith("50") ? "wpkh" : "tr") : prevoutType;
  if (type === "tr") {
    const annex = w.length >= 2 && w[w.length - 1].startsWith("50");
    if (w.length - (annex ? 1 : 0) !== 1) return null;
    if (bytes(w[0]) === 64) return 0x00;
    if (bytes(w[0]) === 65) return parseInt(w[0].slice(-2), 16);
    return null;
  }
  if (type === "wpkh") {
    if (w.length !== 2 || bytes(w[0]) < 9 || bytes(w[0]) > 73) return null;
    return parseInt(w[0].slice(-2), 16);
  }
  return null;
}

const readPsbt = (psbtHex) =>
  btc.Transaction.fromPSBT(hex.decode(String(psbtHex || "")), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });

/** The signature type of one decoded PSBT input (signedInputSighash). */
function typeOfPsbtInput(input) {
  const type = input.witnessUtxo?.script ? scriptTypeOfHex(hex.encode(input.witnessUtxo.script)) : null;
  if (Array.isArray(input.finalScriptWitness) && input.finalScriptWitness.length) {
    return inputSighash(input.finalScriptWitness.map((e) => hex.encode(e)), type);
  }
  if (type === "tr" && input.tapKeySig instanceof Uint8Array) {
    if (input.tapKeySig.length === 64) return 0x00;
    if (input.tapKeySig.length === 65) return input.tapKeySig[64];
    return null;
  }
  if (type === "wpkh" && Array.isArray(input.partialSig) && input.partialSig.length) {
    const sig = input.partialSig[0]?.[1];
    return sig instanceof Uint8Array && sig.length ? sig[sig.length - 1] : null;
  }
  return null;
}

/**
 * The signature type of input `index` of a SIGNED PSBT (hex), read like
 * the indexer reads it. A finalized input: inputSighash over its
 * `finalScriptWitness`, for the type of its `witnessUtxo` script. An input
 * that is signed but not finalized: a P2TR `tapKeySig` of 64 bytes is 0x00,
 * of 65 bytes its last byte; a P2WPKH `partialSig` signature, its last
 * byte. Null when none of these is present (or the PSBT does not read).
 */
export function signedInputSighash(signedPsbtHex, index) {
  try {
    const tx = readPsbt(signedPsbtHex);
    if (!Number.isInteger(index) || index < 0 || index >= tx.inputsLength) return null;
    return typeOfPsbtInput(tx.getInput(index));
  } catch {
    return null;
  }
}

/**
 * After-signing check of the signature TYPES: every input of
 * `inputIndexes` (every input when it is not a list) of the signed PSBT
 * must carry a signature whose type is in `allowed`. → null when they all
 * do, else a phrase for the first one that does not: "input {i} was signed
 * with type 0x{hh}" or "input {i} carries no signature this app can read".
 */
export function signedSighashMismatch(signedPsbtHex, inputIndexes, allowed) {
  const ok = new Set((Array.isArray(allowed) ? allowed : []).map(Number));
  let tx;
  try {
    tx = readPsbt(signedPsbtHex);
  } catch {
    return "the signed result is not a readable PSBT";
  }
  const indexes = Array.isArray(inputIndexes) ? inputIndexes.map(Number) : Array.from({ length: tx.inputsLength }, (_, i) => i);
  for (const i of indexes) {
    const t = Number.isInteger(i) && i >= 0 && i < tx.inputsLength ? typeOfPsbtInput(tx.getInput(i)) : null;
    if (t === null) return `input ${i} carries no signature this app can read`;
    if (!ok.has(t)) return `input ${i} was signed with type 0x${t.toString(16).padStart(2, "0")}`;
  }
  return null;
}
