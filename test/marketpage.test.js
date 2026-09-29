// Pure-part tests for the market gate: src/lib/marketBoard.js (open vs
// next-to-open partition, the open-market sorts, minted-out-first) and
// src/lib/tokenTabs.js (which tabs a token page shows and how `?tab=`
// resolves). Plain Node, no framework.
import assert from "node:assert/strict";
import { MARKET_SORTS, NEXT_LIMIT, isMarketOpen, isMarketPending, isMintedOut, mintedOutFirst, mintedPct, partitionMarkets, sortOpenMarkets } from "../src/lib/marketBoard.js";
import { MARKET_OPEN_DELAY, marketOpensAt, marketPendingText } from "../src/lib/finality.js";
import { _sanitizeTokenRow } from "../src/lib/indexer.js";
import { ALL_TABS, TAB_LABEL, defaultTab, marketClosedNotice, mintedProgressNote, resolveTab, tabsFor } from "../src/lib/tokenTabs.js";

const S = 21_000_000;
// A registry row as the sanitizer leaves it: `market_open` is the indexer's
// gate (minted out AND the completing block 6 deep).
const row = (ticker, minted, extra = {}) => ({ ticker, supply: S, minted, minted_out: minted >= S, minted_out_height: minted >= S ? 969_790 : null, market_open: minted >= S, mine_count: Math.round(minted / 250), holders: 1, open_orders: 0, floor_unit_price: null, last_trade: null, market_24h: null, ...extra });

// ---- the gate --------------------------------------------------------------------------------
{
  assert.equal(isMintedOut(row("A", S)), true);
  assert.equal(isMintedOut(row("A", S - 1)), false);
  assert.equal(isMintedOut({ ticker: "A", supply: S, minted: S, minted_out: false }), true, "the cumulative reading: minted >= supply is minted out");
  assert.equal(isMintedOut({ ticker: "A", supply: S, minted: 5, minted_out: true }), true, "the indexer's flag opens it too");
  assert.equal(isMintedOut({ ticker: "A", supply: S, minted: S + 500 }), true, "over-credit (never happens, but never closes)");
  assert.equal(isMintedOut(null), false);
  assert.equal(isMintedOut({ ticker: "A" }), false, "no numbers → not minted out");
  assert.equal(mintedPct(row("A", S)), 100);
  assert.equal(mintedPct(row("A", S / 2)), 50);
  assert.equal(mintedPct(row("A", 0)), 0);
  assert.equal(mintedPct({ ticker: "A", supply: S, minted: 1, minted_out: true }), 100, "flagged → exactly 100");
  assert.equal(mintedPct(null), 0);
  console.log("marketpage gate: minted_out flag OR minted >= supply; never comes back down");
}

// ---- partition + next-to-open ---------------------------------------------------------------------
{
  const items = [
    row("LUCKY", 1_234_567, { market_24h: { volume_sats: 999, trades: 9, change_pct: 1, buyers: 1 } }), // 5.9 %, a market row that must NOT open it
    row("BLOK", S, { minted_out_height: 969_790, market_24h: { volume_sats: 592_451, trades: 7, change_pct: -2.2, buyers: 5 }, floor_unit_price: 12.9 }),
    row("SATS", 8_400_000),
    row("ORE", 42_021),
    row("NODE", 620_500),
    row("GRID", 210_000),
    row("PIXEL", 3_150),
    row("VOLT", 0),
  ];
  const { open, next } = partitionMarkets(items);
  assert.deepEqual(open.map((t) => t.ticker), ["BLOK"], "only the minted-out token has an open market");
  assert.equal(next.length, NEXT_LIMIT, `next to open is capped at ${NEXT_LIMIT}`);
  assert.deepEqual(next.map((t) => t.ticker), ["SATS", "LUCKY", "NODE", "GRID", "ORE", "PIXEL"], "highest minted share first; the 0 % token falls off the end");
  assert.ok(next.every((t) => !isMintedOut(t)), "nothing minted out in next");
  assert.deepEqual(partitionMarkets(items, { nextLimit: 2 }).next.map((t) => t.ticker), ["SATS", "LUCKY"]);
  assert.deepEqual(partitionMarkets([]), { open: [], next: [] });
  assert.deepEqual(partitionMarkets(null), { open: [], next: [] }, "no registry → empty, not a throw");
  assert.deepEqual(partitionMarkets([null, row("A", S)]).open.map((t) => t.ticker), ["A"], "holes are skipped");
  // ties on minted share break on mine count, then ticker
  const tie = partitionMarkets([row("B", 100, { mine_count: 1 }), row("A", 100, { mine_count: 1 }), row("C", 100, { mine_count: 5 })]).next;
  assert.deepEqual(tie.map((t) => t.ticker), ["C", "A", "B"]);
  console.log("marketpage partition: open = minted out; next = top 6 by minted share, stable ties");
}

