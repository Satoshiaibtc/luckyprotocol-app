import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * The stop handle of a flow's wait for the indexer's scan of a wallet
 * (src/lib/retry.js — up to SEED_WAIT_BUDGET_MS on a first use):
 *
 *   const seedWait = useSeedWait()
 *   const signal = seedWait.begin()   // before the build's UTXO reads
 *   …reads with `signal`…
 *   seedWait.done(signal)             // once they are in: later steps (the
 *                                     // wallet prompt, the broadcast) are
 *                                     // never stopped by it
 *   seedWait.stop()                   // the flow's "Stop waiting" button
 *
 * A stopped read throws an AbortError and `signal.aborted` is true — the
 * flow then goes back to idle without an error. The wait is also stopped
 * on unmount, so a page the user left stops asking the indexer.
 */
export function useSeedWait() {
  const ref = useRef(null);
  useEffect(() => () => ref.current?.abort(), []);
  const begin = useCallback(() => {
    ref.current?.abort();
    const ctrl = new AbortController();
    ref.current = ctrl;
    return ctrl.signal;
  }, []);
  const done = useCallback((signal) => {
    if (ref.current && ref.current.signal === signal) ref.current = null;
  }, []);
  const stop = useCallback(() => ref.current?.abort(), []);
  return useMemo(() => ({ begin, done, stop }), [begin, done, stop]);
}
