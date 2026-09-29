// Concurrent MINEs: the pure pending-list
// model behind the mine console — resume, append / cap, status folding
// (confirmed / seen / dropped), the indexer's credit, which MINE the
// terminal follows, the button label, the row wording. Plain Node.
import assert from "node:assert/strict";
import {
  DROPPED_WATCH_MS,
  MINE_FLOW_BUSY,
  PENDING_MINES_MAX,
  addPendingMine,
  applyMineStatus,
  applyReconcile,
  confirmedFromRow,
  inMempoolCount,
  isFinished,
  mineButtonLabel,
  mineFocus,
  newPendingMine,
  pendingMineRow,
  resumeMinePendings,
  updatePendingMine,
  withDepth,
} from "../src/lib/minePending.js";
import { resumeMineState } from "../src/hooks/useMine.js";
import { seedWaitNote } from "../src/lib/retry.js";
import { blockFoundLine, blockLineKey, finalLine, mempoolLine, reconcileLine, reorgLine, settledYoursLine } from "../src/lib/minerlog.js";
import { FINAL_DEPTH } from "../src/lib/finality.js";

const TX = (c) => c.repeat(64);
const GRACE = 180_000;

// ---- resume: every MINE record of the ticker, oldest first ------------------------------------------------
{
  const recs = [
    { txid: TX("b"), kind: "mine", ticker: "LUCKY", inputs: [], at: 2_000, confirmed: false },
    { txid: TX("a"), kind: "mine", ticker: "LUCKY", inputs: [], at: 1_000, confirmed: true },
    { txid: TX("c"), kind: "mine", ticker: "SATS", inputs: [], at: 3_000, confirmed: false },
    { txid: TX("d"), kind: "send", ticker: "LUCKY", inputs: [], at: 4_000, confirmed: false },
    { txid: TX("e"), kind: "mine", ticker: "LUCKY", inputs: [], at: 500, confirmed: true, done: true },
  ];
  const r = resumeMinePendings(recs, "LUCKY");
  assert.deepEqual(r.map((x) => x.txid), [TX("a"), TX("b")], "both LUCKY mines, oldest first; not SATS, not the send, not one already shown and kept only as a guard");
  assert.ok(r.every((x) => x.phase === "pending" && x.resumed === true), "resumed as pending — the first /tx-status answer moves a confirmed one on");
  assert.equal(r[1].broadcastAt, 2_000);
  assert.deepEqual(resumeMinePendings([], "LUCKY"), []);
  // the single-item view kept for older callers: the newest
  const one = resumeMineState("bc1x", "LUCKY", recs);
  assert.deepEqual([one.phase, one.txid, one.resumed], ["pending", TX("b"), true]);
  assert.equal(resumeMineState("bc1x", "ORE", recs).phase, "idle");
  console.log("minepending resume: every unshown MINE of the ticker comes back, oldest first");
}

