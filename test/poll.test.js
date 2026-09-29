// The schedule of periodic reads (src/lib/poller.js), shared by usePoll,
// usePaged and the block tape: a tick while the previous call of the same
// poll is in flight is skipped (never stacked), a hidden tab asks for
// nothing, and the poll catches up with one call when the tab returns —
// only when a tick was missed. And the indexer transport's timeout covers
// the body, not only the headers: a stalled body ends the call, so the poll
// that waits on it is not frozen. Plain Node, no framework.
import assert from "node:assert/strict";
import { createPoller, pageHidden, startPolling } from "../src/lib/poller.js";
import * as indexer from "../src/lib/indexer.js";
import { isAbortError } from "../src/lib/abort.js";
import { syncStateOf } from "../src/lib/sync.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- in flight: a slow answer is never joined by a second request -------------------------------------
{
  let calls = 0;
  let release;
  const p = createPoller(
    () => {
      calls += 1;
      return new Promise((r) => {
        release = r;
      });
    },
    { hidden: () => false },
  );
  const first = p.tick();
  assert.equal(p.busy(), true);
  assert.equal(await p.tick(), false, "skipped while the first call is in flight");
  assert.equal(await p.tick(), false);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
  assert.equal(p.busy(), false);
  const second = p.tick();
  release();
  assert.equal(await second, true, "the next tick after the answer runs");
  assert.equal(calls, 2);
  console.log("poll: a tick while the last call is in flight is skipped");
}

// ---- a failing call clears the in-flight flag and never rejects the tick ------------------------------
{
  let calls = 0;
  const p = createPoller(
    async () => {
      calls += 1;
      throw new Error("HTTP 503");
    },
    { hidden: () => false },
  );
  assert.equal(await p.tick(), true);
  assert.equal(await p.tick(), true);
  assert.equal(calls, 2);
  assert.equal(p.busy(), false);
}

// ---- hidden: nothing is asked; one catch-up call on return, only when a tick was missed ---------------
{
  let hidden = true;
  let calls = 0;
  const p = createPoller(
    async () => {
      calls += 1;
    },
    { hidden: () => hidden },
  );
  assert.equal(await p.tick(), false);
  assert.equal(await p.tick(), false);
  assert.equal(calls, 0, "a hidden tab asks for nothing");
  assert.equal(await p.visible(), false, "still hidden: no catch-up yet");
  hidden = false;
  assert.equal(await p.visible(), true, "back: one catch-up call");
  assert.equal(calls, 1);
  assert.equal(await p.visible(), false, "no second catch-up for the same miss");
  assert.equal(calls, 1);
  // Hidden and back again with no tick in between: nothing to catch up.
  hidden = true;
  hidden = false;
  assert.equal(await p.visible(), false);
  assert.equal(calls, 1);
  console.log("poll: hidden tabs pause, one catch-up on return and only after a missed tick");
}

// ---- startPolling: interval, immediate, visibility listener, stop -----------------------------------
{
  const listeners = new Set();
  const doc = {
    addEventListener: (type, fn) => type === "visibilitychange" && listeners.add(fn),
    removeEventListener: (type, fn) => type === "visibilitychange" && listeners.delete(fn),
  };
  // A slow read on a fast interval: never two at once.
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const stop = startPolling(
    async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(35);
      inFlight -= 1;
    },
    10,
    { hidden: () => false, doc },
  );
  assert.equal(calls, 1, "runs once at once");
  assert.equal(listeners.size, 1);
  await sleep(120);
  stop();
  assert.equal(maxInFlight, 1, "ticks never stacked");
  assert.ok(calls >= 2 && calls <= 4, `${calls} calls in 120 ms of 35 ms reads`);
  assert.equal(listeners.size, 0, "stop removes the visibility listener");
  const after = calls;
  await sleep(40);
  assert.equal(calls, after, "stop ends the interval");

  // immediate: false — the first call waits for the interval (the block tape's refresh).
  let n = 0;
  const stop2 = startPolling(
    () => {
      n += 1;
    },
    15,
    { immediate: false, hidden: () => false, doc },
  );
  assert.equal(n, 0);
  await sleep(40);
  stop2();
  assert.ok(n >= 1);

  // intervalMs <= 0: once, and once more only as a catch-up of a hidden start.
  let hidden = true;
  let m = 0;
  const stop3 = startPolling(
    () => {
      m += 1;
    },
    0,
    { hidden: () => hidden, doc },
  );
  assert.equal(m, 0, "hidden at start: nothing yet");
  hidden = false;
  for (const fn of listeners) fn();
  await sleep(0);
  assert.equal(m, 1, "the missed first read runs when the tab is visible");
  for (const fn of listeners) fn();
  await sleep(0);
  assert.equal(m, 1);
  stop3();
  console.log("poll: startPolling runs, never stacks, catches up once and stops cleanly");
}

