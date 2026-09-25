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
// the §4 routing rules (MINE credits vout0, SEND routes its own ticker's
// AMT / residual and every other ticker to CHANGE_OUT, DEPLOY registers a
// ticker; whatever is not routed by a rule — DEPLOY / AVATAR / a plain
// spend — is DEFAULT-ROUTED to the tx's first non-OP_RETURN output), open
// orders whose outpoint was spent are settled per §7.5, and fills append a
// TradeView.
// That is what lets the whole listing → fill → trade loop run end-to-end
// without a node.
//
// The seeded order book carries REAL signed listings: each seller is a
// deterministic secp256k1 key and its PSBT is signed with
// SINGLE|ANYONECANPAY at first access, so `verifyListing` passes exactly as
// it would against a live indexer. Seeding is lazy (first mock call) so a
// production bundle that merely imports this module pays nothing.

import { sha256 } from "@noble/hashes/sha2.js";
import { hex, base64, bech32, bech32m } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import { EXPECTED_YIELD, bucketOfYield, mineYield } from "./yield.js";
import { REQUIRED_TOKEN_SUPPLY, DUST_SATS, PROJECT_FEE_ADDRESS, AVATAR_PROTOCOL_FEE_SATS } from "./payloads.js";
import { buildListingPsbt, verifyListing, parseListing, decodeRawTx, LISTING_SIGHASH } from "./swap.js";
import { parseEnvelopeFromWitness, checkEnvelopeLimits, bytesToDataUrl } from "./inscribe.js";

// A 16×16 PNG (141 bytes, a cyan diamond) — the seeded avatar of LUCKY, so
// the board shows one inscribed token before any AVATAR tx is simulated.
const SEED_AVATAR_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAVElEQVR42mNg5eAlCTFgFeXWsuLWsiJWA0Q1Lj0MeFRj1cOAVbXS5XdKl99h1cOASzUuPQx4VGPVw4BfNaYesjSQ7CRyPE1OsJITceQkDXISH34EAJ7PeVHXpJSFAAAAAElFTkSuQmCC";

const BASE_TIP = 969_800;
const CONFIRM_AFTER_MS = 20_000;
const LATENCY_MS = 120;
const LOAD_TS = Math.floor(Date.now() / 1000);

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
function blockTimeAt(height) {
  return LOAD_TS - (BASE_TIP - height) * 600 - 240;
}

// ---- seeded world (lazy) -------------------------------------------------------------------

