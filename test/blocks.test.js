import assert from "node:assert/strict";
import { blockStats, blockFullness, visibleBlockCount, MAX_BLOCK_WEIGHT, RECENT_BLOCKS_LIMIT } from "../src/lib/blocks.js";
import { hashesDisagree } from "../src/hooks/useRecentBlocks.js";
import * as indexer from "../src/lib/indexer.js";

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

// The block tape compares the WHOLE /blocks/recent window with its cache: the
// usual chain reorganization replaces h and adds h+1 in one step, so only
// the ceiling moves — h must still be noticed (its hash changed).
{
  const A = "0".repeat(63) + "a";
  const B = "0".repeat(63) + "b";
  const cache = new Map([[969_800, { hash: A }], [969_799, { hash: "0".repeat(64) }], [969_798, { missing: true }]]);
  assert.equal(hashesDisagree(cache, new Map([[969_801, { hash: B }], [969_800, { hash: B }]])), true, "h replaced while h+1 arrived");
  assert.equal(hashesDisagree(cache, new Map([[969_801, { hash: B }], [969_800, { hash: A }]])), false, "the same chain, one more block");
  assert.equal(hashesDisagree(cache, new Map([[969_798, { hash: B }]])), false, "a height cached as missing is not a disagreement");
  assert.equal(hashesDisagree(new Map(), new Map([[1, { hash: A }]])), false);
  console.log("blocks: a replaced block anywhere in the window resets the tape");
}

// Capacity: the tape asks /blocks/recent with ONE limit on every screen
// size, so every visitor shares one cached URL; the tape keeps the heights
// it shows. The limit covers the widest tape.
{
  assert.ok(RECENT_BLOCKS_LIMIT >= visibleBlockCount(1e6), "the widest tape fits in one read");
  assert.ok(RECENT_BLOCKS_LIMIT <= 32, "within the indexer's maximum");
  const urls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const blocks = Array.from({ length: RECENT_BLOCKS_LIMIT }, (_, i) => ({ height: 969_900 - i, hash: "0".repeat(63) + "a", time: 1_790_000_000, weight: 3_000_000, tx_count: 2_000 }));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ tip_height: 969_900, blocks }) };
  };
  try {
    const a = await indexer.recentBlocks();
    const b = await indexer.recentBlocks(new AbortController().signal);
    assert.equal(a.blocks.length, RECENT_BLOCKS_LIMIT);
    assert.equal(b.blocks.length, RECENT_BLOCKS_LIMIT);
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(new Set(urls).size, 1, "one URL for every caller");
  assert.ok(urls[0].endsWith(`/blocks/recent?limit=${RECENT_BLOCKS_LIMIT}`), urls[0]);
  console.log("blocks: one shared /blocks/recent URL for every screen size");
}
