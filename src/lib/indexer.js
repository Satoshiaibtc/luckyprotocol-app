// LuckyProtocol indexer adapter — HTTP only. The reference indexer's HTTP
// interface serves this app; it is not part of the protocol (PROTOCOL.md §5).
//
// Every chain-derived read goes through the indexer. There is NO
// third-party fallback: if the indexer is unreachable, reads throw and the
// UI shows the offline state. mempool.space is an explorer LINK target
// and a read-only second source: the buyer-side check of a listing's
// outpoint (src/lib/secondSource.js), plus the network tip and
// fee rates (src/lib/network.js). This module never talks to it.
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
//   GET  /txouts?o=txid:vout,…      txouts / outputValues (the node's confirmed UTXO set, ≤ 100 a request)
//   GET  /mines/:addr               minesByAddress
//   GET  /mines?limit&offset&ticker minesFeed
//   GET  /mines/by-txid/:txid       mineByTxid
//   GET  /tokens?limit&offset       tokens / allTokens (rows carry market_24h)
//   GET  /tokens/:ticker            token
//   GET  /pending-deploys/:ticker   pendingDeploys    (DEPLOYs of the ticker waiting in the node's mempool)
//   GET  /tokens/:ticker/holders    tokenHolders
//   GET  /tokens/:ticker/market     market            (?window=24h|7d)
//   GET  /tokens/:ticker/candles    candles           (?interval=1h|1d&limit)
//   GET  /transfers/:addr           transfers
//   GET  /activity?kind&address…    activity          (deploy / mine / send / trade ledger)
//   GET  /activity/daily?days       activityDaily
//   GET  /price                     price             (usd_per_btc | null)
//   GET  /tx-status/:txid           txStatus
//   GET  /block-info/:height        blockInfo
//   GET  /digits?limit&before       digits            (last hex digit of every held block hash)
//   GET  /digits?days               digitsByDays      (the same, over the last N days by header time)
//   GET  /fees                      fees              (+ incrementalrelayfee)
//   POST /broadcast                 broadcast         (text/plain raw hex)
//   POST /orders                    postOrder         (JSON, §7.4)
//   GET  /orders?ticker&status…     orders            (psbt omitted; status open|filling|all…)
//   GET  /orders/:id                order             (incl. psbt)
//   GET  /orders/:id → POST /orders renewOrder        (re-POST the same PSBT, §7.4 TTL)
//   GET  /orders/by-address/:addr   ordersByAddress
//   GET  /trades?ticker&limit…      trades
//   GET  /trades/:addr              tradesByAddress

import { mockGet, mockPostText, mockPostJson } from "./mock.js";
import { serverErrorText } from "./httpError.js";
import { RECENT_BLOCKS_LIMIT, blockStats } from "./blocks.js";
import { DAYS_DEFAULT, DAYS_MAX, DIGITS_DEFAULT, DIGITS_MAX } from "./digits.js";
import { MARKET_OPEN_DELAY } from "./finality.js";

export const DEFAULT_INDEXER_URL = "http://127.0.0.1:8765";
// `import.meta.env` is Vite's; plain Node (the sanitizer tests) has none.
const ENV = import.meta.env || {};
const MOCK = ENV.VITE_MOCK === "1";

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

const _configured = String(ENV.VITE_INDEXER_URL || "").trim();
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

async function _httpGet(path, signal, { fresh = false } = {}) {
  if (MOCK) return mockGet(path);
  const url = `${INDEXER_URL}${path}`;
  const t = _timedSignal(signal);
  // The timer runs until the body is read, not only until the headers
  // arrive: a body that stalls after its headers is aborted by the same
  // timeout (a poll that skips ticks while a call is in flight would
  // otherwise wait on it forever).
  try {
    let res;
    try {
      // `fresh`: an answer that must not come from the browser's cache (the
      // caller also varies the URL, so no shared cache answers it either).
      res = await fetch(url, fresh ? { signal: t.signal, cache: "no-store" } : { signal: t.signal });
    } catch (e) {
      if (t.timedOut()) throw new Error(`Indexer timeout after ${HTTP_TIMEOUT_MS}ms: ${url}`);
      if (signal && signal.aborted) throw e;
      throw new Error(`Indexer unreachable: ${url} — ${e.message || e}`);
    }
    if (!res.ok) {
      let text = "";
      try { text = await res.text(); } catch { /* ignore */ }
      const body = serverErrorText(text);
      const err = new Error(`Indexer ${path} -> HTTP ${res.status}${body ? `: ${body}` : ""}`);
      err.status = res.status;
      // The server's own sentence, without the path (a caller that shows it alone).
      err.detail = body;
      // Seconds the server asked us to wait when it answers "busy".
      const ra = Number(res.headers?.get?.("Retry-After"));
      if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
      throw err;
    }
    try {
      return await res.json();
    } catch (e) {
      if (t.timedOut()) throw new Error(`Indexer timeout after ${HTTP_TIMEOUT_MS}ms: ${url}`);
      throw e;
    }
  } finally {
    t.done();
  }
}

async function _httpPostText(path, body, signal, meta) {
  if (MOCK) return mockPostText(path, body, meta);
  const url = `${INDEXER_URL}${path}`;
  const t = _timedSignal(signal);
  // As in _httpGet, the timer also covers the body.
  try {
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
    }
    const text = (await _bodyText(res, t, url)).trim();
    if (!res.ok) {
      const body = serverErrorText(text);
      const err = new Error(`${path} HTTP ${res.status}${body ? `: ${body}` : ""}`);
      err.status = res.status;
      throw err;
    }
    return text;
  } finally {
    t.done();
  }
}