const TOKEN_SEEDS = [
  { ticker: "LUCKY", minted: 1_234_567, deploy_block: 969_500, holders: 412, base: 48, deployerType: "tr" },
  { ticker: "BLOK", minted: 19_950_000, deploy_block: 969_501, holders: 3_310, base: 12.5, deployerType: "tr" },
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

function world() {
  if (W) return W;
  const tokens = new Map();
  const trades = [];
  const orders = new Map();
  const knownUtxos = new Map(); // outpoint → { txid, vout, sats, address, balances, confirmed, block_height }
  const traderPool = Array.from({ length: 12 }, (_, i) => (i % 4 === 3 ? fakeP2wpkh(`trader-${i}`) : fakeP2tr(`trader-${i}`)));

  const avatars = new Map(); // ticker → { bytes, contentType }
  const avatarViews = []; // AvatarView[] (§8.4), newest first

  for (const s of TOKEN_SEEDS) {
    // LUCKY is deployed by the simulated wallet so the §8 avatar flow can be previewed.
    const deployer = s.ticker === "LUCKY" ? MOCK_WALLET.address : s.deployerType === "wpkh" ? fakeP2wpkh(`deployer-${s.ticker}`) : fakeP2tr(`deployer-${s.ticker}`);
    tokens.set(s.ticker, {
      ticker: s.ticker,
      supply: REQUIRED_TOKEN_SUPPLY,
      minted: s.minted,
      deployer,
      deploy_txid: fakeTxid(`deploy-${s.ticker}`),
      deploy_block: s.deploy_block,
      holders: s.holders,
      mine_count: Math.round(s.minted / EXPECTED_YIELD),
      trade_count: 0,
      volume_sats: 0,
      avatar_txid: null,
      avatar_content_type: null,
    });
    if (s.ticker === "LUCKY") {
      const bytes = base64.decode(SEED_AVATAR_PNG_B64);
      const row = tokens.get(s.ticker);
      row.avatar_txid = fakeTxid(`avatar-${s.ticker}`);
      row.avatar_content_type = "image/png";
      avatars.set(s.ticker, { bytes, contentType: "image/png" });
      avatarViews.push({
        txid: row.avatar_txid,
        block_height: s.deploy_block + 2,
        block_hash: blockHashAt(s.deploy_block + 2),
        sender: deployer,
        ticker: s.ticker,
        applied: true,
        content_type: "image/png",
        bytes_len: bytes.length,
      });
    }

    // ---- trade history: 30–60 fills over ~3 days with a bounded price walk
    if (s.base > 0) {
      const n = randInt(`trades-n:${s.ticker}`, 30, 60);
      let p = s.base;
      for (let i = 0; i < n; i++) {
        const step = (rand(`walk:${s.ticker}:${i}`) - 0.47) * 0.12;
        p = Math.max(0.5, p * (1 + step));
        const amount = randInt(`amt:${s.ticker}:${i}`, 5, 300) * 10;
        const price_sats = Math.max(DUST_SATS, Math.round(p * amount));
        const height = BASE_TIP - 1 - Math.floor(((n - 1 - i) * 430) / n) - randInt(`jit:${s.ticker}:${i}`, 0, 3);
        const seller = traderPool[randInt(`seller:${s.ticker}:${i}`, 0, traderPool.length - 1)];
        let buyer = traderPool[randInt(`buyer:${s.ticker}:${i}`, 0, traderPool.length - 1)];
        if (buyer === seller) buyer = traderPool[(traderPool.indexOf(seller) + 1) % traderPool.length];
        trades.push({
          txid: fakeTxid(`trade:${s.ticker}:${i}`),
          block_height: Math.min(height, BASE_TIP - 1),
          block_hash: blockHashAt(Math.min(height, BASE_TIP - 1)),
          block_time: blockTimeAt(Math.min(height, BASE_TIP - 1)),
          ticker: s.ticker,
          amount,
          price_sats,
          unit_price: price_sats / amount,
          seller,
          buyer,
          order_id: `${fakeTxid(`filled-order:${s.ticker}:${i}`)}:0`,
        });
      }
      const mine = trades.filter((t) => t.ticker === s.ticker);
      const row = tokens.get(s.ticker);
      row.trade_count = mine.length;
      row.volume_sats = mine.reduce((a, t) => a + t.price_sats, 0);

      // ---- open asks: 3–8 real signed listings at ascending prices
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
        });
        const built = buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo: utxo, priceSats: price_sats, amount });
        const tx = btc.Transaction.fromPSBT(hex.decode(built.psbtHex));
        tx.signIdx(seller.priv, 0, [LISTING_SIGHASH]);
        const id = key(utxo);
        const created_at = LOAD_TS - randInt(`ask-age:${s.ticker}:${j}`, 600, 3 * 86400);
        orders.set(id, {
          id,
          ticker: s.ticker,
          amount,
          price_sats,
          unit_price: price_sats / amount,
          seller: seller.address,
          carrier_sats: DUST_SATS,
          status: "open",
          created_at,
          updated_at: created_at,
          spent_txid: null,
          spent_block: null,
          buyer: null,
          psbt: hex.encode(tx.toPSBT()),
        });
      }
    }
  }

  // ---- seeded network mine feed (20 rows, mixed yields + tickers)
  const feed = YIELD_PATTERN.map((y, i) => {
    const height = BASE_TIP - 1 - Math.floor(i / 2); // ~2 mines per block
    forceYield(height, y);
    return {
      txid: fakeTxid(`feed-${i}`),
      block_height: height,
      block_hash: blockHashAt(height),
      sender: SENDERS[i % SENDERS.length],
      ticker: FEED_TICKERS[i],
      status: "settled",
      yield_smallest: y,
      cap_exhausted: false,
    };
  });

  W = { tokens, trades, orders, knownUtxos, feed, avatars, avatarViews, sim: new Map(), simMines: [], spent: new Set(), created: new Map(), simOrder: 0, seededAddrs: new Set() };
  return W;
}

