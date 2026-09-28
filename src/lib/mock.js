// Deterministic mock indexer (VITE_MOCK=1).
//
// Implemented as a fake HTTP layer keyed by route path, so indexer.js runs
// the SAME parsers + sanitizers over mock data that it runs over a live
// indexer. Nothing here is random: identities, txids, block hashes, the
// trade history and the order book all derive from sha256 of stable seeds,
// so every reload shows the same world. The only clock is the simulated
// broadcast timer (a broadcast confirms ~20 s after it is registered).
//
// It is also a tiny indexer: a broadcast raw tx is decoded, its inputs are
// marked spent, and on confirmation its OP_RETURN payload is applied with
// the §2 / §4.1 rules in src/lib/mockRouting.js — the fee checks, the MINE
// validity rule, the burn when the default output is missing or
// address-less, the §2.1 deployer attribution (as far as the mock knows the
// prevouts) — open orders whose outpoint was spent are settled per §7.5
// (the payment is judged at the listed input's own index), and fills
// append a TradeView. It is a simulator for browser checks: consensus is
// asserted by the indexer's Rust tests and the shared vector files.
// That is what lets the whole listing → fill → trade loop run end-to-end
// without a node.
//
// The seeded order book carries REAL signed listings: each seller is a
// deterministic secp256k1 key and its PSBT is signed with
// SINGLE|ANYONECANPAY at first access, so `verifyListing` passes exactly as
// it would against a live indexer. Seeding is lazy (first mock call) so a
// production bundle that merely imports this module pays nothing.

import { sha256 } from "@noble/hashes/sha2.js";
import { hex, bech32, bech32m } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import { EXPECTED_YIELD, bucketOfYield, mineYield } from "./yield.js";
import { DAYS_MAX, DIGITS_DEFAULT, DIGITS_MAX } from "./digits.js";
import { REQUIRED_TOKEN_SUPPLY, DUST_SATS, PROJECT_FEE_ADDRESS, buildMinePayload, buildSendPayload } from "./payloads.js";
import { buildListingPsbt, verifyListing, parseListing, decodeRawTx, LISTING_SIGHASH } from "./swap.js";
import { aggregateDaily } from "./activity.js";
import { makeOpReturnScript } from "./psbt.js";
import { compareSecondSource } from "./secondSource.js";
import { isFillOf, isOpReturnOut, routeDecision } from "./mockRouting.js";
import { MAX_COMMIT_AGE, MIN_COMMIT_AGE } from "./payloads.js";
import { serverErrorText } from "./httpError.js";
import { COMMIT_CARRIER_LISTING_TEXT, MAX_OPEN_LISTINGS_PER_ADDRESS, WITHDRAW_FIRST_TEXT, sellerCapError } from "./listingRules.js";

const BASE_TIP = 969_800;
const CONFIRM_AFTER_MS = 20_000;
const LATENCY_MS = 120;
const LOAD_TS = Math.floor(Date.now() / 1000);
const ORDER_TTL_SEC = 14 * 86400;      // §7.4: an open order expires 14 days after updated_at
const MAX_ASK_BAND_MULTIPLE = 100;     // §7.4: a new ask may be at most 100× the ticker's best open ask
const USD_PER_BTC = 67_250;            // /price — a fixed number so USD sub-labels can be previewed
const INCREMENTAL_RELAY_FEE = 0.1;     // /fees.incrementalrelayfee — Bitcoin Core's default (sat/vB)
const DAY_BLOCKS = 144;
// /digits: the mock's digit log holds this many blocks below the tip (~41
// days) — deep enough to fill the 30-day window, shallow enough that the
// 60-day one runs out first (complete: false → "history still loading").
const DIGIT_LOG_DEPTH = 6_000;
// /digits?days: the mock's "now" is the tip's header time plus this many
// seconds (LOAD_TS at the seeded tip) — fixed, never the wall clock, so a
// day window does not drift between polls while the mock tip stands still.
const DIGITS_NOW_AFTER_TIP = 240;

const enc = (s) => new TextEncoder().encode(s);
const h256 = (s) => hex.encode(sha256(enc(s)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (u) => `${u.txid}:${u.vout}`;

/** Deterministic [0,1) from a seed string. */
function rand(seed) {
  return parseInt(h256(seed).slice(0, 8), 16) / 0x100000000;
}
const randInt = (seed, lo, hi) => lo + Math.floor(rand(seed) * (hi - lo + 1));

// ---- deterministic identities -------------------------------------------------------

function fakeP2tr(seed) {
  const prog = sha256(enc(`p2tr:${seed}`));
  return bech32m.encode("bc", [1, ...bech32m.toWords(prog)]);
}
function fakeP2wpkh(seed) {
  const prog = sha256(enc(`p2wpkh:${seed}`)).slice(0, 20);
  return bech32.encode("bc", [0, ...bech32.toWords(prog)]);
}
function fakeTxid(seed) {
  return h256(`txid:${seed}`);
}

/**
 * A real keypair + address derived from a PUBLIC seed. Sellers in the
 * seeded order book need genuine keys so their listings carry genuine
 * SINGLE|ANYONECANPAY signatures. Never fund any of these.
 */
function identity(seed, type) {
  const priv = sha256(enc(`luckyprotocol-mock-key:${seed} (public seed, never fund)`));
  const pub = pubECDSA(priv, true);
  if (type === "wpkh") {
    const p = btc.p2wpkh(pub, btc.NETWORK);
    return { priv, pubkeyHex: hex.encode(pub), address: p.address, type };
  }
  const p = btc.p2tr(pubSchnorr(priv), undefined, btc.NETWORK);
  return { priv, pubkeyHex: hex.encode(pub), address: p.address, type: "tr" };
}

/** Simulated wallet identity (the "Use simulated wallet" affordance). */
const MOCK_ID = identity("wallet", "tr");
export const MOCK_WALLET = { address: MOCK_ID.address, pubkeyHex: MOCK_ID.pubkeyHex };

/**
 * Sign like the extension would: honors `toSignInputs` (index, address,
 * sighashTypes) and `autoFinalized`. Refuses inputs not owned by the mock
 * wallet, exactly like UniSat refuses a foreign address.
 */
export function mockSignPsbt(psbtHex, { autoFinalized = true, toSignInputs } = {}) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });
  const rows = Array.isArray(toSignInputs) && toSignInputs.length
    ? toSignInputs
    : Array.from({ length: tx.inputsLength }, (_, index) => ({ index }));
  for (const row of rows) {
    const idx = Number(row.index);
    if (row.address && row.address !== MOCK_WALLET.address) {
      throw new Error(`mock wallet: input ${idx} belongs to ${row.address}, not the connected account`);
    }
    const allowed = Array.isArray(row.sighashTypes) && row.sighashTypes.length ? row.sighashTypes.map(Number) : undefined;
    tx.signIdx(MOCK_ID.priv, idx, allowed);
    if (autoFinalized) tx.finalizeIdx(idx);
  }
  return hex.encode(tx.toPSBT());
}

// ---- blocks ----------------------------------------------------------------------------

// A mainnet-looking block hash: 19 leading zero nibbles + 44 pseudo-random
// nibbles + a last nibble that can be forced to land in a yield bucket.
const FORCED_DIGITS = new Map(); // height → digit
function blockHashAt(height) {
  const raw = h256(`block:${height}`);
  const forced = FORCED_DIGITS.get(height);
  const last = forced ?? raw[63];
  return `${"0".repeat(19)}${raw.slice(19, 63)}${last}`;
}
// Pin a block's last nibble to one of the digits that yields `y`, picked
// deterministically from the bucket's digit set (BUCKETS in yield.js).
function forceYield(height, y) {
  const b = bucketOfYield(y);
  if (!b) throw new Error(`mock: ${y} is not a yield tier`);
  const raw = h256(`block:${height}`);
  const pick = parseInt(raw[40], 16);
  FORCED_DIGITS.set(height, b.digits[pick % b.digits.length]);
}
// Display fixtures only; production capacity always comes from Bitcoin Core.
function blockCapacityAt(height) {
  const weights = [3_999_200, 3_840_000, 2_120_000, 3_520_000, 1_040_000, 2_800_000, 3_996_000, 3_100_000];
  const weight = weights[height % weights.length];
  return { weight, tx_count: Math.floor(weight / 920) };
}

function blockTimeAt(height) {
  return LOAD_TS - (BASE_TIP - height) * 600 - 240;
}

// ---- seeded world (lazy) -------------------------------------------------------------------

const TOKEN_SEEDS = [
  { ticker: "LUCKY", minted: 1_234_567, deploy_block: 969_500, holders: 412, base: 48, deployerType: "tr" },
  // BLOK is minted out: its market is the one open market of the mock world.
  // The MINE that completed the supply confirmed at block 965,000 (~33 days
  // before the tip), before the earliest seeded fill, so the 30 days of
  // trade history keep their spread (1d candles, 7d vs 24h windows).
  { ticker: "BLOK", minted: REQUIRED_TOKEN_SUPPLY, minted_out_height: 965_000, deploy_block: 960_000, holders: 3_310, base: 12.5, deployerType: "tr" },
  { ticker: "SATS", minted: 8_400_000, deploy_block: 969_505, holders: 1_904, base: 3.2, deployerType: "wpkh" },
  { ticker: "ORE", minted: 42_021, deploy_block: 969_512, holders: 57, base: 310, deployerType: "wpkh" },
  { ticker: "NODE", minted: 620_500, deploy_block: 969_530, holders: 233, base: 85, deployerType: "tr" },
  { ticker: "GRID", minted: 210_000, deploy_block: 969_600, holders: 120, base: 140, deployerType: "tr" },
  { ticker: "PIXEL", minted: 3_150, deploy_block: 969_790, holders: 9, base: 1_200, deployerType: "wpkh" },
  { ticker: "VOLT", minted: 0, deploy_block: 969_799, holders: 0, base: 0, deployerType: "tr" }, // brand-new: no mines, no trades, no asks
];

