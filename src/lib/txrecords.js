// Client-side record of every transaction this browser broadcast (or tried
// to broadcast) that has not been seen to settle yet — per address, in
// localStorage ('lp.txrec.<address>'), so a reload, a navigation or an
// account switch does not forget it.
//
// Two jobs (audit usertx-2 / usertx-6):
//
//   * Its INPUTS are excluded from fee selection until the tx confirms or
//     drops. The indexer's /btc-utxos confirmed set only changes when a
//     block is applied, so without this a second build (OKX path) picks
//     an input the first tx already spends, and under full-RBF the second
//     tx silently replaces the first — e.g. a listing withdrawal undone by
//     the next MINE.
//   * A DEPLOY / MINE that is still pending is remembered with its ticker:
//     the Create page refuses to offer a ticker the user already has a
//     pending DEPLOY for (a second DEPLOY would pay the fees twice), and
//     the mine console resumes tracking a pending MINE after a reload.
//
// A record is dropped when its tx confirmed and nothing needs it any more,
// when the indexer's node reports it unknown for longer than
// DROP_GRACE_MS (dropped / replaced), or after TXREC_TTL_MS (the default
// mempool expiry). A confirmed DEPLOY or MINE is KEPT (marked confirmed)
// until the page that shows its result has shown it: the Create page's
// registry verdict, the mine console's reveal — "tracking resumes when you
// return" must hold even when another page's build refreshed the records
// in between (audit mine-4). Pure parts are unit-tested in
// test/pending.test.js.

export const TXREC_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const TXREC_KEY_PREFIX = "lp.txrec.";
/** How long a broadcast tx may be unknown to the indexer's node before it counts as dropped. */
export const DROP_GRACE_MS = 3 * 60 * 1000;
/** Records kept per address (oldest dropped first). */
export const TXREC_MAX = 50;

const TXID_RE = /^[0-9a-f]{64}$/;
const OUTPOINT_RE = /^[0-9a-f]{64}:(0|[1-9][0-9]{0,6})$/;
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
  return { txid, kind, ticker, inputs, at, confirmed };
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
 * At most TXREC_MAX records, oldest first. Over the cap, CONFIRMED records
 * (kept only for a result page) go first, oldest first — an unconfirmed
 * one guards inputs against being re-spent and is evicted only when
 * nothing else is left.
 */
export function trimRecords(list, max = TXREC_MAX) {
  if (list.length <= max) return list;
  let drop = list.length - max;
  const gone = new Set();
  for (const r of list) {
    if (drop === 0) break;
    if (r.confirmed) {
      gone.add(r.txid);
      drop -= 1;
    }
  }
  const kept = list.filter((r) => !gone.has(r.txid));
  return kept.slice(-max);
}

/**
 * The record of this browser's own, still unconfirmed transaction that
 * spends `outpoint` ("txid:vout") — matched by the order's
 * `pending_spend_txid` when the indexer names one, else by the record's
 * inputs — or null. A listing whose pending spend is one of these is the
 * seller's own withdrawal (or split), not a buyer's fill (audit
 * portfolio-1).
 */
export function ownPendingSpendOf(records, outpoint, pendingSpendTxid = null) {
  const key = String(outpoint || "").toLowerCase();
  const t = String(pendingSpendTxid || "").toLowerCase();
  for (const r of records || []) {
    if (r.confirmed) continue;
    if (t && r.txid === t) return r;
    if (key && r.inputs.includes(key) && r.kind !== "fill") return r;
  }
  return null;
}

/** Outpoints ("txid:vout") spent by records that are not confirmed. */
export function pendingSpentOutpoints(records) {
  const out = new Set();
  for (const r of records || []) if (!r.confirmed) for (const k of r.inputs) out.add(k);
  return out;
}

/**
 * What a /tx-status answer means for a record: "confirmed" | "pending"
 * (in the mempool, or still inside the grace window) | "dropped" (unknown
 * to the node for longer than `graceMs`) | "unknown" (no answer).
 */
export function classifyTxStatus(record, status, now = Date.now(), graceMs = DROP_GRACE_MS) {
  if (!status) return "unknown";
  if (status.confirmed) return "confirmed";
  if (status.seen) return "pending";
  return now - record.at > graceMs ? "dropped" : "pending";
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
    /** Record a broadcast tx `{ txid, kind, ticker, inputs: [{ txid, vout }] | ["txid:vout"] }`. */
    add(address, { txid, kind = "other", ticker = null, inputs = [] }) {
      const keys = (inputs || []).map((i) => (typeof i === "string" ? i : `${i.txid}:${i.vout}`));
      const rec = normalizeTxRecord({ txid, kind, ticker, inputs: keys, at: now() }, now());
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
    /** Forget one tx. */
    remove(address, txid) {
      const t = String(txid || "").toLowerCase();
      write(address, read(address).filter((r) => r.txid !== t));
    },
    /** Mark one tx confirmed (its inputs are no longer excluded; the record stays for its ticker). */
    markConfirmed(address, txid) {
      const t = String(txid || "").toLowerCase();
      write(address, read(address).map((r) => (r.txid === t ? { ...r, confirmed: true } : r)));
    },
  };
}

const DEFAULT_STORE = createTxRecordStore();

export const recordBroadcastTx = (address, rec) => DEFAULT_STORE.add(address, rec);
export const txRecords = (address) => DEFAULT_STORE.list(address);
export const forgetTx = (address, txid) => DEFAULT_STORE.remove(address, txid);
export const markTxConfirmed = (address, txid) => DEFAULT_STORE.markConfirmed(address, txid);

/** Kinds whose confirmed record is kept until the page showing its result forgets it. */
export const KEEP_WHEN_CONFIRMED = new Set(["deploy", "mine"]);

/**
 * Re-check every record of `address` that still matters against the
 * indexer (`txStatus(txid)` → the /tx-status shape) and prune: a dropped
 * tx is forgotten, a confirmed one is forgotten too — except a DEPLOY or a
 * MINE, which is marked confirmed (its inputs need no exclusion any more)
 * and kept for its ticker until the Create page / mine console has shown
 * the result. Returns the surviving records with a `state`
 * ("confirmed" | "pending" | "unknown").
 */
export async function refreshTxRecords(address, txStatus, { store = DEFAULT_STORE, now = Date.now, graceMs = DROP_GRACE_MS } = {}) {
  const out = [];
  for (const r of store.list(address)) {
    if (r.confirmed) {
      out.push({ ...r, state: "confirmed" });
      continue;
    }
    let s = null;
    try {
      s = await txStatus(r.txid);
    } catch {
      s = null;
    }
    const state = classifyTxStatus(r, s, now(), graceMs);
    if (state === "dropped") {
      store.remove(address, r.txid);
      continue;
    }
    if (state === "confirmed") {
      // A confirmed DEPLOY stays until the registry lists its ticker (the
      // Create page forgets it then), a confirmed MINE until the console has
      // shown its reveal; anything else has nothing left to guard.
      if (KEEP_WHEN_CONFIRMED.has(r.kind)) store.markConfirmed(address, r.txid);
      else {
        store.remove(address, r.txid);
        continue;
      }
    }
    out.push({ ...r, confirmed: state === "confirmed", state, status: s });
  }
  return out;
}
