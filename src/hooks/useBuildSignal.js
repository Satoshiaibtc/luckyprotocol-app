import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * The stop handle of a flow's reads before the wallet opens (its UTXO list,
 * its token outputs):
 *
 *   const reads = useBuildSignal()
 *   const signal = reads.begin()   // before the build's reads
 *   …reads with `signal`…
 *   reads.done(signal)             // once they are in: later steps (the
 *                                  // wallet prompt, the broadcast) are
 *                                  // never stopped by it
 *   reads.stop()                   // a wallet change: the build ends
 *
 * A stopped read throws an AbortError and `signal.aborted` is true — the
 * flow then goes back to idle without an error, and never opens the
 * wallet for an address that is no longer connected. The reads are also
 * stopped on unmount.
 */
export function useBuildSignal() {
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
