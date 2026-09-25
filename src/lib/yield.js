// LuckyProtocol yield function — the ONLY settlement authority on the JS side.
//
// Deliberately dependency-free (no fetch, no wallet, no PSBT) so it can be
// unit-tested in plain Node against the golden vectors shared with the Rust
// indexer (PROTOCOL-v3.md §3). Any drift in case handling or digit
// bucketing fails `npm test`.
//
//   yield(block_hash) :=
//     let d = last hex char of lowercase(block_hash)
//     d == 'f'        → 500
//     d in 'a'..='e'  → 100
//     d in '0'..='9'  → 21
//
// `block_hash` is the hash of the block that CONFIRMS the MINE tx.

export const YIELD_HIGH = 500; // last digit 'f'
export const YIELD_MID = 100;  // last digit 'a'..'e'
export const YIELD_BASE = 21;  // last digit '0'..'9'

/** Expected yield per MINE: (500 + 5·100 + 10·21) / 16. */
export const EXPECTED_YIELD = (YIELD_HIGH + 5 * YIELD_MID + 10 * YIELD_BASE) / 16;

const HEX_RE = /^[0-9a-f]+$/;

/**
 * Last hex digit of a block hash, lowercased — the "yield digit".
 * Returns null for empty / non-string / non-hex input.
 */
export function yieldDigit(blockHash) {
  if (typeof blockHash !== "string") return null;
  const h = blockHash.trim().toLowerCase();
  if (h.length === 0 || !HEX_RE.test(h)) return null;
  return h[h.length - 1];
}

/**
 * mineYield(blockHash) → 21 | 100 | 500, or null when the input is empty
 * or not a hex string. Case-insensitive (uppercase 'F' → 500).
 */
export function mineYield(blockHash) {
  const d = yieldDigit(blockHash);
  if (d === null) return null;
  if (d === "f") return YIELD_HIGH;
  if (d >= "a" && d <= "e") return YIELD_MID;
  return YIELD_BASE;
}

/** Human label for a yield bucket, used by the UI. */
export function yieldTierLabel(y) {
  if (y === YIELD_HIGH) return "high";
  if (y === YIELD_MID) return "mid";
  if (y === YIELD_BASE) return "base";
  return "unknown";
}
