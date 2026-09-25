// LuckyProtocol yield function — the ONLY settlement authority on the JS side.
//
// Deliberately dependency-free (no fetch, no wallet, no PSBT) so it can be
// unit-tested in plain Node against the golden vectors shared with the Rust
// indexer (PROTOCOL-v3.md §3). Any drift in case handling or digit
// bucketing fails `npm test`.
//
//   yield(block_hash) :=
//     let d = last hex char of lowercase(block_hash)
//     d == 'f'        → 1000
//     d in 'a'..='e'  → 500
//     d in '0'..='9'  → 100
//
// `block_hash` is the hash of the block that CONFIRMS the MINE tx.

export const YIELD_HIGH = 1000; // last digit 'f'
export const YIELD_MID = 500;   // last digit 'a'..'e'
export const YIELD_BASE = 100;  // last digit '0'..'9'

/** Expected yield per MINE: (1000 + 5·500 + 10·100) / 16 = 281.25. */
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
 * mineYield(blockHash) → 100 | 500 | 1000, or null when the input is empty
 * or not a hex string. Case-insensitive (uppercase 'F' → 1000).
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

// ---- Probability model (additive; the UI's only source of percentages) ---------

/** Number of possible last hex digits. */
export const DIGIT_SPACE = 16;

/**
 * The three yield buckets, high → base. `digits` is the exact set of last
 * hex digits; `count` is its size. Probabilities are count / DIGIT_SPACE.
 */
export const BUCKETS = [
  { id: "high", label: "f", digits: "f", count: 1, yield: YIELD_HIGH },
  { id: "mid", label: "a–e", digits: "abcde", count: 5, yield: YIELD_MID },
  { id: "base", label: "0–9", digits: "0123456789", count: 10, yield: YIELD_BASE },
];

/** Probability of landing in a bucket as a fraction: 1/16, 5/16, 10/16. */
export const ODDS_HIGH = BUCKETS[0].count / DIGIT_SPACE;
export const ODDS_MID = BUCKETS[1].count / DIGIT_SPACE;
export const ODDS_BASE = BUCKETS[2].count / DIGIT_SPACE;

export function bucketOf(digit) {
  const d = typeof digit === "string" ? digit.toLowerCase() : "";
  if (d.length !== 1) return null;
  return BUCKETS.find((b) => b.digits.includes(d)) || null;
}
export function bucketOfYield(y) {
  return BUCKETS.find((b) => b.yield === y) || null;
}
export function bucketOfHash(blockHash) {
  return bucketOf(yieldDigit(blockHash));
}

/** All 16 digits in order, each with its bucket id. */
export const DIGITS = "0123456789abcdef".split("").map((d) => ({ d, bucket: bucketOf(d).id }));

/** Probability helpers — the ONLY place percentages are formed. */
export const probability = (b) => b.count / DIGIT_SPACE; // 0.0625
export const probabilityPct = (b) => trimPct((100 * b.count) / DIGIT_SPACE); // "6.25"
export const contribution = (b) => (b.count * b.yield) / DIGIT_SPACE; // 62.5 / 156.25 / 62.5
function trimPct(x) {
  return String(Number(x.toFixed(2))); // 62.5 not 62.50
}

/** Std-dev of a single mine's yield: sqrt(Σ p·y² − EV²) ≈ 260.3 */
export const YIELD_SD = Math.sqrt(
  BUCKETS.reduce((s, b) => s + probability(b) * b.yield * b.yield, 0) - EXPECTED_YIELD * EXPECTED_YIELD,
);

/** Human sentence for role="img" graphics. */
export function distributionSentence() {
  return `${BUCKETS.map((b) => `${b.label} ${b.count} in ${DIGIT_SPACE} yields ${b.yield}`).join("; ")}; expected ${EXPECTED_YIELD} per mine.`;
}
