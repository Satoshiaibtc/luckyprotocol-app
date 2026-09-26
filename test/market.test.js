// Pure-part tests for src/lib/market.js: candle geometry + axis ticks,
// order-book selection, the fill cost quote, the audit M-9 cancel fee rule
// and the sign-coloured change formatter. Plain Node, no framework.
import assert from "node:assert/strict";
import {
  CANDLE_PAD,
  cancelFeeRate,
  candleLayout,
  changeSign,
  fillQuote,
  fmtChangePct,
  fmtTick,
  fmtTimeTick,
  nearestCandle,
  niceTicks,
  orderSelectable,
  sortAsks,
  timeTicks,
} from "../src/lib/market.js";
import { MAX_FEE_RATE_SAT_VB } from "../src/lib/psbt.js";
import { DUST_SATS, SEND_PROTOCOL_FEE_SATS } from "../src/lib/payloads.js";

const P2TR = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const P2WPKH = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const T = "ab".repeat(32);

// ---- axis ticks -------------------------------------------------------------------------
{
  assert.deepEqual(niceTicks(0, 100, 4), [0, 20, 40, 60, 80, 100], "1-2-5 steps");
  assert.deepEqual(niceTicks(47.3, 52.9, 4), [48, 49, 50, 51, 52], "ticks inside the range only");
  assert.deepEqual(niceTicks(5, 5), [5], "degenerate range → one tick");
  assert.deepEqual(niceTicks(NaN, 1), [], "non-finite → none");
  assert.deepEqual(niceTicks(0.001, 0.009, 4), [0.002, 0.004, 0.006, 0.008], "sub-sat prices");
  assert.equal(fmtTick(1234.5), "1,235");
  assert.equal(fmtTick(312.4), "312");
  assert.equal(fmtTick(48.56), "48.6");
  assert.equal(fmtTick(3.008), "3.01");
  assert.equal(fmtTick(0.0123), "0.012");
  assert.equal(fmtTick(NaN), "");
  assert.deepEqual(timeTicks(0), []);
  assert.deepEqual(timeTicks(1), [0]);
  assert.deepEqual(timeTicks(2, 6), [0, 1]);
  assert.deepEqual(timeTicks(10, 4), [0, 3, 6, 9], "evenly spaced, first + last always labelled");
  assert.deepEqual(timeTicks(3, 6), [0, 1, 2], "never more ticks than candles");
  assert.equal(fmtTimeTick(1790452492, "1d"), "09-26", "UTC calendar day");
  assert.equal(fmtTimeTick(1790452492, "1h"), "26 19:54", "UTC hour");
  assert.equal(fmtTimeTick(NaN, "1h"), "");
  console.log("market ticks: nice 1-2-5 steps, adaptive labels, evenly spaced time ticks");
}

// ---- candle layout ------------------------------------------------------------------------
{
  assert.equal(candleLayout({ candles: [], width: 600, height: 300 }), null, "no candles → no layout (empty state)");
  const candles = [
    { t: 1790400000, o: 50, h: 55, l: 48, c: 52, v_sats: 10_000, v_amount: 200, n: 3 },
    { t: 1790403600, o: 52, h: 60, l: 51, c: 58, v_sats: 40_000, v_amount: 700, n: 6 },
    { t: 1790410800, o: 58, h: 59, l: 45, c: 46, v_sats: 20_000, v_amount: 400, n: 2 }, // a gap: the 08:00 bucket is omitted
  ];
  const L = candleLayout({ candles, width: 600, height: 300, volumeHeight: 60, interval: "1h" });
  assert.ok(L, "layout exists");
  assert.equal(L.bars.length, 3);
  const innerW = 600 - CANDLE_PAD.left - CANDLE_PAD.right;
  assert.equal(L.colW, innerW / 3, "equal spacing by index, not by time (empty buckets are omitted)");
  assert.equal(L.bars[1].x, CANDLE_PAD.left + L.colW * 1.5, "centre of its column");
  assert.ok(L.yMin < 45 && L.yMax > 60, "price scale pads around low/high");
  assert.ok(L.yMin >= 0, "never below zero");
  assert.ok(L.bars[0].yH < L.bars[0].yO && L.bars[0].yO > L.bars[0].yC && L.bars[0].yC > L.bars[0].yH, "y grows downward: high above open above close for an up candle");
  assert.equal(L.bars[0].up, true);
  assert.equal(L.bars[2].up, false, "close < open");
  assert.equal(L.bars[1].yV, L.volTop, "the biggest volume fills the volume band");
  assert.equal(L.bars[0].yV, L.volBottom - (10_000 / 40_000) * (L.volBottom - L.volTop), "volume scales linearly");
  assert.ok(L.volTop < L.volBottom && L.priceBottom < L.volTop, "volume band sits under the price band");
  assert.equal(L.last.v, 46, "last close drives the last-price line");
  assert.equal(L.last.y, L.yPrice(46));
  assert.ok(L.priceTicks.length >= 2 && L.priceTicks.every((t) => t.v >= L.yMin && t.v <= L.yMax), "price ticks inside the scale");
  assert.deepEqual(L.timeTicks.map((t) => t.i), [0, 1, 2]);
  assert.equal(L.timeTicks[0].label, fmtTimeTick(1790400000, "1h"));
  assert.equal(nearestCandle(L, L.bars[1].x + 2), 1);
  assert.equal(nearestCandle(L, -100), 0, "clamped left");
  assert.equal(nearestCandle(L, 10_000), 2, "clamped right");
  assert.equal(nearestCandle(null, 5), null);
  const flat = candleLayout({ candles: [{ t: 1, o: 5, h: 5, l: 5, c: 5, v_sats: 0, v_amount: 0, n: 1 }], width: 300, height: 200 });
  assert.ok(flat.yMax > flat.yMin && Number.isFinite(flat.bars[0].yV), "a single flat candle still scales (no divide by zero)");
  console.log("market candles: index-spaced columns, padded price scale, volume band, last-price line, hover snapping");
}

