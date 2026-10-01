// Client-side record of every transaction this browser broadcast (or tried
// to broadcast) that has not been seen to settle yet — per address, in
// localStorage ('lp.txrec.<address>'), so a reload, a navigation or an
// account switch does not forget it.
//
// Two jobs:
//
//   * Its INPUTS are excluded from fee selection until the tx confirms or
//     drops. The node's confirmed UTXO set (GET /txouts) only changes when
//     a block is mined, so without this a second build picks an input the
//     first tx already spends, and under full-RBF the second tx silently
//     replaces the first — e.g. a listing withdrawal undone by the next
//     MINE.
//   * A DEPLOY / MINE that is still pending is remembered with its ticker:
//     the Create page refuses to offer a ticker the user already has a
//     pending DEPLOY for (a second DEPLOY would pay the fees twice), and
//     the mine console resumes tracking a pending MINE after a reload.
//
// A confirmed record is kept until its block is FINAL (src/lib/finality.js):
// a chain reorganization can put a confirmed tx back into the mempool, and
// its inputs then reappear as unspent in the indexer's view — spending one
// again would replace the user's own tx (a withdrawal undone by the next
// MINE). So its inputs stay excluded until the block has FINAL_DEPTH
// confirmations (or, when the depth cannot be read, FINAL_GUARD_MS after
// it was first seen confirmed), and a re-check that finds it back in the
// mempool marks it unconfirmed again. A record is dropped when it is final
// and nothing needs it any more, when the indexer's node has not seen it
// for longer than DROP_GRACE_MS since it was last seen (dropped /
// replaced — counted only while that answer means something, see
// `setUnseenTrusted`), or after TXREC_TTL_MS (the default mempool expiry).
// A confirmed DEPLOY or MINE is KEPT until the page that shows its result
// has shown it (`done`): the Create page's registry verdict, the mine
// console's final credit — "tracking resumes when you return" must hold
// even when another page's build refreshed the records in between. Pure
// parts are unit-tested in test/pending.test.js and
// test/flows.test.js.

import { FINAL_DEPTH, confirmationsAt } from "./finality.js";

export const TXREC_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const TXREC_KEY_PREFIX = "lp.txrec.";
/**
 * How long a broadcast tx may be unknown to the indexer's node, since it
 * was last seen (or broadcast), before it counts as dropped. Generous: a
 * node can miss a tx the rest of the network holds (a relay path through
 * the wallet's own backend, a restart that emptied its mempool).
 */
export const DROP_GRACE_MS = 10 * 60 * 1000;
/** A confirmed record whose depth cannot be read guards its inputs this long (~12 blocks). */
export const FINAL_GUARD_MS = 2 * 60 * 60 * 1000;
/** Records kept per address (oldest dropped first). */
export const TXREC_MAX = 50;
/**
 * A confirmed record that is not final yet is asked about again at most
 * this often (every build refreshes the records; its inputs stay excluded
 * in between whatever the answer).
 */
export const CONFIRMED_RECHECK_MS = 60 * 1000;

const TXID_RE = /^[0-9a-f]{64}$/;
const OUTPOINT_RE = /^[0-9a-f]{64}:(0|[1-9][0-9]{0,6})$/;
const HEX_RE = /^[0-9a-f]+$/;
/** An unsigned PSBT longer than this (hex characters) is not kept with its record (no Speed up after a reload). */
export const TXREC_PSBT_MAX = 60_000;
const KINDS = new Set(["deploy", "mine", "send", "fill", "other"]);
const TICKER_RE = /^[A-Z0-9]{1,8}$/;

/** Storage key for an address (lower-cased; no address shares "*"). */
export function txRecordKey(address) {
  const a = typeof address === "string" ? address.trim().toLowerCase() : "";
  return `${TXREC_KEY_PREFIX}${a || "*"}`;
}

