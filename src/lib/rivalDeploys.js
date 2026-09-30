// Other DEPLOYs of the same ticker waiting in the node's mempool (GET
// /pending-deploys/:ticker, read by src/lib/indexer.js pendingDeploys): the
// pure parts. The first DEPLOY to confirm takes the name, so a DEPLOY that
// waits can be passed by a copy that pays a higher fee rate. The Create
// page therefore warns before signing when another DEPLOY of the typed
// ticker is already waiting, and, while the user's own DEPLOY waits, when
// another one pays more than it. No React; unit-tested in
// test/rivaldeploys.test.js. The React side is src/hooks/usePendingDeploys.js
// and src/pages/CreatePage.jsx.
//
// A read that failed, or a watch that is not running (`watching: false`),
// is "unknown": the page says so in one quiet line and never holds back a
// DEPLOY because of it.

import { MAX_FEE_RATE_SAT_VB, psbtFeeSats, psbtVsize } from "./psbt.js";

/** How often the list is read while the ticker stays in the field, and while the user's DEPLOY waits. */
export const PENDING_DEPLOYS_POLL_MS = 15_000;
/** The read made when Create is clicked gives up after this long: a slow answer never holds back a DEPLOY. */
export const CLICK_CHECK_TIMEOUT_MS = 5_000;
/** The offered rate is at least this many sat/vB above the highest waiting DEPLOY… */
export const RIVAL_MARGIN_MIN_SAT_VB = 2;
/** …and at least this many percent above it. */
export const RIVAL_MARGIN_PERCENT = 10;

export const PENDING_CHECK_FAILED_TEXT = "Pending DEPLOYs could not be checked right now.";

const lower = (t) => (typeof t === "string" ? t.trim().toLowerCase() : "");
const round2 = (x) => Math.round(x * 100) / 100;

