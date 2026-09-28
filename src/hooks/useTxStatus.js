import { useContext, useEffect, useRef, useState } from "react";
import { AppContext } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { DROP_GRACE_MS } from "../lib/txrecords.js";
import { FINAL_DEPTH, bestConfirmations } from "../lib/finality.js";
import { friendlyError } from "./useWallet.js";

const DEFAULT_POLL_MS = 15_000;
/** A confirmed tx is re-checked this often until its block is final (a chain reorganization can still undo it). */
export const CONFIRMED_POLL_MS = 60_000;
/** A tx the node lost sight of is re-checked this often… */
export const UNSEEN_POLL_MS = 120_000;
/** …for this long: it may still confirm. */
export const UNSEEN_WATCH_MS = 60 * 60 * 1000;
const EMPTY = {
  confirmed: false,
  dropped: false,
  watchEnded: false,
  block_height: null,
  block_hash: null,
  block_time: null,
  serverConfirmations: null,
  serverFinal: false,
  reorged: false,
  backInMempool: false,
  pollError: null,
  lastChecked: null,
};

/**
 * Poll `/tx-status/:txid` — until its block is FINAL, not just until it
 * confirms. Returns `{ confirmed, final, confirmations, dropped,
 * watchEnded, reorged, backInMempool, block_height, block_hash,
 * block_time, pollError, lastChecked }`. `onConfirmed(status)` fires when
 * the tx confirms, and again when it confirms after a chain reorganization
 * put it back in the mempool (or after the caller stopped and resumed
 * tracking it); `onReorg(kind, status)` fires when a chain reorganization
 * moved it — kind "block" (it now confirms in another block) or "mempool"
 * (it is back in the mempool, waiting to confirm again).
 *
 *   pending   every `intervalMs`
 *   confirmed every CONFIRMED_POLL_MS until `confirmations` reaches
 *             FINAL_DEPTH (the indexer's applied height from the app's
 *             health, or the server's own count — the larger)
 *
 * `dropped` (audit usertx-2 / usertx-6): the indexer's node has reported the
 * tx unknown (`seen:false` — not in its mempool, not confirmed) for longer
 * than DROP_GRACE_MS since it was last seen. That is not proof it is gone
 * (the node may simply not have it), so it is re-checked every
 * UNSEEN_POLL_MS for UNSEEN_WATCH_MS and comes back if it confirms;
 * `watchEnded` is true once that time is over and it is no longer checked.
 * The unseen clock does not run while the app's health says such an answer
 * means nothing (the indexer lagging, stalled or rebuilding, or its node
 * without peers — `sync.trustUnseen`).
 */
