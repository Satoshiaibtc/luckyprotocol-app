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
// validity rule, a SEND's fixed outputs (AMT to vout1, the rest to vout2),
// the burn when the default output is missing or address-less, the §2.1
// deployer attribution and the §4 rule 6 routing of inputs signed as a
// listing (as far as the mock knows the prevouts) — open orders whose
// outpoint was spent are settled per §7.5
// (a fill is a spend signed with the listing's SIGHASH_SINGLE|ANYONECANPAY
// signature that pays the seller at the listed input's own index; any
// other spend cancels), and fills append a TradeView. A listing whose time
// runs out leaves the book but stays the outpoint's listing floor, with
// its seller: the seller still sees it (status "expired"), a higher
// re-listing is still refused, and a fill of it is still a trade. Stored
// listings are the canonical PSBT the order book serves (only the fields
// a fill needs). It is a simulator for browser checks: consensus is
// asserted by the indexer's own tests and the shared vector files.
// That is what lets the whole listing → fill → trade loop run end-to-end
// without a node.
//
// Depth and finality (the indexer API): every mine view, /tx-status and
// the token rows carry the confirmation depth the live indexer serves
// (`confirmations`, `final`, `market_open`, `market_opens_at_height`), and
// the simulated chain keeps growing — one block every CONFIRM_AFTER_MS for
// MOCK_TRAILING_BLOCKS blocks after each simulated confirmation — so a
// result visibly goes from provisional to final.
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
import { REQUIRED_TOKEN_SUPPLY, DUST_SATS, PROJECT_FEE_ADDRESS, SEND_RESIDUAL_VOUT, SEND_TO_VOUT, buildMinePayload, buildSendPayload } from "./payloads.js";
import { buildListingPsbt, parseListing, decodeRawTx, sellerPartialSig, LISTING_SIGHASH } from "./swap.js";
import { aggregateDaily } from "./activity.js";
import { makeOpReturnScript } from "./psbt.js";
import { compareSecondSource } from "./secondSource.js";
import { isOpReturnOut, listingSignedInputs, routeDecision, settleListingSpend } from "./mockRouting.js";
import { serverErrorText } from "./httpError.js";
import { FINAL_DEPTH, MARKET_OPEN_DELAY, confirmationsAt } from "./finality.js";
import { MAX_OPEN_LISTINGS_PER_ADDRESS, WITHDRAW_FIRST_TEXT, sellerCapError } from "./listingRules.js";

const BASE_TIP = 970_100;
const CONFIRM_AFTER_MS = 20_000;
// After a simulated tx confirms, the simulated chain keeps growing — one
// block per CONFIRM_AFTER_MS — for this many blocks, so its confirmations
// reach FINAL_DEPTH (and a little beyond) without further broadcasts.
const MOCK_TRAILING_BLOCKS = FINAL_DEPTH + 2;
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
  { ticker: "LUCKY", minted: 1_234_567, deploy_block: 969_800, holders: 412, base: 48, deployerType: "tr" },
  // BLOK is minted out: its market is the one open market of the mock world.
  // The MINE that completed the supply confirmed at block 965,300 (~33 days
  // before the tip), before the earliest seeded fill, so the 30 days of
  // trade history keep their spread (1d candles, 7d vs 24h windows).
  { ticker: "BLOK", minted: REQUIRED_TOKEN_SUPPLY, minted_out_height: 965_300, deploy_block: 960_300, holders: 3_310, base: 12.5, deployerType: "tr" },
  { ticker: "SATS", minted: 8_400_000, deploy_block: 969_805, holders: 1_904, base: 3.2, deployerType: "wpkh" },
  { ticker: "ORE", minted: 42_021, deploy_block: 969_812, holders: 57, base: 310, deployerType: "wpkh" },
  { ticker: "NODE", minted: 620_500, deploy_block: 969_830, holders: 233, base: 85, deployerType: "tr" },
  { ticker: "GRID", minted: 210_000, deploy_block: 969_900, holders: 120, base: 140, deployerType: "tr" },
  { ticker: "PIXEL", minted: 3_150, deploy_block: 970_090, holders: 9, base: 1_200, deployerType: "wpkh" },
  // DUNE was minted out two blocks before the tip: its market opens once that
  // block has FINAL_DEPTH confirmations (no fills or asks until then).
  { ticker: "DUNE", minted: REQUIRED_TOKEN_SUPPLY, minted_out_height: BASE_TIP - 2, deploy_block: 970_000, holders: 880, base: 0, deployerType: "wpkh" },
  { ticker: "VOLT", minted: 0, deploy_block: 970_099, holders: 0, base: 0, deployerType: "tr" }, // brand-new: no mines, no trades, no asks
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
    // stored like every listing the book accepts: its canonical PSBT
    psbt: canonicalListingPsbt(hex.encode(tx.toPSBT())),
  };
}

/** The `filling` overlay: a fill of the outpoint is in the mempool at `vsize` vB and `feerate` sat/vB. */
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
      // mempool, so the book greys it out.
      const last = mine[mine.length - 1].unit_price;
      const k = randInt(`orders-n:${s.ticker}`, 3, 8);
      let unit = last * (1 + rand(`ask0:${s.ticker}`) * 0.03);
      for (let j = 0; j < k; j++) {
        unit *= 1 + 0.015 + rand(`ask:${s.ticker}:${j}`) * 0.05;
        const seller = identity(`seller:${s.ticker}:${j}`, j % 3 === 1 ? "wpkh" : "tr");
        const amount = randInt(`ask-amt:${s.ticker}:${j}`, 10, 250) * 10;
        const price_sats = Math.max(DUST_SATS, Math.round(unit * amount));
        const utxo = { txid: fakeTxid(`listed:${s.ticker}:${j}`), vout: SEND_TO_VOUT, sats: DUST_SATS };
        knownUtxos.set(key(utxo), {
          ...utxo,
          address: seller.address,
          balances: { [s.ticker]: amount },
          confirmed: true,
          block_height: BASE_TIP - 20 - j * 3,
          // the creating tx the mock second source re-parses: a split (SEND to self), carrier = vout1
          origin: { op: "SEND", amount },
        });
        const created_at = LOAD_TS - randInt(`ask-age:${s.ticker}:${j}`, 600, 3 * 86400);
        const filling = s.ticker === "BLOK" && j === 1;
        orders.set(key(utxo), {
          ...signedOrder({ seller, utxo, ticker: s.ticker, amount, price_sats, created_at }),
          ...(filling ? pendingFill(`pending-fill:${s.ticker}:${j}`, 99_000, 0.1) : {}),
        });
      }
      // ---- one ask on a PARTIAL-CREDIT carrier (§3): the
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
  W = { tokens, trades, orders, floors: new Map(), knownUtxos, feed, history, sim: new Map(), simMines: [], simSends: [], spent: new Set(), created: new Map(), simOrder: 0, seededAddrs: new Set(), replaying: false };

  // The simulated wallet's own `filling` listing: its 1,921-BLOK carrier
  // (seeded UTXO #5; BLOK is the one minted-out token, so the one the wallet
  // can list) listed near the floor, with a 99 kvB / 0.1 sat/vB fill of it
  // "in the mempool" — the Sell fold's Cancel then has to apply the
  // replacement fee rule, which is the point of seeding it.
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
  seedMyOffBook(Number.isFinite(blokFloor) ? blokFloor : 50);
  replaySimLog();
  return W;
}

// ---- simulated broadcasts survive a reload (this tab only) -----------------------------------
//
// The mock world is rebuilt on every page load, but a flow that spans a
// reload — a pending DEPLOY, a pending MINE — needs the txs it broadcast
// to still exist. Every accepted broadcast is appended to sessionStorage
// ("lp.mock.simlog": raw hex + broadcast time + its block, and the held
// blocks of a held DEPLOY) and replayed, in order and with its original
// time, when the world is built again.

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

