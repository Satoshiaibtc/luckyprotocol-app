// Pure-part tests for src/lib/activity.js: UTC day bucketing, the daily
// aggregation the mock serves (and the indexer mirrors), the bar + line
// series/layout, the ledger's party cell and the address-search gate.
// Plain Node, no framework.
import assert from "node:assert/strict";
import {
  DAILY_DAYS,
  DAILY_PAD,
  KINDS,
  METRICS,
  activityParties,
  aggregateDaily,
  dailyLayout,
  dailySeries,
  fillDays,
  isSearchableAddress,
  lastNDays,
  nearestBar,
  niceCountTicks,
  utcDay,
} from "../src/lib/activity.js";

const A = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const B = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const C = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
const T = (i) => "ab".repeat(31) + String(i).padStart(2, "0");
const NOW = 1790452492; // 2026-09-26T09:14:52Z

// ---- days ---------------------------------------------------------------------------------
{
  assert.equal(utcDay(NOW), "2026-09-26");
  assert.equal(utcDay(0), "1970-01-01");
  assert.equal(utcDay(NaN), null);
  assert.deepEqual(lastNDays(3, NOW), ["2026-09-24", "2026-09-25", "2026-09-26"], "ascending, ending today (UTC)");
  assert.equal(lastNDays(30, NOW).length, 30);
  assert.equal(DAILY_DAYS, 30);
  const filled = fillDays([{ date: "2026-09-25", events: 4, deploys: 0, mines: 4, sends: 0, trades: 0, active_addresses: 2, token_amount: 900, volume_sats: 0 }], 3, NOW);
  assert.deepEqual(filled.map((r) => [r.date, r.events]), [["2026-09-24", 0], ["2026-09-25", 4], ["2026-09-26", 0]], "one row per day, zero rows for missing days");
  console.log("activity days: UTC calendar days, window filled with zero rows");
}

// ---- aggregation ----------------------------------------------------------------------------
{
  const day = (d, h = 12) => NOW - d * 86_400 - (9 - h) * 3600;
  const items = [
    { kind: "deploy", txid: T(1), block_height: 100, block_time: day(1), ticker: "X", amount: 21_000_000, deployer: A, sender: A },
    { kind: "mine", txid: T(2), block_height: 101, block_time: day(1), ticker: "X", amount: 500, sender: B },
    { kind: "mine", txid: T(3), block_height: 102, block_time: day(1), ticker: "X", amount: 100, sender: B },
    { kind: "mine", txid: T(9), block_height: 102, block_time: day(1), ticker: "X", amount: 0, applied: false, sender: B }, // invalid MINE
    { kind: "send", txid: T(4), block_height: 103, block_time: day(0), ticker: "X", amount: 40, from: B, sender: B, to: C },
    { kind: "send", txid: T(10), block_height: 103, block_time: day(0), ticker: "X", amount: 70, applied: false, from: B, sender: B, to: C }, // not applied
    { kind: "trade", txid: T(5), block_height: 104, block_time: day(0), ticker: "X", amount: 200, buyer: A, seller: C, price_sats: 10_000, unit_price: 50, self_trade: false },
    { kind: "trade", txid: T(6), block_height: 105, block_time: day(0), ticker: "X", amount: 10, buyer: C, seller: C, price_sats: 999_999, unit_price: 99_999, self_trade: true },
    { kind: "mine", txid: T(7), block_height: 1, block_time: day(45), ticker: "X", amount: 100, sender: B }, // outside the window
    { kind: "mine", txid: T(8), block_height: 2, block_time: null, ticker: "X", amount: 100, sender: B },   // no time → skipped
  ];
  const rows = aggregateDaily(items, { days: 30, now: NOW });
  assert.deepEqual(rows.map((r) => r.date), ["2026-09-25", "2026-09-26"], "ascending, only days with events");
  const [y, t] = rows;
  assert.deepEqual(y, { date: "2026-09-25", events: 4, deploys: 1, mines: 3, sends: 0, trades: 0, active_addresses: 2, token_amount: 600, volume_sats: 0 }, "a deploy's supply and an invalid mine's 0 never count as moved tokens");
  assert.equal(t.events, 4);
  assert.equal(t.sends, 2, "a non-applied SEND is still an event…");
  assert.equal(t.trades, 1, "…and a self-trade is an event, not a trade (§5: `trades` excludes self-trades, as the indexer's /activity/daily does)…");
  assert.equal(t.volume_sats, 10_000, "…and never volume (§7.5)");
  assert.equal(t.active_addresses, 3, "distinct parties across from/to/buyer/seller");
  assert.equal(t.token_amount, 240, "applied send 40 + non-self trade 200; the non-applied send and the self-trade are excluded");
  assert.deepEqual(aggregateDaily([], { now: NOW }), []);
  assert.deepEqual(aggregateDaily(null, { now: NOW }), []);
  console.log("activity aggregate: per-UTC-day counts, distinct addresses, self-trade volume excluded, window respected");
}