// ---- order book ---------------------------------------------------------------------------
{
  const mk = (id, unit, created_at, extra = {}) => ({ id, ticker: "LUCKY", amount: 100, price_sats: unit * 100, unit_price: unit, seller: P2TR, carrier_sats: 546, status: "open", created_at, ...extra });
  const rows = [mk("c", 52, 3), mk("a", 50, 2), mk("b", 50, 1), mk("d", 49, 9, { status: "filling" })];
  assert.deepEqual(sortAsks(rows).map((o) => o.id), ["d", "b", "a", "c"], "by unit price, then age (older first)");
  assert.deepEqual(sortAsks(null), []);
  assert.deepEqual(orderSelectable(mk("x", 1, 1), P2WPKH), { ok: true, reason: null });
  assert.deepEqual(orderSelectable(mk("x", 1, 1), P2TR), { ok: false, reason: "own" }, "own listing");
  assert.deepEqual(orderSelectable(mk("x", 1, 1), null), { ok: true, reason: null }, "no wallet → still selectable (Connect prompt comes later)");
  assert.deepEqual(orderSelectable(mk("x", 1, 1, { status: "filling" }), P2WPKH), { ok: false, reason: "filling" }, "a spend is already in the mempool");
  assert.deepEqual(orderSelectable(mk("x", 1, 1, { status: "filled" }), P2WPKH), { ok: false, reason: "closed" });
  assert.deepEqual(orderSelectable(null, P2WPKH), { ok: false, reason: "closed" });

  const order = { id: `${T}:0`, ticker: "LUCKY", amount: 1200, price_sats: 60_000, unit_price: 50, seller: P2TR, carrier_sats: 546, status: "open" };
  const q = fillQuote({ order, address: P2WPKH, feeRateSatVb: 2 });
  assert.equal(q.priceSats, 60_000);
  assert.equal(q.tokenCarrierSats, DUST_SATS);
  assert.equal(q.residualCarrierSats, DUST_SATS);
  assert.equal(q.protocolFeeSats, SEND_PROTOCOL_FEE_SATS);
  assert.equal(q.feeSats, Math.ceil(q.vsize * 2), "fee = ceil(vsize) × rate");
  assert.equal(q.totalSats, 60_000 + 3 * 546 + q.feeSats, "price + token carrier + protocol fee + residual carrier + network fee");
  assert.ok(q.vsize > 200 && q.vsize < 400, `a 2-in / 6-out fill is a few hundred vB (${q.vsize})`);
  assert.equal(fillQuote({ order, address: P2WPKH, feeRateSatVb: null }), null, "no rate → no quote");
  assert.equal(fillQuote({ order, address: P2WPKH, feeRateSatVb: 0 }), null);
  assert.equal(fillQuote({ order: null, address: P2WPKH, feeRateSatVb: 2 }), null);
  const q2 = fillQuote({ order, address: P2TR, feeRateSatVb: 1.5 });
  assert.equal(q2.feeSats, Math.ceil(q2.vsize * 1.5), "fractional rates");
  assert.ok(q2.vsize > q.vsize, "P2TR outputs are larger than P2WPKH ones");
  console.log("market book: sorted asks, own / filling / closed rows unselectable, fill quote = price + 3 × 546 + fee");
}

