// Sanitizer tests for the market-era view shapes in src/lib/indexer.js:
// OrderView (filling + pending_* + expires_at), TradeView.self_trade, the
// token rows' market_24h, /fees.incrementalrelayfee, /tokens/:t/market,
// candles, /activity items, /activity/daily rows, /price and /digits. Plain Node —
// the module guards `import.meta.env` so it loads without Vite; nothing
// here touches the network (the sanitizers are pure).
import assert from "node:assert/strict";
import {
  _sanitizeActivityItem as activityItem,
  _sanitizeCandle as candle,
  _sanitizeDailyRow as dailyRow,
  _sanitizeDigits as digits,
  _sanitizeDigitsByDays as digitsByDaysRow,
  digitsByDays,
  _sanitizeFees as fees,
  _sanitizeMarket as market,
  _sanitizeMarket24h as market24h,
  _sanitizeOrderRow as orderRow,
  _sanitizePrice as price,
  _sanitizeTokenRow as tokenRow,
  _sanitizeTradeRow as tradeRow,
  _sanitizeMineRow as mineRow,
  _sanitizeTxStatus as txStatus,
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
  assert.deepEqual([junk.pending_spend_txid, junk.pending_fee_sats, junk.pending_vsize, junk.pending_feerate], [null, null, null, null], "out-of-range pending fields → null (the cancel fee rule then falls back to the rate floor)");
  const leak = orderRow({ ...base, status: "open", pending_feerate: 0.1, pending_fee_sats: 100 });
  assert.equal(leak.pending_feerate, null, "pending_* on a non-filling order are dropped");
  assert.equal(orderRow({ ...base, status: "withdrawn" }), null, "unknown status → row dropped");
  // A listing that left the book with its outpoint unspent (the seller's own list): still fillable.
  const off = orderRow({ ...base, status: "expired", carrier_sats: undefined, created_at: undefined, dropped_at: 1791489290 });
  assert.equal(off.status, "expired", "an off-book listing is kept");
  assert.equal(off.carrier_sats, null, "its carrier value may be unknown");
  assert.equal(off.dropped_at, 1791489290);
  assert.equal(orderRow({ ...base, carrier_sats: undefined }), null, "a live order still needs its carrier value");
  assert.equal(orderRow({ ...base, unit_price: 1 }).unit_price, 87_121 / 1921, "unit_price is price / amount — a wire value that disagreed would mis-sort the book");
  assert.equal(orderRow({ ...base, unit_price: undefined }).unit_price, 87_121 / 1921);
  console.log("views OrderView: filling + pending_* (bounded, only while filling) + expires_at; null is null");
}

// ---- TradeView.self_trade ---------------------------------------------------------------------
{
  const t = { txid: TX, block_height: 970_096, block_time: 1790000000, ticker: "LUCKY", amount: 1200, price_sats: 60_000, unit_price: 50, seller: P2TR, buyer: P2WPKH };
  assert.equal(tradeRow(t).self_trade, false, "absent → false");
  assert.equal(tradeRow({ ...t, self_trade: true }).self_trade, true);
  assert.equal(tradeRow({ ...t, self_trade: "yes" }).self_trade, false, "only an explicit true");
  assert.equal(tradeRow({ ...t, self_trade: 1 }).self_trade, false);
  // §7.5: `buyer` is null when vout1 has no address form — the fill still counts.
  const noBuyer = tradeRow({ ...t, buyer: null });
  assert.ok(noBuyer, "a fill with an address-less token slot is kept");
  assert.equal(noBuyer.buyer, null);
  assert.equal(tradeRow({ ...t, buyer: "not-an-address" }).buyer, null, "a malformed buyer is null, not a dropped row");
  assert.equal(tradeRow({ ...t, seller: null }), null, "the seller (an order's address) is required");
  assert.equal(tradeRow({ ...t, block_time: 0 }).block_time, null, "block_time 0 = unknown, like every other view");
  assert.equal(tradeRow({ ...t, unit_price: 1 }).unit_price, 50, "unit_price is price / amount — never the wire value");
  assert.equal(tradeRow({ ...t, unit_price: undefined }).unit_price, 50);
  assert.equal(tradeRow({ ...t, price_sats: 0 }), null, "a fill pays ≥ the ask ≥ 546 sats: price 0 is not a trade");
  assert.equal(tradeRow({ ...t, price_sats: 545 }), null);
  console.log("views TradeView: self_trade kept, strictly boolean; buyer may be null; unit_price derived; sub-546 dropped");
}

