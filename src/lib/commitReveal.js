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
import { FINAL_DEPTH, confirmationsAt } from "./finality.js";

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
 * this or another tab, so it is kept.
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
    // the chain tip when it was (last) sent: a block above it without the step means it missed one
    sentTip: int(s.sentTip),
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
    // confirm; if it does, it is ours.
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
 * belong to the reservation `rec` of `address`, or null when it does:
 * its `hash` must be the record's H (so the saved ticker,
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

/**
 * Confirmations step 1 needs before Publish opens. The rules accept a
 * publish in any block after the reservation's — but one sent at the first
 * confirmation can, after a one-block chain reorganization, confirm in the
 * SAME block as step 1: then it does not count, the reservation is used up
 * and the name is public. Waiting for the second confirmation closes that
 * window (it costs one block, about ten minutes).
 */
export const PUBLISH_MIN_CONFIRMATIONS = 2;

/**
 * Publish closes when fewer than this many blocks can still hold it. A
 * publish needs room for a block it misses (fees), a chain reorganization
 * that confirms it a block later, and the page's tip being a block behind
 * the network; one that confirms after the window does not count — its
 * fees are paid and the name is public. Giving up the last hour of a
 * two-week window costs nothing.
 */
export const PUBLISH_CUTOFF_BLOCKS = 6;

/** The reservation window of a COMMIT confirmed at `commitHeight`: `{ revealFrom, expiresAt }` (block heights, inclusive). */
export function revealWindow(commitHeight) {
  if (!Number.isInteger(commitHeight)) return null;
  return { revealFrom: commitHeight + MIN_COMMIT_AGE, expiresAt: commitHeight + MAX_COMMIT_AGE };
}

/**
 * The REVEAL timing at `tip` for a COMMIT confirmed at `commitHeight`:
 *   ready          a REVEAL sent now confirms at tip + 1 or later ≥ revealFrom (the rules allow it)
 *   confirmations  step 1's confirmations at `tip`
 *   settled        it has PUBLISH_MIN_CONFIRMATIONS (the app's Publish waits for that)
 *   publishFrom    the tip at which it will have them
 *   blocksLeft     blocks that can still hold a valid REVEAL (tip + 1 … expiresAt)
 *   expired        none can any more (tip ≥ expiresAt)
 *   closing        not expired, but fewer than PUBLISH_CUTOFF_BLOCKS left: Publish is closed
 *   publishable    ready AND settled AND neither expired nor closing
 * or null while either height is unknown.
 */
export function revealTiming(commitHeight, tip) {
  const w = revealWindow(commitHeight);
  if (!w || !Number.isInteger(tip)) return null;
  const blocksLeft = Math.max(0, w.expiresAt - tip);
  const ready = tip + 1 >= w.revealFrom;
  const confirmations = confirmationsAt(commitHeight, tip);
  const settled = confirmations >= PUBLISH_MIN_CONFIRMATIONS;
  const expired = blocksLeft === 0;
  const closing = !expired && blocksLeft < PUBLISH_CUTOFF_BLOCKS;
  return {
    ...w,
    ready,
    confirmations,
    settled,
    publishFrom: commitHeight + PUBLISH_MIN_CONFIRMATIONS - 1,
    blocksLeft,
    expired,
    closing,
    publishable: ready && settled && !expired && !closing,
  };
}

/** Below this many blocks left the countdown turns into a warning. */
export const EXPIRY_WARN_BLOCKS = 144;

/**
 * "Publish by block #971,311 — 2,009 blocks left (about 14 days)." — the
 * last block Publish is open (PUBLISH_CUTOFF_BLOCKS before the expiry).
 */
