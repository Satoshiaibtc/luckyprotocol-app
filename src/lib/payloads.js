// LUCKY-20 OP_RETURN payload encoders, the byte-exact payload parser and
// the protocol constants (PROTOCOL.md §1–§2).
//
// A payload is compact JSON, ASCII, in exactly one of three byte forms: no
// whitespace, the keys in this order, no other key.
//
//   DEPLOY:  {"p":"lucky-20","op":"deploy","tick":"<TICKER>"}
//   MINE:    {"p":"lucky-20","op":"mine","tick":"<TICKER>"}
//   SEND:    {"p":"lucky-20","op":"send","tick":"<TICKER>","amt":"<AMT>"}
//
// TICKER is [A-Z0-9]{1,8}; AMT is a decimal string from 1 to 21,000,000
// with no sign and no leading zero. The longest payload is 63 bytes.
//
// Parsing is byte-exact. Every other byte string is not a LUCKY-20
// payload, even JSON with the same meaning: a space or a line break, another
// key order, a missing, extra or repeated key, a number where a string is
// required, an escape sequence, a lower-case ticker, `"p":"LUCKY-20"`, a
// `|`-separated push such as `LUCKY-20|MINE|LUCKY`. An `avatar` op is not a
// payload either (§8). A tx whose push does not parse is a plain spend:
// DEFAULT ROUTING moves every token on its inputs to the tx's first
// non-OP_RETURN output (whoever that pays). So the encoders below are
// narrow, and the parser is a template match, never a JSON parser.
// src/lib/payload_vectors.json, byte-identical to the file the indexer's
// own tests read, pins both sides (test/payload.vectors.test.js).
//
// Outputs are fixed by the operation, never named in the payload: a MINE
// credits vout0; a SEND puts AMT on vout1 (SEND_TO_VOUT) and the rest of the
// input pool, every ticker, on vout2 (SEND_RESIDUAL_VOUT); a DEPLOY names no
// output.

// ---- §1 constants ----------------------------------------------------------

/** The value of the `p` key of every payload (§1 PROTOCOL_ID): the wire id of LUCKY-20. */
export const PROTOCOL_ID = "lucky-20";
export const ACTIVATION_HEIGHT = 969_696;          // spec §1; protocol txs below this height are ignored
export const REQUIRED_TOKEN_SUPPLY = 21_000_000;   // implicit on every DEPLOY
export const DUST_SATS = 546;                      // token-carrier output value
export const PROJECT_FEE_ADDRESS =
  "bc1phk23psaqmq4rlsjeet79xpt65n9v2hvrv97ezc6c4rpld4s2shwqa9qx9n";
export const DEPLOY_PROTOCOL_FEE_SATS = 5_460;
export const MINE_PROTOCOL_FEE_SATS = 546;
export const SEND_PROTOCOL_FEE_SATS = 546;
/** The output that receives a SEND's AMT (§1, §2.3). */
export const SEND_TO_VOUT = 1;
/** The output that receives the rest of a SEND's input pool, every ticker (§1, §2.3). */
export const SEND_RESIDUAL_VOUT = 2;
// Confirmations after which a block's effects are final (§1, §3.1). Defined
// with the other depth helpers; re-exported here so the §1 gate
// (scripts/check-spec.mjs) compares it with the spec like every constant.
export { FINAL_DEPTH } from "./finality.js";
export const MAX_PAYLOAD_BYTES = 80;
export const TICKER_RE = /^[A-Z0-9]{1,8}$/;
/** §1 AMT grammar: whole tokens as decimal digits, no sign, no leading zero (the 21,000,000 cap is checked apart). */
export const AMT_RE = /^[1-9][0-9]{0,7}$/;

/**
 * nLockTime of every DEPLOY, MINE and SEND this app builds:
 * ACTIVATION_HEIGHT − 1, so such a transaction can only confirm in block
 * ACTIVATION_HEIGHT or later. That is what lets the Create and Mine gates
 * open one block early (at tip 969,695) with no risk of an ignored,
 * pre-activation confirmation. Not a consensus constant: the indexer
 * ignores nLockTime; it is the app's own safety net. (A listing and its
 * fill keep nLockTime 0 — the seller's SINGLE|ANYONECANPAY signature
 * commits to it, §7.)
 */
export const PROTOCOL_LOCKTIME = ACTIVATION_HEIGHT - 1;

// ---- validators --------------------------------------------------------------

export function validateTicker(ticker) {
  if (typeof ticker !== "string") {
    throw new Error("ticker must be a string");
  }
  if (ticker.length < 1 || ticker.length > 8) {
    throw new Error(`ticker length ${ticker.length} not in [1, 8]`);
  }
  if (!TICKER_RE.test(ticker)) {
    throw new Error(`ticker "${ticker}" must be A-Z 0-9 only`);
  }
  return ticker;
}

export function isValidTicker(ticker) {
  return typeof ticker === "string" && TICKER_RE.test(ticker);
}

function asciiBytes(s) {
  // OP_RETURN payloads are pure printable ASCII — refuse anything that
  // TextEncoder would expand to multi-byte UTF-8 (the indexer's parser does
  // not decode UTF-8, and multi-byte chars would silently inflate length).
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(`non-ASCII byte 0x${c.toString(16)} at index ${i}`);
    }
  }
  return new TextEncoder().encode(s);
}