/** A well-formed record, normalized — or null. */
export function normalizeTxRecord(r, now = Date.now()) {
  if (!r || typeof r !== "object") return null;
  const txid = String(r.txid || "").toLowerCase();
  if (!TXID_RE.test(txid)) return null;
  const kind = KINDS.has(r.kind) ? r.kind : "other";
  const ticker = TICKER_RE.test(String(r.ticker || "")) ? String(r.ticker) : null;
  const inputs = Array.isArray(r.inputs) ? [...new Set(r.inputs.map((k) => String(k).toLowerCase()).filter((k) => OUTPOINT_RE.test(k)))] : [];
  let at = Number(r.at);
  if (!Number.isFinite(at)) return null;
  if (at > now) at = now;
  const confirmed = r.confirmed === true;
  const stamp = (v) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.min(Number(v), now) : null);
  const height = Number(r.blockHeight);
  return {
    txid,
    kind,
    ticker,
    inputs,
    at,
    confirmed,
    // when the indexer's node last reported it (in its mempool or confirmed)
    seenAt: stamp(r.seenAt),
    // the block it confirmed in, and when that was first seen (null while unconfirmed)
    blockHeight: confirmed && r.blockHeight !== null && Number.isInteger(height) && height >= 0 ? height : null,
    confirmedAt: confirmed ? stamp(r.confirmedAt) : null,
    // the page that shows its result has shown it; kept only to guard its inputs until final
    done: r.done === true,
    // A DEPLOY's, MINE's or transfer's unsigned PSBT and BTC change output
    // (what a Speed up rebuilds from after a reload), and the txids of the
    // versions it replaced.
    psbt: typeof r.psbt === "string" && r.psbt.length > 0 && r.psbt.length <= TXREC_PSBT_MAX && r.psbt.length % 2 === 0 && HEX_RE.test(r.psbt.toLowerCase()) ? r.psbt.toLowerCase() : null,
    changeVout: Number.isInteger(r.changeVout) && r.changeVout >= 0 && r.changeVout < 1_000 ? r.changeVout : null,
    replaces: Array.isArray(r.replaces) ? [...new Set(r.replaces.map((t) => String(t).toLowerCase()).filter((t) => TXID_RE.test(t) && t !== txid))].slice(-20) : [],
  };
}

/** Parse a stored JSON list, drop malformed and expired rows, keep the newest TXREC_MAX. */
export function parseTxRecords(raw, now = Date.now(), ttl = TXREC_TTL_MS) {
  if (typeof raw !== "string" || !raw) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const n = normalizeTxRecord(r, now);
    if (!n || seen.has(n.txid) || now - n.at > ttl) continue;
    seen.add(n.txid);
    out.push(n);
  }
  out.sort((a, b) => a.at - b.at);
  return trimRecords(out);
}

/**
 * At most TXREC_MAX records, oldest first. Over the cap, records kept only
 * as a guard (`done`, confirmed) go first, then other CONFIRMED records
 * (kept for a result page), oldest first — an unconfirmed one guards
 * inputs against being re-spent and is evicted only when nothing else is
 * left.
 */
export function trimRecords(list, max = TXREC_MAX) {
  if (list.length <= max) return list;
  let drop = list.length - max;
  const gone = new Set();
  for (const pick of [(r) => r.confirmed && r.done, (r) => r.confirmed]) {
    for (const r of list) {
      if (drop === 0) break;
      if (!gone.has(r.txid) && pick(r)) {
        gone.add(r.txid);
        drop -= 1;
      }
    }
  }
  const kept = list.filter((r) => !gone.has(r.txid));
  return kept.slice(-max);
}

/**
 * The record of this browser's own transaction that spends `outpoint`
 * ("txid:vout") and is in the mempool, or null. A listing whose pending
 * spend is one of these is the seller's own withdrawal (or split), not a
 * buyer's fill.
 *
 * When the indexer names the pending spend (`pendingSpendTxid`), only that
 * txid counts — even a record already seen confirmed (a chain
 * reorganization put it back in the mempool). A record whose inputs
 * include the outpoint but whose txid is NOT the named spend was replaced
 * (someone else's fill paid more): that is not the user's pending
 * withdrawal any more. Only while the indexer names nothing (it has not
 * seen the spend yet) are the unconfirmed records' inputs matched.
 */
export function ownPendingSpendOf(records, outpoint, pendingSpendTxid = null) {
  const key = String(outpoint || "").toLowerCase();
  const t = String(pendingSpendTxid || "").toLowerCase();
  for (const r of records || []) {
    if (t) {
      if (r.txid === t) return r;
      continue;
    }
    if (!r.confirmed && key && r.inputs.includes(key) && r.kind !== "fill") return r;
  }
  return null;
}

