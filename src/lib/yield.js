// LuckyProtocol yield function — the ONLY settlement authority on the JS side.
//
// Deliberately dependency-free (no fetch, no wallet, no PSBT) so it can be
// unit-tested in plain Node against the golden vectors shared with the Rust
// indexer (PROTOCOL-v3.md §3). Any drift in case handling or digit
// bucketing fails `npm test`.
//
//   yield(block_hash) :=
//     let d = last hex char of lowercase(block_hash)
//     d == 'f'        → 1000   (1 of 16)
//     d in 'a'..='e'  → 500    (5 of 16)
//     d in '5'..='9'  → 200    (5 of 16)
//     d in '0'..='4'  → 100    (5 of 16)
//
// `block_hash` is the hash of the block that CONFIRMS the MINE tx.

export const YIELD_HIGH = 1000; // last digit 'f'
export const YIELD_MID = 500;   // last digit 'a'..'e'
export const YIELD_LOW = 200;   // last digit '5'..'9'
export const YIELD_BASE = 100;  // last digit '0'..'4'

/** Number of possible last hex digits. */
export const DIGIT_SPACE = 16;

/**
 * The four yield buckets, high → base. `digits` is the exact set of last
 * hex digits; `count` is its size. Probabilities are count / DIGIT_SPACE.
 * Every other number in this module — and every percentage in the UI —
 * derives from this table.
 */
export const BUCKETS = [
  { id: "high", label: "f", digits: "f", count: 1, yield: YIELD_HIGH },
  { id: "mid", label: "a–e", digits: "abcde", count: 5, yield: YIELD_MID },
  { id: "low", label: "5–9", digits: "56789", count: 5, yield: YIELD_LOW },
  { id: "base", label: "0–4", digits: "01234", count: 5, yield: YIELD_BASE },
];

/** Probability helpers — the ONLY place percentages are formed. */
export const probability = (b) => b.count / DIGIT_SPACE; // 0.0625
export const probabilityPct = (b) => trimPct((100 * b.count) / DIGIT_SPACE); // "6.25"
export const contribution = (b) => (b.count * b.yield) / DIGIT_SPACE; // 62.5 / 156.25 / 62.5 / 31.25
function trimPct(x) {
  return String(Number(x.toFixed(2))); // 62.5 not 62.50
}

/** Expected yield per MINE: Σ count·yield / 16 = (1000 + 5·500 + 5·200 + 5·100) / 16 = 312.5. */
export const EXPECTED_YIELD = BUCKETS.reduce((s, b) => s + contribution(b), 0);

/** Probability of landing in a bucket as a fraction: 1/16, 5/16, 5/16, 5/16. */
export const ODDS_HIGH = probability(BUCKETS[0]);
export const ODDS_MID = probability(BUCKETS[1]);
export const ODDS_LOW = probability(BUCKETS[2]);
export const ODDS_BASE = probability(BUCKETS[3]);

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

/**
 * mineYield(blockHash) → 100 | 200 | 500 | 1000, or null when the input is
 * empty or not a hex string. Case-insensitive (uppercase 'F' → 1000).
 */
export function mineYield(blockHash) {
  const b = bucketOfHash(blockHash);
  return b ? b.yield : null;
}

/** Human label for a yield bucket ("high" | "mid" | "low" | "base"), used by the UI. */
export function yieldTierLabel(y) {
  const b = bucketOfYield(y);
  return b ? b.id : "unknown";
}

/** All 16 digits in order, each with its bucket id. */
export const DIGITS = "0123456789abcdef".split("").map((d) => ({ d, bucket: bucketOf(d).id }));

/** Std-dev of a single mine's yield: sqrt(Σ p·y² − EV²) ≈ 242 */
export const YIELD_SD = Math.sqrt(
  BUCKETS.reduce((s, b) => s + probability(b) * b.yield * b.yield, 0) - EXPECTED_YIELD * EXPECTED_YIELD,
);

/** Human sentence for role="img" graphics. */
export function distributionSentence() {
  return `${BUCKETS.map((b) => `${b.label} ${b.count} in ${DIGIT_SPACE} yields ${b.yield}`).join("; ")}; expected ${EXPECTED_YIELD} per mine.`;
}
