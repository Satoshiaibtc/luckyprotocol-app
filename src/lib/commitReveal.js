// Commit-reveal deploy (PROTOCOL.md §2.1) — the Create page's two steps:
//
//   1. Reserve  = the COMMIT: `LUCKY-20|COMMIT|<H>` with a 546-sat carrier
//                 at vout0. H = SHA-256(REVEAL payload ‖ the carrier's
//                 scriptPubKey), so the chain learns nothing about the
//                 ticker, and a copy of H is useless to anyone else.
//   2. Publish  = the REVEAL: `LUCKY-20|DEPLOY|<TICKER>|<SALT>`, spending
//                 the carrier as input 0, confirmed at least MIN_COMMIT_AGE
//                 and at most MAX_COMMIT_AGE blocks after the COMMIT.
//
// Between the two steps the only proof of WHICH ticker was reserved is the
// salt, and it lives only in this browser (with the carrier script, the
// rest of what H covers): the record below is persisted
// per address in localStorage ('lp.deploy.<address>') BEFORE the COMMIT is
// signed, and survives reloads until the user finishes or abandons it.
// Pure parts (record normalization, the store over an injectable storage
// and clock, the timing math, the texts) are tested in
// test/deploylog.test.js; the React side is src/hooks/useCommitReveal.js.

import { MAX_COMMIT_AGE, MIN_COMMIT_AGE, SALT_RE, SCRIPT_HEX_RE, TICKER_RE, commitHashFor } from "./payloads.js";
import { blocksEtaText, blocksText } from "./activation.js";

export const DEPLOY_RECORD_PREFIX = "lp.deploy.";
// 2: the record keeps `carrierScript`, the scriptPubKey H binds (§2.1). A
// record without one cannot recompute H and is not read.
export const DEPLOY_RECORD_VERSION = 2;

const TXID_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]+$/;

/**
 * A draft (ticker + salt chosen, no COMMIT signed yet) older than this is
 * abandoned work — the wallet window of that attempt is long gone — and may
 * be cleared. A younger one may belong to a signature that is still open in
 * this or another tab, so it is kept (audit LENS-3).
 */
export const DRAFT_STALE_MS = 30 * 60 * 1000;

const txidList = (list, except = []) => {
  const skip = new Set(except);
  return Array.isArray(list) ? [...new Set(list.map((t) => String(t).toLowerCase()).filter((t) => TXID_RE.test(t) && !skip.has(t)))] : [];
};

/** Storage key for an address (lower-cased; no address shares "*"). */
export function deployRecordKey(address) {
  const a = typeof address === "string" ? address.trim().toLowerCase() : "";
  return `${DEPLOY_RECORD_PREFIX}${a || "*"}`;
}

const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

function normalizeInputs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const u of list) {
    const txid = String(u?.txid || "").toLowerCase();
    const vout = Number(u?.vout);
    const sats = Number(u?.sats);
    if (TXID_RE.test(txid) && Number.isInteger(vout) && vout >= 0 && Number.isInteger(sats) && sats > 0) out.push({ txid, vout, sats });
  }
  return out;
}

/**
 * One step's tx sub-record (COMMIT or REVEAL), or null when malformed:
 *   txid        the tx this browser signed (known before it is broadcast)
 *   psbt        its UNSIGNED PSBT hex — what "Speed up" rebuilds from
 *   signedAt    ms when the wallet signed it
 *   sentAt      ms when a relay accepted it; null = signed, broadcast not confirmed
 *   height      confirmation height once seen; null until then
 *   replaces    txids of earlier versions this one replaced (Speed up)
 *   unseenAt    ms when the indexer's node was found not to know this tx (nor
 *               any version it replaced) for DROP_GRACE_MS; null otherwise.
 *               An unseen step is never given up automatically: the page keeps
 *               checking every version, since a miner may still confirm one.
 *   feeSats / feeRateSatVb / vsize / changeVout / inputs — what the log and Speed up show
 */
