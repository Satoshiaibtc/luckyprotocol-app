// Activity page helpers — pure, window-free, tested in test/activity.test.js.
//
//   utcDay / lastNDays / fillDays   — UTC calendar days for the daily chart
//   aggregateDaily                  — /activity items → /activity/daily rows
//                                     (the mock uses it; the indexer computes
//                                     the same thing server-side)
//   dailySeries / dailyLayout       — one metric as bars + a cumulative line
//   activityParties                 — who → whom for a ledger row
//   isSearchableAddress             — the address box accepts what the wallet
//                                     layer accepts (mainnet bc1q… / bc1p…)

import { isMainnetAddress } from "./walletShapes.js";

export const KINDS = [
  { id: "all", label: "All" },
  { id: "deploy", label: "Deploy" },
  { id: "mine", label: "Mine" },
  { id: "send", label: "Send" },
  { id: "trade", label: "Trade" },
];

export const METRICS = [
  { id: "events", label: "Events", unit: "" },
  { id: "sends", label: "Sends", unit: "" },
  { id: "active_addresses", label: "Active addresses", unit: "" },
  { id: "volume_sats", label: "Volume", unit: "sats" },
];

export const DAILY_DAYS = 30;

/** "YYYY-MM-DD" of a unix-seconds timestamp, UTC. */
export function utcDay(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** The last `n` UTC days ending today (`nowSec`), ascending. */
export function lastNDays(n, nowSec) {
  const count = Math.max(1, Math.floor(Number(n) || 1));
  const end = Math.floor(Number(nowSec) / 86400) * 86400;
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(utcDay(end - i * 86400));
  return out;
}

const EMPTY_DAY = { events: 0, deploys: 0, mines: 0, sends: 0, trades: 0, active_addresses: 0, token_amount: 0, volume_sats: 0 };

/** One row per day of the window, in order; missing days are zero rows. */
export function fillDays(rows, n, nowSec) {
  const byDate = new Map((rows || []).map((r) => [r.date, r]));
  return lastNDays(n, nowSec).map((date) => byDate.get(date) || { date, ...EMPTY_DAY });
}

const PARTY_KEYS = ["from", "to", "sender", "deployer", "buyer", "seller"];

/**
 * Aggregate raw ledger items into daily rows (ascending). An item lands on
 * the UTC day of its `block_time`; items without one are skipped. Volume
 * counts non-self trades only (§7.5).
 */
export function aggregateDaily(items, { days = DAILY_DAYS, now } = {}) {
  const nowSec = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  const window = new Set(lastNDays(days, nowSec));
  const acc = new Map();
  const parties = new Map();
  for (const it of items || []) {
    if (!it || !Number.isFinite(it.block_time)) continue;
    const date = utcDay(it.block_time);
    if (!window.has(date)) continue;
    let row = acc.get(date);
    if (!row) {
      row = { date, ...EMPTY_DAY };
      acc.set(date, row);
      parties.set(date, new Set());
    }
    row.events += 1;
    // token_amount = credited mine yields + applied send amounts + non-self
    // trade amounts (a deploy's `amount` is the supply, never moved tokens).
    const applied = it.applied !== false;
    if (it.kind === "deploy") row.deploys += 1;
    else if (it.kind === "mine") {
      row.mines += 1;
      if (applied && Number.isFinite(it.amount)) row.token_amount += it.amount;
    } else if (it.kind === "send") {
      row.sends += 1;
      if (applied && Number.isFinite(it.amount)) row.token_amount += it.amount;
    } else if (it.kind === "trade") {
      row.trades += 1;
      if (!it.self_trade) {
        if (Number.isFinite(it.price_sats)) row.volume_sats += it.price_sats;
        if (Number.isFinite(it.amount)) row.token_amount += it.amount;
      }
    }
    const set = parties.get(date);
    for (const k of PARTY_KEYS) if (typeof it[k] === "string" && it[k]) set.add(it[k]);
  }
  for (const [date, set] of parties) acc.get(date).active_addresses = set.size;
  return [...acc.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** `{ values, cumulative, total, max }` of one metric over the rows. */
export function dailySeries(rows, metric) {
  const key = METRICS.some((m) => m.id === metric) ? metric : "events";
  const values = (rows || []).map((r) => Math.max(0, Number(r[key]) || 0));
  const cumulative = [];
  let run = 0;
  for (const v of values) {
    run += v;
    cumulative.push(run);
  }
  return { values, cumulative, total: run, max: values.reduce((m, v) => (v > m ? v : m), 0) };
}

export const DAILY_PAD = { top: 10, right: 44, bottom: 20, left: 44 };

/**
 * Bar + line geometry for the daily chart in a `width` × `height` box:
 * bars scale to the metric's max (left axis), the cumulative line to its
 * final value (right axis). Null with no rows.
 */
export function dailyLayout({ rows, metric, width, height, pad = DAILY_PAD }) {
  if (!rows || rows.length === 0) return null;
  const { values, cumulative, total, max } = dailySeries(rows, metric);
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = Math.max(10, height - pad.top - pad.bottom);
  const colW = innerW / rows.length;
  const barW = Math.max(1, Math.floor(colW * 0.66));
  const yBar = (v) => pad.top + innerH - (max > 0 ? (v / max) * innerH : 0);
  const yLine = (v) => pad.top + innerH - (total > 0 ? (v / total) * innerH : 0);
  const x = (i) => pad.left + colW * (i + 0.5);
  const bars = rows.map((r, i) => ({ i, date: r.date, v: values[i], cum: cumulative[i], x: x(i), y: yBar(values[i]), h: pad.top + innerH - yBar(values[i]) }));
  const line = bars.map((b, i) => `${i === 0 ? "M" : "L"}${b.x.toFixed(1)} ${yLine(b.cum).toFixed(1)}`).join(" ");
  const yTicks = niceCountTicks(max).map((v) => ({ v, y: yBar(v) }));
  const labelEvery = rows.length > 16 ? 7 : rows.length > 8 ? 2 : 1;
  const xTicks = bars.filter((b, i) => i % labelEvery === 0 || i === rows.length - 1).map((b) => ({ x: b.x, label: b.date.slice(5) }));
  return { bars, line, colW, barW, x, yBar, yLine, yTicks, xTicks, total, max, top: pad.top, bottom: pad.top + innerH, left: pad.left, right: pad.left + innerW };
}

/** 0 … max in ≤ 4 steps of 1-2-5 × 10ⁿ. */
export function niceCountTicks(max) {
  if (!(max > 0)) return [0];
  const rough = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Index of the bar whose column contains `px`, or null. */
export function nearestBar(layout, px) {
  if (!layout || layout.bars.length === 0) return null;
  const i = Math.floor((px - layout.left) / layout.colW);
  return Math.max(0, Math.min(layout.bars.length - 1, i));
}

/**
 * The "who" cell of a ledger row: `{ left, right, join }` where `join` is
 * "→" (send: from → to), "←" (trade: buyer ← seller), or null (one party:
 * the miner / the deployer).
 */
export function activityParties(item) {
  if (!item) return { left: null, right: null, join: null };
  switch (item.kind) {
    case "send":
      return { left: item.from || item.sender || null, right: item.to || null, join: "→" };
    case "trade":
      return { left: item.buyer || null, right: item.seller || null, join: "←" };
    case "deploy":
      return { left: item.deployer || item.sender || null, right: null, join: null };
    default:
      return { left: item.sender || item.from || null, right: null, join: null };
  }
}

/** The address search box accepts exactly what a wallet may connect with. */
export function isSearchableAddress(s) {
  return isMainnetAddress(String(s || "").trim());
}
