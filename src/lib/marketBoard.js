// Pure helpers for the #/market page and the board's market gating.
//
// Owner's rule (2026-09-27): a token's market opens only once the token is
// fully minted. "Minted" is the CUMULATIVE credited MINE yield — it never
// decreases (burns, unspendable outputs and anything else never lower it),
// so once a token is minted out it stays minted out forever. The indexer
// says so with `minted_out` on every token row; `isMintedOut` also accepts
// the raw `minted >= supply` reading for rows that predate the field.

export const NEXT_LIMIT = 6;

export const MARKET_SORTS = [
  { id: "volume", label: "Top volume (24h)" },
  { id: "floor", label: "Lowest floor" },
  { id: "change", label: "24h change" },
  { id: "opened", label: "Newest opened" },
];

/** True when the token's cumulative credited yield reached its supply. */
export function isMintedOut(t) {
  if (!t) return false;
  if (t.minted_out === true) return true;
  const supply = Number(t.supply);
  const minted = Number(t.minted);
  return Number.isFinite(supply) && supply > 0 && Number.isFinite(minted) && minted >= supply;
}

/** Minted share in percent, 0–100 (a minted-out token is exactly 100). */
export function mintedPct(t) {
  if (!t) return 0;
  if (isMintedOut(t)) return 100;
  const supply = Number(t.supply);
  const minted = Number(t.minted);
  if (!(supply > 0) || !(minted >= 0)) return 0;
  return Math.min(100, (100 * minted) / supply);
}

const byTicker = (a, b) => String(a.ticker).localeCompare(String(b.ticker));

/**
 * Open markets in the requested order:
 *   volume — 24 h fill volume, tokens without a market row last
 *   floor  — cheapest open ask first, no asks last
 *   change — largest 24 h change first, unknown last
 *   opened — most recently minted out first, unknown height last
 * Ties break on the ticker so the order is stable across polls.
 */
export function sortOpenMarkets(rows, sort = "volume") {
  const out = [...rows];
  switch (sort) {
    case "floor":
      return out.sort((a, b) => (a.floor_unit_price ?? Infinity) - (b.floor_unit_price ?? Infinity) || byTicker(a, b));
    case "change":
      return out.sort((a, b) => (b.market_24h?.change_pct ?? -Infinity) - (a.market_24h?.change_pct ?? -Infinity) || byTicker(a, b));
    case "opened":
      return out.sort((a, b) => (b.minted_out_height ?? -1) - (a.minted_out_height ?? -1) || byTicker(a, b));
    default:
      return out.sort((a, b) => (b.market_24h?.volume_sats ?? -1) - (a.market_24h?.volume_sats ?? -1) || (b.market_24h?.trades ?? 0) - (a.market_24h?.trades ?? 0) || byTicker(a, b));
  }
}

/**
 * Split the token registry into `open` (minted out, sorted by `sort`) and
 * `next` (not yet minted out, highest minted share first, at most
 * `nextLimit` rows — the "Next to open" strip).
 */
export function partitionMarkets(items, { sort = "volume", nextLimit = NEXT_LIMIT } = {}) {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  const open = sortOpenMarkets(rows.filter(isMintedOut), sort);
  const next = rows
    .filter((t) => !isMintedOut(t))
    .sort((a, b) => mintedPct(b) - mintedPct(a) || (b.mine_count ?? 0) - (a.mine_count ?? 0) || byTicker(a, b))
    .slice(0, Math.max(0, nextLimit));
  return { open, next };
}

/** Minted-out tokens first, everything else after in its existing order (stable). */
export function mintedOutFirst(rows) {
  return [...rows.filter(isMintedOut), ...rows.filter((t) => !isMintedOut(t))];
}

/**
 * What the board shows when the current view is empty (audit visit-1) —
 * `items` the whole registry, `shown` the current view after filter + sort,
 * `sort` the view id, `q` the filter text. Tested in test/journeys.test.js.
 *   "none"         — the registry is empty
 *   "no-mintedout" — the Minted out view, no filter, nothing minted out yet
 *   "not-minted"   — the filter matches tokens that are not minted out
 *                    (the Minted out view): they exist — say so, never
 *                    "no ticker matches … Create it"
 *   "no-match"     — no token in the whole registry matches the filter
 *   null           — the view is not empty
 */
export function emptyBoardState({ items, shown, sort, q }) {
  if (items.length === 0) return "none";
  if (shown.length > 0) return null;
  const needle = String(q || "").trim().toUpperCase();
  if (!needle) return sort === "mintedout" ? "no-mintedout" : "none";
  return items.some((t) => t.ticker.includes(needle)) ? "not-minted" : "no-match";
}
