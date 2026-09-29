// Confirmation depth and finality (FINAL_DEPTH = 6): the pure helpers in
// src/lib/finality.js, the new-ticker mining gate and the end-of-supply
// warning in src/lib/statusText.js, and the pure watch behind every tracked
// transaction (src/hooks/useTxStatus.js). Plain Node, no framework.
import assert from "node:assert/strict";
import {
  FINAL_DEPTH,
  MARKET_OPEN_DELAY,
  MINE_MIN_DEPLOY_CONFIRMATIONS,
  bestConfirmations,
  confirmationsAt,
  confirmationsText,
  deployDeepEnough,
  finalityText,
  isFinalAt,
  marketOpensAt,
} from "../src/lib/finality.js";
import { FULL_BLOCK_MINT, TAIL_BLOCKS, deployWaitText, inTailZone, mineIdleReason, recentMintRate, tailWarning } from "../src/lib/statusText.js";
import { CONFIRMED_POLL_MS, UNSEEN_POLL_MS, UNSEEN_WATCH_MS, droppedMessage, newTxWatch, txWatchErrorDelay, txWatchStep } from "../src/hooks/useTxStatus.js";
import { DROP_GRACE_MS } from "../src/lib/txrecords.js";

// ---- depth ------------------------------------------------------------------------------------------------
{
  assert.equal(FINAL_DEPTH, 6);
  assert.equal(confirmationsAt(969_700, 969_700), 1, "the tip block has 1 confirmation");
  assert.equal(confirmationsAt(969_700, 969_705), 6);
  assert.equal(confirmationsAt(969_701, 969_700), 0, "above the indexer's height: 0");
  assert.equal(confirmationsAt(null, 969_700), null);
  assert.equal(confirmationsAt(969_700, null), null);
  assert.equal(isFinalAt(969_700, 969_704), false);
  assert.equal(isFinalAt(969_700, 969_705), true);
  assert.equal(isFinalAt(969_700, null), false, "unknown depth is never final");
  assert.equal(isFinalAt(969_700, null, true), true, "…unless the indexer says final");
  assert.equal(bestConfirmations(3, 969_700, 969_701), 3, "the server's count when the local tip is stale");
  assert.equal(bestConfirmations(1, 969_700, 969_704), 5, "the local count when the server's answer is older");
  assert.equal(bestConfirmations(null, 969_700, 969_700), 1);
  assert.equal(bestConfirmations(2, null, null), 2);
  assert.equal(bestConfirmations(null, null, null), null);
  assert.equal(confirmationsText(1), "1/6 confirmations");
  assert.equal(confirmationsText(9), "6/6 confirmations", "capped at FINAL_DEPTH");
  assert.equal(confirmationsText(null), "");
  assert.equal(finalityText(2), "provisional · 2/6 confirmations");
  assert.equal(finalityText(6), "final");
  assert.equal(finalityText(0), "");
  console.log("finality: confirmations = indexed − h + 1; final at 6; server and local counts both lower bounds");
}

// ---- the market opens 6 confirmations after the completing block --------------------------------------------
{
  assert.equal(MARKET_OPEN_DELAY, FINAL_DEPTH - 1);
  const out = { ticker: "X", supply: 100, minted: 100, minted_out: true, minted_out_height: 969_800 };
  assert.equal(marketOpensAt(out), 969_805, "at 969,805 the block 969,800 has 6 confirmations");
  assert.equal(confirmationsAt(969_800, marketOpensAt(out)), FINAL_DEPTH);
  assert.equal(marketOpensAt({ ...out, market_opens_at_height: 969_900 }), 969_900, "the indexer's own height wins");
  assert.equal(marketOpensAt({ ...out, minted: 5, minted_out: false }), null, "not minted out: no opening height");
  assert.equal(marketOpensAt({ ...out, minted_out_height: null }), null);
  console.log("finality market: minted_out_height + 5");
}

