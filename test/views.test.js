// Sanitizer tests for the market-era view shapes in src/lib/indexer.js:
// OrderView (filling + pending_* + expires_at), TradeView.self_trade, the
// token rows' market_24h, /fees.incrementalrelayfee, /tokens/:t/market,
// candles, /activity items, /activity/daily rows and /price. Plain Node —
// the module guards `import.meta.env` so it loads without Vite; nothing
// here touches the network (the sanitizers are pure).
import assert from "node:assert/strict";
import {
  _sanitizeActivityItem as activityItem,
  _sanitizeCandle as candle,
  _sanitizeDailyRow as dailyRow,
  _sanitizeFees as fees,
  _sanitizeMarket as market,
  _sanitizeMarket24h as market24h,
  _sanitizeOrderRow as orderRow,
  _sanitizePrice as price,
  _sanitizeTokenRow as tokenRow,
  _sanitizeTradeRow as tradeRow,
} from "../src/lib/indexer.js";

const TX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const P2TR = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const P2WPKH = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

// ---- OrderView ------------------------------------------------------------------------------
{
  const base = { id: `${TX}:1`, ticker: "LUCKY", amount: 1921, price_sats: 87_121, unit_price: 45.35, seller: P2TR, carrier_sats: 546, status: "open", created_at: 1790279690, updated_at: 1790279690, expires_at: 1791489290, spent_txid: null, spent_block: null, buyer: null };
  const open = orderRow(base);
  assert.equal(open.status, "open");
  assert.equal(open.expires_at, 1791489290, "expires_at kept");
  assert.equal(open.spent_block, null, "null stays null — never 0");
  assert.deepEqual([open.pending_spend_txid, open.pending_fee_sats, open.pending_vsize, open.pending_feerate], [null, null, null, null], "pending_* null when open");
  assert.equal(orderRow({ ...base, expires_at: "soon" }).expires_at, null, "malformed expiry → null");
  assert.equal(orderRow({ ...base, expires_at: -5 }).expires_at, null);

  const filling = orderRow({ ...base, status: "filling", pending_spend_txid: TX.toUpperCase(), pending_fee_sats: 9_900, pending_vsize: 99_000, pending_feerate: 0.1 });
  assert.equal(filling.status, "filling", "the new status is accepted");
  assert.equal(filling.pending_spend_txid, TX, "lower-cased txid");
  assert.equal(filling.pending_fee_sats, 9_900);
  assert.equal(filling.pending_vsize, 99_000);
  assert.equal(filling.pending_feerate, 0.1);
  const junk = orderRow({ ...base, status: "filling", pending_spend_txid: "nope", pending_fee_sats: -1, pending_vsize: 5e6, pending_feerate: "fast" });
  assert.deepEqual([junk.pending_spend_txid, junk.pending_fee_sats, junk.pending_vsize, junk.pending_feerate], [null, null, null, null], "out-of-range pending fields → null (the M-9 rule then falls back to the rate floor)");
  const leak = orderRow({ ...base, status: "open", pending_feerate: 0.1, pending_fee_sats: 100 });
  assert.equal(leak.pending_feerate, null, "pending_* on a non-filling order are dropped");
  assert.equal(orderRow({ ...base, status: "expired" }), null, "unknown status → row dropped");
  console.log("views OrderView: filling + pending_* (bounded, only while filling) + expires_at; null is null");
}

// ---- TradeView.self_trade ---------------------------------------------------------------------
{
  const t = { txid: TX, block_height: 969_700, block_time: 1790000000, ticker: "LUCKY", amount: 1200, price_sats: 60_000, unit_price: 50, seller: P2TR, buyer: P2WPKH };
  assert.equal(tradeRow(t).self_trade, false, "absent → false");
  assert.equal(tradeRow({ ...t, self_trade: true }).self_trade, true);
  assert.equal(tradeRow({ ...t, self_trade: "yes" }).self_trade, false, "only an explicit true");
  assert.equal(tradeRow({ ...t, self_trade: 1 }).self_trade, false);
  console.log("views TradeView: self_trade kept, strictly boolean");
}

