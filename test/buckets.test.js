// Sanity checks for the probability model in src/lib/yield.js. Plain Node,
// no framework: every UI percentage derives from BUCKETS, so this is the
// gate that keeps the displayed math honest.
import assert from "node:assert/strict";
import {
  BUCKETS,
  DIGITS,
  DIGIT_SPACE,
  EXPECTED_YIELD,
  ODDS_BASE,
  ODDS_HIGH,
  ODDS_MID,
  YIELD_SD,
  bucketOf,
  bucketOfHash,
  bucketOfYield,
  contribution,
  distributionSentence,
  probability,
  probabilityPct,
} from "../src/lib/yield.js";

assert.equal(DIGIT_SPACE, 16);
assert.equal(BUCKETS.length, 3);
assert.equal(BUCKETS.reduce((s, b) => s + b.count, 0), DIGIT_SPACE, "bucket counts sum to 16");
BUCKETS.forEach((b) => assert.equal(b.digits.length, b.count, `bucket ${b.id}: digits.length === count`));

// Every digit maps to exactly one bucket.
assert.equal(DIGITS.length, DIGIT_SPACE);
for (const d of "0123456789abcdef") {
  const hits = BUCKETS.filter((b) => b.digits.includes(d));
  assert.equal(hits.length, 1, `digit ${d} in exactly one bucket`);
  assert.equal(bucketOf(d), hits[0]);
  assert.equal(bucketOf(d.toUpperCase()), hits[0], `digit ${d} upper`);
  assert.equal(bucketOfHash(`${"0".repeat(63)}${d}`), hits[0]);
}
assert.equal(bucketOf(""), null);
assert.equal(bucketOf("g"), null);
assert.equal(bucketOf(null), null);
assert.equal(bucketOfHash("nope"), null);
assert.equal(bucketOfYield(1000).id, "high");
assert.equal(bucketOfYield(500).id, "mid");
assert.equal(bucketOfYield(100).id, "base");
assert.equal(bucketOfYield(0), null);

// Probabilities and contributions.
assert.deepEqual(BUCKETS.map(probabilityPct), ["6.25", "31.25", "62.5"]);
assert.deepEqual(BUCKETS.map(probability), [ODDS_HIGH, ODDS_MID, ODDS_BASE]);
assert.equal(ODDS_HIGH + ODDS_MID + ODDS_BASE, 1);
assert.equal(BUCKETS.reduce((s, b) => s + contribution(b), 0), EXPECTED_YIELD, "Σ contribution === EV");
assert.equal(Math.round(YIELD_SD), 260, "σ ≈ 260");

assert.match(distributionSentence(), /f 1 in 16 yields 1000; a–e 5 in 16 yields 500; 0–9 10 in 16 yields 100; expected 281\.25 per mine\./);

console.log("buckets: 16 digits → 3 buckets, Σ contribution = EV, σ ≈ 260 ok");
