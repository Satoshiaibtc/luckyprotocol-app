// The Create page's DEPLOY (spec §2.1) — the pure parts: which txids are
// the user's DEPLOY, what the registry row says about it, when a pending
// DEPLOY missed a block or left every mempool, how much room its change
// leaves for a Speed up, and the settling notes that follow a result until
// its block is final. No React; unit-tested in test/createflow.test.js. The
// React side is src/hooks/useCreate.js.
//
// A DEPLOY is one transaction. While it waits for a block, its ticker is
// visible in the mempool and another DEPLOY of the same ticker that pays
// more can confirm first; the page therefore offers a Speed up (the same
// transaction with a higher fee, a new txid). Every version it had is the
// same DEPLOY: a miner may confirm any of them, so the page judges the
// DEPLOY by all its versions together, never by one.

import { rawTxSummary, speedUpCeilingRate } from "./psbt.js";
import { DROP_GRACE_MS } from "./txrecords.js";
import { FINAL_DEPTH, confirmationsAt } from "./finality.js";

const TXID_RE = /^[0-9a-f]{64}$/;
const TICKER_RE = /^[A-Z0-9]{1,8}$/;

const lowerTxid = (t) => (typeof t === "string" ? t.trim().toLowerCase() : "");

/** The txid of a signed raw transaction (hex). */
export const txidOfRaw = (raw) => rawTxSummary(raw).txid;

/**
 * Every txid of a DEPLOY: `rec.txid` (the newest version), then
 * `rec.versions` / `rec.replaces` (the versions it replaced) — lower-cased,
 * well-formed and without repeats.
 */