function appendSimLog(raw, at, height, hold = null) {
  try {
    if (typeof sessionStorage === "undefined") return;
    const list = readSimLog();
    list.push({ raw, at, height, ...(Number.isInteger(hold) ? { hold } : {}) });
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
        simulateBroadcast(e.raw, { at: e.at, height: Number.isInteger(e.height) ? e.height : null, hold: Number.isInteger(e.hold) ? e.hold : null });
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

/**
 * Has the simulated tx `e` confirmed by `now` (ms; a replayed broadcast
 * passes its own time)? A DEPLOY held by the `lp.mock.holdDeploy` knob
 * (`e.hold` blocks) confirms `e.hold` blocks later than any other tx.
 */
function simConfirmed(e, now = Date.now()) {
  const held = Number.isInteger(e.hold) ? e.hold : 0;
  return now - e.at >= (held + 1) * CONFIRM_AFTER_MS;
}
/**
 * The simulated tip: the highest confirmed simulated block, grown by one
 * block per CONFIRM_AFTER_MS after each confirmation (MOCK_TRAILING_BLOCKS
 * at most) — but never past a block a still-pending simulated tx is due in.
 * A held DEPLOY does not hold the chain back: while it waits the tip grows
 * one block per CONFIRM_AFTER_MS from the block it was sent at, up to the
 * block before its own.
 */
function tipHeight(now = Date.now()) {
  const w = world();
  let tip = BASE_TIP;
  let cap = Infinity;
  for (const e of w.sim.values()) {
    if (!simConfirmed(e, now)) {
      if (Number.isInteger(e.hold)) {
        tip = Math.max(tip, e.height - e.hold - 1 + Math.min(e.hold, Math.floor((now - e.at) / CONFIRM_AFTER_MS)));
        continue;
      }
      cap = Math.min(cap, e.height - 1);
      continue;
    }
    const grown = Math.min(MOCK_TRAILING_BLOCKS, Math.floor((now - e.at - CONFIRM_AFTER_MS) / CONFIRM_AFTER_MS));
    tip = Math.max(tip, e.height + Math.max(0, grown));
  }
  let confirmedTop = BASE_TIP;
  for (const e of w.sim.values()) if (simConfirmed(e, now) && e.height > confirmedTop) confirmedTop = e.height;
  return Math.max(confirmedTop, Math.min(tip, cap));
}

/**
 * The height the simulated indexer has applied: the simulated tip, less the
 * `lp.mock.indexerLag` knob. Depth and the market gate are measured from it,
 * as the live indexer measures them from its indexed height.
 */
function indexedHeight() {
  return tipHeight() - mockIndexerLag();
}

/** `{ confirmations, final }` of a block at `height` against the indexed height (the live indexer's fields). */
function depthOf(height) {
  const n = confirmationsAt(height, indexedHeight()) ?? 0;
  return { confirmations: n, final: n >= FINAL_DEPTH };
}

/** A MineView as the live indexer serves it: `reason` always present, with its depth at response time. */
const mineView = (r) => ({ reason: null, ...r, ...depthOf(r.block_height) });

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

/**
 * The `pending_*` fields the order book shows for a mempool spend of a
 * listed outpoint: the spend's fee, its vsize and its own feerate (sat/vB,
 * two decimals) — null each when the mock cannot tell.
 */
function pendingSpendOf(d, rawHex) {
  const fee = feeOf(d);
  let vsize = null;
  try {
    vsize = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true }).vsize;
  } catch {
    vsize = null;
  }
  const known = Number.isInteger(fee) && fee >= 0 && Number.isInteger(vsize) && vsize > 0;
  return {
    pending_fee_sats: known ? fee : null,
    pending_vsize: known ? vsize : null,
    pending_feerate: known ? Math.round((fee / vsize) * 100) / 100 : null,
  };
}

/** Take a replaced (unconfirmed) simulated tx back out of the mempool: its inputs unspent, its outputs gone. */
function evictSim(txid) {
  const w = world();
  const e = w.sim.get(txid);
  if (!e) return;
  w.sim.delete(txid);
  for (const i of e.decoded.inputs) w.spent.delete(key(i));
  for (const o of e.decoded.outputs) w.created.delete(`${txid}:${o.vout}`);
  // A listing whose pending spend this was is back to `open` (the book's
  // "filling + nothing in the mempool"); a replacement that spends it again
  // marks it `filling` once more as it is registered.
  for (const i of e.decoded.inputs) {
    const o = w.orders.get(key(i));
    if (o && o.status === "filling" && o.pending_spend_txid === txid) {
      Object.assign(o, { status: "open", pending_spend_txid: null, pending_fee_sats: null, pending_vsize: null, pending_feerate: null });
    }
  }
}

/**
 * Register a simulated broadcast. Returns the txid; throws like a node on a
 * double-spend, a non-final lock time, or a replacement that does not pay
 * more. A conflicting UNCONFIRMED simulated tx is replaced when the new one
 * pays a higher fee (BIP125 as modern nodes apply it — full RBF), which is
 * what "Speed up" relies on. `at` is only set when replaying the log, and
 * `hold` then (the blocks a held DEPLOY waits, mockHoldDeploy).
 */
export function simulateBroadcast(rawHex, { at = null, height: loggedHeight = null, hold: loggedHold = null } = {}) {
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
  // Its block: the next one after everything simulated so far (a replay
  // keeps the height it was first given, so its block hash — and a MINE's
  // yield — stay the same across a reload). A DEPLOY sent while the
  // `lp.mock.holdDeploy` knob is set (never a replacement) misses that many
  // blocks first: the knob is used up, and the DEPLOY confirms N blocks
  // later while the chain goes on.
  w.simOrder += 1;
  let hold = Number.isInteger(loggedHold) && loggedHold > 0 ? loggedHold : null;
  if (!w.replaying && at === null && !conflicts.size && d.payload && d.payload.op === "DEPLOY") hold = takeHoldDeploy();
  const nextHeight = Math.max(BASE_TIP + w.simOrder, tipHeight() + 1, ...[...w.sim.values()].map((e) => e.height));
  const height = Number.isInteger(loggedHeight) ? loggedHeight : hold ? tipHeight() + hold + 1 : nextHeight;
  if (!w.replaying) appendSimLog(rawHex, Date.now(), height, hold);
  for (const i of d.inputs) w.spent.add(key(i));
  // §7.3: the live indexer marks a listing `filling` for ANY mempool spend
  // of its outpoint — a buyer's fill or the seller's own withdrawal alike —
  // with that spend's fee, vsize and feerate (what a replacement must beat).
  // An observation, not a seller action: `updated_at` (and so the expiry)
  // does not move.
  const pending = pendingSpendOf(d, rawHex);
  for (const i of d.inputs) {
    const o = w.orders.get(key(i));
    // (a `filling` one whose pending spend this tx replaces too)
    if (!o || (o.status !== "open" && o.status !== "filling")) continue;
    Object.assign(o, { status: "filling", pending_spend_txid: d.txid, ...pending });
  }
  for (const o of d.outputs) {
    // Every non-OP_RETURN output can carry tokens (§4 rule 5) — an
    // address-less one too; it just never shows under any address.
    if (isOpReturnOut(o)) continue;
    w.created.set(`${d.txid}:${o.vout}`, { txid: d.txid, vout: o.vout, sats: o.sats, address: o.address || null, balances: {}, confirmed: false, block_height: null });
  }
  // Its own fee and size stay with it: /pending-deploys lists a waiting DEPLOY with them.
  w.sim.set(d.txid, { at: at ?? Date.now(), height, decoded: d, applied: false, feeSats: pending.pending_fee_sats, vsize: pending.pending_vsize, ...(hold ? { hold } : {}) });
  return d.txid;
}

/**
 * Dev knob for the "taken" paths of the Create page:
 * `sessionStorage["lp.mock.takeTicker"] = "NAME"` registers NAME to another
 * deployer at the current tip (this tab only), as if someone else's DEPLOY
 * had confirmed first; with a DEPLOY of NAME pending it shows the "taken
 * while yours was waiting" screen.
 */
