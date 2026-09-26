// DEPLOY // LOG line model — the create page's terminal grammar. Pure, no
// React, unit-tested in plain Node (test/deploylog.test.js).
//
// Same contract as minerlog.js: every line is a REAL event the create page
// observed, keys are deterministic per event (StrictMode double effects and
// re-renders are idempotent), and the shared lines (wallet, fee quote, tip,
// sign, broadcasting, accepted, block found, error) are the minerlog.js
// formatters re-exported as-is. A deploy has no digit reveal and no yield:
// its settlement is the ticker registration, and only the indexer can say
// whether this DEPLOY was the first to confirm — so the "✓ yours" banner
// waits for that verdict instead of being printed on raw confirmation.

import { fmtInt, shortAddr, shortTxid } from "./format.js";
import { DEPLOY_PROTOCOL_FEE_SATS } from "./payloads.js";

export { walletLine, feeQuoteLine, tipLine, signLine, broadcastingLine, acceptedLine, blockFoundLine, errorLine } from "./minerlog.js";

/** LED labels for the two deploy paths. */
export const PLAIN_PHASES = ["Build", "Sign", "Broadcast", "Confirm"];
export const AVATAR_PHASES = ["Commit", "Sign", "Broadcast", "Confirm"];

/** Phases of the plain DEPLOY flow during which the page is working. */
export const PLAIN_BUSY = new Set(["building", "signing", "broadcasting", "pending"]);
/** Phases of the avatar flow (useDeployAvatar) during which the page is working. */
export const AVATAR_BUSY = new Set([
  "compressing",
  "securing",
  "commit-building",
  "commit-signing",
  "commit-broadcast",
  "reveal-building",
  "reveal-signing",
  "reveal-broadcast",
  "pending",
  "reclaim-pending",
]);

const line = ({ key, kind, text, tier = null, yours = false, ts = Date.now(), ...rest }) => ({
  key,
  ts,
  kind,
  text,
  tier,
  yours,
  ...rest,
});

const secondBucket = (ms) => Math.floor(Number(ms) / 1000);
const short = (txid) => shortTxid(txid, 5, 3);

/** `  inputs 2  vsize 214 vB  fee 321 sats @ 1.5 sat/vB` from whatever the builder reported (each part omitted when unknown). */
function txDetail({ inputCount, vsize, feeSats, feeRateSatVb } = {}) {
  const inputs = inputCount != null ? `  inputs ${fmtInt(inputCount)}` : "";
  const size = vsize != null ? `  vsize ${fmtInt(vsize)} vB` : "";
  const fee = feeSats != null ? `  fee ${fmtInt(feeSats)} sats${feeRateSatVb ? ` @ ${feeRateSatVb} sat/vB` : ""}` : "";
  return `${inputs}${size}${fee}`;
}

// ---- plain DEPLOY -------------------------------------------------------------------------------

/** `build DEPLOY LUCKY  protocol fee 5,460 sats  inputs 2  vsize 214 vB  fee 321 sats @ 1.5 sat/vB` */
export function deployBuildLine(flow, ticker, at = Date.now()) {
  return line({
    key: `dphase:build:${flow.startedAt ?? flow.txid ?? secondBucket(at)}`,
    kind: "act",
    text: `build DEPLOY ${ticker}  protocol fee ${fmtInt(DEPLOY_PROTOCOL_FEE_SATS)} sats${txDetail(flow)}`,
    ts: at,
  });
}

/** `mempool  DEPLOY LUCKY awaiting block #969,802` */
export function deployMempoolLine(ticker, nextHeight, txid, at = Date.now()) {
  const h = Number.isInteger(nextHeight) ? ` #${fmtInt(nextHeight)}` : "";
  return line({ key: `dmempool:${txid ?? nextHeight}`, kind: "act", text: `mempool  DEPLOY ${ticker} awaiting block${h}`, ts: at });
}