export function normalizeStep(s) {
  if (!s || typeof s !== "object") return null;
  const txid = String(s.txid || "").toLowerCase();
  if (!TXID_RE.test(txid)) return null;
  const psbt = typeof s.psbt === "string" && s.psbt.length % 2 === 0 && HEX_RE.test(s.psbt.toLowerCase()) ? s.psbt.toLowerCase() : null;
  return {
    txid,
    psbt,
    signedAt: num(s.signedAt),
    sentAt: num(s.sentAt),
    height: int(s.height),
    feeSats: int(s.feeSats),
    feeRateSatVb: num(s.feeRateSatVb),
    vsize: int(s.vsize),
    changeVout: int(s.changeVout),
    inputs: normalizeInputs(s.inputs),
    replaces: txidList(s.replaces, [txid]),
    unseenAt: num(s.unseenAt),
  };
}

/**
 * A well-formed deploy record, or null. It holds everything H covers: the
 * ticker and salt (the REVEAL payload) and `carrierScript`, the scriptPubKey
 * of the carrier the COMMIT pays (lowercase hex — the user's own address).
 * The hash is RE-DERIVED from those three and must match: a record whose
 * salt or script was altered would otherwise publish a REVEAL that can
 * never match its COMMIT.
 */
export function normalizeDeployRecord(r) {
  if (!r || typeof r !== "object") return null;
  const ticker = String(r.ticker || "");
  const salt = String(r.salt || "");
  const carrierScript = typeof r.carrierScript === "string" ? r.carrierScript.toLowerCase() : "";
  if (!TICKER_RE.test(ticker) || !SALT_RE.test(salt) || !SCRIPT_HEX_RE.test(carrierScript)) return null;
  const hash = commitHashFor(ticker, salt, carrierScript);
  if (r.hash !== undefined && r.hash !== hash) return null;
  const commit = normalizeStep(r.commit);
  const carrierSats = int(r.carrierSats);
  return {
    v: DEPLOY_RECORD_VERSION,
    ticker,
    salt,
    carrierScript,
    hash,
    createdAt: num(r.createdAt) ?? 0,
    carrierSats: carrierSats && carrierSats > 0 ? carrierSats : null,
    commit,
    // A reveal without a commit is meaningless — dropped.
    reveal: commit ? normalizeStep(r.reveal) : null,
    // Publish transactions this reservation sent that the indexer's node
    // lost sight of while the reservation stayed open (the reveal was then
    // released so the user could publish again). One of them may still
    // confirm; if it does, it is ours (audit LENS-2).
    droppedReveals: commit ? txidList(r.droppedReveals) : [],
  };
}