export function expiryText(timing) {
  if (!timing) return "";
  if (timing.expired) return `The reservation expired at block #${timing.expiresAt.toLocaleString("en-US")} — it can no longer be published.`;
  if (timing.closing) return `The reservation expires at block #${timing.expiresAt.toLocaleString("en-US")}: fewer than ${PUBLISH_CUTOFF_BLOCKS} blocks are left, so Publish is closed.`;
  const lastTip = timing.expiresAt - PUBLISH_CUTOFF_BLOCKS;
  const left = Math.max(0, timing.blocksLeft - PUBLISH_CUTOFF_BLOCKS + 1);
  return `Publish by block #${lastTip.toLocaleString("en-US")} — ${blocksText(left)} left (${blocksEtaText(left)}); publishing closes ${PUBLISH_CUTOFF_BLOCKS} blocks before the reservation expires.`;
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
 *   indexed       the indexer's applied height, for the depth of the registry row (default: tip)
 *
 * → "idle" | "draft" | "reserve-unsent" | "reserve-pending" | "reserve-unseen"
 *   | "recording" | "settling" | "ready" | "taken-tentative" | "taken"
 *   | "closing" | "expired" | "invalid" | "carrier-spent"
 *   | "publish-unsent" | "publish-pending" | "publish-unseen"
 *   | "publish-pending-taken" | "publish-confirmed"
 *   | "registered-provisional" | "registered" | "taken-after" | "refused"
 *
 * "reserve-unseen" / "publish-unseen": the indexer's node has not known the
 * step (nor any version it replaced) for a few minutes. Not a dead end — a
 * miner may still confirm it — so the record and its salt are kept and the
 * page keeps checking.
 *
 * Depth (src/lib/finality.js): "settling" — step 1 confirmed but Publish
 * waits for PUBLISH_MIN_CONFIRMATIONS; "closing" — too few blocks left to
 * publish safely (PUBLISH_CUTOFF_BLOCKS); "taken-tentative" — someone
 * else's DEPLOY of the name is not final yet, so it could still change;
 * "registered-provisional" — ours, not final yet.
 */
export function deployPhase({ rec, commitStatus, commitInfo = null, row, rowAsOf = null, tip, indexed = tip }) {
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
      if (row) {
        if (ownPublishTxids(rec).has(String(row.deploy_txid || "").toLowerCase())) return "recording";
        // Someone else's DEPLOY: final only at FINAL_DEPTH — until then a
        // chain reorganization could still undo it.
        return rowIsFinal(row, indexed) ? "taken" : "taken-tentative";
      }
      if (!Number.isInteger(rec.commit.height)) return rec.commit.unseenAt ? "reserve-unseen" : "reserve-pending";
      const t = revealTiming(rec.commit.height, tip);
      if (commitStatus === "invalid") return "invalid";
      if (commitStatus === "revealed") return commitInfo && ownPublishTxids(rec).has(commitInfo.spent_txid) ? "recording" : "carrier-spent";
      if (commitStatus === "expired" || t?.expired) return "expired";
      if (commitStatus === "open" && t?.closing) return "closing";
      if (commitStatus !== "open" || !t?.ready) return "recording";
      if (!t.settled) return "settling";
      // The registry row of the ticker has not been read yet (undefined, not
      // null): never offer Publish before it is known to be free.
      if (row === undefined) return "recording";
      return "ready";
    }
    case "revealed": {
      const v = revealVerdict(row, rec);
      const registered = rowIsFinal(row, indexed) ? "registered" : "registered-provisional";
      if (!Number.isInteger(rec.reveal.height)) {
        if (v === "registered") return registered;
        if (rec.reveal.unseenAt) return "publish-unseen";
        return v === "taken" ? "publish-pending-taken" : "publish-pending";
      }
      if (v === "registered") return registered;
      // The indexer's own verdict on the spend of our carrier (CommitView).
      const ours = ownPublishTxids(rec);
      if (commitInfo && commitInfo.reveal_applied === false && ours.has(commitInfo.spent_txid)) {
        return commitInfo.reveal_reason === "ticker_taken" ? "taken-after" : "refused";
      }
      if (v === "taken") return "taken-after";
      // No row although the indexer had applied the REVEAL's block when the
      // row was read: the REVEAL did not apply — but only on the indexer's
      // word that OUR publish spent the reservation. After a chain
      // reorganization took the publish out of its block the reservation is
      // open again and there is no row either: that is not a verdict, the
      // page keeps checking.
      if (
        row === null &&
        Number.isInteger(rowAsOf) &&
        rowAsOf >= rec.reveal.height &&
        commitInfo &&
        commitInfo.status === "revealed" &&
        ours.has(commitInfo.spent_txid) &&
        commitInfo.reveal_applied !== true
      ) {
        return "refused";
      }
      return "publish-confirmed";
    }
    default:
      return "idle";
  }
}

/** Is the registry row's DEPLOY final at `indexed` (its block FINAL_DEPTH deep)? Unknown depth is not final. */
export function rowIsFinal(row, indexed) {
  const n = row ? confirmationsAt(row.deploy_block, indexed) : null;
  return n !== null && n >= FINAL_DEPTH;
}

/** Confirmations of the registry row's DEPLOY at `indexed`, or null. */
export function rowConfirmations(row, indexed) {
  return row ? confirmationsAt(row.deploy_block, indexed) : null;
}

/** Phases in which a reservation can only be abandoned (nothing left to publish). */
export const DEAD_END_PHASES = new Set(["taken", "closing", "expired", "invalid", "carrier-spent", "taken-after", "refused"]);

// ---- chain reorganizations under a reservation -------------------------------------------------

