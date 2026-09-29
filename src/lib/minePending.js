// Concurrent MINEs — the pure part of the
// mine console's state, unit-tested in test/minepending.test.js.
//
// A MINE leaves the build → sign → broadcast flow the moment it is
// broadcast and joins a PENDING LIST, so the button is free again at once
// instead of saying "Awaiting block" and staying locked for the ten
// minutes or more a block can take.
// Each pending item is tracked on its own (tx status → confirmed → the
// indexer's credit → final), and the inputs of every pending tx stay
// excluded from the next build through the existing broadcast records
// (txrecords.js, wallet.getBitcoinUtxos → excludePendingSpends), so a
// second MINE never re-spends — and so never replaces — the first.
//
// A confirmed MINE is provisional until its block has FINAL_DEPTH
// confirmations (src/lib/finality.js): a chain reorganization can move it
// to another block (another hash, so maybe another tier) or back to the
// mempool. The item keeps being checked until final, and such a move is
// folded in — `reorgs` counts them, `reorg` describes the last one — so
// the console can say what changed instead of keeping a stale credit.
//
//   item = { txid, ticker, broadcastAt, phase: "pending" | "confirmed" | "dropped",
//            resumed, unseenSince, lastChecked, pollError, droppedAt,
//            blockHeight, blockHash, blockTime, yieldLocal,
//            reconcile: "pending" | "done" | "timeout" | undefined, indexed,
//            serverConfirmations, confirmations, final,
//            reorgs, reorg: { kind: "block" | "mempool", fromHeight, fromHash, fromYield } | null,
//            inputs (set when it is given up: its record goes, and comes back if it confirms after all) }

import { mineYield } from "./yield.js";
import { fmtInt, shortTxid } from "./format.js";
import { creditOf, mineInvalidReasonText } from "./minerlog.js";
import { FINAL_DEPTH, bestConfirmations, finalityText } from "./finality.js";

/** Finished items kept beyond this many are dropped (oldest first); an item still in flight is never dropped. */
export const PENDING_MINES_MAX = 12;
/** A MINE the node lost sight of is re-checked for this long after it was given up: it may still confirm. */
export const DROPPED_WATCH_MS = 60 * 60 * 1000;
/** Flow phases that hold the button: the wallet prompt is open or a broadcast is on its way. */
export const MINE_FLOW_BUSY = new Set(["building", "signing", "broadcasting"]);

/** A fresh item for a MINE this page just broadcast. */
export function newPendingMine({ txid, ticker, broadcastAt = Date.now() }) {
  return { txid, ticker, broadcastAt, phase: "pending", resumed: false, unseenSince: broadcastAt, lastChecked: null, pollError: null, reorgs: 0, reorg: null, final: false };
}

/**
 * The items to open the console with for `ticker`: every MINE record this
 * browser keeps for it (unconfirmed, or confirmed but not final and shown
 * yet), oldest first, as resumed "pending" items. The first
 * /tx-status answer moves a confirmed one straight on to its reveal.
 */
export function resumeMinePendings(records, ticker) {
  // every one of them (the record store's own cap bounds the count): a
  // provisional MINE left out would never have its reorganizations said
  return (records || [])
    .filter((r) => r && r.kind === "mine" && r.ticker === ticker && !r.done)
    .sort((a, b) => a.at - b.at)
    // the drop clock restarts from the last time the node reported it, not the broadcast
    .map((r) => ({ ...newPendingMine({ txid: r.txid, ticker, broadcastAt: r.at }), unseenSince: Math.max(r.at, Number.isFinite(r.seenAt) ? r.seenAt : 0), resumed: true }));
}

/**
 * Is this item done? A dropped one (it is still re-checked now and then —
 * it may confirm after all), or a confirmed one whose credit is known and
 * whose block is final. A provisional credit is still in flight.
 */
export function isFinished(item) {
  return item.phase === "dropped" || (item.phase === "confirmed" && !!item.reconcile && item.reconcile !== "pending" && item.final === true);
}

/**
 * Append `item` (dedup by txid); beyond the cap the oldest FINISHED items
 * go. An item still in flight (pending, or confirmed but not final) always
 * stays: evicted, it would no longer be checked, and a chain
 * reorganization that changed its credit would go unsaid. Their number is
 * bounded anyway — each confirms or drops, then turns final.
 */
