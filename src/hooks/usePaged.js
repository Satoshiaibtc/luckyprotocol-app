import { useCallback, useEffect, useRef, useState } from "react";
import { startPolling } from "../lib/poller.js";

/**
 * Offset-paginated list with "load more" + periodic refresh of what is loaded.
 *
 *   const q = usePaged((offset, limit, signal) => indexer.trades({ ticker, offset, limit }, signal), { limit, deps, refreshMs })
 *   q.rows / q.total / q.loading / q.error / q.hasMore / q.loadMore() / q.refresh()
 *
 * `fetchPage` must resolve to `{ items, total }`. Passing `null` disables.
 * `refreshMs <= 0` loads once per deps change / refresh().
 */
export function usePaged(fetchPage, { limit = 25, deps = [], refreshMs = 0 } = {}) {
  const [state, setState] = useState({ rows: [], total: 0, loading: !!fetchPage, error: null });
  const fnRef = useRef(fetchPage);
  fnRef.current = fetchPage;
  const rowsRef = useRef([]);
  rowsRef.current = state.rows;
  const ctrlRef = useRef(null);
  const [tick, setTick] = useState(0);

  const run = useCallback(async ({ offset, count, append }) => {
    const f = fnRef.current;
    if (!f) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setState((s) => ({ ...s, loading: true }));
    try {
      const page = await f(offset, count, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const items = page?.items || [];
      setState((s) => ({
        rows: append ? [...s.rows, ...items] : items,
        total: Number.isFinite(page?.total) ? page.total : items.length,
        loading: false,
        error: null,
      }));
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setState((s) => ({ ...s, loading: false, error: e }));
    }
  }, []);

  // (Re)load the first page on deps change / manual refresh; refresh keeps
  // everything already loaded by refetching the same span. The periodic
  // refresh follows src/lib/poller.js: skipped while the previous one is
  // in flight, paused while the tab is hidden, caught up on its return.
  useEffect(() => {
    if (!fnRef.current) {
      setState({ rows: [], total: 0, loading: false, error: null });
      return undefined;
    }
    let first = true;
    const load = () => {
      const count = first && tick === 0 ? limit : Math.max(limit, rowsRef.current.length);
      first = false;
      return run({ offset: 0, count, append: false });
    };
    const stop = startPolling(load, refreshMs);
    return () => {
      stop();
      ctrlRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are caller-declared
  }, [tick, limit, refreshMs, ...deps]);

  const loadMore = useCallback(() => {
    run({ offset: rowsRef.current.length, count: limit, append: true });
  }, [run, limit]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { ...state, hasMore: state.rows.length < state.total, loadMore, refresh };
}
