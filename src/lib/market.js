// Market tab helpers — pure, window-free, tested in test/market.test.js.
//
//   candles     candleLayout / nearestCandle / niceTicks / timeTicks — the
//               geometry the hand-built SVG chart draws from
//   order book  sortAsks / orderSelectable / fillQuote — which ask a buyer
//               may pick and what a fill costs at a fee rate
//   cancel      cancelFeeRate — the fee rule for a SEND-to-self that
//               has to replace a low-fee fill sitting in the mempool
//   change      changeSign / fmtChangePct — sign-coloured deltas
//
// Prices are sats per whole token throughout; sizes are sats.

import { DUST_SATS, SEND_PROTOCOL_FEE_SATS } from "./payloads.js";
import { MAX_FEE_RATE_SAT_VB } from "./psbt.js";
import { estimateFillCost } from "./swap.js";
import { FINAL_DEPTH } from "./finality.js";
import { COMMIT_CARRIER_PLAIN_TEXT, SELLER_CAP_RE, listingCapText } from "./listingRules.js";

export const WINDOWS = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
];
export const INTERVALS = [
  { id: "1h", label: "1h", limit: 168 },
  { id: "1d", label: "1d", limit: 90 },
];

// ---- withdrawal wording --------------------------------------------------------------------

/**
 * The withdrawal's pending line: until the
 * SEND-to-self confirms, the old signed listing is still a valid fill —
 * anyone who saved it can pay a higher fee and replace the withdrawal.
 */
export const WITHDRAW_PENDING_TEXT =
  "Withdrawal broadcast. Until it confirms, anyone who saved the old signed listing can still fill it — a fill that pays a higher fee can replace this withdrawal. Checking every 15 s.";

/** The withdrawal confirmed but is not final: a chain reorganization could still bring the old listing back. */
export const WITHDRAW_CONFIRMED_TEXT =
  `Withdrawal confirmed — final after ${FINAL_DEPTH} confirmations. Until then a chain reorganization could put it back in the mempool, and the old listing with it; this page keeps checking.`;

// ---- axis ticks -------------------------------------------------------------------------

