// HashMint indexer adapter — HTTP only (PROTOCOL-v3-HASHMINT.md §5).
//
// Every chain-derived read goes through the indexer. There is NO
// third-party fallback: if the indexer is unreachable, reads throw and the
// UI shows the offline state. mempool.space is only ever an explorer LINK
// target — it is never fetched.
//
// Base URL: `VITE_INDEXER_URL` at build time (default http://127.0.0.1:8765),
// validated by `_isAllowedIndexerUrl` (https, or http to loopback).
//
// Mock mode: `VITE_MOCK=1` swaps the transport for src/lib/mock.js. The
// parsers + sanitizers below still run — mock data is not trusted either.
//
// Routes:
//   GET  /                          health
//   GET  /balances/:addr            balances
//   GET  /utxos/:addr               tokenUtxos        (token-bearing only)
//   GET  /btc-utxos/:addr           btcUtxos          (raw BTC UTXOs)
//   GET  /mines/:addr               minesByAddress
//   GET  /mines?limit&offset&ticker minesFeed
//   GET  /mines/by-txid/:txid       mineByTxid
//   GET  /tokens?limit&offset       tokens
//   GET  /tokens/:ticker            token
//   GET  /tokens/:ticker/holders    tokenHolders
//   GET  /transfers/:addr           transfers
//   GET  /tx-status/:txid           txStatus
//   GET  /block-info/:height        blockInfo
//   GET  /fees                      fees
//   POST /broadcast                 broadcast         (text/plain raw hex)

import { mockGet, mockPostText } from "./mock.js";

export const DEFAULT_INDEXER_URL = "http://127.0.0.1:8765";
const MOCK = import.meta.env.VITE_MOCK === "1";

/**
 * Validate an indexer base URL before we trust it. A poisoned value could
 * redirect every chain read (balances, UTXOs, tx-status) to an attacker's
 * server. CSP connect-src is the primary gate; this is the independent
 * second check: https with a hostname, or http to a loopback host.
 */
export function _isAllowedIndexerUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.hostname.length === 0) return false;
  if (u.protocol === "https:") return true;
  const loopback =
    u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return u.protocol === "http:" && loopback;
}

const _configured = String(import.meta.env.VITE_INDEXER_URL || "").trim();
export const INDEXER_URL = (
  _configured && _isAllowedIndexerUrl(_configured) ? _configured : DEFAULT_INDEXER_URL
).replace(/\/+$/, "");

if (_configured && !_isAllowedIndexerUrl(_configured)) {
  // eslint-disable-next-line no-console
  console.warn(
    `[indexer] ignoring VITE_INDEXER_URL="${_configured}" — must be https:// or http:// to ` +
    `localhost; using ${DEFAULT_INDEXER_URL}`,
  );
}

export const isMock = () => MOCK;
export const getIndexerUrl = () => INDEXER_URL;

// ---- HTTP transport -----------------------------------------------------------------

// Every request gets a default timeout so a wedged server can't hang a
// caller forever. 30s is generous for a healthy indexer.
const HTTP_TIMEOUT_MS = 30_000;

// AbortSignal that fires on EITHER our timeout OR a caller-supplied signal.
function _timedSignal(callerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort();
    else callerSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return {
    signal: ctrl.signal,
    timedOut: () => ctrl.signal.aborted && !(callerSignal && callerSignal.aborted),
    done: () => clearTimeout(timer),
  };
}