/**
 * Has step 1 left the block it was recorded in? True when this record
 * shows it confirmed (`commit.height`), the indexer no longer has it
 * (`commitData === null`, /commits 404) although it has applied the blocks
 * after it (`indexed ≥ height + 1`), and that was seen on `misses` ≥ 2
 * reads in a row (one read can race the indexer). The page then asks
 * about every version of step 1 again.
 */
export function commitRecheckNeeded({ commit, commitData, indexed, misses }) {
  if (!commit || !Number.isInteger(commit.height) || commitData !== null) return false;
  if (!Number.isInteger(indexed) || indexed < commit.height + 1) return false;
  return misses >= 2;
}

/**
 * Step 1 after that re-check (`verdict` = findVersion's): confirmed at
 * another height or as another version → switched there; in a mempool →
 * unconfirmed again (height null: tracking and Speed up resume); unknown to
 * the node → unconfirmed and unseen (the reserve-unseen flow); no answer →
 * unchanged. Note: `switchStepTo` keeps the old height when given none, so
 * the height is cleared here explicitly.
 */
export function commitAfterRecheck(step, verdict, now = Date.now()) {
  if (!step || !verdict) return step;
  if (verdict.kind === "confirmed") return switchStepTo(step, verdict.txid, { height: verdict.height, now });
  if (verdict.kind === "seen") return { ...switchStepTo(step, verdict.txid, { now }), height: null, unseenAt: null };
  if (verdict.kind === "none") return { ...step, height: null, unseenAt: step.unseenAt ?? now };
  return step;
}

/**
 * Has our publish left its block? It shows confirmed (`reveal.height`), the
 * indexer has applied that block, and yet reports the reservation OPEN —
 * its carrier unspent: a chain reorganization took the publish out. The
 * page clears the height so tracking (and Speed up) resume; if the publish
 * is gone from every mempool the existing release flow opens Publish again.
 */
export function revealLeftBlock({ reveal, commitData, indexed }) {
  if (!reveal || !Number.isInteger(reveal.height) || !commitData) return false;
  return commitData.status === "open" && Number.isInteger(indexed) && indexed >= reveal.height;
}

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
     * included, so two Reserve clicks can never overwrite each other's salt.
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
    /**
     * Put `rec` back as the open record of `address` (a created name whose
     * publish left its block — see the settling notes). Refuses (null)
     * while another record is open that is not a stale draft. → the stored record.
     */
    restore(address, rec) {
      const cur = read(address);
      if (cur && !isStaleDraft(cur, now())) return null;
      const next = normalizeDeployRecord(rec);
      if (!next) return null;
      write(address, next);
      return next;
    },
    /** "storage" | "memory" (after a failure, or without localStorage). */
    backend() {
      return store ? "storage" : "memory";
    },
  };
}

// ---- created, not final yet ------------------------------------------------------------------
//
// A publish the registry lists as ours is provisional until its block is
// FINAL_DEPTH deep: a chain reorganization can still take it out, or put
// another publish of the name first. The reservation record is cleared at
// once (so a new name can be reserved), but a SETTLING note keeps what is
// needed to follow it — the whole record, salt included — per address in
// localStorage ('lp.deploy.settling.<address>'), until it is final.

export const SETTLING_PREFIX = "lp.deploy.settling.";
/** Notes kept per address (the oldest go first). */
export const SETTLING_MAX = 5;
/** A note older than this is dropped whatever it says. */
export const SETTLING_TTL_MS = 24 * 60 * 60 * 1000;
const SETTLING_VERDICTS = new Set(["provisional", "changed-taken", "changed-missing"]);

/** Storage key of the settling notes of an address. */
export function settlingKey(address) {
  const a = typeof address === "string" ? address.trim().toLowerCase() : "";
  return `${SETTLING_PREFIX}${a || "*"}`;
}

/** A well-formed settling note `{ ticker, revealTxid, height, at, verdict, changes, rec }` (`changes`: reorganization changes seen), or null. */
export function normalizeSettlingNote(n) {
  if (!n || typeof n !== "object") return null;
  const rec = normalizeDeployRecord(n.rec);
  const revealTxid = String(n.revealTxid || "").toLowerCase();
  if (!rec || !rec.reveal || !TXID_RE.test(revealTxid)) return null;
  return {
    ticker: rec.ticker,
    revealTxid,
    height: int(n.height),
    at: num(n.at) ?? 0,
    verdict: SETTLING_VERDICTS.has(n.verdict) ? n.verdict : "provisional",
    changes: int(n.changes) ?? 0,
    rec,
  };
}

/**
 * Where a settling note stands, from the registry row of its ticker
 * (`row`: undefined = not read, null = no row) at `indexed`:
 * "final" (ours and FINAL_DEPTH deep — the note can go), "provisional"
 * (ours, not final yet), "changed-taken" (another publish holds the name
 * now), "changed-missing" (no row although the indexer has applied the
 * note's block and is not rebuilding: our publish is out of its block), or
 * "unknown" (not read yet, or no row because the indexer has not applied
 * that block — a restart, a cold scan or a rebuild is not a reorganization).
 * `applied` / `rebuilding` describe the indexer that answered the "no row"
 * (read after it); `applied` defaults to `indexed`.
 */
