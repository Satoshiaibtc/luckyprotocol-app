// Probability board — pure helpers over a string of block-hash last digits.
//
// The indexer's GET /digits returns the last hex character of every block
// hash it holds (oldest first). Everything on #/probability is derived here:
// the bead-plate grid, the run columns ("big road"), digit / tier counts,
// the chi-square test against a uniform digit, Wilson intervals, run-length
// statistics and the cumulative / rolling mean yield.
//
// Descriptive only. Each block's digit is independent of the last; nothing
// here predicts the next block. No React, no fetch — plain Node tests in
// test/digits.test.js. Every function is total: empty or malformed input
// gives an empty / neutral result, never NaN (null stands for "undefined").

import { BUCKETS, DIGIT_SPACE, EXPECTED_YIELD, YIELD_SD, bucketOf, probability } from "./yield.js";

/**
 * The most heights /digits will return: 70 days at the nominal 144 blocks a
 * day, so the 60-day window is covered even when blocks come faster than
 * every 10 minutes. It is also the limit clamp of the block-count path.
 */
export const DIGITS_MAX = 10_080;
/** Default of the block-count path (GET /digits?limit), one nominal week. */
export const DIGITS_DEFAULT = 1008;
/** Nominal blocks per day — only the rolling-mean span; windows are by time. */
export const BLOCKS_PER_DAY = 144;
/** Bead-plate / road height. */
export const GRID_ROWS = 6;

/**
 * The window chips, by real time (GET /digits?days=N). Blocks per day are
 * not fixed, so a window holds however many blocks were mined in it and
 * the chips never show a block count. No 1-day chip: its grid would be
 * the one window whose size does not match the others.
 */
export const WINDOWS = [
  { days: 7, label: "1 week" },
  { days: 30, label: "30 days" },
  { days: 60, label: "60 days" },
];
/** Default window: one week. */
export const DAYS_DEFAULT = 7;
/** Longest window /digits?days accepts (larger values are clamped). */
export const DAYS_MAX = 60;

/** Label of a window in days ("1 week"), or "N days" for one not on a chip. */
export function windowLabel(days) {
  const d = Math.floor(Number(days));
  const w = WINDOWS.find((x) => x.days === d);
  if (w) return w.label;
  return d > 0 ? `${d} day${d === 1 ? "" : "s"}` : "";
}

/** Tier ids in yield order, high → base. */
export const TIERS = BUCKETS.map((b) => b.id);

const BY_ID = new Map(BUCKETS.map((b) => [b.id, b]));
const HEX = "0123456789abcdef";

/** Tier id ("high" | "mid" | "low" | "base") of a last hex digit, or null. */
export function tierOf(digit) {
  const b = bucketOf(digit);
  return b ? b.id : null;
}

/** Yield of a tier id, or null for an unknown tier. */
export function yieldOfTier(tier) {
  const b = BY_ID.get(tier);
  return b ? b.yield : null;
}

/** Yield of a last hex digit, or null. */
export function yieldOfDigit(digit) {
  const b = bucketOf(digit);
  return b ? b.yield : null;
}

/** Model probability of a tier (count / 16), or null. */
export function tierProbability(tier) {
  const b = BY_ID.get(tier);
  return b ? probability(b) : null;
}

/** Lower-case hex string or "" — the one input normaliser. */
function clean(digits) {
  if (typeof digits !== "string") return "";
  const s = digits.toLowerCase();
  return /^[0-9a-f]*$/.test(s) ? s : "";
}

// ---- layouts ---------------------------------------------------------------------------------

/**
 * Bead plate: columns of `rows` cells, filled top-to-bottom then
 * left-to-right — oldest top-left, newest bottom-right (or wherever the
 * last column ends). Each cell: { digit, tier, index }.
 */
/**
 * Columns [first, last] (inclusive) a horizontal scroller shows at
 * `scrollLeft` over a `viewWidth`-wide viewport of `cell`-px columns, padded
 * by `buffer` columns each side and clamped to [0, totalCols − 1]. Returns
 * null when there is nothing to draw. Total: bad numbers → the whole range.
 */