// ---- append, dedupe, cap (finished rows go first) -----------------------------------------------------------
{
  let l = [];
  l = addPendingMine(l, newPendingMine({ txid: TX("1"), ticker: "LUCKY", broadcastAt: 10 }));
  l = addPendingMine(l, newPendingMine({ txid: TX("2"), ticker: "LUCKY", broadcastAt: 20 }));
  assert.equal(l.length, 2, "a second MINE while the first is pending — both tracked");
  assert.equal(inMempoolCount(l), 2);
  l = addPendingMine(l, newPendingMine({ txid: TX("1"), ticker: "LUCKY", broadcastAt: 30 }));
  assert.equal(l.length, 2, "same txid is not added twice");
  // fill beyond the cap: the finished (dropped) one is evicted before any in-flight one
  let big = [{ ...newPendingMine({ txid: TX("f"), ticker: "X", broadcastAt: 0 }), phase: "dropped" }];
  for (let i = 0; i < PENDING_MINES_MAX; i++) big = addPendingMine(big, newPendingMine({ txid: i.toString(16).padStart(64, "0"), ticker: "X", broadcastAt: i }));
  assert.equal(big.length, PENDING_MINES_MAX);
  assert.ok(!big.some((x) => x.txid === TX("f")), "the dropped row went first");
  assert.equal(inMempoolCount(big), PENDING_MINES_MAX, "no in-flight MINE was evicted");
  const same = updatePendingMine(l, TX("9"), (x) => ({ ...x, phase: "dropped" }));
  assert.equal(same, l, "unknown txid → the same list");
  // beyond the cap with nothing finished: a provisional credit (confirmed, not final) is never evicted
  const provisional = { ...newPendingMine({ txid: TX("p"), ticker: "X", broadcastAt: 0 }), phase: "confirmed", reconcile: "done", final: false };
  let full = [provisional];
  for (let i = 0; i < PENDING_MINES_MAX; i++) full = addPendingMine(full, newPendingMine({ txid: (i + 100).toString(16).padStart(64, "0"), ticker: "X", broadcastAt: i + 1 }));
  assert.equal(full.length, PENDING_MINES_MAX + 1, "every in-flight MINE stays tracked");
  assert.ok(full.some((x) => x.txid === TX("p")), "the provisional one is still checked — a reorganization of it is said");
  const gone = full[1].txid;
  full = updatePendingMine(full, gone, (x) => ({ ...x, phase: "dropped" }));
  full = addPendingMine(full, newPendingMine({ txid: TX("q"), ticker: "X", broadcastAt: 99 }));
  assert.equal(full.length, PENDING_MINES_MAX + 1, "a finished row makes room for the new one");
  assert.ok(!full.some((x) => x.txid === gone) && full.some((x) => x.txid === TX("p")), "the dropped row went, the provisional one stays");
  // resume brings back every unshown MINE of the ticker, not only the newest 12
  const recs = Array.from({ length: PENDING_MINES_MAX + 3 }, (_, i) => ({ txid: (i + 200).toString(16).padStart(64, "0"), kind: "mine", ticker: "X", inputs: [], at: i, confirmed: i < 5 }));
  assert.equal(resumeMinePendings(recs, "X").length, PENDING_MINES_MAX + 3);
  console.log("minepending list: concurrent items, dedupe by txid, cap evicts finished rows only — never one in flight");
}

// ---- status folding -----------------------------------------------------------------------------------------
{
  const t0 = 1_000_000;
  const p = newPendingMine({ txid: TX("a"), ticker: "LUCKY", broadcastAt: t0 });
  // seen in the mempool: stays pending, the unseen clock restarts
  const seen = applyMineStatus(p, { confirmed: false, seen: true }, t0 + 60_000, GRACE);
  assert.equal(seen.phase, "pending");
  assert.equal(seen.unseenSince, t0 + 60_000);
  // not seen, inside the grace → still pending
  assert.equal(applyMineStatus(seen, { confirmed: false, seen: false }, t0 + 60_000 + GRACE - 1, GRACE).phase, "pending");
  // not seen for longer than the grace since last seen → dropped
  assert.equal(applyMineStatus(seen, { confirmed: false, seen: false }, t0 + 60_000 + GRACE + 1, GRACE).phase, "dropped");
  assert.equal(applyMineStatus(p, { confirmed: false, seen: false }, t0 + GRACE + 1, GRACE).phase, "dropped", "never seen → dropped after the grace");
  // confirmed: yield from the block hash, reconcile pending
  const hash = "0".repeat(63) + "f";
  const c = applyMineStatus(p, { confirmed: true, block_height: 970_101, block_hash: hash, block_time: 1 }, t0 + 1, GRACE);
  assert.deepEqual([c.phase, c.blockHeight, c.yieldLocal, c.reconcile], ["confirmed", 970_101, 1000, "pending"]);
  const unknown = applyMineStatus(c, { confirmed: false, seen: false }, t0 + 10 * GRACE, GRACE);
  assert.deepEqual([unknown.phase, unknown.blockHash, unknown.reorgs], ["confirmed", hash, 0], "a confirmed item the indexer does not know right now stays as it is (it may be recovering)");
  assert.equal(applyMineStatus(p, null, t0, GRACE), p, "no answer, no change");
  // the indexer's credit
  const done = applyReconcile(c, { status: "settled", yield_smallest: 300, cap_exhausted: false });
  assert.deepEqual([done.reconcile, done.indexed.yield_smallest], ["done", 300]);
  assert.equal(isFinished(done), false, "credited but provisional: still in flight until final");
  assert.equal(isFinished(withDepth(done, 970_105)), false, "5 confirmations");
  assert.equal(isFinished(withDepth(done, 970_106)), true, "6 confirmations: final");
  assert.equal(applyReconcile(c, "timeout").reconcile, "timeout");
  assert.equal(isFinished(c), false, "confirmed but not credited yet is still in flight");
  assert.equal(applyReconcile(p, "timeout"), p, "only a confirmed item reconciles");
  console.log("minepending status: seen / grace / dropped / confirmed (+ local yield) / credited / timeout");
}

