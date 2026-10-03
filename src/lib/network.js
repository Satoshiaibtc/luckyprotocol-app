// A second view of the Bitcoin network, next to the indexer's own node:
// the chain tip and the projected next blocks of the second source
// (mempool.space, the same one the buyer-side outpoint check reads —
// src/lib/secondSource.js).
//
// Why: the indexer knows only what its one node knows. A node that lost
// its peers, fell behind or was fed an old chain still reports "synced" to
// itself, and it may have no fee estimate at all (right after a restart).
// Comparing with an independent tip catches the first; the second
// source's projected blocks stand in for the second.
//
// Privacy: the two URLs carry no user data at all (no address, no txid),
// no credentials and no body. Every visitor's browser reads the tip every
// NETWORK_POLL_MS (2 minutes), on every page — so mempool.space sees each
// visitor's IP address, not only the buyers'. The projected blocks are
// read on the same schedule, but only while the indexer has no estimate
// to use (see needNetworkFees).
// Pure parts (`networkLag`, `networkFeesFromBlocks`, `needNetworkFees`,
// `feesStillReading`, `feesRereadAfterTip`, `mergeFeeSources`) are
// unit-tested in test/network.test.js; the fetchers take an injectable
// fetch.

import { SECOND_SOURCE_NAME, SECOND_SOURCE_ORIGIN, SECOND_SOURCE_TIMEOUT_MS } from "./secondSource.js";

export const NETWORK_TIP_URL = `${SECOND_SOURCE_ORIGIN}/api/blocks/tip/height`;
export const NETWORK_FEES_URL = `${SECOND_SOURCE_ORIGIN}/api/v1/fees/mempool-blocks`;
/** How often the app asks the second source (tip and, when needed, fees). */
export const NETWORK_POLL_MS = 120_000;
/** Our node counts as behind the network when the second source's tip is at least this many blocks higher… */
export const NETWORK_LAG_BLOCKS = 2;
/** …on two reads at least this far apart (one read can race a new block). */
export const NETWORK_LAG_CONFIRM_MS = 90_000;

const TIER_KEYS = ["fastestFee", "halfHourFee", "hourFee", "economyFee"];

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
 * The second source's fee tiers, from its projected next blocks (see
 * networkFeesFromBlocks), or null when they cannot be read.
 */
export async function fetchNetworkFees(opts = {}) {
  const v = await getJson(NETWORK_FEES_URL, opts);
  return networkFeesFromBlocks(v);
}

/**
 * A block's `medianFee` (sat/vB) when it is a sane JSON number ≥ 0, else
 * null. 0 is a real median (the middle of the block pays nothing per vB);
 * the tiers built from it still floor at 1.
 */
function blockMedian(block) {
  const n = block && typeof block === "object" ? block.medianFee : undefined;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? n : null;
}

/** Rounded up to hundredths, like the indexer's /fees (binary noise at an exact hundredth ignored). */
function upToHundredths(v) {
  const h = v * 100;
  return Math.ceil(h - h * Number.EPSILON * 2) / 100;
}

/**
 * The second source's projected blocks (`GET /api/v1/fees/mempool-blocks`:
 * an array of `{ medianFee, … }`, the next block first) → tiers in the
 * shape of the indexer's /fees, or null when there is no usable next block:
 *
 *   fastestFee  = the next block's median fee rate
 *   halfHourFee = the second block's (Fast's when there is none)
 *   hourFee     = the third block's (Normal's when there is none)
 *   economyFee  = the last block's, else 1
 *
 * each rounded up to hundredths with a 1 sat/vB floor and never above the
 * tier before it; minimumFee 1. `nextBlockMedianFee` is the next block's
 * median itself, rounded up to hundredths (it may be below 1, or 0).
 */