export function visibleColumns(scrollLeft, viewWidth, cell, totalCols, buffer = 8) {
  const total = Math.floor(Number(totalCols));
  if (!(total > 0)) return null;
  const c = Number(cell);
  const left = Number(scrollLeft);
  const width = Number(viewWidth);
  const pad = Math.max(0, Math.floor(Number(buffer) || 0));
  if (!(c > 0) || !Number.isFinite(left) || !(width > 0)) return { first: 0, last: total - 1 };
  const first = Math.max(0, Math.floor(Math.max(0, left) / c) - pad);
  const last = Math.min(total - 1, Math.ceil((Math.max(0, left) + width) / c) + pad);
  return first <= last ? { first, last } : null;
}

/** Row counts the bead plate may use, smallest first. */
export const PLATE_ROWS = [6, 12, 18, 24, 36];

/**
 * Rows for the bead plate: the smallest count in PLATE_ROWS whose columns
 * fit `width` at `minCell` px or more (so digit glyphs stay legible without
 * scrolling); the largest count when none fits (dense cells, the panel
 * scrolls). Total: bad input → GRID_ROWS.
 */
export function plateRows(n, width, minCell = 16) {
  const count = Math.floor(Number(n));
  const w = Number(width);
  const min = Number(minCell);
  if (!(count > 0) || !(w > 0) || !(min > 0)) return GRID_ROWS;
  for (const r of PLATE_ROWS) {
    if (Math.floor(w / Math.ceil(count / r)) >= min) return r;
  }
  return PLATE_ROWS[PLATE_ROWS.length - 1];
}

export function gridLayout(digits, rows = GRID_ROWS) {
  const s = clean(digits);
  const r = Math.max(1, Math.floor(Number(rows) || GRID_ROWS));
  const cols = [];
  for (let i = 0; i < s.length; i++) {
    const c = Math.floor(i / r);
    if (!cols[c]) cols[c] = [];
    cols[c].push({ digit: s[i], tier: tierOf(s[i]), index: i });
  }
  return cols;
}

/**
 * Row-major layout for the digit grid: blocks run left to right, then wrap
 * to the next row — oldest top-left, newest in the last row. `rows` rows
 * of ceil(n / rows) columns; block i sits at row
 * floor(i / width), column i % width. Returned as columns (so only the
 * columns in view need drawing), each cell { digit, tier, index, row }.
 */
export function gridLayoutRows(digits, rows = GRID_ROWS) {
  const s = clean(digits);
  if (!s.length) return [];
  const r = Math.max(1, Math.floor(Number(rows) || GRID_ROWS));
  const width = Math.ceil(s.length / r);
  const cols = Array.from({ length: width }, () => []);
  for (let i = 0; i < s.length; i++) {
    cols[i % width].push({ digit: s[i], tier: tierOf(s[i]), index: i, row: Math.floor(i / width) });
  }
  return cols;
}

/** Runs of consecutive blocks in the same tier: [{ tier, start, length }]. */
export function runs(digits) {
  const s = clean(digits);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const t = tierOf(s[i]);
    const last = out[out.length - 1];
    if (last && last.tier === t) last.length += 1;
    else out.push({ tier: t, start: i, length: 1 });
  }
  return out;
}

/**
 * "Big road" layout. Each run is a column of up to `maxRows` cells; a run
 * longer than that continues to the RIGHT along its last row (the tail),
 * and the next run starts in the next column whose top cell is free. A
 * run that meets an occupied cell below it also turns right. Returns
 * explicit cells { col, row, tier, index } so the renderer stays dumb.
 */
export function roadColumns(runList, maxRows = GRID_ROWS) {
  const rows = Math.max(1, Math.floor(Number(maxRows) || GRID_ROWS));
  const list = Array.isArray(runList) ? runList : [];
  const used = new Set();
  const key = (c, r) => `${c},${r}`;
  const cells = [];
  let startCol = -1;
  for (const run of list) {
    const len = Math.max(0, Math.floor(Number(run && run.length) || 0));
    if (len === 0) continue;
    // Next column whose top cell is free (a tail from an earlier run may
    // have crossed row 0).
    let col = startCol + 1;
    while (used.has(key(col, 0))) col += 1;
    startCol = col;
    let row = 0;
    for (let i = 0; i < len; i++) {
      if (i > 0) {
        if (row + 1 < rows && !used.has(key(col, row + 1))) {
          row += 1;
        } else {
          col += 1;
          while (used.has(key(col, row))) col += 1;
        }
      }
      used.add(key(col, row));
      cells.push({ col, row, tier: run.tier ?? null, index: (run.start ?? 0) + i });
    }
  }
  return cells;
}