/** A sat/vB for the page: at most 2 decimals, thousands separated ("12.25", "1,000"). */
export function fmtRate(rate) {
  return Number(rate).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * The rate a waiting DEPLOY competes at: its package rate, the rate the
 * node mines it at (a child that pays for it raises it, an unconfirmed
 * parent that pays less lowers it), else its own fee rate; null when
 * unreadable.
 */
export function deployRowRate(row) {
  const own = Number(row?.fee_rate);
  if (row?.fee_rate === null || row?.fee_rate === undefined || !Number.isFinite(own) || own < 0) return null;
  const pkg = Number(row?.package_fee_rate);
  return row?.package_fee_rate !== null && row?.package_fee_rate !== undefined && Number.isFinite(pkg) && pkg > 0 ? pkg : own;
}

/**
 * What one read of the list says (`answer`: undefined before the first
 * read, null when the read failed, else indexer.pendingDeploys's result).
 * `own` = the txids of the user's own DEPLOY versions, never counted:
 *
 *   { status: "idle" }                        not read yet
 *   { status: "unknown" }                     the read failed, or the watch is not running
 *   { status: "registered" }                  the ticker is registered — the registry says the rest
 *   { status: "ok", rivals: null }            no other DEPLOY of the ticker waits
 *   { status: "ok", rivals: { count, topRate, rows } }
 *
 * `topRate` is the highest competing rate (deployRowRate) over the other
 * DEPLOYs — the rows come sorted by their own fee rate, so it is a
 * maximum, never simply the first row.
 */
export function readPendingDeploys(answer, own = []) {
  if (answer === undefined) return { status: "idle" };
  if (!answer || typeof answer !== "object" || answer.watching !== true) return { status: "unknown" };
  if (answer.registered === true) return { status: "registered" };
  const mine = new Set((own || []).map(lower).filter(Boolean));
  const rows = (Array.isArray(answer.pending) ? answer.pending : []).filter((r) => r && !mine.has(lower(r.txid)) && deployRowRate(r) !== null);
  if (!rows.length) return { status: "ok", rivals: null };
  const topRate = Math.max(...rows.map(deployRowRate));
  return { status: "ok", rivals: { count: rows.length, topRate, rows } };
}

/**
 * The rate to offer against a waiting DEPLOY that pays `topRate`: at least
 * RIVAL_MARGIN_MIN_SAT_VB and at least RIVAL_MARGIN_PERCENT above it,
 * rounded up to a whole sat/vB, and never below the Fast estimate `fast`.
 * Past the safety cap it is the cap while the cap still pays more; null
 * when nothing that can be signed pays more.
 */
export function suggestedRivalRate(topRate, fast = null) {
  const top = Number(topRate);
  if (topRate === null || topRate === undefined || !Number.isFinite(top) || top < 0) return null;
  // In hundredths of a sat/vB: 20 × 1.1 must be 22, not 22.000000000000004 (→ 23).
  const cents = Math.round(top * 100);
  const margin = Math.max(RIVAL_MARGIN_MIN_SAT_VB * 100, Math.ceil((cents * RIVAL_MARGIN_PERCENT) / 100));
  let rate = Math.ceil((cents + margin) / 100);
  const f = Number(fast);
  if (fast !== null && Number.isFinite(f) && f > rate) rate = f;
  if (rate > MAX_FEE_RATE_SAT_VB) return MAX_FEE_RATE_SAT_VB > top ? MAX_FEE_RATE_SAT_VB : null;
  return rate;
}

/** The warning before signing, for `rivals` of readPendingDeploys. */
export function rivalWarningText(ticker, rivals) {
  const rate = fmtRate(rivals.topRate);
  if (rivals.count > 1) {
    return (
      `${rivals.count} other DEPLOYs of ${ticker} are waiting to be confirmed; the highest pays ${rate} sat/vB. ` +
      "The first DEPLOY to confirm takes the name; the fees of the ones that confirm later are spent and not refunded."
    );
  }
  return `Another DEPLOY of ${ticker} is waiting to be confirmed, paying ${rate} sat/vB. The first DEPLOY to confirm takes the name; the fee of the one that confirms second is spent and not refunded.`;
}

/**
 * Does a click on Create stop at the warning, with nothing signed? Only
 * when the read made at the click (`answer`) lists another DEPLOY that the
 * page had not shown — none was shown, or it pays more than the highest
 * rate shown (`shownTopRate`) — and the chosen `rate` does not already pay
 * more than it. A failed or unknown read never stops it.
 */
export function rivalPause(answer, { own = [], shownTopRate = null, rate = null } = {}) {
  const r = readPendingDeploys(answer, own);
  if (r.status !== "ok" || !r.rivals) return false;
  const top = r.rivals.topRate;
  if (Number.isFinite(Number(rate)) && rate !== null && Number(rate) > top) return false;
  if (shownTopRate !== null && Number.isFinite(Number(shownTopRate)) && Number(shownTopRate) >= top) return false;
  return true;
}

/**
 * A click that signs a DEPLOY (Create, Retry, or Sign in the review):
 * `readFresh()` makes the fresh read, and the click stops when rivalPause
 * says so. A read that throws counts as failed and never stops the DEPLOY.
 */
export async function clickPauses(readFresh, ctx) {
  let fresh = null;
  try {
    fresh = await readFresh();
  } catch {
    fresh = null;
  }
  return rivalPause(fresh, ctx);
}

/**
 * What the page has shown about ticker `t` when a click creates it. `at`
 * is the page at the click: `typed` the field's ticker, `own` the versions
 * of an earlier DEPLOY of it from this browser, `shownTop` the highest rate
 * its warning showed, `settling` the settling notes. The warning on the
 * page is about the field's ticker, so a Retry of another ticker has shown
 * none, and its own versions come from its released note.
 *
 *   → { same, own, shownTop }
 */
export function clickContext(t, { typed = null, own = [], shownTop = null, settling = [] } = {}) {
  if (t === typed) return { same: true, own: own || [], shownTop };
  const note = (settling || []).find((n) => n && n.ticker === t && n.verdict === "released");
  return { same: false, own: note?.versions ?? [], shownTop: null };
}

/**
 * Speed up's suggested rate: the highest of the Fast estimate `fast`, the
 * lowest rate a replacement may use (`floor`) and every rate offered
 * against another DEPLOY (`rivalRates`, null ones ignored); null without a
 * floor.
 */
export function speedUpSuggested(fast, floor, ...rivalRates) {
  if (!floor) return null;
  return Math.max(Number(fast) || 0, floor, ...rivalRates.map((r) => Number(r) || 0));
}

/**
 * The rate of the user's own pending DEPLOY as this page built it: the
 * flow's own rate, else its unsigned copy's fee over its size; null when
 * neither is known (a DEPLOY picked up again without its unsigned copy).
 */
export function ownDeployRate(flow) {
  const r = Number(flow?.feeRateSatVb);
  if (flow?.feeRateSatVb !== null && flow?.feeRateSatVb !== undefined && Number.isFinite(r) && r > 0) return r;
  if (typeof flow?.psbt !== "string" || !flow.psbt) return null;
  try {
    const vsize = Math.ceil(psbtVsize(flow.psbt));
    const fee = psbtFeeSats(flow.psbt);
    return vsize > 0 && Number.isFinite(fee) && fee >= 0 ? round2(fee / vsize) : null;
  } catch {
    return null;
  }
}

/**
 * While the user's own DEPLOY waits: the other DEPLOYs of its ticker that
 * pay more than its current version, or null. `own` = every version's
 * txid (none of them is another DEPLOY); `current` = the newest version,
 * whose own row gives its rate once the list has it; `localRate` its rate
 * as built (ownDeployRate) until then.
 *
 *   → { count, topRate, mine } | null
 */
export function rivalsAhead(answer, { own = [], current = null, localRate = null } = {}) {
  const r = readPendingDeploys(answer, own);
  if (r.status !== "ok" || !r.rivals) return null;
  const cur = lower(current);
  const row = cur ? (answer.pending || []).find((x) => x && lower(x.txid) === cur) : null;
  const listed = row ? deployRowRate(row) : null;
  const local = Number(localRate);
  const mine = listed !== null ? listed : localRate !== null && Number.isFinite(local) && local > 0 ? local : null;
  if (mine === null) return null;
  const ahead = r.rivals.rows.filter((x) => deployRowRate(x) > mine);
  if (!ahead.length) return null;
  return { count: ahead.length, topRate: Math.max(...ahead.map(deployRowRate)), mine };
}

/**
 * The line next to Speed up when another DEPLOY pays more than the user's
 * (`ahead` of rivalsAhead). Without a Speed up on this page (a DEPLOY
 * picked up again without its unsigned copy) the advice is left out.
 */
export function rivalAheadText(ticker, ahead, { canSpeedUp = true } = {}) {
  const lead =
    ahead.count > 1
      ? `${ahead.count} other DEPLOYs of ${ticker} pay more (up to ${fmtRate(ahead.topRate)} sat/vB) than yours (${fmtRate(ahead.mine)} sat/vB).`
      : `Another DEPLOY of ${ticker} pays more (${fmtRate(ahead.topRate)} sat/vB) than yours (${fmtRate(ahead.mine)} sat/vB).`;
  return canSpeedUp ? `${lead} Speed up to stay ahead.` : lead;
}

/** The quiet line for a read that says nothing (readPendingDeploys status "unknown"), else null. */
export function pendingCheckLine(view) {
  return view?.status === "unknown" ? PENDING_CHECK_FAILED_TEXT : null;
}
