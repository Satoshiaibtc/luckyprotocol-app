// How far the indexer is behind the chain tip (audit usertx-1). Pure, no
// React; tested in test/views.test.js.
//
// The indexer answers from the state it has APPLIED. During a cold scan
// (a snapshot-version bump, a refused or corrupt snapshot, a reorg
// rebuild) and for the seconds after every block, that state is older than
// the chain: a ticker deployed in an unapplied block reads as free, and a
// token's `minted` is stale. Every write flow that depends on "not taken"
// or "supply left" checks this first.

/**
 * `{ indexed, tip, lag, stalled, synced }` from a /health read — `lag` is
 * null while either height is unknown, and `synced` is true only when both
 * are known, equal, and progress is not stalled.
 */
export function syncStateOf(health) {
  const indexed = Number.isInteger(health?.indexed_height) ? health.indexed_height : null;
  const tip = Number.isInteger(health?.tip_height) ? health.tip_height : null;
  const lag = indexed !== null && tip !== null ? Math.max(0, tip - indexed) : null;
  const stalled = !!health?.stalled;
  return { indexed, tip, lag, stalled, synced: lag === 0 && !stalled };
}

/**
 * The error for a click that found the indexer behind at the moment of the
 * click (the idle hint above did not see it yet): says that nothing was
 * sent and what to do — press again — instead of promising an automatic
 * resume the flow does not have (audit create-8). null when synced.
 */
export function syncRetryText(sync, subject, action = "Create") {
  if (!sync || sync.synced) return null;
  let reason;
  if (sync.stalled) reason = "the indexer has stopped making progress";
  else if (sync.lag === null) reason = "the indexer has not reported how far it has indexed";
  else {
    const n = sync.lag;
    reason = `the indexer is ${n.toLocaleString("en-US")} block${n === 1 ? "" : "s"} behind the chain tip (#${sync.indexed.toLocaleString("en-US")} of #${sync.tip.toLocaleString("en-US")})`;
  }
  return `Nothing was sent: ${reason}, so ${subject} could be out of date. Press ${action} again once it has caught up.`;
}

/** One sentence for a page that pauses while the indexer is not synced, or null when it is. */
export function syncPauseText(sync, what) {
  if (!sync || sync.synced) return null;
  if (sync.stalled) return `The indexer has stopped making progress, so ${what} would rely on stale state — paused until it recovers.`;
  if (sync.lag === null) return `The indexer has not reported how far it has indexed yet — ${what} is paused until it does.`;
  const n = sync.lag;
  return `The indexer is ${n.toLocaleString("en-US")} block${n === 1 ? "" : "s"} behind the chain tip (#${sync.indexed.toLocaleString("en-US")} of #${sync.tip.toLocaleString("en-US")}), so ${what} would rely on stale state — paused until it catches up.`;
}
