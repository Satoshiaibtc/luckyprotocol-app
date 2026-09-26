// Market tab helpers — pure, window-free, tested in test/market.test.js.
//
//   candles     candleLayout / nearestCandle / niceTicks / timeTicks — the
//               geometry the hand-built SVG chart draws from
//   order book  sortAsks / orderSelectable / fillQuote — which ask a buyer
//               may pick and what a fill costs at a fee rate
//   cancel      cancelFeeRate — the audit M-9 rule for a SEND-to-self that
//               has to replace a low-fee fill sitting in the mempool
//   change      changeSign / fmtChangePct — sign-coloured deltas
//
// Prices are sats per whole token throughout; sizes are sats.

import { DUST_SATS, SEND_PROTOCOL_FEE_SATS } from "./payloads.js";
import { MAX_FEE_RATE_SAT_VB } from "./psbt.js";
import { estimateFillCost } from "./swap.js";

export const WINDOWS = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
];
export const INTERVALS = [
  { id: "1h", label: "1h", limit: 168 },
  { id: "1d", label: "1d", limit: 90 },
];

// ---- axis ticks -------------------------------------------------------------------------

/** 1-2-5 ticks inside [min, max]. `count` is a target, not a promise. */
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (!(max > min)) return [min];
  const span = max - min;
  const rough = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Axis label for a sats-per-token value: fewer decimals the larger it is. */
export function fmtTick(v) {
  if (!Number.isFinite(v)) return "";
  if (v >= 1000) return Math.round(v).toLocaleString("en-US");
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** Indices of the candles that get a time label: evenly spaced, first and last included. */
export function timeTicks(count, maxTicks = 6) {
  if (!Number.isInteger(count) || count <= 0) return [];
  if (count === 1) return [0];
  const n = Math.max(2, Math.min(maxTicks, count));
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round(((count - 1) * i) / (n - 1)));
  return [...new Set(out)];
}

