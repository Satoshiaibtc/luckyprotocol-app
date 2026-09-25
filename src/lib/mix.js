// Observed yield mix — pure, dependency-free, unit-tested in plain Node.
//
// Buckets a list of MineView rows (indexer.minesFeed items or
// indexer.minesByAddress rows) by the yield they settled at, so the UI can
// put the observed shares next to the model shares from yield.js.

import { bucketOfYield } from "./yield.js";

/**
 * summarizeMix(rows) → { n, counts: { high, mid, base }, total, mean }
 *
 * Counts only `status === "settled"` rows that were not cap-exhausted (a
 * cap-exhausted mine yields 0 and says nothing about the block digit). Rows
 * whose yield matches no bucket are ignored. `mean` is `total / n`, or
 * null when n === 0.
 */
export function summarizeMix(rows) {
  const counts = { high: 0, mid: 0, base: 0 };
  let n = 0;
  let total = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.status !== "settled" || r.cap_exhausted) continue;
    const b = bucketOfYield(r.yield_smallest);
    if (!b) continue;
    counts[b.id] += 1;
    n += 1;
    total += r.yield_smallest;
  }
  return { n, counts, total, mean: n === 0 ? null : total / n };
}
