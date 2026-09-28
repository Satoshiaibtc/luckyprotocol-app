// Retry helper for the first read of a wallet's BTC UTXOs: the indexer
// builds that list with a scan of the whole UTXO set, which takes a few
// minutes, and while the scan is waiting or running — or while it is busy
// with other scans — it answers "not yet, ask again in N seconds". That
// never means "no", so the caller waits and retries within a time budget
// instead of failing after a few seconds. The wait can be stopped (an
// AbortSignal), and the one "busy" answer that waiting cannot fix — this
// network started too many new scans lately — ends it at once with a
// plain sentence. Pure, no React, unit-tested in plain Node
// (test/wallet.test.js, test/flows.test.js).

/** True for the indexer's "scan waiting / running" answer on the first read of an address. */
export function isSeedingError(e) {
  return !!e && (e.status === 503 || /HTTP 503/.test(String(e.message || "")));
}

/** True for the indexer's "busy with other scans" answer. */
export function isSeedBusyError(e) {
  return !!e && (e.status === 429 || /HTTP 429/.test(String(e.message || "")));
}

/**
 * True for the "busy" answer that says this network (one public IP)
 * started too many new scans lately: the limit lasts minutes, so the page
 * does not wait it out — it says when to try again.
 */
export function isSeedLimitError(e) {
  return isSeedBusyError(e) && e.reason === "client_limit";
}

/** True for a stopped wait (the flow's Stop waiting, or the page left). */
export function isAbortError(e) {
  return !!e && e.name === "AbortError";
}

/** The error a stopped wait ends with. */
export function seedWaitStopped() {
  return Object.assign(new Error("Stopped waiting for the indexer's scan of this wallet."), { name: "AbortError" });
}

/** Default wait between retries when the server names none, and the clamp for the ones it names. */
export const RETRY_MIN_DELAY_MS = 2_000;
export const RETRY_MAX_DELAY_MS = 60_000;
/** How long a flow keeps waiting for a first-time scan before it gives up. */
export const SEED_WAIT_BUDGET_MS = 600_000;

/**
 * The wait before the next try: the error's `retryAfter` (seconds, from
 * the Retry-After header) clamped to [min, max], else `min`.
 */
export function retryDelayMs(e, { minDelayMs = RETRY_MIN_DELAY_MS, maxDelayMs = RETRY_MAX_DELAY_MS } = {}) {
  const s = Number(e && e.retryAfter);
  if (!Number.isFinite(s) || s <= 0) return minDelayMs;
  return Math.min(maxDelayMs, Math.max(minDelayMs, Math.round(s * 1000)));
}

/** `ms`, cut short when `signal` aborts. */
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run `fn` and retry it while it fails with a seeding 503 or a busy 429,
 * waiting what the server's Retry-After asks (clamped), until `attempts`
 * calls were made OR `budgetMs` has elapsed; any other error — and the
 * per-network limit (isSeedLimitError) — is thrown at once. `signal`
 * stops the wait: the pending sleep ends and seedWaitStopped() is thrown.
 * `onRetry(attemptNumber, { waitMs, busy, elapsedMs, queuePosition,
 * etaSecs, reason })` fires before each wait so a flow can say what it is
 * waiting for (the last three from the indexer's answer, null when it
 * named none).
 */
export async function retryOn503(
  fn,
  { attempts = 3, budgetMs = Infinity, minDelayMs = RETRY_MIN_DELAY_MS, maxDelayMs = RETRY_MAX_DELAY_MS, delayMs, onRetry, sleep, now, signal } = {},
) {
  const wait = sleep || sleepUnlessAborted;
  const clock = now || (() => Date.now());
  const started = clock();
  // `delayMs` (older callers / tests): a fixed wait, whatever the server says.
  const lo = delayMs ?? minDelayMs;
  const hi = delayMs ?? maxDelayMs;
  let last;
  for (let i = 1; i <= attempts; i++) {
    if (signal && signal.aborted) throw seedWaitStopped();
    try {
      return await fn(i);
    } catch (e) {
      if (signal && signal.aborted) throw seedWaitStopped();
      const retryable = (isSeedingError(e) || isSeedBusyError(e)) && !isSeedLimitError(e);
      if (!retryable || i === attempts) throw e;
      last = e;
      const waitMs = retryDelayMs(e, { minDelayMs: lo, maxDelayMs: hi });
      const elapsedMs = clock() - started;
      if (elapsedMs + waitMs > budgetMs) throw e;
      if (onRetry) {
        onRetry(i, {
          waitMs,
          busy: isSeedBusyError(e),
          elapsedMs,
          queuePosition: e.queuePosition ?? null,
          etaSecs: e.etaSecs ?? null,
          reason: e.reason ?? null,
        });
      }
      await wait(waitMs, signal);
      if (signal && signal.aborted) throw seedWaitStopped();
    }
  }
  throw last;
}