function mockTakeTicker() {
  try {
    const t = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("lp.mock.takeTicker") : null;
    return t && /^[A-Z0-9]{1,8}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Dev knob for the Create page's warnings about other DEPLOYs of a ticker:
 * `sessionStorage["lp.mock.rivalDeploy"] = "NAME@RATE"` (several joined by
 * commas, e.g. "NEW@12.5,NEW@8"; RATE in sat/vB, MOCK_RIVAL_RATE when left
 * out) makes /pending-deploys/NAME list a DEPLOY of NAME from another
 * wallet paying RATE, waiting in the simulated mempool until NAME is
 * registered (this tab only). A new RATE is a new transaction (a
 * replacement), as a sped-up copy would be. Returns the rows for `ticker`.
 */
export const MOCK_RIVAL_RATE = 6;
const MOCK_RIVAL_VSIZE = 250;
function mockRivalDeploys(ticker) {
  let raw = null;
  try {
    raw = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("lp.mock.rivalDeploy") : null;
  } catch {
    raw = null;
  }
  if (!raw) return [];
  const rows = [];
  String(raw)
    .split(",")
    .forEach((part, i) => {
      const [name, rateText] = part.trim().split("@");
      if (String(name || "").toUpperCase() !== ticker) return;
      const asked = rateText === undefined || rateText.trim() === "" ? MOCK_RIVAL_RATE : Number(rateText);
      if (!Number.isFinite(asked) || asked < 1 || asked > 1_000_000) return;
      const feeSats = Math.ceil(asked * MOCK_RIVAL_VSIZE);
      const feeRate = Math.round((feeSats / MOCK_RIVAL_VSIZE) * 100) / 100;
      rows.push({ txid: fakeTxid(`rival-deploy:${ticker}:${i}:${asked}`), fee_rate: feeRate, fee_sats: feeSats, vsize: MOCK_RIVAL_VSIZE, first_seen: LOAD_TS - 60 * (i + 1), package_fee_rate: feeRate });
    });
  return rows;
}

/**
 * Dev knob for a mempool watch that says nothing: `sessionStorage["lp.mock.deployWatch"]`
 * = "off" makes /pending-deploys answer `watching: false` (the watch has not
 * completed a pass, or is failing), "down" makes it answer the server's busy
 * 503 (the only 503 the route can get; a failing watch answers
 * `watching: false`) (this tab only).
 */
function mockDeployWatch() {
  try {
    const v = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("lp.mock.deployWatch") : null;
    return v === "off" || v === "down" ? v : null;
  } catch {
    return null;
  }
}

/** The indexer's refusal of a /pending-deploys ticker, word for word. */
export const PENDING_DEPLOYS_REFUSAL = "ticker must match [A-Z0-9]{1,8}";

/** The indexer's ticker normalisation: Unicode white space trimmed, ASCII letters upper-cased (no other letter). */
function normalizeTickerLikeIndexer(text) {
  return String(text)
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
    .replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * GET /pending-deploys/:ticker as the indexer answers it: the simulated
 * DEPLOYs of the ticker that still wait (read with the mock's own DEPLOY
 * rule — a DEPLOY without the exact fee output can never register the
 * ticker, so it is not listed) and the rival knob's rows, highest fee rate
 * first; none once the ticker is registered. `watching` is false while the
 * simulated index is rebuilding or more than one block behind, as on the
 * indexer; the last rows are served meanwhile.
 */
function mockPendingDeploys(path, tickerText) {
  const w = world();
  let t = "";
  try {
    t = normalizeTickerLikeIndexer(decodeURIComponent(tickerText));
  } catch {
    t = "";
  }
  if (!/^[A-Z0-9]{1,8}$/.test(t)) throw http400(path, PENDING_DEPLOYS_REFUSAL);
  const watch = mockDeployWatch();
  if (watch === "down") {
    const text = "server busy; retry shortly";
    throw Object.assign(new Error(`Indexer ${path} -> HTTP 503: ${text}`), { status: 503, detail: text, retryAfter: 1 });
  }
  const registered = w.tokens.has(t);
  const rows = [];
  if (!registered) {
    for (const [txid, e] of w.sim) {
      const p = e.decoded.payload;
      if (simConfirmed(e) || !p || p.op !== "DEPLOY" || p.ticker !== t) continue;
      if (routeDecision(e.decoded, {}).reason === "fee_missing") continue;
      if (!Number.isInteger(e.feeSats) || !Number.isInteger(e.vsize) || e.vsize <= 0) continue;
      const feeRate = Math.round((e.feeSats / e.vsize) * 100) / 100;
      rows.push({ txid, fee_rate: feeRate, fee_sats: e.feeSats, vsize: e.vsize, first_seen: Math.floor(e.at / 1000), package_fee_rate: feeRate });
    }
    rows.push(...mockRivalDeploys(t));
  }
  rows.sort((a, b) => b.fee_rate - a.fee_rate || a.first_seen - b.first_seen || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0));
  const at = now();
  const paused = mockIndexerLag() > 1 || mockHealthOverride().state_rebuilding === true;
  return { ticker: t, registered, pending: rows, as_of: watch === "off" ? at - 200 : at, watching: watch !== "off" && !paused };
}

/**
 * Dev knob for a DEPLOY that misses blocks: `sessionStorage["lp.mock.holdDeploy"]
 * = "N"` (N from 1 to 6, this tab only) makes the next DEPLOY broadcast
 * wait N blocks before it confirms while the simulated chain goes on — the
 * missed-block notice and Speed up can then be checked. Used up by that
 * DEPLOY (the key is removed); a Speed up of it is not held.
 */
function takeHoldDeploy() {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const n = Number(sessionStorage.getItem("lp.mock.holdDeploy"));
    if (!Number.isInteger(n) || n < 1 || n > 6) return null;
    sessionStorage.removeItem("lp.mock.holdDeploy");
    return n;
  } catch {
    return null;
  }
}

/** Apply every confirmed-but-unapplied simulated tx (idempotent). */
function settle() {
  const w = world();
  expireOrders();
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
  // Gather the per-ticker input pool (§4.1) — the inputs signed as a
  // listing kept apart (§4 rule 6).
  const listedIdx = new Set(listingSignedInputs(d, prevoutOf));
  const pool = {};
  const listed = [];
  for (const [idx, i] of d.inputs.entries()) {
    const u = lookupUtxo(key(i));
    if (!u) continue;
    if (listedIdx.has(idx)) {
      listed.push({ idx, balances: { ...(u.balances || {}) } });
      continue;
    }
    for (const [t, a] of Object.entries(u.balances || {})) pool[t] = (pool[t] || 0) + a;
  }
  const credit = (vout, ticker, amt) => {
    if (amt <= 0 || !Number.isInteger(vout)) return;
    const c = w.created.get(`${txid}:${vout}`);
    if (!c) return; // an OP_RETURN — tokens can never land there (§2)
    c.balances[ticker] = (c.balances[ticker] || 0) + amt;
  };

  const p = d.payload;
  const dec = routeDecision(d, {
    pool,
    listed,
    isDeployed: (t) => w.tokens.has(t),
    deployBlockOf: (t) => w.tokens.get(t)?.deploy_block ?? null,
    height,
    prevoutOf,
  });
  // A SEND's AMT first — an applied SEND's pool includes the listed inputs'
  // balance of its ticker, which moves with it — then the whole residual
  // pool (every ticker) to the decided vout, or nowhere: a null
  // residualVout burns it (§4.1).
  if (dec.send) {
    const joined = listed.reduce((s, x) => s + (Number(x.balances[dec.send.ticker]) || 0), 0);
    credit(dec.send.vout, dec.send.ticker, dec.send.amount);
    pool[dec.send.ticker] = (pool[dec.send.ticker] || 0) + joined - dec.send.amount;
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
      reason: valid ? null : dec.reason,
    });
  } else if (p && p.op === "SEND") {
    const to = d.outputs[SEND_TO_VOUT];
    // Every parsed SEND is a ledger row; a non-applied one keeps the requested amount and applied:false.
    w.simSends.push({ txid, block_height: height, block_hash: hash, block_time: time, ticker: p.ticker, amount: p.amount, applied: sendApplied, sender: senderOf(d), to: to && to.address ? to.address : null });
    // Per-ticker routing: the rest of this ticker AND every other ticker in
    // the pool go to vout2; an unusable vout2 falls back to the default
    // output (routeDecision).
    routeRest();
  } else if (p && p.op === "DEPLOY") {
    if (dec.applied) {
      w.tokens.set(p.ticker, {
        ticker: p.ticker,
        supply: REQUIRED_TOKEN_SUPPLY,
        minted: 0,
        minted_out_height: null,
        // §2.1: the largest whole-tx-signed contributor ("" when none).
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
    routeRest(); // not a protocol tx (incl. an `avatar` op, §8) → the default output, burning when it is address-less
  }
  // §4 rule 6: what an input signed as a listing did not move with an
  // applied SEND of its ticker goes to the output its signature covers.
  for (const { vout, balances } of dec.listedTo) {
    for (const [t, a] of Object.entries(balances)) credit(vout, t, a);
  }

  // §7.5 order settlement for every spent outpoint: a live order (it may be
  // `filling` — the spend that confirms is a fill or a replacing
  // withdrawal) or a listing that already left the book (its floor, whose
  // signature was still valid). Only a spend signed with the listing's
  // 0x83 signature that pays the seller at the listed input's own index
  // (SIGHASH_SINGLE pairs them) fills; any other spend cancels. A fill is
  // one trade, recorded once.
  for (const [idx, i] of d.inputs.entries()) {
    const k = key(i);
    const o = w.orders.get(k);
    const live = !!o && (o.status === "open" || o.status === "filling");
    // A floor settles only for an outpoint the book holds no order for, and
    // only when it names its seller (the book's rule).
    const f = w.floors.get(k) || null;
    const floor = !o && f && f.seller ? f : null;
    w.floors.delete(k); // spent: the old signature is void now
    if (!live && !floor) continue;
    const listed = live ? o : floor;
    const s = settleListingSpend(d, dec, listed, idx);
    if (live) {
      o.updated_at = time;
      o.spent_txid = txid;
      o.spent_block = height;
      o.pending_spend_txid = null;
      o.pending_fee_sats = null;
      o.pending_vsize = null;
      o.pending_feerate = null;
      o.status = s.filled ? "filled" : "cancelled";
      o.buyer = s.filled ? s.buyer : null;
    }
    if (s.filled && !w.trades.some((t) => t.txid === txid && t.order_id === listed.id)) {
      w.trades.push({
        txid,
        block_height: height,
        block_hash: hash,
        block_time: time,
        ticker: listed.ticker,
        amount: listed.amount,
        price_sats: s.priceSats,
        unit_price: s.priceSats / listed.amount,
        seller: listed.seller,
        buyer: s.buyer,
        order_id: listed.id,
        self_trade: s.selfTrade,
      });
      const tok = w.tokens.get(listed.ticker);
      if (tok && !s.selfTrade) { tok.trade_count += 1; tok.volume_sats += s.priceSats; }
    }
  }
}

// ---- listings that leave the book ---------------------------------------------------------

/**
 * §7.4 TTL, as the order book applies it: an OPEN listing whose
 * `expires_at` has passed leaves the book, and its price stays behind as
 * the outpoint's listing floor, with its seller — its signature can still
 * be filled, so a higher re-listing is still refused, the seller still
 * sees it (by-address, status "expired") and a fill of it is still a
 * trade. A `filling` listing is exempt while its spend is in the mempool.
 */
function expireOrders(ts = now()) {
  const w = world();
  for (const [k, o] of w.orders) {
    if (o.status !== "open" || !(o.expires_at <= ts)) continue;
    w.orders.delete(k);
    rememberFloor(o, ts);
  }
}

/**
 * Keep `o`'s price as its outpoint's floor (the cheaper of two signed
 * listings stays; unit prices compared exactly, like the book: a/b < c/d ⇔
 * a·d < c·b). A floor without a seller gets `o`'s — same outpoint, same
 * script.
 */
function rememberFloor(o, ts) {
  const w = world();
  const prev = w.floors.get(o.id);
  if (prev && !unitBelow(o, prev)) {
    if (!prev.seller) Object.assign(prev, { seller: o.seller, carrier_sats: o.carrier_sats ?? null });
    return;
  }
  w.floors.set(o.id, { id: o.id, ticker: o.ticker, amount: o.amount, price_sats: o.price_sats, unit_price: o.unit_price, seller: o.seller, carrier_sats: o.carrier_sats ?? null, created_at: o.created_at ?? null, dropped_at: ts });
}

/** Is the unit price of `a` ({ price_sats, amount }) strictly below that of `b`? Exact, in integers. */
function unitBelow(a, b) {
  return BigInt(a.price_sats) * BigInt(b.amount) < BigInt(b.price_sats) * BigInt(a.amount);
}

/** A floor as a row of the seller's by-address `expired` list (the order book's ExpiredListing). */
function offBookRow(f, holder) {
  return {
    id: f.id,
    ticker: f.ticker,
    amount: f.amount,
    price_sats: f.price_sats,
    unit_price: f.price_sats / f.amount,
    seller: f.seller || holder,
    carrier_sats: f.carrier_sats ?? null,
    status: "expired",
    dropped_at: f.dropped_at,
  };
}

// ---- a submitted listing, reduced to the fields a listing is judged by ----------------------------

/** A Bitcoin CompactSize at `at` → [value, next offset]. */
function readCompactSize(b, at) {
  if (at >= b.length) throw new Error("unexpected end of data");
  const x = b[at];
  if (x < 0xfd) return [x, at + 1];
  const n = x === 0xfd ? 2 : x === 0xfe ? 4 : 8;
  if (at + 1 + n > b.length) throw new Error("unexpected end of data");
  let v = 0;
  for (let i = n - 1; i >= 0; i--) v = v * 256 + b[at + 1 + i];
  if (!Number.isSafeInteger(v)) throw new Error("length out of range");
  return [v, at + 1 + n];
}

function writeCompactSize(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

/** One PSBT key-value map at `at` → [[{ key, value }], next offset]. */
function readPsbtMap(b, at) {
  const entries = [];
  for (let i = at; ;) {
    const [keyLen, k] = readCompactSize(b, i);
    if (keyLen === 0) return [entries, k];
    const key = b.subarray(k, k + keyLen);
    const [valueLen, v] = readCompactSize(b, k + keyLen);
    const value = b.subarray(v, v + valueLen);
    if (key.length !== keyLen || value.length !== valueLen) throw new Error("unexpected end of data");
    entries.push({ key, value });
    i = v + valueLen;
  }
}

function writePsbtMap(entries) {
  const parts = [];
  for (const { key, value } of entries) parts.push(writeCompactSize(key.length), key, writeCompactSize(value.length), value);
  parts.push(Uint8Array.of(0));
  return parts;
}

// Input 0 key types a listing is judged by: witnessUtxo, partialSig,
// sighashType, tapKeySig, tapInternalKey.
const LISTING_INPUT_KEYS = new Set([0x01, 0x02, 0x03, 0x13, 0x17]);

/**
 * A submitted listing PSBT (bytes) reduced to what the order book reads
 * from it: the unsigned tx, and on its inputs only witnessUtxo, partial
 * signatures, sighashType, tapKeySig and a tapInternalKey that tweaks (no
 * script tree) to the P2TR output key; no output fields, no other global
 * fields, nothing after the last map. The book ignores everything else a
 * PSBT carries (it keeps the canonical form), so a field the app's PSBT
 * library would refuse to read never decides a listing here either.
 */
function listingPsbtFields(bytes) {
  if (bytes.length < 5 || hex.encode(bytes.subarray(0, 5)) !== "70736274ff") throw new Error("not a PSBT (bad magic)");
  const [globals, afterGlobals] = readPsbtMap(bytes, 5);
  const txEntry = globals.find((e) => e.key.length === 1 && e.key[0] === 0x00);
  if (!txEntry) throw new Error("no unsigned transaction");
  const tx = btc.RawTx.decode(txEntry.value);
  let at = afterGlobals;
  const parts = [bytes.subarray(0, 5), ...writePsbtMap([txEntry])];
  for (let i = 0; i < tx.inputs.length; i++) {
    const [entries, next] = readPsbtMap(bytes, at);
    at = next;
    const utxo = entries.find((e) => e.key.length === 1 && e.key[0] === 0x01);
    let spk = null;
    if (utxo) {
      const [len, s] = readCompactSize(utxo.value, 8);
      spk = utxo.value.subarray(s, s + len);
    }
    const kept = entries.filter((e) => {
      if (!LISTING_INPUT_KEYS.has(e.key[0])) return false;
      if (e.key[0] !== 0x17) return true;
      try {
        return !!spk && e.value.length === 32 && hex.encode(btc.p2tr(e.value).script) === hex.encode(spk);
      } catch {
        return false;
      }
    });
    parts.push(...writePsbtMap(kept));
  }
  for (let i = 0; i < tx.outputs.length; i++) {
    const [, next] = readPsbtMap(bytes, at);
    at = next;
    parts.push(Uint8Array.of(0));
  }
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * The canonical listing PSBT the order book stores and serves after a
 * listing passed its checks: the unsigned tx, input 0's witnessUtxo and
 * sighash type 0x83, and the seller's signature — for P2WPKH only the
 * partialSig whose key is the listed UTXO's, for P2TR only tapKeySig (and
 * tapInternalKey only when it tweaks to the output key). Nothing else a
 * PSBT can carry reaches a buyer.
 */
function canonicalListingPsbt(psbtHex) {
  const src = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });
  const in0 = src.getInput(0);
  const out0 = src.getOutput(0);
  const script = in0.witnessUtxo.script;
  const input = { txid: in0.txid, index: in0.index, sequence: in0.sequence, witnessUtxo: { script, amount: in0.witnessUtxo.amount }, sighashType: LISTING_SIGHASH };
  const type = btc.OutScript.decode(script).type;
  if (type === "wpkh") {
    const own = sellerPartialSig(in0.partialSig, script);
    if (own) input.partialSig = [own];
  } else if (type === "tr") {
    if (in0.tapKeySig) input.tapKeySig = in0.tapKeySig;
    if (in0.tapInternalKey) {
      try {
        if (hex.encode(btc.p2tr(in0.tapInternalKey).script) === hex.encode(script)) input.tapInternalKey = in0.tapInternalKey;
      } catch {
        // not a key that tweaks to this output: left out
      }
    }
  }
  const tx = new btc.Transaction({ version: src.version, lockTime: src.lockTime, allowUnknownOutputs: true });
  // The output first: once input 0 carries its SIGHASH_SINGLE signature, output 0 is fixed.
  tx.addOutput({ script: out0.script, amount: out0.amount });
  tx.addInput(input);
  return hex.encode(tx.toPSBT());
}

/** The order book's refusal of a listed output below 546 sats. */
export const SMALL_CARRIER_LISTING_TEXT = "listed output holds fewer than 546 sats; send the tokens to a 546-sat carrier first";

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

/**
 * Dev knob for a listing that left the book (§7.4):
 * `sessionStorage["lp.mock.offBook"] = "1"` (this tab, read when the mock
 * world is built — reload after setting it) gives the simulated wallet a
 * 400-BLOK carrier whose listing below the floor ran out 15 days ago: the
 * sell form and the portfolio show it as still fillable, with Withdraw.
 */
function mockOffBook() {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem("lp.mock.offBook") === "1";
  } catch {
    return false;
  }
}