async function _httpPostJson(path, bodyObj, signal) {
  if (MOCK) return mockPostJson(path, bodyObj);
  const url = `${INDEXER_URL}${path}`;
  const t = _timedSignal(signal);
  // As in _httpGet, the timer also covers the body.
  try {
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
    }
    const text = (await _bodyText(res, t, url)).trim();
    if (!res.ok) {
      // The indexer answers every trading route with `{ "error": "…" }`: the
      // sentence itself is what a seller reads — no HTTP prefix, no JSON
      // punctuation, never cut mid-sentence.
      throw orderHttpError(path, res.status, text);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${path}: response is not JSON`);
    }
  } finally {
    t.done();
  }
}

/**
 * The body of a POST's answer as text ("" when it cannot be read). A read
 * cut off by the timeout is the timeout error when the status was a
 * success: an empty body there would pass for the server's answer.
 */
async function _bodyText(res, t, url) {
  try {
    return await res.text();
  } catch {
    if (res.ok && t.timedOut()) throw new Error(`Indexer timeout after ${HTTP_TIMEOUT_MS}ms: ${url}`);
    return "";
  }
}

/**
 * The Error for a refused POST (e.g. /orders): `message` is the server's
 * own sentence (`{ error }` or plain text); `status`, `path` and the raw
 * `body` ride along for callers that map a status to their own words.
 */
export function orderHttpError(path, status, text) {
  const sentence = serverErrorText(text) || `${path} refused (HTTP ${status})`;
  const err = new Error(sentence);
  err.status = status;
  err.path = path;
  err.body = String(text || "");
  return err;
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

// Unknown (null / undefined) is null — never 0: `Number(null)` is 0, which
// would turn "no expiry" into 1970 and "no pending fee" into a free fill.
const _safeInt = (v, max) => {
  if (v === null || v === undefined) return null;
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

// A unix-seconds block time. Rows written before the indexer learned block
// times carry 0, which is "unknown" — never 1970.
const _safeTime = (v) => {
  const t = _safeInt(v, 1e12);
  return t === null || t === 0 ? null : t;
};

// Finite float of either sign (percentage changes). |x| ≤ max, else null.
const _safeSignedFloat = (v, max = 1e9) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
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

// MineView (indexer API): identity fields must be well-formed; yield clamps to the
// supply cap; status is coerced to the two documented values. `confirmations`
// / `final` are the indexer's depth of the row's block at response time
// (null when it does not say): a credit is provisional until `final`.
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
    block_time: _safeTime(m.block_time),
    sender,
    status: m.status === "invalid" ? "invalid" : "settled",
    yield_smallest: y,
    cap_exhausted: m.cap_exhausted === true,
    confirmations: _safeInt(m.confirmations, 1e9),
    final: typeof m.final === "boolean" ? m.final : null,
    // the §2.2 rule an invalid MINE failed (not_deployed, deploy_same_block,
    // fee_missing, vout0_unusable), or null
    reason: m.status === "invalid" && typeof m.reason === "string" && /^[a-z0-9_]{1,40}$/.test(m.reason) ? m.reason : null,
  };
}

function _sanitizeTransferRow(t) {
  if (!t || typeof t !== "object") return null;
  if (!_TXID_RE.test(String(t.txid || ""))) return null;
  if (!_TICKER_RE.test(String(t.ticker || ""))) return null;
  const height = _safeInt(t.block_height, 1e9);
  const amount = _safeInt(t.amount, _MAX_TOKEN_AMT);
  if (height === null || amount === null || !_safeStr(t.sender, 128)) return null;
  return { ...t, txid: String(t.txid).toLowerCase(), block_height: height, block_time: _safeTime(t.block_time), amount };
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
  // `buyer` is null on the wire when vout1 has no address form
  // (§7.5) — the fill still happened and still counts, so the row stays.
  const buyer = _safeAddr(t.buyer);
  // A fill pays ≥ the ask and an ask is ≥ 546 sats (§7.1 / §7.4): a
  // cheaper "trade" is not one the indexer could have recorded.
  if (height === null || amount === null || amount < 1 || price === null || price < 546 || !seller) return null;
  return {
    txid: String(t.txid).toLowerCase(),
    block_height: height,
    block_hash: _safeHash(t.block_hash),
    block_time: _safeTime(t.block_time),
    ticker: t.ticker,
    amount,
    price_sats: price,
    // Always derived here (the indexer's own definition, §7.5): a wire
    // value that disagreed with price / amount would mis-sort the book
    // and mislabel the row.
    unit_price: price / amount,
    seller,
    buyer,
    order_id: _ORDER_ID_RE.test(String(t.order_id || "")) ? String(t.order_id).toLowerCase() : null,
    // §7.5: buyer script == seller script. Only an explicit true counts.
    self_trade: t.self_trade === true,
  };
}

// OrderView (§7.4). `psbt` is hex-only and only present on GET /orders/:id.
// `filling`: the indexer sees a spend of the listed outpoint in
// the mempool; the pending_* fields describe that spend and are null for
// every other status. `expired` (only in a seller's own by-address list): a
// listing that left the book (its time ran out, or a cap pushed it out)
// whose outpoint is still unspent — its signature can still be filled at
// its price; `carrier_sats` may be unknown (null) there.
const _ORDER_STATUS = new Set(["open", "filling", "filled", "cancelled", "expired"]);
function _sanitizeOrderRow(o) {
  if (!o || typeof o !== "object") return null;
  if (!_ORDER_ID_RE.test(String(o.id || ""))) return null;
  if (!_TICKER_RE.test(String(o.ticker || ""))) return null;
  const amount = _safeInt(o.amount, _MAX_TOKEN_AMT);
  const price = _safeInt(o.price_sats, _MAX_SATS);
  const carrier = _safeInt(o.carrier_sats, _MAX_SATS);
  const seller = _safeAddr(o.seller);
  const status = _ORDER_STATUS.has(o.status) ? o.status : null;
  if (!status) return null;
  if (amount === null || amount < 1 || price === null || price < 546 || (carrier === null && status !== "expired") || !seller) return null;
  const psbt = o.psbt !== undefined && o.psbt !== null ? _safeHex(o.psbt) : null;
  const spentTxid = _TXID_RE.test(String(o.spent_txid || "")) ? String(o.spent_txid).toLowerCase() : null;
  const filling = status === "filling";
  return {
    id: String(o.id).toLowerCase(),
    ticker: o.ticker,
    amount,
    price_sats: price,
    // Derived, never trusted from the wire (the book sorts and labels by it).
    unit_price: price / amount,
    seller,
    carrier_sats: carrier,
    status,
    created_at: _safeInt(o.created_at, 1e12),
    updated_at: _safeInt(o.updated_at, 1e12),
    expires_at: _safeInt(o.expires_at, 1e12),
    spent_txid: spentTxid,
    spent_block: _safeInt(o.spent_block, 1e9),
    buyer: _safeAddr(o.buyer),
    pending_spend_txid: filling ? _safeTxidOrNull(o.pending_spend_txid) : null,
    pending_fee_sats: filling ? _safeInt(o.pending_fee_sats, _MAX_SATS) : null,
    pending_vsize: filling ? _safeInt(o.pending_vsize, 4_000_000) : null,
    pending_feerate: filling ? _safeFloat(o.pending_feerate, 1_000_000) : null,
    // false while the ticker's market is not open yet (the book then offers
    // no fill of it); anything but an explicit false is an open market
    market_open: o.market_open !== false,
    ...(status === "expired" ? { dropped_at: _safeInt(o.dropped_at, 1e12) } : {}),
    ...(psbt ? { psbt } : {}),
    ...(o.replaced === true ? { replaced: true } : {}),
  };
}

// `/tokens` rows' 24 h market summary. Absent or malformed → null (the
// board then shows "—", never a made-up zero).
function _sanitizeMarket24h(m) {
  if (!m || typeof m !== "object") return null;
  return {
    volume_sats: _safeInt(m.volume_sats, _MAX_SATS),
    trades: _safeInt(m.trades, 1e9),
    change_pct: _safeSignedFloat(m.change_pct),
    buyers: _safeInt(m.buyers, 1e9),
  };
}

// GET /tokens/:ticker/market?window=24h|7d
const _WINDOWS = new Set(["24h", "7d"]);
function _sanitizeMarket(m) {
  if (!m || typeof m !== "object") return null;
  if (!_TICKER_RE.test(String(m.ticker || ""))) return null;
  const excluded = m.self_trades_excluded;
  return {
    ticker: m.ticker,
    window: _WINDOWS.has(m.window) ? m.window : null,
    as_of: _safeInt(m.as_of, 1e12),
    tip_height: _safeInt(m.tip_height, 1e9),
    floor_unit_price: _safeFloat(m.floor_unit_price),
    open_orders: _safeInt(m.open_orders, 1e9),
    listed_amount: _safeInt(m.listed_amount, _MAX_TOKEN_AMT),
    last_trade: m.last_trade ? _sanitizeTradeRow(m.last_trade) : null,
    trades: _safeInt(m.trades, 1e9),
    volume_sats: _safeInt(m.volume_sats, _MAX_SATS),
    buyers: _safeInt(m.buyers, 1e9),
    sellers: _safeInt(m.sellers, 1e9),
    high_unit_price: _safeFloat(m.high_unit_price),
    low_unit_price: _safeFloat(m.low_unit_price),
    first_unit_price: _safeFloat(m.first_unit_price),
    change_pct: _safeSignedFloat(m.change_pct),
    // a count, or a plain flag — either shape is shown as "self-trades excluded"
    self_trades_excluded: typeof excluded === "boolean" ? excluded : _safeInt(excluded, 1e9),
    minted_out: m.minted_out === true,
    // the market gate: minted out AND the completing block FINAL_DEPTH deep —
    // only an explicit true opens it
    market_open: m.market_open === true,
    market_opens_at_height: _safeInt(m.market_opens_at_height, 1e9),
  };
}

// One OHLC bucket. Prices are sats per whole token; a bucket whose extremes
// do not bracket its open/close is malformed and dropped.
function _sanitizeCandle(c) {
  if (!c || typeof c !== "object") return null;
  const t = _safeInt(c.t, 1e12);
  const o = _safeFloat(c.o);
  const h = _safeFloat(c.h);
  const l = _safeFloat(c.l);
  const cl = _safeFloat(c.c);
  if (t === null || o === null || h === null || l === null || cl === null) return null;
  if (l > Math.min(o, cl) || h < Math.max(o, cl)) return null;
  return {
    t,
    o,
    h,
    l,
    c: cl,
    v_sats: _safeInt(c.v_sats, _MAX_SATS) ?? 0,
    v_amount: _safeInt(c.v_amount, 1e12) ?? 0,
    n: _safeInt(c.n, 1e9) ?? 0,
  };
}

// GET /activity item. Every address-like field must be a mainnet address
// shape or it is null; the row survives on its identity (kind, txid, height).
const _ACTIVITY_KINDS = new Set(["deploy", "mine", "send", "trade"]);
function _sanitizeActivityItem(a) {
  if (!a || typeof a !== "object") return null;
  if (!_ACTIVITY_KINDS.has(a.kind)) return null;
  if (!_TXID_RE.test(String(a.txid || ""))) return null;
  if (!_TICKER_RE.test(String(a.ticker || ""))) return null;
  const height = _safeInt(a.block_height, 1e9);
  if (height === null) return null;
  return {
    kind: a.kind,
    txid: String(a.txid).toLowerCase(),
    block_height: height,
    block_time: _safeTime(a.block_time),
    ticker: a.ticker,
    // false = a SEND the indexer did not apply or an invalid MINE (amount is
    // then the requested amount / a 0 yield); anything but an explicit false is applied.
    applied: a.applied !== false,
    amount: _safeInt(a.amount, _MAX_TOKEN_AMT),
    from: _safeAddr(a.from),
    to: _safeAddr(a.to),
    sender: _safeAddr(a.sender),
    deployer: _safeAddr(a.deployer),
    buyer: _safeAddr(a.buyer),
    seller: _safeAddr(a.seller),
    price_sats: _safeInt(a.price_sats, _MAX_SATS),
    unit_price: _safeFloat(a.unit_price),
    self_trade: a.self_trade === true,
  };
}

// GET /activity/daily row: one UTC day. Counts default to 0 like the
// per-ticker stats do; a row without a well-formed date is dropped.
const _DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function _sanitizeDailyRow(d) {
  if (!d || typeof d !== "object" || !_DATE_RE.test(String(d.date || ""))) return null;
  const n = (k, max = 1e12) => _safeInt(d[k], max) ?? 0;
  return {
    date: String(d.date),
    events: n("events"),
    deploys: n("deploys"),
    mines: n("mines"),
    sends: n("sends"),
    trades: n("trades"),
    active_addresses: n("active_addresses"),
    token_amount: n("token_amount", 1e15),
    volume_sats: n("volume_sats", _MAX_SATS),
  };
}

// GET /price → `usd_per_btc` is a finite positive number or null (= unavailable).
function _sanitizePrice(p) {
  const v = p && typeof p === "object" ? Number(p.usd_per_btc) : NaN;
  return {
    usd_per_btc: Number.isFinite(v) && v > 0 && v <= 1e9 ? v : null,
    as_of: _safeInt(p && p.as_of, 1e12),
    source: _safeStr(p && p.source, 64),
  };
}

const _safeTxidOrNull = (v) => (_TXID_RE.test(String(v || "")) ? String(v).toLowerCase() : null);

function _sanitizeTokenRow(t) {
  if (!t || typeof t !== "object") return null;
  if (!_TICKER_RE.test(String(t.ticker || ""))) return null;
  if (!_TXID_RE.test(String(t.deploy_txid || ""))) return null;
  const supply = _safeInt(t.supply, _MAX_TOKEN_AMT);
  const minted = _safeInt(t.minted, _MAX_TOKEN_AMT);
  const block = _safeInt(t.deploy_block, 1e9);
  if (supply === null || minted === null || block === null) return null;
  // §2.1: a DEPLOY with no whole-transaction-signed input still registers
  // the ticker, with an EMPTY deployer (served as ""). The row must survive:
  // dropping it would show a taken ticker as free on the Create page, where
  // a DEPLOY for it is ignored and its fees are lost.
  const deployer = t.deployer === "" || t.deployer == null ? "" : _safeStr(t.deployer, 128);
  if (deployer === null) return null;
  const holders = _safeInt(t.holders, 1e9);
  const lastTrade = t.last_trade ? _sanitizeTradeRow(t.last_trade) : null;
  // Market gate: `minted_out` is the indexer's own flag (cumulative credited
  // yield reached the supply; only a chain reorganization brings it back
  // down); a row without it falls back to `minted >= supply`.
  // `minted_out_height` is the block of the MINE whose credit completed the
  // supply, or null when unknown. `market_open` is the indexer's gate: minted
  // out AND that block has FINAL_DEPTH confirmations, from
  // `market_opens_at_height` on. A row from an indexer that predates the
  // field keeps the older rule (open when minted out).
  const mintedOut = t.minted_out === true || minted >= supply;
  const mintedOutHeight = mintedOut ? _safeInt(t.minted_out_height, 1e9) : null;
  const opensAt = _safeInt(t.market_opens_at_height, 1e9);
  return {
    ticker: t.ticker,
    supply,
    minted,
    minted_out: mintedOut,
    minted_out_height: mintedOutHeight,
    market_open: mintedOut && (typeof t.market_open === "boolean" ? t.market_open : true),
    market_opens_at_height: mintedOut ? (opensAt ?? (mintedOutHeight !== null ? mintedOutHeight + MARKET_OPEN_DELAY : null)) : null,
    deployer,
    deploy_txid: String(t.deploy_txid).toLowerCase(),
    deploy_block: block,
    ...(holders !== null ? { holders } : {}),
    // per-ticker stats (indexer API); missing/malformed → 0 / null, never NaN
    mine_count: _safeInt(t.mine_count, 1e12) ?? 0,
    trade_count: _safeInt(t.trade_count, 1e12) ?? 0,
    volume_sats: _safeInt(t.volume_sats, _MAX_SATS) ?? 0,
    open_orders: _safeInt(t.open_orders, 1e9) ?? 0,
    floor_unit_price: _safeFloat(t.floor_unit_price),
    last_trade: lastTrade,
    market_24h: _sanitizeMarket24h(t.market_24h),
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
// unconfirmed tx is `seen:false` (reading every 200 as "seen" could never
// report a dropped tx). A 404 is
// `seen:false` as before. `in_mempool` is the server's own flag, or null
// when it does not provide one.
function _sanitizeTxStatus(txid, s, known = true) {
  if (!s || typeof s !== "object") {
    return { txid, confirmed: false, seen: false, in_mempool: known ? null : false, block_height: null, block_hash: null, block_time: null, confirmations: null, final: false };
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
    // the depth of the block the indexer recorded for the tx, at response
    // time (null when it does not say); `final` only when explicitly true
    confirmations: confirmed ? _safeInt(s.confirmations, 1e9) : null,
    final: confirmed && s.final === true,
  };
}

// A missing or malformed value is null — never a made-up default — and an
// absurd one (> 1e6 sat/vB) is dropped here; anything above the
// MAX_FEE_RATE_SAT_VB safety cap survives as-is so feechoice can REJECT
// it visibly ("estimate unavailable") instead of clamping.
// `ok: false` means the node could not estimate and the numbers are floors:
// they are never used — every tier is null then, like a missing one.
function _sanitizeFees(f) {
  const ok = !(f && f.ok === false);
  const pick = (k) => (ok ? _safeFloat(f && f[k], 1_000_000) : null);
  return {
    ok,
    fastestFee: pick("fastestFee"),
    halfHourFee: pick("halfHourFee"),
    hourFee: pick("hourFee"),
    economyFee: pick("economyFee"),
    minimumFee: pick("minimumFee"),
    // The node's BIP125 increment (sat/vB), used by the cancel fee rule;
    // null when the indexer does not report it (the rule then assumes 1).
    incrementalrelayfee: _safeFloat(f && f.incrementalrelayfee, 1_000_000),
  };
}

function _pageQuery(opts = {}) {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  if (opts.ticker) params.set("ticker", String(opts.ticker));
  if (opts.deployer) params.set("deployer", String(opts.deployer));
  if (opts.status) params.set("status", String(opts.status));
  if (opts.kind) params.set("kind", String(opts.kind));
  if (opts.address) params.set("address", String(opts.address));
  const q = params.toString();
  return q ? `?${q}` : "";
}

function _page(env, maxTotal, sanitize) {
  const items = ((env && env.items) || []).map(sanitize).filter(Boolean);
  return {
    // An envelope without `total` (a per-address list from an indexer that
    // predates paging) is taken as complete.
    total: _safeInt(env && env.total, maxTotal) ?? items.length,
    offset: _safeInt(env && env.offset, maxTotal) ?? 0,
    limit: _safeInt(env && env.limit, 1e6) ?? 0,
    items,
  };
}

// Per-address lists (`/mines/:addr`, `/orders/by-address/:addr`,
// `/trades/:addr`) are paged by the indexer: `limit` default 50, max 200
// (indexer API). Callers that need "everything live" ask for the max and page.
export const ADDR_LIST_MAX_LIMIT = 200;

// ---- Read API — one wrapper per route -----------------------------------------------

/** GET / — health + tip envelope. */
export async function health(signal) {
  // `/health` is an alias of `/` (indexer API); prefer it because some edge
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
    // open orders with a spend already in the mempool; 0 when the indexer predates it
    filling_order_count: _safeInt(env && env.filling_order_count, 1e9) ?? 0,
    last_progress_at: _safeInt(env && env.last_progress_at, 1e12),
    // unix s of the indexer's last completed poll of its node (null = not reported)
    last_poll_at: _safeInt(env && env.last_poll_at, 1e12),
    // the node's peer count, or null when unknown — 0 means it hears no one
    node_peers: _safeInt(env && env.node_peers, 1e6),
    // header time of the tip block (unix s), or null
    tip_time: _safeTime(env && env.tip_time),
    // a full rebuild / cold scan is running: every answer is incomplete.
    // The flag is `state_rebuilding`; an answer without it (an indexer that
    // predates it, or one not on these rules) counts as rebuilding, so
    // writes pause. The key `rebuilding` is always true, for builds that
    // pause every write on it.
    rebuilding: !(env && env.state_rebuilding === false),
    final_depth: _safeInt(env && env.final_depth, 1_000),
    // false while the order book cannot save listings (a new one is refused
    // meanwhile); absent = it can
    persist_ok: !(env && env.persist_ok === false),
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

/** Most outpoints one GET /txouts request may name; longer lists are asked in chunks of this size. */
export const TXOUTS_MAX = 100;
/** Retries of a chunk the server answered "busy" (a 503 with a short Retry-After, or a 429). */
export const TXOUTS_RETRIES = 2;
const TXOUTS_RETRY_MAX_SECS = 5;
/** A 429's Retry-After is the rest of the server's 10 s per-client window: waited out up to this long. */
const TXOUTS_BUDGET_WAIT_MAX_SECS = 10;
const _OUTPOINT_RE = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/;

/** "txid:vout" keys (lower-case) of `outpoints` (`{ txid, vout }` rows or "txid:vout" strings), distinct, in order; malformed ones dropped. */
export function outpointKeys(outpoints) {
  const out = [];
  const seen = new Set();
  for (const o of outpoints || []) {
    const k = typeof o === "string" ? o.toLowerCase() : `${String(o?.txid || "").toLowerCase()}:${Number(o?.vout)}`;
    const m = _OUTPOINT_RE.exec(k);
    if (!m || Number(m[2]) > 0xffffffff || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// One /txouts row. `unspent` only when the server says exactly true; the
// value, script and address only on an unspent row; `confirmations` 0
// when missing; `tokens` only on a token carrier.
function _sanitizeTxout(r) {
  if (!r || typeof r !== "object" || !_TXID_RE.test(String(r.txid || ""))) return null;
  const vout = _safeInt(r.vout, 0xffffffff);
  if (vout === null) return null;
  const unspent = r.unspent === true;
  const carrier = r.token_carrier === true;
  const tokens = carrier ? _sanitizeBalances(r.tokens) : null;
  return {
    txid: String(r.txid).toLowerCase(),
    vout,
    unspent,
    sats: unspent ? _safeInt(r.sats, _MAX_SATS) : null,
    script_hex: unspent ? _safeHex(r.script_hex, 20_000) : null,
    address: unspent ? _safeAddr(r.address) : null,
    confirmations: unspent ? (_safeInt(r.confirmations, 1e9) ?? 0) : 0,
    coinbase: unspent && r.coinbase === true,
    token_carrier: carrier,
    tokens: tokens && Object.keys(tokens).length ? tokens : null,
  };
}

/** A failed /txouts read as one plain sentence (the server's own when it gave one); `status` / `retryAfter` ride along. */
function _txoutsError(e) {
  if (e && e.name === "AbortError") return e;
  const detail = String(e?.detail || "").trim();
  const text = detail || (e?.status ? `HTTP ${e.status}` : /timeout/i.test(String(e?.message || "")) ? "no answer in time" : "the indexer could not be reached");
  return Object.assign(new Error(text), { status: e?.status ?? null, retryAfter: e?.retryAfter ?? null, cause: e });
}

/** `ms`, cut short when `signal` aborts. */
function _sleepUnlessAborted(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * GET /txouts?o=… → one row per distinct outpoint of `outpoints`, in their
 * order: `{ txid, vout, unspent, sats, script_hex, address, confirmations,
 * coinbase, token_carrier, tokens }` — the node's CONFIRMED UTXO set (an
 * output a mempool tx spends is still `unspent`; one a mempool tx creates
 * is not) with the indexer's token state. Asked TXOUTS_MAX outpoints a
 * request, one request after another. An answer that does not cover every
 * outpoint it was asked about is an error, never a shorter list. A chunk
 * the server answers 503 with a short Retry-After, or 429 (the per-client
 * budget, whose window is at most 10 s), is asked again up to
 * TXOUTS_RETRIES times after that wait, so a long list is paced across
 * windows instead of failing. Throws one plain sentence (with `status`,
 * `retryAfter`); a stopped read (`signal`) throws its AbortError.
 */
export async function txouts(outpoints, signal) {
  const keys = outpointKeys(outpoints);
  const rows = [];
  for (let i = 0; i < keys.length; i += TXOUTS_MAX) {
    const chunk = keys.slice(i, i + TXOUTS_MAX);
    let env;
    for (let attempt = 0; ; attempt++) {
      try {
        env = await _httpGet(`/txouts?o=${chunk.join(",")}`, signal, { fresh: true });
        break;
      } catch (e) {
        if (signal && signal.aborted) throw e;
        const busy = !!e && (e.status === 503 || e.status === 429);
        const wait = Number(e?.retryAfter) || 1;
        const cap = e?.status === 429 ? TXOUTS_BUDGET_WAIT_MAX_SECS : TXOUTS_RETRY_MAX_SECS;
        if (!busy || attempt >= TXOUTS_RETRIES || wait > cap) throw _txoutsError(e);
        await _sleepUnlessAborted(wait * 1000, signal);
        if (signal && signal.aborted) throw e;
      }
    }
    if (!Array.isArray(env)) throw new Error("the indexer's answer about these outputs is unreadable");
    const byKey = new Map();
    for (const r of env.map(_sanitizeTxout).filter(Boolean)) byKey.set(`${r.txid}:${r.vout}`, r);
    for (const k of chunk) {
      const r = byKey.get(k);
      if (!r) throw new Error("the indexer's answer about these outputs is incomplete");
      rows.push(r);
    }
  }
  return rows;
}

// An outpoint's value never changes: once read, it is kept for the page's life.
const _valueCache = new Map();
const _VALUE_CACHE_MAX = 50_000;

/**
 * The BTC value of each outpoint of `outpoints` the node has unspent
 * (GET /txouts, asked only for outpoints whose value this page has not
 * read before) → `[{ txid, vout, sats }]` in their order; outpoints without
 * a known value are left out. Used for token carriers, whose exact value a
 * SEND signs.
 */
export async function outputValues(outpoints, signal) {
  const keys = outpointKeys(outpoints);
  const missing = keys.filter((k) => !_valueCache.has(k));
  if (missing.length) {
    if (_valueCache.size + missing.length > _VALUE_CACHE_MAX) _valueCache.clear();
    // Chunk by chunk: a failed or stopped read keeps what it already read,
    // and the next call asks only for the rest.
    for (let i = 0; i < missing.length; i += TXOUTS_MAX) {
      const rows = await txouts(missing.slice(i, i + TXOUTS_MAX), signal);
      for (const r of rows) if (r.unspent && Number.isInteger(r.sats)) _valueCache.set(`${r.txid}:${r.vout}`, r.sats);
    }
  }
  return keys
    .filter((k) => _valueCache.has(k))
    .map((k) => {
      const [txid, vout] = k.split(":");
      return { txid, vout: Number(vout), sats: _valueCache.get(k) };
    });
}

/** GET /mines/:addr → MineView[] (sender == addr, newest first) */
/**
 * GET /mines/:addr?limit&offset → `{ total, offset, limit, items }`. Paged by
 * the indexer (default 50, max ADDR_LIST_MAX_LIMIT, indexer API): `total` is
 * the address's full count — a caller that shows one page must not present
 * it as the whole record.
 */
export async function minesByAddress(address, opts = {}, signal) {
  const env = await _httpGet(`/mines/${encodeURIComponent(address)}${_pageQuery({ limit: opts.limit, offset: opts.offset })}`, signal);
  return _page({ ...(env || {}), items: env && env.mines }, 1e12, _sanitizeMineRow);
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

/**
 * The whole registry: every `/tokens` page (TOKENS_PAGE rows each, oldest
 * deploy first) until `total` is reached, at most TOKENS_MAX_PAGES. →
 * `{ total, offset: 0, limit, items, complete }` — `complete: false` when
 * the page cap was hit or a page came back short (a token the page does
 * not list may still exist: ask `token(ticker)` before calling it free).
 */
export const TOKENS_PAGE = 500;
export const TOKENS_MAX_PAGES = 20;
export async function allTokens(signal, { pageSize = TOKENS_PAGE, maxPages = TOKENS_MAX_PAGES } = {}) {
  const items = [];
  const seen = new Set();
  let total = 0;
  let complete = false;
  for (let n = 0, offset = 0; n < maxPages; n++) {
    const pg = await tokens({ limit: pageSize, offset }, signal);
    for (const t of pg.items) {
      if (!seen.has(t.ticker)) {
        seen.add(t.ticker);
        items.push(t);
      }
    }
    total = pg.total;
    const served = pg.limit > 0 ? Math.min(pg.limit, pageSize) : pageSize;
    offset += served;
    if (offset >= total) {
      complete = items.length >= total;
      break;
    }
    if (pg.items.length === 0) break;
  }
  return { total: Math.max(total, items.length), offset: 0, limit: pageSize, items, complete };
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

/**
 * GET /tokens/:ticker → registry entry (+ holders) | null (404 only).
 * A 200 whose row fails sanitization THROWS: the ticker
 * exists but its row is unreadable — "unknown", never "free", or the Create
 * page would offer a DEPLOY that the indexer ignores (fees lost).
 */
export async function token(ticker, signal) {
  let row;
  try {
    row = await _httpGet(`/tokens/${encodeURIComponent(ticker)}`, signal);
  } catch (e) {
    if (_is404(e)) return null;
    throw e;
  }
  const clean = _sanitizeTokenRow(row);
  if (!clean) throw new Error(`the indexer returned an unreadable registry row for ${ticker}`);
  return clean;
}

// A DEPLOY's vsize is a few hundred vB; anything past the largest standard
// transaction is not a DEPLOY row the page can use.
const _MAX_TX_VSIZE = 400_000;

// One /pending-deploys row. `package_fee_rate` is the rate the node mines
// the transaction at; it may be above `fee_rate` (a child pays for it) or
// below (it waits on an unconfirmed parent that pays less). An answer
// without it reads as `fee_rate`.
function _sanitizePendingDeployRow(r) {
  if (!r || typeof r !== "object") return null;
  if (!_TXID_RE.test(String(r.txid || ""))) return null;
  const feeRate = _safeFloat(r.fee_rate, 1_000_000);
  if (feeRate === null) return null;
  const pkg = _safeFloat(r.package_fee_rate, 1_000_000);
  return {
    txid: String(r.txid).toLowerCase(),
    fee_rate: feeRate,
    fee_sats: _safeInt(r.fee_sats, _MAX_SATS),
    vsize: _safeInt(r.vsize, _MAX_TX_VSIZE),
    first_seen: _safeTime(r.first_seen),
    package_fee_rate: pkg !== null && pkg > 0 ? pkg : feeRate,
  };
}

/**
 * The /pending-deploys answer for `ticker` → `{ ticker, registered, pending, as_of, watching }`,
 * `pending` sorted by `fee_rate` (highest first). An answer about another
 * ticker, or without a `pending` list, THROWS (unreadable, never "none").
 */
function _sanitizePendingDeploys(env, ticker) {
  if (!env || typeof env !== "object" || env.ticker !== ticker || !Array.isArray(env.pending)) {
    throw new Error(`the indexer returned an unreadable list of pending DEPLOYs for ${ticker}`);
  }
  const registered = env.registered === true;
  const pending = registered ? [] : env.pending.map(_sanitizePendingDeployRow).filter(Boolean);
  pending.sort((a, b) => b.fee_rate - a.fee_rate || (a.first_seen ?? 0) - (b.first_seen ?? 0) || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0));
  return { ticker, registered, pending, as_of: _safeTime(env.as_of), watching: env.watching === true };
}

/**
 * GET /pending-deploys/:ticker → the DEPLOYs of `ticker` waiting in the
 * node's mempool: `{ ticker, registered, pending: [{ txid, fee_rate, fee_sats, vsize, first_seen, package_fee_rate }], as_of, watching }`.
 * `fresh`: bypass every cache (the route answers with max-age=5 and ignores
 * the query parameter that varies the URL) — the read made when the user
 * clicks Create. Any failure throws; the caller treats it as "not known".
 */
export async function pendingDeploys(ticker, signal, { fresh = false } = {}) {
  const bust = fresh ? `?t=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : "";
  const env = await _httpGet(`/pending-deploys/${encodeURIComponent(ticker)}${bust}`, signal, { fresh });
  return _sanitizePendingDeploys(env, ticker);
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
export async function txStatus(txid, signal, { fresh = false } = {}) {
  try {
    // `fresh`: bypass every cache — a "not seen yet" answer cached a few
    // seconds earlier must not decide whether a broadcast reached the node.
    const bust = fresh ? `?fresh=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : "";
    const s = await _httpGet(`/tx-status/${encodeURIComponent(txid)}${bust}`, signal, { fresh });
    return _sanitizeTxStatus(txid, s, true);
  } catch (e) {
    if (_is404(e)) return _sanitizeTxStatus(txid, null, false);
    throw e;
  }
}

/**
 * GET /blocks/recent?limit=RECENT_BLOCKS_LIMIT → blocks with hash, time,
 * weight and tx_count, newest first (indexer API). One request replaces N
 * /block-info reads for the block tape. Always the same limit, whatever
 * the screen: every visitor asks the same URL, so one cached answer serves
 * them all, and the tape keeps the heights it shows. Returns null when the
 * indexer predates the route (404).
 */
export async function recentBlocks(signal) {
  const n = RECENT_BLOCKS_LIMIT;
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
    blocks.push({ height, hash, time: _safeInt(r?.time, 1e12), ...blockStats(r) });
  }
  return { tip_height: _safeInt(env && env.tip_height, 1e9), blocks };
}

/** GET /block-info/:height → metadata or null (past tip). */
export async function blockInfo(height, signal) {
  try {
    const env = await _httpGet(`/block-info/${Number(height)}`, signal);
    const hash = _safeHash(env && (env.hash || env.block_hash));
    if (!hash) return null;
    return {
      height: _safeInt(env && env.height, 1e9) ?? Number(height),
      hash,
      time: _safeInt(env && (env.time ?? env.timestamp), 1e12),
      ...blockStats(env),
    };
  } catch (e) {
    if (_is404(e)) return null;
    throw e;
  }
}

const _DIGITS_RE = /^[0-9a-f]*$/;
const _emptyDigits = (tip) => ({ tip_height: tip, from: tip === null ? null : tip + 1, to: tip, digits: "" });

/**
 * `{ tip_height, from, to, digits }` — digits[i] is the last hex character
 * of the block hash at height from + i. Anything inconsistent (non-hex,
 * longer than asked, from/to not matching the length, past the tip) is an
 * EMPTY record — never a trimmed or patched one. `from = to + 1` encodes
 * "empty", as the indexer itself does.
 */
function _sanitizeDigits(env, limit) {
  return _digitsRecord(env, limit) ?? _emptyDigits(_safeInt(env && env.tip_height, 1e9));
}

// The consistent record, or null when anything is off (see _sanitizeDigits).
function _digitsRecord(env, limit) {
  const tip = _safeInt(env && env.tip_height, 1e9);
  const from = _safeInt(env && env.from, 1e9 + 1);
  const to = _safeInt(env && env.to, 1e9);
  const raw = env && typeof env.digits === "string" ? env.digits.toLowerCase() : null;
  if (tip === null || from === null || to === null || raw === null) return null;
  if (raw.length > limit || !_DIGITS_RE.test(raw)) return null;
  if (to !== from + raw.length - 1 || to > tip) return null;
  return { tip_height: tip, from, to, digits: raw };
}

/**
 * The day-window record: `_sanitizeDigits` (capped at DIGITS_MAX heights)
 * plus `since`, `complete` and `status`, which says what the answer is:
 *  - "ok": a day window — the digit checks pass, `since` is an integer ≥ 0
 *    (unix seconds) and `complete` a boolean (true: the indexer found the
 *    window's lower edge; false: its log ran out first, older blocks are
 *    still being filled);
 *  - "unsupported": a consistent /digits body carrying neither `since` nor
 *    `complete` — an indexer from before day windows ignored `days` and
 *    answered its block-count default, which is NOT the asked window;
 *  - "invalid": anything else (digit checks fail, `since` / `complete`
 *    malformed, or only one of them present).
 * Only "ok" carries digits; the other two are the empty record with
 * `since: null` and `complete: null` — nothing on them vouches for any
 * window, so the page never reads them as history still loading.
 */
function _sanitizeDigitsByDays(env) {
  const rec = _digitsRecord(env, DIGITS_MAX);
  const empty = (status) => ({ ..._emptyDigits(_safeInt(env && env.tip_height, 1e9)), since: null, complete: null, status });
  if (!rec) return empty("invalid");
  const absent = (v) => v === undefined || v === null;
  if (absent(env.since) && absent(env.complete)) return empty("unsupported");
  const since = _safeInt(env.since, 1e12);
  if (since === null || typeof env.complete !== "boolean") return empty("invalid");
  return { ...rec, since, complete: env.complete, status: "ok" };
}

/**
 * GET /digits?limit=N&before=H → the last hex digit of every block hash the
 * indexer holds in [to − N + 1, to], oldest first, where to = min(before,
 * tip). Heights the indexer does not hold are dropped from the low end, so
 * `digits.length` may be shorter than `limit` — never padded.
 */
export async function digits(limit = DIGITS_DEFAULT, before = null, signal) {
  const n = Math.min(DIGITS_MAX, Math.max(1, Math.floor(Number(limit) || DIGITS_DEFAULT)));
  const b = _safeInt(before, 1e9);
  const env = await _httpGet(`/digits?limit=${n}${b !== null ? `&before=${b}` : ""}`, signal);
  return _sanitizeDigits(env, n);
}

/**
 * GET /digits?days=N → the last hex digit of every held block whose header
 * time is within the last N days (N clamped to 1..=DAYS_MAX), oldest first:
 * `{ tip_height, from, to, digits, since, complete, status }`. The window is
 * by real time — blocks per day are not fixed, so its length varies. The
 * indexer walks down from its newest held height and stops at the first
 * header older than `since`, so the range is contiguous. On `status: "ok"`,
 * `complete: false` means the log ran out before that edge (older blocks
 * are still being filled); see `_sanitizeDigitsByDays` for the others.
 */
export async function digitsByDays(days = DAYS_DEFAULT, signal) {
  const n = days === null || days === undefined || days === "" ? NaN : Math.floor(Number(days));
  const d = Number.isFinite(n) ? Math.min(DAYS_MAX, Math.max(1, n)) : DAYS_DEFAULT;
  const env = await _httpGet(`/digits?days=${d}`, signal);
  return _sanitizeDigitsByDays(env);
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

/**
 * GET /orders/by-address/:addr?limit&offset → `{ total, offset, limit,
 * items: OrderView[], expired: OrderView[], expiredTotal }` (every status,
 * newest first by created_at, psbt omitted). Paged like every per-address
 * list: `limit` default 50, max 200 — pass `{ limit, offset }`; `total`
 * says how many rows exist.
 *
 * `expired` = the address's listings that left the book (their time ran
 * out, or a cap pushed them out) while their outpoint is still unspent:
 * their signature still fills at `price_sats` until the seller withdraws.
 * The indexer sends all of them with every page, outside the paging and
 * outside `total` (`expiredTotal` counts them), so they are kept apart from
 * `items` — an offset walk over `items` stays exact. Each row has status
 * "expired"; its `carrier_sats` may be null (unknown).
 */
export async function ordersByAddress(address, opts = {}, signal) {
  const env = await _httpGet(`/orders/by-address/${encodeURIComponent(address)}${_pageQuery({ limit: opts.limit, offset: opts.offset })}`, signal);
  const page = _page({ ...(env || {}), items: env && env.orders }, 1e9, _sanitizeOrderRow);
  const expired = [];
  const seen = new Set();
  for (const raw of env && Array.isArray(env.expired) ? env.expired : []) {
    const row = _sanitizeOrderRow(raw && typeof raw === "object" ? { ...raw, status: "expired" } : raw);
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      expired.push(row);
    }
  }
  return { ...page, expired, expiredTotal: _safeInt(env && env.expired_total, 1e9) ?? expired.length };
}

/**
 * POST /orders — JSON `{ psbt, ticker, amount, price_sats }` → OrderView (201).
 * 400 with a reason when the indexer rejects the listing, 409 when the
 * outpoint is spent / has a pending spend, or when the ticker's market is
 * not open yet (`{ "error": "market opens when TICKER is fully minted …" }`
 * — not minted out — or `{ "error": "market opens at block N" }` — minted
 * out, but the block that completed the supply is not FINAL_DEPTH deep).
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

/** GET /trades/:addr?limit&offset → `{ total, offset, limit, items: TradeView[] }` where addr is buyer or seller (paged, newest first) */
export async function tradesByAddress(address, opts = {}, signal) {
  const env = await _httpGet(`/trades/${encodeURIComponent(address)}${_pageQuery({ limit: opts.limit, offset: opts.offset })}`, signal);
  return _page({ ...(env || {}), items: env && env.trades }, 1e12, _sanitizeTradeRow);
}

/** Renew of a listing that already left the book: what its signature still means and what to do. */
export const RENEW_OFF_BOOK_TEXT =
  "This listing has left the order book, so it cannot be renewed — but its signature is still valid: anyone who saved it can still complete it at its price. Withdraw it (a transfer to yourself) to void that signature, or sign a new listing at the same or a lower price.";

/**
 * Renew a listing (§7.4 TTL): GET /orders/:id for the stored PSBT, then
 * POST /orders with exactly the same body. The seller signs nothing — the
 * PSBT is the same bearer instrument, the indexer just refreshes
 * `updated_at` / `expires_at`. Throws when the order is gone or closed.
 */
export async function renewOrder(id, signal) {
  const o = await order(id, signal);
  if (!o || o.status === "expired") throw new Error(RENEW_OFF_BOOK_TEXT);
  if (o.status === "filling") throw new Error("a fill of this listing is pending in the mempool — it is exempt from expiry and cannot be re-published until that spend confirms or drops (§7.3)");
  // (never "cancelled" in the text: friendlyError reads "cancel" as a declined signature)
  if (o.status === "cancelled") throw new Error("listing was withdrawn on-chain — nothing to renew");
  if (o.status === "filled") throw new Error("listing was filled — nothing to renew");
  if (o.status !== "open") throw new Error(`listing is ${o.status} — nothing to renew`);
  if (!o.psbt) throw new Error("the indexer returned the order without its PSBT");
  return postOrder({ psbt: o.psbt, ticker: o.ticker, amount: o.amount, price_sats: o.price_sats }, signal);
}

// ---- Market data ----------------------------------------------------------------------

/** GET /tokens/:ticker/market?window=24h|7d → market summary | null (404). */
export async function market(ticker, window = "24h", signal) {
  const w = _WINDOWS.has(window) ? window : "24h";
  try {
    const row = await _httpGet(`/tokens/${encodeURIComponent(ticker)}/market?window=${w}`, signal);
    return _sanitizeMarket(row);
  } catch (e) {
    if (_is404(e)) return null;
    throw e;
  }
}

const _INTERVALS = new Set(["1h", "1d"]);

/** GET /tokens/:ticker/candles?interval=1h|1d&limit → `{ ticker, interval, candles }` ascending, or null (404). */
export async function candles(ticker, { interval = "1h", limit = 168 } = {}, signal) {
  const iv = _INTERVALS.has(interval) ? interval : "1h";
  const n = Math.min(1000, Math.max(1, Number(limit) || 168));
  let env;
  try {
    env = await _httpGet(`/tokens/${encodeURIComponent(ticker)}/candles?interval=${iv}&limit=${n}`, signal);
  } catch (e) {
    if (_is404(e)) return null;
    throw e;
  }
  const rows = ((env && env.candles) || []).map(_sanitizeCandle).filter(Boolean);
  // Ascending by bucket start, one bucket per timestamp — whatever the wire order.
  rows.sort((a, b) => a.t - b.t);
  return {
    ticker: _TICKER_RE.test(String(env && env.ticker)) ? env.ticker : ticker,
    interval: _INTERVALS.has(env && env.interval) ? env.interval : iv,
    candles: rows.filter((c, i) => i === 0 || c.t !== rows[i - 1].t),
  };
}

const _ACTIVITY_FILTER = new Set(["all", "deploy", "mine", "send", "trade"]);

/** GET /activity?limit&offset&kind&address → `{ total, offset, limit, items }` newest first. */
export async function activity(opts = {}, signal) {
  const q = { limit: opts.limit, offset: opts.offset };
  if (opts.kind && opts.kind !== "all" && _ACTIVITY_FILTER.has(opts.kind)) q.kind = opts.kind;
  if (opts.address) {
    // Never drop a filter silently: an unfiltered ledger shown under a
    // "Showing rows where … is a party" notice is the whole network's.
    // Callers lower-case a bech32 address first.
    const a = String(opts.address);
    if (!_ADDR_RE.test(a)) throw new Error(`"${a}" is not a mainnet address the ledger can be filtered by`);
    q.address = a;
  }
  const env = await _httpGet(`/activity${_pageQuery(q)}`, signal);
  return _page(env, 1e12, _sanitizeActivityItem);
}

/** GET /activity/daily?days=N → `{ days: [...] }` ascending by date, at most N rows. */
export async function activityDaily(days = 30, signal) {
  const n = Math.min(365, Math.max(1, Number(days) || 30));
  const env = await _httpGet(`/activity/daily?days=${n}`, signal);
  const rows = ((env && env.days) || []).map(_sanitizeDailyRow).filter(Boolean);
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { days: rows.slice(-n) };
}

/** GET /price → `{ usd_per_btc: number|null, as_of, source }` — null means "no USD anywhere in the UI". */
export async function price(signal) {
  return _sanitizePrice(await _httpGet("/price", signal));
}

// Exposed for test/views.test.js (plain Node) — not part of the read API.
export {
  _sanitizeOrderRow,
  _sanitizeTradeRow,
  _sanitizeTokenRow,
  _sanitizeFees,
  _sanitizeMarket,
  _sanitizeMarket24h,
  _sanitizeCandle,
  _sanitizeActivityItem,
  _sanitizeDailyRow,
  _sanitizePrice,
  _sanitizeDigits,
  _sanitizeDigitsByDays,
  _sanitizeMineRow,
  _sanitizeTxStatus,
  _sanitizePendingDeploys,
};