// Roughly the model mix over 20 rows: 1–2 × 1000, ~6 × 500, ~6 × 200, ~6 × 100.
const YIELD_PATTERN = [100, 500, 200, 1000, 100, 200, 500, 100, 500, 200, 100, 1000, 200, 500, 100, 200, 500, 100, 200, 500];
const FEED_TICKERS = ["LUCKY", "SATS", "LUCKY", "BLOK", "LUCKY", "NODE", "LUCKY", "SATS", "BLOK", "LUCKY", "ORE", "LUCKY", "GRID", "SATS", "LUCKY", "BLOK", "NODE", "LUCKY", "SATS", "BLOK"];
const SENDERS = Array.from({ length: 7 }, (_, i) =>
  i % 3 === 2 ? fakeP2wpkh(`miner-${i}`) : fakeP2tr(`miner-${i}`),
);

let W = null; // the seeded world, built on first access

/** An open OrderView with a REAL SINGLE|ANYONECANPAY signature from `seller` (an identity()). */
function signedOrder({ seller, utxo, ticker, amount, price_sats, created_at }) {
  const built = buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo: utxo, priceSats: price_sats, amount });
  const tx = btc.Transaction.fromPSBT(hex.decode(built.psbtHex));
  tx.signIdx(seller.priv, 0, [LISTING_SIGHASH]);
  return {
    id: key(utxo),
    ticker,
    amount,
    price_sats,
    unit_price: price_sats / amount,
    seller: seller.address,
    carrier_sats: utxo.sats,
    status: "open",
    created_at,
    updated_at: created_at,
    expires_at: created_at + ORDER_TTL_SEC,
    spent_txid: null,
    spent_block: null,
    buyer: null,
    pending_spend_txid: null,
    pending_fee_sats: null,
    pending_vsize: null,
    pending_feerate: null,
    psbt: hex.encode(tx.toPSBT()),
  };
}

/** The `filling` overlay (audit M-9): a fill of the outpoint is in the mempool at `vsize` vB and `feerate` sat/vB. */
function pendingFill(seed, vsize, feerate) {
  return {
    status: "filling",
    pending_spend_txid: fakeTxid(seed),
    pending_fee_sats: Math.ceil(vsize * feerate),
    pending_vsize: vsize,
    pending_feerate: feerate,
  };
}

/**
 * 30 days of older mines and sends (deterministic) so the activity ledger
 * and its daily chart have a month of history. Mines at one height share
 * that block's yield digit; sends move tokens between the trader pool.
 */
function seededHistory(traderPool, tokens) {
  const mines = [];
  const sends = [];
  for (let d = 0; d < 30; d++) {
    const k = randInt(`hist-n:${d}`, 3, 12);
    const seenHeights = new Map();
    for (let i = 0; i < k; i++) {
      const height = BASE_TIP - 20 - d * DAY_BLOCKS - randInt(`hist-h:${d}:${i}`, 0, DAY_BLOCKS - 1);
      let y = seenHeights.get(height);
      if (y === undefined) {
        y = YIELD_PATTERN[randInt(`hist-y:${height}`, 0, YIELD_PATTERN.length - 1)];
        forceYield(height, y);
        seenHeights.set(height, y);
      }
      const ticker = FEED_TICKERS[randInt(`hist-t:${d}:${i}`, 0, FEED_TICKERS.length - 1)];
      const capExhausted = capExhaustedAt(tokens.get(ticker), height);
      mines.push({
        txid: fakeTxid(`hist-mine:${d}:${i}`),
        block_height: height,
        block_hash: blockHashAt(height),
        block_time: blockTimeAt(height),
        sender: SENDERS[randInt(`hist-s:${d}:${i}`, 0, SENDERS.length - 1)],
        ticker,
        status: "settled",
        yield_smallest: capExhausted ? 0 : y, // the indexer records the clamped credit
        cap_exhausted: capExhausted,
      });
    }
    const s = randInt(`hist-sends:${d}`, 0, 3);
    for (let i = 0; i < s; i++) {
      const height = BASE_TIP - 20 - d * DAY_BLOCKS - randInt(`hist-sh:${d}:${i}`, 0, DAY_BLOCKS - 1);
      const from = traderPool[randInt(`hist-from:${d}:${i}`, 0, traderPool.length - 1)];
      let to = traderPool[randInt(`hist-to:${d}:${i}`, 0, traderPool.length - 1)];
      if (to === from) to = traderPool[(traderPool.indexOf(from) + 1) % traderPool.length];
      sends.push({
        txid: fakeTxid(`hist-send:${d}:${i}`),
        block_height: height,
        block_hash: blockHashAt(height),
        block_time: blockTimeAt(height),
        ticker: FEED_TICKERS[randInt(`hist-st:${d}:${i}`, 0, FEED_TICKERS.length - 1)],
        amount: randInt(`hist-sa:${d}:${i}`, 1, 90) * 10,
        sender: from,
        to,
      });
    }
  }
  mines.sort((a, b) => b.block_height - a.block_height);
  sends.sort((a, b) => b.block_height - a.block_height);
  return { mines, sends };
}

/**
 * A settled MINE of a minted-out token after the block that completed its
 * supply credits 0 and is flagged cap_exhausted (the completing mine itself
 * is not).
 */
function capExhaustedAt(tok, height) {
  return !!tok && tok.minted >= tok.supply && height > (tok.minted_out_height ?? Infinity);
}