// ---- sorts ---------------------------------------------------------------------------------
{
  const v = (ticker, volume_sats, trades, change_pct, floor, height) => row(ticker, S, { minted_out_height: height, floor_unit_price: floor, market_24h: volume_sats === undefined ? null : { volume_sats, trades, change_pct, buyers: 1 } });
  const rows = [v("AAA", 100, 1, 5, 2, 969_700), v("BBB", 500, 2, -3, null, 969_790), v("CCC", 500, 9, null, 1, null), v("DDD", undefined, undefined, undefined, 3, 969_750)];
  assert.deepEqual(MARKET_SORTS.map((s) => s.id), ["volume", "floor", "change", "opened"]);
  assert.deepEqual(sortOpenMarkets(rows, "volume").map((t) => t.ticker), ["CCC", "BBB", "AAA", "DDD"], "volume desc, then trades desc; no market row last");
  assert.deepEqual(sortOpenMarkets(rows).map((t) => t.ticker), ["CCC", "BBB", "AAA", "DDD"], "volume is the default");
  assert.deepEqual(sortOpenMarkets(rows, "floor").map((t) => t.ticker), ["CCC", "AAA", "DDD", "BBB"], "cheapest ask first; no asks last");
  assert.deepEqual(sortOpenMarkets(rows, "change").map((t) => t.ticker), ["AAA", "BBB", "CCC", "DDD"], "largest change first; unknown last");
  assert.deepEqual(sortOpenMarkets(rows, "opened").map((t) => t.ticker), ["BBB", "DDD", "AAA", "CCC"], "newest minted-out block first; unknown height last");
  assert.deepEqual(sortOpenMarkets(rows, "bogus").map((t) => t.ticker), ["CCC", "BBB", "AAA", "DDD"], "unknown sort → volume");
  const before = rows.map((t) => t.ticker);
  sortOpenMarkets(rows, "floor");
  assert.deepEqual(rows.map((t) => t.ticker), before, "input is not mutated");
  console.log("marketpage sorts: volume / floor / change / opened, unknowns sink, ticker tie-break");
}

// ---- minted-out first (the board's volume / floor sorts) ----------------------------------------------
{
  const rows = [row("A", 5), row("B", S), row("C", 9), row("D", S)];
  assert.deepEqual(mintedOutFirst(rows).map((t) => t.ticker), ["B", "D", "A", "C"], "open markets first, the rest in their existing order");
  assert.deepEqual(mintedOutFirst([]).length, 0);
  console.log("marketpage mintedOutFirst: stable partition");
}