async function _httpGet(path, signal) {
  if (MOCK) return mockGet(path);
  const url = `${INDEXER_URL}${path}`;
  const t = _timedSignal(signal);
  let res;
  try {
    res = await fetch(url, { signal: t.signal });
  } catch (e) {
    if (t.timedOut()) throw new Error(`Indexer timeout after ${HTTP_TIMEOUT_MS}ms: ${url}`);
    if (signal && signal.aborted) throw e;
    throw new Error(`Indexer unreachable: ${url} — ${e.message || e}`);
  } finally {
    t.done();
  }
  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    const err = new Error(`Indexer ${path} -> HTTP ${res.status}${body ? `: ${body}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

async function _httpPostText(path, body, signal, meta) {
  if (MOCK) return mockPostText(path, body, meta);
  const url = `${INDEXER_URL}${path}`;
  const t = _timedSignal(signal);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
      signal: t.signal,
    });
  } catch (e) {
    if (t.timedOut()) throw new Error(`Indexer timeout after ${HTTP_TIMEOUT_MS}ms: ${url}`);
    throw new Error(`Indexer unreachable: ${url} — ${e.message || e}`);
  } finally {
    t.done();
  }
  const text = (await res.text().catch(() => "")).trim();
  if (!res.ok) {
    const err = new Error(`${path} HTTP ${res.status}${text ? `: ${text}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return text;
}

const _is404 = (e) => e && (e.status === 404 || /HTTP 404/.test(String(e.message)));

// ---- Response sanitization -----------------------------------------------------------
//
// The indexer is the authority for correctness, but "authoritative" is not
// "assume every field is well-formed". Anything failing a type / range /
// shape check is dropped — a partial-but-valid view beats poisoning the UI.

const _TICKER_RE = /^[A-Z0-9]{1,8}$/;
const _TXID_RE = /^[0-9a-f]{64}$/i;
const _HASH_RE = /^[0-9a-f]{64}$/i;
const _MAX_TOKEN_AMT = 21_000_000;
const _MAX_SATS = 21_000_000 * 100_000_000;

const _safeInt = (v, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};

const _safeStr = (v, max) =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

const _safeHash = (v) => (_HASH_RE.test(String(v || "")) ? String(v).toLowerCase() : null);

function _sanitizeBalances(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [ticker, amt] of Object.entries(raw)) {
    const n = _safeInt(amt, _MAX_TOKEN_AMT);
    if (_TICKER_RE.test(ticker) && n !== null) out[ticker] = n;
  }
  return out;
}

function _sanitizeTokenUtxo(u) {
  if (!u || typeof u !== "object" || !_TXID_RE.test(String(u.txid || ""))) return null;
  const vout = _safeInt(u.vout, 1e6);
  if (vout === null) return null;
  return { txid: String(u.txid).toLowerCase(), vout, balances: _sanitizeBalances(u.balances) };
}

function _sanitizeBtcUtxo(u) {
  if (!u || typeof u !== "object" || !_TXID_RE.test(String(u.txid || ""))) return null;
  const vout = _safeInt(u.vout, 1e6);
  const sats = _safeInt(u.sats, _MAX_SATS);
  if (vout === null || sats === null) return null;
  return {
    txid: String(u.txid).toLowerCase(),
    vout,
    sats,
    confirmed: u.confirmed !== false,
    block_height: _safeInt(u.block_height, 1e9) ?? 0,
  };
}

// MineView (§5): identity fields must be well-formed; yield clamps to the
// supply cap; status is coerced to the two documented values.
function _sanitizeMineRow(m) {
  if (!m || typeof m !== "object") return null;
  if (!_TXID_RE.test(String(m.txid || ""))) return null;
  if (!_TICKER_RE.test(String(m.ticker || ""))) return null;
  const height = _safeInt(m.block_height, 1e9);
  const y = _safeInt(m.yield_smallest, _MAX_TOKEN_AMT);
  if (height === null || y === null) return null;
  const sender = _safeStr(m.sender, 128);
  if (!sender) return null;
  return {
    txid: String(m.txid).toLowerCase(),
    ticker: m.ticker,
    block_height: height,
    block_hash: _safeHash(m.block_hash),
    sender,
    status: m.status === "invalid" ? "invalid" : "settled",
    yield_smallest: y,
    cap_exhausted: m.cap_exhausted === true,
  };
}

function _sanitizeTransferRow(t) {
  if (!t || typeof t !== "object") return null;
  if (!_TXID_RE.test(String(t.txid || ""))) return null;
  if (!_TICKER_RE.test(String(t.ticker || ""))) return null;
  const height = _safeInt(t.block_height, 1e9);
  const amount = _safeInt(t.amount, _MAX_TOKEN_AMT);
  if (height === null || amount === null || !_safeStr(t.sender, 128)) return null;
  return { ...t, txid: String(t.txid).toLowerCase(), block_height: height, amount };
}

