// The token page's action tabs. The Market tab exists only once the
// token's market is open (owner's rules, 2026-09-27 / 2026-09-28): the
// token is minted out AND the block that completed the supply has
// FINAL_DEPTH confirmations. Until then `?tab=market` resolves to the mine
// console with a one-line notice. A token with an open market opens on
// Market by default — its mines credit 0.
import { isMarketOpen, isMintedOut } from "./marketBoard.js";
import { FINAL_DEPTH, marketOpensAt, marketPendingText } from "./finality.js";
import { fmtInt, fmtMintedPct } from "./format.js";

export const ALL_TABS = ["mine", "market"];
export const TAB_LABEL = { mine: "Mine", market: "Market" };

/** The tabs a token page shows, default first. */
export function tabsFor(token) {
  return isMarketOpen(token) ? ["market", "mine"] : ["mine"];
}

export function defaultTab(token) {
  return isMarketOpen(token) ? "market" : "mine";
}

/**
 * "Market opens when TICKER is fully minted · 5.88% minted" (rounded down:
 * never "100%" while it is still minting) — or, for a minted-out token whose
 * completing block is not deep enough yet, "TICKER is minted out — the
 * market opens at block #N, …".
 */
export function marketClosedNotice(ticker, token) {
  if (token && isMintedOut(token)) return marketPendingText({ ...token, ticker: token.ticker || ticker });
  // Trailing fractional zeros trimmed ("40.00%" → "40%", "5.80%" → "5.8%"); a whole "100%" is left alone.
  const pct = token ? fmtMintedPct(token.minted, token.supply, 2).replace(/(\.\d*?)0+%$/, "$1%").replace(/\.%$/, "%") : "";
  const share = token ? ` · ${pct} minted` : "";
  return `Market opens when ${ticker} is fully minted${share}`;
}

/**
 * The notice for a token whose market opened while this visit showed its
 * Mine tab (the tab stays put — audit mine-3): null unless the pinned view
 * was opened before the market opened.
 */
export function mintedOutFlipNotice(pinned, token) {
  if (!pinned || pinned.marketOpen || !isMarketOpen(token)) return null;
  return `${token.ticker} is fully minted — its market is open.`;
}

/**
 * "Market opens at 100% · minted 1,234,567 of 21,000,000" (the board card /
 * tab strip note), or "Minted out · market opens at block #N" while the
 * completing block of a minted-out token is not deep enough yet.
 */
export function mintedProgressNote(token) {
  if (!token) return "Market opens at 100%";
  if (isMintedOut(token)) {
    const at = marketOpensAt(token);
    return at !== null ? `Minted out · market opens at block #${fmtInt(at)}` : `Minted out · market opens after ${FINAL_DEPTH} confirmations`;
  }
  return `Market opens at 100% · minted ${fmtInt(token.minted)} of ${fmtInt(token.supply)}`;
}

/**
 * Resolve the requested `?tab=` against the token's state:
 *   { tab: "mine" | "market", notice: string | null }
 * An unknown or absent tab is the default; `market` on a token whose market
 * is not open is the mine console plus the "Market opens…" notice.
 */
export function resolveTab(requested, ticker, token) {
  const tabs = tabsFor(token);
  if (requested && tabs.includes(requested)) return { tab: requested, notice: null };
  if (requested === "market") return { tab: "mine", notice: marketClosedNotice(ticker, token) };
  return { tab: defaultTab(token), notice: null };
}
