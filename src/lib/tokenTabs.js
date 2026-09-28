// The token page's action tabs. The Market tab exists only once the token
// is minted out (owner's rule, 2026-09-27); until then `?tab=market`
// resolves to the mine console with a one-line notice. A minted-out token
// opens on Market by default — its mines credit 0.
import { isMintedOut } from "./marketBoard.js";
import { fmtInt, fmtMintedPct } from "./format.js";

export const ALL_TABS = ["mine", "market"];
export const TAB_LABEL = { mine: "Mine", market: "Market" };

/** The tabs a token page shows, default first. */
export function tabsFor(token) {
  return isMintedOut(token) ? ["market", "mine"] : ["mine"];
}

export function defaultTab(token) {
  return isMintedOut(token) ? "market" : "mine";
}

/** "Market opens when TICKER is fully minted · 5.88% minted" (rounded down: never "100%" while it is still minting). */
export function marketClosedNotice(ticker, token) {
  // Trailing fractional zeros trimmed ("40.00%" → "40%", "5.80%" → "5.8%"); a whole "100%" is left alone.
  const pct = token ? fmtMintedPct(isMintedOut(token) ? token.supply : token.minted, token.supply, 2).replace(/(\.\d*?)0+%$/, "$1%").replace(/\.%$/, "%") : "";
  const share = token ? ` · ${pct} minted` : "";
  return `Market opens when ${ticker} is fully minted${share}`;
}

/**
 * The notice for a token that became minted out while this visit showed
 * its Mine tab (the tab stays put — audit mine-3): null unless the pinned
 * view was opened before the flip.
 */
export function mintedOutFlipNotice(pinned, token) {
  if (!pinned || pinned.mintedOut || !isMintedOut(token)) return null;
  return `${token.ticker} is now fully minted — its market is open.`;
}

/** "Market opens at 100% · minted 1,234,567 of 21,000,000" (the board card / tab strip note). */
export function mintedProgressNote(token) {
  if (!token) return "Market opens at 100%";
  return `Market opens at 100% · minted ${fmtInt(token.minted)} of ${fmtInt(token.supply)}`;
}

/**
 * Resolve the requested `?tab=` against the token's state:
 *   { tab: "mine" | "market", notice: string | null }
 * An unknown or absent tab is the default; `market` on a token that is not
 * minted out is the mine console plus the "Market opens when…" notice.
 */
export function resolveTab(requested, ticker, token) {
  const tabs = tabsFor(token);
  if (requested && tabs.includes(requested)) return { tab: requested, notice: null };
  if (requested === "market") return { tab: "mine", notice: marketClosedNotice(ticker, token) };
  return { tab: defaultTab(token), notice: null };
}