/** `data:` URL of a token's avatar (seeded or simulated), or null. Backs indexer.avatarUrl in mock mode. */
export function mockAvatarDataUrl(ticker) {
  const a = world().avatars.get(String(ticker || "").toUpperCase());
  return a ? bytesToDataUrl(a.bytes, a.contentType) : null;
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
    mk(5, DUST_SATS, true),   // LUCKY carrier
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
    { ...b[5], balances: { LUCKY: 1_921 } },
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

function simConfirmed(e) {
  return Date.now() - e.at >= CONFIRM_AFTER_MS;
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

/** Register a simulated broadcast. Returns the txid; throws like a node on a double-spend. */
export function simulateBroadcast(rawHex) {
  const w = world();
  let d;
  try {
    d = decodeRawTx(rawHex);
  } catch (e) {
    throw Object.assign(new Error(`broadcast HTTP 400: TX decode failed — ${e.message || e}`), { status: 400 });
  }
  if (w.sim.has(d.txid)) return d.txid; // idempotent re-broadcast
  for (const i of d.inputs) {
    if (w.spent.has(key(i))) {
      throw Object.assign(new Error("broadcast HTTP 400: bad-txns-inputs-missingorspent (an input was already spent by another transaction)"), { status: 400 });
    }
  }
  for (const i of d.inputs) w.spent.add(key(i));
  w.simOrder += 1;
  const height = BASE_TIP + w.simOrder;
  for (const o of d.outputs) {
    if (!o.address) continue;
    w.created.set(`${d.txid}:${o.vout}`, { txid: d.txid, vout: o.vout, sats: o.sats, address: o.address, balances: {}, confirmed: false, block_height: null });
  }
  // input0's witness stack — where an AVATAR reveal carries its envelope (§8.2).
  let witness0 = null;
  try {
    witness0 = btc.RawTx.decode(hex.decode(rawHex)).witnesses?.[0] || null;
  } catch {
    witness0 = null;
  }
  w.sim.set(d.txid, { at: Date.now(), height, decoded: d, witness0, applied: false });
  return d.txid;
}

/** Address of a spent input: created / known rows, else the deployer's seeded rows. */
function inputAddress(i, deployer) {
  const u = lookupUtxo(key(i));
  if (u && u.address) return u.address;
  if (deployer && seededBtcUtxos(deployer).some((s) => key(s) === key(i))) return deployer;
  return null;
}

/** Apply every confirmed-but-unapplied simulated tx (idempotent). */
function settle() {
  const w = world();
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
    if (amt <= 0) return;
    const c = w.created.get(`${txid}:${vout}`);
    if (!c) return; // OP_RETURN / unknown script — tokens can never land there (§4.4)
    c.balances[ticker] = (c.balances[ticker] || 0) + amt;
  };
  // Default routing: whatever no rule routed goes to the first non-OP_RETURN output.
  const firstOut = d.outputs.find((o) => o.address);
  const routeRest = (vout) => {
    const target = Number.isInteger(vout) ? vout : firstOut ? firstOut.vout : null;
    if (target === null) return;
    for (const [t, a] of Object.entries(pool)) credit(target, t, a);
  };

  const p = d.payload;
  let sendApplied = false;
  if (p && p.op === "MINE") {
    const tok = w.tokens.get(p.ticker);
    const valid = !!tok && !!d.outputs[0] && !!d.outputs[0].address;
    let y = 0;
    let capExhausted = false;
    if (valid) {
      const remaining = Math.max(0, tok.supply - tok.minted);
      y = Math.min(mineYield(hash) || 0, remaining);
      capExhausted = remaining === 0;
      tok.minted += y;
      tok.mine_count += 1;
    }
    for (const [t, a] of Object.entries(pool)) credit(0, t, a); // residual pool → vout0
    credit(0, p.ticker, y);
    w.simMines.push({
      txid,
      block_height: height,
      block_hash: hash,
      sender: senderOf(d),
      ticker: p.ticker,
      status: valid ? "settled" : "invalid",
      yield_smallest: y,
      cap_exhausted: capExhausted,
    });
  } else if (p && p.op === "SEND") {
    const to = d.outputs[p.toOutIdx];
    const chg = d.outputs[p.changeOutIdx];
    const have = pool[p.ticker] || 0;
    sendApplied = have >= p.amount && !!to && !!to.address && w.tokens.has(p.ticker);
    if (sendApplied) {
      credit(p.toOutIdx, p.ticker, p.amount);
      pool[p.ticker] = have - p.amount;
    }
    // Per-ticker routing: the residual of this ticker AND every other ticker
    // in the pool go to CHANGE_OUT; a missing CHANGE_OUT falls back to the
    // default route (first non-OP_RETURN output).
    routeRest(chg && chg.address ? p.changeOutIdx : null);
  } else if (p && p.op === "DEPLOY") {
    if (!w.tokens.has(p.ticker) && d.outputs[0] && d.outputs[0].address) {
      w.tokens.set(p.ticker, {
        ticker: p.ticker,
        supply: REQUIRED_TOKEN_SUPPLY,
        minted: 0,
        deployer: d.outputs[0].address,
        deploy_txid: txid,
        deploy_block: height,
        holders: 0,
        mine_count: 0,
        trade_count: 0,
        volume_sats: 0,
        avatar_txid: null,
        avatar_content_type: null,
      });
    }
    routeRest(null); // DEPLOY routes nothing → default route
  } else if (p && p.op === "AVATAR") {
    // §8.3: ticker deployed, a deployer-owned input, the exact 546-sat fee
    // output, a within-limits envelope in input0's witness, vout0 not OP_RETURN.
    const tok = w.tokens.get(p.ticker);
    const env = parseEnvelopeFromWitness(e.witness0 || []);
    const deployerInput = !!tok && d.inputs.some((i) => inputAddress(i, tok.deployer) === tok.deployer);
    const feeOk = d.outputs.some((o) => o.address === PROJECT_FEE_ADDRESS && o.sats === AVATAR_PROTOCOL_FEE_SATS);
    const applied = !!tok && deployerInput && feeOk && checkEnvelopeLimits(env) && !!d.outputs[0] && !!d.outputs[0].address;
    if (applied) {
      tok.avatar_txid = txid;
      tok.avatar_content_type = env.contentType;
      w.avatars.set(p.ticker, { bytes: env.bytes, contentType: env.contentType });
    }
    w.avatarViews.unshift({
      txid,
      block_height: height,
      block_hash: hash,
      sender: senderOf(d),
      ticker: p.ticker,
      applied,
      content_type: env ? env.contentType : null,
      bytes_len: env ? env.bytes.length : 0,
    });
    routeRest(null); // AVATAR routes nothing → default route
  } else {
    routeRest(null); // not a protocol tx → default route (tokens follow the first output)
  }

  // §7.5 order settlement for every spent outpoint.
  for (const i of d.inputs) {
    const o = w.orders.get(key(i));
    if (!o || o.status !== "open") continue;
    const v0 = d.outputs[0];
    const to = p && p.op === "SEND" ? d.outputs[p.toOutIdx] : null;
    const isFill =
      sendApplied && p.ticker === o.ticker && v0 && v0.address === o.seller && v0.sats >= o.price_sats && to && to.address;
    o.updated_at = time;
    o.spent_txid = txid;
    o.spent_block = height;
    if (isFill) {
      o.status = "filled";
      o.buyer = to.address;
      const trade = {
        txid,
        block_height: height,
        block_hash: hash,
        block_time: time,
        ticker: o.ticker,
        amount: o.amount,
        price_sats: v0.sats,
        unit_price: v0.sats / o.amount,
        seller: o.seller,
        buyer: to.address,
        order_id: o.id,
      };
      w.trades.push(trade);
      const tok = w.tokens.get(o.ticker);
      if (tok) { tok.trade_count += 1; tok.volume_sats += v0.sats; }
    } else {
      o.status = "cancelled";
    }
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

function tokenView(t) {
  const w = world();
  const open = [...w.orders.values()].filter((o) => o.ticker === t.ticker && o.status === "open");
  const mine = w.trades.filter((x) => x.ticker === t.ticker);
  const last = mine.length ? mine.reduce((a, b) => (b.block_height >= a.block_height ? b : a)) : null;
  return {
    ...t,
    open_orders: open.length,
    floor_unit_price: open.length ? Math.min(...open.map((o) => o.unit_price)) : null,
    last_trade: last,
  };
}

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
    const tip = tipHeight();
    return {
      network: "mainnet",
      mock: true,
      indexed_height: tip,
      tip_height: tip,
      token_count: w.tokens.size,
      mine_count: [...w.tokens.values()].reduce((s, t) => s + t.mine_count, 0),
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
    const addr = decodeURIComponent(m[1]);
    const sim = w.simMines.filter((r) => r.sender === addr).sort((a, b) => b.block_height - a.block_height);
    return { address: addr, mines: [...sim, ...MY_SEEDED_MINES(addr)] };
  }
  if (p === "/mines") {
    const ticker = q.get("ticker");
    let all = [...w.simMines].sort((a, b) => b.block_height - a.block_height).concat(w.feed);
    if (ticker) all = all.filter((r) => r.ticker === ticker);
    return page(all, q, 20);
  }
  if (p === "/tokens") {
    const items = [...w.tokens.values()].map(tokenView);
    return { total: items.length, offset: 0, limit: items.length, items };
  }
  if ((m = p.match(/^\/tokens\/([^/]+)\/holders$/))) {
    const t = w.tokens.get(decodeURIComponent(m[1]));
    if (!t) throw notFound(p);
    const all = holdersFor(t);
    const pg = page(all, q, 25);
    return { ticker: t.ticker, total: Math.max(t.holders, all.length), limit: pg.limit, offset: pg.offset, holders: pg.items };
  }
  if ((m = p.match(/^\/tokens\/([^/]+)$/))) {
    const t = w.tokens.get(decodeURIComponent(m[1]));
    if (!t) throw notFound(p);
    return tokenView(t);
  }
  if ((m = p.match(/^\/transfers\/([^/]+)$/))) {
    return { address: decodeURIComponent(m[1]), transfers: [] };
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
    for (let h = tip; h > tip - limit && h >= 0; h--) blocks.push({ height: h, hash: blockHashAt(h) });
    return { tip_height: tip, blocks };
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
    return { height, hash: blockHashAt(height), time };
  }
  if (p === "/fees") {
    return { fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 3, minimumFee: 1 };
  }
  if ((m = p.match(/^\/orders\/by-address\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    const rows = [...w.orders.values()].filter((o) => o.seller === addr).sort((a, b) => b.created_at - a.created_at).map(publicOrder);
    return { address: addr, orders: rows };
  }
  if ((m = p.match(/^\/orders\/([^/]+)$/))) {
    const o = w.orders.get(decodeURIComponent(m[1]).toLowerCase());
    if (!o) throw notFound(p);
    return { ...o };
  }
  if (p === "/orders") {
    const ticker = q.get("ticker");
    const status = q.get("status") || "open";
    let all = [...w.orders.values()];
    if (ticker) all = all.filter((o) => o.ticker === ticker);
    if (status !== "all") all = all.filter((o) => o.status === status);
    all = status === "open"
      ? all.sort((a, b) => a.unit_price - b.unit_price || a.created_at - b.created_at)
      : all.sort((a, b) => b.updated_at - a.updated_at);
    return page(all.map(publicOrder), q, 50);
  }
  if ((m = p.match(/^\/trades\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    const rows = w.trades.filter((t) => t.seller === addr || t.buyer === addr).sort((a, b) => b.block_height - a.block_height);
    return { address: addr, trades: rows };
  }
  if (p === "/trades") {
    const ticker = q.get("ticker");
    let all = [...w.trades].sort((a, b) => b.block_height - a.block_height || b.block_time - a.block_time);
    if (ticker) all = all.filter((t) => t.ticker === ticker);
    return page(all, q, 50);
  }
  if ((m = p.match(/^\/avatars\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    return { address: addr, avatars: w.avatarViews.filter((a) => a.sender === addr) };
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

const bad = (msg, status = 400) => Object.assign(new Error(`/orders HTTP ${status}: ${msg}`), { status });

/** Fake `POST path` with a JSON body → JSON response. */
export async function mockPostJson(path, body) {
  await sleep(LATENCY_MS * 2);
  const w = world();
  settle();
  if (path !== "/orders") throw notFound(path);
  if (!body || typeof body !== "object") throw bad("body must be JSON");
  const { psbt, ticker, amount, price_sats } = body;
  if (!w.tokens.has(ticker)) throw bad(`unknown ticker ${ticker}`);

  let L;
  try {
    L = parseListing(psbt);
  } catch (e) {
    throw bad(`psbt does not decode: ${e.message || e}`);
  }
  if (L.inputCount !== 1 || L.outputCount !== 1 || L.lockTime !== 0) throw bad("listing must have exactly 1 input, 1 output and nLockTime 0");
  const outpoint = `${L.input0.txid}:${L.input0.vout}`;
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
  const perAddress = [...w.orders.values()].filter((o) => o.seller === u.address && o.status === "open" && o.id !== outpoint).length;
  if (perAddress >= 50) throw bad("per-address open-order cap (50) reached");
  const existing = w.orders.get(outpoint);
  const now = Math.floor(Date.now() / 1000);
  const row = {
    ...order,
    status: "open",
    created_at: existing ? existing.created_at : now,
    updated_at: now,
    spent_txid: null,
    spent_block: null,
    buyer: null,
    psbt: String(psbt).toLowerCase(),
  };
  w.orders.set(outpoint, row);
  return { ...publicOrder(row), ...(existing && existing.status === "open" ? { replaced: true } : {}) };
}
