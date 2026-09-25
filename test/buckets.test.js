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
  ODDS_LOW,
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
assert.equal(BUCKETS.length, 4);
assert.deepEqual(BUCKETS.map((b) => b.id), ["high", "mid", "low", "base"]);
assert.deepEqual(BUCKETS.map((b) => b.label), ["f", "c–e", "7–b", "0–6"]);
assert.deepEqual(BUCKETS.map((b) => b.digits), ["f", "cde", "789ab", "0123456"]);
assert.deepEqual(BUCKETS.map((b) => b.count), [1, 3, 5, 7]);
assert.deepEqual(BUCKETS.map((b) => b.yield), [1000, 500, 200, 100]);
assert.equal(BUCKETS.reduce((s, b) => s + b.count, 0), DIGIT_SPACE, "bucket counts sum to 16");
BUCKETS.forEach((b) => assert.equal(b.digits.length, b.count, `bucket ${b.id}: digits.length === count`));
// Strictly descending yields, high → base.
for (let i = 1; i < BUCKETS.length; i++) assert.ok(BUCKETS[i - 1].yield > BUCKETS[i].yield, "yields descend");

// Every digit maps to exactly one bucket.
assert.equal(DIGITS.length, DIGIT_SPACE);
for (const d of "0123456789abcdef") {
  const hits = BUCKETS.filter((b) => b.digits.includes(d));
  assert.equal(hits.length, 1, `digit ${d} in exactly one bucket`);
  assert.equal(bucketOf(d), hits[0]);
  assert.equal(bucketOf(d.toUpperCase()), hits[0], `digit ${d} upper`);
  assert.equal(bucketOfHash(`${"0".repeat(63)}${d}`), hits[0]);
}
assert.deepEqual(DIGITS.map((x) => x.bucket).join(","), "base,base,base,base,base,base,base,low,low,low,low,low,mid,mid,mid,high");
assert.equal(bucketOf(""), null);
assert.equal(bucketOf("g"), null);
assert.equal(bucketOf(null), null);
assert.equal(bucketOfHash("nope"), null);
assert.equal(bucketOfYield(1000).id, "high");
assert.equal(bucketOfYield(500).id, "mid");
assert.equal(bucketOfYield(200).id, "low");
assert.equal(bucketOfYield(100).id, "base");
assert.equal(bucketOfYield(0), null);

// Probabilities and contributions.
assert.deepEqual(BUCKETS.map(probabilityPct), ["6.25", "18.75", "31.25", "43.75"]);
assert.deepEqual(BUCKETS.map(probability), [ODDS_HIGH, ODDS_MID, ODDS_LOW, ODDS_BASE]);
assert.equal(ODDS_HIGH + ODDS_MID + ODDS_LOW + ODDS_BASE, 1);
assert.deepEqual(BUCKETS.map(contribution), [62.5, 93.75, 62.5, 43.75]);
assert.equal(BUCKETS.reduce((s, b) => s + contribution(b), 0), EXPECTED_YIELD, "Σ contribution === EV");
assert.equal(EXPECTED_YIELD, 262.5);
assert.equal(Math.round(YIELD_SD), 239, "σ ≈ 239");

assert.match(distributionSentence(), /f 1 in 16 yields 1000; c–e 3 in 16 yields 500; 7–b 5 in 16 yields 200; 0–6 7 in 16 yields 100; expected 262\.5 per mine\./);

console.log("buckets: 16 digits → 4 buckets, Σ contribution = EV 262.5, σ ≈ 239 ok");