// ---- token rows' market_24h -------------------------------------------------------------------
{
  assert.deepEqual(market24h({ volume_sats: 592_451, trades: 7, change_pct: -2.2, buyers: 5 }), { volume_sats: 592_451, trades: 7, change_pct: -2.2, buyers: 5 });
  assert.deepEqual(market24h({ volume_sats: "x", trades: -1, change_pct: Infinity, buyers: 5.5 }), { volume_sats: null, trades: null, change_pct: null, buyers: null }, "each field bounded on its own");
  assert.equal(market24h(null), null);
  assert.equal(market24h("soon"), null);
  const tok = { ticker: "LUCKY", supply: 21_000_000, minted: 1_234_567, deployer: P2TR, deploy_txid: TX, deploy_block: 969_896, holders: 412 };
  assert.equal(tokenRow(tok).market_24h, null, "a row without market_24h → null (the card shows —)");
  assert.deepEqual(tokenRow({ ...tok, market_24h: { volume_sats: 10, trades: 1, change_pct: 0, buyers: 1 } }).market_24h, { volume_sats: 10, trades: 1, change_pct: 0, buyers: 1 });
  assert.equal(tokenRow({ ...tok, market_24h: { change_pct: 1e12 } }).market_24h.change_pct, null, "absurd change → null");
  // §2.1 empty deployer: the ticker is still registered — the row survives (a dropped row reads as "free" on the Create page).
  assert.equal(tokenRow({ ...tok, deployer: "" }).deployer, "", "empty deployer is served as \"\" and kept");
  assert.equal(tokenRow({ ...tok, deployer: null }).deployer, "", "null deployer is kept as empty");
  assert.equal(tokenRow({ ...tok, deployer: "x".repeat(129) }), null, "an oversized deployer is still malformed");
  assert.equal(tokenRow({ ...tok, deployer: 42 }), null, "a non-string deployer is still malformed");
  console.log("views /tokens: market_24h sanitized per field, absent → null");
}

// ---- token rows' market gate: minted_out + minted_out_height ------------------------------------
{
  const tok = { ticker: "BLOK", supply: 21_000_000, minted: 1_234_567, deployer: P2TR, deploy_txid: TX, deploy_block: 969_897, holders: 3_310 };
  const below = tokenRow(tok);
  assert.equal(below.minted_out, false, "absent flag, minted < supply → false");
  assert.equal(below.minted_out_height, null);
  const full = tokenRow({ ...tok, minted: 21_000_000 });
  assert.equal(full.minted_out, true, "absent flag → fallback minted >= supply");
  assert.equal(full.minted_out_height, null, "height unknown → null, never 0");
  const flagged = tokenRow({ ...tok, minted: 21_000_000, minted_out: true, minted_out_height: 970_186 });
  assert.equal(flagged.minted_out, true);
  assert.equal(flagged.minted_out_height, 970_186);
  assert.equal(tokenRow({ ...tok, minted_out: true, minted_out_height: 970_186 }).minted_out, true, "the indexer's flag is authoritative even below the supply");
  assert.equal(tokenRow({ ...tok, minted: 21_000_000, minted_out: false }).minted_out, true, "the cumulative reading wins: minted >= supply is minted out");
  assert.equal(tokenRow({ ...tok, minted_out: "yes" }).minted_out, false, "only an explicit true; otherwise the fallback");
  assert.equal(tokenRow({ ...tok, minted_out: true, minted_out_height: -1 }).minted_out_height, null, "negative height → null");
  assert.equal(tokenRow({ ...tok, minted_out: true, minted_out_height: 970186.5 }).minted_out_height, null, "fractional → null");
  assert.equal(tokenRow({ ...tok, minted_out: true, minted_out_height: "970186" }).minted_out_height, 970_186, "numeric string accepted");
  assert.equal(tokenRow({ ...tok, minted_out: true, minted_out_height: 0 }).minted_out_height, 0, "0 is a block height (int ≥ 0)");
  assert.equal(tokenRow({ ...tok, minted_out_height: 970_186 }).minted_out_height, null, "a height on a token that is not minted out is dropped");
  console.log("views /tokens: minted_out (flag, fallback minted >= supply) + minted_out_height (int ≥ 0 | null)");
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
  const raw = { ticker: "LUCKY", window: "24h", as_of: 1790452492, tip_height: 970_196, floor_unit_price: 45.35, open_orders: 2, listed_amount: 3_120, last_trade: { txid: TX, block_height: 970_195, block_time: 1790451650, ticker: "LUCKY", amount: 100, price_sats: 4_700, unit_price: 47, seller: P2TR, buyer: P2WPKH, self_trade: false }, trades: 7, volume_sats: 592_451, buyers: 5, sellers: 4, high_unit_price: 49.1, low_unit_price: 44.2, first_unit_price: 48.1, change_pct: -2.2, self_trades_excluded: 1 };
  const m = market(raw);
  assert.equal(m.ticker, "LUCKY");
  assert.equal(m.window, "24h");
  assert.equal(m.as_of, 1790452492);
  assert.equal(m.tip_height, 970_196);
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
  assert.equal(m.minted_out, false, "market gate absent → false");
  assert.equal(market({ ...raw, minted_out: true }).minted_out, true);
  assert.equal(market({ ...raw, minted_out: 1 }).minted_out, false, "only an explicit true opens the market");
  assert.deepEqual([m.market_open, m.market_opens_at_height], [false, null], "the depth gate absent → closed, height unknown");
  assert.deepEqual([market({ ...raw, minted_out: true, market_open: true, market_opens_at_height: 970_191 }).market_open, market({ ...raw, market_opens_at_height: 970_191 }).market_opens_at_height], [true, 970_191]);
  console.log("views /market: every field bounded, negatives allowed for change_pct, unknown → null; minted_out strict");
}

