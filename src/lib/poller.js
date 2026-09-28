// The schedule of one periodic read, without React — shared by usePoll,
// usePaged and the block tape (src/hooks/), unit-tested in plain Node
// (test/poll.test.js).
//
// Two rules keep a busy indexer from being asked twice for the same thing:
//   * a tick while the previous call of the same poll is still in flight
//     is skipped — a slow answer is never joined by a second request;
//   * a hidden tab asks for nothing: a tick while hidden is skipped and
//     remembered, and the poll catches up with ONE call when the tab is
//     visible again (only when a tick was actually missed).

/** True while the page is hidden (never outside a browser). */
export function pageHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * `createPoller(run, { hidden })` → `{ tick, visible, busy }`:
 *
 *   tick()     call `run()` now, unless the page is hidden (the tick is
 *              then remembered as missed) or the previous call is still
 *              in flight (skipped); resolves true when it ran
 *   visible()  the page became visible: run the missed tick, if any
 *   busy()     a call is in flight
 *
 * `run` may return a promise; the call counts as in flight until it
 * settles. Its errors are the caller's to report — they are swallowed
 * here only so a tick never rejects.
 */
export function createPoller(run, { hidden = pageHidden } = {}) {
  let inFlight = false;
  let missed = false;
  const tick = async () => {
    if (hidden()) {
      missed = true;
      return false;
    }
    if (inFlight) return false;
    inFlight = true;
    missed = false;
    try {
      await run();
    } catch {
      /* reported by `run` itself */
    } finally {
      inFlight = false;
    }
    return true;
  };
  const visible = () => (missed && !hidden() ? tick() : Promise.resolve(false));
  return { tick, visible, busy: () => inFlight };
}

/**
 * Run `run` every `intervalMs` (and once now, unless `immediate` is false)
 * under createPoller's rules, catching up on the page's return from the
 * background → a stop function. `intervalMs <= 0` runs once (or once the
 * page is visible).
 */
export function startPolling(run, intervalMs, { immediate = true, hidden = pageHidden, doc = typeof document !== "undefined" ? document : null } = {}) {
  const poller = createPoller(run, { hidden });
  if (immediate) poller.tick();
  const id = intervalMs > 0 ? setInterval(poller.tick, intervalMs) : null;
  const onVisibility = () => {
    poller.visible();
  };
  if (doc) doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    if (id) clearInterval(id);
    if (doc) doc.removeEventListener("visibilitychange", onVisibility);
  };
}
