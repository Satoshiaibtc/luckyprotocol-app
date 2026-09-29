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

/** HTTP answers that mean "busy right now, ask again": too many requests, overloaded, request timeout. */
const BUSY_STATUSES = new Set([408, 429, 503]);

/**
 * True when the indexer ANSWERED but is busy — rate-limited (429),
 * overloaded (503) or timed the request out (408). It is up: the next
 * poll usually gets through.
 */
export function isIndexerBusy(err) {
  return !!err && BUSY_STATUSES.has(Number(err.status));
}

// The transport's prefix in front of the server's own sentence:
// "Indexer /tokens?limit=500 -> HTTP 400: " (a path is not for a page).
const TRANSPORT_PREFIX_RE = /^Indexer \S* -> HTTP \d{3}(?::\s*)?/;

/**
 * One plain sentence for a failed indexer read. `retrySec` names the poll
 * interval ("retrying every 15 s") when the caller keeps polling. No URL
 * or path is ever part of it (the raw message stays in indexerErrorTitle).
 */
export function indexerErrorText(err, { retrySec = null } = {}) {
  if (!err) return "";
  const retry = Number.isFinite(retrySec) && retrySec > 0 ? ` Retrying every ${retrySec} s.` : "";
  if (isIndexerOffline(err)) return `The indexer is offline.${retry}`;
  const status = Number(err.status);
  if (isIndexerBusy(err)) {
    const wait = Number(err.retryAfter) > 0 ? Math.ceil(Number(err.retryAfter)) : Number.isFinite(retrySec) && retrySec > 0 ? retrySec : null;
    return wait ? `The indexer is busy — retrying in ${wait} s.` : "The indexer is busy right now — try again shortly.";
  }
  if (Number.isInteger(status) && status >= 500) return `The indexer answered with an error (HTTP ${status}).${retry}`;
  const msg = String(err.message || err);
  if (TRANSPORT_PREFIX_RE.test(msg)) {
    const sentence = msg.replace(TRANSPORT_PREFIX_RE, "").trim();
    return `${sentence ? `${sentence[0].toUpperCase()}${sentence.slice(1)}${/[.!?]$/.test(sentence) ? "" : "."}` : `The indexer refused the request (HTTP ${status}).`}${retry}`;
  }
  return msg;
}

/** The raw message, for a `title` attribute next to `indexerErrorText`. */
export function indexerErrorTitle(err) {
  return err ? String(err.message || err) : undefined;
}