function world() {
  if (W) return W;
  const tokens = new Map();
  const trades = [];
  const orders = new Map();
  const knownUtxos = new Map(); // outpoint → { txid, vout, sats, address, balances, confirmed, block_height }
  const traderPool = Array.from({ length: 12 }, (_, i) => (i % 4 === 3 ? fakeP2wpkh(`trader-${i}`) : fakeP2tr(`trader-${i}`)));

  for (const s of TOKEN_SEEDS) {
    // LUCKY is deployed by the simulated wallet so Portfolio's created-token list can be previewed.
    const deployer = s.ticker === "LUCKY" ? MOCK_WALLET.address : s.deployerType === "wpkh" ? fakeP2wpkh(`deployer-${s.ticker}`) : fakeP2tr(`deployer-${s.ticker}`);
    tokens.set(s.ticker, {
      ticker: s.ticker,
      supply: REQUIRED_TOKEN_SUPPLY,
      minted: s.minted,
      minted_out_height: s.minted_out_height ?? null,
      deployer,
      deploy_txid: fakeTxid(`deploy-${s.ticker}`),
      deploy_block: s.deploy_block,
      holders: s.holders,
      mine_count: Math.round(s.minted / EXPECTED_YIELD),
      trade_count: 0,
      volume_sats: 0,
    });

    // ---- trade history: 30–60 fills with a bounded price walk. The first
    // 40 % are spread over the 27 days before the last 3 (so 1d candles and
    // the 7d window have content), the rest sit in the last 3 days (1h
    // candles, the 24h window). One BLOK fill is a self-trade (§7.5).
    // Only a minted-out token has a market (the indexer refuses every
    // listing before that), so only such a token gets fills and asks.
    if (s.base > 0 && s.minted_out_height) {
      const n = randInt(`trades-n:${s.ticker}`, 30, 60);
      const early = Math.floor(n * 0.4);
      let p = s.base;
      for (let i = 0; i < n; i++) {
        const step = (rand(`walk:${s.ticker}:${i}`) - 0.47) * 0.12;
        p = Math.max(0.5, p * (1 + step));
        const amount = randInt(`amt:${s.ticker}:${i}`, 5, 300) * 10;
        const price_sats = Math.max(DUST_SATS, Math.round(p * amount));
        const jit = randInt(`jit:${s.ticker}:${i}`, 0, 3);
        const height =
          i < early
            ? BASE_TIP - 1 - 3 * DAY_BLOCKS - Math.floor(((early - 1 - i) * 27 * DAY_BLOCKS) / early) - jit
            : BASE_TIP - 1 - Math.floor(((n - 1 - i) * 3 * DAY_BLOCKS) / (n - early)) - jit;
        const seller = traderPool[randInt(`seller:${s.ticker}:${i}`, 0, traderPool.length - 1)];
        let buyer = traderPool[randInt(`buyer:${s.ticker}:${i}`, 0, traderPool.length - 1)];
        const selfTrade = s.ticker === "BLOK" && i === n - 2;
        if (selfTrade) buyer = seller;
        else if (buyer === seller) buyer = traderPool[(traderPool.indexOf(seller) + 1) % traderPool.length];
        // A market opens only once the token is minted out: every fill sits
        // after the block that completed the supply.
        const h = Math.max(Math.min(height, BASE_TIP - 1), s.minted_out_height + 1);
        trades.push({
          txid: fakeTxid(`trade:${s.ticker}:${i}`),
          block_height: h,
          block_hash: blockHashAt(h),
          block_time: blockTimeAt(h),
          ticker: s.ticker,
          amount,
          price_sats: selfTrade ? Math.round(price_sats * 4) : price_sats, // a wash at 4× must not print a price
          unit_price: selfTrade ? (price_sats * 4) / amount : price_sats / amount,
          seller,
          buyer,
          order_id: `${fakeTxid(`filled-order:${s.ticker}:${i}`)}:0`,
          self_trade: selfTrade,
        });
      }
      const mine = trades.filter((t) => t.ticker === s.ticker && !t.self_trade);
      const row = tokens.get(s.ticker);
      row.trade_count = mine.length;
      row.volume_sats = mine.reduce((a, t) => a + t.price_sats, 0);

      // ---- open asks: 3–8 real signed listings at ascending prices. The
      // second BLOK ask is `filling`: a low-fee fill of it sits in the
      // mempool (audit M-9), so the book greys it out.
      const last = mine[mine.length - 1].unit_price;
      const k = randInt(`orders-n:${s.ticker}`, 3, 8);
      let unit = last * (1 + rand(`ask0:${s.ticker}`) * 0.03);
      for (let j = 0; j < k; j++) {
        unit *= 1 + 0.015 + rand(`ask:${s.ticker}:${j}`) * 0.05;
        const seller = identity(`seller:${s.ticker}:${j}`, j % 3 === 1 ? "wpkh" : "tr");
        const amount = randInt(`ask-amt:${s.ticker}:${j}`, 10, 250) * 10;
        const price_sats = Math.max(DUST_SATS, Math.round(unit * amount));
        const utxo = { txid: fakeTxid(`listed:${s.ticker}:${j}`), vout: 0, sats: DUST_SATS };
        knownUtxos.set(key(utxo), {
          ...utxo,
          address: seller.address,
          balances: { [s.ticker]: amount },
          confirmed: true,
          block_height: BASE_TIP - 20 - j * 3,
          // the creating tx the mock second source re-parses: a split (SEND to self), carrier = TO_OUT
          origin: { op: "SEND", amount },
        });
        const created_at = LOAD_TS - randInt(`ask-age:${s.ticker}:${j}`, 600, 3 * 86400);
        const filling = s.ticker === "BLOK" && j === 1;
        orders.set(key(utxo), {
          ...signedOrder({ seller, utxo, ticker: s.ticker, amount, price_sats, created_at }),
          ...(filling ? pendingFill(`pending-fill:${s.ticker}:${j}`, 99_000, 0.1) : {}),
        });
      }
      // ---- one ask on a PARTIAL-CREDIT carrier (§3, audit consensus-5): the
      // MINE that completed the supply in block minted_out_height drew the
      // 1,000 tier but was credited only the 300 that were left. The second
      // source can check the tier, not the 300 — the buy sheet must say
      // "amount not independently verified" and ask for an extra tick.
      if (s.minted_out_height) {
        forceYield(s.minted_out_height, 1000);
        const seller = identity(`seller:${s.ticker}:cap`, "tr");
        const amount = 300;
        const utxo = { txid: fakeTxid(`listed:${s.ticker}:cap`), vout: 0, sats: DUST_SATS };
        knownUtxos.set(key(utxo), { ...utxo, address: seller.address, balances: { [s.ticker]: amount }, confirmed: true, block_height: s.minted_out_height, origin: { op: "MINE" } });
        const price_sats = Math.max(DUST_SATS, Math.round(last * 1.02 * amount));
        orders.set(key(utxo), signedOrder({ seller, utxo, ticker: s.ticker, amount, price_sats, created_at: LOAD_TS - 4 * 3600 }));
      }
    }
  }

  // ---- seeded network mine feed (20 rows, mixed yields + tickers)
  const feed = YIELD_PATTERN.map((y, i) => {
    const height = BASE_TIP - 1 - Math.floor(i / 2); // ~2 mines per block
    forceYield(height, y);
    // Every BLOK row sits after the block that completed its supply, so it
    // is a cap-exhausted 0-credit mine (the realistic post-100 % picture).
    const capExhausted = capExhaustedAt(tokens.get(FEED_TICKERS[i]), height);
    return {
      txid: fakeTxid(`feed-${i}`),
      block_height: height,
      block_hash: blockHashAt(height),
      block_time: blockTimeAt(height),
      sender: SENDERS[i % SENDERS.length],
      ticker: FEED_TICKERS[i],
      status: "settled",
      yield_smallest: capExhausted ? 0 : y, // the indexer records the clamped credit; the block hash still explains the tier
      cap_exhausted: capExhausted,
    };
  });

  const history = seededHistory(traderPool, tokens);
  W = { tokens, trades, orders, knownUtxos, feed, history, sim: new Map(), simMines: [], simSends: [], spent: new Set(), created: new Map(), simOrder: 0, seededAddrs: new Set(), commits: new Map(), commitByCarrier: new Map(), replaying: false };

  // The simulated wallet's own `filling` listing: its 1,921-BLOK carrier
  // (seeded UTXO #5; BLOK is the one minted-out token, so the one the wallet
  // can list) listed near the floor, with a 99 kvB / 0.1 sat/vB fill of it
  // "in the mempool" — the Sell fold's Cancel then has to apply the M-9
  // replacement rule, which is the point of seeding it.
  ensureSeeded(MOCK_WALLET.address);
  const mine = seededBtcUtxos(MOCK_WALLET.address)[5];
  const myCarrier = { txid: mine.txid, vout: mine.vout, sats: mine.sats };
  const blokFloor = [...orders.values()].filter((o) => o.ticker === "BLOK").reduce((m, o) => Math.min(m, o.unit_price), Infinity);
  const myPrice = Math.max(DUST_SATS, Math.round((Number.isFinite(blokFloor) ? blokFloor * 0.995 : 50) * 1_921));
  orders.set(key(myCarrier), {
    ...signedOrder({ seller: MOCK_ID, utxo: myCarrier, ticker: "BLOK", amount: 1_921, price_sats: myPrice, created_at: LOAD_TS - 2 * 86400 }),
    ...pendingFill("pending-fill:wallet", 99_000, 0.1),
  });
  seedMyListings(Number.isFinite(blokFloor) ? blokFloor : 50);
  replaySimLog();
  return W;
}

// ---- simulated broadcasts survive a reload (this tab only) -----------------------------------
//
// The mock world is rebuilt on every page load, but a flow that spans a
// reload — a reservation between its two steps, a pending MINE — needs the
// txs it broadcast to still exist. Every accepted broadcast is appended to
// sessionStorage ("lp.mock.simlog": raw hex + broadcast time) and replayed,
// in order and with its original time, when the world is built again.

const SIM_LOG_KEY = "lp.mock.simlog";

function readSimLog() {
  try {
    const raw = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(SIM_LOG_KEY) : null;
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.raw === "string" && Number.isFinite(e.at)) : [];
  } catch {
    return [];
  }
}

function appendSimLog(raw, at) {
  try {
    if (typeof sessionStorage === "undefined") return;
    const list = readSimLog();
    list.push({ raw, at });
    sessionStorage.setItem(SIM_LOG_KEY, JSON.stringify(list.slice(-200)));
  } catch {
    /* no storage — the simulated chain simply resets on reload */
  }
}

function replaySimLog() {
  const w = W;
  w.replaying = true;
  try {
    for (const e of readSimLog()) {
      try {
        simulateBroadcast(e.raw, { at: e.at });
      } catch {
        /* a logged tx that no longer applies is skipped */
      }
    }
  } finally {
    w.replaying = false;
  }
}

// ---- per-address seeds ------------------------------------------------------------------------

/** Seeded BTC UTXOs for any address (token carriers are 546-sat rows). */
function seededBtcUtxos(addr) {
  const mk = (i, sats, confirmed, vout) => ({
    txid: fakeTxid(`utxo:${addr}:${i}`),
    vout: vout ?? i % 2,
    sats,
    confirmed,
    block_height: confirmed ? BASE_TIP - 100 - i * 13 : null,
  });
  return [
    mk(0, DUST_SATS, true),   // LUCKY carrier
    mk(1, 12_000, true),
    mk(2, 48_500, true),
    mk(3, 250_000, true),
    mk(4, 5_000, false),      // pending mempool output
    mk(5, DUST_SATS, true),   // BLOK carrier (the wallet's own filling listing)
    mk(6, DUST_SATS, true),   // ORE carrier
    mk(7, DUST_SATS, true),   // carrier holding two tickers (not listable)
    mk(8, 1_000_000, true),
  ];
}

/** Seeded token UTXOs for any address; registered into knownUtxos once. */
function ensureSeeded(addr) {
  const w = world();
  if (w.seededAddrs.has(addr)) return;
  w.seededAddrs.add(addr);
  const b = seededBtcUtxos(addr);
  const tok = [
    { ...b[0], balances: { LUCKY: 1_200 } },
    { ...b[5], balances: { BLOK: 1_921 } },
    { ...b[6], balances: { ORE: 42 } },
    { ...b[7], balances: { LUCKY: 300, ORE: 8 } },
  ];
  for (const u of tok) w.knownUtxos.set(key(u), { ...u, address: addr });
}

const MY_SEEDED_MINES = (addr) =>
  [1000, 100, 500, 200].map((y, i) => {
    const height = BASE_TIP - 30 - i * 7;
    forceYield(height, y);
    return {
      txid: fakeTxid(`mine:${addr}:${i}`),
      block_height: height,
      block_hash: blockHashAt(height),
      block_time: blockTimeAt(height),
      sender: addr,
      ticker: "LUCKY",
      status: "settled",
      yield_smallest: y,
      cap_exhausted: false,
    };
  });

function holdersFor(t) {
  const n = Math.min(t.holders, 25);
  let remaining = t.minted;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const share = i === 0 ? 0.11 : 0.11 * Math.pow(0.86, i);
    const balance = Math.max(1, Math.floor(t.minted * share * (0.7 + rand(`hold:${t.ticker}:${i}`) * 0.6)));
    rows.push({ address: i % 4 === 2 ? fakeP2wpkh(`holder:${t.ticker}:${i}`) : fakeP2tr(`holder:${t.ticker}:${i}`), balance: Math.min(balance, remaining) });
    remaining -= rows[rows.length - 1].balance;
  }
  return rows.filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance);
}

// ---- simulated chain --------------------------------------------------------------------------

/** Has the simulated tx `e` confirmed by `now` (ms; a replayed broadcast passes its own time)? */
function simConfirmed(e, now = Date.now()) {
  return now - e.at >= CONFIRM_AFTER_MS;
}
function tipHeight() {
  const w = world();
  let tip = BASE_TIP;
  for (const e of w.sim.values()) if (simConfirmed(e) && e.height > tip) tip = e.height;
  return tip;
}

function lookupUtxo(k) {
  const w = world();
  return w.created.get(k) || w.knownUtxos.get(k) || null;
}

/** All live UTXOs (seeded + created − spent) for an address. */
function liveUtxos(addr) {
  const w = world();
  ensureSeeded(addr);
  const rows = new Map();
  for (const u of seededBtcUtxos(addr)) rows.set(key(u), { ...u, address: addr, balances: w.knownUtxos.get(key(u))?.balances || {} });
  for (const u of w.knownUtxos.values()) if (u.address === addr) rows.set(key(u), u);
  for (const u of w.created.values()) if (u.address === addr) rows.set(key(u), u);
  return [...rows.values()].filter((u) => !w.spent.has(key(u)));
}

