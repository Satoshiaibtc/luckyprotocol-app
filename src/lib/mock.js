// Deterministic mock indexer (VITE_MOCK=1).
//
// Implemented as a fake HTTP layer keyed by route path, so indexer.js runs
// the SAME parsers + sanitizers over mock data that it runs over a live
// indexer. Nothing here is random: hashes derive from sha256 of stable
// seeds, so the feed, the tip hash and every fake txid are the same on
// every reload. Simulated broadcasts confirm ~20s after being registered.

import { sha256 } from "@noble/hashes/sha2.js";
import { hex, bech32, bech32m } from "@scure/base";
import { p2tr, NETWORK } from "@scure/btc-signer";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { mineYield } from "./yield.js";
import { REQUIRED_TOKEN_SUPPLY, DUST_SATS } from "./payloads.js";

const BASE_TIP = 969_800;
const HASH_MINTED_BASE = 1_234_567;
const CONFIRM_AFTER_MS = 20_000;
const LATENCY_MS = 120;

const enc = (s) => new TextEncoder().encode(s);
const h256 = (s) => hex.encode(sha256(enc(s)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- deterministic fake identities ------------------------------------------------

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

// A mainnet-looking block hash: 19 leading zero nibbles + 44 pseudo-random
// nibbles + a last nibble that can be forced to land in a yield bucket.
const FORCED_DIGITS = new Map(); // height → digit
function blockHashAt(height) {
  const raw = h256(`block:${height}`);
  const forced = FORCED_DIGITS.get(height);
  const last = forced ?? raw[63];
  return `${"0".repeat(19)}${raw.slice(19, 63)}${last}`;
}
function blockTimeAt(height, tip) {
  return Math.floor(Date.now() / 1000) - (tip - height) * 600 - 240;
}

// ---- seeded network feed (20 rows, mixed yields) ---------------------------------

const YIELD_PATTERN = [21, 100, 21, 500, 21, 21, 100, 21, 100, 21, 21, 500, 21, 100, 21, 21, 100, 21, 21, 21];
const SENDERS = Array.from({ length: 7 }, (_, i) =>
  i % 3 === 2 ? fakeP2wpkh(`miner-${i}`) : fakeP2tr(`miner-${i}`),
);

const FEED = YIELD_PATTERN.map((y, i) => {
  const height = BASE_TIP - 1 - Math.floor(i / 2); // ~2 mines per block
  const raw = h256(`block:${height}`);
  const pick = parseInt(raw[40], 16);
  const digit = y === 500 ? "f" : y === 100 ? "abcde"[pick % 5] : String(pick % 10);
  FORCED_DIGITS.set(height, digit);
  return {
    txid: fakeTxid(`feed-${i}`),
    block_height: height,
    block_hash: blockHashAt(height),
    sender: SENDERS[i % SENDERS.length],
    ticker: "HASH",
    status: "settled",
    yield_smallest: y,
    cap_exhausted: false,
  };
});

// ---- simulated broadcasts -----------------------------------------------------------

/** txid → { at, address, ticker, height } */
const SIM = new Map();
let simOrder = 0;

function simConfirmed(entry) {
  return Date.now() - entry.at >= CONFIRM_AFTER_MS;
}
function simConfirmedList() {
  return [...SIM.entries()].filter(([, e]) => simConfirmed(e)).map(([txid, e]) => ({ txid, ...e }));
}
function tipHeight() {
  const confirmed = simConfirmedList();
  return confirmed.length ? Math.max(BASE_TIP, ...confirmed.map((e) => e.height)) : BASE_TIP;
}
function simMineView(txid, e) {
  const block_hash = blockHashAt(e.height);
  return {
    txid,
    block_height: e.height,
    block_hash,
    sender: e.address,
    ticker: e.ticker,
    status: "settled",
    yield_smallest: mineYield(block_hash),
    cap_exhausted: false,
  };
}

/** Register a simulated broadcast. Returns the fake txid. */
export function simulateBroadcast(rawHex, meta = {}) {
  const txid = fakeTxid(`sim:${rawHex}:${simOrder}`);
  simOrder += 1;
  SIM.set(txid, {
    at: Date.now(),
    address: meta.address || SENDERS[0],
    ticker: meta.ticker || "HASH",
    height: BASE_TIP + simOrder,
  });
  return txid;
}

// ---- per-address fakes --------------------------------------------------------------

const MY_SEEDED_MINES = (addr) =>
  [500, 21, 100].map((y, i) => {
    const height = BASE_TIP - 30 - i * 7;
    const raw = h256(`block:${height}`);
    const pick = parseInt(raw[40], 16);
    const digit = y === 500 ? "f" : y === 100 ? "abcde"[pick % 5] : String(pick % 10);
    FORCED_DIGITS.set(height, digit);
    return {
      txid: fakeTxid(`mine:${addr}:${i}`),
      block_height: height,
      block_hash: blockHashAt(height),
      sender: addr,
      ticker: "HASH",
      status: "settled",
      yield_smallest: y,
      cap_exhausted: false,
    };
  });

function simYieldFor(addr) {
  return simConfirmedList()
    .filter((e) => e.address === addr)
    .reduce((s, e) => s + (mineYield(blockHashAt(e.height)) || 0), 0);
}

function btcUtxosFor(addr) {
  const mk = (i, sats, confirmed) => ({
    txid: fakeTxid(`utxo:${addr}:${i}`),
    vout: i % 2,
    sats,
    confirmed,
    block_height: confirmed ? BASE_TIP - 100 - i * 13 : null,
  });
  return [
    mk(0, DUST_SATS, true),   // token carrier — must be excluded by the builder
    mk(1, 12_000, true),
    mk(2, 48_500, true),
    mk(3, 250_000, true),
    mk(4, 5_000, false),      // pending mempool output
  ];
}

// ---- route table --------------------------------------------------------------------

const notFound = (p) => Object.assign(new Error(`Indexer ${p} -> HTTP 404`), { status: 404 });

const TOKENS = () => {
  const simMinted = simConfirmedList().reduce(
    (s, e) => s + (mineYield(blockHashAt(e.height)) || 0),
    0,
  );
  return [
    {
      ticker: "HASH",
      supply: REQUIRED_TOKEN_SUPPLY,
      minted: HASH_MINTED_BASE + simMinted,
      deployer: fakeP2tr("deployer-hash"),
      deploy_txid: fakeTxid("deploy-hash"),
      deploy_block: 969_500,
    },
    {
      ticker: "ORE",
      supply: REQUIRED_TOKEN_SUPPLY,
      minted: 42_021,
      deployer: fakeP2wpkh("deployer-ore"),
      deploy_txid: fakeTxid("deploy-ore"),
      deploy_block: 969_512,
    },
  ];
};

/** Fake `GET path` → parsed JSON. Throws `HTTP 404` like the real transport. */
export async function mockGet(path) {
  await sleep(LATENCY_MS);
  const url = new URL(path, "http://mock.invalid");
  const p = url.pathname;
  const q = url.searchParams;
  let m;

  if (p === "/") {
    const tip = tipHeight();
    return {
      network: "mainnet",
      mock: true,
      indexed_height: tip,
      tip_height: tip,
      token_count: 2,
      mine_count: FEED.length + simConfirmedList().length,
      last_progress_at: Math.floor(Date.now() / 1000) - 12,
      stalled: false,
    };
  }
  if ((m = p.match(/^\/balances\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    return { address: addr, balances: { HASH: 3_121 + simYieldFor(addr), ORE: 42 } };
  }
  if ((m = p.match(/^\/utxos\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    const carrier = btcUtxosFor(addr)[0];
    return {
      address: addr,
      utxos: [{ txid: carrier.txid, vout: carrier.vout, balances: { HASH: 3_121, ORE: 42 } }],
    };
  }
  if ((m = p.match(/^\/btc-utxos\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    return { address: addr, scanned_at_height: tipHeight(), utxos: btcUtxosFor(addr) };
  }
  if ((m = p.match(/^\/mines\/by-txid\/([^/]+)$/))) {
    const txid = decodeURIComponent(m[1]).toLowerCase();
    const e = SIM.get(txid);
    if (e) {
      if (!simConfirmed(e)) throw notFound(p);
      return simMineView(txid, e);
    }
    const row = FEED.find((r) => r.txid === txid);
    if (row) return row;
    throw notFound(p);
  }
  if ((m = p.match(/^\/mines\/([^/]+)$/))) {
    const addr = decodeURIComponent(m[1]);
    const sim = simConfirmedList()
      .filter((e) => e.address === addr)
      .map((e) => simMineView(e.txid, e))
      .sort((a, b) => b.block_height - a.block_height);
    return { address: addr, mines: [...sim, ...MY_SEEDED_MINES(addr)] };
  }
  if (p === "/mines") {
    const limit = Number(q.get("limit") || 20);
    const offset = Number(q.get("offset") || 0);
    const ticker = q.get("ticker");
    const sim = simConfirmedList()
      .map((e) => simMineView(e.txid, e))
      .sort((a, b) => b.block_height - a.block_height);
    let all = [...sim, ...FEED];
    if (ticker) all = all.filter((r) => r.ticker === ticker);
    return { total: all.length, offset, limit, items: all.slice(offset, offset + limit) };
  }
  if (p === "/tokens") {
    const items = TOKENS();
    return { total: items.length, offset: 0, limit: items.length, items };
  }
  if ((m = p.match(/^\/tokens\/([^/]+)\/holders$/))) {
    const ticker = decodeURIComponent(m[1]);
    const holders = SENDERS.map((a, i) => ({ address: a, balance: 25_000 - i * 3_100 }));
    return { ticker, total: holders.length, limit: holders.length, offset: 0, holders };
  }
  if ((m = p.match(/^\/tokens\/([^/]+)$/))) {
    const t = TOKENS().find((x) => x.ticker === decodeURIComponent(m[1]));
    if (!t) throw notFound(p);
    return { ...t, holders: SENDERS.length };
  }
  if ((m = p.match(/^\/transfers\/([^/]+)$/))) {
    return { address: decodeURIComponent(m[1]), transfers: [] };
  }
  if ((m = p.match(/^\/tx-status\/([^/]+)$/))) {
    const txid = decodeURIComponent(m[1]).toLowerCase();
    const e = SIM.get(txid);
    if (e) {
      if (!simConfirmed(e)) {
        return { txid, confirmed: false, block_height: null, block_hash: null, block_time: null };
      }
      return {
        txid,
        confirmed: true,
        block_height: e.height,
        block_hash: blockHashAt(e.height),
        block_time: Math.floor((e.at + CONFIRM_AFTER_MS) / 1000),
      };
    }
    const row = FEED.find((r) => r.txid === txid);
    if (row) {
      return {
        txid,
        confirmed: true,
        block_height: row.block_height,
        block_hash: row.block_hash,
        block_time: blockTimeAt(row.block_height, tipHeight()),
      };
    }
    return { txid, confirmed: false, block_height: null, block_hash: null, block_time: null };
  }
  if ((m = p.match(/^\/block-info\/(\d+)$/))) {
    const height = Number(m[1]);
    const tip = tipHeight();
    if (height > tip) throw notFound(p);
    return { height, hash: blockHashAt(height), time: blockTimeAt(height, tip) };
  }
  if (p === "/fees") {
    return { fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 3, minimumFee: 1 };
  }
  throw notFound(p);
}

/** Fake `POST path` with a text body → text response. */
export async function mockPostText(path, body, meta) {
  await sleep(LATENCY_MS * 3);
  if (path === "/broadcast") {
    if (typeof body !== "string" || body.length < 20) {
      throw new Error("broadcast HTTP 400: empty or malformed tx hex");
    }
    return simulateBroadcast(body, meta);
  }
  throw notFound(path);
}

/**
 * Simulated wallet identity. The PSBT builder sets `tapInternalKey` on P2TR
 * inputs and btc-signer validates it as a real curve point, so this must be
 * a genuine secp256k1 key — derived from a PUBLIC seed, so the address is
 * coherent with the pubkey exactly like a UniSat account. Never fund it.
 */
export const MOCK_WALLET = (() => {
  const priv = sha256(enc("hashmint-mock-wallet:privkey (public seed, never fund)"));
  const pub = pubECDSA(priv, true); // 33-byte compressed
  return {
    address: p2tr(pub.slice(1), undefined, NETWORK).address,
    pubkeyHex: hex.encode(pub),
  };
})();