function _sanitizeTokenRow(t) {
  if (!t || typeof t !== "object") return null;
  if (!_TICKER_RE.test(String(t.ticker || ""))) return null;
  if (!_TXID_RE.test(String(t.deploy_txid || ""))) return null;
  const supply = _safeInt(t.supply, _MAX_TOKEN_AMT);
  const minted = _safeInt(t.minted, _MAX_TOKEN_AMT);
  const block = _safeInt(t.deploy_block, 1e9);
  if (supply === null || minted === null || block === null) return null;
  if (!_safeStr(t.deployer, 128)) return null;
  const holders = _safeInt(t.holders, 1e9);
  return {
    ticker: t.ticker,
    supply,
    minted,
    deployer: t.deployer,
    deploy_txid: String(t.deploy_txid).toLowerCase(),
    deploy_block: block,
    ...(holders !== null ? { holders } : {}),
  };
}

function _sanitizeHolderRow(h) {
  if (!h || typeof h !== "object") return null;
  const address = _safeStr(h.address, 128);
  const balance = _safeInt(h.balance, _MAX_TOKEN_AMT);
  if (!address || balance === null) return null;
  return { address, balance };
}

function _sanitizeTxStatus(txid, s) {
  if (!s || typeof s !== "object") {
    return { txid, confirmed: false, block_height: null, block_hash: null, block_time: null };
  }
  const confirmed = s.confirmed === true;
  return {
    txid,
    confirmed,
    block_height: confirmed ? _safeInt(s.block_height, 1e9) : null,
    block_hash: confirmed ? _safeHash(s.block_hash) : null,
    block_time: confirmed ? _safeInt(s.block_time, 1e12) : null,
  };
}

function _sanitizeFees(f) {
  const pick = (k, dflt) => _safeInt(f && f[k], 100_000) ?? dflt;
  return {
    fastestFee: pick("fastestFee", 10),
    halfHourFee: pick("halfHourFee", 8),
    hourFee: pick("hourFee", 5),
    economyFee: pick("economyFee", 3),
    minimumFee: pick("minimumFee", 1),
  };
}

function _pageQuery(opts = {}) {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  if (opts.ticker) params.set("ticker", String(opts.ticker));
  const q = params.toString();
  return q ? `?${q}` : "";
}

// ---- Read API — one wrapper per route -----------------------------------------------

/** GET / — health + tip envelope. */
export async function health(signal) {
  const env = await _httpGet("/", signal);
  return {
    network: _safeStr(env && env.network, 32) || "unknown",
    indexed_height: _safeInt(env && env.indexed_height, 1e9),
    tip_height: _safeInt(env && env.tip_height, 1e9),
    token_count: _safeInt(env && env.token_count, 1e9) ?? 0,
    mine_count: _safeInt(env && env.mine_count, 1e12) ?? 0,
    last_progress_at: _safeInt(env && env.last_progress_at, 1e12),
    stalled: !!(env && env.stalled),
    mock: !!(env && env.mock),
  };
}

/** GET /balances/:addr → `{ TICKER: amount }` */
export async function balances(address, signal) {
  const env = await _httpGet(`/balances/${encodeURIComponent(address)}`, signal);
  return _sanitizeBalances(env && env.balances);
}

/** GET /utxos/:addr → token-bearing outpoints `[{ txid, vout, balances }]` */
export async function tokenUtxos(address, signal) {
  const env = await _httpGet(`/utxos/${encodeURIComponent(address)}`, signal);
  return ((env && env.utxos) || []).map(_sanitizeTokenUtxo).filter(Boolean);
}

/**
 * GET /btc-utxos/:addr → `[{ txid, vout, sats, confirmed, block_height }]`.
 * The first query for an address returns 503 while the indexer seeds its
 * scan; that surfaces as a thrown error the caller can retry.
 */
export async function btcUtxos(address, signal) {
  const env = await _httpGet(`/btc-utxos/${encodeURIComponent(address)}`, signal);
  return ((env && env.utxos) || []).map(_sanitizeBtcUtxo).filter(Boolean);
}

/** GET /mines/:addr → MineView[] (sender == addr, newest first) */
export async function minesByAddress(address, signal) {
  const env = await _httpGet(`/mines/${encodeURIComponent(address)}`, signal);
  return ((env && env.mines) || []).map(_sanitizeMineRow).filter(Boolean);
}

/** GET /mines?limit&offset&ticker → `{ total, offset, limit, items }` */
export async function minesFeed(opts = {}, signal) {
  const env = await _httpGet(`/mines${_pageQuery(opts)}`, signal);
  return {
    total: _safeInt(env && env.total, 1e12) ?? 0,
    offset: _safeInt(env && env.offset, 1e12) ?? 0,
    limit: _safeInt(env && env.limit, 1e6) ?? 0,
    items: ((env && env.items) || []).map(_sanitizeMineRow).filter(Boolean),
  };
}