/** Σ prevout sats − Σ outputs of a decoded tx, or null when a prevout is unknown to the mock. */
function feeOf(d) {
  let inSum = 0;
  for (const i of d.inputs) {
    const pv = prevoutOf(key(i));
    if (!pv || !Number.isFinite(Number(pv.sats))) return null;
    inSum += Number(pv.sats);
  }
  return inSum - d.outputs.reduce((s, o) => s + o.sats, 0);
}

/** Take a replaced (unconfirmed) simulated tx back out of the mempool: its inputs unspent, its outputs gone. */
function evictSim(txid) {
  const w = world();
  const e = w.sim.get(txid);
  if (!e) return;
  w.sim.delete(txid);
  for (const i of e.decoded.inputs) w.spent.delete(key(i));
  for (const o of e.decoded.outputs) w.created.delete(`${txid}:${o.vout}`);
}

/**
 * Register a simulated broadcast. Returns the txid; throws like a node on a
 * double-spend, a non-final lock time, or a replacement that does not pay
 * more. A conflicting UNCONFIRMED simulated tx is replaced when the new one
 * pays a higher fee (BIP125 as modern nodes apply it — full RBF), which is
 * what "Speed up" relies on. `at` is only set when replaying the log.
 */
export function simulateBroadcast(rawHex, { at = null } = {}) {
  const w = world();
  let d;
  try {
    d = decodeRawTx(rawHex);
  } catch (e) {
    throw Object.assign(new Error(`broadcast HTTP 400: TX decode failed — ${e.message || e}`), { status: 400 });
  }
  if (w.sim.has(d.txid)) return d.txid; // idempotent re-broadcast
  // nLockTime (a height below 500,000,000) is final once the next block is above it.
  let raw = null;
  try {
    raw = btc.RawTx.decode(hex.decode(rawHex));
  } catch {
    raw = null;
  }
  if (raw && at === null && raw.lockTime > 0 && raw.lockTime < 500_000_000 && raw.lockTime > tipHeight() && raw.inputs.some((i) => i.sequence < 0xffffffff)) {
    throw Object.assign(new Error("broadcast HTTP 400: non-final (the lock time is above the next block)"), { status: 400 });
  }
  const conflicts = new Set();
  for (const i of d.inputs) {
    if (!w.spent.has(key(i))) continue;
    const other = [...w.sim.entries()].find(([, e]) => !simConfirmed(e, at ?? Date.now()) && e.decoded.inputs.some((x) => key(x) === key(i)));
    if (!other) {
      throw Object.assign(new Error("broadcast HTTP 400: bad-txns-inputs-missingorspent (an input was already spent by another transaction)"), { status: 400 });
    }
    conflicts.add(other[0]);
  }
  if (conflicts.size) {
    const newFee = feeOf(d);
    let oldFee = 0;
    for (const t of conflicts) {
      const f = feeOf(w.sim.get(t).decoded);
      oldFee = oldFee === null || f === null ? null : oldFee + f;
    }
    if (newFee !== null && oldFee !== null && newFee <= oldFee) {
      throw Object.assign(new Error(`broadcast HTTP 400: insufficient fee, rejecting replacement (new fee ${newFee} sats, old ${oldFee} sats)`), { status: 400 });
    }
    for (const t of conflicts) evictSim(t);
  }
  if (!w.replaying) appendSimLog(rawHex, Date.now());
  for (const i of d.inputs) w.spent.add(key(i));
  // §7.3: the live indexer marks a listing `filling` for ANY mempool spend
  // of its outpoint — a buyer's fill or the seller's own withdrawal alike.
  for (const i of d.inputs) {
    const o = w.orders.get(key(i));
    // (a `filling` one whose pending spend this tx replaces too)
    if (!o || (o.status !== "open" && o.status !== "filling")) continue;
    Object.assign(o, { status: "filling", pending_spend_txid: d.txid, pending_fee_sats: null, pending_vsize: null, pending_feerate: null, updated_at: now() });
  }
  w.simOrder += 1;
  const height = BASE_TIP + w.simOrder;
  for (const o of d.outputs) {
    // Every non-OP_RETURN output can carry tokens (§4 rule 5) — an
    // address-less one too; it just never shows under any address.
    if (isOpReturnOut(o)) continue;
    w.created.set(`${d.txid}:${o.vout}`, { txid: d.txid, vout: o.vout, sats: o.sats, address: o.address || null, balances: {}, confirmed: false, block_height: null });
  }
  w.sim.set(d.txid, { at: at ?? Date.now(), height, decoded: d, applied: false });
  return d.txid;
}

/**
 * Dev knob for the "taken before publish" path of the Create page:
 * `sessionStorage["lp.mock.takeTicker"] = "NAME"` registers NAME to another
 * deployer at the current tip (this tab only), as if someone else's publish
 * had confirmed first.
 */
