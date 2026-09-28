// A second view of the Bitcoin network, next to the indexer's own node:
// the chain tip and the fee estimates of the second source (mempool.space,
// the same one the buyer-side outpoint check reads — src/lib/secondSource.js).
//
// Why: the indexer knows only what its one node knows. A node that lost
// its peers, fell behind or was fed an old chain still reports "synced" to
// itself; its fee estimator lags a sudden rush and has nothing at all after
// a restart. Comparing with an independent tip catches the first, and
// taking the higher fast estimate softens the second.
//
// Privacy: the two URLs carry no user data at all (no address, no txid),
// no credentials and no body. Every visitor's browser reads them, each
// every NETWORK_POLL_MS (2 minutes), on every page — so mempool.space sees
// each visitor's IP address, not only the buyers'.
// Pure parts (`networkLag`, `mergeFeeSources`) are unit-tested in
// test/network.test.js; the fetchers take an injectable fetch.

import { SECOND_SOURCE_NAME, SECOND_SOURCE_ORIGIN, SECOND_SOURCE_TIMEOUT_MS } from "./secondSource.js";
import { HIGH_FEE_FASTEST_MULTIPLE, HIGH_FEE_MIN_SAT_VB } from "./feechoice.js";

export const NETWORK_TIP_URL = `${SECOND_SOURCE_ORIGIN}/api/blocks/tip/height`;
export const NETWORK_FEES_URL = `${SECOND_SOURCE_ORIGIN}/api/v1/fees/recommended`;
/** How often the app asks the second source (tip and fees each). */
export const NETWORK_POLL_MS = 120_000;
/** Our node counts as behind the network when the second source's tip is at least this many blocks higher… */
export const NETWORK_LAG_BLOCKS = 2;
/** …on two reads at least this far apart (one read can race a new block). */
export const NETWORK_LAG_CONFIRM_MS = 90_000;

const FEE_KEYS = ["fastestFee", "halfHourFee", "hourFee", "economyFee", "minimumFee"];

async function getJson(url, { fetchImpl, timeoutMs = SECOND_SOURCE_TIMEOUT_MS } = {}) {
  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!f) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { method: "GET", signal: ctrl.signal, credentials: "omit", cache: "no-store" });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The second source's chain tip height, or null when it cannot be read (never an error). */
export async function fetchNetworkTip(opts = {}) {
  const v = await getJson(NETWORK_TIP_URL, opts);
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1e8 ? n : null;
}

/**
 * The second source's recommended rates `{ fastestFee, halfHourFee,
 * hourFee, economyFee, minimumFee }` (sat/vB), or null when it cannot be
 * read. A malformed or absurd value is null.
 */
export async function fetchNetworkFees(opts = {}) {
  const v = await getJson(NETWORK_FEES_URL, opts);
  return sanitizeNetworkFees(v);
}

export function sanitizeNetworkFees(v) {
  if (!v || typeof v !== "object") return null;
  const out = {};
  let any = false;
  for (const k of FEE_KEYS) {
    const n = Number(v[k]);
    out[k] = Number.isFinite(n) && n >= 1 && n <= 1_000_000 ? n : null;
    if (out[k] !== null) any = true;
  }
  return any ? out : null;
}

/**
 * Fold one second-source tip read into the lag tracker `prev`
 * (`{ behindSince, networkTip }`, or null) against our node's `tip` at
 * `now` → the next tracker. `behindSince` is the time of the first read in
 * the current run of reads that all put our node NETWORK_LAG_BLOCKS or
 * more behind; any read that does not (or an unknown height) clears it.
 */
export function networkLag(prev, { networkTip, tip, now }) {
  const behind = Number.isInteger(networkTip) && Number.isInteger(tip) && networkTip - tip >= NETWORK_LAG_BLOCKS;
  if (!behind) return { behindSince: null, networkTip: Number.isInteger(networkTip) ? networkTip : null };
  return { behindSince: prev?.behindSince ?? now, networkTip };
}

/**
 * How many blocks our node is behind the network, or 0 — only once the
 * tracker has seen it on reads at least NETWORK_LAG_CONFIRM_MS apart, and
 * measured against the CURRENT `tip` (a node that caught up is not behind).
 */
