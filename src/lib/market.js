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
import { SELLER_CAP_RE, listingCapText } from "./listingRules.js";

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

/**
 * Said while the wallet signs a withdrawal: its fee decides how long the
 * old signature stays fillable. A pending withdrawal can be sped up from
 * this page (the same transaction with a higher fee).
 */
export const WITHDRAW_FEE_NOTE =
  "sign the withdrawal in your wallet. Until it confirms, anyone who saved the old listing can still fill it with a transaction that pays a higher fee — a fee that confirms soon shortens that window, and Speed up raises it while it is pending.";

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
 * spend in the mempool: this app never builds a second fill that competes
 * with it (only a spend paying a higher fee could replace it, and whichever
 * confirms first counts), so it is shown greyed and cannot be selected.
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
 *
 * `totalSats` is the gross figure (price + the three 546-sat outputs + the
 * network fee) and the ceiling the sheet never signs above. The listed
 * UTXO's own BTC (`carrierInSats`) enters the fill as input 0 and comes
 * back in the buyer's change, so the wallet pays `netSats` = total − carrier;
 * two of the 546-sat outputs are the buyer's own token carriers.
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
    carrierInSats: est.carrierInSats,
    netSats: est.netSats,
  };
}

/**
 * The buy bar's line once the fill confirmed (`status` = the /tx-status
 * answer): its block when the answer names one, never "block #0".
 */
export function filledLineText(status) {
  if (status?.final) return "Filled.";
  const h = status?.block_height;
  const where = Number.isInteger(h) && h > 0 ? ` in block #${h.toLocaleString("en-US")}` : "";
  return `Filled${where} — final after ${FINAL_DEPTH} confirmations.`;
}

/** Text for the pending-fill title of an order-book row the buyer cannot pick. */
export function fillingRowTitle(order) {
  const rate = order && Number.isFinite(order.pending_feerate) ? ` at ${order.pending_feerate} sat/vB` : "";
  return `A fill of this listing is already in the mempool${rate}. This app does not build a second fill that competes with it; whichever spend confirms first counts.`;
}

// ---- a fill that did not confirm ----------------------------------------------------------

/**
 * What became of a fill this browser broadcast as `txid` from `address`,
 * judged from the order book's current view of the listing (`now`, the
 * OrderView of GET /orders/:id, or null when it is gone). →
 *   { kind: "mine", txid }       the book names this address as the buyer
 *                                in another transaction (the same fill,
 *                                replaced by a faster copy): follow that txid
 *   { kind: "other", txid }      another buyer's fill confirmed first
 *   { kind: "seller", txid }     the seller spent the listed UTXO first (a
 *                                withdrawal, or a fill of their own)
 *   { kind: "replacing", txid }  another spend of it sits in the mempool
 *   null                         nothing can be concluded yet
 * "other" and "seller" need a confirmed spend (`spent_txid` and
 * `spent_block`): only then can the buyer's transaction never confirm.
 */
export function fillOutcome(now, { txid, address } = {}) {
  if (!now || typeof now !== "object") return null;
  const mine = String(txid || "").toLowerCase();
  const spent = now.spent_txid ? String(now.spent_txid).toLowerCase() : null;
  const confirmedElsewhere = !!spent && spent !== mine && Number.isInteger(now.spent_block);
  if (now.status === "filled") {
    if (!spent || spent === mine) return null;
    if (address && now.buyer === address) return { kind: "mine", txid: spent };
    if (!confirmedElsewhere) return null;
    return { kind: now.buyer && now.buyer === now.seller ? "seller" : "other", txid: spent };
  }
  if (now.status === "cancelled") return confirmedElsewhere ? { kind: "seller", txid: spent } : null;
  if (now.status === "filling") {
    const pending = now.pending_spend_txid ? String(now.pending_spend_txid).toLowerCase() : null;
    if (pending && pending !== mine) return { kind: "replacing", txid: pending };
  }
  return null;
}

/**
 * Right before the wallet signs a fill: the book's fresh view of the
 * listing (`now`, GET /orders/:id) against the one the sheet verified and
 * shows (`shown`). Null when it may be signed, else why not — a spend of it
 * already in the mempool, a listing closed or gone, a market not open, or
 * a listing re-published since (another price, another PSBT).
 */
export function signTimeOrderProblem(now, shown) {
  if (!now) return "Not signed: this listing is no longer on the order book.";
  if (now.status === "filling") return "Not signed: a fill or a withdrawal of this listing is already in the mempool.";
  if (now.status === "filled") return "Not signed: this listing has just been filled.";
  if (now.status === "cancelled") return "Not signed: this listing has just been withdrawn.";
  if (now.status !== "open") return "Not signed: this listing is no longer on the order book.";
  if (now.market_open === false) return "Not signed: this ticker's market is not open.";
  if (!shown) return null;
  if (now.psbt !== shown.psbt || now.price_sats !== shown.price_sats || now.amount !== shown.amount || now.seller !== shown.seller || now.carrier_sats !== shown.carrier_sats) {
    return "Not signed: this listing changed since the sheet opened — close it and select it again.";
  }
  return null;
}

/**
 * A fill's fee rate below the Normal (half-hour) estimate: it may wait
 * hours or days, the seller can withdraw it meanwhile, and a fill cannot be
 * sped up here — said before signing. Null when the rate is at least
 * Normal, or either figure is unknown.
 */
export function slowFillWarning(rateSatVb, feesData) {
  const r = Number(rateSatVb);
  const normal = Number(feesData?.halfHourFee);
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(normal) || normal <= 0 || r >= normal) return null;
  return `${r} sat/vB is below the Normal estimate (${normal} sat/vB), so this fill may wait hours or days. Until it confirms the seller can still withdraw the listing (your BTC then does not move), and a fill cannot be sped up from this page — Normal or Fast is safer.`;
}

