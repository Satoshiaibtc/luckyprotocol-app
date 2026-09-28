import { useEffect, useRef, useState } from "react";
import * as indexer from "../lib/indexer.js";
import { DROP_GRACE_MS } from "../lib/txrecords.js";
import { friendlyError } from "./useWallet.js";

const DEFAULT_POLL_MS = 15_000;
const EMPTY = { confirmed: false, dropped: false, block_height: null, block_hash: null, block_time: null, pollError: null, lastChecked: null };

/**
 * Poll `/tx-status/:txid` until it confirms. Returns
 * `{ confirmed, dropped, block_height, block_hash, block_time, pollError, lastChecked }`.
 * `onConfirmed(status)` fires exactly once per txid.
 *
 * `dropped` (audit usertx-2 / usertx-6): the indexer's node has reported the
 * tx unknown (`seen:false` — not in its mempool, not confirmed) for longer
 * than DROP_GRACE_MS since tracking started — it was evicted or replaced
 * (e.g. by a later transaction of the user's own that re-spent an input).
 * Polling stops; the flow shows it instead of "pending" forever. A tx that
 * is seen again before the grace ends resets the clock.
 */
export function useTxStatus(txid, { intervalMs = DEFAULT_POLL_MS, onConfirmed, since = null } = {}) {
  const [state, setState] = useState(EMPTY);
  const cbRef = useRef(onConfirmed);
  cbRef.current = onConfirmed;
  const firedFor = useRef(null);
  const sinceRef = useRef(since);
  sinceRef.current = since;

  useEffect(() => {
    setState(EMPTY);
    if (!txid) return undefined;
    let alive = true;
    let id = null;
    // The unseen clock starts at the broadcast (when the caller knows it) or now.
    let unseenSince = Number.isFinite(sinceRef.current) ? sinceRef.current : Date.now();
    const check = async () => {
      try {
        const s = await indexer.txStatus(txid);
        if (!alive) return;
        if (s.confirmed && s.block_hash) {
          setState({ confirmed: true, dropped: false, block_height: s.block_height, block_hash: s.block_hash, block_time: s.block_time, pollError: null, lastChecked: Date.now() });
          if (id) clearInterval(id);
          if (firedFor.current !== txid) {
            firedFor.current = txid;
            cbRef.current?.(s);
          }
        } else if (!s.seen && Date.now() - unseenSince > DROP_GRACE_MS) {
          setState((st) => ({ ...st, dropped: true, pollError: null, lastChecked: Date.now() }));
          if (id) clearInterval(id);
        } else {
          if (s.seen) unseenSince = Date.now();
          setState((st) => ({ ...st, pollError: null, lastChecked: Date.now() }));
        }
      } catch (e) {
        if (alive) setState((st) => ({ ...st, pollError: friendlyError(e), lastChecked: Date.now() }));
      }
    };
    check();
    id = setInterval(check, intervalMs);
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
  }, [txid, intervalMs]);

  return state;
}

/** The message a pending flow shows when its tx was dropped (see `dropped` above). */
export function droppedMessage(txid, what = "transaction") {
  const short = txid ? `${String(txid).slice(0, 12)}…` : "";
  return (
    `The ${what} ${short} has not been in the indexer's node mempool for a few minutes and never confirmed — it was dropped or replaced. ` +
    "You can try again: a new transaction may spend the same inputs, so at most one of the two can confirm."
  );
}