export function confirmedNetworkLag(tracker, tip, now) {
  if (!tracker || tracker.behindSince === null || !Number.isInteger(tracker.networkTip) || !Number.isInteger(tip)) return 0;
  if (now - tracker.behindSince < NETWORK_LAG_CONFIRM_MS) return 0;
  const n = tracker.networkTip - tip;
  return n >= NETWORK_LAG_BLOCKS ? n : 0;
}

/**
 * The fee estimates every builder uses, from the indexer's `/fees`
 * (already sanitized: tiers are null when it could not estimate, `ok:
 * false`) and the second source's recommended rates (or null):
 *
 *   - the indexer answered: its tiers, with the FAST tier raised to the
 *     second source's when that is higher (a sudden rush shows there
 *     first; the node's estimator only learns from blocks already mined) —
 *     but never above max(HIGH_FEE_MIN_SAT_VB, HIGH_FEE_FASTEST_MULTIPLE ×
 *     the indexer's own fast estimate): a faulty second source (or anything
 *     in front of it) must not make every Fast payment overpay silently.
 *     That bound is where a custom rate starts asking for a confirmation;
 *     a higher rate stays possible through Custom, confirmed;
 *   - the indexer has no estimates: the second source's tiers, said so;
 *   - neither: every tier null — the page says so and only Custom works.
 *
 * → the fees object plus `source` ("indexer" | "second" | null),
 * `fastFrom` ("indexer" | "second" | null, where the fast tier came from)
 * and `fastCapped` (the second source's fast rate was above the bound).
 * `incrementalrelayfee` is always the indexer's.
 */
export function mergeFeeSources(indexerFees, networkFees) {
  const own = indexerFees || null;
  const ext = networkFees || null;
  const has = (f) => !!f && FEE_KEYS.slice(0, 4).some((k) => Number.isFinite(f[k]) && f[k] !== null);
  const base = { incrementalrelayfee: own?.incrementalrelayfee ?? null, ok: own ? own.ok !== false : false };
  if (has(own)) {
    const mine = Number.isFinite(own.fastestFee) ? own.fastestFee : null;
    const ref = mine ?? (Number.isFinite(own.halfHourFee) ? own.halfHourFee : 0);
    const cap = Math.max(HIGH_FEE_MIN_SAT_VB, ref * HIGH_FEE_FASTEST_MULTIPLE);
    const quoted = ext && Number.isFinite(ext.fastestFee) ? ext.fastestFee : null;
    const theirs = quoted !== null ? Math.min(quoted, cap) : null;
    const raise = theirs !== null && (mine === null || theirs > mine);
    return {
      ...base,
      fastestFee: raise ? theirs : mine,
      halfHourFee: own.halfHourFee ?? null,
      hourFee: own.hourFee ?? null,
      economyFee: own.economyFee ?? null,
      minimumFee: own.minimumFee ?? null,
      source: "indexer",
      fastFrom: raise ? "second" : mine === null ? null : "indexer",
      // the second source quoted more than the bound: Fast stops there
      fastCapped: raise && quoted > theirs,
    };
  }
  if (has(ext)) {
    return {
      ...base,
      fastestFee: ext.fastestFee ?? null,
      halfHourFee: ext.halfHourFee ?? null,
      hourFee: ext.hourFee ?? null,
      economyFee: ext.economyFee ?? null,
      minimumFee: ext.minimumFee ?? null,
      source: "second",
      fastFrom: ext.fastestFee != null ? "second" : null,
      fastCapped: false,
    };
  }
  return { ...base, fastestFee: null, halfHourFee: null, hourFee: null, economyFee: null, minimumFee: null, source: null, fastFrom: null, fastCapped: false };
}

/** One line for the fee selector about where the estimates came from, or null for the plain case. */
export function feeSourceNote(fees) {
  if (!fees) return null;
  if (fees.source === "second") return `The indexer's node has no fee estimate right now — these are ${SECOND_SOURCE_NAME}'s.`;
  if (fees.source === "indexer" && fees.fastFrom === "second" && fees.fastCapped) {
    return `Fast follows ${SECOND_SOURCE_NAME}, which currently estimates much higher than the indexer's node — up to ${fees.fastestFee} sat/vB; pick Custom for more.`;
  }
  if (fees.source === "indexer" && fees.fastFrom === "second") return `Fast follows ${SECOND_SOURCE_NAME}, which currently estimates higher than the indexer's node.`;
  return null;
}
