// LuckyProtocol OP_RETURN payload encoders + protocol constants.
//
// Byte-identical to the indexer's parser (PROTOCOL.md §1–§2).
// The indexer strictly validates every field — a single-byte drift means
// the tx is treated as a plain BTC spend, and DEFAULT ROUTING then moves
// every token input to the tx's first non-OP_RETURN output (whoever that
// pays), so the encoders here are deliberately narrow.
//
// Wire formats (ASCII, `|`-delimited, no trailing newline, ≤ 80 bytes):
//
//   COMMIT:  LUCKY-20|COMMIT|<H>                 (H = 64 lowercase hex; exactly 80 bytes)
//   DEPLOY:  LUCKY-20|DEPLOY|<TICKER>|<SALT>     (the REVEAL; SALT = 32 lowercase hex)
//   MINE:    LUCKY-20|MINE|<TICKER>              (ticker only)
//   SEND:    LUCKY-20|SEND|<TICKER>|<AMT>|<TO_OUT>|<CHANGE_OUT>
//
// H = SHA-256( UTF-8 bytes of the exact REVEAL payload string ‖ raw
// scriptPubKey bytes of the COMMIT's vout0, the commit carrier ). A COMMIT
// names no ticker: the name only becomes public with the REVEAL, which must
// spend the COMMIT's carrier (vout0) as input 0 in a LATER block
// (commit-reveal deploy, anti front-running). The carrier's script binds H
// to the committer: a copy of H in someone else's COMMIT can never be
// revealed, because that COMMIT's carrier has another script. The old three-field
// `LUCKY-20|DEPLOY|<TICKER>` still parses but is never applied
// ("commit_required"); this app never builds it.
//
// `LUCKY-20|AVATAR|<TICKER>` was withdrawn before activation (§8) and
// parses as nothing, like any other unknown op.

import { sha256 } from "@noble/hashes/sha2.js";

// ---- §1 constants ----------------------------------------------------------

export const PROTOCOL_PREFIX = "LUCKY-20";
export const ACTIVATION_HEIGHT = 969_300;          // spec §1 (owner decision 2026-09-26); protocol txs below this height are ignored
export const REQUIRED_TOKEN_SUPPLY = 21_000_000;   // implicit on every DEPLOY
export const DUST_SATS = 546;                      // token-carrier output value
export const PROJECT_FEE_ADDRESS =
  "bc1phk23psaqmq4rlsjeet79xpt65n9v2hvrv97ezc6c4rpld4s2shwqa9qx9n";
export const DEPLOY_PROTOCOL_FEE_SATS = 5_460;
export const MINE_PROTOCOL_FEE_SATS = 546;
export const SEND_PROTOCOL_FEE_SATS = 546;
export const MAX_OUT_IDX = 255;
// Commit-reveal deploy (§2.1): a REVEAL applies only in a block at least
// MIN_COMMIT_AGE and at most MAX_COMMIT_AGE blocks after its COMMIT's block.
export const MIN_COMMIT_AGE = 1;
export const MAX_COMMIT_AGE = 2_016;
// Confirmations after which a block's effects are final (§1, §3.1). Defined
// with the other depth helpers; re-exported here so the §1 gate
// (scripts/check-spec.mjs) compares it with the spec like every constant.
export { FINAL_DEPTH } from "./finality.js";
export const MAX_PAYLOAD_BYTES = 80;
export const TICKER_RE = /^[A-Z0-9]{1,8}$/;
/** REVEAL salt: exactly 16 bytes as 32 lowercase hex characters. */
export const SALT_RE = /^[0-9a-f]{32}$/;
/** COMMIT hash: a SHA-256 as 64 lowercase hex characters. */
export const COMMIT_HASH_RE = /^[0-9a-f]{64}$/;
/** A carrier scriptPubKey as lowercase hex: whole bytes, at least one. */
export const SCRIPT_HEX_RE = /^(?:[0-9a-f]{2})+$/;

/**
 * nLockTime of every COMMIT, REVEAL, MINE and SEND this app builds (owner
 * decision B, 2026-09-27): ACTIVATION_HEIGHT − 1, so such a transaction can
 * only confirm in block ACTIVATION_HEIGHT or later. That is what lets the
 * Reserve and Mine gates open one block early (at tip 969,299) with no risk
 * of an ignored, pre-activation confirmation. Not a consensus constant: the
 * indexer ignores nLockTime; it is the app's own safety net. (A listing and
 * its fill keep nLockTime 0 — the seller's SINGLE|ANYONECANPAY signature
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

function validateOutIdx(name, idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx > MAX_OUT_IDX) {
    throw new Error(`${name} = ${idx} out of range [0, ${MAX_OUT_IDX}]`);
  }
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
 * The REVEAL payload string `LUCKY-20|DEPLOY|<TICKER>|<SALT>` (§2.1). Its
 * UTF-8 bytes are what the COMMIT's hash covers first, before the carrier
 * script (commitHashOf).
 */