export function useTxStatus(txid, { intervalMs = DEFAULT_POLL_MS, onConfirmed, onReorg, since = null } = {}) {
  const [state, setState] = useState(EMPTY);
  const cbRef = useRef(onConfirmed);
  cbRef.current = onConfirmed;
  const reorgRef = useRef(onReorg);
  reorgRef.current = onReorg;
  const sinceRef = useRef(since);
  sinceRef.current = since;
  // The app's view of the indexer (null outside the app's provider, e.g. a bare render).
  const app = useContext(AppContext);
  const tip = app?.sync?.indexed ?? null;
  const tipRef = useRef(tip);
  tipRef.current = tip;
  const trustRef = useRef(app?.sync?.trustUnseen !== false);
  trustRef.current = app?.sync?.trustUnseen !== false;

  useEffect(() => {
    setState(EMPTY);
    if (!txid) return undefined;
    let alive = true;
    let timer = null;
    // Each run is a new watch: its first confirmation fires onConfirmed.
    let watch = newTxWatch(sinceRef.current, Date.now());
    const check = async () => {
      let next;
      try {
        const s = await indexer.txStatus(txid);
        if (!alive) return;
        const step = txWatchStep(watch, s, { now: Date.now(), tip: tipRef.current, trustUnseen: trustRef.current, intervalMs });
        watch = step.watch;
        setState((st) => ({ ...st, ...step.set }));
        if (step.confirmed) cbRef.current?.(s);
        if (step.reorg) reorgRef.current?.(step.reorg, s);
        next = step.next;
      } catch (e) {
        if (!alive) return;
        setState((st) => ({ ...st, pollError: friendlyError(e), lastChecked: Date.now() }));
        next = txWatchErrorDelay(watch, { tip: tipRef.current, intervalMs });
      }
      if (alive && next > 0) timer = setTimeout(check, next);
    };
    check();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [txid, intervalMs]);

  const confirmations = state.confirmed ? bestConfirmations(state.serverConfirmations, state.block_height, tip) : null;
  const final = state.confirmed && (state.serverFinal || (confirmations !== null && confirmations >= FINAL_DEPTH));
  return { ...state, confirmations, final };
}

// ---- the watch itself, pure (test/finality.test.js feeds it answer sequences) -------------------------------

/**
 * A fresh watch: the unseen clock starts at the broadcast (`since`, when
 * the caller knows it) or at `now`; nothing confirmed, onConfirmed not
 * fired yet.
 */
export function newTxWatch(since, now) {
  return {
    confirmedHash: null,
    confirmedHeight: null,
    confirmedCount: null,
    fired: false,
    unseenSince: Number.isFinite(since) ? since : now,
    droppedAt: null,
  };
}

/** Is the last confirmed answer's block final at `tip`? The same rule as the hook's `final`. */
function lastAnswerFinal(watch, tip) {
  const n = bestConfirmations(watch.confirmedCount, watch.confirmedHeight, tip);
  return n !== null && n >= FINAL_DEPTH;
}

/**
 * Fold one /tx-status answer `s` into `watch` → `{ watch, set, confirmed,
 * reorg, next }`: the next watch, the fields to merge into the hook's
 * state, whether onConfirmed fires now (the watch's first confirmation,
 * and the first one after the tx went back to the mempool), the chain
 * reorganization to report (null | "block" | "mempool"), and the delay
 * before the next check (0 = stop: final, or unseen for UNSEEN_WATCH_MS).
 */
export function txWatchStep(watch, s, { now, tip = null, trustUnseen = true, intervalMs = DEFAULT_POLL_MS, graceMs = DROP_GRACE_MS } = {}) {
  const w = { ...watch };
  const quiet = (set, next) => ({ watch: w, set: { ...set, pollError: null, lastChecked: now }, confirmed: false, reorg: null, next });
  if (s.confirmed && s.block_hash) {
    const moved = w.confirmedHash !== null && w.confirmedHash !== s.block_hash;
    const confirmed = !w.fired;
    Object.assign(w, {
      confirmedHash: s.block_hash,
      confirmedHeight: Number.isInteger(s.block_height) ? s.block_height : null,
      confirmedCount: Number.isInteger(s.confirmations) ? s.confirmations : null,
      fired: true,
      droppedAt: null,
    });
    const n = bestConfirmations(s.confirmations, s.block_height, tip);
    const final = s.final === true || (n !== null && n >= FINAL_DEPTH);
    const set = {
      confirmed: true,
      dropped: false,
      watchEnded: false,
      block_height: s.block_height,
      block_hash: s.block_hash,
      block_time: s.block_time,
      serverConfirmations: s.confirmations,
      serverFinal: s.final === true,
      backInMempool: false,
      pollError: null,
      lastChecked: now,
    };
    if (moved) set.reorged = true;
    return { watch: w, set, confirmed, reorg: moved ? "block" : null, next: final ? 0 : CONFIRMED_POLL_MS };
  }
  if (w.confirmedHash !== null && s.seen) {
    // It had confirmed and is back in the mempool: its block was replaced
    // by a chain reorganization. It confirms again in a new block — and
    // onConfirmed fires again then.
    Object.assign(w, { confirmedHash: null, confirmedHeight: null, confirmedCount: null, fired: false, unseenSince: now });
    const set = { confirmed: false, block_height: null, block_hash: null, block_time: null, serverConfirmations: null, serverFinal: false, reorged: true, backInMempool: true, pollError: null, lastChecked: now };
    return { watch: w, set, confirmed: false, reorg: "mempool", next: intervalMs };
  }
  if (w.confirmedHash !== null) {
    // Confirmed before, unknown now (the indexer may be recovering from a
    // reorganization, or no longer holds the record): keep the last answer
    // and ask again later — until that block is final.
    return quiet({}, lastAnswerFinal(w, tip) ? 0 : CONFIRMED_POLL_MS);
  }
  if (s.seen) {
    w.unseenSince = now;
    w.droppedAt = null;
    return quiet({ dropped: false, watchEnded: false }, intervalMs);
  }
  if (!trustUnseen) {
    // The node's "unknown" means nothing right now: the clock does not run.
    w.unseenSince = now;
    return quiet({}, intervalMs);
  }
  if (now - w.unseenSince > graceMs) {
    w.droppedAt = w.droppedAt ?? now;
    const ended = now - w.droppedAt > UNSEEN_WATCH_MS;
    return quiet({ dropped: true, watchEnded: ended }, ended ? 0 : UNSEEN_POLL_MS);
  }
  return quiet({}, intervalMs);
}

/** The delay before the next check after a failed read (0 = stop: the last confirmed answer is final by now). */
export function txWatchErrorDelay(watch, { tip = null, intervalMs = DEFAULT_POLL_MS } = {}) {
  if (watch.confirmedHash !== null) return lastAnswerFinal(watch, tip) ? 0 : CONFIRMED_POLL_MS;
  return watch.droppedAt !== null ? UNSEEN_POLL_MS : intervalMs;
}

/**
 * The message a pending flow shows when the indexer's node has not seen
 * its tx for a while (see `dropped` above). Not "try again": the tx may
 * still confirm, and a second one could then confirm too.
 */
export function droppedMessage(txid, what = "transaction") {
  const short = txid ? `${String(txid).slice(0, 12)}…` : "";
  return (
    `The ${what} ${short} has not been in the indexer's node for ${Math.round(DROP_GRACE_MS / 60_000)} minutes and has not confirmed. ` +
    "It may have been replaced or dropped, or the node may simply not have it — it can still confirm, and this page keeps checking for an hour. " +
    "Look at your Portfolio before sending anything again."
  );
}
