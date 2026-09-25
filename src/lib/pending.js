// Client-side registry of outpoints that WILL carry tokens once a tx we just
// broadcast confirms (MINE vout0, SEND-to-self vout0 + vout3, fill vout1 +
// vout4).
//
// The §4 builder obligation excludes ≤546-sat outputs and everything the
// indexer's /utxos/:addr reports — but the indexer only reports token
// outpoints after the tx confirms. If a wallet's UTXO source handed us an
// unconfirmed carrier as a fee input before the indexer knows about it, the
// next tx would be a plain spend of that carrier and default routing would
// move its tokens to that tx's first output. This set closes that window.
//
// Persistence: localStorage, keyed by address ('lp.pending.<address>' →
// { "txid:vout": addedAt }), with a 2-hour TTL — a reload no longer forgets
// what was just broadcast. Two hours is safe because the UTXO paths also
// refuse every UNCONFIRMED output outright (wallet.getBitcoinUtxos); by the
// time an entry expires the tx is either confirmed (and the indexer lists
// its carriers) or still unconfirmed (and excluded for that reason).
// Without usable storage the registry degrades to an in-memory map.
//
// The pure parts (record parsing / pruning / merging, the store factory with
// an injectable storage + clock) are tested in test/pending.test.js.

export const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
export const PENDING_KEY_PREFIX = "lp.pending.";

const TXID_RE = /^[0-9a-f]{64}$/;

/** Storage key for an address (lower-cased; a missing address shares the "*" bucket). */
export function pendingStorageKey(address) {
  const a = typeof address === "string" ? address.trim().toLowerCase() : "";
  return `${PENDING_KEY_PREFIX}${a || "*"}`;
}

/** "txid:vout" for a well-formed outpoint, else null. */
export function outpointId(o) {
  if (!o || typeof o.txid !== "string") return null;
  const txid = o.txid.toLowerCase();
  const vout = Number(o.vout);
  if (!TXID_RE.test(txid) || !Number.isInteger(vout) || vout < 0) return null;
  return `${txid}:${vout}`;
}

/**
 * Drop expired (now − addedAt > ttl) and malformed entries. Entries stamped
 * in the future (clock skew, tampering) are kept but re-stamped to `now` so
 * they still expire. → a NEW plain object { "txid:vout": addedAt }.
 */
export function prunePendingRecord(rec, now = Date.now(), ttl = PENDING_TTL_MS) {
  const out = {};
  if (!rec || typeof rec !== "object") return out;
  for (const [k, at] of Object.entries(rec)) {
    const [txid, voutStr] = String(k).split(":");
    if (outpointId({ txid, vout: Number(voutStr) }) !== k) continue;
    const t = Number(at);
    if (!Number.isFinite(t)) continue;
    const stamp = t > now ? now : t;
    if (now - stamp > ttl) continue;
    out[k] = stamp;
  }
  return out;
}

/** Parse a stored JSON record (string | null) and prune it. Garbage → {}. */
export function parsePendingRecord(raw, now = Date.now(), ttl = PENDING_TTL_MS) {
  if (typeof raw !== "string" || !raw) return {};
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return {};
  }
  return prunePendingRecord(rec, now, ttl);
}

export function serializePendingRecord(rec) {
  return JSON.stringify(rec || {});
}

/** Merge `list` ([{ txid, vout }]) into `rec`, stamping each at `now`. Malformed rows are skipped. */
export function addToPendingRecord(rec, list, now = Date.now()) {
  const out = { ...(rec || {}) };
  for (const o of list || []) {
    const k = outpointId(o);
    if (k) out[k] = now;
  }
  return out;
}

/** The outpoints of a record → [{ txid, vout }]. */
export function pendingRecordOutpoints(rec) {
  const out = [];
  for (const k of Object.keys(rec || {})) {
    const [txid, vout] = k.split(":");
    out.push({ txid, vout: Number(vout) });
  }
  return out;
}

/** Merge indexer-reported token outpoints with a pending list (deduplicated, first wins). */
export function mergeOutpoints(tokenOutpoints, pending) {
  const seen = new Set();
  const out = [];
  for (const o of [...(tokenOutpoints || []), ...(pending || [])]) {
    const k = outpointId(o);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ txid: o.txid.toLowerCase(), vout: Number(o.vout) });
  }
  return out;
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
    // A blocked / private-mode storage throws on the first touch.
    const probe = `${PENDING_KEY_PREFIX}__probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * A pending-outpoint store over any { getItem, setItem, removeItem }
 * storage (localStorage in the browser; a fake in tests) and an injectable
 * clock. Every read prunes and, when something expired, writes the pruned
 * record back; a storage that starts throwing mid-session falls back to an
 * in-memory copy so a build never crashes on it.
 */
export function createPendingStore({ storage, now = () => Date.now(), ttl = PENDING_TTL_MS } = {}) {
  let store = storage === undefined ? browserStorage() : storage;
  const fallback = memoryStorage();
  const backend = () => store || fallback;

  const write = (address, rec) => {
    const key = pendingStorageKey(address);
    const empty = Object.keys(rec).length === 0;
    try {
      if (empty) backend().removeItem(key);
      else backend().setItem(key, serializePendingRecord(rec));
    } catch {
      store = null;
      if (empty) fallback.removeItem(key);
      else fallback.setItem(key, serializePendingRecord(rec));
    }
  };

  const read = (address) => {
    const key = pendingStorageKey(address);
    let raw = null;
    try {
      raw = backend().getItem(key);
    } catch {
      store = null;
      raw = fallback.getItem(key);
    }
    const rec = parsePendingRecord(raw, now(), ttl);
    // Write back when pruning removed something (or the record was garbage).
    if (raw && serializePendingRecord(rec) !== raw) write(address, rec);
    return rec;
  };

  return {
    /** Register outpoints for `address` (stamped now). → the live list. */
    add(list, address) {
      const rec = addToPendingRecord(read(address), list, now());
      write(address, rec);
      return pendingRecordOutpoints(rec);
    },
    /** Live (unexpired) pending outpoints for `address`. */
    list(address) {
      return pendingRecordOutpoints(read(address));
    },
    /** Indexer-reported token outpoints ∪ pending ones for `address`. */
    withPending(tokenOutpoints, address) {
      return mergeOutpoints(tokenOutpoints, this.list(address));
    },
    /** Forget everything for `address`. */
    clear(address) {
      write(address, {});
    },
    /** Which backend is live: "storage" | "memory" (after a failure or without localStorage). */
    backend() {
      return store ? "storage" : "memory";
    },
  };
}

const DEFAULT_STORE = createPendingStore();

/** Register outpoints that will carry tokens once the tx confirms, for `address`. */
export function addPendingTokenOutpoints(list, address) {
  return DEFAULT_STORE.add(list, address);
}

/** Live pending outpoints for `address`. */
export function pendingTokenOutpoints(address) {
  return DEFAULT_STORE.list(address);
}

/** Merge indexer-reported token outpoints with the pending set for `address`. */
export function withPending(tokenOutpoints, address) {
  return DEFAULT_STORE.withPending(tokenOutpoints, address);
}
