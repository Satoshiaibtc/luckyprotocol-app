// Idle status lines shared by the mine console and the Create page — pure,
// tested in test/flows.test.js.

import { MIN_FEE_INPUT_SATS_UNSAFE } from "./psbt.js";
import { lockedHint } from "./activation.js";
import { MINE_MIN_DEPLOY_CONFIRMATIONS } from "./finality.js";
import { MINE_PROTOCOL_FEE_SATS } from "./payloads.js";

const int = (n) => Number(n).toLocaleString("en-US");

/**
 * The "Ready" line. A wallet without an asset-safe UTXO list (OKX, the
 * simulated wallet) is told plainly what that means BEFORE its first
 * transaction (spec §6: the app warns OKX users; audit mine-8) — not only
 * in the signing detail, while the wallet's own popup has the attention.
 */
export function readyText(assetSafe, action) {
  if (assetSafe === true) return "Ready. Fee inputs are selected from spendable BTC only — dust and token-bearing outputs are never spent.";
  return (
    `Ready to ${String(action).toLowerCase()}. This wallet has no asset-safe UTXO list: LUCKY-20 carriers and outputs of ` +
    `${MIN_FEE_INPUT_SATS_UNSAFE.toLocaleString("en-US")} sats or less are skipped, but Ordinals or Runes on larger outputs cannot be detected — use an address that holds none.`
  );
}

/**
 * Why the MINE button is off while idle (audit visit-6 / mine-7), or null
 * when nothing but the fee rate stops it. The order is the order of the
 * notices above the button.
 */
export function mineIdleReason({ connected, indexerOk, preActivation, exhausted, lagText, ticker, deployBlock = null, deployTooNew = false }) {
  if (!connected) return "Connect a wallet to mine.";
  if (!indexerOk) return "Indexer offline — mining paused until it is reachable.";
  if (preActivation) return lockedHint();
  if (exhausted) return `${ticker} is fully minted — mining is closed; a MINE would credit 0.`;
  if (lagText) return "Paused until the indexer catches up with the chain tip (see above).";
  if (deployTooNew) return deployWaitText(ticker, deployBlock);
  return null;
}

/**
 * Why a brand-new ticker cannot be mined yet: its DEPLOY needs
 * MINE_MIN_DEPLOY_CONFIRMATIONS confirmations first. A MINE in the DEPLOY's
 * own block is invalid, and a chain reorganization that replaces that
 * block could put a MINE ahead of the DEPLOY — invalid too, fees paid.
 */
export function deployWaitText(ticker, deployBlock) {
  const opens = Number.isInteger(deployBlock) ? ` (block #${int(deployBlock + MINE_MIN_DEPLOY_CONFIRMATIONS - 1)})` : "";
  return `${ticker} was just created. Mining opens at its ${MINE_MIN_DEPLOY_CONFIRMATIONS === 2 ? "2nd" : `${MINE_MIN_DEPLOY_CONFIRMATIONS}th`} confirmation${opens}, so a chain reorganization cannot leave a MINE ahead of the creation — such a MINE credits nothing.`;
}

// ---- the end of the supply (audit: MINEs queued in the mempool) ------------------------------------

/** Blocks of recent minting the rate is measured over. */
export const TAIL_WINDOW_BLOCKS = 6;
/** Warn when the remaining supply is at most this many blocks' worth of the recent rate. */
export const TAIL_BLOCKS = 3;
/**
 * About one block full of MINEs at the expected credit (≈ 4,500 × 262.5):
 * the TAIL ZONE. Below this, MINEs already waiting in the mempool — which
 * neither the app nor the indexer counts — can use up the rest in a single
 * block, whatever recent blocks minted (a rush can be queued behind a
 * quiet chain), so a remaining supply below it is always warned about.
 */
export const FULL_BLOCK_MINT = 1_200_000;

/** Is a remaining supply in the tail zone (above 0, below FULL_BLOCK_MINT)? */
export function inTailZone(remaining) {
  return Number.isFinite(remaining) && remaining > 0 && remaining < FULL_BLOCK_MINT;
}

/**
 * How much recent blocks minted of a ticker, from its newest MINEs (`rows`,
 * newest first — the /mines?ticker feed the console already reads; `limit`
 * the page size it asked for) over the last TAIL_WINDOW_BLOCKS blocks up to
 * `tip`: `{ perBlock, lowerBound }` — `lowerBound` when the page was full
 * and still inside the window (there were more) — or null without a tip.
 */
export function recentMintRate(rows, tip, { windowBlocks = TAIL_WINDOW_BLOCKS, limit = null } = {}) {
  if (!Number.isInteger(tip)) return null;
  const lo = tip - windowBlocks + 1;
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const inWin = list.filter((r) => r.status !== "invalid" && Number.isInteger(r.block_height) && r.block_height >= lo && r.block_height <= tip);
  if (inWin.length === 0) return { perBlock: 0, lowerBound: false };
  const sum = inWin.reduce((s, r) => s + (r.cap_exhausted ? 0 : Number(r.yield_smallest) || 0), 0);
  const oldest = Math.min(...list.map((r) => (Number.isInteger(r.block_height) ? r.block_height : Infinity)));
  const lowerBound = Number.isInteger(limit) && list.length >= limit && oldest >= lo;
  const span = lowerBound ? Math.max(1, tip - oldest + 1) : windowBlocks;
  return { perBlock: sum / span, lowerBound };
}

/**
 * The warning before a MINE near the end of the supply, or null: the MINEs
 * already waiting in the mempool (which the app cannot see) may use up
 * what is left, and a MINE confirmed after that credits 0 while its fees
 * are still paid. Raised in the tail zone (below FULL_BLOCK_MINT) whatever
 * the recent rate, and above it when the remaining supply is at most
 * TAIL_BLOCKS blocks' worth of the recent rate. The rate is quoted when
 * recent blocks minted any.
 */
export function tailWarning({ ticker, remaining, rate }) {
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const minting = !!rate && rate.perBlock > 0;
  const risky = inTailZone(remaining) || (minting && remaining <= TAIL_BLOCKS * rate.perBlock);
  if (!risky) return null;
  const per = minting ? `, and recent blocks minted ${rate.lowerBound ? "at least " : "about "}${int(Math.round(rate.perBlock))} each` : "";
  return (
    `Only ${int(remaining)} ${ticker} left${per}. MINEs already waiting in the mempool may use up the rest first — ` +
    `a new MINE can then credit 0, while its ${int(MINE_PROTOCOL_FEE_SATS)}-sat protocol fee and the network fee are still paid.`
  );
}
