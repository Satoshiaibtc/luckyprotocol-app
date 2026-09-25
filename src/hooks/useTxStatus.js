import { useEffect, useRef, useState } from "react";
import * as indexer from "../lib/indexer.js";
import { friendlyError } from "./useWallet.js";

const DEFAULT_POLL_MS = 15_000;

/**
 * Poll `/tx-status/:txid` until it confirms. Returns
 * `{ confirmed, block_height, block_hash, block_time, pollError, lastChecked }`.
 * `onConfirmed(status)` fires exactly once per txid.
 */
export function useTxStatus(txid, { intervalMs = DEFAULT_POLL_MS, onConfirmed } = {}) {
  const [state, setState] = useState({ confirmed: false, block_height: null, block_hash: null, block_time: null, pollError: null, lastChecked: null });
  const cbRef = useRef(onConfirmed);
  cbRef.current = onConfirmed;
  const firedFor = useRef(null);

  useEffect(() => {
    setState({ confirmed: false, block_height: null, block_hash: null, block_time: null, pollError: null, lastChecked: null });
    if (!txid) return undefined;
    let alive = true;
    let id = null;
    const check = async () => {
      try {
        const s = await indexer.txStatus(txid);
        if (!alive) return;
        if (s.confirmed && s.block_hash) {
          setState({ confirmed: true, block_height: s.block_height, block_hash: s.block_hash, block_time: s.block_time, pollError: null, lastChecked: Date.now() });
          if (id) clearInterval(id);
          if (firedFor.current !== txid) {
            firedFor.current = txid;
            cbRef.current?.(s);
          }
        } else {
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