/**
 * The wallet flows' wait for a first-time UTXO scan: up to
 * SEED_WAIT_BUDGET_MS, honouring Retry-After. Same contract as retryOn503.
 */
export function retryWhileSeeding(fn, opts = {}) {
  return retryOn503(fn, { attempts: 1_000, budgetMs: SEED_WAIT_BUDGET_MS, ...opts });
}

// ---- what the flows say while they wait -------------------------------------------------------

/** Whole minutes for `secs` seconds, at least 1. */
function minutesOf(secs) {
  return Math.max(1, Math.ceil(secs / 60));
}

/** "42 s" under a minute, "3 min 05 s" above. */
export function fmtWaited(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/**
 * The line a flow shows while the indexer scans this wallet (fed by
 * retryOn503's onRetry info, plus `rescan` from wallet.getBitcoinUtxos:
 * this browser has read the address before, so the scan follows a chain
 * reorganization or an indexer restart, not a first use). The queue
 * position and the estimate are the indexer's own, when it gives them;
 * an estimate past what is left of SEED_WAIT_BUDGET_MS says so, since the
 * flow stops waiting before the scan is due to finish.
 */
export function seedWaitNote({ elapsedMs = 0, busy = false, rescan = false, queuePosition = null, etaSecs = null, reason = null } = {}) {
  const waited = `waiting ${fmtWaited(elapsedMs)}`;
  if (busy && reason === "queue_full") return `The indexer's scan queue is full right now — this wallet is set up as soon as there is room (${waited}).`;
  if (busy) return `The indexer is busy right now — asking again shortly (${waited}).`;
  const head = rescan ? "Setting up this wallet again (after a chain reorganization or an indexer restart)" : "Setting up this wallet";
  const pos = Number.isInteger(queuePosition) && queuePosition >= 0 ? queuePosition : null;
  const step = pos !== null && pos > 0 ? `queued to scan the Bitcoin UTXO set, ${pos} address${pos === 1 ? "" : "es"} ahead` : "scanning the Bitcoin UTXO set";
  const known = Number.isFinite(etaSecs) && etaSecs >= 0;
  const eta = known ? `about ${minutesOf(etaSecs)} min` : "usually a few minutes";
  const pastBudget = known && etaSecs * 1000 > SEED_WAIT_BUDGET_MS - elapsedMs;
  const tail = pastBudget ? ` This page waits up to ${Math.round(SEED_WAIT_BUDGET_MS / 60_000)} min; the scan keeps running after that.` : "";
  return `${head}: ${step}, ${eta} (${waited}).${tail}`;
}

/**
 * The sentence for a wait that ended without the wallet's UTXOs: this
 * network's new-scan limit (with the indexer's Retry-After in minutes),
 * the scan queue that stayed full, or the scan still running when the
 * budget ran out (with the indexer's last estimate, when it gave one).
 * Null for any other error.
 */
export function seedFailureText(e) {
  if (isSeedLimitError(e)) {
    const s = Number(e.retryAfter);
    const when = Number.isFinite(s) && s > 0 ? `in ${minutesOf(s)} min` : "in a few minutes";
    return `Too many new wallets from your network are being set up right now — try again ${when}.`;
  }
  const budget = `${Math.round(SEED_WAIT_BUDGET_MS / 60_000)} min`;
  if (isSeedBusyError(e) && e.reason === "queue_full") return `The indexer's scan queue stayed full for ${budget} — try again in a few minutes.`;
  if (isSeedBusyError(e)) return `The indexer stayed busy for ${budget} — try again in a few minutes.`;
  if (isSeedingError(e)) {
    const eta = Number(e.etaSecs);
    const when = e.etaSecs != null && Number.isFinite(eta) && eta >= 0 ? `in about ${minutesOf(eta)} min` : "in a few minutes";
    return `This wallet is still being set up — the indexer's scan of the Bitcoin UTXO set did not finish within ${budget}. It keeps running; try again ${when}.`;
  }
  return null;
}