/**
 * The newest `maxCols` columns of a road layout, re-based to column 0.
 * Returns { cells, dropped } where `dropped` counts the older columns left
 * out (0 when everything fits). Total: bad input → { cells: [], dropped: 0 }.
 */
export function latestRoad(cells, maxCols) {
  const list = Array.isArray(cells) ? cells : [];
  const max = Math.floor(Number(maxCols));
  const width = roadWidth(list);
  if (!(max > 0) || width <= max) return { cells: list, dropped: 0 };
  const first = width - max;
  return { cells: list.filter((c) => c.col >= first).map((c) => ({ ...c, col: c.col - first })), dropped: first };
}

/** Number of columns a road layout spans (0 for none). */
export function roadWidth(cells) {
  let w = 0;
  for (const c of Array.isArray(cells) ? cells : []) if (c.col + 1 > w) w = c.col + 1;
  return w;
}

// ---- counts ----------------------------------------------------------------------------------

/** 16 counts in "0".."f" order. */
export function digitCounts(digits) {
  const s = clean(digits);
  const counts = new Array(DIGIT_SPACE).fill(0);
  for (let i = 0; i < s.length; i++) counts[HEX.indexOf(s[i])] += 1;
  return counts;
}

/** One count per tier id: { high, mid, low, base }. */
export function tierCounts(digits) {
  const s = clean(digits);
  const counts = Object.fromEntries(TIERS.map((t) => [t, 0]));
  for (let i = 0; i < s.length; i++) {
    const t = tierOf(s[i]);
    if (t) counts[t] += 1;
  }
  return counts;
}

// ---- statistics ------------------------------------------------------------------------------

/** Pearson statistic Σ (o − e)² / e against the same expectation in every cell; null if undefined. */
export function chiSquare(counts, expectedEach) {
  const e = Number(expectedEach);
  if (!Array.isArray(counts) || counts.length === 0 || !(e > 0) || !Number.isFinite(e)) return null;
  let stat = 0;
  for (const c of counts) {
    const o = Number(c);
    if (!Number.isFinite(o)) return null;
    stat += ((o - e) * (o - e)) / e;
  }
  return stat;
}

