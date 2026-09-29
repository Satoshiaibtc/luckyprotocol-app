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
//
// A deploy is one transaction (§2.1) whose OP_RETURN names the ticker.
// While it waits for a block it can be sped up (a replacement with a
// higher fee); every version it had is the same DEPLOY.

import { fmtInt, shortTxid } from "./format.js";
import { DEPLOY_PROTOCOL_FEE_SATS } from "./payloads.js";
import { FINAL_DEPTH } from "./finality.js";
import { formatTime } from "./minerlog.js";

export { walletLine, feeQuoteLine, tipLine, signLine, broadcastingLine, acceptedLine, blockFoundLine, errorLine } from "./minerlog.js";

/** LED labels of a deploy: the signature, the broadcast, the confirming block, the registry's verdict. */
export const DEPLOY_PHASES = ["Sign", "Broadcast", "Confirm", "Registered"];

/** Phases of the Create flow during which the page is working on a click (build → sign → broadcast). */
export const DEPLOY_BUSY = new Set(["building", "signing", "broadcasting"]);

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

/** `mempool  DEPLOY LUCKY awaiting block #970,102` */
export function deployMempoolLine(ticker, nextHeight, txid, at = Date.now()) {
  const h = Number.isInteger(nextHeight) ? ` #${fmtInt(nextHeight)}` : "";
  return line({ key: `dmempool:${txid ?? nextHeight}`, kind: "act", text: `mempool  DEPLOY ${ticker} awaiting block${h}`, ts: at });
}

/** `awaiting block #970,102  ·  4:16 since last block` — one per minute while pending (no digit count: a deploy has no digit). */
export function deployHeartbeatLine(nextHeight, sinceMs, at = Date.now()) {
  let since = "";
  if (Number.isFinite(sinceMs)) {
    const s = Math.max(0, Math.floor(sinceMs / 1000));
    since = `  ·  ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} since last block`;
  }
  const h = Number.isInteger(nextHeight) ? ` #${fmtInt(nextHeight)}` : "";
  return line({ key: `hb:${nextHeight}:${Math.floor(Number(at) / 60_000)}`, kind: "sys", text: `awaiting block${h}${since}`, ts: at });
}

/**
 * `DEPLOY LUCKY confirmed  block 970,102  ·  awaiting the indexer's verdict` — tx-status says confirmed; registration is still the indexer's call.
 * Keyed by block height too: after a chain reorganization took it out of its block, its confirmation in a new one is logged again.
 */
export function deployConfirmedLine(ticker, height, txid, at = Date.now()) {
  return line({
    key: `dconfirmed:${txid ?? ""}:${height}`,
    kind: "ok",
    text: `DEPLOY ${ticker} confirmed  block ${fmtInt(height)}  ·  awaiting the indexer's verdict`,
    ts: at,
  });
}

/**
 * Banner: `LUCKY deployed  block 970,102  ✓ yours` (kind ok, no tier — styled
 * by .ln.yours.ln-ok); `provisional` adds that it is final only after
 * FINAL_DEPTH confirmations.
 */
export function deployedLine(ticker, height, txid, at = Date.now(), { provisional = false } = {}) {
  const note = provisional ? `  ·  provisional until ${FINAL_DEPTH} confirmations` : "";
  return line({ key: `deployed:${txid ?? height}`, kind: "ok", yours: true, text: `${ticker} deployed  block ${fmtInt(height)}  ✓ yours${note}`, ts: at });
}

/** `LUCKY final  block 970,102  6 confirmations  ·  the name is yours` — a created name whose block is final. */
export function createdFinalLine(ticker, height, txid, at = Date.now()) {
  const block = Number.isInteger(height) ? `  block ${fmtInt(height)}` : "";
  return line({ key: `cr:final:${txid ?? ticker}`, kind: "ok", text: `${ticker} final${block}  ${FINAL_DEPTH} confirmations  ·  the name is yours`, ts: at });
}