export function revealPayloadString(ticker, salt) {
  validateTicker(ticker);
  validateSalt(salt);
  return `${PROTOCOL_PREFIX}|DEPLOY|${ticker}|${salt}`;
}

/**
 * `LUCKY-20|DEPLOY|<TICKER>|<SALT>` — the REVEAL. It registers the ticker
 * (supply 21,000,000) only when input 0 spends the carrier of a recorded
 * COMMIT whose hash is SHA-256 of exactly these bytes followed by that
 * carrier's scriptPubKey, that COMMIT is at
 * least MIN_COMMIT_AGE and at most MAX_COMMIT_AGE blocks older, and the tx
 * pays exactly DEPLOY_PROTOCOL_FEE_SATS to PROJECT_FEE_ADDRESS (§2.1).
 * There is no builder for the old three-field DEPLOY: it is never applied.
 */
export function buildRevealPayload(ticker, salt) {
  return capPayload(asciiBytes(revealPayloadString(ticker, salt)));
}

/**
 * The bytes of a carrier scriptPubKey given as lowercase hex or as bytes.
 * Throws when it is missing or empty: an H without the carrier script
 * would not bind the committer.
 */
export function carrierScriptBytes(script) {
  if (script instanceof Uint8Array) {
    if (!script.length) throw new Error("the carrier script is empty");
    return script;
  }
  const h = typeof script === "string" ? script.toLowerCase() : "";
  if (!SCRIPT_HEX_RE.test(h)) throw new Error("the carrier script must be non-empty hex (whole bytes)");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * H of a REVEAL payload string for a COMMIT whose carrier (vout0) has the
 * scriptPubKey `carrierScript` (hex or bytes): SHA-256( UTF-8 bytes of the
 * payload ‖ the script bytes ) as 64 lowercase hex (§2.1). The four spec
 * vectors are asserted in test/payloads.test.js.
 */
export function commitHashOf(revealPayload, carrierScript) {
  if (typeof revealPayload !== "string" || !revealPayload) throw new Error("reveal payload must be a non-empty string");
  const p = new TextEncoder().encode(revealPayload);
  const s = carrierScriptBytes(carrierScript);
  const both = new Uint8Array(p.length + s.length);
  both.set(p, 0);
  both.set(s, p.length);
  return bytesToHex(sha256(both));
}

/** H for `(ticker, salt)` under the carrier script `carrierScript`: commitHashOf(revealPayloadString(ticker, salt), carrierScript). */
export function commitHashFor(ticker, salt, carrierScript) {
  return commitHashOf(revealPayloadString(ticker, salt), carrierScript);
}

/** `LUCKY-20|COMMIT|<H>` — exactly 80 bytes; names no ticker (§2.1). */
export function buildCommitPayload(hash) {
  if (typeof hash !== "string" || !COMMIT_HASH_RE.test(hash)) {
    throw new Error("COMMIT hash must be 64 lowercase hex characters");
  }
  const bytes = capPayload(asciiBytes(`${PROTOCOL_PREFIX}|COMMIT|${hash}`));
  if (bytes.length !== MAX_PAYLOAD_BYTES) throw new Error(`COMMIT payload is ${bytes.length} bytes, expected ${MAX_PAYLOAD_BYTES}`);
  return bytes;
}

export function isValidSalt(salt) {
  return typeof salt === "string" && SALT_RE.test(salt);
}

function validateSalt(salt) {
  if (!isValidSalt(salt)) throw new Error("salt must be exactly 32 lowercase hex characters (16 bytes)");
  return salt;
}

/**
 * 16 fresh random bytes as the 32-hex REVEAL salt (Web Crypto). Throws when
 * there is no secure random source: a guessable salt would let anyone test
 * tickers against a public COMMIT hash (the carrier script it also covers
 * is public too).
 */
export function newSalt() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") throw new Error("this browser has no secure random source (crypto.getRandomValues)");
  return bytesToHex(c.getRandomValues(new Uint8Array(16)));
}

function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * `LUCKY-20|MINE|<TICKER>` — yield is credited to vout0; the yield-slot and
 * change-slot indices are implicit (both 0, §2.2) and NOT encoded. Nothing
 * else is encoded: the yield is a pure function of the confirming block's
 * hash.
 */
export function buildMinePayload(ticker) {
  validateTicker(ticker);
  return capPayload(asciiBytes(`${PROTOCOL_PREFIX}|MINE|${ticker}`));
}