function capPayload(bytes) {
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `payload ${bytes.length} bytes exceeds OP_RETURN ${MAX_PAYLOAD_BYTES}-byte standardness limit`,
    );
  }
  return bytes;
}

// ---- encoders ------------------------------------------------------------------

/**
 * `{"p":"lucky-20","op":"deploy","tick":"<TICKER>"}` (§2.1): registers the
 * ticker (supply 21,000,000) when the tx pays exactly
 * DEPLOY_PROTOCOL_FEE_SATS to PROJECT_FEE_ADDRESS and no earlier DEPLOY in
 * block order registered it. Names no output: token inputs go to the
 * default output.
 */
export function buildDeployPayload(ticker) {
  validateTicker(ticker);
  return capPayload(asciiBytes(`{"p":"${PROTOCOL_ID}","op":"deploy","tick":"${ticker}"}`));
}

/**
 * `{"p":"lucky-20","op":"mine","tick":"<TICKER>"}` (§2.2): the yield and
 * the residual of the input pool, every ticker, go to vout0. Nothing else
 * is encoded: the yield is a pure function of the confirming block's hash.
 */
export function buildMinePayload(ticker) {
  validateTicker(ticker);
  return capPayload(asciiBytes(`{"p":"${PROTOCOL_ID}","op":"mine","tick":"${ticker}"}`));
}

/**
 * `{"p":"lucky-20","op":"send","tick":"<TICKER>","amt":"<AMT>"}` (§2.3).
 * `amount` is whole tokens (1 ≤ AMT ≤ 21,000,000). AMT of `ticker` goes to
 * vout1; the rest of the input pool — the rest of `ticker` and every other
 * ticker — goes to vout2, so a builder must always emit vout2 (see
 * buildSendPsbt). A SEND names no output: an index field is refused rather
 * than silently dropped.
 */
export function buildSendPayload({ ticker, amount, ...rest } = {}) {
  if ("toOutIdx" in rest || "changeOutIdx" in rest) {
    throw new Error("a SEND names no output: AMT goes to vout1 and the rest to vout2 (§2.3)");
  }
  validateTicker(ticker);
  if (typeof amount !== "bigint" && typeof amount !== "number") {
    throw new Error("amount must be a number or bigint");
  }
  if (typeof amount === "number" && !Number.isSafeInteger(amount)) {
    throw new Error("SEND amount must be a whole number of tokens");
  }
  const amt = typeof amount === "bigint" ? amount : BigInt(amount);
  if (amt < 1n) throw new Error("SEND amount must be >= 1");
  if (amt > BigInt(REQUIRED_TOKEN_SUPPLY)) {
    throw new Error(`SEND amount exceeds ${REQUIRED_TOKEN_SUPPLY.toLocaleString("en-US")} cap`);
  }
  return capPayload(asciiBytes(`{"p":"${PROTOCOL_ID}","op":"send","tick":"${ticker}","amt":"${amt.toString()}"}`));
}

// ---- parser --------------------------------------------------------------------

// The three templates, byte for byte (§2). `$` without the m flag matches
// only at the very end of the input, so a trailing line break fails too.
const DEPLOY_MINE_RE = /^\{"p":"lucky-20","op":"(deploy|mine)","tick":"([A-Z0-9]{1,8})"\}$/;
const SEND_RE = /^\{"p":"lucky-20","op":"send","tick":"([A-Z0-9]{1,8})","amt":"([1-9][0-9]{0,7})"\}$/;

/**
 * Parse an OP_RETURN payload string, byte-exact (§2):
 *
 *   {"p":"lucky-20","op":"deploy","tick":"T"}          → { op: "DEPLOY", ticker }
 *   {"p":"lucky-20","op":"mine","tick":"T"}            → { op: "MINE", ticker }
 *   {"p":"lucky-20","op":"send","tick":"T","amt":"N"}  → { op: "SEND", ticker, amount }
 *
 * and null for every other string. The returned op names are upper case
 * (the names the app uses everywhere); only the wire spells them in lower
 * case. Used by the mock indexer, by the sign-time guard in psbt.js, by the
 * second-source check and by display code; never by consensus.
 */
export function parsePayload(str) {
  if (typeof str !== "string") return null;
  let m = DEPLOY_MINE_RE.exec(str);
  if (m) return { op: m[1].toUpperCase(), ticker: m[2] };
  m = SEND_RE.exec(str);
  if (m) {
    const amount = Number(m[2]);
    if (amount <= REQUIRED_TOKEN_SUPPLY) return { op: "SEND", ticker: m[1], amount };
  }
  return null;
}

/**
 * parsePayload over the pushed bytes: null unless every byte is printable
 * ASCII. The length cap only avoids spreading a huge push into
 * String.fromCharCode — no payload is longer than 63 bytes, so the result is
 * the same as without it.
 */
export function parsePayloadBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PAYLOAD_BYTES) return null;
  for (const b of bytes) if (b < 0x20 || b > 0x7e) return null;
  return parsePayload(String.fromCharCode(...bytes));
}

/** Decode payload bytes back to the ASCII string (display / debugging). */
export function payloadToString(bytes) {
  return new TextDecoder("ascii").decode(bytes);
}
