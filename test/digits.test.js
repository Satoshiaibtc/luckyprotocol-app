// src/lib/digits.js — the probability board's pure helpers. Plain Node.
import assert from "node:assert/strict";
import {
  BLOCKS_PER_DAY,
  DAYS_DEFAULT,
  DAYS_MAX,
  DIGITS_DEFAULT,
  DIGITS_MAX,
  GRID_ROWS,
  plateRows,
  visibleColumns,
  TIERS,
  WINDOWS,
  blocksSinceTier,
  chiSquare,
  cumulativeMeanYield,
  currentRun,
  digitCounts,
  expectedRunLength,
  geometricTail,
  gridLayout,
  gridLayoutRows,
  logGamma,
  longestRunPerTier,
  meanRunLengthPerTier,
  meanYield,
  pValueChiSquare,
  regularizedGammaQ,
  roadColumns,
  roadWidth,
  latestRoad,
  rollingMeanYield,
  runs,
  standardError,
  tierCounts,
  tierOf,
  tierProbability,
  wilson,
  windowLabel,
  yieldOfDigit,
  yieldOfTier,
} from "../src/lib/digits.js";
import { BUCKETS, EXPECTED_YIELD, YIELD_SD } from "../src/lib/yield.js";

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} expected ${b} ± ${eps}, got ${a}`);

// ---- constants ------------------------------------------------------------------------------
assert.equal(DIGITS_MAX, 10_080);
assert.equal(DIGITS_DEFAULT, 1008);
assert.equal(DAYS_DEFAULT, 7);
assert.equal(DAYS_MAX, 60);
assert.equal(BLOCKS_PER_DAY, 144);
assert.equal(GRID_ROWS, 6);

// ---- visibleColumns ---------------------------------------------------------------------------
{
  assert.equal(visibleColumns(0, 800, 26, 0), null, "nothing to draw");
  assert.deepEqual(visibleColumns(0, 800, 26, 10), { first: 0, last: 9 }, "fits → everything");
  assert.deepEqual(visibleColumns(0, 520, 26, 1680, 0), { first: 0, last: 20 }, "0..520 px → columns 0..20");
  assert.deepEqual(visibleColumns(43_160, 520, 26, 1680, 8), { first: 1652, last: 1679 }, "scrolled to the end, clamped");
  assert.deepEqual(visibleColumns(2600, 520, 26, 1680, 8), { first: 92, last: 128 });
  assert.deepEqual(visibleColumns(NaN, 520, 26, 30), { first: 0, last: 29 }, "bad scroll → whole range");
  assert.deepEqual(visibleColumns(-50, 520, 26, 1680, 0), { first: 0, last: 20 }, "negative scroll (overscroll) → from 0");
  console.log("visibleColumns: in-view column range with a buffer, clamped");
}

// ---- plateRows -------------------------------------------------------------------------------
{
  assert.equal(plateRows(0, 1200), GRID_ROWS, "empty → default rows");
  assert.equal(plateRows(144, NaN), GRID_ROWS, "bad width → default rows");
  assert.equal(plateRows(144, 1194), 6, "a day fits at 6 rows on a desktop (24 cols × 49 px)");
  assert.equal(plateRows(1008, 1194), 18, "a week: 6 rows → 7 px, 12 → 14 px, 18 → 21 px ≥ 16");
  assert.equal(plateRows(144, 310), 12, "a day on a phone: 6 rows → 12 px, 12 rows → 25 px");
  assert.equal(plateRows(8640, 1194), 36, "nothing fits → the densest layout (scrolls)");
  assert.equal(plateRows(16, 1194, 16), 6);
  console.log("plateRows: smallest row count that keeps cells ≥ 16 px, else 36");
}
// Windows are by real time: days + label, never a block count.
assert.deepEqual(WINDOWS, [
  { days: 7, label: "1 week" },
  { days: 30, label: "30 days" },
  { days: 60, label: "60 days" },
]);
assert.ok(WINDOWS.every((w) => !("blocks" in w)), "no block counts on the chips");
assert.ok(WINDOWS.some((w) => w.days === DAYS_DEFAULT), "the default is a chip");
assert.equal(Math.max(...WINDOWS.map((w) => w.days)), DAYS_MAX);
assert.deepEqual(TIERS, ["high", "mid", "low", "base"]);
// 70 nominal days of heights: the 60-day window fits even at 168 blocks a day.
assert.equal(DIGITS_MAX, 70 * BLOCKS_PER_DAY);
assert.ok(DIGITS_MAX >= DAYS_MAX * 168);
assert.equal(windowLabel(1), "1 day");
assert.equal(windowLabel(7), "1 week");
assert.equal(windowLabel(60), "60 days");
assert.equal(windowLabel(3), "3 days");
assert.equal(windowLabel(0), "");
assert.equal(windowLabel("x"), "");

// ---- tier / yield lookups (from BUCKETS, never re-derived) ----------------------------------
assert.equal(tierOf("f"), "high");
assert.equal(tierOf("c"), "mid");
assert.equal(tierOf("e"), "mid");
assert.equal(tierOf("7"), "low");
assert.equal(tierOf("b"), "low");
assert.equal(tierOf("0"), "base");
assert.equal(tierOf("6"), "base");
assert.equal(tierOf("g"), null);
assert.equal(tierOf(""), null);
assert.equal(yieldOfTier("high"), 1000);
assert.equal(yieldOfTier("base"), 100);
assert.equal(yieldOfTier("nope"), null);
assert.equal(yieldOfDigit("f"), 1000);
assert.equal(yieldOfDigit("z"), null);
assert.equal(tierProbability("high"), 1 / 16);
assert.equal(tierProbability("base"), 7 / 16);
assert.equal(tierProbability("x"), null);
for (const b of BUCKETS) for (const d of b.digits) assert.equal(tierOf(d), b.id);

// ---- gridLayout -----------------------------------------------------------------------------
{
  assert.deepEqual(gridLayout(""), []);
  assert.deepEqual(gridLayout(null), []);
  assert.deepEqual(gridLayout("xyz"), [], "non-hex → empty");
  const g = gridLayout("0123456789abcd", 6);
  assert.equal(g.length, 3, "14 cells → 3 columns of 6");
  assert.equal(g[0].length, 6);
  assert.equal(g[2].length, 2);
  assert.deepEqual(g[0][0], { digit: "0", tier: "base", index: 0 });
  assert.deepEqual(g[1][0], { digit: "6", tier: "base", index: 6 }, "column 2 starts at index 6 — filled top-to-bottom, then left-to-right");
  assert.deepEqual(g[2][1], { digit: "d", tier: "mid", index: 13 }, "newest is the last cell of the last column");
  assert.equal(gridLayout("ff", 1).length, 2, "rows = 1 → one cell per column");
  assert.equal(gridLayout("FF").length, 1, "upper case accepted");
}

// ---- gridLayoutRows (row-major: left to right, then the next row) ----------------------------
{
  assert.deepEqual(gridLayoutRows(""), []);
  assert.deepEqual(gridLayoutRows(null), []);
  assert.deepEqual(gridLayoutRows("xyz"), [], "non-hex → empty");
  const g = gridLayoutRows("0123456789abcd", 3); // 14 cells, 3 rows → 5 columns
  assert.equal(g.length, 5);
  assert.deepEqual(g[0].map((k) => [k.index, k.row]), [[0, 0], [5, 1], [10, 2]], "column 0 holds 0, 5, 10");
  assert.deepEqual(g[1][0], { digit: "1", tier: "base", index: 1, row: 0 }, "row 0 runs left to right: index 1 is column 1");
  assert.deepEqual(g[4].map((k) => [k.index, k.row]), [[4, 0], [9, 1]], "the last row is partly filled");
  assert.deepEqual(g[3][2], { digit: "d", tier: "mid", index: 13, row: 2 }, "newest = last row, column 13 % 5 = 3");
  const n = 1008;
  const big = gridLayoutRows("0".repeat(n), 18);
  assert.equal(big.length, 56);
  assert.equal(big.flat().length, n, "every block placed exactly once");
  assert.ok(big.flat().every((k) => k.index === k.row * 56 + big.findIndex((col) => col.includes(k))), "index = row × width + column");
  console.log("gridLayoutRows: row-major, oldest top-left, newest in the last row");
}

// ---- runs -----------------------------------------------------------------------------------
{
  assert.deepEqual(runs(""), []);
  assert.deepEqual(runs("f"), [{ tier: "high", start: 0, length: 1 }]);
  // 00 (base) 7 (low) cde (mid) f (high) 3 (base)
  assert.deepEqual(runs("007cdef3"), [
    { tier: "base", start: 0, length: 2 },
    { tier: "low", start: 2, length: 1 },
    { tier: "mid", start: 3, length: 3 },
    { tier: "high", start: 6, length: 1 },
    { tier: "base", start: 7, length: 1 },
  ]);
  assert.equal(runs("0123456").length, 1, "the whole base tier is one run");
}

// ---- roadColumns ----------------------------------------------------------------------------
{
  assert.deepEqual(roadColumns([]), []);
  assert.deepEqual(roadColumns(null), []);
  assert.equal(roadWidth([]), 0);

  const r = roadColumns(runs("007cdef3"), 6);
  assert.deepEqual(r.map((c) => [c.col, c.row, c.tier, c.index]), [
    [0, 0, "base", 0],
    [0, 1, "base", 1],
    [1, 0, "low", 2],
    [2, 0, "mid", 3],
    [2, 1, "mid", 4],
    [2, 2, "mid", 5],
    [3, 0, "high", 6],
    [4, 0, "base", 7],
  ]);
  assert.equal(roadWidth(r), 5);

  // latestRoad: the newest columns, re-based to 0; `dropped` counts older columns.
  assert.deepEqual(latestRoad(r, 10), { cells: r, dropped: 0 }, "fits → unchanged");
  const last2 = latestRoad(r, 2);
  assert.equal(last2.dropped, 3);
  assert.deepEqual(last2.cells.map((c) => [c.col, c.row, c.index]), [[0, 0, 6], [1, 0, 7]]);
  assert.deepEqual(latestRoad(null, 5), { cells: [], dropped: 0 });
  assert.deepEqual(latestRoad(r, 0), { cells: r, dropped: 0 }, "bad max → unchanged");

  // Tail: a run of 9 in 6 rows fills the column, then goes right along row 5.
  const tail = roadColumns([{ tier: "base", start: 0, length: 9 }], 6);
  assert.deepEqual(tail.slice(5).map((c) => [c.col, c.row]), [[0, 5], [1, 5], [2, 5], [3, 5]]);
  assert.equal(tail[8].index, 8);

  // The next run starts in the next column (its top cell is free) and turns
  // right when it meets the tail below it.
  const two = roadColumns([{ tier: "base", start: 0, length: 9 }, { tier: "mid", start: 9, length: 7 }], 6);
  const mid = two.filter((c) => c.tier === "mid").map((c) => [c.col, c.row]);
  assert.deepEqual(mid, [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [2, 4], [3, 4]]);
  assert.equal(roadWidth(two), 4);
  // No cell is used twice.
  const keys = new Set(two.map((c) => `${c.col},${c.row}`));
  assert.equal(keys.size, two.length);

  // A tail that crossed row 0 (maxRows = 1) pushes the next run further right.
  const one = roadColumns([{ tier: "low", start: 0, length: 3 }, { tier: "high", start: 3, length: 1 }], 1);
  assert.deepEqual(one.map((c) => [c.col, c.row]), [[0, 0], [1, 0], [2, 0], [3, 0]]);
  assert.equal(roadColumns([{ tier: "low", start: 0, length: 0 }]).length, 0, "zero-length runs are skipped");
}

// ---- counts ---------------------------------------------------------------------------------
{
  assert.deepEqual(digitCounts(""), new Array(16).fill(0));
  const c = digitCounts("0123456789abcdeff");
  assert.equal(c.length, 16);
  assert.equal(c[15], 2);
  assert.equal(c[0], 1);
  assert.equal(c.reduce((s, x) => s + x, 0), 17);
  assert.deepEqual(tierCounts(""), { high: 0, mid: 0, low: 0, base: 0 });
  assert.deepEqual(tierCounts("0123456789abcdef"), { high: 1, mid: 3, low: 5, base: 7 });
  assert.deepEqual(tierCounts("zz"), { high: 0, mid: 0, low: 0, base: 0 }, "non-hex → zeros");
}

// ---- chi-square + p-value -------------------------------------------------------------------
{
  assert.equal(chiSquare([], 1), null);
  assert.equal(chiSquare([1, 2], 0), null);
  assert.equal(chiSquare(null, 1), null);
  assert.equal(chiSquare([NaN], 1), null);
  assert.equal(chiSquare([5, 5, 5, 5], 5), 0, "perfect fit → 0");
  assert.equal(chiSquare([10, 0], 5), 10, "(25 + 25) / 5");
  const uniform = new Array(16).fill(63);
  assert.equal(chiSquare(uniform, 63), 0);

  near(logGamma(1), 0, 1e-12, "Γ(1) = 1");
  near(logGamma(5), Math.log(24), 1e-12, "Γ(5) = 24");
  near(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-12, "Γ(½) = √π");
  assert.equal(logGamma(0), null);
  assert.equal(logGamma(-1), null);

  assert.equal(regularizedGammaQ(1, 0), 1);
  near(regularizedGammaQ(1, 1), Math.exp(-1), 1e-12, "Q(1, x) = e^−x");
  near(regularizedGammaQ(1, 5), Math.exp(-5), 1e-12, "Q(1, x) = e^−x (continued fraction branch)");
  assert.equal(regularizedGammaQ(0, 1), null);
  assert.equal(regularizedGammaQ(1, -1), null);

  // Known critical values.
  near(pValueChiSquare(24.996, 15), 0.05, 0.002, "df 15 · 5 %");
  near(pValueChiSquare(30.578, 15), 0.01, 0.001, "df 15 · 1 %");
  near(pValueChiSquare(3.841, 1), 0.05, 0.001, "df 1 · 5 %");
  near(pValueChiSquare(7.815, 3), 0.05, 0.001, "df 3 · 5 %");
  assert.equal(pValueChiSquare(0, 15), 1, "stat 0 → p = 1");
  near(pValueChiSquare(100, 15), 0, 1e-10, "far tail → ~0");
  assert.equal(pValueChiSquare(null, 15), null);
  assert.equal(pValueChiSquare(-1, 15), null);
  assert.equal(pValueChiSquare(5, 0), null);
  assert.equal(pValueChiSquare(NaN, 15), null);
  // Monotone in the statistic.
  assert.ok(pValueChiSquare(10, 15) > pValueChiSquare(20, 15));
  assert.ok(pValueChiSquare(20, 15) > pValueChiSquare(30, 15));
}

// ---- Wilson ---------------------------------------------------------------------------------
{
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 1 });
  assert.equal(wilson(5, 2), null, "k > n is malformed");
  assert.equal(wilson(-1, 2), null);
  assert.equal(wilson(NaN, 2), null);
  const w = wilson(10, 100);
  near(w.lo, 0.0552, 0.001, "wilson lo");
  near(w.hi, 0.1744, 0.001, "wilson hi");
  const z = wilson(0, 10);
  assert.equal(z.lo, 0, "0 of n → lo 0");
  assert.ok(z.hi > 0 && z.hi < 0.35);
  const f = wilson(10, 10);
  assert.equal(f.hi, 1, "n of n → hi 1");
  assert.ok(f.lo > 0.65 && f.lo < 1);
  // Narrower with more data.
  const a = wilson(63, 1008);
  const b = wilson(9, 144);
  assert.ok(a.hi - a.lo < b.hi - b.lo);
}

// ---- runs and gaps --------------------------------------------------------------------------
{
  assert.equal(geometricTail(1 / 16, 0), 1);
  near(geometricTail(1 / 16, 16), Math.pow(15 / 16, 16), 1e-15, "geometric tail");
  assert.equal(geometricTail(2, 1), null);
  assert.equal(geometricTail(0.5, -1), null);
  assert.equal(expectedRunLength(0), 1);
  near(expectedRunLength(1 / 16), 16 / 15, 1e-15, "high runs");
  near(expectedRunLength(7 / 16), 16 / 9, 1e-15, "base runs");
  assert.equal(expectedRunLength(1), null);

  assert.equal(blocksSinceTier("", "high"), null);
  assert.equal(blocksSinceTier("0000", "high"), null, "never in window");
  assert.equal(blocksSinceTier("000f", "high"), 0, "newest block is in the tier");
  assert.equal(blocksSinceTier("f000", "high"), 3);
  assert.equal(blocksSinceTier("f0f0", "high"), 1);

  const r = runs("007cdef3");
  assert.deepEqual(longestRunPerTier(r), { high: 1, mid: 3, low: 1, base: 2 });
  assert.deepEqual(longestRunPerTier([]), { high: 0, mid: 0, low: 0, base: 0 });
  assert.deepEqual(longestRunPerTier(null), { high: 0, mid: 0, low: 0, base: 0 });
  assert.deepEqual(meanRunLengthPerTier(r), { high: 1, mid: 3, low: 1, base: 1.5 });
  assert.deepEqual(meanRunLengthPerTier([]), { high: null, mid: null, low: null, base: null });
  assert.deepEqual(currentRun(r), { tier: "base", start: 7, length: 1 });
  assert.equal(currentRun([]), null);
  assert.equal(currentRun(null), null);
}

// ---- yield series ---------------------------------------------------------------------------
{
  assert.deepEqual(cumulativeMeanYield(""), []);
  assert.deepEqual(cumulativeMeanYield("f0"), [1000, 550]);
  assert.deepEqual(cumulativeMeanYield("0c7"), [100, 300, (100 + 500 + 200) / 3]);
  assert.deepEqual(rollingMeanYield("", 3), []);
  assert.deepEqual(rollingMeanYield("f0c7", 2), [null, 550, 300, 350]);
  assert.deepEqual(rollingMeanYield("ff", 1), [1000, 1000]);
  assert.deepEqual(rollingMeanYield("f0", 5), [null, null], "window larger than the record → all null");
  assert.equal(rollingMeanYield("f0c7", 144).length, 4);
  for (const v of rollingMeanYield("0123456789abcdef".repeat(20), 144)) assert.ok(v === null || Number.isFinite(v));

  assert.equal(meanYield(""), null);
  assert.equal(meanYield("0123456789abcdef"), EXPECTED_YIELD, "one of each digit → the model mean exactly");
  assert.equal(EXPECTED_YIELD, 262.5);

  assert.equal(standardError(0), null);
  assert.equal(standardError(-3), null);
  near(standardError(1), YIELD_SD, 1e-12, "n = 1 → σ");
  near(standardError(4), YIELD_SD / 2, 1e-12, "n = 4 → σ / 2");
  near(standardError(1008), Math.sqrt((YIELD_SD * YIELD_SD) / 1008), 1e-12, "n = 1008");
}

// ---- totality: nothing returns NaN ---------------------------------------------------------
{
  const hasNaN = (v) => (typeof v === "number" ? Number.isNaN(v) : Array.isArray(v) ? v.some(hasNaN) : v && typeof v === "object" ? Object.values(v).some(hasNaN) : false);
  for (const input of ["", null, undefined, 42, "zz", "f", "0123456789abcdef"]) {
    assert.equal(hasNaN(gridLayout(input)), false);
    assert.equal(hasNaN(runs(input)), false);
    assert.equal(hasNaN(roadColumns(runs(input))), false);
    assert.equal(hasNaN(digitCounts(input)), false);
    assert.equal(hasNaN(tierCounts(input)), false);
    assert.equal(hasNaN(cumulativeMeanYield(input)), false);
    assert.equal(hasNaN(rollingMeanYield(input, 3)), false);
    assert.equal(hasNaN(meanYield(input)), false);
    assert.equal(hasNaN(blocksSinceTier(input, "high")), false);
    const counts = digitCounts(input);
    const n = counts.reduce((s, x) => s + x, 0);
    const stat = chiSquare(counts, n / 16);
    assert.equal(hasNaN(stat), false);
    assert.equal(hasNaN(pValueChiSquare(stat, 15)), false);
    for (const t of TIERS) assert.equal(hasNaN(wilson(tierCounts(input)[t], n)), false);
  }
  assert.equal(hasNaN(standardError(NaN)), false);
  assert.equal(hasNaN(geometricTail(NaN, 1)), false);
  assert.equal(hasNaN(expectedRunLength(NaN)), false);
}

console.log("digits: ok");