// Lanczos approximation (g = 7, n = 9) — accurate to ~1e-15 for real z > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(z) for z > 0. */
export function logGamma(z) {
  if (!(z > 0) || !Number.isFinite(z)) return null;
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let a = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// P(a, x) by its series — converges fast for x < a + 1.
function gammaPSeries(a, x) {
  let term = 1 / a;
  let sum = term;
  for (let n = 1; n < 1000; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

// Q(a, x) by its continued fraction (modified Lentz) — for x ≥ a + 1.
function gammaQFraction(a, x) {
  const TINY = 1e-300;
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularized upper incomplete gamma Q(a, x) = Γ(a, x) / Γ(a); null when undefined. */
export function regularizedGammaQ(a, x) {
  if (!(a > 0) || !(x >= 0) || !Number.isFinite(a) || !Number.isFinite(x)) return null;
  if (x === 0) return 1;
  const q = x < a + 1 ? 1 - gammaPSeries(a, x) : gammaQFraction(a, x);
  return Math.min(1, Math.max(0, q));
}

/** Upper tail of the chi-square distribution: P(X² ≥ stat) = Q(df / 2, stat / 2). */
export function pValueChiSquare(stat, df) {
  if (stat === null || stat === undefined || !Number.isFinite(Number(stat)) || Number(stat) < 0) return null;
  if (!(df > 0) || !Number.isFinite(Number(df))) return null;
  return regularizedGammaQ(Number(df) / 2, Number(stat) / 2);
}

/** Wilson score interval for k of n at z (95 % by default). n = 0 → { 0, 1 }; malformed → null. */
export function wilson(k, n, z = 1.96) {
  const kk = Number(k);
  const nn = Number(n);
  if (!Number.isFinite(kk) || !Number.isFinite(nn) || nn < 0 || kk < 0 || kk > nn) return null;
  if (nn === 0) return { lo: 0, hi: 1 };
  const p = kk / nn;
  const z2 = z * z;
  const denom = 1 + z2 / nn;
  const centre = (p + z2 / (2 * nn)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / nn + z2 / (4 * nn * nn))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// ---- runs and gaps ---------------------------------------------------------------------------

/** (1 − p)^k — the model share of windows in which k consecutive blocks miss a tier of probability p. */
export function geometricTail(p, k) {
  const pp = Number(p);
  const kk = Number(k);
  if (!(pp >= 0 && pp <= 1) || !(kk >= 0) || !Number.isFinite(kk)) return null;
  return Math.pow(1 - pp, kk);
}

/** Model mean length of a run in a tier of probability p: 1 / (1 − p). */
export function expectedRunLength(p) {
  const pp = Number(p);
  if (!(pp >= 0 && pp < 1)) return null;
  return 1 / (1 - pp);
}

/** Blocks after the last block of `tier` (0 when the newest block is in it); null if never in the window. */
export function blocksSinceTier(digits, tier) {
  const s = clean(digits);
  for (let i = s.length - 1; i >= 0; i--) if (tierOf(s[i]) === tier) return s.length - 1 - i;
  return null;
}

/** Longest run per tier id (0 when the tier never occurs). */
export function longestRunPerTier(runList) {
  const out = Object.fromEntries(TIERS.map((t) => [t, 0]));
  for (const r of Array.isArray(runList) ? runList : []) {
    if (r && r.tier in out && r.length > out[r.tier]) out[r.tier] = r.length;
  }
  return out;
}

/** Mean run length per tier id (null when the tier never occurs). */
export function meanRunLengthPerTier(runList) {
  const sum = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const n = Object.fromEntries(TIERS.map((t) => [t, 0]));
  for (const r of Array.isArray(runList) ? runList : []) {
    if (r && r.tier in sum) {
      sum[r.tier] += r.length;
      n[r.tier] += 1;
    }
  }
  return Object.fromEntries(TIERS.map((t) => [t, n[t] > 0 ? sum[t] / n[t] : null]));
}

/** The run the window ends on, or null for an empty window. */
export function currentRun(runList) {
  const list = Array.isArray(runList) ? runList : [];
  return list.length ? list[list.length - 1] : null;
}

// ---- yield series ----------------------------------------------------------------------------

/** Running mean of the per-block yield, one entry per block. */
export function cumulativeMeanYield(digits) {
  const s = clean(digits);
  const out = [];
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    total += yieldOfDigit(s[i]) ?? 0;
    out.push(total / (i + 1));
  }
  return out;
}

/** Mean yield of the last `w` blocks at every position; null until the window is full. */
export function rollingMeanYield(digits, w = BLOCKS_PER_DAY) {
  const s = clean(digits);
  const span = Math.max(1, Math.floor(Number(w) || BLOCKS_PER_DAY));
  const out = [];
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    total += yieldOfDigit(s[i]) ?? 0;
    if (i >= span) total -= yieldOfDigit(s[i - span]) ?? 0;
    out.push(i + 1 >= span ? total / span : null);
  }
  return out;
}

/** Standard error of the mean yield over n blocks: √(σ² / n); null for n ≤ 0. */
export function standardError(n) {
  const nn = Number(n);
  if (!(nn > 0) || !Number.isFinite(nn)) return null;
  return Math.sqrt((YIELD_SD * YIELD_SD) / nn);
}

/** Mean yield of the whole window, or null when empty. */
export function meanYield(digits) {
  const cum = cumulativeMeanYield(digits);
  return cum.length ? cum[cum.length - 1] : null;
}

export { EXPECTED_YIELD as MODEL_MEAN_YIELD };