function seedMyOffBook(floorUnit) {
  if (!mockOffBook()) return;
  const w = W;
  const utxo = { txid: fakeTxid("my-offbook:0"), vout: SEND_TO_VOUT, sats: DUST_SATS };
  const amount = 400;
  w.knownUtxos.set(key(utxo), { ...utxo, address: MOCK_WALLET.address, balances: { BLOK: amount }, confirmed: true, block_height: BASE_TIP - 3_000, origin: { op: "SEND", amount } });
  const created = LOAD_TS - 29 * 86400;
  const o = signedOrder({ seller: MOCK_ID, utxo, ticker: "BLOK", amount, price_sats: Math.max(DUST_SATS, Math.round(floorUnit * 0.8 * amount)), created_at: created });
  rememberFloor(o, o.expires_at);
}

function seedMyListings(floorUnit) {
  const n = mockMyListings();
  if (!n) return;
  const w = W;
  for (let i = 0; i < n + 2; i++) {
    const utxo = { txid: fakeTxid(`my-listed:${i}`), vout: SEND_TO_VOUT, sats: DUST_SATS };
    const amount = 100 + i * 10;
    // the creating tx the mock second source re-parses: a split (SEND to self), carrier = vout1
    w.knownUtxos.set(key(utxo), { ...utxo, address: MOCK_WALLET.address, balances: { BLOK: amount }, confirmed: true, block_height: BASE_TIP - 40 - i, origin: { op: "SEND", amount } });
    if (i >= n) continue; // the last two carriers stay unlisted: the new listings to try at the cap
    const price_sats = Math.max(DUST_SATS, Math.round(floorUnit * (1.02 + i * 0.01) * amount));
    w.orders.set(key(utxo), signedOrder({ seller: MOCK_ID, utxo, ticker: "BLOK", amount, price_sats, created_at: LOAD_TS - 3600 * (i + 1) }));
  }
}

