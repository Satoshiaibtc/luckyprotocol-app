// LuckyProtocol OP_RETURN payload encoders + protocol constants.
//
// Byte-identical to the indexer's parser (PROTOCOL-v3.md §1–§2).
// The indexer strictly validates every field — a single-byte drift means
// the tx is treated as a plain BTC spend (and strict-burn applies to any
// token inputs), so the encoders here are deliberately narrow.
//
// Wire formats (ASCII, `|`-delimited, no trailing newline, ≤ 80 bytes):
//
//   DEPLOY:  LUCKY-20|DEPLOY|<TICKER>
//   MINE:    LUCKY-20|MINE|<TICKER>              (no tier / pick / indices)
//   SEND:    LUCKY-20|SEND|<TICKER>|<AMT>|<TO_OUT>|<CHANGE_OUT>
//   AVATAR:  LUCKY-20|AVATAR|<TICKER>            (§8; image rides in input0's witness)

// ---- §1 constants ----------------------------------------------------------

export const PROTOCOL_PREFIX = "LUCKY-20";
export const ACTIVATION_HEIGHT = 968_750;          // FINAL (spec §1); protocol txs below this height are ignored
export const SNAPSHOT_VERSION = 12;
export const REQUIRED_TOKEN_SUPPLY = 21_000_000;   // implicit on every DEPLOY
export const DUST_SATS = 546;                      // token-carrier output value
export const PROJECT_FEE_ADDRESS =
  "bc1pyefhtnuz2gw04fsynlsseeh847cqy20dw7yt6fnavm9fgnewcr7q88gqf3";
export const DEPLOY_PROTOCOL_FEE_SATS = 5_460;
export const MINE_PROTOCOL_FEE_SATS = 546;
export const SEND_PROTOCOL_FEE_SATS = 546;
export const AVATAR_PROTOCOL_FEE_SATS = 546;      // §8.1 vout1, exact amount
export const MAX_OUT_IDX = 255;
export const MAX_PAYLOAD_BYTES = 80;
export const TICKER_RE = /^[A-Z0-9]{1,8}$/;

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
 * `LUCKY-20|DEPLOY|<TICKER>` — registers the ticker with supply 21,000,000.
 * The tx must also pay exactly DEPLOY_PROTOCOL_FEE_SATS to
 * PROJECT_FEE_ADDRESS (consensus rule, §2.1).
 */
export function buildDeployPayload(ticker) {
  validateTicker(ticker);
  return capPayload(asciiBytes(`${PROTOCOL_PREFIX}|DEPLOY|${ticker}`));
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
 * the tx into a plain spend that strict-burns every token input.
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
    throw new Error("SEND toOutIdx === changeOutIdx does not parse (§2.3) — the indexer would burn the input pool; use distinct indices");
  }
  return capPayload(
    asciiBytes(`${PROTOCOL_PREFIX}|SEND|${ticker}|${amt.toString()}|${toOutIdx}|${changeOutIdx}`),
  );
}

/**
 * `LUCKY-20|AVATAR|<TICKER>` (§8.1) — exactly three fields. The image
 * itself is not in the payload: it is the ord-style envelope revealed in
 * input0's witness (see src/lib/inscribe.js). The tx must also pay exactly
 * AVATAR_PROTOCOL_FEE_SATS to PROJECT_FEE_ADDRESS and spend at least one
 * UTXO of the token's deployer (§8.3).
 */
export function buildAvatarPayload(ticker) {
  validateTicker(ticker);
  return capPayload(asciiBytes(`${PROTOCOL_PREFIX}|AVATAR|${ticker}`));
}

/**
 * Parse an OP_RETURN payload string back into its fields, or return null
 * when it is not a LuckyProtocol payload. Mirrors the indexer's grammar:
 * DEPLOY|T, MINE|T, AVATAR|T, SEND|T|AMT|TO|CHG — anything else is "not a
 * protocol tx". SEND is EXACTLY six fields: a five-field SEND (no
 * CHANGE_OUT) and a seven-field one are both invalid, and TO == CHG is
 * invalid (§2.3; the same vectors live in protocol.rs and in
 * test/payloads.test.js — audit M-2). Used by the mock indexer, by the
 * sign-time guard in psbt.js and by display code; never by consensus.
 */
export function parsePayload(str) {
  if (typeof str !== "string") return null;
  const f = str.split("|");
  if (f[0] !== PROTOCOL_PREFIX || f.length < 3) return null;
  const op = f[1];
  const ticker = f[2];
  if (!TICKER_RE.test(ticker)) return null;
  if ((op === "DEPLOY" || op === "MINE" || op === "AVATAR") && f.length === 3) return { op, ticker };
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