/**
 * This browser's own unconfirmed transaction that spent `outpoint` but is
 * NOT the spend the indexer now reports (`pendingSpendTxid`) — replaced in
 * the mempool, e.g. a withdrawal out-bid by a fill of the old listing — or
 * null.
 */
export function replacedOwnSpendOf(records, outpoint, pendingSpendTxid) {
  const key = String(outpoint || "").toLowerCase();
  const t = String(pendingSpendTxid || "").toLowerCase();
  if (!t || !key) return null;
  for (const r of records || []) {
    if (!r.confirmed && r.txid !== t && r.inputs.includes(key) && r.kind !== "fill") return r;
  }
  return null;
}

/**
 * Outpoints ("txid:vout") spent by the records — unconfirmed ones AND
 * confirmed ones that are not final yet (a final record has left the
 * store): a chain reorganization can put a confirmed tx back in the
 * mempool and its inputs back in the indexer's unspent view. Excluding an
 * input that is really spent costs nothing — it is not in the UTXO set.
 */
export function pendingSpentOutpoints(records) {
  const out = new Set();
  for (const r of records || []) for (const k of r.inputs) out.add(k);
  return out;
}

/**
 * Has a confirmed record reached finality at `tip` (the indexer's applied
 * height)? When its depth cannot be read, FINAL_GUARD_MS after it was
 * first seen confirmed counts instead.
 */
export function recordIsFinal(record, tip, now = Date.now()) {
  if (!record || !record.confirmed) return false;
  const n = confirmationsAt(record.blockHeight, tip);
  if (n !== null) return n >= FINAL_DEPTH;
  const since = record.confirmedAt ?? record.at;
  return Number.isFinite(since) && now - since >= FINAL_GUARD_MS;
}

// Is an unknown-to-the-node answer meaningful right now? The app keeps this
// in step with /health (App.jsx: `sync.trustUnseen`): while the indexer
// lags, is stalled or rebuilding, or its node has no peers, a tx the node
// does not know may simply not have reached it — no record is dropped then.
let unseenTrusted = true;
// The indexer's applied height, for the depth of confirmed records (null =
// unknown: the FINAL_GUARD_MS time guard applies). Also kept by the app.
let indexedTip = null;
/** Set by the app from the indexer's health; see above. */
export function setUnseenTrusted(v) {
  unseenTrusted = v !== false;
}
/** Set by the app from the indexer's health: its applied height. */
export function setIndexedTip(n) {
  indexedTip = Number.isInteger(n) ? n : null;
}
export const isUnseenTrusted = () => unseenTrusted;
/** The indexer's applied height as last set by the app (null = unknown). */
export const indexedTipNow = () => indexedTip;

/**
 * What a /tx-status answer means for a record: "confirmed" | "pending"
 * (in the mempool, or still inside the grace window, or the node's
 * "unknown" cannot be trusted right now) | "dropped" (unknown to the node
 * for longer than `graceMs` since it was last seen or broadcast) |
 * "unknown" (no answer).
 */