/**
 * A chain reorganization changed a created name that was not final yet
 * (settlingVerdict): another DEPLOY holds it now, or ours left its block —
 * or it is ours again. One line per change: `change` (the note's count of
 * changes) keeps a second flip to the same verdict from reading as a repeat.
 */
export function createdReorgLine(ticker, verdict, txid, otherTxid = null, at = Date.now(), { change = 0 } = {}) {
  const key = `cr:reorg:${txid}:${verdict}:${otherTxid || ""}:${change}`;
  if (verdict === "changed-taken") {
    const other = otherTxid ? ` (tx ${short(otherTxid)})` : "";
    return line({ key, kind: "err", text: `chain reorganization  ${ticker} is now registered to another DEPLOY${other}  ·  still checking until final`, ts: at });
  }
  if (verdict === "changed-missing") {
    return line({ key, kind: "err", text: `chain reorganization  your DEPLOY of ${ticker} left its block  ·  still checking — it usually confirms again`, ts: at });
  }
  return line({ key, kind: "sys", text: `${ticker} is registered to your DEPLOY again  ·  still provisional`, ts: at });
}

/**
 * `DEPLOY a3f9c…21e left block #970,110 (chain reorganization) · waiting for it to confirm again` [err]
 * — a confirmed DEPLOY the indexer no longer shows in that block. Its callers
 * emit it once per event, so the key carries the second: a DEPLOY that leaves
 * the same height a second time (a reorganization back and forth) is logged again.
 */
