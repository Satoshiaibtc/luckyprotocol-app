import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Poll an async function on an interval.
 *
 *   const q = usePoll(fn | null, intervalMs, deps)
 *   q.data / q.error / q.loading / q.updatedAt / q.refresh()
 *
 * `fn` receives an AbortSignal that fires on unmount / deps change. Passing
 * `null` disables polling and clears state. `intervalMs <= 0` runs once
 * per deps change. Polling pauses while the tab is hidden and resumes
 * (with an immediate refresh) when it becomes visible again.
 */
export function usePoll(fn, intervalMs, deps = []) {
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
    let alive = true;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: s.data === null }));

    const run = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const data = await f(ctrl.signal);
        if (alive) setState({ data, error: null, loading: false, updatedAt: Date.now() });
      } catch (e) {
        if (alive && !ctrl.signal.aborted) {
          setState((s) => ({ ...s, error: e, loading: false, updatedAt: Date.now() }));
        }
      }
    };

    run();
    const id = intervalMs > 0 ? setInterval(run, intervalMs) : null;
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      ctrl.abort();
      if (id) clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are caller-declared
  }, [intervalMs, tick, ...deps]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refresh };
}