export function settlingVerdict(note, row, indexed, { applied = indexed, rebuilding = false } = {}) {
  if (!note || row === undefined) return "unknown";
  if (row === null) {
    const seen = !rebuilding && Number.isInteger(applied) && Number.isInteger(note.height) && applied >= note.height;
    return seen ? "changed-missing" : "unknown";
  }
  if (!ownPublishTxids(note.rec).has(String(row.deploy_txid || "").toLowerCase()) && row.deploy_txid !== note.revealTxid) return "changed-taken";
  return rowIsFinal(row, indexed) ? "final" : "provisional";
}

/**
 * Did a sent, unconfirmed publish miss a block? True when the chain tip is
 * above the tip it was sent at (`step.sentTip`) and it has no height yet:
 * its ticker is visible in the mempool, and every block it waits gives
 * someone else time to reserve the name and publish first (their COMMIT
 * needs a block of its own). False while anything is unknown.
 */
export function publishMissedBlock(step, tip) {
  if (!step || !step.sentAt || Number.isInteger(step.height) || step.unseenAt) return false;
  return Number.isInteger(step.sentTip) && Number.isInteger(tip) && tip > step.sentTip;
}

/** Settling notes over any { getItem, setItem, removeItem } storage (localStorage in the browser). */
export function createSettlingStore({ storage, now = () => Date.now() } = {}) {
  let store = storage === undefined ? browserStorage() : storage;
  const fallback = memoryStorage();
  const backend = () => store || fallback;
  const read = (address) => {
    let raw = null;
    try {
      raw = backend().getItem(settlingKey(address));
    } catch {
      store = null;
      raw = fallback.getItem(settlingKey(address));
    }
    let list = [];
    try {
      list = raw ? JSON.parse(raw) : [];
    } catch {
      list = [];
    }
    const t = now();
    return (Array.isArray(list) ? list : []).map(normalizeSettlingNote).filter((n) => n && t - n.at <= SETTLING_TTL_MS);
  };
  const write = (address, list) => {
    const key = settlingKey(address);
    try {
      if (list.length) backend().setItem(key, JSON.stringify(list));
      else backend().removeItem(key);
    } catch {
      store = null;
      if (list.length) fallback.setItem(key, JSON.stringify(list));
      else fallback.removeItem(key);
    }
  };
  return {
    list: (address) => read(address),
    /** Add (or replace) the note of `rec`'s publish. */
    add(address, { rec, height = null }) {
      const n = normalizeSettlingNote({ rec, revealTxid: rec?.reveal?.txid, height, at: now(), verdict: "provisional" });
      if (!n) return read(address);
      const list = [...read(address).filter((x) => x.revealTxid !== n.revealTxid), n].slice(-SETTLING_MAX);
      write(address, list);
      return list;
    },
    /** Apply `fn(note) → note` to the note of `revealTxid`. */
    update(address, revealTxid, fn) {
      const t = String(revealTxid || "").toLowerCase();
      const list = read(address).map((n) => (n.revealTxid === t ? normalizeSettlingNote(fn(n)) || n : n));
      write(address, list);
      return list;
    },
    remove(address, revealTxid) {
      const t = String(revealTxid || "").toLowerCase();
      const list = read(address).filter((n) => n.revealTxid !== t);
      write(address, list);
      return list;
    },
  };
}

const SETTLING_STORE = createSettlingStore();
export const settlingNotes = (address) => SETTLING_STORE.list(address);
export const addSettlingNote = (address, note) => SETTLING_STORE.add(address, note);
export const updateSettlingNote = (address, revealTxid, fn) => SETTLING_STORE.update(address, revealTxid, fn);
export const removeSettlingNote = (address, revealTxid) => SETTLING_STORE.remove(address, revealTxid);

const DEFAULT_STORE = createDeployRecordStore();

export const loadDeployRecord = (address) => DEFAULT_STORE.load(address);
export const startDeployRecord = (address, init) => DEFAULT_STORE.start(address, init);
export const updateDeployRecord = (address, fn) => DEFAULT_STORE.update(address, fn);
export const claimDeployRecord = (address, pred, fn) => DEFAULT_STORE.claim(address, pred, fn);
export const clearDeployRecord = (address) => DEFAULT_STORE.clear(address);
export const restoreDeployRecord = (address, rec) => DEFAULT_STORE.restore(address, rec);
export const deployRecordBackend = () => DEFAULT_STORE.backend();