/** `awaiting block #969,802  ·  4:16 since last block` — one per minute while pending (no digit count: a deploy has no digit). */
export function deployHeartbeatLine(nextHeight, sinceMs, at = Date.now()) {
  let since = "";
  if (Number.isFinite(sinceMs)) {
    const s = Math.max(0, Math.floor(sinceMs / 1000));
    since = `  ·  ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} since last block`;
  }
  const h = Number.isInteger(nextHeight) ? ` #${fmtInt(nextHeight)}` : "";
  return line({ key: `hb:${nextHeight}:${Math.floor(Number(at) / 60_000)}`, kind: "sys", text: `awaiting block${h}${since}`, ts: at });
}

/** `DEPLOY LUCKY confirmed  block 969,802  ·  awaiting the indexer's verdict` — tx-status says confirmed; registration is still the indexer's call. */
export function deployConfirmedLine(ticker, height, txid, at = Date.now()) {
  return line({
    key: `dconfirmed:${txid ?? height}`,
    kind: "ok",
    text: `DEPLOY ${ticker} confirmed  block ${fmtInt(height)}  ·  awaiting the indexer's verdict`,
    ts: at,
  });
}

/** Banner: `LUCKY deployed  block 969,802  ✓ yours` (kind ok, no tier — styled by .ln.yours.ln-ok). */
export function deployedLine(ticker, height, txid, at = Date.now()) {
  return line({ key: `deployed:${txid ?? height}`, kind: "ok", yours: true, text: `${ticker} deployed  block ${fmtInt(height)}  ✓ yours`, ts: at });
}

/**
 * What the indexer's /tokens/:ticker row says about a confirmed deploy:
 * "registered" (the row's deploy_txid is ours), "taken" (a row exists for
 * another deploy), "unindexed" (no row yet).
 */
export function registrationVerdict(row, txid) {
  if (!row) return "unindexed";
  return typeof row.deploy_txid === "string" && typeof txid === "string" && row.deploy_txid.toLowerCase() === txid.toLowerCase() ? "registered" : "taken";
}

/**
 * The indexer's verdict line:
 *   registered → `indexer: LUCKY registered · first deploy claims the name` [sys] (+ avatar applied / not applied)
 *   taken      → `indexer: LUCKY was already taken (this deploy is ignored)` [err]
 *   unindexed  → `indexer has not indexed this deploy yet` [sys]
 */
export function registrationLine(ticker, verdict, txid, { avatarApplied = null, at = Date.now() } = {}) {
  const key = `registered:${txid ?? ticker}:${verdict}`;
  if (verdict === "registered") {
    const avatar = avatarApplied === true ? "  ·  avatar applied" : avatarApplied === false ? "  ·  avatar not applied (replace it from Portfolio)" : "";
    return line({ key, kind: "sys", text: `indexer: ${ticker} registered · first deploy claims the name${avatar}`, ts: at });
  }
  if (verdict === "taken") return line({ key, kind: "err", text: `indexer: ${ticker} was already taken (this deploy is ignored)`, ts: at });
  return line({ key, kind: "sys", text: "indexer has not indexed this deploy yet", ts: at });
}

/** `deploy no longer tracked on this page  tx a3f9c…21e  ·  see Portfolio` (avatar path: `· saved — resume it from this page`). */
export function deployUntrackedLine(txid, { saved = false, at = Date.now() } = {}) {
  const tail = saved ? "saved — resume it from this page" : "see Portfolio";
  return line({ key: `untracked:${txid}`, kind: "sys", text: `deploy no longer tracked on this page  tx ${short(txid)}  ·  ${tail}`, ts: at });
}

// ---- DEPLOY with avatar (useDeployAvatar) --------------------------------------------------------------