/**
 * Dev knob for the activation countdown: `sessionStorage["lp.mock.healthTip"]
 * = "969599"` makes /health report that tip (and indexed height) in THIS
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

/**
 * Dev knob for the node-health warnings: `sessionStorage["lp.mock.health"]
 * = '{"node_peers":0,"stalled":true}'` (any of node_peers, stalled,
 * rebuilding, tip_time, persist_ok) overrides those /health fields in THIS
 * tab. `rebuilding` sets `state_rebuilding`, the key that carries the
 * rebuild flag (`rebuilding` itself is always true).
 */
function mockHealthOverride() {
  try {
    const raw = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("lp.mock.health") : null;
    const o = raw ? JSON.parse(raw) : null;
    if (!o || typeof o !== "object") return {};
    const out = {};
    for (const k of ["node_peers", "stalled", "tip_time", "persist_ok"]) if (k in o) out[k] = o[k];
    if ("rebuilding" in o) out.state_rebuilding = o.rebuilding;
    return out;
  } catch {
    return {};
  }
}

/** Dev knob: `sessionStorage["lp.mock.feesDown"] = "1"` makes /fees answer `ok: false` with 1 sat/vB floors (the node could not estimate). */
function mockFeesDown() {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem("lp.mock.feesDown") === "1";
  } catch {
    return false;
  }
}

/**
 * Dev knob: `sessionStorage["lp.mock.networkAhead"] = "N"` makes the mock
 * second source's tip N blocks above the simulated one (our node behind
 * the network).
 */