// ---- token rows' market_24h -------------------------------------------------------------------
{
  assert.deepEqual(market24h({ volume_sats: 592_451, trades: 7, change_pct: -2.2, buyers: 5 }), { volume_sats: 592_451, trades: 7, change_pct: -2.2, buyers: 5 });
  assert.deepEqual(market24h({ volume_sats: "x", trades: -1, change_pct: Infinity, buyers: 5.5 }), { volume_sats: null, trades: null, change_pct: null, buyers: null }, "each field bounded on its own");
  assert.equal(market24h(null), null);
  assert.equal(market24h("soon"), null);
  const tok = { ticker: "LUCKY", supply: 21_000_000, minted: 1_234_567, deployer: P2TR, deploy_txid: TX, deploy_block: 969_500, holders: 412 };
  assert.equal(tokenRow(tok).market_24h, null, "a row without market_24h → null (the card shows —)");
  assert.deepEqual(tokenRow({ ...tok, market_24h: { volume_sats: 10, trades: 1, change_pct: 0, buyers: 1 } }).market_24h, { volume_sats: 10, trades: 1, change_pct: 0, buyers: 1 });
  assert.equal(tokenRow({ ...tok, market_24h: { change_pct: 1e12 } }).market_24h.change_pct, null, "absurd change → null");
  console.log("views /tokens: market_24h sanitized per field, absent → null");
}

// ---- /fees.incrementalrelayfee ----------------------------------------------------------------
{
  const f = fees({ fastestFee: 2.38, halfHourFee: 1.5, hourFee: 1.25, economyFee: 1.02, minimumFee: 1, incrementalrelayfee: 0.1 });
  assert.equal(f.incrementalrelayfee, 0.1);
  assert.equal(fees({ halfHourFee: 1.5 }).incrementalrelayfee, null, "missing → null (the cancel rule assumes 1)");
  assert.equal(fees({ incrementalrelayfee: -1 }).incrementalrelayfee, null);
  assert.equal(fees({ incrementalrelayfee: "0.1" }).incrementalrelayfee, 0.1, "numeric strings are numbers");
  assert.equal(fees(null).incrementalrelayfee, null);
  console.log("views /fees: incrementalrelayfee bounded like the other rates");
}

// ---- /tokens/:ticker/market -------------------------------------------------------------------
{
  const raw = { ticker: "LUCKY", window: "24h", as_of: 1790452492, tip_height: 969_800, floor_unit_price: 45.35, open_orders: 2, listed_amount: 3_120, last_trade: { txid: TX, block_height: 969_799, block_time: 1790451650, ticker: "LUCKY", amount: 100, price_sats: 4_700, unit_price: 47, seller: P2TR, buyer: P2WPKH, self_trade: false }, trades: 7, volume_sats: 592_451, buyers: 5, sellers: 4, high_unit_price: 49.1, low_unit_price: 44.2, first_unit_price: 48.1, change_pct: -2.2, self_trades_excluded: 1 };
  const m = market(raw);
  assert.equal(m.ticker, "LUCKY");
  assert.equal(m.window, "24h");
  assert.equal(m.as_of, 1790452492);
  assert.equal(m.tip_height, 969_800);
  assert.equal(m.floor_unit_price, 45.35);
  assert.equal(m.open_orders, 2);
  assert.equal(m.listed_amount, 3_120);
  assert.equal(m.last_trade.unit_price, 47, "last_trade is a sanitized TradeView");
  assert.equal(m.trades, 7);
  assert.equal(m.volume_sats, 592_451);
  assert.equal(m.buyers, 5);
  assert.equal(m.sellers, 4);
  assert.equal(m.high_unit_price, 49.1);
  assert.equal(m.low_unit_price, 44.2);
  assert.equal(m.first_unit_price, 48.1);
  assert.equal(m.change_pct, -2.2, "negative changes survive");
  assert.equal(m.self_trades_excluded, 1);
  assert.equal(market({ ...raw, self_trades_excluded: true }).self_trades_excluded, true, "a flag is kept as a flag");
  assert.equal(market({ ...raw, self_trades_excluded: "1" }).self_trades_excluded, 1, "a numeric string is a count");
  const empty = market({ ticker: "VOLT", window: "7d" });
  assert.equal(empty.window, "7d");
  assert.deepEqual([empty.floor_unit_price, empty.last_trade, empty.trades, empty.volume_sats, empty.change_pct, empty.high_unit_price], [null, null, null, null, null, null], "a brand-new token: everything unknown, nothing 0");
  assert.equal(market({ ...raw, window: "1y" }).window, null, "unknown window → null");
  assert.equal(market({ ...raw, change_pct: NaN }).change_pct, null);
  assert.equal(market({ ...raw, listed_amount: 22_000_000 }).listed_amount, null, "above the supply cap → null");
  assert.equal(market({ ...raw, last_trade: { txid: "bad" } }).last_trade, null, "malformed last_trade → null");
  assert.equal(market({ ...raw, ticker: "lucky" }), null, "bad ticker → no view");
  assert.equal(market(null), null);
  console.log("views /market: every field bounded, negatives allowed for change_pct, unknown → null");
}