export function classifyTxStatus(record, status, now = Date.now(), graceMs = DROP_GRACE_MS, { trustUnseen = true } = {}) {
  if (!status) return "unknown";
  if (status.confirmed) return "confirmed";
  if (status.seen) return "pending";
  if (!trustUnseen) return "pending";
  const since = Math.max(record.at, Number.isFinite(record.seenAt) ? record.seenAt : 0);
  return now - since > graceMs ? "dropped" : "pending";
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

function browserStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = `${TXREC_KEY_PREFIX}__probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * A record store over any { getItem, setItem, removeItem } storage
 * (localStorage in the browser, a fake in tests) with an injectable
 * clock. A storage that throws falls back to memory for the session.
 */
export function createTxRecordStore({ storage, now = () => Date.now(), ttl = TXREC_TTL_MS } = {}) {
  let store = storage === undefined ? browserStorage() : storage;
  const fallback = memoryStorage();
  const backend = () => store || fallback;

  const read = (address) => {
    const key = txRecordKey(address);
    let raw = null;
    try {
      raw = backend().getItem(key);
    } catch {
      store = null;
      raw = fallback.getItem(key);
    }
    return parseTxRecords(raw, now(), ttl);
  };
  const write = (address, list) => {
    const key = txRecordKey(address);
    const text = JSON.stringify(list);
    try {
      if (list.length === 0) backend().removeItem(key);
      else backend().setItem(key, text);
    } catch {
      store = null;
      if (list.length === 0) fallback.removeItem(key);
      else fallback.setItem(key, text);
    }
  };

  return {
    /** Record a broadcast tx `{ txid, kind, ticker, inputs: [{ txid, vout }] | ["txid:vout"], psbt?, changeVout?, replaces? }`. */
    add(address, { txid, kind = "other", ticker = null, inputs = [], psbt = null, changeVout = null, replaces = [] }) {
      const keys = (inputs || []).map((i) => (typeof i === "string" ? i : `${i.txid}:${i.vout}`));
      const rec = normalizeTxRecord({ txid, kind, ticker, inputs: keys, at: now(), psbt, changeVout, replaces }, now());
      if (!rec) return read(address);
      const list = read(address).filter((r) => r.txid !== rec.txid);
      list.push(rec);
      const trimmed = trimRecords(list);
      write(address, trimmed);
      return trimmed;
    },
    /** Live records for `address`, oldest first. */
    list(address) {
      return read(address);
    },
    /** Delete one tx's record outright. */
    remove(address, txid) {
      const t = String(txid || "").toLowerCase();
      write(address, read(address).filter((r) => r.txid !== t));
    },
    /**
     * Forget one tx: an unconfirmed record (dropped, replaced, abandoned)
     * is deleted; a confirmed one is only marked `done` — it keeps guarding
     * its inputs until its block is final (refreshTxRecords deletes it then).
     */
    forget(address, txid) {
      const t = String(txid || "").toLowerCase();
      const list = read(address);
      const r = list.find((x) => x.txid === t);
      if (!r) return;
      if (r.confirmed) write(address, list.map((x) => (x.txid === t ? { ...x, done: true } : x)));
      else write(address, list.filter((x) => x.txid !== t));
    },
    /** Mark one tx confirmed in block `blockHeight` (null = not known yet); the record stays until final. */
    markConfirmed(address, txid, blockHeight = null) {
      const t = String(txid || "").toLowerCase();
      const at = now();
      write(
        address,
        read(address).map((r) =>
          r.txid === t
            ? {
                ...r,
                confirmed: true,
                blockHeight: Number.isInteger(blockHeight) ? blockHeight : r.blockHeight,
                confirmedAt: r.confirmed && r.confirmedAt !== null ? r.confirmedAt : at,
                seenAt: at,
              }
            : r,
        ),
      );
    },
    /** A confirmed tx is back in the mempool (a chain reorganization): unconfirmed again, its inputs still guarded. */
    markUnconfirmed(address, txid) {
      const t = String(txid || "").toLowerCase();
      const at = now();
      write(address, read(address).map((r) => (r.txid === t ? { ...r, confirmed: false, blockHeight: null, confirmedAt: null, seenAt: at } : r)));
    },
    /** The indexer's node reported the tx (in its mempool): the drop clock restarts. */
    markSeen(address, txid) {
      const t = String(txid || "").toLowerCase();
      const at = now();
      write(address, read(address).map((r) => (r.txid === t ? { ...r, seenAt: at } : r)));
    },
  };
}

const DEFAULT_STORE = createTxRecordStore();

export const recordBroadcastTx = (address, rec) => DEFAULT_STORE.add(address, rec);
export const txRecords = (address) => DEFAULT_STORE.list(address);
/** Forget a tx: see the store's `forget` (a confirmed one keeps guarding its inputs until final). */
export const forgetTx = (address, txid) => DEFAULT_STORE.forget(address, txid);
export const markTxConfirmed = (address, txid, blockHeight = null) => DEFAULT_STORE.markConfirmed(address, txid, blockHeight);
export const markTxUnconfirmed = (address, txid) => DEFAULT_STORE.markUnconfirmed(address, txid);

/** Kinds whose confirmed record is kept until the page showing its result forgets it. */
export const KEEP_WHEN_CONFIRMED = new Set(["deploy", "mine"]);

/**
 * Re-check every record of `address` that still matters against the
 * indexer (`txStatus(txid)` → the /tx-status shape) and prune:
 *
 *   - a dropped tx is forgotten (only while the node's "unknown" can be
 *     trusted — `trustUnseen`, default: the app's current health);
 *   - a confirmed tx stays until its block is final at `tip` (the
 *     indexer's applied height; unknown → FINAL_GUARD_MS), its inputs
 *     still excluded — then it is forgotten, except a DEPLOY or a MINE
 *     whose result page has not shown it yet (not `done`);
 *   - a confirmed tx found back in the mempool (a chain reorganization)
 *     is unconfirmed again. A confirmed record is asked about at most
 *     every CONFIRMED_RECHECK_MS (each build refreshes the records, and a
 *     heavy miner holds dozens of them for the hour before they are final).
 *   - a transfer a Speed up replaced is not dropped while its newest
 *     version (the record naming it in `replaces` that no other record
 *     replaces) waits and no version of it has confirmed: any of them may
 *     still confirm.
 *
 * Returns the surviving records with a `state` ("confirmed" | "pending" | "unknown").
 */
export async function refreshTxRecords(address, txStatus, { store = DEFAULT_STORE, now = Date.now, graceMs = DROP_GRACE_MS, tip = indexedTip, trustUnseen = unseenTrusted } = {}) {
  const out = [];
  const list = store.list(address);
  const confirmedTxids = new Set(list.filter((r) => r.confirmed).map((r) => r.txid));
  const replacedTxids = new Set(list.flatMap((r) => r.replaces));
  const waitingFaster = new Set(
    list.filter((r) => r.kind === "send" && !r.confirmed && !replacedTxids.has(r.txid) && !r.replaces.some((t) => confirmedTxids.has(t))).flatMap((r) => r.replaces),
  );
  for (const r of list) {
    if (r.confirmed && recordIsFinal(r, tip, now())) {
      if (r.done || !KEEP_WHEN_CONFIRMED.has(r.kind)) {
        store.remove(address, r.txid);
        continue;
      }
      out.push({ ...r, state: "confirmed" });
      continue;
    }
    if (r.confirmed && Number.isFinite(r.seenAt) && now() - r.seenAt < CONFIRMED_RECHECK_MS) {
      out.push({ ...r, state: "confirmed" });
      continue;
    }
    let s = null;
    try {
      s = await txStatus(r.txid);
    } catch {
      s = null;
    }
    if (r.confirmed) {
      // Not final yet: back in the mempool is a chain reorganization; any
      // other answer (including "unknown" while the indexer recovers from
      // one) keeps it confirmed and guarding.
      if (s && !s.confirmed && s.seen) {
        store.markUnconfirmed(address, r.txid);
        out.push({ ...r, confirmed: false, blockHeight: null, confirmedAt: null, state: "pending", status: s });
        continue;
      }
      // A confirmed answer is stamped (the next re-check waits); no answer is asked again next time.
      if (s && s.confirmed && Number.isInteger(s.block_height) && s.block_height !== r.blockHeight) store.markConfirmed(address, r.txid, s.block_height);
      else if (s && s.confirmed) store.markSeen(address, r.txid);
      out.push({ ...r, state: "confirmed", status: s });
      continue;
    }
    const state = classifyTxStatus(r, s, now(), graceMs, { trustUnseen });
    if (state === "dropped" && r.kind === "send" && waitingFaster.has(r.txid)) {
      out.push({ ...r, state: "pending", status: s });
      continue;
    }
    if (state === "dropped") {
      store.remove(address, r.txid);
      continue;
    }
    if (state === "confirmed") {
      // Kept (its inputs still excluded) until final; a confirmed DEPLOY or
      // MINE beyond that until its result page has shown it.
      store.markConfirmed(address, r.txid, s.block_height ?? null);
    } else if (s && s.seen) {
      store.markSeen(address, r.txid);
    }
    out.push({ ...r, confirmed: state === "confirmed", state, status: s });
  }
  return out;
}
