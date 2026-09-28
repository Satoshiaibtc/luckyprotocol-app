import { useCallback, useEffect, useRef, useState } from "react";
import { startPolling } from "../lib/poller.js";

/**
 * Poll an async function on an interval.
 *
 *   const q = usePoll(fn | null, intervalMs, deps, { paused })
 *   q.data / q.error / q.loading / q.updatedAt / q.refresh()
 *
 * `fn` receives an AbortSignal that fires on unmount / deps change. Passing
 * `null` disables polling and clears state. `intervalMs <= 0` runs once
 * per deps change. A tick while the previous call is still in flight is
 * skipped (a slow answer is never joined by a second request). Polling
 * pauses while the tab is hidden and catches up with one call when it is
 * visible again (src/lib/poller.js). `paused` stops polling but keeps the
 * last answer; un-pausing reads again at once.
 */
export function usePoll(fn, intervalMs, deps = [], { paused = false } = {}) {
  const [state, setState] = useState({
    data: null,
    error: null,
    loading: !!fn,
    updatedAt: null,
  });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const f = fnRef.current;
    if (!f) {
      setState({ data: null, error: null, loading: false, updatedAt: null });
      return undefined;
    }
    if (paused) return undefined;
    let alive = true;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: s.data === null }));

    const run = async () => {
      try {
        const data = await f(ctrl.signal);
        if (alive) setState({ data, error: null, loading: false, updatedAt: Date.now() });
      } catch (e) {
        if (alive && !ctrl.signal.aborted) {
          setState((s) => ({ ...s, error: e, loading: false, updatedAt: Date.now() }));
        }
      }
    };

    const stop = startPolling(run, intervalMs);
    return () => {
      alive = false;
      ctrl.abort();
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are caller-declared
  }, [intervalMs, tick, paused, ...deps]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refresh };
}