// ---- candles ------------------------------------------------------------------------------
{
  const c = candle({ t: 1790400000, o: 50, h: 55, l: 48, c: 52, v_sats: 10_000, v_amount: 200, n: 3 });
  assert.deepEqual(c, { t: 1790400000, o: 50, h: 55, l: 48, c: 52, v_sats: 10_000, v_amount: 200, n: 3 });
  assert.deepEqual(candle({ t: 1, o: 1, h: 1, l: 1, c: 1 }), { t: 1, o: 1, h: 1, l: 1, c: 1, v_sats: 0, v_amount: 0, n: 0 }, "missing volumes → 0 (a bucket without volume still has a price)");
  assert.equal(candle({ t: 1, o: 50, h: 49, l: 48, c: 50 }), null, "high below open/close → dropped");
  assert.equal(candle({ t: 1, o: 50, h: 55, l: 51, c: 52 }), null, "low above open → dropped");
  assert.equal(candle({ t: 1, o: 50, h: 55, l: 48, c: 56 }), null, "close above high → dropped");
  assert.equal(candle({ t: "x", o: 1, h: 1, l: 1, c: 1 }), null, "no bucket time → dropped");
  assert.equal(candle({ t: 1, o: -1, h: 1, l: -1, c: 1 }), null, "negative price → dropped");
  assert.equal(candle({ t: 1, o: 1, h: 1, l: 1, c: 1, v_sats: -5, n: "many" }).v_sats, 0, "bad volume → 0");
  assert.equal(candle(null), null);
  console.log("views candles: o/h/l/c must bracket, volumes default to 0, malformed dropped");
}

// ---- /activity items --------------------------------------------------------------------------
{
  const trade = activityItem({ kind: "trade", txid: TX.toUpperCase(), block_height: 969_799, block_time: 1790451650, ticker: "SATS", amount: 2360, buyer: P2WPKH, seller: P2TR, price_sats: 7099, unit_price: 3.008, self_trade: true });
  assert.equal(trade.kind, "trade");
  assert.equal(trade.txid, TX, "lower-cased");
  assert.equal(trade.block_height, 969_799);
  assert.equal(trade.block_time, 1790451650);
  assert.equal(trade.amount, 2360);
  assert.equal(trade.buyer, P2WPKH);
  assert.equal(trade.seller, P2TR);
  assert.equal(trade.price_sats, 7099);
  assert.equal(trade.unit_price, 3.008);
  assert.equal(trade.self_trade, true);
  assert.deepEqual([trade.from, trade.to, trade.sender, trade.deployer], [null, null, null, null], "fields of other kinds → null");
  assert.equal(trade.applied, true, "absent → applied");
  const mine = activityItem({ kind: "mine", txid: TX, block_height: 1, block_time: null, ticker: "X", amount: 0, sender: P2TR });
  assert.equal(mine.block_time, null, "unknown time → null, never 0");
  assert.equal(mine.amount, 0, "a cap-exhausted mine credits 0 — kept");
  assert.equal(mine.sender, P2TR);
  assert.equal(mine.self_trade, false);
  assert.equal(activityItem({ kind: "mine", txid: TX, block_height: 1, block_time: 0, ticker: "X", sender: P2TR }).block_time, null, "block_time 0 (row written before the upgrade) → unknown");
  assert.equal(activityItem({ kind: "mine", txid: TX, block_height: 1, ticker: "X", applied: false, amount: 0 }).applied, false, "an invalid MINE / non-applied SEND");
  assert.equal(activityItem({ kind: "send", txid: TX, block_height: 1, ticker: "X", applied: "no" }).applied, true, "only an explicit false is not applied");
  const send = activityItem({ kind: "send", txid: TX, block_height: 2, ticker: "X", amount: 40, from: P2TR, to: "not-an-address", sender: P2TR });
  assert.equal(send.from, P2TR);
  assert.equal(send.to, null, "malformed party → null (the row still renders)");
  const deploy = activityItem({ kind: "deploy", txid: TX, block_height: 3, ticker: "X", deployer: P2WPKH });
  assert.equal(deploy.deployer, P2WPKH);
  assert.equal(deploy.amount, null);
  assert.equal(activityItem({ kind: "burn", txid: TX, block_height: 1, ticker: "X" }), null, "unknown kind → dropped");
  assert.equal(activityItem({ kind: "mine", txid: "zz", block_height: 1, ticker: "X" }), null, "bad txid → dropped");
  assert.equal(activityItem({ kind: "mine", txid: TX, ticker: "X" }), null, "no height → dropped");
  assert.equal(activityItem({ kind: "mine", txid: TX, block_height: 1, ticker: "toolongticker" }), null);
  assert.equal(activityItem({ kind: "trade", txid: TX, block_height: 1, ticker: "X", price_sats: 22e14 }).price_sats, null, "above 21e14 sats → null");
  console.log("views /activity: kind gate, identity required, parties as mainnet shapes or null, self_trade strict");
}

