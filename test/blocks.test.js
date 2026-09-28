import assert from "node:assert/strict";
import { blockStats, blockFullness, visibleBlockCount, MAX_BLOCK_WEIGHT } from "../src/lib/blocks.js";

assert.deepEqual(blockStats({ weight: 3_200_000, tx_count: 2_500 }), { weight: 3_200_000, tx_count: 2_500 });
assert.equal(blockFullness(1_000_000), 25);
assert.equal(blockFullness(2_000_000), 50);
assert.equal(blockFullness(MAX_BLOCK_WEIGHT), 100);
assert.equal(blockFullness(800), 0.02);
for (const weight of [null, undefined, 0, -1, 1.5, NaN, Infinity, "3000000", MAX_BLOCK_WEIGHT + 1]) {
  assert.equal(blockFullness(weight), null, `${weight} is unknown, not empty/full`);
}
for (const tx_count of [0, -1, 2.5, null, "100", 1_000_001]) {
  assert.equal(blockStats({ weight: 1000, tx_count }).tx_count, null);
}
assert.deepEqual(blockStats(null), { weight: null, tx_count: null });
for (const width of [320, 600, 800, 1000, 1230, 1500, 2000]) {
  const count = visibleBlockCount(width);
  assert.ok(count >= 2 && count <= 20);
  assert.ok((width - 3 * count) / (count + 1) >= 54, "full-height labels fit");
}
assert.equal(visibleBlockCount(1193), 19);
assert.equal(visibleBlockCount(1194), 20);
assert.equal(visibleBlockCount(1230), 20);
assert.equal(visibleBlockCount(600), 9);
console.log("blocks: true weight occupancy, unknown data, full labels and bounded tile count passed");
