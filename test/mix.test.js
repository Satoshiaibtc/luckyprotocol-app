// summarizeMix — observed yield mix over MineView rows. Plain Node.
import assert from "node:assert/strict";
import { emptyCounts, summarizeMix } from "../src/lib/mix.js";
import { BUCKETS } from "../src/lib/yield.js";

const row = (y, extra = {}) => ({ txid: "x", ticker: "T", block_height: 1, sender: "s", status: "settled", yield_smallest: y, cap_exhausted: false, ...extra });

// One counter per bucket, keyed by bucket id.
assert.deepEqual(Object.keys(emptyCounts()), BUCKETS.map((b) => b.id));
assert.deepEqual(emptyCounts(), { high: 0, mid: 0, low: 0, base: 0 });

// The portfolio seed: 1000 / 100 / 500 / 200.
const r = summarizeMix([row(1000), row(100), row(500), row(200)]);
assert.equal(r.n, 4);
assert.equal(r.total, 1800);
assert.deepEqual(r.counts, { high: 1, mid: 1, low: 1, base: 1 });
assert.equal(r.mean, 450);

// Invalid and cap-exhausted rows say nothing about the digit; unknown yields are ignored.
const s = summarizeMix([row(500), row(0, { status: "invalid" }), row(0, { cap_exhausted: true }), row(250)]);
assert.equal(s.n, 1);
assert.equal(s.total, 500);
assert.equal(s.mean, 500);
assert.deepEqual(s.counts, { high: 0, mid: 1, low: 0, base: 0 });

// Empty / bad input.
assert.deepEqual(summarizeMix([]), { n: 0, counts: { high: 0, mid: 0, low: 0, base: 0 }, total: 0, mean: null });
assert.deepEqual(summarizeMix(null).n, 0);

console.log("mix: 4 rows → n 4, total 1800, mean 450 ok");