/** Parse a stored JSON string → a record or null (garbage → null). */
export function parseDeployRecord(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return normalizeDeployRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Where a record stands, from the record alone (the live chain status is
 * the hook's job):
 *   "none"          no record
 *   "draft"         ticker + salt chosen, no COMMIT signed yet
 *   "commit-unsent" COMMIT signed, no relay confirmed the broadcast (check tx-status)
 *   "committed"     COMMIT broadcast (pending or confirmed), no REVEAL yet
 *   "reveal-unsent" REVEAL signed, broadcast not confirmed
 *   "revealed"      REVEAL broadcast
 */
export function deployStage(rec) {
  if (!rec) return "none";
  if (!rec.commit) return "draft";
  if (!rec.commit.sentAt) return "commit-unsent";
  if (!rec.reveal) return "committed";
  if (!rec.reveal.sentAt) return "reveal-unsent";
  return "revealed";
}

/** Is `rec` a draft old enough to clear (no COMMIT was signed within DRAFT_STALE_MS)? */
export function isStaleDraft(rec, now = Date.now()) {
  return deployStage(rec) === "draft" && now - (rec.createdAt || 0) > DRAFT_STALE_MS;
}

/** Every txid a step has had, the current one first, then the versions it replaced, newest first. */
export function stepVersions(step) {
  if (!step) return [];
  return [step.txid, ...[...(step.replaces || [])].reverse()].filter((t, i, a) => a.indexOf(t) === i);
}

/**
 * What the /tx-status answers for a step's versions say (`results` =
 * `[{ txid, status }]`, `status` null when the indexer could not be asked):
 *   { kind: "confirmed", txid, height }  a version confirmed (the first found wins)
 *   { kind: "seen", txid }               none confirmed, one is in the node's mempool
 *   { kind: "unknown" }                  none seen, and at least one could not be asked
 *   { kind: "none" }                     the node knows none of them
 */
export function resolveVersions(results) {
  const list = results || [];
  const conf = list.find((r) => r.status?.confirmed && Number.isInteger(r.status.block_height));
  if (conf) return { kind: "confirmed", txid: conf.txid, height: conf.status.block_height };
  const seen = list.find((r) => r.status?.seen || r.status?.in_mempool);
  if (seen) return { kind: "seen", txid: seen.txid };
  return list.some((r) => !r.status) ? { kind: "unknown" } : { kind: "none" };
}

/**
 * `step` switched to its version `txid` (one it replaced, or itself): the
 * others become `replaces`, the unseen mark is cleared and — when `height`
 * is known — the step is confirmed there. The stored PSBT is kept (Speed up
 * of an older version from it still pays more than that version did).
 */
export function switchStepTo(step, txid, { height = null, now = Date.now() } = {}) {
  const t = String(txid).toLowerCase();
  const all = stepVersions(step);
  const same = step.txid === t;
  return {
    ...step,
    txid: t,
    replaces: all.filter((x) => x !== t).reverse(),
    sentAt: step.sentAt ?? now,
    height: Number.isInteger(height) ? height : step.height,
    unseenAt: null,
    // The fee figures describe the version this browser built last.
    feeSats: same ? step.feeSats : null,
    feeRateSatVb: same ? step.feeRateSatVb : null,
    vsize: same ? step.vsize : null,
  };
}

/**
 * Why the indexer's record of the COMMIT (`c`, a CommitView) does not
 * belong to the reservation `rec` of `address`, or null when it does
 * (audit LENS-4): its `hash` must be the record's H (so the saved ticker,
 * salt and carrier script reveal it) and its `committer` the connected
 * address (so the deployer is the user). `addressScript` (optional, the
 * scriptPubKey hex of `address`) must be the script the record's H was made
 * with: H binds the carrier's script, so a record made for another address
 * can never be published from this one. Publishing anything else pays the
 * fee for nothing.
 */
export function commitMismatch(c, rec, address, { addressScript = null } = {}) {
  if (!c || !rec) return null;
  if (addressScript && String(addressScript).toLowerCase() !== rec.carrierScript) return "The reservation saved in this browser was made for another address than the connected one";
  if (c.hash && c.hash !== rec.hash) return "The indexer's record of step 1 holds a different sealed code from the one saved in this browser for " + rec.ticker;
  if (c.committer && address && !sameAddress(c.committer, address)) return `Step 1's reserved output belongs to ${c.committer}, not to the connected address`;
  if (!c.hash) return "The indexer's record of step 1 does not show its sealed code";
  return null;
}

/** Bech32 addresses compare case-insensitively; base58 ones exactly. */
export function sameAddress(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (/^bc1/i.test(x) && /^bc1/i.test(y)) return x.toLowerCase() === y.toLowerCase();
  return x === y;
}

/** The reservation window of a COMMIT confirmed at `commitHeight`: `{ revealFrom, expiresAt }` (block heights, inclusive). */
export function revealWindow(commitHeight) {
  if (!Number.isInteger(commitHeight)) return null;
  return { revealFrom: commitHeight + MIN_COMMIT_AGE, expiresAt: commitHeight + MAX_COMMIT_AGE };
}

/**
 * The REVEAL timing at `tip` for a COMMIT confirmed at `commitHeight`:
 *   ready       a REVEAL sent now confirms at tip + 1 or later ≥ revealFrom
 *   blocksLeft  blocks that can still hold a valid REVEAL (tip + 1 … expiresAt)
 *   expired     none can any more (tip ≥ expiresAt)
 * or null while either height is unknown.
 */
export function revealTiming(commitHeight, tip) {
  const w = revealWindow(commitHeight);
  if (!w || !Number.isInteger(tip)) return null;
  const blocksLeft = Math.max(0, w.expiresAt - tip);
  return { ...w, ready: tip + 1 >= w.revealFrom, blocksLeft, expired: blocksLeft === 0 };
}

/** Below this many blocks left the countdown turns into a warning. */
export const EXPIRY_WARN_BLOCKS = 144;

/** "Publish by block #971,317 — 2,015 blocks left (about 14 days)." */
export function expiryText(timing) {
  if (!timing) return "";
  if (timing.expired) return `The reservation expired at block #${timing.expiresAt.toLocaleString("en-US")} — it can no longer be published.`;
  return `Publish by block #${timing.expiresAt.toLocaleString("en-US")} — ${blocksText(timing.blocksLeft)} left (${blocksEtaText(timing.blocksLeft)}).`;
}

/**
 * The verdict for a published (REVEAL) record from the registry row of its
 * ticker (`/tokens/:ticker`, null = no row):
 *   "registered"  the row's deploy_txid is this REVEAL (or one it replaced)
 *   "taken"       a row exists for another deploy
 *   "unindexed"   no row (yet)
 */
export function revealVerdict(row, rec) {
  if (!row) return "unindexed";
  return ownPublishTxids(rec).has(String(row.deploy_txid || "").toLowerCase()) ? "registered" : "taken";
}

/** Every publish transaction this reservation ever sent: the current one, the ones it replaced and the released ones. */
export function ownPublishTxids(rec) {
  return new Set([rec?.reveal?.txid, ...(rec?.reveal?.replaces || []), ...(rec?.droppedReveals || [])].filter(Boolean));
}

/**
 * The phase the Create page shows for `rec`, from the record and the live
 * facts the hook polls:
 *
 *   commitStatus  /commits/:txid status; null = not recorded (404); undefined = not asked yet
 *   commitInfo    the whole CommitView (its reveal_applied / reveal_reason once our publish spent the carrier)
 *   row           /tokens/:ticker row; null = no row; undefined = not asked yet
 *   rowAsOf       the indexer's applied height when `row` was read (null = unknown)
 *   tip           chain tip height (null = unknown)
 *
 * → "idle" | "draft" | "reserve-unsent" | "reserve-pending" | "reserve-unseen"
 *   | "recording" | "ready" | "taken" | "expired" | "invalid" | "carrier-spent"
 *   | "publish-unsent" | "publish-pending" | "publish-unseen"
 *   | "publish-pending-taken" | "publish-confirmed" | "registered"
 *   | "taken-after" | "refused"
 *
 * "reserve-unseen" / "publish-unseen": the indexer's node has not known the
 * step (nor any version it replaced) for a few minutes. Not a dead end — a
 * miner may still confirm it — so the record and its salt are kept and the
 * page keeps checking (audits LENS-2 / ux-1).
 */
export function deployPhase({ rec, commitStatus, commitInfo = null, row, rowAsOf = null, tip }) {
  switch (deployStage(rec)) {
    case "none":
      return "idle";
    case "draft":
      return "draft";
    case "commit-unsent":
      return rec.commit.unseenAt ? "reserve-unseen" : "reserve-unsent";
    case "reveal-unsent":
      return rec.reveal.unseenAt ? "publish-unseen" : "publish-unsent";
    case "committed": {
      // Someone else's DEPLOY registered the name first: this reservation
      // can no longer claim it, whatever its own state. (A publish of our
      // own that was released as dropped may have registered it after all:
      // the page restores it from /commits — "recording" meanwhile.)
      if (row) return ownPublishTxids(rec).has(String(row.deploy_txid || "").toLowerCase()) ? "recording" : "taken";
      if (!Number.isInteger(rec.commit.height)) return rec.commit.unseenAt ? "reserve-unseen" : "reserve-pending";
      const t = revealTiming(rec.commit.height, tip);
      if (commitStatus === "invalid") return "invalid";
      if (commitStatus === "revealed") return commitInfo && ownPublishTxids(rec).has(commitInfo.spent_txid) ? "recording" : "carrier-spent";
      if (commitStatus === "expired" || t?.expired) return "expired";
      if (commitStatus !== "open" || !t?.ready) return "recording";
      // The registry row of the ticker has not been read yet (undefined, not
      // null): never offer Publish before it is known to be free (ux-5).
      if (row === undefined) return "recording";
      return "ready";
    }
    case "revealed": {
      const v = revealVerdict(row, rec);
      if (!Number.isInteger(rec.reveal.height)) {
        if (v === "registered") return "registered";
        if (rec.reveal.unseenAt) return "publish-unseen";
        return v === "taken" ? "publish-pending-taken" : "publish-pending";
      }
      if (v === "registered") return "registered";
      // The indexer's own verdict on the spend of our carrier (CommitView).
      const ours = ownPublishTxids(rec);
      if (commitInfo && commitInfo.reveal_applied === false && ours.has(commitInfo.spent_txid)) {
        return commitInfo.reveal_reason === "ticker_taken" ? "taken-after" : "refused";
      }
      if (v === "taken") return "taken-after";
      // No row although the indexer had applied the REVEAL's block when the
      // row was read: the REVEAL did not apply.
      if (row === null && Number.isInteger(rowAsOf) && rowAsOf >= rec.reveal.height) return "refused";
      return "publish-confirmed";
    }
    default:
      return "idle";
  }
}

/** Phases in which a reservation can only be abandoned (nothing left to publish). */
export const DEAD_END_PHASES = new Set(["taken", "expired", "invalid", "carrier-spent", "taken-after", "refused"]);

/** Plain words for a §2.1 REVEAL `reason` (CommitView.reveal_reason); unknown codes are shown as they are. */
export function revealReasonText(reason) {
  switch (reason) {
    case null:
    case undefined:
      return "";
    case "commit_required":
      return "it had no reservation (the one-step form is never accepted)";
    case "no_commit":
      return "its first input did not use a recorded reservation";
    case "commit_invalid":
      return "the reservation was not valid (see step 1)";
    case "hash_mismatch":
      return "the ticker or code did not match the reservation";
    case "commit_before_activation":
      return "the reservation confirmed before the protocol started";
    case "commit_too_recent":
      return "it confirmed in the same block as the reservation";
    case "commit_expired":
      return "it confirmed after the reservation expired";
    case "fee_missing":
      return "it did not pay the exact protocol fee";
    case "ticker_taken":
      return "the name was already created by someone else";
    default:
      return `indexer reason: ${String(reason)}`;
  }
}

/** Plain words for a /commits/:txid status. */
export function commitStatusText(status) {
  switch (status) {
    case "open":
      return "recorded by the indexer — ready to publish";
    case "revealed":
      return "already used by a publish transaction";
    case "expired":
      return "expired — too many blocks have passed";
    case "invalid":
      return "not accepted by the indexer";
    default:
      return "not recorded by the indexer yet";
  }
}

/**
 * Plain words for why the indexer recorded a COMMIT `invalid` (§2.1
 * `invalid_reason`: only the carrier output can make it so — a copy of the
 * sealed code in someone else's reservation never does).
 */
export function invalidReasonText(reason) {
  switch (reason) {
    case "carrier_missing":
    case "carrier_op_return":
    case "carrier_no_address":
      return "The first output of step 1 cannot hold a reservation, so the indexer did not accept it.";
    default:
      return "The indexer did not accept step 1 as a reservation.";
  }
}

// ---- the store --------------------------------------------------------------------------

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
    const probe = `${DEPLOY_RECORD_PREFIX}__probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * One deploy record per address over any { getItem, setItem, removeItem }
 * storage (localStorage in the browser, a fake in tests). A storage that
 * throws falls back to memory for the session — `backend()` then says
 * "memory" and the page warns that a reload would forget the reservation.
 */
export function createDeployRecordStore({ storage, now = () => Date.now() } = {}) {
  let store = storage === undefined ? browserStorage() : storage;
  const fallback = memoryStorage();
  const backend = () => store || fallback;

  const read = (address) => {
    const key = deployRecordKey(address);
    try {
      return parseDeployRecord(backend().getItem(key));
    } catch {
      store = null;
      return parseDeployRecord(fallback.getItem(key));
    }
  };
  const write = (address, rec) => {
    const key = deployRecordKey(address);
    const text = rec ? JSON.stringify(rec) : null;
    try {
      if (text) backend().setItem(key, text);
      else backend().removeItem(key);
    } catch {
      store = null;
      if (text) fallback.setItem(key, text);
      else fallback.removeItem(key);
    }
  };

  return {
    /** The record of `address`, or null. */
    load(address) {
      return read(address);
    },
    /**
     * A new draft for `ticker` with `salt` and `carrierScript` (the
     * scriptPubKey hex of the carrier the COMMIT will pay). → the record.
     * Refuses (throws, `code: "busy"`) while `address` has any other record
     * that is not a stale draft — a reservation in another tab or window
     * included, so two Reserve clicks can never overwrite each other's salt
     * (audit LENS-4).
     */
    start(address, { ticker, salt, carrierScript }) {
      const rec = normalizeDeployRecord({ ticker, salt, carrierScript, createdAt: now(), commit: null, reveal: null });
      if (!rec) throw new Error("cannot start a reservation: invalid ticker, salt or carrier script");
      const cur = read(address);
      if (cur && !isStaleDraft(cur, now())) throw Object.assign(new Error("A reservation is already open for this address (in this or another tab) — publish or abandon it first."), { code: "busy" });
      write(address, rec);
      return rec;
    },
    /**
     * Apply `fn(record) → record` only when `pred(record)` holds — the
     * record is still the one this caller started or read. → the stored
     * record, or null (no record, or it changed: nothing is written).
     */
    claim(address, pred, fn) {
      const cur = read(address);
      if (!cur || !pred(cur)) return null;
      const next = normalizeDeployRecord(fn(cur));
      if (!next) throw new Error("the reservation record update is malformed");
      write(address, next);
      return next;
    },
    /** Apply `fn(record) → record` and persist it. → the stored record (null when there was none). */
    update(address, fn) {
      const cur = read(address);
      if (!cur) return null;
      const next = normalizeDeployRecord(fn(cur));
      if (!next) throw new Error("the reservation record update is malformed");
      write(address, next);
      return next;
    },
    /** Forget the record of `address` (finish or abandon). */
    clear(address) {
      write(address, null);
    },
    /** "storage" | "memory" (after a failure, or without localStorage). */
    backend() {
      return store ? "storage" : "memory";
    },
  };
}

const DEFAULT_STORE = createDeployRecordStore();

export const loadDeployRecord = (address) => DEFAULT_STORE.load(address);
export const startDeployRecord = (address, init) => DEFAULT_STORE.start(address, init);
export const updateDeployRecord = (address, fn) => DEFAULT_STORE.update(address, fn);
export const claimDeployRecord = (address, pred, fn) => DEFAULT_STORE.claim(address, pred, fn);
export const clearDeployRecord = (address) => DEFAULT_STORE.clear(address);
export const deployRecordBackend = () => DEFAULT_STORE.backend();
