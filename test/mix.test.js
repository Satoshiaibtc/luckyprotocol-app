// summarizeMix — observed yield mix over MineView rows. Plain Node.
import assert from "node:assert/strict";
import { summarizeMix } from "../src/lib/mix.js";

const row = (y, extra = {}) => ({ txid: "x", ticker: "T", block_height: 1, sender: "s", status: "settled", yield_smallest: y, cap_exhausted: false, ...extra });

// The portfolio seed: 1000 / 100 / 500.
const r = summarizeMix([row(1000), row(100), row(500)]);
assert.equal(r.n, 3);
assert.equal(r.total, 1600);
assert.deepEqual(r.counts, { high: 1, mid: 1, base: 1 });
assert.ok(Math.abs(r.mean - 533.333) < 0.001, `mean ${r.mean}`);

// Invalid and cap-exhausted rows say nothing about the digit; unknown yields are ignored.
const s = summarizeMix([row(500), row(0, { status: "invalid" }), row(0, { cap_exhausted: true }), row(250)]);
assert.equal(s.n, 1);
assert.equal(s.total, 500);
assert.equal(s.mean, 500);

// Empty / bad input.
assert.deepEqual(summarizeMix([]), { n: 0, counts: { high: 0, mid: 0, base: 0 }, total: 0, mean: null });
assert.deepEqual(summarizeMix(null).n, 0);

console.log("mix: 3 rows → n 3, total 1600, mean 533.33 ok");