// ---- which MINE the terminal follows; the button -----------------------------------------------------------
{
  const a = { ...newPendingMine({ txid: TX("a"), ticker: "L", broadcastAt: 1 }), phase: "confirmed", reconcile: "done", indexed: { status: "settled", yield_smallest: 100 }, blockHash: "0".repeat(64), blockHeight: 5, yieldLocal: 100 };
  const b = newPendingMine({ txid: TX("b"), ticker: "L", broadcastAt: 2 });
  assert.equal(mineFocus({ phase: "signing", startedAt: 9 }, [a, b]).phase, "signing", "a MINE being signed has the terminal");
  assert.equal(mineFocus({ phase: "idle" }, [a, b]).txid, TX("b"), "else the newest one in flight");
  assert.equal(mineFocus({ phase: "idle" }, [a]).txid, TX("a"), "else the newest confirmed one");
  assert.equal(mineFocus({ phase: "idle" }, []).phase, "idle");
  assert.equal(mineFocus({ phase: "error", error: "x" }, [b]).phase, "error");
  assert.equal(mineButtonLabel("idle", 0), "Mine");
  assert.equal(mineButtonLabel("idle", 2), "Mine again", "not 'Awaiting block': the button is free while MINEs wait");
  assert.equal(mineButtonLabel("signing", 2), "Awaiting signature");
  assert.equal(mineButtonLabel("building", 0), "Assembling…");
  assert.equal(mineButtonLabel("broadcasting", 0), "Broadcasting…");
  assert.ok(!MINE_FLOW_BUSY.has("pending") && MINE_FLOW_BUSY.has("signing"), "pending never holds the button");
  console.log("minepending focus + button: the flow, else the newest in flight; 'Mine again' while others wait");
}