// ---- a body that stalls after its headers ends in the transport's timeout ------------------------------
// The headers arrive, the body never does (a network change mid-answer):
// the 30 s timeout still ends the read, so a poll that skips ticks while a
// call is in flight gets its next tick. The caller's own abort still ends
// it as an AbortError.
{
  const realFetch = globalThis.fetch;
  let bodyAsked = 0;
  // A body that never finishes on its own: it errors only when the request's signal aborts (as fetch does).
  const stalled = (signal) =>
    new Promise((_, reject) => {
      bodyAsked += 1;
      const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  let status = 200;
  globalThis.fetch = async (url, opts) => ({
    ok: status === 200,
    status,
    headers: { get: () => null },
    json: () => stalled(opts.signal),
    text: () => stalled(opts.signal),
  });
  const settled = () => new Promise((r) => setImmediate(r));
  // A hand-driven clock for the transport's timer (setImmediate stays real).
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let now = 0;
  let nextId = 1;
  globalThis.setTimeout = (fn, ms) => {
    timers.set(nextId, { fn, at: now + ms });
    return nextId++;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const advance = (ms) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at > now) continue;
      timers.delete(id);
      t.fn();
    }
  };
  try {
    const p = createPoller(() => indexer.health(), { hidden: () => false });
    let failure = null;
    const first = indexer.health().catch((e) => {
      failure = e;
    });
    const polled = p.tick();
    await settled();
    assert.equal(bodyAsked, 2, "headers in, both bodies being read");
    assert.equal(p.busy(), true);
    assert.equal(await p.tick(), false, "the stalled call is still in flight");
    advance(29_999);
    await settled();
    assert.equal(failure, null, "not before the timeout");
    advance(1);
    await first;
    assert.match(String(failure?.message), /^Indexer timeout after 30000ms: /);
    assert.equal(await polled, true);
    assert.equal(p.busy(), false, "the timeout ends the call: the poll is not frozen");

    // An error status whose body stalls: the status error, once the timeout ends the read.
    status = 503;
    const errored = indexer.health().catch((e) => e);
    await settled();
    advance(30_000);
    const e503 = await errored;
    assert.equal(e503.status, 503);
    assert.match(e503.message, /HTTP 503$/);
    status = 200;

    // The caller's abort during the body read: an AbortError, not the timeout sentence.
    const ctrl = new AbortController();
    const aborted = indexer.health(ctrl.signal).catch((e) => e);
    await settled();
    ctrl.abort();
    const ea = await aborted;
    assert.equal(isAbortError(ea), true, String(ea));
    assert.equal(timers.size, 0, "every call cleared its timer");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.fetch = realFetch;
  }
  console.log("poll: a body that stalls after its headers ends in the timeout; the poll is not frozen");
}

// ---- the rebuild flag is read fail-closed ----------------------------------------------------------------
// Only an answer with `state_rebuilding: false` unpauses writes: an indexer
// that does not send the flag (one that predates it, or one not on these
// rules) reads as rebuilding, and nothing that depends on its state is
// offered.
{
  const realFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  try {
    const at = { indexed_height: 1, tip_height: 1 };
    body = { ...at, rebuilding: false };
    const without = await indexer.health();
    assert.equal(without.rebuilding, true, "no state_rebuilding: rebuilding");
    assert.equal(syncStateOf(without).synced, false, "…and not synced, so writes pause");
    body = { ...at, rebuilding: true, state_rebuilding: false };
    const ready = await indexer.health();
    assert.equal(ready.rebuilding, false, "state_rebuilding false: not rebuilding");
    assert.equal(syncStateOf(ready).synced, true);
    body = { ...at, rebuilding: true, state_rebuilding: true };
    assert.equal((await indexer.health()).rebuilding, true, "state_rebuilding true: rebuilding");
    body = { ...at, state_rebuilding: "false" };
    assert.equal((await indexer.health()).rebuilding, true, "a flag that is not a boolean false counts as rebuilding");
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log("poll: /health without state_rebuilding reads as rebuilding (writes pause)");
}

assert.equal(pageHidden(), false, "no document outside a browser: never hidden");
console.log("poll: all checks passed");
