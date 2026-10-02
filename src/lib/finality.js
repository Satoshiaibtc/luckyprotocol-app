// Confirmation depth and finality — pure, no React, unit-tested in
// test/finality.test.js.
//
// Bitcoin can replace its newest blocks (a chain reorganization). LUCKY-20
// state follows the chain Bitcoin keeps, so a result read from a block
// that is only a few blocks deep can still change: a MINE that confirms
// again in another block is credited from THAT block's hash, a DEPLOY can
// land after someone else's, a fill or a withdrawal can go back to the
// mempool. The app therefore shows every such result as provisional until
// its block has FINAL_DEPTH confirmations, keeps checking it until then,
// and says so when a result changed.
//
// Depth is measured against the indexer's applied height (`indexed`): a
// block the indexer has applied at height h has `indexed − h + 1`
// confirmations. A height above `indexed` (or unknown) has 0.

import { isMintedOut } from "./marketBoard.js";

export { isMarketOpen, isMarketPending } from "./marketBoard.js";

/** Confirmations after which a result is final. */
export const FINAL_DEPTH = 6;

/**
 * The market of a minted-out token opens once the block that completed its
 * supply has FINAL_DEPTH confirmations: `minted_out_height + FINAL_DEPTH − 1`.
 */
export const MARKET_OPEN_DELAY = FINAL_DEPTH - 1;

/** Confirmations a new ticker's DEPLOY needs before the console offers MINE. */
export const MINE_MIN_DEPLOY_CONFIRMATIONS = 1;

/**
 * Confirmations of a block at `height` when the indexer has applied up to
 * `tip`: `tip − height + 1`, 0 above the tip, null while either is unknown.
 */
export function confirmationsAt(height, tip) {
  if (!Number.isInteger(height) || !Number.isInteger(tip)) return null;
  return height <= tip ? tip - height + 1 : 0;
}

/**
 * Confirmations to show: the larger of a server-reported count and the one
 * computed from `tip` (both are lower bounds — each was read at its own
 * moment), or null when neither is known.
 */
export function bestConfirmations(serverCount, height, tip) {
  const local = confirmationsAt(height, tip);
  const server = Number.isInteger(serverCount) && serverCount >= 0 ? serverCount : null;
  if (local === null) return server;
  if (server === null) return local;
  return Math.max(local, server);
}

/** Is a block at `height` final at `tip` (an explicit server `final: true` also counts)? */
export function isFinalAt(height, tip, serverFinal = null) {
  if (serverFinal === true) return true;
  const n = confirmationsAt(height, tip);
  return n !== null && n >= FINAL_DEPTH;
}

/** "1/6 confirmations" (capped at FINAL_DEPTH), or "" when unknown. */
export function confirmationsText(n) {
  if (!Number.isInteger(n) || n < 0) return "";
  const shown = Math.min(n, FINAL_DEPTH);
  return `${shown}/${FINAL_DEPTH} confirmation${FINAL_DEPTH === 1 ? "" : "s"}`;
}

/** "provisional · 2/6 confirmations" while not final, "final" once it is, "" when unknown. */
export function finalityText(n) {
  if (!Number.isInteger(n) || n < 1) return "";
  return n >= FINAL_DEPTH ? "final" : `provisional · ${confirmationsText(n)}`;
}

/**
 * Has a new ticker's DEPLOY (confirmed at `deployBlock`) enough
 * confirmations at `tip` for the console to offer MINE? A MINE in the
 * DEPLOY's own block is invalid, so MINE opens once the DEPLOY has
 * confirmed: a MINE sent from then on lands in a later block, which is all
 * the protocol asks. Unknown heights fail closed.
 */
export function deployDeepEnough(tip, deployBlock) {
  const n = confirmationsAt(deployBlock, tip);
  return n !== null && n >= MINE_MIN_DEPLOY_CONFIRMATIONS;
}

/**
 * The block from which a minted-out token's market is open, or null when
 * it is not minted out or the completing block is unknown. The indexer's
 * own `market_opens_at_height` wins when present.
 */
export function marketOpensAt(t) {
  if (!t || !isMintedOut(t)) return null;
  if (Number.isInteger(t.market_opens_at_height)) return t.market_opens_at_height;
  return Number.isInteger(t.minted_out_height) ? t.minted_out_height + MARKET_OPEN_DELAY : null;
}

/** "Minted out — the market opens at block #970,112." (or without the height when unknown). */
export function marketPendingText(t) {
  const at = marketOpensAt(t);
  const ticker = t?.ticker ? `${t.ticker} is minted out` : "Minted out";
  return at !== null
    ? `${ticker} — the market opens at block #${at.toLocaleString("en-US")}, once the block that completed the supply has ${FINAL_DEPTH} confirmations.`
    : `${ticker} — the market opens once the block that completed the supply has ${FINAL_DEPTH} confirmations.`;
}