// ---- a new ticker is mined from its DEPLOY's 2nd confirmation -----------------------------------------------
{
  assert.equal(MINE_MIN_DEPLOY_CONFIRMATIONS, 2);
  assert.equal(deployDeepEnough(969_700, 969_700), false, "the DEPLOY's own block: a MINE sent now could be reordered ahead of it");
  assert.equal(deployDeepEnough(969_701, 969_700), true);
  assert.equal(deployDeepEnough(null, 969_700), false, "unknown tip fails closed");
  assert.equal(deployDeepEnough(969_701, undefined), false);
  const why = deployWaitText("NEW", 969_700);
  assert.match(why, /^NEW was just created\. Mining opens at its 2nd confirmation \(block #969,701\), so a chain reorganization cannot leave a MINE ahead of the creation/);
  const idle = { connected: true, indexerOk: true, preActivation: false, exhausted: false, lagText: null, ticker: "NEW" };
  assert.equal(mineIdleReason({ ...idle, deployBlock: 969_700, deployTooNew: true }), why);
  assert.equal(mineIdleReason({ ...idle, exhausted: true, deployTooNew: true }).startsWith("NEW is fully minted"), true, "exhausted says more");
  assert.equal(mineIdleReason({ ...idle }), null);
  console.log("finality deploy gate: MINE opens at the DEPLOY's 2nd confirmation, said plainly");
}

// ---- near the end of the supply: queued MINEs may use up the rest ---------------------------------------------
{
  const tip = 970_100;
  const mine = (h, y, extra = {}) => ({ block_height: h, yield_smallest: y, status: "settled", cap_exhausted: false, ...extra });
  // 6 blocks, 3 × 1,000 + 1 × 500 per block → 3,500 per block
  const rows = [];
  for (let h = tip; h > tip - 6; h--) rows.push(mine(h, 1000), mine(h, 1000), mine(h, 1000), mine(h, 500));
  rows.push(mine(tip - 10, 1000), mine(tip - 1, 0, { status: "invalid" }));
  const rate = recentMintRate(rows, tip);
  assert.deepEqual(rate, { perBlock: 3_500, lowerBound: false });
  assert.equal(recentMintRate([], tip).perBlock, 0);
  assert.equal(recentMintRate(rows, null), null);
  assert.equal(TAIL_BLOCKS, 3);
  assert.equal(tailWarning({ ticker: "X", remaining: 5_000_000, rate }), null, "outside the tail zone and more than 3 blocks' worth left: no warning");
  const w = tailWarning({ ticker: "X", remaining: 10_000, rate });
  assert.match(w, /^Only 10,000 X left, and recent blocks minted about 3,500 each\. MINEs already waiting in the mempool may use up the rest first — a new MINE can then credit 0, while its 546-sat protocol fee and the network fee are still paid\.$/);
  // a full feed page still inside the window: the rate is only a lower bound — a hot token
  const hot = Array.from({ length: 50 }, () => mine(tip, 1000));
  const r2 = recentMintRate(hot, tip, { limit: 50 });
  assert.deepEqual(r2, { perBlock: 50_000, lowerBound: true });
  assert.match(tailWarning({ ticker: "X", remaining: 1_000_000, rate: r2 }), /minted at least 50,000 each/, "below one full block of MINEs: warned");
  assert.equal(tailWarning({ ticker: "X", remaining: FULL_BLOCK_MINT, rate: r2 }), null);
  assert.equal(tailWarning({ ticker: "X", remaining: 0, rate }), null, "minted out is said elsewhere");
  // the tail zone: below about one block of MINEs a rush queued in the mempool can take the rest, whatever recent blocks minted
  assert.equal(FULL_BLOCK_MINT, 1_200_000);
  assert.deepEqual([inTailZone(1_000_000), inTailZone(5_000_000), inTailZone(FULL_BLOCK_MINT), inTailZone(0), inTailZone(null)], [true, false, false, false, false]);
  const quiet = tailWarning({ ticker: "X", remaining: 50_000, rate: { perBlock: 0, lowerBound: false } });
  assert.match(quiet, /^Only 50,000 X left\. MINEs already waiting in the mempool may use up the rest first — a new MINE can then credit 0, while its 546-sat protocol fee/, "no MINE in recent blocks: still warned (a rush may be queued), without a rate");
  assert.ok(tailWarning({ ticker: "X", remaining: 50_000, rate }).includes("about 3,500 each"), "with a rate it is quoted");
  assert.match(tailWarning({ ticker: "X", remaining: 100, rate: null }), /Only 100 X left\./, "an unknown rate warns too");
  console.log("finality tail: warned throughout the tail zone and wherever 3 blocks of the recent rate could take the rest");
}

// ---- a tracked tx: confirmed again after a return to the mempool is reported again; the watch stops at final -----
{
  const [A, B, C] = ["a", "b", "c"].map((c) => c.repeat(64));
  const conf = (hash, h, extra = {}) => ({ confirmed: true, seen: true, block_hash: hash, block_height: h, block_time: 1, confirmations: null, ...extra });
  let w = newTxWatch(1_000, 1_000);
  const fired = [];
  const reorgs = [];
  const run = (s, ctx) => {
    const r = txWatchStep(w, s, { intervalMs: 15_000, trustUnseen: true, ...ctx });
    w = r.watch;
    if (r.confirmed) fired.push(s.block_hash);
    if (r.reorg) reorgs.push(r.reorg);
    return r;
  };
  let r = run({ confirmed: false, seen: true }, { now: 2_000, tip: 969_699 });
  assert.deepEqual([r.next, fired.length], [15_000, 0], "pending: asked every intervalMs");
  r = run(conf(A, 969_700), { now: 3_000, tip: 969_700 });
  assert.deepEqual([fired, r.next, r.set.confirmed, r.set.block_hash], [[A], CONFIRMED_POLL_MS, true, A], "confirmed: onConfirmed fires; checked until final");
  run(conf(A, 969_700), { now: 4_000, tip: 969_701 });
  assert.equal(fired.length, 1, "the same confirmation is reported once");
  r = run({ confirmed: false, seen: true }, { now: 5_000, tip: 969_701 });
  assert.deepEqual([reorgs, r.set.confirmed, r.set.backInMempool, r.set.reorged, r.next], [["mempool"], false, true, true, 15_000], "back in the mempool: a reorganization, pending again");
  r = run(conf(B, 969_702), { now: 6_000, tip: 969_702 });
  assert.deepEqual(fired, [A, B], "confirmed again: onConfirmed fires again (the flow leaves 'pending', the reservation gets its height back)");
  r = run(conf(C, 969_702), { now: 7_000, tip: 969_702 });
  assert.deepEqual([fired.length, reorgs, r.set.reorged], [2, ["mempool", "block"], true], "moved to another block: a reorganization, not a new confirmation");
  r = run(conf(C, 969_702), { now: 8_000, tip: 969_707 });
  assert.equal(r.next, 0, "6 confirmations: the watch stops");
  // a new watch (the caller tracks the same txid again) reports its first confirmation again
  const again = txWatchStep(newTxWatch(null, 9_000), conf(C, 969_702), { now: 9_000, tip: 969_703 });
  assert.equal(again.confirmed, true);
  console.log("finality watch: onConfirmed on every confirmation after a return to the mempool; a move to another block is a reorganization");
}

// ---- confirmed before, unknown now: asked again only until the last answer's block is final ----------------
{
  const A = "a".repeat(64);
  const unknown = { confirmed: false, seen: false };
  const w = txWatchStep(newTxWatch(0, 0), { confirmed: true, seen: true, block_hash: A, block_height: 969_800 }, { now: 1, tip: 969_800 }).watch;
  let r = txWatchStep(w, unknown, { now: 2, tip: 969_803 });
  assert.deepEqual([r.next, r.set.confirmed, r.reorg], [CONFIRMED_POLL_MS, undefined, null], "not final yet: the last answer is kept and asked again");
  r = txWatchStep(w, unknown, { now: 3, tip: 969_805 });
  assert.equal(r.next, 0, "final by the app's tip: the watch stops (the page shows 'final' now)");
  assert.equal(txWatchErrorDelay(w, { tip: 969_805 }), 0, "a failed read stops too once final");
  assert.equal(txWatchErrorDelay(w, { tip: 969_801 }), CONFIRMED_POLL_MS);
  const counted = txWatchStep(newTxWatch(0, 0), { confirmed: true, seen: true, block_hash: A, block_height: 969_800, confirmations: 6 }, { now: 1, tip: null }).watch;
  assert.equal(txWatchStep(counted, unknown, { now: 2, tip: null }).next, 0, "the server's own count counts");
  console.log("finality watch: an unknown answer after a confirmation is re-asked only until final");
}

// ---- unseen: dropped after the grace, re-checked for an hour, then no longer ---------------------------------
{
  const T = 5_000_000;
  const unseen = { confirmed: false, seen: false };
  let r = txWatchStep(newTxWatch(T, T), unseen, { now: T + DROP_GRACE_MS - 1 });
  assert.equal(r.set.dropped, undefined, "inside the grace: nothing said yet");
  r = txWatchStep(r.watch, unseen, { now: T + DROP_GRACE_MS + 1 });
  assert.deepEqual([r.set.dropped, r.set.watchEnded, r.next], [true, false, UNSEEN_POLL_MS]);
  assert.equal(txWatchErrorDelay(r.watch), UNSEEN_POLL_MS);
  const gone = txWatchStep(r.watch, unseen, { now: T + DROP_GRACE_MS + 1 + UNSEEN_WATCH_MS + 1 });
  assert.deepEqual([gone.set.dropped, gone.set.watchEnded, gone.next], [true, true, 0], "after an hour the page stops asking — and says so");
  const back = txWatchStep(r.watch, { confirmed: false, seen: true }, { now: T + DROP_GRACE_MS + 2 });
  assert.deepEqual([back.set.dropped, back.set.watchEnded], [false, false], "seen again: not dropped");
  const untrusted = txWatchStep(newTxWatch(T, T), unseen, { now: T + 10 * DROP_GRACE_MS, trustUnseen: false });
  assert.equal(untrusted.set.dropped, undefined, "an answer that means nothing does not run the clock");
  assert.match(droppedMessage("f".repeat(64), "fill"), /this page keeps checking for an hour/);
  console.log("finality watch: dropped after the grace, re-checked for an hour, then flagged as no longer checked");
}

console.log("finality: all checks passed");