export function addPendingMine(list, item) {
  const rest = (list || []).filter((x) => x.txid !== item.txid);
  const next = [...rest, item];
  while (next.length > PENDING_MINES_MAX) {
    const i = next.findIndex(isFinished);
    if (i < 0) break; // every item is still in flight: keep tracking all of them
    next.splice(i, 1);
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

/** What the console showed for a confirmed item: the indexer's credit once known, else the digit's tier. */
function shownYield(item) {
  if (item.reconcile === "done") {
    const c = creditOf(item.indexed, item.yieldLocal);
    return c ? c.credited : 0;
  }
  return Number.isFinite(item.yieldLocal) ? item.yieldLocal : null;
}

/** The last move of a confirmed item, before it is folded in. */
function reorgFrom(item, kind) {
  return { kind, fromHeight: item.blockHeight ?? null, fromHash: item.blockHash ?? null, fromYield: shownYield(item) };
}

/** `item` confirmed in the block of `status` (a /tx-status answer or a MineView row): digit, tier, credit pending again. */
function confirmedIn(item, { block_height, block_hash, block_time, confirmations = null, final = null }) {
  return {
    ...item,
    phase: "confirmed",
    blockHeight: block_height,
    blockHash: block_hash,
    blockTime: block_time ?? null,
    yieldLocal: mineYield(block_hash),
    reconcile: "pending",
    indexed: null,
    serverConfirmations: Number.isInteger(confirmations) ? confirmations : null,
    confirmations: Number.isInteger(confirmations) ? confirmations : null,
    final: final === true,
    droppedAt: null,
    pollError: null,
  };
}

/**
 * Fold one /tx-status answer (`status` = { confirmed, seen, block_height,
 * block_hash, block_time, confirmations?, final? }) into an item at `now`:
 *
 *   pending    confirmed → confirmed (the tier from the block hash);
 *              unknown to the node for longer than `graceMs` since it was
 *              last seen (or broadcast) → dropped (replaced or evicted)
 *              — but only while `trustUnseen`: while the
 *              indexer lags or its node has no peers, "unknown" means
 *              nothing and the clock does not run
 *   dropped    confirmed after all → confirmed; seen again → pending
 *   confirmed  same block → its depth; ANOTHER block (a chain
 *              reorganization) → confirmed there, the tier recomputed and
 *              the credit asked for again; back in the mempool → pending;
 *              unknown → unchanged (the indexer may be recovering from a
 *              reorganization; asked again later)
 */
export function applyMineStatus(item, status, now, graceMs, { trustUnseen = true } = {}) {
  if (!item || !status) return item;
  const confirmedNow = status.confirmed && status.block_hash;
  if (item.phase === "pending") {
    if (confirmedNow) return confirmedIn(item, status);
    if (status.seen || !trustUnseen) return { ...item, unseenSince: now, lastChecked: now, pollError: null };
    const since = Number.isFinite(item.unseenSince) ? item.unseenSince : item.broadcastAt;
    if (Number.isFinite(since) && now - since > graceMs) return { ...item, phase: "dropped", droppedAt: now, lastChecked: now, pollError: null };
    return { ...item, lastChecked: now, pollError: null };
  }
  if (item.phase === "dropped") {
    if (confirmedNow) return confirmedIn(item, status);
    if (status.seen) return { ...item, phase: "pending", droppedAt: null, unseenSince: now, lastChecked: now, pollError: null };
    return { ...item, lastChecked: now, pollError: null };
  }
  if (item.phase !== "confirmed") return item;
  if (confirmedNow) {
    if (status.block_hash === item.blockHash) {
      const server = Number.isInteger(status.confirmations) ? status.confirmations : item.serverConfirmations ?? null;
      return { ...item, serverConfirmations: server, final: item.final || status.final === true, lastChecked: now, pollError: null };
    }
    return { ...confirmedIn(item, status), reorgs: (item.reorgs || 0) + 1, reorg: reorgFrom(item, "block"), lastChecked: now };
  }
  if (status.seen) {
    return {
      ...item,
      phase: "pending",
      blockHeight: null,
      blockHash: null,
      blockTime: null,
      yieldLocal: null,
      reconcile: undefined,
      indexed: null,
      serverConfirmations: null,
      confirmations: null,
      final: false,
      unseenSince: now,
      lastChecked: now,
      pollError: null,
      reorgs: (item.reorgs || 0) + 1,
      reorg: reorgFrom(item, "mempool"),
    };
  }
  return { ...item, lastChecked: now, pollError: null };
}

/**
 * The indexer's verdict on a confirmed item: its /mines/by-txid row, or
 * "timeout". A row credited from ANOTHER block than the one the item shows
 * (a chain reorganization between the two reads) moves the item there —
 * the row is the credit. The row's depth (`confirmations`, `final`) is kept.
 */
export function applyReconcile(item, rowOrTimeout) {
  if (!item || item.phase !== "confirmed") return item;
  if (rowOrTimeout === "timeout") return { ...item, reconcile: "timeout" };
  const row = rowOrTimeout;
  let next = { ...item, reconcile: "done", indexed: row };
  if (row && row.block_hash && item.blockHash && row.block_hash !== item.blockHash && Number.isInteger(row.block_height)) {
    next = { ...confirmedIn(item, { block_height: row.block_height, block_hash: row.block_hash, block_time: row.block_time }), reconcile: "done", indexed: row, reorgs: (item.reorgs || 0) + 1, reorg: reorgFrom(item, "block") };
  }
  if (row && Number.isInteger(row.confirmations)) next.serverConfirmations = row.confirmations;
  if (row && row.final === true) next.final = true;
  return next;
}

/**
 * A MINE found in the indexer's ledger (its /mines/by-txid row) before it
 * was given up as dropped: confirmed in the row's block, credit known.
 */
export function confirmedFromRow(item, row) {
  if (!item || !row || !row.block_hash || !Number.isInteger(row.block_height)) return item;
  return applyReconcile(confirmedIn(item, { block_height: row.block_height, block_hash: row.block_hash, block_time: row.block_time }), row);
}

/**
 * The item's depth at `tip` (the indexer's applied height):
 * `confirmations` = the larger of the server's count and the one from
 * `tip`; `final` once it reaches FINAL_DEPTH (it stays final). Identity
 * when nothing changed.
 */
export function withDepth(item, tip) {
  if (!item || item.phase !== "confirmed") return item;
  const n = bestConfirmations(item.serverConfirmations ?? null, item.blockHeight, tip);
  const final = item.final === true || (n !== null && n >= FINAL_DEPTH);
  if (n === item.confirmations && final === item.final) return item;
  return { ...item, confirmations: n, final };
}

/**
 * The single "mine" the console's LEDs, caption and digit strip follow: the
 * flow while it is building / signing / broadcasting or shows an error;
 * otherwise the newest item still waiting for a block or the indexer's
 * credit, else the newest confirmed one; else idle.
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
export function pendingMineRow(item, ticker, now = Date.now()) {
  const tx = shortTxid(item.txid, 6, 4);
  const row = (tone, text) => ({ tone, tx, text });
  if (item.phase === "dropped") {
    const ended = Number.isFinite(item.droppedAt) && now - item.droppedAt >= DROPPED_WATCH_MS;
    return row(
      "err",
      ended
        ? "not seen by the indexer's node for over an hour — no longer checked here (see Portfolio › My mines)"
        : "not seen by the indexer's node for a while — it may still confirm; checking every 2 min for an hour (see Portfolio › My mines)",
    );
  }
  if (item.phase === "pending") {
    const last = item.pollError ? ` · last check failed: ${item.pollError}` : "";
    const back = item.reorg?.kind === "mempool" ? "back in the mempool after a chain reorganization · " : "";
    return row("busy", `${item.resumed ? "resumed · " : ""}${back}waiting for a block · checking every 15 s${last}`);
  }
  const block = `block #${fmtInt(item.blockHeight)}`;
  const digit = item.blockHash ? ` · digit ${String(item.blockHash).slice(-1)} (tier ${fmtInt(item.yieldLocal)})` : "";
  const moved = item.reorg?.kind === "block" && !item.final ? ` · moved from block #${fmtInt(item.reorg.fromHeight)} by a chain reorganization` : "";
  const depth = finalityText(item.confirmations);
  const fin = depth ? ` · ${depth}` : "";
  if (item.reconcile === "pending") return row("busy", `confirmed in ${block}${digit} · waiting for the indexer's credit${moved}`);
  if (item.reconcile === "timeout") return row("idle", `confirmed in ${block}${digit} · credit not indexed yet (see Portfolio › My mines)${fin}`);
  const c = creditOf(item.indexed, item.yieldLocal);
  if (!c) {
    const why = mineInvalidReasonText(item.indexed?.reason);
    return row(item.final ? "err" : "busy", `${block} · invalid MINE, 0 credited${why ? ` (${why})` : ""}${fin}${moved}`);
  }
  return row(item.final ? "ok" : "busy", `${block}${digit} · +${fmtInt(c.credited)} ${ticker}${c.note ? ` (${c.note})` : ""}${fin}${moved}`);
}