// ---- series + layout -------------------------------------------------------------------------
{
  const rows = fillDays([
    { date: "2026-09-24", events: 5, deploys: 0, mines: 5, sends: 0, trades: 0, active_addresses: 3, token_amount: 0, volume_sats: 100 },
    { date: "2026-09-26", events: 2, deploys: 0, mines: 1, sends: 1, trades: 0, active_addresses: 2, token_amount: 0, volume_sats: 40 },
  ], 3, NOW);
  const s = dailySeries(rows, "events");
  assert.deepEqual(s.values, [5, 0, 2]);
  assert.deepEqual(s.cumulative, [5, 5, 7]);
  assert.equal(s.total, 7);
  assert.equal(s.max, 5);
  assert.deepEqual(dailySeries(rows, "volume_sats").values, [100, 0, 40]);
  assert.deepEqual(dailySeries(rows, "nope").values, [5, 0, 2], "unknown metric → events");
  assert.deepEqual(METRICS.map((m) => m.id), ["events", "sends", "active_addresses", "volume_sats"]);
  assert.deepEqual(KINDS.map((k) => k.id), ["all", "deploy", "mine", "send", "trade"]);

  const L = dailyLayout({ rows, metric: "events", width: 600, height: 240 });
  assert.equal(L.bars.length, 3);
  const innerW = 600 - DAILY_PAD.left - DAILY_PAD.right;
  assert.equal(L.colW, innerW / 3);
  assert.equal(L.bars[0].y, L.top, "the max bar reaches the top");
  assert.equal(L.bars[1].h, 0, "a zero day is a zero-height bar");
  assert.equal(L.bars[2].h, (2 / 5) * (L.bottom - L.top));
  assert.equal(L.yLine(7), L.top, "the cumulative line ends at the top (its own axis)");
  assert.equal(L.yLine(0), L.bottom);
  assert.match(L.line, /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/, "one point per day");
  assert.deepEqual(L.yTicks.map((t) => t.v), [0, 1, 2, 3, 4, 5]);
  assert.equal(L.xTicks.length, 3, "≤ 8 days: every day labelled");
  assert.equal(L.xTicks[0].label, "09-24");
  assert.equal(nearestBar(L, L.bars[2].x), 2);
  assert.equal(nearestBar(L, -5), 0);
  assert.equal(nearestBar(null, 0), null);
  assert.equal(dailyLayout({ rows: [], metric: "events", width: 600, height: 240 }), null);
  const many = dailyLayout({ rows: fillDays([], 30, NOW), metric: "events", width: 600, height: 240 });
  assert.equal(many.bars.length, 30);
  assert.ok(many.bars.every((b) => b.h === 0), "all-zero month draws flat, no NaN");
  assert.equal(many.xTicks.length, 5, "30 days: weekly labels + the last day — day 28's label, one column from day 29's, is skipped");
  assert.deepEqual(many.xTicks.map((t) => t.i), [0, 7, 14, 21, 29]);
  const narrow = dailyLayout({ rows: fillDays([], 30, NOW), metric: "events", width: 358, height: 220 });
  assert.deepEqual(narrow.xTicks.map((t) => t.i), [0, 7, 14, 21, 29], "phone width: still no label within a label width of the last");
  assert.ok(narrow.xTicks.every((t, k) => k === 0 || t.x - narrow.xTicks[k - 1].x >= 36), "labels ≥ 36px apart");
  assert.deepEqual(niceCountTicks(0), [0]);
  assert.deepEqual(niceCountTicks(23), [0, 5, 10, 15, 20]);
  assert.deepEqual(niceCountTicks(1_234_567), [0, 500000, 1000000], "1-2-5 × 10ⁿ, at most ~4 steps");
  assert.deepEqual(niceCountTicks(1, { integer: true }), [0, 1], "a count axis never shows 0.2");
  assert.deepEqual(niceCountTicks(2, { integer: true }), [0, 1, 2]);
  assert.deepEqual(niceCountTicks(1), [0, 0.2, 0.4, 0.6, 0.8, 1], "sats keep fractional steps");
  const one = dailyLayout({ rows: fillDays([{ date: "2026-09-26", events: 1, deploys: 0, mines: 1, sends: 0, trades: 0, active_addresses: 1, token_amount: 0, volume_sats: 0 }], 3, NOW), metric: "events", width: 600, height: 240 });
  assert.deepEqual(one.yTicks.map((t) => t.v), [0, 1], "events / sends / addresses are integers");
  console.log("activity chart: bars on the metric axis, cumulative line on its own axis, weekly labels at 30 days");
}

// ---- parties + address gate ------------------------------------------------------------------
{
  assert.deepEqual(activityParties({ kind: "send", from: A, to: B }), { left: A, right: B, join: "→" });
  assert.deepEqual(activityParties({ kind: "send", sender: A, to: B }), { left: A, right: B, join: "→" }, "sender doubles as from");
  assert.deepEqual(activityParties({ kind: "trade", buyer: A, seller: B }), { left: A, right: B, join: "←" }, "buyer ← seller");
  assert.deepEqual(activityParties({ kind: "mine", sender: B }), { left: B, right: null, join: null });
  assert.deepEqual(activityParties({ kind: "deploy", deployer: A }), { left: A, right: null, join: null });
  assert.deepEqual(activityParties(null), { left: null, right: null, join: null });
  assert.equal(isSearchableAddress(A), true, "bc1p");
  assert.equal(isSearchableAddress(B), true, "bc1q");
  assert.equal(isSearchableAddress(` ${B} `), true, "trimmed");
  assert.equal(isSearchableAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"), false, "legacy is not connectable, so not searchable");
  assert.equal(isSearchableAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"), false, "testnet");
  assert.equal(isSearchableAddress("bc1"), false);
  assert.equal(isSearchableAddress(""), false);
  assert.equal(isSearchableAddress(null), false);
  console.log("activity ledger: party cells + mainnet bc1 address gate (same rule as the wallet layer)");
}

console.log("activity: all checks passed");
