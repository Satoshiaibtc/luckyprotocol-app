// LuckyProtocol OP_RETURN payload encoders + protocol constants.
//
// Byte-identical to the indexer's parser (PROTOCOL-v3.md §1–§2).
// The indexer strictly validates every field — a single-byte drift means
// the tx is treated as a plain BTC spend (and strict-burn applies to any
// token inputs), so the encoders here are deliberately narrow.
//
// Wire formats (ASCII, `|`-delimited, no trailing newline, ≤ 80 bytes):
//
//   DEPLOY:  LUCKYPROTOCOL|DEPLOY|<TICKER>
//   MINE:    LUCKYPROTOCOL|MINE|<TICKER>              (no tier / pick / indices)
//   SEND:    LUCKYPROTOCOL|SEND|<TICKER>|<AMT>|<TO_OUT>|<CHANGE_OUT>

// ---- §1 constants ----------------------------------------------------------

export const PROTOCOL_PREFIX = "LUCKYPROTOCOL";
export const ACTIVATION_HEIGHT = 969_500;          // PLACEHOLDER per spec; finalized at launch
export const SNAPSHOT_VERSION = 12;
export const REQUIRED_TOKEN_SUPPLY = 21_000_000;   // implicit on every DEPLOY
export const DUST_SATS = 546;                      // token-carrier output value
export const PROJECT_FEE_ADDRESS =
  "bc1pyefhtnuz2gw04fsynlsseeh847cqy20dw7yt6fnavm9fgnewcr7q88gqf3";
export const DEPLOY_PROTOCOL_FEE_SATS = 5_460;
export const MINE_PROTOCOL_FEE_SATS = 546;
export const SEND_PROTOCOL_FEE_SATS = 546;
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
 * `LUCKYPROTOCOL|DEPLOY|<TICKER>` — registers the ticker with supply 21,000,000.
 * The tx must also pay exactly DEPLOY_PROTOCOL_FEE_SATS to
 * PROJECT_FEE_ADDRESS (consensus rule, §2.1).
 */
export function buildDeployPayload(ticker) {
  validateTicker(ticker);
  return capPayload(asciiBytes(`${PROTOCOL_PREFIX}|DEPLOY|${ticker}`));
}

/**
 * `LUCKYPROTOCOL|MINE|<TICKER>` — yield is credited to vout0; the yield-slot and
 * change-slot indices are implicit (both 0, §2.2) and NOT encoded. Nothing
 * else is encoded: the yield is a pure function of the confirming block's
 * hash.
 */
export function buildMinePayload(ticker) {
  validateTicker(ticker);
  return capPayload(asciiBytes(`${PROTOCOL_PREFIX}|MINE|${ticker}`));
}

/**
 * `LUCKYPROTOCOL|SEND|<TICKER>|<AMT>|<TO_OUT>|<CHANGE_OUT>` (§2.3).
 * `amount` is whole tokens (1 ≤ AMT ≤ 21,000,000). The residual input
 * pool routes to vout[CHANGE_OUT], so a builder must always emit that
 * output — see buildSendPsbt.
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
    throw new Error("SEND toOutIdx === changeOutIdx is ambiguous; use distinct indices");
  }
  return capPayload(
    asciiBytes(`${PROTOCOL_PREFIX}|SEND|${ticker}|${amt.toString()}|${toOutIdx}|${changeOutIdx}`),
  );
}

/** Decode payload bytes back to the ASCII string (display / debugging). */
export function payloadToString(bytes) {
  return new TextDecoder("ascii").decode(bytes);
}