// ---- M-9 cancel fee rule ------------------------------------------------------------------
{
  const open = { status: "open", pending_feerate: null, pending_fee_sats: null, pending_vsize: null };
  assert.deepEqual(cancelFeeRate({ chosenSatVb: 1.5, order: open, incrementalRelayFee: 0.1, vsize: 250 }), { satVb: 1.5, floorSatVb: null, rateFloor: null, absFloor: null, incr: null, overCap: false, raised: false }, "open order: the chosen rate, untouched");
  assert.equal(cancelFeeRate({ chosenSatVb: null, order: open }).satVb, null, "no rate stays no rate");

  // A 99 kvB fill at 0.1 sat/vB (9,900 sats) pins the outpoint. The rate
  // floor alone (0.1 + 0.1 + 1 = 1.2) would let a 1.5 sat/vB cancel through
  // — which the node rejects, because 250 vB × 1.5 = 375 sats does not beat
  // 9,900 sats (BIP125 rule 3). The absolute-fee floor catches that.
  const filling = { status: "filling", pending_feerate: 0.1, pending_fee_sats: 9_900, pending_vsize: 99_000 };
  const r = cancelFeeRate({ chosenSatVb: 1.5, order: filling, incrementalRelayFee: 0.1, vsize: 250 });
  assert.equal(r.rateFloor, 1.2, "pending_feerate + incrementalrelayfee + 1");
  assert.equal(r.absFloor, 39.7, "(pending fee + vsize × increment) / vsize = 9,925 / 250, rounded up to hundredths without a float artefact");
  assert.equal(r.floorSatVb, 39.7);
  assert.equal(r.satVb, 39.7, "max(chosen, rate floor, absolute-fee floor)");
  assert.equal(r.raised, true);
  assert.equal(r.overCap, false);
  assert.equal(r.incr, 0.1);

  const high = cancelFeeRate({ chosenSatVb: 80, order: filling, incrementalRelayFee: 0.1, vsize: 250 });
  assert.equal(high.satVb, 80, "a chosen rate above the floor is kept");
  assert.equal(high.raised, false);

  const rateOnly = cancelFeeRate({ chosenSatVb: 1.5, order: { status: "filling", pending_feerate: 3, pending_fee_sats: null }, incrementalRelayFee: 0.1 });
  assert.equal(rateOnly.absFloor, null, "no size → no absolute floor");
  assert.equal(rateOnly.satVb, 4.1, "3 + 0.1 + 1");

  const noIncr = cancelFeeRate({ chosenSatVb: 1.5, order: { status: "filling", pending_feerate: 3, pending_fee_sats: 900 }, incrementalRelayFee: null, vsize: 300 });
  assert.equal(noIncr.incr, 1, "unknown incrementalrelayfee → 1 sat/vB (conservative)");
  assert.equal(noIncr.rateFloor, 5);
  assert.equal(noIncr.absFloor, 4, "(900 + 300 × 1) / 300");
  assert.equal(noIncr.satVb, 5);

  const huge = cancelFeeRate({ chosenSatVb: 1.5, order: { status: "filling", pending_feerate: 0.1, pending_fee_sats: 400_000 }, incrementalRelayFee: 0.1, vsize: 250 });
  assert.equal(huge.overCap, true, `above the ${MAX_FEE_RATE_SAT_VB} sat/vB safety cap → the builder refuses; the UI must say so`);
  assert.ok(huge.satVb > MAX_FEE_RATE_SAT_VB);

  const notFilling = cancelFeeRate({ chosenSatVb: 2, order: { status: "open", pending_feerate: 50, pending_fee_sats: 5000 }, incrementalRelayFee: 0.1, vsize: 250 });
  assert.equal(notFilling.satVb, 2, "pending fields on a non-filling order are ignored");
  console.log("market cancel (M-9): filling → max(chosen, pending_feerate + increment + 1, absolute-fee floor); over-cap flagged");
}

// ---- change -------------------------------------------------------------------------------
{
  assert.equal(changeSign(3.2), "up");
  assert.equal(changeSign(-0.4), "down");
  assert.equal(changeSign(0), "flat");
  assert.equal(changeSign(0.004), "flat", "rounds to 0.0%");
  assert.equal(changeSign(null), null);
  assert.equal(fmtChangePct(3.26), "+3.3%");
  assert.equal(fmtChangePct(-1.44), "−1.4%", "a real minus sign");
  assert.equal(fmtChangePct(0), "0.0%");
  assert.equal(fmtChangePct(250.7), "+251%", "no decimals from 100 % up");
  assert.equal(fmtChangePct(undefined), "—");
  console.log("market change: sign-coloured, real minus, adaptive precision");
}

console.log("market: all checks passed");