function mockTakeTicker() {
  try {
    const t = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("lp.mock.takeTicker") : null;
    return t && /^[A-Z0-9]{1,8}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** Apply every confirmed-but-unapplied simulated tx (idempotent). */
function settle() {
  const w = world();
  const taken = mockTakeTicker();
  if (taken && !w.tokens.has(taken)) {
    w.tokens.set(taken, {
      ticker: taken,
      supply: REQUIRED_TOKEN_SUPPLY,
      minted: 0,
      minted_out_height: null,
      deployer: fakeP2tr(`other-deployer:${taken}`),
      deploy_txid: fakeTxid(`taken:${taken}`),
      deploy_block: tipHeight(),
      holders: 0,
      mine_count: 0,
      trade_count: 0,
      volume_sats: 0,
    });
  }
  const pending = [...w.sim.entries()].filter(([, e]) => !e.applied && simConfirmed(e)).sort((a, b) => a[1].height - b[1].height);
  for (const [txid, e] of pending) {
    e.applied = true;
    applyTx(txid, e);
  }
}

function applyTx(txid, e) {
  const w = world();
  const d = e.decoded;
  const height = e.height;
  const hash = blockHashAt(height);
  const time = Math.floor((e.at + CONFIRM_AFTER_MS) / 1000);

  // Confirm outputs.
  for (const o of d.outputs) {
    const c = w.created.get(`${txid}:${o.vout}`);
    if (c) { c.confirmed = true; c.block_height = height; }
  }
  // Gather the per-ticker input pool (§4.1).
  const pool = {};
  for (const i of d.inputs) {
    const u = lookupUtxo(key(i));
    if (!u) continue;
    for (const [t, a] of Object.entries(u.balances || {})) pool[t] = (pool[t] || 0) + a;
  }
  const credit = (vout, ticker, amt) => {
    if (amt <= 0 || !Number.isInteger(vout)) return;
    const c = w.created.get(`${txid}:${vout}`);
    if (!c) return; // an OP_RETURN — tokens can never land there (§2)
    c.balances[ticker] = (c.balances[ticker] || 0) + amt;
  };

  const p = d.payload;
  // §2.1: the OPEN recorded COMMIT whose carrier an input spends (a REVEAL's input 0).
  const commitAt = (k) => {
    const c = w.commitByCarrier.get(k);
    return c && (c.status === "open" || c.status === "invalid") && !c.spent_txid ? c : null;
  };
  const dec = routeDecision(d, { pool, isDeployed: (t) => w.tokens.has(t), commitAt, height });
  // Spending a COMMIT carrier consumes that commit, whether or not this tx
  // is a REVEAL that applies (§2.1) — after the decision, which needed it open.
  for (const [idx, i] of d.inputs.entries()) {
    const c = w.commitByCarrier.get(key(i));
    if (!c || c.spent_txid) continue;
    c.spent_txid = txid;
    c.spent_height = height;
    if (c.status === "open") c.status = height > c.height + MAX_COMMIT_AGE ? "expired" : "revealed";
    if (idx === 0 && d.payload && d.payload.op === "DEPLOY") {
      c.reveal_applied = dec.applied;
      c.reveal_reason = dec.applied ? null : dec.reason;
    }
  }
  // A SEND's AMT first, then the whole residual pool (every ticker) to the
  // decided vout — or nowhere: a null residualVout burns it (§4.1).
  if (dec.send) {
    credit(dec.send.vout, dec.send.ticker, dec.send.amount);
    pool[dec.send.ticker] = (pool[dec.send.ticker] || 0) - dec.send.amount;
  }
  const routeRest = () => {
    if (dec.residualVout === null) return;
    for (const [t, a] of Object.entries(pool)) credit(dec.residualVout, t, a);
  };
  const sendApplied = dec.op === "SEND" && dec.applied;
  if (p && p.op === "MINE") {
    const tok = w.tokens.get(p.ticker);
    const valid = dec.valid;
    let y = 0;
    let capExhausted = false;
    if (valid) {
      const remaining = Math.max(0, tok.supply - tok.minted);
      y = Math.min(mineYield(hash) || 0, remaining);
      capExhausted = remaining === 0;
      tok.minted += y;
      tok.mine_count += 1;
      // the credit that completes the supply opens the market — for good
      if (y > 0 && tok.minted >= tok.supply && tok.minted_out_height === null) tok.minted_out_height = height;
    }
    routeRest(); // residual pool → vout0 (burns only when vout0 is missing / an OP_RETURN)
    credit(dec.yieldVout, p.ticker, y);
    w.simMines.push({
      txid,
      block_height: height,
      block_hash: hash,
      block_time: time,
      sender: senderOf(d),
      ticker: p.ticker,
      status: valid ? "settled" : "invalid",
      yield_smallest: y,
      cap_exhausted: capExhausted,
    });
  } else if (p && p.op === "SEND") {
    const to = d.outputs[p.toOutIdx];
    // Every parsed SEND is a ledger row; a non-applied one keeps the requested amount and applied:false.
    w.simSends.push({ txid, block_height: height, block_hash: hash, block_time: time, ticker: p.ticker, amount: p.amount, applied: sendApplied, sender: senderOf(d), to: to && to.address ? to.address : null });
    // Per-ticker routing: the residual of this ticker AND every other ticker
    // in the pool go to CHANGE_OUT; an unusable CHANGE_OUT falls back to the
    // default output (routeDecision).
    routeRest();
  } else if (p && p.op === "COMMIT") {
    // §2.1: record the commit — open, or invalid when vout0 is unusable —
    // with vout0's script, which H binds (rule 2 of the REVEAL). Not served.
    const c = {
      txid,
      height,
      tx_index: 1,
      hash: p.hash,
      carrier: `${txid}:0`,
      carrier_script: dec.commit.carrier_script,
      committer: dec.commit.committer,
      status: dec.commit.status,
      invalid_reason: dec.commit.invalid_reason,
      spent_txid: null,
      spent_height: null,
      reveal_applied: null,
      reveal_reason: null,
    };
    w.commits.set(txid, c);
    w.commitByCarrier.set(c.carrier, c);
    routeRest(); // COMMIT routes nothing → the default output (the carrier)
  } else if (p && p.op === "DEPLOY") {
    if (!dec.applied) w.refusedReveals = [...(w.refusedReveals || []), { txid, ticker: p.ticker, reason: dec.reason, height }];
    if (dec.applied) {
      w.tokens.set(p.ticker, {
        ticker: p.ticker,
        supply: REQUIRED_TOKEN_SUPPLY,
        minted: 0,
        minted_out_height: null,
        // §2.1: the committer — the address of the COMMIT carrier input 0 spends.
        deployer: dec.deployer,
        deploy_txid: txid,
        deploy_block: height,
        holders: 0,
        mine_count: 0,
        trade_count: 0,
        volume_sats: 0,
      });
    }
    routeRest(); // DEPLOY routes nothing → the default output
  } else {
    routeRest(); // not a protocol tx (incl. the withdrawn AVATAR op, §8) → the default output, burning when it is address-less
  }

  // §7.5 order settlement for every spent outpoint (an order may be `filling`
  // — the spend that confirms is the fill itself or a replacing withdrawal).
  for (const [idx, i] of d.inputs.entries()) {
    const o = w.orders.get(key(i));
    if (!o || (o.status !== "open" && o.status !== "filling")) continue;
    // The payment is judged at the listed input's own index (SIGHASH_SINGLE
    // pairs them), not at vout0 — §7.5 / audit consensus-4.
    const pay = d.outputs[idx];
    const to = p && p.op === "SEND" ? d.outputs[p.toOutIdx] : null;
    const isFill = isFillOf(d, dec, o, idx) && !!to;
    o.updated_at = time;
    o.spent_txid = txid;
    o.spent_block = height;
    o.pending_spend_txid = null;
    o.pending_fee_sats = null;
    o.pending_vsize = null;
    o.pending_feerate = null;
    if (isFill) {
      o.status = "filled";
      o.buyer = to.address;
      const selfTrade = to.address === o.seller;
      const trade = {
        txid,
        block_height: height,
        block_hash: hash,
        block_time: time,
        ticker: o.ticker,
        amount: o.amount,
        price_sats: pay.sats,
        unit_price: pay.sats / o.amount,
        seller: o.seller,
        buyer: to.address,
        order_id: o.id,
        self_trade: selfTrade,
      };
      w.trades.push(trade);
      const tok = w.tokens.get(o.ticker);
      if (tok && !selfTrade) { tok.trade_count += 1; tok.volume_sats += pay.sats; }
    } else {
      o.status = "cancelled";
    }
  }
}

/**
 * `{ address, sats }` of an outpoint the mock knows — one it created or
 * seeded, or one of the mock wallet's seeded BTC outputs — else null.
 */
function prevoutOf(k) {
  const u = lookupUtxo(k);
  if (u) return { address: u.address, sats: u.sats };
  const seeded = seededBtcUtxos(MOCK_WALLET.address).find((r) => key(r) === k);
  return seeded ? { address: MOCK_WALLET.address, sats: seeded.sats } : null;
}

/** Dev knob for the lag gates (0 unless set; never used outside VITE_MOCK). */
function mockIndexerLag() {
  try {
    const n = Number(typeof localStorage !== "undefined" ? localStorage.getItem("lp.mock.indexerLag") : 0);
    return Number.isInteger(n) && n > 0 && n < 100_000 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Dev knob for the per-address listing cap (§7.4):
 * `sessionStorage["lp.mock.myListings"] = "N"` (1–20, this tab only, read
 * when the mock world is built — reload after setting it) gives the
 * simulated wallet N more BLOK carriers, each with an OPEN listing near the
 * floor, plus two more BLOK carriers that are not listed. With N = 10 the
 * sell form shows "10 of 10 listings used", refuses a new listing of an
 * unlisted carrier before the wallet signs, and still accepts one of the N
 * listed again at the same or a lower price; with N = 9 one new listing
 * goes through and the next one is refused. With N = 11 the address is above
 * the cap (as after a fill left the mempool unconfirmed): each listing can
 * still be renewed or re-priced lower, and a new one is refused.
 */
function mockMyListings() {
  try {
    const n = Number(typeof sessionStorage !== "undefined" ? sessionStorage.getItem("lp.mock.myListings") : NaN);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 0;
  } catch {
    return 0;
  }
}

function seedMyListings(floorUnit) {
  const n = mockMyListings();
  if (!n) return;
  const w = W;
  for (let i = 0; i < n + 2; i++) {
    const utxo = { txid: fakeTxid(`my-listed:${i}`), vout: 0, sats: DUST_SATS };
    const amount = 100 + i * 10;
    // the creating tx the mock second source re-parses: a split (SEND to self), carrier = TO_OUT
    w.knownUtxos.set(key(utxo), { ...utxo, address: MOCK_WALLET.address, balances: { BLOK: amount }, confirmed: true, block_height: BASE_TIP - 40 - i, origin: { op: "SEND", amount } });
    if (i >= n) continue; // the last two carriers stay unlisted: the new listings to try at the cap
    const price_sats = Math.max(DUST_SATS, Math.round(floorUnit * (1.02 + i * 0.01) * amount));
    w.orders.set(key(utxo), signedOrder({ seller: MOCK_ID, utxo, ticker: "BLOK", amount, price_sats, created_at: LOAD_TS - 3600 * (i + 1) }));
  }
}

/**
 * Dev knob for the activation countdown: `sessionStorage["lp.mock.healthTip"]
 * = "969299"` makes /health report that tip (and indexed height) in THIS
 * tab only, so the pre-activation banner and locks can be checked in mock
 * mode. Only /health reads it — the simulated chain stays at BASE_TIP.
 */
function mockHealthTip() {
  try {
    const n = Number(typeof sessionStorage !== "undefined" ? sessionStorage.getItem("lp.mock.healthTip") : NaN);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function senderOf(d) {
  for (const i of d.inputs) {
    const u = lookupUtxo(key(i));
    if (u && u.address) return u.address;
  }
  // Fee inputs are seeded rows we never registered by outpoint: fall back to vout0.
  return d.outputs[0]?.address || MOCK_WALLET.address;
}

const WINDOW_SEC = { "24h": 86_400, "7d": 7 * 86_400 };
const byTime = (a, b) => a.block_height - b.block_height || a.block_time - b.block_time || a.txid.localeCompare(b.txid);
const now = () => Math.floor(Date.now() / 1000);

/** Non-self trades of a ticker, oldest first. */
function priceTrades(ticker) {
  return world().trades.filter((x) => x.ticker === ticker && !x.self_trade).sort(byTime);
}

/** `GET /tokens/:ticker/market?window=` — derived from the trade history and the book. */
function marketFor(ticker, windowId) {
  const w = world();
  const wid = WINDOW_SEC[windowId] ? windowId : "24h";
  const since = now() - WINDOW_SEC[wid];
  const all = priceTrades(ticker);
  const inWin = all.filter((x) => x.block_time >= since);
  const selfExcluded = w.trades.filter((x) => x.ticker === ticker && x.self_trade && x.block_time >= since).length;
  const open = [...w.orders.values()].filter((o) => o.ticker === ticker && o.status === "open");
  const first = inWin.length ? inWin[0].unit_price : null;
  const lastIn = inWin.length ? inWin[inWin.length - 1].unit_price : null;
  return {
    ticker,
    window: wid,
    as_of: now(),
    tip_height: tipHeight(),
    floor_unit_price: open.length ? Math.min(...open.map((o) => o.unit_price)) : null,
    open_orders: open.length,
    listed_amount: open.reduce((s, o) => s + o.amount, 0),
    last_trade: all.length ? all[all.length - 1] : null,
    trades: inWin.length,
    volume_sats: inWin.reduce((s, x) => s + x.price_sats, 0),
    buyers: new Set(inWin.map((x) => x.buyer)).size,
    sellers: new Set(inWin.map((x) => x.seller)).size,
    high_unit_price: inWin.length ? Math.max(...inWin.map((x) => x.unit_price)) : null,
    low_unit_price: inWin.length ? Math.min(...inWin.map((x) => x.unit_price)) : null,
    first_unit_price: first,
    change_pct: inWin.length >= 2 && first ? Math.round(((lastIn - first) / first) * 10000) / 100 : null, // null with fewer than two fills, two decimals
    self_trades_excluded: selfExcluded,
    minted_out: isMintedOut(w.tokens.get(ticker)),
  };
}

/** The market gate: cumulative credited yield reached the supply (never comes back down). */
function isMintedOut(t) {
  return !!t && t.minted >= t.supply;
}

/** `GET /tokens/:ticker/candles?interval=&limit=` — OHLC buckets of non-self trades, empty buckets omitted. */
function candlesFor(ticker, interval, limit) {
  const size = interval === "1d" ? 86_400 : 3_600;
  const buckets = new Map();
  for (const x of priceTrades(ticker)) {
    const t = Math.floor(x.block_time / size) * size;
    const b = buckets.get(t);
    if (!b) buckets.set(t, { t, o: x.unit_price, h: x.unit_price, l: x.unit_price, c: x.unit_price, v_sats: x.price_sats, v_amount: x.amount, n: 1 });
    else {
      b.h = Math.max(b.h, x.unit_price);
      b.l = Math.min(b.l, x.unit_price);
      b.c = x.unit_price;
      b.v_sats += x.price_sats;
      b.v_amount += x.amount;
      b.n += 1;
    }
  }
  const rows = [...buckets.values()].sort((a, b) => a.t - b.t);
  return { ticker, interval: size === 86_400 ? "1d" : "1h", candles: rows.slice(-limit) };
}

function tokenView(t) {
  const m = marketFor(t.ticker, "24h");
  return {
    ...t,
    minted_out: isMintedOut(t),
    minted_out_height: isMintedOut(t) ? t.minted_out_height ?? null : null,
    open_orders: m.open_orders,
    floor_unit_price: m.floor_unit_price,
    last_trade: m.last_trade,
    market_24h: { volume_sats: m.volume_sats, trades: m.trades, change_pct: m.change_pct, buyers: m.buyers },
  };
}

/**
 * The whole ledger (`GET /activity` items), newest first: deploys, mines,
 * sends, trades. Every key is present (null when not applicable), like the
 * live indexer; `applied` is false for an invalid MINE (0 yield) or a SEND
 * that did not apply (amount = the requested amount). A fill is TWO rows
 * with the same txid — the SEND that moved the tokens and the trade.
 */
const ITEM_KEYS = { kind: null, txid: null, block_height: null, block_time: null, ticker: null, amount: null, applied: true, from: null, to: null, sender: null, deployer: null, buyer: null, seller: null, price_sats: null, unit_price: null, self_trade: false };
const item = (fields) => ({ ...ITEM_KEYS, ...fields });

function activityItems() {
  const w = world();
  const items = [];
  for (const t of w.tokens.values()) {
    const e = [...w.sim.values()].find((x) => x.decoded.txid === t.deploy_txid);
    items.push(item({ kind: "deploy", txid: t.deploy_txid, block_height: t.deploy_block, block_time: e ? Math.floor((e.at + CONFIRM_AFTER_MS) / 1000) : blockTimeAt(t.deploy_block), ticker: t.ticker, amount: t.supply, deployer: t.deployer, sender: t.deployer }));
  }
  for (const r of [...w.simMines, ...w.feed, ...w.history.mines]) {
    items.push(item({ kind: "mine", txid: r.txid, block_height: r.block_height, block_time: r.block_time, ticker: r.ticker, amount: r.cap_exhausted ? 0 : r.yield_smallest, applied: r.status !== "invalid", sender: r.sender }));
  }
  for (const s of [...w.simSends, ...w.history.sends]) {
    items.push(item({ kind: "send", txid: s.txid, block_height: s.block_height, block_time: s.block_time, ticker: s.ticker, amount: s.amount, applied: s.applied !== false, from: s.sender, sender: s.sender, to: s.to }));
  }
  for (const x of w.trades) {
    items.push(item({ kind: "trade", txid: x.txid, block_height: x.block_height, block_time: x.block_time, ticker: x.ticker, amount: x.amount, buyer: x.buyer, seller: x.seller, price_sats: x.price_sats, unit_price: x.unit_price, self_trade: !!x.self_trade }));
    if (!w.simSends.some((s) => s.txid === x.txid)) {
      // The fill's SEND row as the live indexer attributes it: `from` is the
      // largest input contributor — the buyer, who funds price + fees (the
      // seller's input is the 546-sat carrier) — and `to` is vout[TO_OUT],
      // also the buyer.
      items.push(item({ kind: "send", txid: x.txid, block_height: x.block_height, block_time: x.block_time, ticker: x.ticker, amount: x.amount, from: x.buyer, sender: x.buyer, to: x.buyer }));
    }
  }
  // Newest first; inside one block the live feed serves the reverse of its
  // apply order (deploy < mine < send < trade), so a fill's trade row sits
  // above its send row.
  const rank = { deploy: 0, mine: 1, send: 2, trade: 3 };
  return items.sort((a, b) => b.block_height - a.block_height || b.block_time - a.block_time || a.txid.localeCompare(b.txid) || (rank[b.kind] ?? 0) - (rank[a.kind] ?? 0));
}

/** The scriptPubKey hex of an address the mock knows (null for an address-less output). */
function scriptHexOf(address) {
  try {
    return address ? hex.encode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(address))) : null;
  } catch {
    return null;
  }
}

/**
 * The creating tx of a mock outpoint as mempool.space's `/api/tx/<txid>`
 * would serialise it (`vout[].scriptpubkey|value`, `status.block_hash|
 * block_height`) — the real tx for a simulated broadcast, a synthesized
 * reference layout for a seeded carrier (`origin`: a SEND whose TO_OUT is
 * the carrier, or a MINE credited on vout0). Null for an unknown outpoint.
 */
function explorerTxOf(txid, vout, u) {
  const w = world();
  const e = w.sim.get(txid);
  if (e) {
    const status = simConfirmed(e) ? { confirmed: true, block_height: e.height, block_hash: blockHashAt(e.height) } : { confirmed: false };
    return { txid, vout: e.decoded.outputs.map((o) => ({ scriptpubkey: o.script, value: o.sats })), status };
  }
  if (!u) return null;
  const carrier = { scriptpubkey: scriptHexOf(u.address) || "", value: u.sats };
  const fee = { scriptpubkey: scriptHexOf(PROJECT_FEE_ADDRESS), value: DUST_SATS };
  const opret = (payload) => ({ scriptpubkey: hex.encode(makeOpReturnScript(payload)), value: 0 });
  const status = { confirmed: true, block_height: u.block_height, block_hash: blockHashAt(u.block_height) };
  const [ticker, amount] = Object.entries(u.balances || {})[0] || ["", 0];
  if (u.origin?.op === "MINE") return { txid, vout: [carrier, fee, opret(buildMinePayload(ticker))], status };
  // A SEND with the carrier at TO_OUT; the other slots in reference order
  // (fee, OP_RETURN, residual slot) on the free indices.
  const outs = new Array(Math.max(vout + 1, 4)).fill(null);
  outs[vout] = carrier;
  const [feeIdx, opIdx, changeIdx, ...rest] = [...outs.keys()].filter((i) => i !== vout);
  outs[feeIdx] = fee;
  outs[changeIdx] = { scriptpubkey: carrier.scriptpubkey, value: DUST_SATS };
  outs[opIdx] = opret(buildSendPayload({ ticker, amount: u.origin?.amount ?? amount, toOutIdx: vout, changeOutIdx: changeIdx }));
  for (const i of rest) outs[i] = { scriptpubkey: carrier.scriptpubkey, value: DUST_SATS };
  return { txid, vout: outs, status };
}

/**
 * Mock second source (audit M-12) for VITE_MOCK=1, same verdict shape as
 * src/lib/secondSource.js — and the SAME comparison (compareSecondSource:
 * unspent, value, script, the §7.2 step 3 OP_RETURN re-parse with the §3
 * partial-credit rule) run over the mock's own record of the creating tx
 * (explorerTxOf). So "agree" / "unverified" (amount not independently
 * verified) / "disagree" come out exactly as they would against
 * mempool.space. Nothing leaves the browser.
 */
export async function mockCheckSecondSource(listing) {
  await sleep(LATENCY_MS * 2);
  const w = world();
  const txid = String(listing.txid).toLowerCase();
  const vout = Number(listing.vout);
  const k = `${txid}:${vout}`;
  const tx = explorerTxOf(txid, vout, lookupUtxo(k));
  if (!tx) {
    const r = `mock second source has no record of outpoint ${txid.slice(0, 8)}…:${vout}`;
    return { verdict: "disagree", reasons: [r], notes: [], detail: r, urls: null };
  }
  const cmp = compareSecondSource(listing, { outspend: { spent: w.spent.has(k) }, tx });
  const same = `unspent, ${Number(listing.carrierSats).toLocaleString("en-US")} sats, same script, OP_RETURN credits vout ${vout}`;
  const tag = " (VITE_MOCK=1 — mempool.space is not consulted)";
  return {
    verdict: cmp.verdict,
    reasons: cmp.reasons,
    notes: cmp.notes,
    detail:
      cmp.verdict === "agree"
        ? `mock second source agrees: ${same}${tag}`
        : cmp.verdict === "unverified"
          ? `mock second source agrees on the outpoint (${same}) but cannot confirm the amount: ${cmp.notes.join("; ")}${tag}`
          : cmp.reasons.join("; "),
    urls: null,
  };
}

const PARTY_KEYS = ["from", "to", "sender", "deployer", "buyer", "seller"];

const publicOrder = ({ psbt: _psbt, ...rest }) => rest;

// ---- route table -----------------------------------------------------------------------------

const notFound = (p) => Object.assign(new Error(`Indexer ${p} -> HTTP 404`), { status: 404 });

function page(all, q, dfltLimit = 20) {
  const limit = Math.max(1, Math.min(200, Number(q.get("limit") || dfltLimit)));
  const offset = Math.max(0, Number(q.get("offset") || 0));
  return { total: all.length, offset, limit, items: all.slice(offset, offset + limit) };
}

/** Fake `GET path` → parsed JSON. Throws `HTTP 404` like the real transport. */
export async function mockGet(path) {
  await sleep(LATENCY_MS);
  const w = world();
  settle();
  const url = new URL(path, "http://mock.invalid");
  const p = url.pathname;
  const q = url.searchParams;
  let m;

  if (p === "/" || p === "/health") {
    const tip = mockHealthTip() ?? tipHeight();
    return {
      network: "mainnet",
      mock: true,
      // `localStorage["lp.mock.indexerLag"] = "N"` simulates an indexer N
      // blocks behind the tip (a cold scan) for checking the lag gates.
      indexed_height: tip - mockIndexerLag(),
      tip_height: tip,
      token_count: w.tokens.size,
      mine_count: [...w.tokens.values()].reduce((s, t) => s + t.mine_count, 0),
      filling_order_count: [...w.orders.values()].filter((o) => o.status === "filling").length,
      last_progress_at: Math.floor(Date.now() / 1000) - 12,
      stalled: false,
    };
  }
  if ((m = p.match(/^\/balances\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    const balances = {};
    for (const u of liveUtxos(addr)) {
      if (!u.confirmed) continue;
      for (const [t, a] of Object.entries(u.balances || {})) balances[t] = (balances[t] || 0) + a;
    }
    return { address: addr, balances };
  }
  if ((m = p.match(/^\/utxos\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    const utxos = liveUtxos(addr)
      .filter((u) => u.confirmed && Object.keys(u.balances || {}).length > 0)
      .map((u) => ({ txid: u.txid, vout: u.vout, balances: u.balances }));
    return { address: addr, utxos };
  }
  if ((m = p.match(/^\/btc-utxos\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    const utxos = liveUtxos(addr).map(({ txid, vout, sats, confirmed, block_height }) => ({ txid, vout, sats, confirmed, block_height }));
    return { address: addr, scanned_at_height: tipHeight(), utxos };
  }
  if ((m = p.match(/^\/mines\/by-txid\/([^/]+)$/))) {
    const txid = decodeURIComponent(m[1]).toLowerCase();
    const row = w.simMines.find((r) => r.txid === txid) || w.feed.find((r) => r.txid === txid);
    if (row) return row;
    throw notFound(p);
  }
  if ((m = p.match(/^\/mines\/([^/]+)$/))) {
    // Paged like the live indexer (indexer API: limit default 50, max 200).
    const addr = decodeURIComponent(m[1]);
    const sim = w.simMines.filter((r) => r.sender === addr).sort((a, b) => b.block_height - a.block_height);
    const pg = page([...sim, ...MY_SEEDED_MINES(addr)], q, 50);
    return { address: addr, mines: pg.items, total: pg.total, limit: pg.limit, offset: pg.offset };
  }
  if (p === "/mines") {
    const ticker = q.get("ticker");
    let all = [...w.simMines].sort((a, b) => b.block_height - a.block_height).concat(w.feed, w.history.mines);
    if (ticker) all = all.filter((r) => r.ticker === ticker);
    return page(all, q, 20);
  }
  if (p === "/tokens") {
    const deployer = q.get("deployer");
    const items = [...w.tokens.values()].filter((t) => !deployer || t.deployer === deployer).map(tokenView);
    return page(items, q, 10);
  }
  if ((m = p.match(/^\/tokens\/([^/]+)\/holders$/))) {
    const t = w.tokens.get(decodeURIComponent(m[1]));
    if (!t) throw notFound(p);
    const all = holdersFor(t);
    const pg = page(all, q, 25);
    return { ticker: t.ticker, total: Math.max(t.holders, all.length), limit: pg.limit, offset: pg.offset, holders: pg.items };
  }
  if ((m = p.match(/^\/tokens\/([^/]+)\/market$/))) {
    const t = w.tokens.get(decodeURIComponent(m[1]));
    if (!t) throw notFound(p);
    return marketFor(t.ticker, q.get("window") || "24h");
  }
  if ((m = p.match(/^\/tokens\/([^/]+)\/candles$/))) {
    const t = w.tokens.get(decodeURIComponent(m[1]));
    if (!t) throw notFound(p);
    const limit = Math.max(1, Math.min(1000, Number(q.get("limit") || 168)));
    return candlesFor(t.ticker, q.get("interval") === "1d" ? "1d" : "1h", limit);
  }
  if ((m = p.match(/^\/tokens\/([^/]+)$/))) {
    const t = w.tokens.get(decodeURIComponent(m[1]));
    if (!t) throw notFound(p);
    return tokenView(t);
  }
  if ((m = p.match(/^\/transfers\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    const transfers = [...w.simSends, ...w.history.sends].filter((s) => s.sender === addr || s.to === addr).sort((a, b) => b.block_height - a.block_height);
    return { address: addr, transfers, total: transfers.length, limit: transfers.length, offset: 0 };
  }
  if (p === "/activity/daily") {
    const days = Math.max(1, Math.min(365, Number(q.get("days") || 30)));
    return { days: aggregateDaily(activityItems(), { days, now: now() }) };
  }
  if (p === "/activity") {
    const kind = q.get("kind") || "all";
    const addr = q.get("address");
    let all = activityItems();
    if (kind !== "all") all = all.filter((it) => it.kind === kind);
    if (addr) all = all.filter((it) => PARTY_KEYS.some((k) => it[k] === addr));
    return page(all, q, 50);
  }
  if ((m = p.match(/^\/commits\/([^/]+)$/))) {
    // §2.1: the recorded COMMIT; 404 until it confirms (and for a txid that is not one).
    const txid = decodeURIComponent(m[1]).toLowerCase();
    const c = w.commits.get(txid);
    if (!c) throw notFound(p);
    const expired = c.status === "open" && tipHeight() >= c.height + MAX_COMMIT_AGE;
    return {
      txid: c.txid,
      height: c.height,
      tx_index: c.tx_index,
      hash: c.hash,
      carrier: c.carrier,
      committer: c.committer,
      status: expired ? "expired" : c.status,
      reveal_from_height: c.height + MIN_COMMIT_AGE,
      expires_at_height: c.height + MAX_COMMIT_AGE,
      invalid_reason: c.invalid_reason,
      spent_txid: c.spent_txid,
      spent_height: c.spent_height,
      reveal_applied: c.reveal_applied,
      reveal_reason: c.reveal_reason,
    };
  }
  if (p === "/price") {
    return { usd_per_btc: USD_PER_BTC, as_of: now(), source: "mock" };
  }
  if ((m = p.match(/^\/tx-status\/([^/]+)$/))) {
    const txid = decodeURIComponent(m[1]).toLowerCase();
    const e = w.sim.get(txid);
    if (e) {
      if (!simConfirmed(e)) return { txid, confirmed: false, seen: true, in_mempool: true, block_height: null, block_hash: null, block_time: null };
      return { txid, confirmed: true, block_height: e.height, block_hash: blockHashAt(e.height), block_time: Math.floor((e.at + CONFIRM_AFTER_MS) / 1000) };
    }
    const row = w.feed.find((r) => r.txid === txid) || w.trades.find((r) => r.txid === txid);
    if (row) {
      return { txid, confirmed: true, block_height: row.block_height, block_hash: row.block_hash, block_time: row.block_time ?? blockTimeAt(row.block_height) };
    }
    return { txid, confirmed: false, seen: false, in_mempool: false, block_height: null, block_hash: null, block_time: null };
  }
  if (p === "/blocks/recent") {
    const tip = tipHeight();
    const limit = Math.min(32, Math.max(1, Number(q.get("limit") || 16)));
    const blocks = [];
    for (let h = tip; h > tip - limit && h >= 0; h--) blocks.push({ height: h, hash: blockHashAt(h), time: blockTimeAt(h), ...blockCapacityAt(h) });
    return { tip_height: tip, blocks };
  }
  if (p === "/digits" && q.has("days")) {
    // Same contract as the indexer's day window (days wins over limit): walk
    // DOWN from the newest held height, keep every height whose header time
    // is >= since, stop at the first one older. complete = the log held that
    // older height (the window's lower edge was found); false when the log
    // ran out first. Header times come from blockTimeAt, like the tape's.
    // `days` parses like the indexer's: any integer (optional sign, ASCII
    // digits) is clamped into 1..=DAYS_MAX — zero or negative → 1, too big
    // → DAYS_MAX; anything else (empty, "abc", "1.5") is a 400.
    const raw = q.get("days");
    if (!/^[+-]?[0-9]+$/.test(raw)) {
      throw Object.assign(new Error(`Indexer ${path} -> HTTP 400: invalid days ${JSON.stringify(raw)}: expected an integer`), { status: 400 });
    }
    const n = raw.startsWith("-") ? 0 : Number(raw.replace(/^\+/, ""));
    const days = Math.min(DAYS_MAX, Math.max(1, n));
    const tip = tipHeight();
    const since = blockTimeAt(tip) + DIGITS_NOW_AFTER_TIP - days * 86_400;
    const floor = Math.max(0, BASE_TIP - DIGIT_LOG_DEPTH + 1);
    const to = tip;
    let from = to + 1;
    let complete = false;
    for (let h = to; h >= floor; h--) {
      if (blockTimeAt(h) < since) {
        complete = true;
        break;
      }
      from = h;
    }
    let digits = "";
    for (let h = from; h <= to; h++) digits += blockHashAt(h).slice(-1);
    return { tip_height: tip, from, to, digits, since, complete };
  }
  if (p === "/digits") {
    // Same contract as the indexer: to = min(before, tip); heights below the
    // log's floor are dropped from the LOW end; digits[i] is the last hex
    // character of blockHashAt(from + i) — the block tape and the
    // probability board therefore agree by construction.
    const tip = tipHeight();
    const limit = Math.min(DIGITS_MAX, Math.max(1, Math.floor(Number(q.get("limit")) || DIGITS_DEFAULT)));
    const beforeRaw = q.get("before");
    const before = beforeRaw === null || beforeRaw === "" ? tip : Math.max(0, Math.floor(Number(beforeRaw) || 0));
    const to = Math.min(before, tip);
    const floor = Math.max(0, BASE_TIP - DIGIT_LOG_DEPTH + 1);
    const from = Math.max(floor, to - limit + 1);
    let digits = "";
    for (let h = from; h <= to; h++) digits += blockHashAt(h).slice(-1);
    return { tip_height: tip, from: digits.length ? from : to + 1, to, digits };
  }
  if ((m = p.match(/^\/block-info\/(\d+)$/))) {
    const height = Number(m[1]);
    const tip = tipHeight();
    if (height > tip) throw notFound(p);
    let time = blockTimeAt(height);
    if (height > BASE_TIP) {
      const e = [...w.sim.values()].find((x) => x.height === height);
      if (e) time = Math.floor((e.at + CONFIRM_AFTER_MS) / 1000);
    }
    return { height, hash: blockHashAt(height), time, ...blockCapacityAt(height) };
  }
  if (p === "/fees") {
    // Fractional like the real indexer (f64 rounded up to hundredths) so
    // mock mode exercises decimal rates end to end.
    return { fastestFee: 2.38, halfHourFee: 1.5, hourFee: 1.25, economyFee: 1.02, minimumFee: 1, incrementalrelayfee: INCREMENTAL_RELAY_FEE };
  }
  if ((m = p.match(/^\/orders\/by-address\/([^/]+)$/))) {
    // Paged like the live indexer (indexer API: limit default 50, max 200).
    const addr = decodeURIComponent(m[1]);
    const rows = [...w.orders.values()].filter((o) => o.seller === addr).sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)).map(publicOrder);
    const pg = page(rows, q, 50);
    return { address: addr, orders: pg.items, total: pg.total, limit: pg.limit, offset: pg.offset };
  }
  if ((m = p.match(/^\/orders\/([^/]+)$/))) {
    const o = w.orders.get(decodeURIComponent(m[1]).toLowerCase());
    if (!o) throw notFound(p);
    return { ...o };
  }
  if (p === "/orders") {
    const ticker = q.get("ticker");
    // `open` excludes `filling` (a spend is already in the mempool); ask for
    // `filling` or `all` explicitly — exactly the live indexer's contract.
    const status = q.get("status") || "open";
    let all = [...w.orders.values()];
    if (ticker) all = all.filter((o) => o.ticker === ticker);
    if (status !== "all") all = all.filter((o) => o.status === status);
    all = status === "open" || status === "filling"
      ? all.sort((a, b) => a.unit_price - b.unit_price || a.created_at - b.created_at)
      : all.sort((a, b) => b.updated_at - a.updated_at);
    return page(all.map(publicOrder), q, 50);
  }
  if ((m = p.match(/^\/trades\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    const rows = w.trades.filter((t) => t.seller === addr || t.buyer === addr).sort((a, b) => b.block_height - a.block_height);
    const pg = page(rows, q, 50);
    return { address: addr, trades: pg.items, total: pg.total, limit: pg.limit, offset: pg.offset };
  }
  if (p === "/trades") {
    const ticker = q.get("ticker");
    let all = [...w.trades].sort((a, b) => b.block_height - a.block_height || b.block_time - a.block_time);
    if (ticker) all = all.filter((t) => t.ticker === ticker);
    return page(all, q, 50);
  }
  throw notFound(p);
}

/** Fake `POST path` with a text body → text response. */
export async function mockPostText(path, body) {
  await sleep(LATENCY_MS * 3);
  world();
  settle();
  if (path === "/broadcast") {
    if (typeof body !== "string" || body.length < 20) {
      throw Object.assign(new Error("broadcast HTTP 400: empty or malformed tx hex"), { status: 400 });
    }
    return simulateBroadcast(body);
  }
  throw notFound(path);
}

// The live transport's shape (indexer.orderHttpError): the server's `{ error }`
// sentence as the message, the status and raw body alongside.
const bad = (msg, status = 400) => {
  const body = JSON.stringify({ error: msg });
  return Object.assign(new Error(serverErrorText(body)), { status, path: "/orders", body });
};

/** Fake `POST path` with a JSON body → JSON response. */
export async function mockPostJson(path, body) {
  await sleep(LATENCY_MS * 2);
  const w = world();
  settle();
  if (path !== "/orders") throw notFound(path);
  if (!body || typeof body !== "object") throw bad("body must be JSON");
  const { psbt, ticker, amount, price_sats } = body;
  if (!w.tokens.has(ticker)) throw bad(`unknown ticker ${ticker}`);
  // §7.4: price_sats ≤ amount × 1 BTC (at most 1 BTC per whole token).
  const maxPrice = Number(amount) * 100_000_000;
  if (!(Number(price_sats) >= DUST_SATS && Number(price_sats) <= maxPrice)) {
    throw bad(`price_sats must be in [${DUST_SATS}, ${maxPrice}] (≤ 1 BTC per whole token × ${amount})`);
  }
  const tok = w.tokens.get(ticker);
  if (!isMintedOut(tok)) throw bad(`market opens when ${ticker} is fully minted (minted ${tok.minted} of ${tok.supply})`, 409);

  let L;
  try {
    L = parseListing(psbt);
  } catch (e) {
    throw bad(`psbt does not decode: ${e.message || e}`);
  }
  if (L.inputCount !== 1 || L.outputCount !== 1 || L.lockTime !== 0) throw bad("listing must have exactly 1 input, 1 output and nLockTime 0");
  // trading-1 (§7.4): refuse a listing no fill could ever relay — the 0x83
  // signature commits nVersion and input0's nSequence, so no buyer can fix
  // them. The texts are byte-identical to the order book's.
  if (L.version !== 1 && L.version !== 2) throw bad(`listing tx version must be 1 or 2 (got ${L.version}): a listing with any other version can never be filled`);
  const seq = L.input0.sequence;
  if (!Number.isInteger(seq) || seq < 0x80000000) {
    throw bad(`input0 nSequence 0x${(Number(seq) >>> 0).toString(16).padStart(8, "0")} sets a relative timelock: use 0xfffffffd, 0xfffffffe or 0xffffffff (any value >= 0x80000000) so the listing can be filled`);
  }
  const outpoint = `${L.input0.txid}:${L.input0.vout}`;
  // rvs-2 (§7.4): the carrier of an open COMMIT is never listed.
  const reserving = L.input0.vout === 0 ? w.commits.get(String(L.input0.txid).toLowerCase()) : null;
  if (reserving && reserving.status === "open" && !reserving.spent_txid && tipHeight() < reserving.height + MAX_COMMIT_AGE) throw bad(COMMIT_CARRIER_LISTING_TEXT, 409);
  if (L.input0.address) ensureSeeded(L.input0.address);
  const u = lookupUtxo(outpoint);
  if (!u || !u.confirmed) throw bad("input0 outpoint is not a known token UTXO", 400);
  if (w.spent.has(outpoint)) throw bad("outpoint is spent or has a pending spend", 409);
  const bal = Object.entries(u.balances || {});
  if (bal.length !== 1 || bal[0][0] !== ticker || bal[0][1] !== Number(amount)) {
    throw bad(`outpoint balances are ${JSON.stringify(u.balances)}, listing says { ${ticker}: ${amount} }`);
  }
  if (L.input0.address !== u.address) throw bad("witnessUtxo script does not match the outpoint");
  const order = {
    id: outpoint,
    ticker,
    amount: Number(amount),
    price_sats: Number(price_sats),
    unit_price: Number(price_sats) / Number(amount),
    seller: u.address,
    carrier_sats: u.sats,
  };
  const v = verifyListing({ psbtHex: psbt, order });
  if (!v.ok) {
    const first = v.checks.find((c) => !c.ok);
    throw bad(`${first.label}: ${first.detail}`);
  }
  const existing = w.orders.get(outpoint);
  // §7.3: an outpoint the book shows as `filling` has a spend in the
  // mempool — a buyer must not be handed it again (and it is exempt from
  // expiry, so there is nothing to renew).
  if (existing && existing.status === "filling") throw bad("outpoint has a pending spend in the mempool (filling)", 409);
  // trading-4 (§7.4): the book keeps the CHEAPEST live signed listing of an
  // outpoint — the cheaper PSBT stays fillable on-chain whatever the book
  // shows; the same or a lower price replaces it.
  if (existing && existing.status === "open" && order.unit_price > existing.unit_price + 1e-9) {
    throw bad(WITHDRAW_FIRST_TEXT, 409);
  }
  // §7.4 per-seller cap, checked where the order book checks it (after the
  // two checks above, before the price band) and with its exact text naming
  // the real count. Counts OPEN listings only (not `filling`), not expired.
  // A listing that replaces a live open listing of the same outpoint (a
  // renewal or a lower re-price) takes no new place and is never refused
  // here — even when the address is above the cap.
  const ts = now();
  const replaces = !!existing && existing.status === "open" && !(existing.expires_at <= ts);
  if (!replaces) {
    const perAddress = [...w.orders.values()].filter((o) => o.seller === u.address && o.status === "open" && !(o.expires_at <= ts)).length;
    if (perAddress >= MAX_OPEN_LISTINGS_PER_ADDRESS) throw bad(sellerCapError(perAddress, MAX_OPEN_LISTINGS_PER_ADDRESS), 400);
  }
  // §7.4 price band (audit M-11), the live indexer's exact rule: at most
  // 100× the ticker's best OTHER open ask; no band on an otherwise empty book.
  const others = [...w.orders.values()].filter((o) => o.ticker === ticker && o.status === "open" && o.id !== outpoint);
  if (others.length) {
    const best = Math.min(...others.map((o) => o.unit_price));
    const ceiling = best * MAX_ASK_BAND_MULTIPLE;
    if (order.unit_price > ceiling) {
      throw bad(`unit price ${order.unit_price.toFixed(4)} sats/token is outside the price band: at most ${MAX_ASK_BAND_MULTIPLE}× the current best ${ticker} ask (${best.toFixed(4)} sats/token → ceiling ${ceiling.toFixed(4)})`);
    }
  }
  const row = {
    ...order,
    status: "open",
    // §7.4: a same-price re-POST (Renew) keeps its place in the queue; a re-price is a new ask.
    created_at: existing && existing.status === "open" && existing.price_sats === order.price_sats ? existing.created_at : ts,
    updated_at: ts,
    expires_at: ts + ORDER_TTL_SEC,
    spent_txid: null,
    spent_block: null,
    buyer: null,
    pending_spend_txid: null,
    pending_fee_sats: null,
    pending_vsize: null,
    pending_feerate: null,
    psbt: String(psbt).toLowerCase(),
  };
  w.orders.set(outpoint, row);
  return { ...publicOrder(row), ...(existing && existing.status === "open" ? { replaced: true } : {}) };
}