/** The 1-2-5 × 10ⁿ step that splits [min, max] into about `count` parts; null for a degenerate range. */
export function niceStep(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return null;
  const rough = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  // Math.pow(10, -n) differs in the last bit between V8 versions (Node 22
  // gives 2 × 1e-4 = 0.00019999999999999998, Node 24 gives 0.0002): round
  // to 12 significant digits so the step is the same on every runtime.
  return Number(((norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag).toPrecision(12));
}

/** 1-2-5 ticks inside [min, max]. `count` is a target, not a promise. */
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (!(max > min)) return [min];
  const step = niceStep(min, max, count);
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Decimals that make every multiple of `step` distinct (0.0002 → 4, 0.5 → 1, 2 → 0); capped at 8. */
export function stepDecimals(step) {
  if (!Number.isFinite(step) || step <= 0) return null;
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

/**
 * Axis label for a sats-per-token value. With the axis `step` every tick
 * shares the decimal count the step needs (sub-sat prices — the normal
 * regime for a 21,000,000-supply token — otherwise collapse to the same
 * label). Without a step the precision follows the magnitude: fewer
 * decimals the larger it is, and below 1 sat three significant digits.
 */
export function fmtTick(v, step) {
  if (!Number.isFinite(v)) return "";
  const d = stepDecimals(step);
  if (d !== null) return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (v >= 1000) return Math.round(v).toLocaleString("en-US");
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  if (v <= 0) return v.toFixed(3);
  return v.toFixed(Math.min(8, Math.max(3, 2 - Math.floor(Math.log10(v)))));
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
 *   { colW, bodyW, x(i), yPrice(v), yVol(v), yMin, yMax, vMax, priceStep,
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
    priceStep: niceStep(yMin, yMax, 4),
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

// ---- cancel fee rule ------------------------------------------------------------------

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

// ---- chart time labels ----------------------------------------------------------------------

/**
 * The readout / aria time of a candle, in UTC like the axis ticks
 * (fmtTimeTick) — "YYYY-MM-DD HH:MM UTC" (1h) / "YYYY-MM-DD UTC" (1d).
 * Local time next to UTC ticks would sit 8 h apart in UTC+8 with no zone
 * on either.
 */
export function fmtCandleTime(t, interval) {
  if (!Number.isFinite(t)) return "";
  const d = new Date(t * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  if (interval === "1d") return `${day} UTC`;
  return `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// ---- sell form ------------------------------------------------------------------------------

/**
 * A unit price typed in the sell form → a positive finite number, or null
 * when it does not parse ("", "15x", "0"). A decimal comma counts as a
 * decimal point ("15,5" → 15.5); a thousands separator does not exist here.
 */
export function parseUnitInput(v) {
  const t = String(v ?? "").trim().replace(",", ".");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Why a split amount cannot be used, or null when it can. `max` = the
 * largest amount this carrier allows (its whole
 * amount when it may be moved entirely, else one less); `holds` = what the
 * carrier holds.
 */
export function splitAmountError(text, max, holds, ticker) {
  const t = String(text ?? "").trim();
  if (t === "") return null;
  const range = max >= 1 ? `Enter a whole number from 1 to ${max.toLocaleString("en-US")}` : "Nothing to split";
  const n = Number(t);
  if (!/^\d+$/.test(t) || !Number.isInteger(n)) return `${range} — whole tokens only; this carrier holds ${Number(holds).toLocaleString("en-US")} ${ticker}.`;
  if (n < 1 || n > max) {
    const why = n > holds ? "more than this carrier holds" : n === holds ? "the whole carrier — a listing already sells all of it" : "zero";
    return `${range} (${why}); this carrier holds ${Number(holds).toLocaleString("en-US")} ${ticker}.`;
  }
  return null;
}

/**
 * Why a higher price needs Withdraw first (the book keeps the cheapest listing),
 * in plain words — the sell form's notice and the book's 409 both say it.
 */
export const RAISE_PRICE_TEXT =
  "To raise the price, withdraw this listing first. Your earlier listing is already signed at the lower price, and anyone who saved it can still complete it on-chain at that price — so the order book keeps the cheaper one. Withdraw moves these tokens to a new carrier of yours on-chain (a send to yourself), which voids the old signature for good; then list the new carrier at the higher price.";

/**
 * The order book could not save a listing to disk (a 503 that says so): it
 * is not confirmed — it may not be listed at all, or only until the indexer
 * restarts, and while it is shown a buyer can fill it. Posting the same
 * listing again is safe (the same price renews it).
 */
export const BOOK_NOT_SAVED_TEXT =
  "The order book could not save this listing right now: it may not be listed, or only until the indexer restarts — and while it is shown, it can be filled at your price. Try again in a few minutes; posting the same listing again is safe.";

/** The sell form's pause while the order book reports that it cannot save listings. */
export const BOOK_UNSAVED_PAUSE_TEXT =
  "The order book cannot save new listings right now, so listing is paused until it can. Withdrawing still works.";

/**
 * A POST /orders refusal (indexer.orderHttpError: the server's sentence +
 * `status`) → one sentence for the sell form, or null when `e` is not a
 * refusal of the book (a wallet or network error keeps its own text).
 * Band / cap / pending-spend refusals get short plain words, as does a book
 * that cannot save listings (503); anything else is the book's own
 * sentence behind "The order book refused this listing".
 */
export function listingRefusalText(e) {
  const status = Number(e?.status);
  const msg = String(e?.message || "").trim();
  if (status === 503 && /cannot be saved/i.test(msg)) return BOOK_NOT_SAVED_TEXT;
  if (!Number.isInteger(status) || status < 400 || status >= 500) return null;
  // §7.4 per-ticker cap: "<TICKER> has N open orders (cap N); a new ask must
  // undercut the worst one (…)" is the book's own sentence, kept whole. It
  // names the ticker, so it is settled first: no rule below may read a
  // ticker such as SELLER or TIMELOCK as its own keyword.
  if (/^[A-Z0-9]{1,8} has \d+ open orders \(cap \d+\); a new ask must undercut/.test(msg)) return `The order book refused this listing: ${msg}`.replace(/([^.])$/, "$1.");
  if (/price band/i.test(msg)) return `The order book refused this price: ${msg}.`.replace(/\.\.$/, ".");
  if (/price_sats must be in/i.test(msg)) return "The order book refused this price: at most 1 BTC per whole token (and at least 546 sats in total).";
  if (/pending spend|spent or pending/i.test(msg)) return "A transaction spending this UTXO is already in the mempool — the order book refuses a new listing for it until that confirms or drops.";
  // The book keeps the cheapest live signed listing of an outpoint.
  if (/withdraw first/i.test(msg)) return RAISE_PRICE_TEXT;
  // The first output of an open reservation (COMMIT) is never listed.
  if (/reserves a ticker|open commit/i.test(msg)) return COMMIT_CARRIER_PLAIN_TEXT;
  // A listing whose version / input sequence no fill could relay
  // (the book says "listing tx version must be 1 or 2 …" and "input0
  // nSequence … sets a relative timelock").
  if (/tx version|nversion|nsequence|relative (time)?lock|timelock|can never be filled/i.test(msg)) {
    return `The order book refused this listing because no buyer could ever complete it (${msg.replace(/\.$/, "")}). Sign it again; if this repeats, your wallet changed the transaction while signing.`;
  }
  // §7.4 per-seller cap: "seller has 10 open orders (cap 10)" — the whole
  // message only, so a per-ticker refusal never reads as this one.
  const cap = SELLER_CAP_RE.exec(msg);
  if (cap) return listingCapText(Number(cap[2]), Number(cap[1]));
  if (/open-order cap|per-address|per seller/i.test(msg)) return `The order book refused this listing: ${msg}.`.replace(/\.\.$/, ".");
  return msg ? `The order book refused this listing: ${msg}`.replace(/([^.])$/, "$1.") : `The order book refused this listing (HTTP ${status}).`;
}