/** Time label for a bucket start: day for 1d buckets, HH:MM (UTC) for 1h. */
export function fmtTimeTick(t, interval) {
  if (!Number.isFinite(t)) return "";
  const d = new Date(t * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  if (interval === "1d") return `${mm}-${dd}`;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd} ${hh}:${mi}`;
}

// ---- candle layout ------------------------------------------------------------------------

export const CANDLE_PAD = { top: 12, right: 14, bottom: 22, left: 56 };

/**
 * Geometry for `candles` (ascending, empty buckets omitted → equal spacing
 * by index, not by time) inside a `width` × `height` box whose lower
 * `volumeHeight` px hold the volume bars. Returns null with no candles.
 *
 *   { colW, bodyW, x(i), yPrice(v), yVol(v), yMin, yMax, vMax,
 *     priceTicks: [{ v, y }], timeTicks: [{ i, x, label }],
 *     bars: [{ i, x, yO, yC, yH, yL, yV, up, c }], last: { v, y },
 *     priceTop, priceBottom, volTop, volBottom }
 */
export function candleLayout({ candles, width, height, volumeHeight = 56, pad = CANDLE_PAD, interval = "1h" }) {
  const rows = Array.isArray(candles) ? candles : [];
  if (rows.length === 0) return null;
  const innerW = Math.max(10, width - pad.left - pad.right);
  const priceTop = pad.top;
  const volBottom = height - pad.bottom;
  const volTop = volBottom - Math.max(0, volumeHeight);
  const priceBottom = volTop - (volumeHeight > 0 ? 8 : 0);
  const priceH = Math.max(10, priceBottom - priceTop);

  let yMin = Infinity;
  let yMax = -Infinity;
  let vMax = 0;
  for (const c of rows) {
    if (c.l < yMin) yMin = c.l;
    if (c.h > yMax) yMax = c.h;
    if (c.v_sats > vMax) vMax = c.v_sats;
  }
  if (yMax === yMin) {
    yMin = yMin * 0.95;
    yMax = yMax * 1.05 || 1;
  }
  const padY = (yMax - yMin) * 0.08;
  yMin = Math.max(0, yMin - padY);
  yMax += padY;

  const colW = innerW / rows.length;
  const bodyW = Math.max(1, Math.min(14, Math.floor(colW * 0.62)));
  const x = (i) => pad.left + colW * (i + 0.5);
  const yPrice = (v) => priceTop + priceH - ((v - yMin) / (yMax - yMin)) * priceH;
  const yVol = (v) => (vMax > 0 ? volBottom - (v / vMax) * (volBottom - volTop) : volBottom);

  const bars = rows.map((c, i) => ({
    i,
    x: x(i),
    yO: yPrice(c.o),
    yC: yPrice(c.c),
    yH: yPrice(c.h),
    yL: yPrice(c.l),
    yV: yVol(c.v_sats),
    up: c.c >= c.o,
    c,
  }));
  const last = rows[rows.length - 1];
  return {
    colW,
    bodyW,
    x,
    yPrice,
    yVol,
    yMin,
    yMax,
    vMax,
    priceTicks: niceTicks(yMin, yMax, 4).map((v) => ({ v, y: yPrice(v) })),
    timeTicks: timeTicks(rows.length, Math.max(2, Math.floor(innerW / 96))).map((i) => ({ i, x: x(i), label: fmtTimeTick(rows[i].t, interval) })),
    bars,
    last: { v: last.c, y: yPrice(last.c) },
    priceTop,
    priceBottom,
    volTop,
    volBottom,
    left: pad.left,
    right: width - pad.right,
  };
}

/** Index of the candle whose column contains `px` (clamped to the range). */
export function nearestCandle(layout, px) {
  if (!layout || layout.bars.length === 0) return null;
  const i = Math.floor((px - layout.left) / layout.colW);
  return Math.max(0, Math.min(layout.bars.length - 1, i));
}

// ---- order book ---------------------------------------------------------------------------

/** Asks by unit price, then age (older first) — the book's display order. */
export function sortAsks(rows) {
  return [...(rows || [])].sort((a, b) => a.unit_price - b.unit_price || (a.created_at ?? 0) - (b.created_at ?? 0) || a.id.localeCompare(b.id));
}

/**
 * May the connected `address` pick this order? `{ ok, reason }` with reason
 * ∈ null | "own" | "filling" | "closed". A `filling` row already has a
 * spend in the mempool: a second fill would only be rejected as a
 * double-spend, so it is shown greyed and cannot be selected.
 */
export function orderSelectable(order, address) {
  if (!order || typeof order !== "object") return { ok: false, reason: "closed" };
  if (order.status === "filling") return { ok: false, reason: "filling" };
  if (order.status !== "open") return { ok: false, reason: "closed" };
  if (address && order.seller === address) return { ok: false, reason: "own" };
  return { ok: true, reason: null };
}

/**
 * What a fill of `order` costs at `feeRateSatVb` from `address` (display
 * estimate — the builder recomputes with the real inputs). Null without a
 * usable rate. Every carrier the buyer receives is a 546-sat output.
 */
export function fillQuote({ order, address, feeRateSatVb }) {
  if (!order || !Number.isFinite(feeRateSatVb) || feeRateSatVb <= 0) return null;
  let est;
  try {
    est = estimateFillCost({ order, address: address || order.seller, feeRateSatVb });
  } catch {
    return null;
  }
  return {
    priceSats: est.priceSats,
    tokenCarrierSats: DUST_SATS,
    protocolFeeSats: SEND_PROTOCOL_FEE_SATS,
    residualCarrierSats: DUST_SATS,
    feeSats: est.feeSats,
    vsize: est.vsize,
    feeRateSatVb,
    totalSats: est.totalSats,
  };
}

// ---- M-9 cancel fee rule ------------------------------------------------------------------

/**
 * The fee rate a cancel (SEND-to-self of the listed UTXO) must use.
 *
 * An open order: the chosen rate, unchanged. A `filling` order has a spend
 * of the same outpoint sitting in the mempool; the cancel is a BIP125
 * replacement of it and the node refuses anything that does not beat it,
 * so the rate is raised to
 *
 *   max( chosen,
 *        pending_feerate + incrementalrelayfee + 1,                 (rate floor)
 *        (pending_fee_sats + vsize × incrementalrelayfee) / vsize ) (absolute-fee floor, rule 3/4)
 *
 * `incrementalrelayfee` comes from /fees (null → 1 sat/vB, conservative).
 * `vsize` is the cancel's estimated size; without it only the rate floor
 * applies. `overCap` is set when the result exceeds the app's 1,000 sat/vB
 * safety cap — the builder will refuse it, so the caller should say so.
 */
export function cancelFeeRate({ chosenSatVb, order, incrementalRelayFee, vsize }) {
  const chosen = Number.isFinite(chosenSatVb) && chosenSatVb > 0 ? chosenSatVb : null;
  const filling = !!order && order.status === "filling" && Number.isFinite(order.pending_feerate);
  if (!filling) return { satVb: chosen, floorSatVb: null, rateFloor: null, absFloor: null, incr: null, overCap: false, raised: false };
  const incr = Number.isFinite(incrementalRelayFee) && incrementalRelayFee > 0 ? incrementalRelayFee : 1;
  const rateFloor = order.pending_feerate + incr + 1;
  let absFloor = null;
  if (Number.isFinite(order.pending_fee_sats) && Number.isFinite(vsize) && vsize > 0) {
    absFloor = (order.pending_fee_sats + vsize * incr) / vsize;
  }
  const floor = ceil2(Math.max(rateFloor, absFloor ?? 0));
  const satVb = Math.max(chosen ?? 0, floor);
  return {
    satVb,
    floorSatVb: floor,
    rateFloor: ceil2(rateFloor),
    absFloor: absFloor === null ? null : ceil2(absFloor),
    incr,
    overCap: satVb > MAX_FEE_RATE_SAT_VB,
    raised: chosen === null || floor > chosen,
  };
}

/** Round UP to hundredths of a sat/vB (the wallet rate grain) without a float artefact pushing 39.70 to 39.71. */
function ceil2(x) {
  return Math.ceil(x * 100 - 1e-7) / 100;
}

// ---- change -------------------------------------------------------------------------------

/** "up" | "down" | "flat" for a percentage, null when unknown. */
export function changeSign(pct) {
  if (!Number.isFinite(pct)) return null;
  if (pct > 0.005) return "up";
  if (pct < -0.005) return "down";
  return "flat";
}

/** "+3.2%" / "−1.4%" / "0.0%" / "—". A real minus sign, not a hyphen. */
export function fmtChangePct(pct) {
  if (!Number.isFinite(pct)) return "—";
  const s = changeSign(pct);
  const abs = Math.abs(pct);
  const digits = abs >= 100 ? 0 : 1;
  return `${s === "up" ? "+" : s === "down" ? "−" : ""}${abs.toFixed(digits)}%`;
}