/** One plain sentence for a fillOutcome of kind "other" | "seller" | "replacing". */
export function fillOutcomeText(outcome) {
  if (!outcome) return "";
  const tx = outcome.txid ? ` (tx ${String(outcome.txid).slice(0, 12)}…)` : "";
  if (outcome.kind === "other") return `Another buyer's fill of this listing confirmed first${tx}. Your transaction can no longer confirm — your BTC did not move.`;
  if (outcome.kind === "seller") return `The seller spent the listed UTXO first${tx}, which withdrew the listing. Your transaction can no longer confirm — your BTC did not move.`;
  if (outcome.kind === "replacing") return `Another transaction spending this listing${tx} — the seller's withdrawal or another buyer's fill — has replaced yours in the mempool. If it confirms, your BTC does not move; this page keeps checking.`;
  return "";
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
 * A number written with thousands separators: "1,000", "12,345",
 * "1,000,000", "1,000.5". Read as a decimal comma it would be a thousand
 * times too small, and read as thousands it would misread "1,250" typed as
 * 1.25 — so the unit box refuses it and says why.
 */
const THOUSANDS_RE = /^[1-9]\d{0,2}(,\d{3})+(\.\d*)?$/;

/** Why the text in the unit-price box cannot be read, in plain words — or null. */
export function unitInputProblem(v) {
  const t = String(v ?? "").trim();
  if (t === "") return null;
  if (THOUSANDS_RE.test(t)) return "Write the price without thousands separators, with a dot for decimals — 1000, not 1,000.";
  if (parseUnitInput(t) === null) return "Enter the price as a number of sats per token, e.g. 15.5.";
  return null;
}

/**
 * A unit price typed in the sell form → a positive finite number, or null
 * when it does not parse ("", "15x", "0"). A single decimal comma counts as
 * a decimal point ("15,5" → 15.5, "0,125" → 0.125); a number written with
 * thousands separators ("1,000", "12,345") is refused, never read as 1 or 12.345.
 */
export function parseUnitInput(v) {
  const s = String(v ?? "").trim();
  if (THOUSANDS_RE.test(s)) return null;
  const t = s.replace(",", ".");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The total-sats box → a whole number of sats, or NaN. Thousands separators
 * are dropped when they are laid out as such ("5,000,000"): a total is whole
 * sats, so no comma in it can be a decimal comma.
 */
export function parseTotalInput(v) {
  const s = String(v ?? "").trim();
  const t = /^[1-9]\d{0,2}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s;
  if (!/^\d+$/.test(t)) return NaN;
  return Number(t);
}

/** Below this share of the market's reference price a listing needs an explicit confirmation. */
export const LOW_PRICE_RATIO = 0.1;

/**
 * Is `unitPrice` (sats per token) below a tenth of the ticker's current
 * floor — or, with no open listing, its last trade? → `{ ref, refKind:
 * "floor" | "last trade", ratio }` or null (not low, or nothing to compare
 * with). A listing is a bearer instrument: once published anyone can fill
 * it, so a price typed a thousand times too small is caught before signing.
 */
export function lowPriceCheck(unitPrice, token) {
  const u = Number(unitPrice);
  if (!Number.isFinite(u) || u <= 0 || !token) return null;
  const floor = Number(token.floor_unit_price);
  const last = Number(token.last_trade?.unit_price);
  const [ref, refKind] = Number.isFinite(floor) && floor > 0 ? [floor, "floor"] : Number.isFinite(last) && last > 0 ? [last, "last trade"] : [null, null];
  if (ref === null || u >= ref * LOW_PRICE_RATIO) return null;
  return { ref, refKind, ratio: u / ref };
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
  "To raise the price, withdraw this listing first. Your earlier listing is already signed at the lower price, and anyone who saved it can still complete it on-chain at that price — so the order book keeps the cheaper one. Withdraw moves these tokens to a new carrier of yours on-chain (a transfer to yourself), which voids the old signature for good; then list the new carrier at the higher price.";

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
  // The listed outpoint does not hold exactly the listing's tokens (a UTXO
  // with several tickers, or a stale view): the book names the balances.
  if (/^outpoint (carries|balances are) \{/.test(msg)) {
    return `The order book refused this listing: this UTXO's tokens do not match it (${msg.replace(/\.$/, "")}). Refresh; if it holds more than one ticker, move this ticker to its own carrier first.`;
  }
  // A listing whose version / input sequence no fill could relay
  // (the book says "listing tx version must be 1 or 2 …" and "input0
  // nSequence … sets a relative timelock"). Case-sensitive, lower-case or
  // camel-case words only: a ticker is upper-case, so one named TIMELOCK or
  // NVERSION in another refusal never reads as this one.
  if (/tx version|nVersion|nSequence|relative (time)?lock|timelock|can never be filled/.test(msg)) {
    return `The order book refused this listing because no buyer could ever complete it (${msg.replace(/\.$/, "")}). Sign it again; if this repeats, your wallet changed the transaction while signing.`;
  }
  // §7.4 per-seller cap: "seller has 10 open orders (cap 10)" — the whole
  // message only, so a per-ticker refusal never reads as this one.
  const cap = SELLER_CAP_RE.exec(msg);
  if (cap) return listingCapText(Number(cap[2]), Number(cap[1]));
  if (/open-order cap|per-address|per seller/i.test(msg)) return `The order book refused this listing: ${msg}.`.replace(/\.\.$/, ".");
  return msg ? `The order book refused this listing: ${msg}`.replace(/([^.])$/, "$1.") : `The order book refused this listing (HTTP ${status}).`;
}