function mockNetworkAhead() {
  try {
    const n = Number(typeof sessionStorage !== "undefined" ? sessionStorage.getItem("lp.mock.networkAhead") : 0);
    return Number.isInteger(n) && n > 0 && n < 10_000 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Dev knob for a wallet with many outputs: `sessionStorage["lp.mock.manyUtxos"]
 * = "N"` (1–5000) adds N confirmed 546-sat plain outputs to every address
 * (the simulated wallet lists them, GET /txouts knows them), so a wallet's
 * check of its list runs in several requests. Outputs of 546 sats are never
 * spent as fee inputs, so the knob changes what is listed, never what is spent.
 */
function mockExtraBtcUtxos(addr) {
  let n = 0;
  try {
    n = Number(typeof sessionStorage !== "undefined" ? sessionStorage.getItem("lp.mock.manyUtxos") : 0);
  } catch {
    n = 0;
  }
  if (!Number.isInteger(n) || n <= 0) return [];
  const count = Math.min(5000, n);
  const prefix = [...String(addr)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, "0");
  return Array.from({ length: count }, (_, i) => ({ txid: `${prefix}${i.toString(16).padStart(56, "0")}`, vout: 0, sats: DUST_SATS, confirmed: true, block_height: BASE_TIP - 10 }));
}

/** The mock second source's chain tip (src/lib/network.js) — nothing leaves the browser. */
export async function mockNetworkTip() {
  await sleep(LATENCY_MS);
  world();
  return (mockHealthTip() ?? tipHeight()) + mockNetworkAhead();
}

/** The mock second source's recommended fee rates (whole sat/vB, like mempool.space). */
export async function mockNetworkFees() {
  await sleep(LATENCY_MS);
  return { fastestFee: 3, halfHourFee: 2, hourFee: 2, economyFee: 1, minimumFee: 1 };
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
  // The book shows no ask of a ticker whose market is not open (0 / null figures).
  const open = isMarketOpen(w.tokens.get(ticker)) ? [...w.orders.values()].filter((o) => o.ticker === ticker && o.status === "open") : [];
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
    market_open: isMarketOpen(w.tokens.get(ticker)),
    market_opens_at_height: marketOpensAt(w.tokens.get(ticker)),
  };
}

/** Cumulative credited yield reached the supply. */
function isMintedOut(t) {
  return !!t && t.minted >= t.supply;
}

/** The block from which the market of a minted-out token is open (its completing block FINAL_DEPTH deep), or null. */
function marketOpensAt(t) {
  return isMintedOut(t) && Number.isInteger(t.minted_out_height) ? t.minted_out_height + MARKET_OPEN_DELAY : null;
}

/** The market gate: minted out AND the completing block FINAL_DEPTH deep (a row without the height counts as open). */
function isMarketOpen(t) {
  if (!isMintedOut(t)) return false;
  const at = marketOpensAt(t);
  return at === null || indexedHeight() >= at;
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
    market_open: isMarketOpen(t),
    market_opens_at_height: marketOpensAt(t),
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
      // seller's input is the 546-sat carrier) — and `to` is vout1, also
      // the buyer.
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
 * would serialise it (`vout[].scriptpubkey|value`, `vin[].witness|prevout`,
 * `status.block_hash|block_height`) — the real tx for a simulated
 * broadcast, a synthesized reference layout for a seeded carrier: a MINE
 * credited on vout0 (`origin.op` "MINE"); a SEND in the §2.3 reference
 * layout whose vout1 (AMT) or vout2 (the residual) is the carrier; any
 * other vout a plain transfer with no LUCKY-20 payload (the second source
 * refuses it). Null for an unknown outpoint.
 */
function explorerTxOf(txid, vout, u) {
  const w = world();
  const e = w.sim.get(txid);
  if (e) {
    const status = simConfirmed(e) ? { confirmed: true, block_height: e.height, block_hash: blockHashAt(e.height) } : { confirmed: false };
    const vin = e.decoded.inputs.map((i, k) => {
      const pv = prevoutOf(key(i));
      return { txid: i.txid, vout: i.vout, witness: e.decoded.witnesses[k] || [], prevout: pv ? { scriptpubkey: scriptHexOf(pv.address) || "", value: pv.sats } : null };
    });
    return { txid, vin, vout: e.decoded.outputs.map((o) => ({ scriptpubkey: o.script, value: o.sats })), status };
  }
  if (!u) return null;
  const carrier = { scriptpubkey: scriptHexOf(u.address) || "", value: u.sats };
  const dust = { scriptpubkey: carrier.scriptpubkey, value: DUST_SATS };
  const fee = { scriptpubkey: scriptHexOf(PROJECT_FEE_ADDRESS), value: DUST_SATS };
  const opret = (payload) => ({ scriptpubkey: hex.encode(makeOpReturnScript(payload)), value: 0 });
  const status = { confirmed: true, block_height: u.block_height, block_hash: blockHashAt(u.block_height) };
  const [ticker, amount] = Object.entries(u.balances || {})[0] || ["", 0];
  if (u.origin?.op === "MINE") return { txid, vout: [carrier, fee, opret(buildMinePayload(ticker))], status };
  const send = (amt) => opret(buildSendPayload({ ticker, amount: Math.max(1, Number(amt) || 1) }));
  // A SEND: vout0 fee, vout1 AMT, vout2 the residual, vout3 the OP_RETURN.
  if (vout === SEND_TO_VOUT) return { txid, vout: [fee, carrier, dust, send(u.origin?.amount ?? amount)], status };
  if (vout === SEND_RESIDUAL_VOUT) return { txid, vout: [fee, dust, carrier, send(1)], status };
  // Anything else: a plain transfer, no OP_RETURN.
  const outs = Array.from({ length: vout + 1 }, (_, i) => (i === vout ? carrier : dust));
  return { txid, vout: outs, status };
}

/**
 * Mock second source for VITE_MOCK=1, same verdict shape as
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

const publicOrder = ({ psbt: _psbt, ...rest }) => ({ ...rest, market_open: isMarketOpen(world().tokens.get(rest.ticker)) });

// ---- route table -----------------------------------------------------------------------------

const notFound = (p) => Object.assign(new Error(`Indexer ${p} -> HTTP 404`), { status: 404 });

/**
 * One page of `all`, clamped like the indexer: `limit` defaults to
 * `dfltLimit` and is at most `maxLimit`; at least 1 unless `allowZero` (the
 * global lists — /mines, /tokens/:ticker/holders — only cap it, so
 * `limit=0` there is an empty page).
 */
function page(all, q, dfltLimit = 20, maxLimit = 200, { allowZero = false } = {}) {
  const raw = q.get("limit");
  const asked = raw === null || raw === "" ? dfltLimit : Number(raw);
  const limit = Math.max(allowZero ? 0 : 1, Math.min(maxLimit, Number.isFinite(asked) ? Math.floor(asked) : dfltLimit));
  const offset = Math.max(0, Number(q.get("offset") || 0));
  return { total: all.length, offset, limit, items: all.slice(offset, offset + limit) };
}

/** The global lists' page (`/mines`, `/tokens/:ticker/holders`): default 100 rows, at most 500. */
export const MOCK_LIST_DEFAULT_LIMIT = 100;
export const MOCK_LIST_MAX_LIMIT = 500;

/** The indexer's `/tokens` page: default 10 rows, at most 500, oldest deploy first (then ticker). */
export const MOCK_TOKENS_DEFAULT_LIMIT = 10;
export const MOCK_TOKENS_MAX_LIMIT = 500;
// ---- GET /txouts and the simulated wallet's own list --------------------------------------------

/** Most outpoints one GET /txouts request may name (as the indexer). */
export const MOCK_TXOUTS_MAX = 100;
const TXOUT_ENTRY_RE = /^[0-9a-f]{64}:[0-9]+$/;
/** The indexer's refusals of a GET /txouts query, word for word. */
export const TXOUTS_REFUSALS = {
  list: "o must list 1 to 100 outpoints as txid:vout, separated by commas",
  tooMany: "at most 100 outpoints per request",
  entry: (n) => `outpoint ${n} is not txid:vout (64 lower-case hex characters, a colon, a whole number)`,
};

/** A 400 of the live transport (indexer.js `_httpGet`) for `path` with the server's `text`. */
function http400(path, text) {
  return Object.assign(new Error(`Indexer ${path} -> HTTP 400: ${text}`), { status: 400, detail: text });
}

/** Every output the mock knows by outpoint: created, registered, and the seeded rows of every seeded address. */
function outputIndex() {
  const w = world();
  const index = new Map();
  for (const addr of w.seededAddrs) {
    for (const u of seededBtcUtxos(addr)) index.set(key(u), { ...u, address: addr });
    for (const u of mockExtraBtcUtxos(addr)) index.set(key(u), { ...u, address: addr });
  }
  for (const [k, u] of w.knownUtxos) index.set(k, u);
  for (const [k, u] of w.created) index.set(k, u);
  return index;
}

/**
 * One GET /txouts row, as the indexer answers it: the output in the
 * simulated node's CONFIRMED UTXO set (a pending spend leaves it
 * `unspent`, a pending output is not), its depth on the indexed chain (0
 * while its block is above the indexed height — the `lp.mock.indexerLag`
 * knob), and the token state: a carrier whose spend has confirmed (and so
 * has been applied) carries no tokens any more.
 */
function txoutRow(k, index) {
  const [txid, voutText] = k.split(":");
  const vout = Number(voutText);
  const u = index.get(k) || null;
  const balances = Object.fromEntries(Object.entries(u?.balances || {}).filter(([, a]) => Number(a) > 0));
  const spend = spendOf(k);
  const spentInBlock = !!(spend && spend.confirmed);
  const carrier = !spentInBlock && Object.keys(balances).length > 0;
  const unspent = !!u && u.confirmed !== false && !spentInBlock;
  const base = { txid, vout, token_carrier: carrier, tokens: carrier ? balances : null };
  if (!unspent) return { txid, vout, unspent: false, sats: null, script_hex: null, address: null, confirmations: 0, coinbase: false, ...base };
  return {
    txid,
    vout,
    unspent: true,
    sats: u.sats,
    script_hex: scriptHexOf(u.address),
    address: u.address || null,
    confirmations: confirmationsAt(u.block_height, indexedHeight()) ?? 0,
    coinbase: false,
    ...base,
  };
}

/** GET /txouts?o=txid:vout,… → the rows, in request order (a repeated outpoint once), or the indexer's 400. */
function mockTxouts(path, q) {
  const all = q.getAll("o");
  if (all.length !== 1 || all[0] === "") throw http400(path, TXOUTS_REFUSALS.list);
  const entries = all[0].split(",");
  if (entries.length > MOCK_TXOUTS_MAX) throw http400(path, TXOUTS_REFUSALS.tooMany);
  const keys = [];
  for (const [i, e] of entries.entries()) {
    const ok = TXOUT_ENTRY_RE.test(e) && Number(e.split(":")[1]) <= 0xffffffff;
    if (!ok) throw http400(path, TXOUTS_REFUSALS.entry(i + 1));
    const k = `${e.split(":")[0]}:${Number(e.split(":")[1])}`;
    if (!keys.includes(k)) keys.push(k);
  }
  const index = outputIndex();
  return keys.map((k) => txoutRow(k, index));
}

/**
 * The simulated wallet's `getBitcoinUtxos()` answer, shaped like UniSat's:
 * every output of `addr` the wallet sees — confirmed or not, token carriers
 * included (a wallet knows nothing of LUCKY-20), outputs already spent by
 * a pending transaction left out — as `{ txid, vout, satoshis, scriptPk,
 * addressType, pubkey, inscriptions, atomicals }`.
 */
export async function mockWalletUtxos(addr) {
  await sleep(LATENCY_MS);
  settle();
  const script = scriptHexOf(addr);
  const addressType = String(addr).startsWith("bc1p") ? 2 : 1;
  return [...liveUtxos(addr), ...mockExtraBtcUtxos(addr)].map((u) => ({
    txid: u.txid,
    vout: u.vout,
    satoshis: u.sats,
    scriptPk: script,
    addressType,
    pubkey: addr === MOCK_WALLET.address ? MOCK_WALLET.pubkeyHex : "",
    inscriptions: [],
    atomicals: [],
  }));
}

/** The simulated wallet's `getBalance()`: `{ confirmed, unconfirmed, total }` in sats. */
export async function mockWalletBalance(addr) {
  await sleep(LATENCY_MS);
  settle();
  const rows = liveUtxos(addr);
  const confirmed = rows.filter((u) => u.confirmed !== false).reduce((s, u) => s + u.sats, 0);
  const unconfirmed = rows.filter((u) => u.confirmed === false).reduce((s, u) => s + u.sats, 0);
  return { confirmed, unconfirmed, total: confirmed + unconfirmed };
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
      last_poll_at: Math.floor(Date.now() / 1000) - 5,
      node_peers: 8,
      tip_time: blockTimeAt(tip),
      // always true: a build that reads this key pauses every write; the
      // rebuild flag is `state_rebuilding`
      rebuilding: true,
      state_rebuilding: false,
      final_depth: FINAL_DEPTH,
      persist_ok: true,
      stalled: false,
      ...mockHealthOverride(),
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
  if (p === "/txouts") {
    return mockTxouts(path, q);
  }
  if ((m = p.match(/^\/mines\/by-txid\/([^/]+)$/))) {
    const txid = decodeURIComponent(m[1]).toLowerCase();
    const row = w.simMines.find((r) => r.txid === txid) || w.feed.find((r) => r.txid === txid);
    if (row) return mineView(row);
    // A SEND with that txid: its transfer row, with the same depth fields.
    const send = [...w.simSends, ...w.history.sends].find((r) => r.txid === txid);
    if (send) return { ...send, ...depthOf(send.block_height) };
    throw notFound(p);
  }
  if ((m = p.match(/^\/mines\/([^/]+)$/))) {
    // Paged like the live indexer (indexer API: limit default 50, max 200).
    const addr = decodeURIComponent(m[1]);
    const sim = w.simMines.filter((r) => r.sender === addr).sort((a, b) => b.block_height - a.block_height);
    const pg = page([...sim, ...MY_SEEDED_MINES(addr)], q, 50);
    return { address: addr, mines: pg.items.map(mineView), total: pg.total, limit: pg.limit, offset: pg.offset };
  }
  if (p === "/mines") {
    const ticker = q.get("ticker");
    let all = [...w.simMines].sort((a, b) => b.block_height - a.block_height).concat(w.feed, w.history.mines);
    if (ticker) all = all.filter((r) => r.ticker === ticker);
    const pg = page(all, q, MOCK_LIST_DEFAULT_LIMIT, MOCK_LIST_MAX_LIMIT, { allowZero: true });
    return { ...pg, items: pg.items.map(mineView) };
  }
  if (p === "/tokens") {
    const deployer = q.get("deployer");
    const items = [...w.tokens.values()]
      .filter((t) => !deployer || t.deployer === deployer)
      .sort((a, b) => a.deploy_block - b.deploy_block || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0))
      .map(tokenView);
    return page(items, q, MOCK_TOKENS_DEFAULT_LIMIT, MOCK_TOKENS_MAX_LIMIT);
  }
  if ((m = p.match(/^\/tokens\/([^/]+)\/holders$/))) {
    const t = w.tokens.get(decodeURIComponent(m[1]));
    if (!t) throw notFound(p);
    const all = holdersFor(t);
    const pg = page(all, q, MOCK_LIST_DEFAULT_LIMIT, MOCK_LIST_MAX_LIMIT, { allowZero: true });
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
  if ((m = p.match(/^\/pending-deploys\/([^/]+)$/))) {
    return mockPendingDeploys(path, m[1]);
  }
  if ((m = p.match(/^\/transfers\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    const all = [...w.simSends, ...w.history.sends].filter((s) => s.sender === addr || s.to === addr).sort((a, b) => b.block_height - a.block_height);
    // Paged like every per-address list of the indexer (default 50, max 200).
    const pg = page(all, q, 50);
    return { address: addr, transfers: pg.items, total: pg.total, limit: pg.limit, offset: pg.offset };
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
  if (p === "/price") {
    return { usd_per_btc: USD_PER_BTC, as_of: now(), source: "mock" };
  }
  if ((m = p.match(/^\/tx-status\/([^/]+)$/))) {
    const txid = decodeURIComponent(m[1]).toLowerCase();
    const e = w.sim.get(txid);
    if (e) {
      if (!simConfirmed(e)) return { txid, confirmed: false, seen: true, in_mempool: true, block_height: null, block_hash: null, block_time: null, confirmations: 0, final: false };
      return { txid, confirmed: true, seen: true, in_mempool: false, block_height: e.height, block_hash: blockHashAt(e.height), block_time: Math.floor((e.at + CONFIRM_AFTER_MS) / 1000), ...depthOf(e.height) };
    }
    const row = w.feed.find((r) => r.txid === txid) || w.trades.find((r) => r.txid === txid);
    if (row) {
      return { txid, confirmed: true, seen: true, in_mempool: false, block_height: row.block_height, block_hash: row.block_hash, block_time: row.block_time ?? blockTimeAt(row.block_height), ...depthOf(row.block_height) };
    }
    return { txid, confirmed: false, seen: false, in_mempool: false, block_height: null, block_hash: null, block_time: null, confirmations: 0, final: false };
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
    // Fractional like the real indexer (a decimal rounded up to hundredths) so
    // mock mode exercises decimal rates end to end.
    // `ok: false` (the node could not estimate) serves 1 sat/vB floors, like the live indexer.
    if (mockFeesDown()) return { ok: false, fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, incrementalrelayfee: INCREMENTAL_RELAY_FEE };
    return { ok: true, fastestFee: 2.38, halfHourFee: 1.5, hourFee: 1.25, economyFee: 1.02, minimumFee: 1, incrementalrelayfee: INCREMENTAL_RELAY_FEE };
  }
  if ((m = p.match(/^\/orders\/by-address\/([^/]+)$/))) {
    // Paged like the live indexer (indexer API: limit default 50, max 200).
    // Beside the book's rows: the seller's listings that left the book with
    // their outpoint unspent (status "expired" — still fillable).
    // `expired` — like the live indexer — is every such listing on every
    // page, newest drop first (at most 500), outside the paging and `total`.
    const addr = decodeURIComponent(m[1]);
    const book = [...w.orders.values()].filter((o) => o.seller === addr);
    const live = new Set(book.filter((o) => o.status === "open" || o.status === "filling").map((o) => o.id));
    // A floor is listed while the address still holds its (unspent) outpoint;
    // a floor without a recorded seller counts as the holder's.
    const heldBy = (f) => (prevoutOf(f.id)?.address ?? f.seller) === addr;
    const offBook = [...w.floors.values()].filter((f) => (!f.seller || f.seller === addr) && heldBy(f) && !live.has(f.id)).sort((a, b) => (b.dropped_at ?? 0) - (a.dropped_at ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const rows = book.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map(publicOrder);
    const pg = page(rows, q, 50);
    return { address: addr, orders: pg.items, total: pg.total, limit: pg.limit, offset: pg.offset, expired: offBook.slice(0, 500).map((f) => offBookRow(f, addr)), expired_total: offBook.length };
  }
  if ((m = p.match(/^\/orders\/([^/]+)$/))) {
    const o = w.orders.get(decodeURIComponent(m[1]).toLowerCase());
    if (!o) throw notFound(p);
    return { ...o, market_open: isMarketOpen(w.tokens.get(o.ticker)) };
  }
  if (p === "/orders") {
    const ticker = q.get("ticker");
    // `open` excludes `filling` (a spend is already in the mempool); ask for
    // `filling` or `all` explicitly — exactly the live indexer's contract.
    const status = (q.get("status") || "").trim().toLowerCase() || "open";
    if (!["open", "filling", "filled", "cancelled", "all"].includes(status)) {
      throw Object.assign(new Error(`Indexer ${path} -> HTTP 400: status must be one of open | filling | filled | cancelled | all`), { status: 400 });
    }
    let all = [...w.orders.values()];
    if (ticker) all = all.filter((o) => o.ticker === ticker);
    if (status !== "all") all = all.filter((o) => o.status === status);
    // No live orders (open or filling) of a ticker whose market is not open,
    // whatever `status` asks (the live book's rule); closed ones stay listed.
    all = all.filter((o) => (o.status !== "open" && o.status !== "filling") || isMarketOpen(w.tokens.get(o.ticker)));
    // The book's one order for every status: unit price, then age, then id (byte order).
    all.sort((a, b) => a.unit_price - b.unit_price || a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
    // Dev knob for a relay that fails, while it is set:
    // `sessionStorage["lp.mock.relayDown"]` = "1" — every relay answers 502
    // and nothing is sent; = "silent" — the tx is sent, but the relay
    // answers 502 all the same.
    const down = mockRelayDown();
    if (down === "silent") simulateBroadcast(body);
    if (down) throw Object.assign(new Error("/broadcast HTTP 502: bad gateway"), { status: 502 });
    return simulateBroadcast(body);
  }
  throw notFound(path);
}

/** The relay-failure knob (see mockPostText): "1", "silent" or null. */
function mockRelayDown() {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const v = sessionStorage.getItem("lp.mock.relayDown");
    return v === "1" || v === "silent" ? v : null;
  } catch {
    return null;
  }
}

// The live transport's shape (indexer.orderHttpError): the server's `{ error }`
// sentence as the message, the status and raw body alongside.
const bad = (msg, status = 400) => {
  const body = JSON.stringify({ error: msg });
  return Object.assign(new Error(serverErrorText(body)), { status, path: "/orders", body });
};

/** The order book's 503 while it cannot write listings to disk. */
const ORDERS_NOT_SAVED_TEXT = "the order book cannot be saved right now; retry shortly";

/** A JSON number the book reads as an unsigned integer. */
const isU64 = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Names of the sighash types, as the order book prints them. */
const TAP_SIGHASH_NAMES = { 0x00: "SIGHASH_DEFAULT", 0x01: "SIGHASH_ALL", 0x02: "SIGHASH_NONE", 0x03: "SIGHASH_SINGLE", 0x81: "SIGHASH_ALL|SIGHASH_ANYONECANPAY", 0x82: "SIGHASH_NONE|SIGHASH_ANYONECANPAY", 0x83: "SIGHASH_SINGLE|SIGHASH_ANYONECANPAY" };
const sighashName = (b) => TAP_SIGHASH_NAMES[b] ?? `0x${Number(b).toString(16).padStart(2, "0")}`;

/**
 * The listing rules that need nothing but the PSBT, in the order book's
 * order and with its texts: amount and price range, the PSBT itself, one
 * input and one output, lock time 0, a version and input sequence a fill
 * can relay, the output paying the listed UTXO's own script exactly the
 * price, a carrier of at least 546 sats priced at least at its own value,
 * sighash type 0x83 and the seller's signature carrying it (P2TR key path
 * or the P2WPKH witness-program key). The mock checks the signature's
 * type byte, not the signature itself. → { input0, seller, carrierSats,
 * psbtHex: the listing reduced to the fields judged (listingPsbtFields) }
 */
function listingFacts(psbtHex, amount, price_sats) {
  if (amount < 1 || amount > REQUIRED_TOKEN_SUPPLY) throw bad(`amount must be in [1, ${REQUIRED_TOKEN_SUPPLY}]`);
  const maxPrice = amount * 100_000_000;
  if (!(price_sats >= DUST_SATS && price_sats <= maxPrice)) {
    throw bad(`price_sats must be in [${DUST_SATS}, ${maxPrice}] (≤ 1 BTC per whole token × ${amount})`);
  }
  const text = psbtHex.trim();
  if (!/^([0-9a-fA-F]{2})*$/.test(text)) throw bad("psbt is not valid hex");
  let L;
  let judged;
  try {
    judged = hex.encode(listingPsbtFields(hex.decode(text)));
    L = parseListing(judged);
  } catch (e) {
    throw bad(`psbt does not decode: ${e.message || e}`);
  }
  if (L.inputCount !== 1 || L.outputCount !== 1) throw bad("psbt must have exactly 1 input and 1 output");
  if (L.lockTime !== 0) throw bad("nLockTime must be 0");
  // §7.4: refuse a listing no fill could ever relay — the 0x83
  // signature commits nVersion and input0's nSequence, so no buyer can fix
  // them.
  if (L.version !== 1 && L.version !== 2) throw bad(`listing tx version must be 1 or 2 (got ${L.version}): a listing with any other version can never be filled`);
  const seq = L.input0.sequence;
  if (!Number.isInteger(seq) || seq < 0x80000000) {
    throw bad(`input0 nSequence 0x${(Number(seq) >>> 0).toString(16).padStart(8, "0")} sets a relative timelock: use 0xfffffffd, 0xfffffffe or 0xffffffff (any value >= 0x80000000) so the listing can be filled`);
  }
  const wu = L.input0.witnessUtxo;
  if (!wu) throw bad("input0 missing witnessUtxo");
  if (hex.encode(L.output0.script) !== hex.encode(wu.script)) throw bad("output0 must pay the seller's own script (== witnessUtxo.scriptPubKey)");
  if (L.output0.amount !== BigInt(price_sats)) throw bad(`output0 value ${L.output0.amount} != price_sats ${price_sats}`);
  const carrierSats = Number(wu.amount);
  if (carrierSats < DUST_SATS) throw bad(SMALL_CARRIER_LISTING_TEXT);
  if (price_sats < carrierSats) {
    throw bad(`price_sats ${price_sats} is below the listed UTXO's own value ${carrierSats} sat — BTC above price on the carrier goes to the buyer, so the ask must cover it (split the tokens onto a 546-sat carrier first to sell only tokens)`);
  }
  const st = L.input0.sighashType;
  if (st === null || st === undefined) throw bad("input0 missing sighashType (must be 0x83)");
  if (st !== LISTING_SIGHASH) throw bad(`input0 sighashType must be 0x83 (SINGLE|ANYONECANPAY), got 0x${Number(st).toString(16).padStart(2, "0")}`);
  if (L.input0.scriptType === "tr") {
    const sig = L.input0.tapKeySig;
    if (!sig) throw bad("input0 missing tapKeySig (P2TR listing must be key-path signed)");
    const type = sig.length === 64 ? 0x00 : sig[sig.length - 1];
    if (type !== LISTING_SIGHASH) throw bad(`tapKeySig sighash byte must be SINGLE|ANYONECANPAY, got ${sighashName(type)}`);
  } else if (L.input0.scriptType === "wpkh") {
    const own = sellerPartialSig(L.input0.partialSig, wu.script);
    if (!own) throw bad("input0 has no partialSig for the witness-program key");
    const type = own[1][own[1].length - 1];
    if (type !== LISTING_SIGHASH) throw bad(`partialSig sighash byte must be SINGLE|ANYONECANPAY, got ${sighashName(type)}`);
  } else {
    throw bad("unsupported script type: only P2TR key-path and P2WPKH listings are accepted");
  }
  const seller = L.input0.address;
  if (!seller) throw bad("listed script has no address form");
  return { input0: L.input0, seller, carrierSats, psbtHex: judged };
}

/** The simulated tx spending outpoint `k`, as `{ txid, confirmed }`, or null. */
function spendOf(k) {
  for (const [txid, e] of world().sim) {
    if (e.decoded.inputs.some((i) => key(i) === k)) return { txid, confirmed: simConfirmed(e) };
  }
  return null;
}

/** Fake `POST path` with a JSON body → JSON response. */
export async function mockPostJson(path, body) {
  await sleep(LATENCY_MS * 2);
  const w = world();
  settle();
  if (path !== "/orders") throw notFound(path);
  if (!body || typeof body !== "object" || typeof body.psbt !== "string" || typeof body.ticker !== "string" || !isU64(body.amount) || !isU64(body.price_sats)) {
    throw bad("invalid JSON body: expected { psbt, ticker, amount, price_sats }");
  }
  const psbt = body.psbt;
  const amount = Number(body.amount);
  const price_sats = Number(body.price_sats);
  const ticker = normalizeTickerLikeIndexer(body.ticker);
  if (!/^[A-Z0-9]{1,8}$/.test(ticker)) throw bad("ticker must match [A-Z0-9]{1,8}");
  // 0. The market gate comes first, before anything in the listing is read,
  //    then the book's ability to save it — as the live book checks them. A
  //    ticker the registry does not hold is left to the UTXO checks.
  const tok = w.tokens.get(ticker);
  if (tok && !isMintedOut(tok)) throw bad(`market opens when ${ticker} is fully minted (minted ${tok.minted} of ${tok.supply})`, 409);
  if (tok && !isMarketOpen(tok)) throw bad(`market opens at block ${marketOpensAt(tok)}`, 409);
  if (mockHealthOverride().persist_ok === false) throw bad(ORDERS_NOT_SAVED_TEXT, 503);
  // 1. Everything decidable from the PSBT alone, in the book's order and
  //    with its texts.
  const L = listingFacts(psbt, amount, price_sats);
  const outpoint = `${L.input0.txid}:${L.input0.vout}`;
  if (L.input0.address) ensureSeeded(L.input0.address);
  // 2. The book's state: no spend of it in flight, no cheaper signed
  //    listing of it, and a confirmed token UTXO carrying exactly this
  //    listing's tokens, held by the PSBT's script.
  const existing = w.orders.get(outpoint);
  if (existing && existing.status === "filling") throw bad(`outpoint has a pending spend in the mempool (${existing.pending_spend_txid || "unknown txid"})`, 409);
  // §7.4: the book keeps the CHEAPEST live signed listing of an
  // outpoint — the cheaper PSBT stays fillable on-chain whatever the book
  // shows, live or remembered as the outpoint's listing floor after it
  // left the book (while the outpoint is unspent); the same or a lower
  // price replaces it. Compared exactly, in integers.
  const asked = { price_sats, amount };
  const floor = w.floors.get(outpoint);
  if ((existing && existing.status === "open" && unitBelow(existing, asked)) || (floor && unitBelow(floor, asked))) {
    throw bad(WITHDRAW_FIRST_TEXT, 409);
  }
  const u = lookupUtxo(outpoint);
  const spend = w.spent.has(outpoint) ? spendOf(outpoint) : null;
  // A confirmed spend (or one the mock cannot place) leaves the outpoint unknown to the book.
  if (!u || !u.confirmed || (w.spent.has(outpoint) && (!spend || spend.confirmed))) {
    throw bad("outpoint is not a token-bearing UTXO known to the indexer (spent, unconfirmed, or never carried tokens)");
  }
  const bal = Object.entries(u.balances || {});
  if (bal.length !== 1 || bal[0][0] !== ticker || bal[0][1] !== amount) {
    const have = bal.map(([t, a]) => `${t}: ${a}`).sort();
    throw bad(`outpoint carries { ${have.join(", ")} }, listing must be its whole balance { ${ticker}: ${amount} }`);
  }
  if (!u.address) throw bad("listed UTXO's script has no address form");
  if (u.address !== L.seller) throw bad(`listed UTXO belongs to ${u.address}, PSBT script derives to ${L.seller}`);
  // 3. The node (mempool-aware): the output must still be there, and match the PSBT's witnessUtxo.
  if (spend) throw bad("outpoint spent or pending spend", 409);
  if (Number(u.sats) !== L.carrierSats) {
    throw bad(`witnessUtxo (${L.carrierSats} sat) does not match the on-chain output (${u.sats} sat / script)`);
  }
  const order = {
    id: outpoint,
    ticker,
    amount,
    price_sats,
    unit_price: price_sats / amount,
    seller: u.address,
    carrier_sats: u.sats,
  };
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
  // §7.4 price band, the live indexer's exact rule: at most
  // 100× the ticker's best OTHER open ask, compared exactly in integers
  // (price × best.amount ≤ 100 × best.price × amount); no band on an
  // otherwise empty book. An ask already at the least price its carrier
  // allows is told how many tokens such a carrier needs; a carrier holding
  // more than 546 sats cannot ask less than its own value, so it is told
  // how many tokens a fresh 546-sat carrier needs instead.
  const others = [...w.orders.values()].filter((o) => o.ticker === ticker && o.status === "open" && o.id !== outpoint);
  if (others.length) {
    const best = others.reduce((a, o) => (BigInt(o.price_sats) * BigInt(a.amount) < BigInt(a.price_sats) * BigInt(o.amount) ? o : a));
    const over = BigInt(order.price_sats) * BigInt(best.amount) > BigInt(MAX_ASK_BAND_MULTIPLE) * BigInt(best.price_sats) * BigInt(order.amount);
    if (over) {
      const bestUnit = best.price_sats / best.amount;
      const carrier = Number(u.sats) || 0;
      const least = Math.max(DUST_SATS, carrier);
      const needAt = (p) => Math.ceil((p * best.amount) / (MAX_ASK_BAND_MULTIPLE * best.price_sats));
      let hint = "";
      if (order.price_sats <= least) {
        hint = carrier > DUST_SATS
          ? `; this carrier holds ${carrier} sats, so its ask cannot go lower — send the tokens to a ${DUST_SATS}-sat carrier holding at least ${needAt(DUST_SATS)} tokens (a send to yourself) first`
          : `; at this ask a carrier listed at ${least} sats needs at least ${needAt(least)} tokens — combine tokens onto one carrier (a send to yourself) first`;
      }
      throw bad(`unit price ${order.unit_price.toFixed(4)} sats/token is outside the price band: at most ${MAX_ASK_BAND_MULTIPLE}× the current best ${ticker} ask (${bestUnit.toFixed(4)} sats/token → ceiling ${(bestUnit * MAX_ASK_BAND_MULTIPLE).toFixed(4)})${hint}`);
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
    psbt: canonicalListingPsbt(L.psbtHex),
  };
  // At or below any floor of this outpoint (a pricier one was refused
  // above): the book shows the cheapest signed listing again, and this one
  // leaves its own floor if it goes.
  w.floors.delete(outpoint);
  w.orders.set(outpoint, row);
  return { ...publicOrder(row), replaced: !!existing && existing.status === "open" };
}