export function stepLeftBlockLine(what, txid, height, at = Date.now()) {
  const block = Number.isInteger(height) ? `block #${fmtInt(height)}` : "its block";
  return line({ key: `cr:left:${txid}:${height ?? ""}:${secondBucket(at)}`, kind: "err", text: `${what} ${short(txid)} left ${block} (chain reorganization)  ·  waiting for it to confirm again`, ts: at });
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
 *   registered → `indexer: LUCKY registered · first deploy claims the name` [sys]
 *   taken      → `indexer: LUCKY was already taken (this deploy is ignored)` [err]
 *   unindexed  → `indexer has not indexed this deploy yet` [sys]
 */
export function registrationLine(ticker, verdict, txid, { at = Date.now() } = {}) {
  const key = `registered:${txid ?? ticker}:${verdict}`;
  if (verdict === "registered") {
    return line({ key, kind: "sys", text: `indexer: ${ticker} registered · first deploy claims the name`, ts: at });
  }
  if (verdict === "taken") return line({ key, kind: "err", text: `indexer: ${ticker} was already taken (this deploy is ignored)`, ts: at });
  return line({ key, kind: "sys", text: "indexer has not indexed this deploy yet", ts: at });
}

/**
 * `deploy no longer tracked on this page  tx a3f9c…21e  ·  tracking resumes when you return`
 * — the Create page picks the newest unsettled DEPLOY back up on return
 * (resumeDeployState).
 */
export function deployUntrackedLine(txid, { at = Date.now() } = {}) {
  return line({ key: `untracked:${txid}`, kind: "sys", text: `deploy no longer tracked on this page  tx ${short(txid)}  ·  tracking resumes when you return`, ts: at });
}

/** `resumed DEPLOY LUCKY  tx a3f9c…21e  ·  broadcast 20:20:39` — a pending DEPLOY picked up again after a reload or a return to the page. */
export function deployResumedLine(ticker, txid, broadcastAt, { at = Date.now() } = {}) {
  const when = Number.isFinite(Number(broadcastAt)) && broadcastAt ? `  ·  broadcast ${formatTime(broadcastAt)}` : "";
  return line({ key: `resumed:${txid}`, kind: "sys", text: `resumed DEPLOY ${ticker}  tx ${short(txid)}${when}`, ts: at });
}

/**
 * The state the Create page opens in for `address`: the newest DEPLOY this
 * browser broadcast that has not been settled by the registry yet (see
 * src/lib/txrecords.js) resumes as "pending" — the tx-status poll then
 * moves it on to confirmed and the registry's verdict. `versions` = the
 * record's txid, then the versions it replaced (Speed up), newest first;
 * `psbt` / `changeVout` are what a further Speed up rebuilds from (null
 * when the record has none: no Speed up then).
 * `records` = txRecords(address). Returns null when there is nothing to resume.
 */
export function resumeDeployState(records) {
  const rec = [...(records || [])].reverse().find((r) => r.kind === "deploy" && r.ticker);
  if (!rec) return null;
  const replaced = Array.isArray(rec.replaces) ? [...rec.replaces].reverse() : [];
  const versions = [rec.txid, ...replaced].filter((t, i, all) => typeof t === "string" && all.indexOf(t) === i);
  return {
    phase: "pending",
    ticker: rec.ticker,
    txid: rec.txid,
    versions,
    psbt: typeof rec.psbt === "string" && rec.psbt ? rec.psbt : null,
    changeVout: Number.isInteger(rec.changeVout) ? rec.changeVout : null,
    broadcastAt: rec.at,
    startedAt: rec.at,
    resumed: true,
  };
}

// ---- Speed up, missed block, unseen, found, dropped, taken while pending ---------------------------

/** `speed up DEPLOY  fee 738 → 1,476 sats @ 6 sat/vB  new tx b1c2d…9f0` */
export function speedUpLine(what, { oldFeeSats, feeSats, feeRateSatVb, txid }, at = Date.now()) {
  const from = Number.isFinite(oldFeeSats) ? `${fmtInt(oldFeeSats)} → ` : "";
  const rate = feeRateSatVb ? ` @ ${feeRateSatVb} sat/vB` : "";
  return line({ key: `cr:speedup:${txid}`, kind: "act", text: `speed up ${what}  fee ${from}${fmtInt(feeSats)} sats${rate}  new tx ${short(txid)}`, ts: at });
}

/**
 * `DEPLOY a3f9c…21e missed block #970,103  ·  NEW is visible in the mempool — speed it up` [err]
 * — a block came without the pending DEPLOY. One line per missed height.
 */
export function missedBlockLine(ticker, txid, height, at = Date.now()) {
  const block = Number.isInteger(height) ? `block #${fmtInt(height)}` : "a block";
  return line({ key: `cr:missed:${txid}:${height ?? ""}`, kind: "err", text: `DEPLOY ${short(txid)} missed ${block}  ·  ${ticker} is visible in the mempool — speed it up`, ts: at });
}

/** `DEPLOY a3f9c…21e left the mempool without confirming` [err] */
export function stepDroppedLine(what, txid, at = Date.now()) {
  return line({ key: `cr:dropped:${txid}`, kind: "err", text: `${what} ${short(txid)} left the mempool without confirming`, ts: at });
}

/**
 * `DEPLOY a3f9c…21e not seen by the indexer's node for a few minutes · still checking (it may confirm)` —
 * the DEPLOY is NOT given up: the page keeps looking for it and for the versions it replaced.
 */
export function stepUnseenLine(what, txid, at = Date.now()) {
  return line({ key: `cr:unseen:${txid}`, kind: "sys", text: `${what} ${short(txid)} not seen by the indexer's node for a few minutes · still checking (it may confirm)`, ts: at });
}

/** `DEPLOY a3f9c…21e found  confirmed in block #970,110` / `…found in the mempool` — an earlier or unseen version turned up. */
export function stepFoundLine(what, txid, height = null, at = Date.now()) {
  const where = Number.isInteger(height) ? `confirmed in block #${fmtInt(height)}` : "in the mempool";
  return line({ key: `cr:found:${txid}:${Number.isInteger(height) ? height : "mempool"}`, kind: "ok", text: `${what} ${short(txid)} found  ${where}`, ts: at });
}

/** `indexer: NEW was registered by another DEPLOY while yours was waiting` [err] */
export function takenWhilePendingLine(ticker, key, at = Date.now()) {
  return line({ key: `cr:taken-pending:${key ?? ticker}`, kind: "err", text: `indexer: ${ticker} was registered by another DEPLOY while yours was waiting`, ts: at });
}