export function networkFeesFromBlocks(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const next = blockMedian(v[0]);
  if (next === null) return null;
  const tier = (m) => Math.max(1, upToHundredths(m));
  const after = (i, prev) => {
    const m = blockMedian(v[i]);
    return m === null ? prev : Math.min(prev, tier(m));
  };
  const fastestFee = tier(next);
  const halfHourFee = after(1, fastestFee);
  const hourFee = after(2, halfHourFee);
  const last = blockMedian(v[v.length - 1]);
  const economyFee = Math.min(hourFee, last === null ? 1 : tier(last));
  return { fastestFee, halfHourFee, hourFee, economyFee, minimumFee: 1, nextBlockMedianFee: upToHundredths(next) };
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

/** True when `fees` (sanitized /fees, or second-source tiers) carries at least one tier. */
export function hasFeeEstimate(fees) {
  return !!fees && TIER_KEYS.some((k) => Number.isFinite(fees[k]));
}

/** How long the indexer's first `/fees` answer may take before the second source is read meanwhile. */
export const INDEXER_FEES_WAIT_MS = 10_000;

/**
 * Should the second source's projected blocks be read? `poll` is the
 * indexer's `/fees` poll (`{ data, error, loading }`, src/hooks/usePoll.js):
 * yes while its last read failed (its older answer is not used then either)
 * or it answered without an estimate, and while its first answer is still
 * outstanding once `waitedOut` (INDEXER_FEES_WAIT_MS passed). A re-read
 * (a new tip) keeps the last answer or error, so this does not flip back
 * while it runs and the stand-in does not blank out.
 */
export function needNetworkFees(poll, waitedOut = false) {
  if (!poll || poll.error != null) return true;
  if (poll.data == null) return !poll.loading || waitedOut === true;
  return !hasFeeEstimate(poll.data);
}

/**
 * Are fee rates still on their way? True while no estimate is in hand
 * (`hasFees` false) and a read that may bring one has not answered yet:
 * the indexer's first `/fees`, or the second source's projected blocks
 * while they are needed (`needNet`, see needNetworkFees). `feesPoll` and
 * `netPoll` are usePoll states; any answer, failed or empty, sets their
 * `updatedAt`. The fee selector then says the rates are being read rather
 * than that there are none.
 */
export function feesStillReading({ hasFees, feesPoll, needNet, netPoll }) {
  if (hasFees) return false;
  const unanswered = (p) => !!p && p.updatedAt == null && p.error == null;
  return unanswered(feesPoll) || (needNet === true && unanswered(netPoll));
}

/**
 * How long after a new chain tip `/fees` is read once more. The indexer
 * re-reads its node's next-block template about 12 s after each new block,
 * so the read the tip change itself triggers may still carry the previous
 * block's median; this one carries the new one.
 */
export const FEES_REREAD_AFTER_TIP_MS = 15_000;

/**
 * Delay (ms) for that extra `/fees` read when the tip went from `prevTip`
 * to `tip`, or null for none: only for a change between two known tips
 * (the first tip the page learns is read with the page itself).
 */
export function feesRereadAfterTip(prevTip, tip) {
  const known = (h) => Number.isSafeInteger(h) && h > 0;
  if (!known(prevTip) || !known(tip) || prevTip === tip) return null;
  return FEES_REREAD_AFTER_TIP_MS;
}

/**
 * Is `fastestFee` the next block's median `median` (sat/vB, before the
 * floor)? Both sources derive it as max(1, the median rounded up to
 * hundredths); compared in whole hundredths.
 */
function isNextBlockMedian(fastestFee, median) {
  if (!Number.isFinite(fastestFee) || !Number.isFinite(median) || median < 0) return false;
  return Math.round(fastestFee * 100) === Math.round(Math.max(1, upToHundredths(median)) * 100);
}

/**
 * The fee estimates every builder uses, from the indexer's `/fees`
 * (already sanitized: tiers are null when it could not estimate, `ok:
 * false`) and the second source's projected-block tiers (or null):
 *
 *   - the indexer answered: its tiers, as they are. Its Fast comes from
 *     the node's next block (`fastSource: "template"`) — the block's median
 *     fee rate, or a lower rate the block still has room at — or is the
 *     node's next-block estimate when it cannot build one ("estimate");
 *   - the indexer has no estimates: the second source's tiers, said so —
 *     their Fast is the median of its projected next block;
 *   - neither: every tier null — the page says so and only Custom works.
 *
 * → the fees object plus `source` ("indexer" | "second" | null),
 * `fastFromNextBlock` (Fast comes from the next block), `fastIsMedian`
 * (Fast is that block's median fee rate right now: it equals max(1,
 * `nextBlockMedianFee`)) and `nextBlockMedianFee` (that median before the
 * 1 sat/vB floor, or null). `incrementalrelayfee` is always the indexer's.
 */
export function mergeFeeSources(indexerFees, networkFees) {
  const own = indexerFees || null;
  const ext = networkFees || null;
  const base = { incrementalrelayfee: own?.incrementalrelayfee ?? null, ok: own ? own.ok !== false : false };
  const tiers = (f) => ({
    fastestFee: f.fastestFee ?? null,
    halfHourFee: f.halfHourFee ?? null,
    hourFee: f.hourFee ?? null,
    economyFee: f.economyFee ?? null,
    minimumFee: f.minimumFee ?? null,
  });
  const nextBlock = (f, fromNextBlock) => {
    const on = fromNextBlock && Number.isFinite(f.fastestFee);
    const m = on && Number.isFinite(f.nextBlockMedianFee) ? f.nextBlockMedianFee : null;
    return { fastFromNextBlock: on, fastIsMedian: on && isNextBlockMedian(f.fastestFee, m), nextBlockMedianFee: m };
  };
  if (hasFeeEstimate(own)) return { ...base, ...tiers(own), source: "indexer", ...nextBlock(own, own.fastSource === "template") };
  if (hasFeeEstimate(ext)) return { ...base, ...tiers(ext), source: "second", ...nextBlock(ext, true) };
  return { ...base, fastestFee: null, halfHourFee: null, hourFee: null, economyFee: null, minimumFee: null, source: null, fastFromNextBlock: false, fastIsMedian: false, nextBlockMedianFee: null };
}

/** One line for the fee selector about where the estimates came from, or null for the plain case. */
export function feeSourceNote(fees) {
  if (!fees) return null;
  if (fees.source === "second") return `The indexer's node has no fee estimate right now — these are ${SECOND_SOURCE_NAME}'s.`;
  return null;
}