/** `avatar  128×128 webp  3,412 bytes` — after compressAvatar (width / height / contentType / bytes from the preview). */
export function avatarLine(preview, at = Date.now()) {
  if (!preview) return null;
  const type = String(preview.contentType || "").replace(/^image\//, "") || "image";
  const w = preview.width ?? 0;
  const h = preview.height ?? 0;
  const bytes = preview.sizeBytes ?? preview.bytes?.length ?? null;
  const dims = w && h ? `${w}×${h} ` : "";
  return line({ key: `avatar:image:${type}:${w}x${h}:${bytes ?? 0}`, kind: "act", text: `avatar  ${dims}${type}  ${fmtInt(bytes)} bytes`, ts: at });
}

/** `securing  recovery record · approve the message in UniSat…` (simulated wallet: no encryption). */
export function securingLine(providerName, startedAt, { signed = true, at = Date.now() } = {}) {
  const how = signed ? `approve the message in ${providerName || "your wallet"}…` : "simulated wallet, stored unencrypted";
  return line({ key: `avatar:securing:${startedAt ?? secondBucket(at)}`, kind: "act", text: `securing  recovery record · ${how}`, ts: at });
}

/** `recovery record secured (wallet signature)` / `recovery record saved (simulated wallet: unencrypted)`. */
export function securedLine(createdAt, { signed = true, at = Date.now() } = {}) {
  return line({
    key: `avatar:secured:${createdAt ?? secondBucket(at)}`,
    kind: "act",
    text: signed ? "recovery record secured (wallet signature)" : "recovery record saved (simulated wallet: unencrypted)",
    ts: at,
  });
}

/** `commit  paying 12,345 sats to bc1p…abc (commit output)  inputs 2  vsize 154 vB  fee 231 sats @ 1.5 sat/vB` — when the commit payment PSBT goes to the wallet. */
export function commitLine(record, detail = {}, at = Date.now()) {
  if (!record) return null;
  return line({
    key: `avatar:commit:${record.createdAt ?? record.commitAddress}`,
    kind: "act",
    text: `commit  paying ${fmtInt(record.commitAmount)} sats to ${shortAddr(record.commitAddress, 4, 3)} (commit output)${txDetail(detail)}`,
    ts: at,
  });
}

/** `commit accepted by node  txid a3f9c…21e` */
export function commitAcceptedLine(txid, at = Date.now()) {
  return line({ key: `avatar:commit-accepted:${txid}`, kind: "ok", text: `commit accepted by node  txid ${short(txid)}`, ts: at });
}

/** `reveal  building DEPLOY LUCKY + avatar  input0 script path  inputs 1  vsize 412 vB  fee 618 sats @ 1.5 sat/vB` */
export function revealBuildLine(ticker, record, detail = {}, at = Date.now()) {
  return line({
    key: `avatar:reveal:${record?.createdAt ?? secondBucket(at)}`,
    kind: "act",
    text: `reveal  building DEPLOY ${ticker} + avatar  input0 script path${txDetail(detail)}`,
    ts: at,
  });
}

/** `pending  checking DEPLOY LUCKY  tx a3f9c…21e every 15 s` — a saved, already-signed reveal resumed: the poll decides (it may never have been relayed). */
export function pendingLine(ticker, txid, at = Date.now()) {
  if (!txid) return null;
  return line({ key: `dpending:${txid}`, kind: "act", text: `pending  checking DEPLOY ${ticker}  tx ${short(txid)} every 15 s`, ts: at });
}

/** `node has not seen tx a3f9c…21e  ·  use "Retry saved transaction"` — /tx-status says seen: false for the saved reveal. */
export function unseenLine(txid, at = Date.now()) {
  if (!txid) return null;
  return line({ key: `unseen:${txid}`, kind: "err", text: `node has not seen tx ${short(txid)}  ·  use "Retry saved transaction"`, ts: at });
}

/** `resume  saved creation found  commit txid …  reveal txid …  refund txid …` (only the txids the record holds). */
export function resumeLine(record, at = Date.now()) {
  if (!record) return null;
  const parts = [
    ["commit", record.commitTxid],
    ["reveal", record.revealTxid],
    ["refund", record.reclaimTxid],
  ]
    .filter(([, txid]) => txid)
    .map(([label, txid]) => `  ${label} txid ${short(txid)}`)
    .join("");
  return line({ key: `avatar:resume:${record.createdAt ?? record.commitAddress}`, kind: "sys", text: `resume  saved creation found${parts}`, ts: at });
}

/** A saved creation this page cannot open: `locked` (needs the original wallet) or `invalid-record` (unreadable, keep the browser data). */
export function savedRecordLine(ticker, state, at = Date.now()) {
  if (state === "locked") {
    return line({ key: `avatar:locked:${ticker}`, kind: "sys", text: `saved creation found for ${ticker}  ·  locked: unlock it with the wallet that started it`, ts: at });
  }
  if (state === "invalid-record") {
    return line({ key: `avatar:invalid-record:${ticker}`, kind: "err", text: `recovery record for ${ticker} cannot be read  ·  keep this browser's data, a paid avatar may depend on it`, ts: at });
  }
  return null;
}

/** `reclaim  sweeping the commit output back to bc1p…abc` — the sweep was relayed. */
export function reclaimLine(record, address, at = Date.now()) {
  if (!record) return null;
  return line({
    key: `avatar:reclaim:${record.reclaimTxid ?? record.createdAt}`,
    kind: "act",
    text: `reclaim  sweeping the commit output back to ${shortAddr(address || record.address, 4, 3)}`,
    ts: at,
  });
}

/** `refund confirmed  block 969,803  ·  commit output back at bc1p…abc` */
export function reclaimedLine(record, address, height, at = Date.now()) {
  if (!record) return null;
  const block = Number.isInteger(height) ? `  block ${fmtInt(height)}` : "";
  return line({
    key: `avatar:reclaimed:${record.reclaimTxid ?? record.createdAt}`,
    kind: "ok",
    text: `refund confirmed${block}  ·  commit output back at ${shortAddr(address || record.address, 4, 3)}`,
    ts: at,
  });
}

// ---- LEDs ----------------------------------------------------------------------------------------

const IDLE4 = Object.freeze(["idle", "idle", "idle", "idle"]);
const fillLeds = (lit, state) => Array.from({ length: 4 }, (_, i) => (i < lit ? state : "idle"));

/**
 * Commit / Sign / Broadcast / Confirm for the avatar flow → { lit, states, busy }.
 * Commit is done once the node accepted the commit payment, Sign once the
 * reveal is signed, Broadcast once the reveal was relayed, Confirm once the
 * indexer settled the outcome. A saved record lights what it already holds
 * (a signed commit → 1, a signed reveal → 2: whether it was relayed is not
 * known until the poll says so).
 */
export function avatarLeds(flow) {
  const phase = flow?.phase;
  const rec = flow?.record || null;
  const progress = rec?.revealRawHex ? 2 : rec?.commitRawHex ? 1 : 0;
  switch (phase) {
    case "compressing":
    case "securing":
      return { lit: 0, states: IDLE4, busy: true };
    case "commit-building":
    case "commit-signing":
    case "commit-broadcast":
      return { lit: 1, states: ["busy", "idle", "idle", "idle"], busy: true };
    case "reveal-building":
    case "reveal-signing":
      return { lit: 2, states: ["ok", "busy", "idle", "idle"], busy: true };
    case "reveal-broadcast":
      return { lit: 3, states: ["ok", "ok", "busy", "idle"], busy: true };
    case "pending":
      return { lit: 4, states: ["ok", "ok", "ok", "busy"], busy: true };
    case "confirmed":
      return { lit: 4, states: ["ok", "ok", "ok", "ok"], busy: false };
    case "name-taken":
      return { lit: 4, states: ["ok", "ok", "ok", "err"], busy: false };
    case "reclaim-pending":
      return { lit: 1, states: ["ok", "idle", "idle", "busy"], busy: true };
    case "reclaimed":
      return { lit: 1, states: ["ok", "idle", "idle", "ok"], busy: false };
    case "resumable":
      return { lit: progress, states: fillLeds(progress, "ok"), busy: false };
    case "error": {
      const lit = Math.max(1, progress);
      return { lit, states: fillLeds(lit, "err"), busy: false };
    }
    default:
      return { lit: 0, states: IDLE4, busy: false };
  }
}