// ---- row wording + the mempool line -------------------------------------------------------------------------
{
  const p = newPendingMine({ txid: TX("a"), ticker: "LUCKY", broadcastAt: 1 });
  const r = pendingMineRow(p, "LUCKY");
  assert.equal(r.tone, "busy");
  assert.equal(r.tx, "aaaaaa…aaaa");
  assert.equal(r.text, "waiting for a block · checking every 15 s");
  assert.match(pendingMineRow({ ...p, resumed: true, pollError: "offline" }, "LUCKY").text, /^resumed · waiting for a block · checking every 15 s · last check failed: offline$/);
  const conf = { ...p, phase: "confirmed", blockHeight: 970_102, blockHash: "0".repeat(63) + "f", yieldLocal: 1000, reconcile: "pending" };
  assert.equal(pendingMineRow(conf, "LUCKY").text, "confirmed in block #970,102 · digit f (tier 1,000) · waiting for the indexer's credit");
  const credited = pendingMineRow({ ...conf, reconcile: "done", indexed: { status: "settled", yield_smallest: 300, cap_exhausted: false }, confirmations: 6, final: true }, "LUCKY");
  assert.deepEqual([credited.tone, credited.text], ["ok", "block #970,102 · digit f (tier 1,000) · +300 LUCKY (cap reached: tier 1,000, credited 300) · final"]);
  const provisional = pendingMineRow({ ...conf, reconcile: "done", indexed: { status: "settled", yield_smallest: 1000, cap_exhausted: false }, confirmations: 1, final: false }, "LUCKY");
  assert.deepEqual([provisional.tone, provisional.text], ["busy", "block #970,102 · digit f (tier 1,000) · +1,000 LUCKY · provisional · 1/6 confirmations"]);
  assert.equal(pendingMineRow({ ...conf, reconcile: "done", indexed: { status: "invalid" }, final: true }, "LUCKY").tone, "err");
  assert.match(pendingMineRow({ ...conf, reconcile: "done", indexed: { status: "invalid", reason: "deploy_same_block" }, final: true }, "LUCKY").text, /invalid MINE, 0 credited \(it confirmed in the same block as the ticker's creation — mining starts in the next block\)/, "the reason is said");
  assert.equal(pendingMineRow({ ...conf, reconcile: "timeout" }, "LUCKY").tone, "idle");
  const dropped = pendingMineRow({ ...p, phase: "dropped" }, "LUCKY");
  assert.equal(dropped.tone, "err");
  assert.ok(!/nothing was credited/.test(dropped.text) && /may still confirm/.test(dropped.text), "a MINE the node lost sight of may still confirm — never 'nothing was credited'");
  assert.match(pendingMineRow({ ...p, phase: "dropped", droppedAt: 1_000 }, "LUCKY", 1_000 + DROPPED_WATCH_MS - 1).text, /checking every 2 min for an hour/);
  const ended = pendingMineRow({ ...p, phase: "dropped", droppedAt: 1_000 }, "LUCKY", 1_000 + DROPPED_WATCH_MS);
  assert.ok(/no longer checked here/.test(ended.text) && !/checking every/.test(ended.text), "after the hour the row no longer claims to check");
  assert.equal(mempoolLine(970_101, TX("a"), 0).text, "mempool  1 mine awaiting block #970,101");
  assert.equal(mempoolLine(970_101, TX("b"), 0, { count: 3 }).text, "mempool  3 of your mines awaiting block #970,101");
  console.log("minepending rows: plain words per state; the mempool line counts concurrent MINEs");
}

// ---- finality: a confirmed MINE is provisional until final, and a chain reorganization is followed ---------------
{
  const t0 = 5_000_000;
  const HF = "0".repeat(63) + "f"; // tier 1,000
  const H3 = "1".repeat(63) + "3"; // tier 100
  const p = newPendingMine({ txid: TX("a"), ticker: "LUCKY", broadcastAt: t0 });
  const c = applyMineStatus(p, { confirmed: true, block_height: 970_101, block_hash: HF, confirmations: 1, final: false }, t0 + 1, GRACE);
  const credited = applyReconcile(c, { status: "settled", yield_smallest: 1000, cap_exhausted: false, block_height: 970_101, block_hash: HF, confirmations: 1, final: false });
  assert.deepEqual([credited.reconcile, credited.final, withDepth(credited, 970_101).confirmations], ["done", false, 1]);
  // same block again: only its depth moves
  const same = applyMineStatus(credited, { confirmed: true, block_height: 970_101, block_hash: HF, confirmations: 3 }, t0 + 60_000, GRACE);
  assert.deepEqual([same.reconcile, same.serverConfirmations, same.reorgs], ["done", 3, 0]);
  // (1) the block was replaced and the MINE confirmed in another one: the tier is recomputed, the credit asked for again
  const moved = applyMineStatus(credited, { confirmed: true, block_height: 970_102, block_hash: H3 }, t0 + 120_000, GRACE);
  assert.deepEqual([moved.phase, moved.blockHeight, moved.yieldLocal, moved.reconcile, moved.indexed, moved.reorgs], ["confirmed", 970_102, 100, "pending", null, 1]);
  assert.deepEqual(moved.reorg, { kind: "block", fromHeight: 970_101, fromHash: HF, fromYield: 1000 });
  assert.equal(isFinished(moved), false);
  const line = reorgLine(moved, "LUCKY", 0);
  assert.equal(line.text, "chain reorganization  block #970,101 was replaced — this MINE is now in block #970,102 (digit 3 → tier 100; it showed +1,000 LUCKY)");
  assert.ok(line.key.includes(H3), "the reorg line's key names the new block — never deduplicated away");
  assert.match(pendingMineRow(withDepth(moved, 970_102), "LUCKY").text, /moved from block #970,101 by a chain reorganization/);
  // (2) the block was replaced and the MINE is back in the mempool: pending again, the same grace
  const back = applyMineStatus(credited, { confirmed: false, seen: true, in_mempool: true }, t0 + 120_000, GRACE);
  assert.deepEqual([back.phase, back.blockHash, back.reconcile, back.reorgs, back.reorg.kind], ["pending", null, undefined, 1, "mempool"]);
  assert.match(reorgLine(back, "LUCKY", 0).text, /back in the mempool and is credited from the block that confirms it; it showed \+1,000 LUCKY/);
  assert.match(pendingMineRow(back, "LUCKY").text, /^back in the mempool after a chain reorganization · waiting for a block/);
  // …and confirms again: a new block, the lines print again (their keys carry the hash)
  const again = applyMineStatus(back, { confirmed: true, block_height: 970_103, block_hash: H3 }, t0 + 180_000, GRACE);
  assert.deepEqual([again.phase, again.blockHeight, again.reorgs], ["confirmed", 970_103, 1]);
  const againDone = applyReconcile(again, { status: "settled", yield_smallest: 100, cap_exhausted: false, block_hash: H3, block_height: 970_103 });
  assert.notEqual(settledYoursLine("LUCKY", againDone, 0).key, settledYoursLine("LUCKY", credited, 0).key, "the banner of the new block is not a repeat of the old one");
  assert.notEqual(reconcileLine(againDone, 0).key, reconcileLine(credited, 0).key);
  assert.notEqual(blockFoundLine({ height: 970_101, hash: H3 }).key, blockFoundLine({ height: 970_101, hash: HF }).key, "a replacing block at the same height is a new line");
  assert.equal(blockLineKey(970_101, HF.toUpperCase()), `block:970101:${HF}`);
  // (3) the credit comes from another block than tx-status named: the row wins
  const rowMoved = applyReconcile(c, { status: "settled", yield_smallest: 100, cap_exhausted: false, block_height: 970_102, block_hash: H3 });
  assert.deepEqual([rowMoved.blockHash, rowMoved.yieldLocal, rowMoved.reconcile, rowMoved.reorgs], [H3, 100, "done", 1]);
  // provisional banner, then final
  const y = settledYoursLine("LUCKY", withDepth(credited, 970_102), 0);
  assert.equal(y.text, "LUCKY mine settled  block 970,101  ✓ yours  ·  provisional 2/6 confirmations");
  assert.equal(finalLine("LUCKY", withDepth(credited, 970_105), 0), null, "5 confirmations: not final");
  const fin = withDepth(credited, 970_106);
  assert.equal(fin.final, true);
  assert.equal(finalLine("LUCKY", fin, 0).text, "LUCKY mine final  block 970,101  6 confirmations  ·  +1,000 LUCKY can no longer change");
  assert.equal(settledYoursLine("LUCKY", fin, 0).text, "LUCKY mine settled  block 970,101  ✓ yours");
  assert.equal(withDepth(fin, 970_106), fin, "identity when nothing changed");
  assert.equal(withDepth({ ...credited, final: false }, null).final, false, "unknown tip: not final");
  assert.equal(applyReconcile(c, { status: "settled", yield_smallest: 1000, block_hash: HF, block_height: 970_101, final: true }).final, true, "the indexer's final: true counts");
  assert.equal(FINAL_DEPTH, 6);
  console.log("minepending reorg: provisional until 6 confirmations; a moved MINE is re-credited from its new block and said so");
}

// ---- finality: no drop while the node's "unknown" means nothing; a dropped MINE can come back -----------------------
{
  const t0 = 9_000_000;
  const p = newPendingMine({ txid: TX("b"), ticker: "LUCKY", broadcastAt: t0 });
  const held = applyMineStatus(p, { confirmed: false, seen: false }, t0 + 10 * GRACE, GRACE, { trustUnseen: false });
  assert.deepEqual([held.phase, held.unseenSince], ["pending", t0 + 10 * GRACE], "the indexer lags or its node has no peers: the unseen clock does not run");
  const dropped = applyMineStatus(p, { confirmed: false, seen: false }, t0 + GRACE + 1, GRACE);
  assert.deepEqual([dropped.phase, dropped.droppedAt], ["dropped", t0 + GRACE + 1]);
  const seenAgain = applyMineStatus(dropped, { confirmed: false, seen: true }, t0 + 2 * GRACE, GRACE);
  assert.equal(seenAgain.phase, "pending", "seen again: pending again");
  const late = applyMineStatus(dropped, { confirmed: true, block_height: 970_200, block_hash: "2".repeat(64) }, t0 + 3 * GRACE, GRACE);
  assert.deepEqual([late.phase, late.blockHeight, late.reconcile], ["confirmed", 970_200, "pending"], "it confirmed after all");
  // the indexer's ledger answers before a MINE is given up
  const fromRow = confirmedFromRow(p, { status: "settled", yield_smallest: 500, cap_exhausted: false, block_height: 970_200, block_hash: "0".repeat(63) + "c", confirmations: 2, final: false });
  assert.deepEqual([fromRow.phase, fromRow.reconcile, fromRow.indexed.yield_smallest, fromRow.serverConfirmations], ["confirmed", "done", 500, 2]);
  assert.equal(confirmedFromRow(p, null), p);
  console.log("minepending unseen: never dropped while the node's answer cannot be trusted; dropped MINEs are watched and come back");
}

// ---- finality: the scan wait after a reorganization is not called a first use ----------------------------------------
{
  assert.match(seedWaitNote({ elapsedMs: 5_000 }), /^Setting up this wallet: /);
  const again = seedWaitNote({ elapsedMs: 5_000, rescan: true });
  assert.ok(/^Setting up this wallet again \(after a chain reorganization or an indexer restart\): /.test(again), again);
  console.log("minepending seed wait: a rescan after a reorganization is said as such");
}

console.log("minepending: all checks passed");