export function deployVersions(rec) {
  if (!rec || typeof rec !== "object") return [];
  const more = Array.isArray(rec.versions) ? rec.versions : Array.isArray(rec.replaces) ? rec.replaces : [];
  const out = [];
  for (const t of [rec.txid, ...more]) {
    const x = lowerTxid(t);
    if (TXID_RE.test(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * What the /tx-status answers for a DEPLOY's versions say (`results` =
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
  return list.length && !list.some((r) => !r.status) ? { kind: "none" } : { kind: "unknown" };
}

/**
 * Does the version poll follow `seenTxid`, the version the node reports as
 * seen, when the page tracks `trackedTxid`? Yes when it is the tracked one,
 * or when the tracked one has been unseen for DROP_GRACE_MS
 * (`trackedDropped`). Right after a Speed up the node still holds the
 * replaced version until the new one reaches it, so the page keeps the new
 * one until then.
 */
export function followSeenVersion(seenTxid, trackedTxid, trackedDropped) {
  return seenTxid === trackedTxid || trackedDropped === true;
}

/**
 * Take the reviewed DEPLOY out of `ref` for signing: `ref.current` while
 * `flow` is still that review, else null. The ref is emptied at once, so a
 * second click on Sign (a double click) finds nothing to sign.
 */
export function claimReview(ref, flow) {
  const ctx = ref?.current;
  if (!ctx || flow?.phase !== "review" || flow.startedAt !== ctx.startedAt) return null;
  ref.current = null;
  return ctx;
}

/**
 * The registry's verdict on a DEPLOY with `versions` sent from `address`,
 * from the /tokens/:ticker row:
 *   "registered"      the row's deploy_txid is one of the versions
 *   "registered-own"  another txid, but its deployer is the connected address
 *                     (the wallet's own speed-up, another tab or device)
 *   "taken"           another DEPLOY holds the ticker
 *   "unindexed"       no row
 */
export function deployVerdict(row, versions, address) {
  if (!row) return "unindexed";
  const txid = lowerTxid(row.deploy_txid);
  if (txid && (versions || []).map(lowerTxid).includes(txid)) return "registered";
  if (typeof address === "string" && address && typeof row.deployer === "string" && row.deployer === address) return "registered-own";
  return "taken";
}

/** Why an own earlier DEPLOY (`{ txid, state }`, src/hooks/useCreate.js ownDeployFor) holds back another one. */
export function ownDeployText(ticker, own) {
  const tx = `tx ${String(own.txid).slice(0, 12)}…`;
  if (own.state === "confirmed") return `Your DEPLOY of ${ticker} (${tx}) has confirmed — waiting for the indexer to list it.`;
  if (own.state === "unknown") return `Your earlier DEPLOY of ${ticker} (${tx}) could not be checked right now — creating again could pay the fees twice, so it stays paused until it can be checked.`;
  return `You already have a pending DEPLOY of ${ticker} (${tx}). It claims the name if it confirms first — creating again would pay the fees twice.`;
}

/** Is `verdict` one of the two verdicts that make the ticker the user's? */
export const isOwnVerdict = (verdict) => verdict === "registered" || verdict === "registered-own";

/**
 * Did another DEPLOY register the ticker while this one waits (the taken-while-pending notice)?
 * Only a row that is not the user's own: a row of the user's deployer is a
 * registration, never "taken".
 */
export function takenWhilePending({ row, versions, address }) {
  return deployVerdict(row, versions, address) === "taken";
}

/**
 * Has the DEPLOY left every mempool (released)? Only when EVERY version is
 * unknown to the node (`resolveVersions(results).kind === "none"`), that
 * answer can be trusted (`trustUnseen`), and it has held for longer than
 * DROP_GRACE_MS since `unseenSince` (when the version poll first answered
 * "none" for all of them). A single version's drop never releases it:
 * after a Speed up the replaced version always leaves the mempool.
 */
export function deployReleased(results, { unseenSince, now = Date.now(), trustUnseen = true } = {}) {
  if (!trustUnseen || !Number.isFinite(unseenSince)) return false;
  if (resolveVersions(results).kind !== "none") return false;
  return now - unseenSince > DROP_GRACE_MS;
}

/**
 * Did a sent, unconfirmed DEPLOY miss a block? True when the chain tip is
 * above the tip it was sent at (`sentTip`), it has no height yet and it is
 * not unseen (that is said otherwise). False while anything is unknown.
 */
export function deployMissedBlock({ sentTip, height, unseen } = {}, tip) {
  if (Number.isInteger(height) || unseen) return false;
  return Number.isInteger(sentTip) && Number.isInteger(tip) && tip > sentTip;
}

/** Confirmations of the registry row's DEPLOY at `indexed`, or null. */
export function rowConfirmations(row, indexed) {
  return row ? confirmationsAt(row.deploy_block, indexed) : null;
}

/** Is the registry row's DEPLOY final at `indexed` (its block FINAL_DEPTH deep)? Unknown depth is not final. */
export function rowIsFinal(row, indexed) {
  const n = rowConfirmations(row, indexed);
  return n !== null && n >= FINAL_DEPTH;
}

/** Per-LED state of the Deploy log's Sign · Broadcast · Confirm · Registered (`flow` = useCreate's). */
export function deployLeds(flow) {
  switch (flow?.phase) {
    case "building":
    case "review":
    case "signing":
      return ["busy", "idle", "idle", "idle"];
    case "broadcasting":
      return ["ok", "busy", "idle", "idle"];
    case "pending":
      return ["ok", flow.unsent ? "busy" : "ok", "busy", flow.takenRow ? "err" : "idle"];
    case "confirmed":
      return ["ok", "ok", "ok", "busy"];
    case "done":
      if (isOwnVerdict(flow.verdict)) return ["ok", "ok", "ok", "ok"];
      if (flow.verdict === "taken") return ["ok", "ok", "ok", "err"];
      return ["ok", "ok", "ok", "busy"];
    case "released":
      return ["ok", "ok", "err", "idle"];
    case "error":
      if (flow.errorAt === "broadcasting") return ["ok", "err", "idle", "idle"];
      return ["err", "idle", "idle", "idle"];
    default:
      return ["idle", "idle", "idle", "idle"];
  }
}

// ---- Speed up headroom ------------------------------------------------------------------------------

/** A DEPLOY whose change cannot pay at least this multiple of its own rate is signed only after an acknowledgement. */
export const SPEEDUP_HEADROOM_MULTIPLE = 3;

/**
 * How far a built DEPLOY (`buildDeployPsbt`'s result) can be sped up from
 * its change, at the rate `rate` it was built with:
 *   null                                 room for at least 3 × `rate`
 *   { kind: "no-change" }                no change output: no Speed up at all
 *   { kind: "low", ceiling, changeSats } the highest rate a Speed up can pay
 */
export function deployHeadroom(built, rate) {
  if (!built) return null;
  if (built.changeOmitted || built.changeVout === null || built.changeVout === undefined) return { kind: "no-change" };
  let ceiling = 0;
  try {
    ceiling = speedUpCeilingRate(built.psbtHex, built.changeVout);
  } catch {
    ceiling = 0;
  }
  if (ceiling >= SPEEDUP_HEADROOM_MULTIPLE * Number(rate)) return null;
  return { kind: "low", ceiling, changeSats: Number(built.changeSats) || 0 };
}

/** The sentence the Create page shows for a `deployHeadroom` answer (null → null). */
export function headroomText(headroom, ticker) {
  if (!headroom) return null;
  if (headroom.kind === "no-change") {
    return "This DEPLOY has no change output, so it cannot be sped up later. To keep that option, add funds or pick a lower fee.";
  }
  return (
    `This DEPLOY can be sped up to at most ${headroom.ceiling} sat/vB, because its change is only ${Number(headroom.changeSats).toLocaleString("en-US")} sats. ` +
    `If another DEPLOY of ${ticker} pays more, you may not be able to outbid it. To keep more room, add a larger UTXO to your wallet first.`
  );
}

// ---- settling notes ---------------------------------------------------------------------------------
//
// A DEPLOY result is provisional until its block is FINAL_DEPTH deep: a
// chain reorganization can still take it out, or put another DEPLOY of the
// ticker first. A settling note keeps what is needed to follow it — the
// ticker and every version's txid — per address in localStorage
// ('lp.create.settling.<address>'), until it is final. A DEPLOY that left
// every mempool (released) keeps a note too: one of its versions may still
// confirm, and then it is the user's.

export const SETTLING_PREFIX = "lp.create.settling.";
/** Notes kept per address (the oldest go first). */
export const SETTLING_MAX = 5;
/** A note older than this is dropped whatever it says. */
export const SETTLING_TTL_MS = 24 * 60 * 60 * 1000;
/** How a note started: the DEPLOY registered the ticker, another DEPLOY holds it, or it left every mempool. */
const ORIGINS = new Set(["registered", "taken", "released"]);
const VERDICTS = new Set(["provisional", "changed-taken", "changed-missing", "released"]);

/** Storage key of the settling notes of an address (lower-cased; no address shares "*"). */
export function settlingKey(address) {
  const a = typeof address === "string" ? address.trim().toLowerCase() : "";
  return `${SETTLING_PREFIX}${a || "*"}`;
}

const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

/**
 * A well-formed settling note, or null:
 *   { ticker, txid, versions, height, at, verdict, changes, origin, otherTxid }
 * `txid` is the version the note is about (the registered one, or the
 * newest); `versions` every txid of the DEPLOY; `height` the block the
 * result was read in (null for a released DEPLOY); `changes` how many
 * changes a chain reorganization made; `otherTxid` the other DEPLOY that
 * holds the ticker, when one does.
 */
export function normalizeSettlingNote(n) {
  if (!n || typeof n !== "object") return null;
  const ticker = String(n.ticker || "");
  const txid = lowerTxid(n.txid);
  if (!TICKER_RE.test(ticker) || !TXID_RE.test(txid)) return null;
  const versions = deployVersions({ txid, versions: n.versions });
  const origin = ORIGINS.has(n.origin) ? n.origin : "registered";
  const other = lowerTxid(n.otherTxid);
  return {
    ticker,
    txid,
    versions,
    height: int(n.height),
    at: num(n.at) ?? 0,
    verdict: VERDICTS.has(n.verdict) ? n.verdict : origin === "released" ? "released" : origin === "taken" ? "changed-taken" : "provisional",
    changes: int(n.changes) ?? 0,
    origin,
    otherTxid: TXID_RE.test(other) ? other : null,
  };
}

/**
 * Where a settling note stands, from the registry row of its ticker
 * (`row`: undefined = not read, null = no row) at `indexed`:
 *   "final"           ours and FINAL_DEPTH deep — the note can go
 *   "final-taken"     another DEPLOY's, FINAL_DEPTH deep — the note can go
 *   "provisional"     ours, not final yet (a row of one of the note's
 *                     versions, or one whose deployer is `address`)
 *   "changed-taken"   another DEPLOY holds the ticker, not final yet
 *   "changed-missing" no row although the indexer has applied the note's
 *                     block and is not rebuilding: the DEPLOY is out of it
 *   "unknown"         not read yet; no row because the indexer has not
 *                     applied that block (a restart, a cold scan or a
 *                     rebuild is not a reorganization); or a released
 *                     DEPLOY with no row — it stays until its TTL
 * `applied` / `rebuilding` describe the indexer that answered "no row"
 * (read after it); `applied` defaults to `indexed`.
 */
export function settlingVerdict(note, row, indexed, { applied = indexed, rebuilding = false, address = null } = {}) {
  if (!note || row === undefined) return "unknown";
  if (row === null) {
    if (note.origin === "released" || note.verdict === "released") return "unknown";
    const seen = !rebuilding && Number.isInteger(applied) && Number.isInteger(note.height) && applied >= note.height;
    return seen && note.origin === "registered" ? "changed-missing" : "unknown";
  }
  const ours = deployVerdict(row, note.versions, address);
  if (ours === "taken") return rowIsFinal(row, indexed) ? "final-taken" : "changed-taken";
  return rowIsFinal(row, indexed) ? "final" : "provisional";
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
    const probe = `${SETTLING_PREFIX}__probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/** Settling notes over any { getItem, setItem, removeItem } storage (localStorage in the browser, a fake in tests). */
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
    /**
     * Add (or replace) the note of a DEPLOY `{ ticker, txid, versions, height, origin, otherTxid }`.
     * A note of the same DEPLOY (any shared version) is replaced.
     */
    add(address, note) {
      const n = normalizeSettlingNote({ ...note, at: now(), changes: 0, verdict: undefined });
      if (!n) return read(address);
      const list = [...read(address).filter((x) => !x.versions.some((t) => n.versions.includes(t))), n].slice(-SETTLING_MAX);
      write(address, list);
      return list;
    },
    /** Apply `fn(note) → note` to the note of `txid`. */
    update(address, txid, fn) {
      const t = lowerTxid(txid);
      const list = read(address).map((n) => (n.txid === t ? normalizeSettlingNote({ ...fn(n), at: n.at }) || n : n));
      write(address, list);
      return list;
    },
    remove(address, txid) {
      const t = lowerTxid(txid);
      const list = read(address).filter((n) => n.txid !== t);
      write(address, list);
      return list;
    },
  };
}

const SETTLING_STORE = createSettlingStore();
export const settlingNotes = (address) => SETTLING_STORE.list(address);
export const addSettlingNote = (address, note) => SETTLING_STORE.add(address, note);
export const updateSettlingNote = (address, txid, fn) => SETTLING_STORE.update(address, txid, fn);
export const removeSettlingNote = (address, txid) => SETTLING_STORE.remove(address, txid);

/**
 * Removes `lp.deploy.<address>` and `lp.deploy.settling.<address>` (the
 * address lower-cased, and `*`), keys this app never reads. Never throws.
 */
export function clearUnusedDeployKeys(storage, address) {
  let s = storage;
  if (s === undefined) {
    try {
      s = typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      s = null;
    }
  }
  if (!s || typeof s.removeItem !== "function") return;
  const a = typeof address === "string" ? address.trim().toLowerCase() : "";
  const ids = [...new Set([a, "*"].filter(Boolean))];
  for (const id of ids) {
    for (const key of [`lp.deploy.${id}`, `lp.deploy.settling.${id}`]) {
      try {
        s.removeItem(key);
      } catch {
        /* a storage that refuses is left as it is */
      }
    }
  }
}
