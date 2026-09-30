import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as indexer from "../lib/indexer.js";
import { startPolling } from "../lib/poller.js";
import { CLICK_CHECK_TIMEOUT_MS, PENDING_DEPLOYS_POLL_MS } from "../lib/rivalDeploys.js";

const TICKER_RE = /^[A-Z0-9]{1,8}$/;
const IDLE = { ticker: null, answer: undefined, at: null };

/**
 * The DEPLOYs of `ticker` waiting in the node's mempool (GET
 * /pending-deploys/:ticker), read while `enabled`: first after `delayMs`,
 * then every PENDING_DEPLOYS_POLL_MS (a tick while the tab is hidden, or
 * while the previous read is still out, is skipped — src/lib/poller.js).
 *
 *   p.ticker     the ticker the answer is about (compare it with the field)
 *   p.answer     undefined before the first read, null when the last read
 *                failed, else indexer.pendingDeploys's result
 *                (src/lib/rivalDeploys.js readPendingDeploys reads it)
 *   p.checkNow(t = ticker)
 *                a fresh read that bypasses every cache and gives up after
 *                CLICK_CHECK_TIMEOUT_MS → the answer, or null when it failed;
 *                it becomes `p.answer` too
 *
 * An answer is shown only when no read started after it has been shown
 * already, and a fresh read outranks every read still out when it lands.
 */
export function usePendingDeploys(ticker, { enabled = true, delayMs = 0, pollMs = PENDING_DEPLOYS_POLL_MS } = {}) {
  const [state, setState] = useState(IDLE);
  const started = useRef(0);
  const shown = useRef(0);

  const read = useCallback(async (t, { fresh = false, signal } = {}) => {
    const n = ++started.current;
    let answer = null;
    try {
      answer = await indexer.pendingDeploys(t, signal, { fresh });
    } catch {
      answer = null;
    }
    if (signal?.aborted && !fresh) return null;
    const newest = fresh ? started.current : n;
    if (n > shown.current || fresh) {
      shown.current = Math.max(shown.current, newest);
      setState({ ticker: t, answer, at: Date.now() });
    }
    return answer;
  }, []);

  const on = !!enabled && TICKER_RE.test(ticker || "");
  useEffect(() => {
    if (!on) {
      setState(IDLE);
      return undefined;
    }
    const ctrl = new AbortController();
    let stop = null;
    const first = setTimeout(() => {
      stop = startPolling(() => read(ticker, { signal: ctrl.signal }), pollMs);
    }, Math.max(0, delayMs));
    return () => {
      clearTimeout(first);
      ctrl.abort();
      if (stop) stop();
    };
  }, [on, ticker, delayMs, pollMs, read]);

  const checkNow = useCallback(
    async (t = ticker) => {
      if (!TICKER_RE.test(t || "")) return null;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CLICK_CHECK_TIMEOUT_MS);
      try {
        return await read(t, { fresh: true, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    },
    [read, ticker],
  );

  return useMemo(() => ({ ticker: state.ticker, answer: state.answer, at: state.at, checkNow }), [state, checkNow]);
}
