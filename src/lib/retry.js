// Retry helper for the first read of a wallet's BTC UTXOs: the indexer
// builds that list with a scan of the whole UTXO set, which takes a minute
// or two, and while the scan is waiting or running — or while it is busy
// with other scans — it answers "not yet, ask again in N seconds". That
// never means "no", so the caller waits and retries within a time budget
// instead of failing after a few seconds. Pure, no React, unit-tested in
// plain Node (test/wallet.test.js).

/** True for the indexer's "scan waiting / running" answer on the first read of an address. */
export function isSeedingError(e) {
  return !!e && (e.status === 503 || /HTTP 503/.test(String(e.message || "")));
}

/** True for the indexer's "busy with other scans" answer. */
export function isSeedBusyError(e) {
  return !!e && (e.status === 429 || /HTTP 429/.test(String(e.message || "")));
}

/** Default wait between retries when the server names none, and the clamp for the ones it names. */
export const RETRY_MIN_DELAY_MS = 2_000;
export const RETRY_MAX_DELAY_MS = 15_000;
/** How long a flow keeps waiting for a first-time scan before it gives up. */
export const SEED_WAIT_BUDGET_MS = 150_000;

/**
 * The wait before the next try: the error's `retryAfter` (seconds, from
 * the Retry-After header) clamped to [min, max], else `min`.
 */
export function retryDelayMs(e, { minDelayMs = RETRY_MIN_DELAY_MS, maxDelayMs = RETRY_MAX_DELAY_MS } = {}) {
  const s = Number(e && e.retryAfter);
  if (!Number.isFinite(s) || s <= 0) return minDelayMs;
  return Math.min(maxDelayMs, Math.max(minDelayMs, Math.round(s * 1000)));
}

/**
 * Run `fn` and retry it while it fails with a seeding 503 or a busy 429,
 * waiting what the server's Retry-After asks (clamped), until `attempts`
 * calls were made OR `budgetMs` has elapsed; any other error is thrown at
 * once. `onRetry(attemptNumber, { waitMs, busy, elapsedMs })` fires before
 * each wait so a flow can say what it is waiting for.
 */
export async function retryOn503(
  fn,
  { attempts = 3, budgetMs = Infinity, minDelayMs = RETRY_MIN_DELAY_MS, maxDelayMs = RETRY_MAX_DELAY_MS, delayMs, onRetry, sleep, now } = {},
) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = now || (() => Date.now());
  const started = clock();
  // `delayMs` (older callers / tests): a fixed wait, whatever the server says.
  const lo = delayMs ?? minDelayMs;
  const hi = delayMs ?? maxDelayMs;
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      const retryable = isSeedingError(e) || isSeedBusyError(e);
      if (!retryable || i === attempts) throw e;
      last = e;
      const waitMs = retryDelayMs(e, { minDelayMs: lo, maxDelayMs: hi });
      const elapsedMs = clock() - started;
      if (elapsedMs + waitMs > budgetMs) throw e;
      if (onRetry) onRetry(i, { waitMs, busy: isSeedBusyError(e), elapsedMs });
      await wait(waitMs);
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
