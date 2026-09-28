// Concurrent MINEs (owner decision F, audit mine-5): the pure pending-list
// model behind the mine console — resume, append / cap, status folding
// (confirmed / seen / dropped), the indexer's credit, which MINE the
// terminal follows, the button label, the row wording. Plain Node.
import assert from "node:assert/strict";
import {
  MINE_FLOW_BUSY,
  PENDING_MINES_MAX,
  addPendingMine,
  applyMineStatus,
  applyReconcile,
  inMempoolCount,
  isFinished,
  mineButtonLabel,
  mineFocus,
  newPendingMine,
  pendingMineRow,
  resumeMinePendings,
  updatePendingMine,
} from "../src/lib/minePending.js";
import { resumeMineState } from "../src/hooks/useMine.js";
import { mempoolLine } from "../src/lib/minerlog.js";

const TX = (c) => c.repeat(64);
const GRACE = 180_000;

// ---- resume: every MINE record of the ticker, oldest first ------------------------------------------------
{
  const recs = [
    { txid: TX("b"), kind: "mine", ticker: "LUCKY", inputs: [], at: 2_000, confirmed: false },
    { txid: TX("a"), kind: "mine", ticker: "LUCKY", inputs: [], at: 1_000, confirmed: true },
    { txid: TX("c"), kind: "mine", ticker: "SATS", inputs: [], at: 3_000, confirmed: false },
    { txid: TX("d"), kind: "send", ticker: "LUCKY", inputs: [], at: 4_000, confirmed: false },
  ];
  const r = resumeMinePendings(recs, "LUCKY");
  assert.deepEqual(r.map((x) => x.txid), [TX("a"), TX("b")], "both LUCKY mines, oldest first; not SATS, not the send");
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
  console.log("minepending list: concurrent items, dedupe by txid, cap evicts finished rows first");
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
  const c = applyMineStatus(p, { confirmed: true, block_height: 969_801, block_hash: hash, block_time: 1 }, t0 + 1, GRACE);
  assert.deepEqual([c.phase, c.blockHeight, c.yieldLocal, c.reconcile], ["confirmed", 969_801, 1000, "pending"]);
  assert.equal(applyMineStatus(c, { confirmed: false, seen: false }, t0 + 10 * GRACE, GRACE), c, "a confirmed item ignores later answers");
  assert.equal(applyMineStatus(p, null, t0, GRACE), p, "no answer, no change");
  // the indexer's credit
  const done = applyReconcile(c, { status: "settled", yield_smallest: 300, cap_exhausted: false });
  assert.deepEqual([done.reconcile, done.indexed.yield_smallest], ["done", 300]);
  assert.equal(isFinished(done), true);
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
  assert.equal(mineButtonLabel("idle", 2), "Mine again", "not 'Awaiting block': the button is free while MINEs wait (mine-5)");
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
  const conf = { ...p, phase: "confirmed", blockHeight: 969_802, blockHash: "0".repeat(63) + "f", yieldLocal: 1000, reconcile: "pending" };
  assert.equal(pendingMineRow(conf, "LUCKY").text, "confirmed in block #969,802 · digit f (tier 1,000) · waiting for the indexer's credit");
  const credited = pendingMineRow({ ...conf, reconcile: "done", indexed: { status: "settled", yield_smallest: 300, cap_exhausted: false } }, "LUCKY");
  assert.deepEqual([credited.tone, credited.text], ["ok", "block #969,802 · digit f (tier 1,000) · +300 LUCKY (cap reached: tier 1,000, credited 300)"]);
  assert.equal(pendingMineRow({ ...conf, reconcile: "done", indexed: { status: "invalid" } }, "LUCKY").tone, "err");
  assert.equal(pendingMineRow({ ...conf, reconcile: "timeout" }, "LUCKY").tone, "idle");
  assert.equal(pendingMineRow({ ...p, phase: "dropped" }, "LUCKY").tone, "err");
  assert.equal(mempoolLine(969_801, TX("a"), 0).text, "mempool  1 mine awaiting block #969,801");
  assert.equal(mempoolLine(969_801, TX("b"), 0, { count: 3 }).text, "mempool  3 of your mines awaiting block #969,801");
  console.log("minepending rows: plain words per state; the mempool line counts concurrent MINEs");
}

console.log("minepending: all checks passed");