// ---- finality: depth on every view (the indexer API: confirmations / final / market_open / health) ----------------
{
  // OrderView.market_open: false while the ticker's market is not open (the book then offers no fill)
  const o = { id: `${TX}:1`, ticker: "LUCKY", amount: 10, price_sats: 1_000, seller: P2TR, carrier_sats: 546, status: "open" };
  assert.equal(orderRow(o).market_open, true, "absent → open (an indexer that predates the flag)");
  assert.equal(orderRow({ ...o, market_open: false }).market_open, false);
  // MineView depth
  const mv = mineRow({ txid: TX, ticker: "LUCKY", block_height: 970_197, block_hash: "0".repeat(63) + "f", sender: P2TR, status: "settled", yield_smallest: 1000, confirmations: 2, final: false });
  assert.deepEqual([mv.confirmations, mv.final], [2, false]);
  const mvOld = mineRow({ txid: TX, ticker: "LUCKY", block_height: 970_197, sender: P2TR, status: "settled", yield_smallest: 1000 });
  assert.deepEqual([mvOld.confirmations, mvOld.final], [null, null], "not reported → unknown, never 'final'");
  // /tx-status depth: only for a confirmed tx; final only when explicitly true
  const ts = txStatus(TX, { confirmed: true, block_height: 970_197, block_hash: "0".repeat(64), confirmations: 6, final: true });
  assert.deepEqual([ts.confirmations, ts.final], [6, true]);
  assert.deepEqual([txStatus(TX, { confirmed: true, block_height: 1, block_hash: "0".repeat(64), final: "yes" }).final, txStatus(TX, { confirmed: false, seen: true, confirmations: 3 }).confirmations], [false, null]);
  assert.deepEqual([txStatus(TX, null, false).confirmations, txStatus(TX, null, false).final], [null, false]);
  console.log("views depth: order market_open, mine confirmations / final, tx-status confirmations / final");
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
  const trade = activityItem({ kind: "trade", txid: TX.toUpperCase(), block_height: 970_195, block_time: 1790451650, ticker: "SATS", amount: 2360, buyer: P2WPKH, seller: P2TR, price_sats: 7099, unit_price: 3.008, self_trade: true });
  assert.equal(trade.kind, "trade");
  assert.equal(trade.txid, TX, "lower-cased");
  assert.equal(trade.block_height, 970_195);
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

// ---- /digits ---------------------------------------------------------------------------------
{
  const ok = digits({ tip_height: 970_196, from: 970_193, to: 970_196, digits: "0f7c" }, 1008);
  assert.deepEqual(ok, { tip_height: 970_196, from: 970_193, to: 970_196, digits: "0f7c" }, "a consistent record passes as is");
  assert.deepEqual(digits({ tip_height: 970_196, from: 970_193, to: 970_196, digits: "0F7C" }, 1008).digits, "0f7c", "lower-cased");
  assert.deepEqual(digits({ tip_height: 970_196, from: 970_196, to: 970_196, digits: "a" }, 1), { tip_height: 970_196, from: 970_196, to: 970_196, digits: "a" }, "limit 1");
  // to = min(before, tip): a record ending below the tip is fine.
  assert.equal(digits({ tip_height: 970_196, from: 969_096, to: 969_099, digits: "0123" }, 1008).digits, "0123");

  const EMPTY = { tip_height: 970_196, from: 970_197, to: 970_196, digits: "" };
  assert.deepEqual(digits({ tip_height: 970_196, from: 970_197, to: 970_196, digits: "" }, 1008), EMPTY, "the indexer's empty record (from = to + 1) passes");
  assert.deepEqual(digits({ tip_height: 970_196, from: 970_193, to: 970_196, digits: "0f7g" }, 1008), EMPTY, "non-hex → empty, never trimmed");
  assert.deepEqual(digits({ tip_height: 970_196, from: 970_193, to: 970_196, digits: "0f7" }, 1008), EMPTY, "length ≠ to − from + 1 → empty");
  assert.deepEqual(digits({ tip_height: 970_196, from: 970_193, to: 970_196, digits: "0f7cc" }, 1008), EMPTY, "too long for the range → empty");
  assert.deepEqual(digits({ tip_height: 970_196, from: 970_195, to: 970_196, digits: "0f" }, 1), EMPTY, "longer than the limit asked → empty");
  assert.deepEqual(digits({ tip_height: 970_196, from: 970_196, to: 970_197, digits: "0f" }, 1008), EMPTY, "past the tip → empty");
  assert.deepEqual(digits({ tip_height: 970_196, from: 970_195, to: 970_196, digits: ["0", "f"] }, 1008), EMPTY, "digits must be a string");
  assert.deepEqual(digits({ tip_height: 970_196, from: "x", to: 970_196, digits: "0" }, 1008), EMPTY, "malformed from → empty");
  assert.deepEqual(digits({ tip_height: 970_196, from: -1, to: 0, digits: "0f" }, 1008), EMPTY, "negative height → empty");
  assert.deepEqual(digits({ tip_height: null, from: 1, to: 2, digits: "0f" }, 1008), { tip_height: null, from: null, to: null, digits: "" }, "no tip → empty with null heights");
  assert.deepEqual(digits(null, 1008), { tip_height: null, from: null, to: null, digits: "" }, "no envelope → empty");
  assert.deepEqual(digits("0f7c", 1008), { tip_height: null, from: null, to: null, digits: "" }, "a bare string is not the contract");
  console.log("views /digits: contiguous lower-case hex or an empty record — never padded, never patched");
}

// ---- /digits?days ----------------------------------------------------------------------------
{
  const SINCE = 1_790_000_000;
  const env = { tip_height: 970_196, from: 970_193, to: 970_196, digits: "0F7C", since: SINCE, complete: true };
  const emptyAs = (status, tip = 970_196) => ({ tip_height: tip, from: tip === null ? null : tip + 1, to: tip, digits: "", since: null, complete: null, status });
  assert.deepEqual(digitsByDaysRow(env), { tip_height: 970_196, from: 970_193, to: 970_196, digits: "0f7c", since: SINCE, complete: true, status: "ok" }, "a consistent day window passes (lower-cased)");
  assert.deepEqual(digitsByDaysRow({ ...env, complete: false }), { tip_height: 970_196, from: 970_193, to: 970_196, digits: "0f7c", since: SINCE, complete: false, status: "ok" }, "log ran out before the window's edge");
  // complete is strictly boolean; since an integer ≥ 0. Anything else is a malformed answer — never "still loading".
  for (const c of [undefined, null, "true", 1, {}, [true]]) assert.deepEqual(digitsByDaysRow({ ...env, complete: c }), emptyAs("invalid"), `complete ${JSON.stringify(c)} → invalid`);
  assert.equal(digitsByDaysRow({ ...env, since: 0 }).since, 0);
  for (const v of [undefined, null, -1, 1.5, "x", NaN, Infinity, 1e13]) assert.deepEqual(digitsByDaysRow({ ...env, since: v }), emptyAs("invalid"), `since ${String(v)} → invalid`);
  assert.equal(digitsByDaysRow({ ...env, since: "1790000000" }).since, SINCE, "a numeric string is the same integer");
  // An indexer from before day windows ignores `days` and answers its block-count default with neither
  // since nor complete: that is not the asked window, so nothing of it is shown — and it is not "loading".
  const oldIndexer = { tip_height: 970_196, from: 969_189, to: 970_196, digits: "a".repeat(1008) };
  assert.deepEqual(digitsByDaysRow(oldIndexer), emptyAs("unsupported"), "no since / complete → unsupported, empty");
  assert.deepEqual(digitsByDaysRow({ ...oldIndexer, since: null, complete: null }), emptyAs("unsupported"), "null since / complete → unsupported");
  assert.deepEqual(digitsByDaysRow({ ...oldIndexer, complete: false }), emptyAs("invalid"), "complete without since → invalid");
  assert.deepEqual(digitsByDaysRow({ ...oldIndexer, since: SINCE }), emptyAs("invalid"), "since without complete → invalid");
  // A window is by time, so its length is not tied to a day count — up to DIGITS_MAX heights pass.
  const long = "0".repeat(10_080);
  assert.equal(digitsByDaysRow({ tip_height: 970_196, from: 970_196 - 10_079, to: 970_196, digits: long, since: SINCE, complete: true }).digits.length, 10_080);
  assert.deepEqual(
    digitsByDaysRow({ tip_height: 970_196, from: 970_196 - 10_080, to: 970_196, digits: long + "0", since: SINCE, complete: true }),
    emptyAs("invalid"),
    "longer than DIGITS_MAX → empty, invalid",
  );
  // The empty window keeps its complete flag: true = blocks held, none inside the window
  // (to = the newest held height); false = nothing held yet.
  assert.deepEqual(
    digitsByDaysRow({ tip_height: 970_196, from: 970_197, to: 970_196, digits: "", since: SINCE, complete: true }),
    { tip_height: 970_196, from: 970_197, to: 970_196, digits: "", since: SINCE, complete: true, status: "ok" },
  );
  assert.deepEqual(
    digitsByDaysRow({ tip_height: 970_196, from: 970_197, to: 970_196, digits: "", since: SINCE, complete: false }),
    { tip_height: 970_196, from: 970_197, to: 970_196, digits: "", since: SINCE, complete: false, status: "ok" },
  );
  // Anything the digit checks reject is the empty record, invalid (complete null — nothing vouches either way).
  assert.deepEqual(digitsByDaysRow({ ...env, digits: "0f7g" }), emptyAs("invalid"), "non-hex → invalid");
  assert.deepEqual(digitsByDaysRow({ ...env, to: 970_197 }), emptyAs("invalid"), "past the tip → invalid");
  assert.deepEqual(digitsByDaysRow(null), emptyAs("invalid", null), "no envelope");
  assert.deepEqual(digitsByDaysRow("0f7c"), emptyAs("invalid", null), "a bare string is not the contract");

  // digitsByDays asks GET /digits?days=N with N clamped to 1..=60 (fetch stubbed — no network).
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url).replace(/^https?:\/\/[^/]+/, ""));
    return { ok: true, status: 200, json: async () => env, text: async () => "" };
  };
  try {
    const r = await digitsByDays(30);
    assert.equal(r.complete, true);
    assert.equal(r.digits, "0f7c");
    for (const d of [1, 7, 60, 0, -3, 61, 1e6, 2.9, "30", null, undefined, "x"]) await digitsByDays(d);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(asked, [
    "/digits?days=30",
    "/digits?days=1",
    "/digits?days=7",
    "/digits?days=60",
    "/digits?days=1",
    "/digits?days=1",
    "/digits?days=60",
    "/digits?days=60",
    "/digits?days=2",
    "/digits?days=30",
    "/digits?days=7",
    "/digits?days=7",
    "/digits?days=7",
  ]);
  console.log("views /digits?days: ok (since int ≥ 0 + complete boolean) | unsupported (older indexer) | invalid; days clamped 1..60");
}

console.log("views: all checks passed");
