// LuckyProtocol indexer adapter — HTTP only (PROTOCOL-v3.md §5).
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
//   POST /orders                    postOrder         (JSON, §7.4)
//   GET  /orders?ticker&status…     orders            (psbt omitted)
//   GET  /orders/:id                order             (incl. psbt)
//   GET  /orders/by-address/:addr   ordersByAddress
//   GET  /trades?ticker&limit…      trades
//   GET  /trades/:addr              tradesByAddress
//   GET  /avatars/:addr             avatarsByAddress  (§8.4 audit list)
//   GET  /tokens/:ticker/avatar     avatarUrl         (image bytes; an <img> src, never fetched here)

import { mockGet, mockPostText, mockPostJson, mockAvatarDataUrl } from "./mock.js";

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

async function _httpPostJson(path, bodyObj, signal) {
  if (MOCK) return mockPostJson(path, bodyObj);
  const url = `${INDEXER_URL}${path}`;
  const t = _timedSignal(signal);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
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
    const err = new Error(`${path} HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    err.status = res.status;
    throw err;
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path}: response is not JSON`);
  }
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
// Mainnet address shapes the app can display/link: bech32/bech32m (bc1…)
// and legacy base58 (1…/3…). Anything else is dropped.
const _ADDR_RE = /^(bc1[ac-hj-np-z02-9]{8,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
const _ORDER_ID_RE = /^[0-9a-f]{64}:(0|[1-9][0-9]{0,6})$/i;
const _HEX_RE = /^[0-9a-f]+$/i;
const _MAX_TOKEN_AMT = 21_000_000;
const _MAX_SATS = 21_000_000 * 100_000_000;

const _safeInt = (v, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};

const _safeStr = (v, max) =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

const _safeHash = (v) => (_HASH_RE.test(String(v || "")) ? String(v).toLowerCase() : null);

const _safeAddr = (v) => (_ADDR_RE.test(String(v || "")) ? String(v) : null);

// Finite float ≥ 0 (unit prices). NaN / Infinity / negative → null.
const _safeFloat = (v, max = 1e18) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

const _safeHex = (v, maxLen = 200_000) =>
  typeof v === "string" && v.length > 0 && v.length <= maxLen && v.length % 2 === 0 && _HEX_RE.test(v)
    ? v.toLowerCase()
    : null;

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

// TradeView (§7.5). Chain-derived; every field is checked.
function _sanitizeTradeRow(t) {
  if (!t || typeof t !== "object") return null;
  if (!_TXID_RE.test(String(t.txid || ""))) return null;
  if (!_TICKER_RE.test(String(t.ticker || ""))) return null;
  const height = _safeInt(t.block_height, 1e9);
  const amount = _safeInt(t.amount, _MAX_TOKEN_AMT);
  const price = _safeInt(t.price_sats, _MAX_SATS);
  const seller = _safeAddr(t.seller);
  const buyer = _safeAddr(t.buyer);
  if (height === null || amount === null || amount < 1 || price === null || !seller || !buyer) return null;
  const unit = _safeFloat(t.unit_price);
  return {
    txid: String(t.txid).toLowerCase(),
    block_height: height,
    block_hash: _safeHash(t.block_hash),
    block_time: _safeInt(t.block_time, 1e12),
    ticker: t.ticker,
    amount,
    price_sats: price,
    unit_price: unit !== null ? unit : price / amount,
    seller,
    buyer,
    order_id: _ORDER_ID_RE.test(String(t.order_id || "")) ? String(t.order_id).toLowerCase() : null,
  };
}

// OrderView (§7.4). `psbt` is hex-only and only present on GET /orders/:id.
const _ORDER_STATUS = new Set(["open", "filled", "cancelled"]);
function _sanitizeOrderRow(o) {
  if (!o || typeof o !== "object") return null;
  if (!_ORDER_ID_RE.test(String(o.id || ""))) return null;
  if (!_TICKER_RE.test(String(o.ticker || ""))) return null;
  const amount = _safeInt(o.amount, _MAX_TOKEN_AMT);
  const price = _safeInt(o.price_sats, _MAX_SATS);
  const carrier = _safeInt(o.carrier_sats, _MAX_SATS);
  const seller = _safeAddr(o.seller);
  if (amount === null || amount < 1 || price === null || price < 546 || carrier === null || !seller) return null;
  const status = _ORDER_STATUS.has(o.status) ? o.status : null;
  if (!status) return null;
  const unit = _safeFloat(o.unit_price);
  const psbt = o.psbt !== undefined && o.psbt !== null ? _safeHex(o.psbt) : null;
  const spentTxid = _TXID_RE.test(String(o.spent_txid || "")) ? String(o.spent_txid).toLowerCase() : null;
  return {
    id: String(o.id).toLowerCase(),
    ticker: o.ticker,
    amount,
    price_sats: price,
    unit_price: unit !== null ? unit : price / amount,
    seller,
    carrier_sats: carrier,
    status,
    created_at: _safeInt(o.created_at, 1e12),
    updated_at: _safeInt(o.updated_at, 1e12),
    spent_txid: spentTxid,
    spent_block: _safeInt(o.spent_block, 1e9),
    buyer: _safeAddr(o.buyer),
    ...(psbt ? { psbt } : {}),
    ...(o.replaced === true ? { replaced: true } : {}),
  };
}

// §8.2 content types — the only values an avatar row may carry.
const _AVATAR_CT = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const _safeTxidOrNull = (v) => (_TXID_RE.test(String(v || "")) ? String(v).toLowerCase() : null);
const _safeAvatarCt = (v) => (_AVATAR_CT.has(String(v || "").toLowerCase()) ? String(v).toLowerCase() : null);

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
  const lastTrade = t.last_trade ? _sanitizeTradeRow(t.last_trade) : null;
  // §8.4: avatar_txid + avatar_content_type; both null unless both are well-formed.
  const avatarTxid = _safeTxidOrNull(t.avatar_txid);
  const avatarCt = _safeAvatarCt(t.avatar_content_type);
  return {
    ticker: t.ticker,
    supply,
    minted,
    deployer: t.deployer,
    deploy_txid: String(t.deploy_txid).toLowerCase(),
    deploy_block: block,
    ...(holders !== null ? { holders } : {}),
    // per-ticker stats (§5); missing/malformed → 0 / null, never NaN
    mine_count: _safeInt(t.mine_count, 1e12) ?? 0,
    trade_count: _safeInt(t.trade_count, 1e12) ?? 0,
    volume_sats: _safeInt(t.volume_sats, _MAX_SATS) ?? 0,
    open_orders: _safeInt(t.open_orders, 1e9) ?? 0,
    floor_unit_price: _safeFloat(t.floor_unit_price),
    last_trade: lastTrade,
    avatar_txid: avatarTxid && avatarCt ? avatarTxid : null,
    avatar_content_type: avatarTxid && avatarCt ? avatarCt : null,
  };
}

// AvatarView (§8.4).
function _sanitizeAvatarRow(a) {
  if (!a || typeof a !== "object") return null;
  if (a.op != null && !["DEPLOY", "AVATAR"].includes(a.op)) return null;
  const txid = _safeTxidOrNull(a.txid);
  if (!txid) return null;
  if (!_TICKER_RE.test(String(a.ticker || ""))) return null;
  const height = _safeInt(a.block_height, 1e9);
  const sender = _safeStr(a.sender, 128);
  if (height === null || !sender) return null;
  return {
    txid,
    block_height: height,
    block_hash: _safeHash(a.block_hash),
    sender,
    ticker: a.ticker,
    op: a.op || "AVATAR",
    applied: a.applied === true,
    content_type: _safeAvatarCt(a.content_type),
    bytes_len: _safeInt(a.bytes_len, 1e6) ?? 0,
  };
}

function _sanitizeHolderRow(h) {
  if (!h || typeof h !== "object") return null;
  const address = _safeStr(h.address, 128);
  const balance = _safeInt(h.balance, _MAX_TOKEN_AMT);
  if (!address || balance === null) return null;
  return { address, balance };
}

// `seen` — has the indexer met this txid at all? True when confirmed, or
// when the server says so (`seen:true` / `in_mempool:true`, a mempool-aware
// /tx-status). A server that answers 200 `confirmed:false` for ANY txid
// (no mempool lookup) proves nothing, so without those fields an
// unconfirmed tx is `seen:false` (audit M-7 — the old "every 200 is seen"
// reading made the avatar flow's "unseen" recovery dead code). A 404 is
// `seen:false` as before. `in_mempool` is the server's own flag, or null
// when it does not provide one.
function _sanitizeTxStatus(txid, s, known = true) {
  if (!s || typeof s !== "object") {
    return { txid, confirmed: false, seen: false, in_mempool: known ? null : false, block_height: null, block_hash: null, block_time: null };
  }
  const confirmed = s.confirmed === true;
  const inMempool = typeof s.in_mempool === "boolean" ? s.in_mempool : null;
  const seen = confirmed || s.seen === true || inMempool === true;
  return {
    txid,
    confirmed,
    seen,
    in_mempool: confirmed ? false : inMempool,
    block_height: confirmed ? _safeInt(s.block_height, 1e9) : null,
    block_hash: confirmed ? _safeHash(s.block_hash) : null,
    block_time: confirmed ? _safeInt(s.block_time, 1e12) : null,
  };
}

// A missing or malformed value is null — never a made-up default — and an
// absurd one (> 1e6 sat/vB) is dropped here; anything above the
// MAX_FEE_RATE_SAT_VB safety cap survives as-is so feechoice can REJECT
// it visibly ("estimate unavailable") instead of clamping (audit L-11).
function _sanitizeFees(f) {
  const pick = (k) => _safeInt(f && f[k], 1_000_000);
  return {
    fastestFee: pick("fastestFee"),
    halfHourFee: pick("halfHourFee"),
    hourFee: pick("hourFee"),
    economyFee: pick("economyFee"),
    minimumFee: pick("minimumFee"),
  };
}

function _pageQuery(opts = {}) {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  if (opts.ticker) params.set("ticker", String(opts.ticker));
  if (opts.deployer) params.set("deployer", String(opts.deployer));
  if (opts.status) params.set("status", String(opts.status));
  const q = params.toString();
  return q ? `?${q}` : "";
}

function _page(env, maxTotal, sanitize) {
  return {
    total: _safeInt(env && env.total, maxTotal) ?? 0,
    offset: _safeInt(env && env.offset, maxTotal) ?? 0,
    limit: _safeInt(env && env.limit, 1e6) ?? 0,
    items: ((env && env.items) || []).map(sanitize).filter(Boolean),
  };
}

// ---- Read API — one wrapper per route -----------------------------------------------

/** GET / — health + tip envelope. */
export async function health(signal) {
  // `/health` is an alias of `/` (spec §5); prefer it because some edge
  // configurations answer the bare root path with an error page. Fall back
  // to `/` for an indexer that predates the alias.
  let env;
  try {
    env = await _httpGet("/health", signal);
  } catch (e) {
    if (!_is404(e)) throw e;
    env = await _httpGet("/", signal);
  }
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
 * GET /tx-status/:txid → `{ txid, confirmed, seen, in_mempool, block_height, block_hash, block_time }`.
 * A 404 means "never seen" and is returned as `confirmed:false, seen:false`;
 * `seen` is true only when confirmed or when the server reports the tx
 * (`seen` / `in_mempool`) — see _sanitizeTxStatus.
 */
export async function txStatus(txid, signal) {
  try {
    const s = await _httpGet(`/tx-status/${encodeURIComponent(txid)}`, signal);
    return _sanitizeTxStatus(txid, s, true);
  } catch (e) {
    if (_is404(e)) return _sanitizeTxStatus(txid, null, false);
    throw e;
  }
}

/** GET /block-info/:height → `{ height, hash, time }` | null (past tip) */
/**
 * GET /blocks/recent?limit=N → `{ tip_height, blocks: [{ height, hash }] }`
 * newest first (spec §5). One request replaces N /block-info reads for the
 * block tape. Returns null when the indexer predates the route (404).
 */
export async function recentBlocks(limit = 16, signal) {
  const n = Math.min(32, Math.max(1, Number(limit) || 16));
  let env;
  try {
    env = await _httpGet(`/blocks/recent?limit=${n}`, signal);
  } catch (e) {
    if (_is404(e)) return null;
    throw e;
  }
  const rows = Array.isArray(env && env.blocks) ? env.blocks : [];
  const blocks = [];
  for (const r of rows.slice(0, n)) {
    const height = _safeInt(r && r.height, 1e9);
    const hash = _safeHash(r && r.hash);
    if (height === null || !hash) continue;
    blocks.push({ height, hash });
  }
  return { tip_height: _safeInt(env && env.tip_height, 1e9), blocks };
}

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
 * 400 + reason on node rejection. `meta` is only used by mock mode.
 */
export async function broadcast(rawHex, meta, signal) {
  if (typeof rawHex !== "string" || !/^[0-9a-f]+$/i.test(rawHex) || rawHex.length % 2 !== 0) {
    throw new Error("broadcast: rawHex must be an even-length hex string");
  }
  const txid = await _httpPostText("/broadcast", rawHex, signal, meta);
  if (!_TXID_RE.test(txid)) throw new Error(`broadcast: unexpected response "${String(txid).slice(0, 80)}"`);
  return txid.toLowerCase();
}

// ---- Trading (§7) --------------------------------------------------------------------

/** GET /orders?ticker&status&limit&offset → `{ total, offset, limit, items: OrderView[] }` (psbt omitted) */
export async function orders(opts = {}, signal) {
  const env = await _httpGet(`/orders${_pageQuery(opts)}`, signal);
  return _page(env, 1e9, _sanitizeOrderRow);
}

/** GET /orders/:id → OrderView incl. `psbt` | null (404). id = "txid:vout". */
export async function order(id, signal) {
  if (!_ORDER_ID_RE.test(String(id || ""))) throw new Error(`order: invalid id "${id}"`);
  try {
    const row = await _httpGet(`/orders/${encodeURIComponent(String(id).toLowerCase())}`, signal);
    return _sanitizeOrderRow(row);
  } catch (e) {
    if (_is404(e)) return null;
    throw e;
  }
}

/** GET /orders/by-address/:addr → OrderView[] (every status, newest first, psbt omitted) */
export async function ordersByAddress(address, signal) {
  const env = await _httpGet(`/orders/by-address/${encodeURIComponent(address)}`, signal);
  return ((env && env.orders) || []).map(_sanitizeOrderRow).filter(Boolean);
}

/**
 * POST /orders — JSON `{ psbt, ticker, amount, price_sats }` → OrderView (201).
 * 400 with a reason when the indexer rejects the listing, 409 when the
 * outpoint is spent / has a pending spend.
 */
export async function postOrder({ psbt, ticker, amount, price_sats }, signal) {
  const hexPsbt = _safeHex(psbt);
  if (!hexPsbt) throw new Error("postOrder: psbt must be hex");
  if (!_TICKER_RE.test(String(ticker || ""))) throw new Error("postOrder: invalid ticker");
  const amt = _safeInt(amount, _MAX_TOKEN_AMT);
  const price = _safeInt(price_sats, _MAX_SATS);
  if (amt === null || amt < 1) throw new Error("postOrder: invalid amount");
  if (price === null || price < 546) throw new Error("postOrder: price must be ≥ 546 sats");
  const row = await _httpPostJson("/orders", { psbt: hexPsbt, ticker, amount: amt, price_sats: price }, signal);
  const view = _sanitizeOrderRow(row);
  if (!view) throw new Error("postOrder: indexer returned a malformed OrderView");
  return view;
}

/** GET /trades?ticker&limit&offset → `{ total, offset, limit, items: TradeView[] }` newest first */
export async function trades(opts = {}, signal) {
  const env = await _httpGet(`/trades${_pageQuery(opts)}`, signal);
  return _page(env, 1e12, _sanitizeTradeRow);
}

/** GET /trades/:addr → TradeView[] where addr is buyer or seller */
export async function tradesByAddress(address, signal) {
  const env = await _httpGet(`/trades/${encodeURIComponent(address)}`, signal);
  return ((env && env.trades) || []).map(_sanitizeTradeRow).filter(Boolean);
}

// ---- Token avatars (§8) ----------------------------------------------------------------

/** GET /avatars/:addr → AvatarView[] (AVATAR txs sent by this address, audit) */
export async function avatarsByAddress(address, signal) {
  const env = await _httpGet(`/avatars/${encodeURIComponent(address)}`, signal);
  return ((env && env.avatars) || []).map(_sanitizeAvatarRow).filter(Boolean);
}

/**
 * `<img src>` for a token's avatar: `GET /tokens/:ticker/avatar` on the
 * indexer, cache-busted with `?v=<avatar_txid>` (the indexer serves
 * `ETag: "<txid>"`, and a replaced avatar changes the txid). Never fetched
 * by this module — the browser loads it as an image, so CSP img-src must
 * list the indexer origin (public/_headers). In mock mode it is a `data:`
 * URL built from the bytes the mock stores. Returns null when the ticker /
 * txid are malformed or (mock) no avatar exists.
 */
export function avatarUrl(ticker, txid) {
  if (!_TICKER_RE.test(String(ticker || ""))) return null;
  const v = _safeTxidOrNull(txid);
  if (!v) return null;
  if (MOCK) return mockAvatarDataUrl(ticker);
  return `${INDEXER_URL}/tokens/${encodeURIComponent(ticker)}/avatar?v=${v}`;
}