/** GET /mines/by-txid/:txid → MineView | null (404) */
export async function mineByTxid(txid, signal) {
  try {
    const row = await _httpGet(`/mines/by-txid/${encodeURIComponent(txid)}`, signal);
    return _sanitizeMineRow(row);
  } catch (e) {
    if (_is404(e)) return null;
    throw e;
  }
}

/** GET /tokens?limit&offset → `{ total, offset, limit, items }` */
export async function tokens(opts = {}, signal) {
  const env = await _httpGet(`/tokens${_pageQuery(opts)}`, signal);
  return {
    total: _safeInt(env && env.total, 1e9) ?? 0,
    offset: _safeInt(env && env.offset, 1e9) ?? 0,
    limit: _safeInt(env && env.limit, 1e6) ?? 0,
    items: ((env && env.items) || []).map(_sanitizeTokenRow).filter(Boolean),
  };
}

/** GET /tokens/:ticker → registry entry (+ holders) | null (404) */
export async function token(ticker, signal) {
  try {
    const row = await _httpGet(`/tokens/${encodeURIComponent(ticker)}`, signal);
    return _sanitizeTokenRow(row);
  } catch (e) {
    if (_is404(e)) return null;
    throw e;
  }
}

/** GET /tokens/:ticker/holders?limit&offset */
export async function tokenHolders(ticker, opts = {}, signal) {
  const env = await _httpGet(
    `/tokens/${encodeURIComponent(ticker)}/holders${_pageQuery(opts)}`,
    signal,
  );
  return {
    ticker,
    total: _safeInt(env && env.total, 1e9) ?? 0,
    offset: _safeInt(env && env.offset, 1e9) ?? 0,
    limit: _safeInt(env && env.limit, 1e6) ?? 0,
    holders: ((env && env.holders) || []).map(_sanitizeHolderRow).filter(Boolean),
  };
}

/** GET /transfers/:addr */
export async function transfers(address, signal) {
  const env = await _httpGet(`/transfers/${encodeURIComponent(address)}`, signal);
  return ((env && env.transfers) || []).map(_sanitizeTransferRow).filter(Boolean);
}

/**
 * GET /tx-status/:txid → `{ txid, confirmed, block_height, block_hash, block_time }`.
 * A 404 means "not yet seen" and is returned as `confirmed:false`.
 */
export async function txStatus(txid, signal) {
  try {
    const s = await _httpGet(`/tx-status/${encodeURIComponent(txid)}`, signal);
    return _sanitizeTxStatus(txid, s);
  } catch (e) {
    if (_is404(e)) return _sanitizeTxStatus(txid, null);
    throw e;
  }
}

/** GET /block-info/:height → `{ height, hash, time }` | null (past tip) */
export async function blockInfo(height, signal) {
  try {
    const env = await _httpGet(`/block-info/${Number(height)}`, signal);
    const hash = _safeHash(env && (env.hash || env.block_hash));
    if (!hash) return null;
    return {
      height: _safeInt(env && env.height, 1e9) ?? Number(height),
      hash,
      time: _safeInt(env && (env.time ?? env.timestamp), 1e12),
    };
  } catch (e) {
    if (_is404(e)) return null;
    throw e;
  }
}

/** GET /fees → `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee }` sat/vB */
export async function fees(signal) {
  return _sanitizeFees(await _httpGet("/fees", signal));
}

/**
 * POST /broadcast — body = raw signed tx hex (text/plain) → txid text.
 * 400 + reason on node rejection. `meta` is only used by mock mode (to
 * attribute the simulated mine to the connected address).
 */
export async function broadcast(rawHex, meta, signal) {
  if (typeof rawHex !== "string" || !/^[0-9a-f]+$/i.test(rawHex) || rawHex.length % 2 !== 0) {
    throw new Error("broadcast: rawHex must be an even-length hex string");
  }
  const txid = await _httpPostText("/broadcast", rawHex, signal, meta);
  if (!_TXID_RE.test(txid)) throw new Error(`broadcast: unexpected response "${String(txid).slice(0, 80)}"`);
  return txid.toLowerCase();
}