/**
 * `LUCKY-20|SEND|<TICKER>|<AMT>|<TO_OUT>|<CHANGE_OUT>` (§2.3).
 * `amount` is whole tokens (1 ≤ AMT ≤ 21,000,000). The residual input
 * pool routes to vout[CHANGE_OUT], so a builder must always emit that
 * output — see buildSendPsbt. `TO_OUT` and `CHANGE_OUT` MUST differ: the
 * indexer's parser rejects equal indices, and a non-parsing payload turns
 * the tx into a plain spend whose token inputs all route to the first
 * non-OP_RETURN output (default routing) — for a SEND that is the
 * recipient slot, i.e. the WHOLE pool would go to the recipient. Routing
 * is per ticker: a SEND moves only its own ticker; any other ticker in the
 * input pool goes to `vout[CHANGE_OUT]`.
 */
export function buildSendPayload({ ticker, amount, toOutIdx, changeOutIdx }) {
  validateTicker(ticker);
  if (typeof amount !== "bigint" && typeof amount !== "number") {
    throw new Error("amount must be a number or bigint");
  }
  const amt = typeof amount === "bigint" ? amount : BigInt(amount);
  if (amt < 1n) throw new Error("SEND amount must be >= 1");
  if (amt > BigInt(REQUIRED_TOKEN_SUPPLY)) {
    throw new Error(`SEND amount exceeds ${REQUIRED_TOKEN_SUPPLY.toLocaleString("en-US")} cap`);
  }
  validateOutIdx("toOutIdx", toOutIdx);
  validateOutIdx("changeOutIdx", changeOutIdx);
  if (toOutIdx === changeOutIdx) {
    throw new Error("SEND toOutIdx === changeOutIdx does not parse (§2.3) — the tx would be a plain spend and the whole input pool would move to its first output; use distinct indices");
  }
  return capPayload(
    asciiBytes(`${PROTOCOL_PREFIX}|SEND|${ticker}|${amt.toString()}|${toOutIdx}|${changeOutIdx}`),
  );
}

/**
 * Parse an OP_RETURN payload string back into its fields, or return null
 * when it is not a LuckyProtocol payload. Mirrors the indexer's grammar:
 *
 *   COMMIT|H            → { op: "COMMIT", hash }           (H: 64 lowercase hex)
 *   DEPLOY|T|SALT       → { op: "DEPLOY", ticker, salt }   (the REVEAL; SALT: 32 lowercase hex)
 *   DEPLOY|T            → { op: "DEPLOY", ticker, salt: null } — parses, never
 *                         applied ("commit_required", §2.1)
 *   MINE|T              → { op: "MINE", ticker }
 *   SEND|T|AMT|TO|CHG   → { op: "SEND", ticker, amount, toOutIdx, changeOutIdx }
 *
 * Anything else — an unknown op such as the withdrawn AVATAR (§8), a hash or
 * salt in the wrong case or length — is "not a protocol tx". SEND is
 * EXACTLY six fields: a five-field SEND (no CHANGE_OUT) and a seven-field
 * one are both invalid, and TO == CHG is invalid (§2.3; the same vectors
 * live in protocol.rs and in test/payloads.test.js — audit M-2). Used by the
 * mock indexer, by the sign-time guard in psbt.js and by display code;
 * never by consensus.
 */
export function parsePayload(str) {
  if (typeof str !== "string") return null;
  const f = str.split("|");
  if (f[0] !== PROTOCOL_PREFIX || f.length < 3) return null;
  const op = f[1];
  if (op === "COMMIT") return f.length === 3 && COMMIT_HASH_RE.test(f[2]) ? { op, hash: f[2] } : null;
  const ticker = f[2];
  if (!TICKER_RE.test(ticker)) return null;
  if (op === "DEPLOY" && f.length === 3) return { op, ticker, salt: null };
  if (op === "DEPLOY" && f.length === 4) return SALT_RE.test(f[3]) ? { op, ticker, salt: f[3] } : null;
  if (op === "MINE" && f.length === 3) return { op, ticker };
  if (op === "SEND" && f.length === 6) {
    if (!/^(0|[1-9][0-9]*)$/.test(f[3]) || !/^(0|[1-9][0-9]*)$/.test(f[4]) || !/^(0|[1-9][0-9]*)$/.test(f[5])) return null;
    const amount = Number(f[3]);
    const toOutIdx = Number(f[4]);
    const changeOutIdx = Number(f[5]);
    if (amount < 1 || amount > REQUIRED_TOKEN_SUPPLY) return null;
    if (toOutIdx > MAX_OUT_IDX || changeOutIdx > MAX_OUT_IDX) return null;
    if (toOutIdx === changeOutIdx) return null; // equal indices do not parse (§2.3)
    return { op, ticker, amount, toOutIdx, changeOutIdx };
  }
  return null;
}

/** Decode payload bytes back to the ASCII string (display / debugging). */
export function payloadToString(bytes) {
  return new TextDecoder("ascii").decode(bytes);
}
