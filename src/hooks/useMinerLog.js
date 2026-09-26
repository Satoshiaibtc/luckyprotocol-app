import { useCallback, useSyncExternalStore } from "react";
import { appendLine } from "../lib/minerlog.js";

// One buffer per ticker, module-level so the log survives leaving and
// re-entering the token page within the session (no localStorage — a
// terminal log is session state, not a record).
const stores = new Map();
const EMPTY = Object.freeze([]);

function storeFor(ticker) {
  let s = stores.get(ticker);
  if (!s) {
    // `meta` is per-ticker mutable bookkeeping that must outlive a page
    // mount (the last wallet observed, the last fee-quote log time), so a
    // return to the page neither repeats nor misses the transition lines.
    s = { lines: EMPTY, listeners: new Set(), meta: { lastWallet: undefined, lastFeeLogAt: 0 } };
    stores.set(ticker, s);
  }
  return s;
}

function notify(s) {
  for (const fn of s.listeners) fn();
}

/**
 * `useMinerLog(ticker)` → { lines, push(line, { replace | move }), clear(), meta }.
 * `push` ignores null and duplicate keys (see appendLine) and is safe to
 * call from effects and event handlers — never from render.
 */
export function useMinerLog(ticker) {
  const subscribe = useCallback(
    (fn) => {
      const s = storeFor(ticker);
      s.listeners.add(fn);
      return () => s.listeners.delete(fn);
    },
    [ticker],
  );
  const getSnapshot = useCallback(() => storeFor(ticker).lines, [ticker]);
  const lines = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const push = useCallback(
    (line, opts) => {
      const s = storeFor(ticker);
      const next = appendLine(s.lines, line, opts);
      if (next !== s.lines) {
        s.lines = next;
        notify(s);
      }
    },
    [ticker],
  );

  const clear = useCallback(() => {
    const s = storeFor(ticker);
    if (s.lines.length === 0) return;
    s.lines = EMPTY;
    notify(s);
  }, [ticker]);

  return { lines, push, clear, meta: storeFor(ticker).meta };
}

/**
 * The create page's DEPLOY // LOG buffer. Namespaced under "deploy:" so it
 * can never share a store with a token page's mine log (tickers are
 * [A-Z0-9]{1,8}, so the prefix cannot collide). One buffer for the page —
 * the ticker is a text field there, and a buffer per keystroke would
 * restart the log (and repeat the wallet / fee / tip lines) on every
 * character typed; the deploy lines name their ticker instead.
 */
export function useDeployLog(scope = "page") {
  return useMinerLog(`deploy:${scope}`);
}
