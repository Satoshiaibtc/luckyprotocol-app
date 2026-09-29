// Plain-language error text for indexer reads — pure, tested in
// test/views.test.js.
//
// The transport (src/lib/indexer.js) builds precise messages such as
// "Indexer unreachable: https://…/tokens?limit=200 — Failed to fetch".
// Those are right for a log, not for a page: the raw URL and the fetch
// wording do not translate, and a page would otherwise add its own
// "Indexer unreachable:" prefix in front of it. Pages show `indexerErrorText`
// and keep the raw message in a `title` (see `indexerErrorTitle`).

const OFFLINE_RE = /Indexer unreachable|Indexer timeout|Failed to fetch|NetworkError|Load failed|network error/i;

/** True when an error means the indexer could not be reached at all (no HTTP answer). */
export function isIndexerOffline(err) {
  if (!err) return false;
  return OFFLINE_RE.test(String(err.message || err));
}

/**
 * One plain sentence for a failed indexer read. `retrySec` names the poll
 * interval ("retrying every 15 s") when the caller keeps polling.
 */
export function indexerErrorText(err, { retrySec = null } = {}) {
  if (!err) return "";
  const retry = Number.isFinite(retrySec) && retrySec > 0 ? ` Retrying every ${retrySec} s.` : "";
  if (isIndexerOffline(err)) return `The indexer is offline.${retry}`;
  const status = Number(err.status);
  if (Number.isInteger(status) && status >= 500) return `The indexer answered with an error (HTTP ${status}).${retry}`;
  return String(err.message || err);
}

/** The raw message, for a `title` attribute next to `indexerErrorText`. */
export function indexerErrorTitle(err) {
  return err ? String(err.message || err) : undefined;
}