// ---- token page tabs ----------------------------------------------------------------------------
{
  const closed = row("LUCKY", 1_234_567);
  const opened = row("BLOK", S);
  assert.deepEqual(ALL_TABS, ["mine", "market"]);
  assert.deepEqual(TAB_LABEL, { mine: "Mine", market: "Market" });
  assert.deepEqual(tabsFor(closed), ["mine"], "no Market tab until minted out");
  assert.deepEqual(tabsFor(opened), ["market", "mine"], "minted out: Market first (the default) — mines credit 0");
  assert.deepEqual(tabsFor(null), ["mine"]);
  assert.equal(defaultTab(closed), "mine");
  assert.equal(defaultTab(opened), "market");

  assert.deepEqual(resolveTab(undefined, "LUCKY", closed), { tab: "mine", notice: null });
  assert.deepEqual(resolveTab("mine", "LUCKY", closed), { tab: "mine", notice: null });
  const r = resolveTab("market", "LUCKY", closed);
  assert.equal(r.tab, "mine", "?tab=market on a token that is not minted out → the mine console");
  assert.equal(r.notice, "Market opens when LUCKY is fully minted · 5.88% minted");
  assert.deepEqual(resolveTab("buy", "LUCKY", closed), { tab: "mine", notice: null }, "stale tabs → default, no notice");
  assert.deepEqual(resolveTab(undefined, "BLOK", opened), { tab: "market", notice: null }, "minted out: Market by default");
  assert.deepEqual(resolveTab("market", "BLOK", opened), { tab: "market", notice: null });
  assert.deepEqual(resolveTab("mine", "BLOK", opened), { tab: "mine", notice: null }, "the console stays reachable");
  assert.deepEqual(resolveTab("sell", "BLOK", opened), { tab: "market", notice: null });

  assert.equal(marketClosedNotice("VOLT", row("VOLT", 0)), "Market opens when VOLT is fully minted · 0% minted");
  assert.equal(marketClosedNotice("SATS", row("SATS", 8_400_000)), "Market opens when SATS is fully minted · 40% minted", "trailing zeros trimmed");
  assert.equal(marketClosedNotice("X", null), "Market opens when X is fully minted", "no token yet → no share");
  assert.equal(mintedProgressNote(closed), "Market opens at 100% · minted 1,234,567 of 21,000,000");
  assert.equal(mintedProgressNote(null), "Market opens at 100%");
  console.log("marketpage tabs: Market tab only when minted out; ?tab=market resolves to Mine with the notice");
}

// ---- finality: minted out, but the market opens only when the completing block is 6 deep ---------------
{
  const pending = row("DUNE", S, { minted_out_height: 969_798, market_open: false, market_opens_at_height: 969_803 });
  assert.equal(MARKET_OPEN_DELAY, 5, "opens at minted_out_height + 5: that block then has 6 confirmations");
  assert.deepEqual([isMintedOut(pending), isMarketOpen(pending), isMarketPending(pending)], [true, false, true]);
  assert.equal(marketOpensAt(pending), 969_803);
  assert.equal(marketOpensAt({ ...pending, market_opens_at_height: undefined }), 969_803, "derived from minted_out_height when the row does not say");
  assert.deepEqual(tabsFor(pending), ["mine"], "no Market tab before it opens");
  assert.equal(defaultTab(pending), "mine");
  const r = resolveTab("market", "DUNE", pending);
  assert.equal(r.tab, "mine");
  assert.equal(r.notice, "DUNE is minted out — the market opens at block #969,803, once the block that completed the supply has 6 confirmations.");
  assert.equal(marketPendingText(pending), r.notice);
  assert.equal(mintedProgressNote(pending), "Minted out · market opens at block #969,803");
  const { open, next } = partitionMarkets([row("BLOK", S), pending, row("SATS", 8_400_000)]);
  assert.deepEqual(open.map((t) => t.ticker), ["BLOK"]);
  assert.deepEqual(next.map((t) => t.ticker), ["DUNE", "SATS"], "a minted-out token waiting for depth leads the next-to-open strip");
  assert.deepEqual(mintedOutFirst([pending, row("BLOK", S)]).map((t) => t.ticker), ["BLOK", "DUNE"], "open markets first");
  // the sanitizer: the indexer's gate, else (a row from before the field) the older rule
  const base = { ticker: "DUNE", supply: S, minted: S, deployer: "", deploy_txid: "a".repeat(64), deploy_block: 969_700, minted_out: true, minted_out_height: 969_798 };
  const clean = _sanitizeTokenRow({ ...base, market_open: false, market_opens_at_height: 969_803 });
  assert.deepEqual([clean.market_open, clean.market_opens_at_height], [false, 969_803]);
  assert.deepEqual([_sanitizeTokenRow(base).market_open, _sanitizeTokenRow(base).market_opens_at_height], [true, 969_803], "no field: open when minted out; the height derived");
  assert.equal(_sanitizeTokenRow({ ...base, minted: 5, minted_out: false, market_open: true }).market_open, false, "never open before minted out");
  console.log("marketpage depth gate: minted out opens the market only once the completing block has 6 confirmations");
}

console.log("marketpage: all checks passed");