// ---- /activity/daily rows ---------------------------------------------------------------------
{
  const d = dailyRow({ date: "2026-09-26", events: 82, deploys: 2, mines: 23, sends: 2, trades: 55, active_addresses: 21, token_amount: 92_660, volume_sats: 21_247_540 });
  assert.deepEqual(d, { date: "2026-09-26", events: 82, deploys: 2, mines: 23, sends: 2, trades: 55, active_addresses: 21, token_amount: 92_660, volume_sats: 21_247_540 });
  assert.deepEqual(dailyRow({ date: "2026-09-26" }), { date: "2026-09-26", events: 0, deploys: 0, mines: 0, sends: 0, trades: 0, active_addresses: 0, token_amount: 0, volume_sats: 0 }, "missing counts → 0 (a chart bar, not a hole)");
  assert.equal(dailyRow({ date: "2026-09-26", events: -3 }).events, 0, "negative → 0");
  assert.equal(dailyRow({ date: "2026-09-26", volume_sats: 22e14 }).volume_sats, 0, "above 21e14 → 0");
  assert.equal(dailyRow({ date: "26/09/2026" }), null, "not ISO → dropped");
  assert.equal(dailyRow({ date: "2026-13-01" }), null, "month 13 → dropped");
  assert.equal(dailyRow({ date: "2026-09-32" }), null);
  assert.equal(dailyRow({}), null);
  assert.equal(dailyRow(null), null);
  console.log("views /activity/daily: ISO date required, counts bounded, missing → 0");
}

// ---- /price ---------------------------------------------------------------------------------
{
  assert.deepEqual(price({ usd_per_btc: 67_250, as_of: 1790452492, source: "mock" }), { usd_per_btc: 67_250, as_of: 1790452492, source: "mock" });
  assert.deepEqual(price({ usd_per_btc: null, as_of: 1790452492, source: "coingecko" }), { usd_per_btc: null, as_of: 1790452492, source: "coingecko" }, "null price = no USD anywhere");
  assert.equal(price({ usd_per_btc: 0 }).usd_per_btc, null, "0 is not a price");
  assert.equal(price({ usd_per_btc: -1 }).usd_per_btc, null);
  assert.equal(price({ usd_per_btc: "67250" }).usd_per_btc, 67_250, "numeric string accepted");
  assert.equal(price({ usd_per_btc: "many" }).usd_per_btc, null);
  assert.equal(price({ usd_per_btc: 1e12 }).usd_per_btc, null, "absurd → null");
  assert.equal(price({ usd_per_btc: 1, source: "x".repeat(65) }).source, null, "source bounded to 64 chars");
  assert.deepEqual(price(null), { usd_per_btc: null, as_of: null, source: null });
  assert.deepEqual(price("67250"), { usd_per_btc: null, as_of: null, source: null }, "a bare number is not the contract");
  console.log("views /price: positive finite number or null; the UI never sees NaN");
}

console.log("views: all checks passed");
