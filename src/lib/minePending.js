// Concurrent MINEs (owner decision F, audit mine-5) — the pure part of the
// mine console's state, unit-tested in test/minepending.test.js.
//
// The console used to hold ONE flow: while a MINE waited for its block the
// button said "Awaiting block" and stayed locked for ten minutes or more.
// Now a MINE leaves the build → sign → broadcast flow the moment it is
// broadcast and joins a PENDING LIST; the button is free again at once.
// Each pending item is tracked on its own (tx status → confirmed → the
// indexer's credit), and the inputs of every pending tx stay excluded from
// the next build through the existing broadcast records (txrecords.js,
// wallet.getBitcoinUtxos → excludePendingSpends), so a second MINE never
// re-spends — and so never replaces — the first.
//
//   item = { txid, ticker, broadcastAt, phase: "pending" | "confirmed" | "dropped",
//            resumed, unseenSince, lastChecked, pollError,
//            blockHeight, blockHash, blockTime, yieldLocal,
//            reconcile: "pending" | "done" | "timeout" | undefined, indexed }

import { mineYield } from "./yield.js";
import { fmtInt, shortTxid } from "./format.js";
import { creditOf } from "./minerlog.js";

/** Items kept in the list (the newest win; finished ones are dropped first). */
export const PENDING_MINES_MAX = 12;
/** Flow phases that hold the button: the wallet prompt is open or a broadcast is on its way. */
export const MINE_FLOW_BUSY = new Set(["building", "signing", "broadcasting"]);

/** A fresh item for a MINE this page just broadcast. */
export function newPendingMine({ txid, ticker, broadcastAt = Date.now() }) {
  return { txid, ticker, broadcastAt, phase: "pending", resumed: false, unseenSince: broadcastAt, lastChecked: null, pollError: null };
}

/**
 * The items to open the console with for `ticker`: every MINE record this
 * browser keeps for it (unconfirmed, or confirmed but its result not shown
 * yet — audit mine-4), oldest first, as resumed "pending" items. The first
 * /tx-status answer moves a confirmed one straight on to its reveal.
 */
export function resumeMinePendings(records, ticker) {
  return (records || [])
    .filter((r) => r && r.kind === "mine" && r.ticker === ticker)
    .sort((a, b) => a.at - b.at)
    .slice(-PENDING_MINES_MAX)
    .map((r) => ({ ...newPendingMine({ txid: r.txid, ticker, broadcastAt: r.at }), resumed: true }));
}

/** Is this item done (nothing left to poll)? */
export function isFinished(item) {
  return item.phase === "dropped" || (item.phase === "confirmed" && item.reconcile && item.reconcile !== "pending");
}

/** Append `item` (dedup by txid), dropping the oldest FINISHED items first beyond the cap. */
export function addPendingMine(list, item) {
  const rest = (list || []).filter((x) => x.txid !== item.txid);
  const next = [...rest, item];
  while (next.length > PENDING_MINES_MAX) {
    const i = next.findIndex(isFinished);
    next.splice(i >= 0 ? i : 0, 1);
  }
  return next;
}

/** Replace the item with `txid` by `fn(item)` (identity when absent). */
export function updatePendingMine(list, txid, fn) {
  let changed = false;
  const next = (list || []).map((x) => {
    if (x.txid !== txid) return x;
    const y = fn(x);
    if (y !== x) changed = true;
    return y;
  });
  return changed ? next : list;
}

/**
 * Fold one /tx-status answer (`status` = { confirmed, seen, block_height,
 * block_hash, block_time }) into a pending item at `now`. A tx the node
 * has not seen for longer than `graceMs` since it was last seen (or
 * broadcast) is "dropped" (replaced or evicted, audit usertx-6).
 */
export function applyMineStatus(item, status, now, graceMs) {
  if (!item || item.phase !== "pending" || !status) return item;
  if (status.confirmed && status.block_hash) {
    return {
      ...item,
      phase: "confirmed",
      blockHeight: status.block_height,
      blockHash: status.block_hash,
      blockTime: status.block_time,
      yieldLocal: mineYield(status.block_hash),
      reconcile: "pending",
      indexed: null,
      pollError: null,
    };
  }
  if (status.seen) return { ...item, unseenSince: now, lastChecked: now, pollError: null };
  const since = Number.isFinite(item.unseenSince) ? item.unseenSince : item.broadcastAt;
  if (Number.isFinite(since) && now - since > graceMs) return { ...item, phase: "dropped", pollError: null };
  return { ...item, lastChecked: now, pollError: null };
}

/** The indexer's verdict on a confirmed item: its /mines/by-txid row, or "timeout". */
export function applyReconcile(item, rowOrTimeout) {
  if (!item || item.phase !== "confirmed") return item;
  if (rowOrTimeout === "timeout") return { ...item, reconcile: "timeout" };
  return { ...item, reconcile: "done", indexed: rowOrTimeout };
}

/**
 * The single "mine" the console's LEDs, caption and digit strip follow: the
 * flow while it is building / signing / broadcasting or shows an error;
 * otherwise the newest item still in flight (pending, or confirmed and
 * waiting for the indexer), else the newest confirmed one; else idle.
 */
export function mineFocus(flow, pendings) {
  if (flow && flow.phase && flow.phase !== "idle") return flow;
  const list = pendings || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const x = list[i];
    if (x.phase === "pending" || (x.phase === "confirmed" && x.reconcile === "pending")) return x;
  }
  for (let i = list.length - 1; i >= 0; i--) if (list[i].phase === "confirmed") return list[i];
  return { phase: "idle" };
}

/** The button's label: the flow's phase while it runs, "Mine again" once anything was sent. */
export function mineButtonLabel(flowPhase, pendingCount) {
  switch (flowPhase) {
    case "building":
      return "Assembling…";
    case "signing":
      return "Awaiting signature";
    case "broadcasting":
      return "Broadcasting…";
    default:
      return pendingCount > 0 ? "Mine again" : "Mine";
  }
}

/** How many items are still waiting for a block. */
export function inMempoolCount(pendings) {
  return (pendings || []).filter((x) => x.phase === "pending").length;
}

/**
 * One row of the pending list, in plain words →
 *   { tone: "busy" | "ok" | "err" | "idle", tx, text }
 * (`tx` = the short txid the row links; `text` = its state).
 */
export function pendingMineRow(item, ticker) {
  const tx = shortTxid(item.txid, 6, 4);
  const row = (tone, text) => ({ tone, tx, text });
  if (item.phase === "dropped") return row("err", "left the mempool without confirming (replaced or dropped) — nothing was credited");
  if (item.phase === "pending") {
    const last = item.pollError ? ` · last check failed: ${item.pollError}` : "";
    return row("busy", `${item.resumed ? "resumed · " : ""}waiting for a block · checking every 15 s${last}`);
  }
  const block = `block #${fmtInt(item.blockHeight)}`;
  const digit = item.blockHash ? ` · digit ${String(item.blockHash).slice(-1)} (tier ${fmtInt(item.yieldLocal)})` : "";
  if (item.reconcile === "pending") return row("busy", `confirmed in ${block}${digit} · waiting for the indexer's credit`);
  if (item.reconcile === "timeout") return row("idle", `confirmed in ${block}${digit} · credit not indexed yet (see Portfolio › My mines)`);
  const c = creditOf(item.indexed, item.yieldLocal);
  if (!c) return row("err", `${block} · invalid MINE, 0 credited`);
  return row("ok", `${block}${digit} · +${fmtInt(c.credited)} ${ticker}${c.note ? ` (${c.note})` : ""}`);
}
