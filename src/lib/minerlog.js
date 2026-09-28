// MINE // LOG line model — pure, no React, unit-tested in plain Node.
//
// Every line is a REAL event the app observed; nothing here is invented
// (no hashrate, no threads — the user does not hash anything). A line is
//   { key, ts, kind, text, tier, yours, hash?, pre?, post?, lit?, sum? }
// kind ∈ sys | act | ok | block | tier | err; tier ∈ 100 | 200 | 500 |
// 1000 | null and always derives from src/lib/yield.js. Keys are
// deterministic per event so StrictMode's double-invoked effects and
// re-renders are idempotent (appendLine drops a key it already holds).

import { DIGIT_SPACE, bucketOf, bucketOfHash, bucketOfYield, yieldDigit } from "./yield.js";
import { fmtInt, fmtMintedPct, shortAddr, shortTxid } from "./format.js";
import { MAX_BLOCK_WEIGHT } from "./blocks.js";

export const MAX_LINES = 200;

/**
 * Immutable append. Drops the oldest beyond MAX_LINES. A line whose key is
 * already in the buffer is ignored — unless `replace` (swap in place, keeps
 * the slot: filling in txs/weight on a line that is already there) or
 * `move` (drop the old slot and re-append at the tail: the plain "block
 * found" line becomes the lit one right before the digit and banner lines,
 * so timestamps stay in order even when feed or heartbeat lines landed in
 * between) is set.
 */
export function appendLine(lines, line, { replace = false, move = false } = {}) {
  if (!line || typeof line.key !== "string") return lines;
  const at = lines.findIndex((l) => l.key === line.key);
  if (at >= 0) {
    if (move) {
      const rest = lines.filter((l) => l.key !== line.key);
      rest.push(line);
      return rest;
    }
    if (!replace) return lines;
    const next = lines.slice();
    next[at] = line;
    return next;
  }
  const next = lines.length >= MAX_LINES ? lines.slice(lines.length - MAX_LINES + 1) : lines.slice();
  next.push(line);
  return next;
}

/** Local "hh:mm:ss" for a Date.now() value. */
export function formatTime(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Split a hash so the last character can be enlarged. */
export function hashLine(hash) {
  const h = typeof hash === "string" ? hash : "";
  return { head: h.slice(0, -1), last: h.slice(-1) };
}

/** Block fullness as "99.9" (one decimal) or null when the weight is unknown. */
export function weightPct(weight) {
  const w = Number(weight);
  if (!Number.isSafeInteger(w) || w <= 0 || w > MAX_BLOCK_WEIGHT) return null;
  return ((100 * w) / MAX_BLOCK_WEIGHT).toFixed(1);
}

const line = ({ key, kind, text, tier = null, yours = false, ts = Date.now(), ...rest }) => ({
  key,
  ts,
  kind,
  text,
  tier,
  yours,
  ...rest,
});

const tierOfHash = (hash) => bucketOfHash(hash)?.yield ?? null;
const tierOfYield = (y) => bucketOfYield(Number(y))?.yield ?? null;
const secondBucket = (ms) => Math.floor(Number(ms) / 1000);

// ---- formatters (one per grammar line) ---------------------------------------------------------

/** `wallet connected  bc1p…62s (UniSat)` / `wallet disconnected`. */
export function walletLine(wallet, at = Date.now()) {
  if (wallet && wallet.status === "connected" && wallet.address) {
    const floor = wallet.assetSafe === false ? " · no asset-aware UTXO list: 10,000-sat floor applies" : "";
    return line({
      key: `wallet:connected:${wallet.address}:${secondBucket(at)}`,
      kind: "sys",
      text: `wallet connected  ${shortAddr(wallet.address, 4, 3)}${wallet.providerName ? ` (${wallet.providerName})` : ""}${floor}`,
      ts: at,
    });
  }
  return line({ key: `wallet:disconnected:${secondBucket(at)}`, kind: "sys", text: "wallet disconnected", ts: at });
}

const FEE_ORDER = [
  ["fast", "fastestFee"],
  ["normal", "halfHourFee"],
  ["slow", "hourFee"],
  ["economy", "economyFee"],
];

/** `fee quote  fast 2.38 · normal 1.5 · slow 1.25 · economy 1.02 sat/vB` — key = the values, so a repeat quote is deduped. */
export function feeQuoteLine(fees, at = Date.now()) {
  const parts = FEE_ORDER.filter(([, k]) => fees && Number.isFinite(Number(fees[k])) && fees[k] !== null).map(([name, k]) => `${name} ${Number(fees[k])}`);
  if (parts.length === 0) return null;
  return line({ key: `fees:${parts.join("|")}`, kind: "sys", text: `fee quote  ${parts.join(" · ")} sat/vB`, ts: at });
}

/** `tip #968,661  ·  LUCKY minted 3.2%` */
export function tipLine(tip, ticker, tokenInfo, at = Date.now()) {
  const height = tip && Number.isInteger(tip.height) ? tip.height : null;
  if (height === null) return null;
  let minted = "";
  if (tokenInfo && Number(tokenInfo.supply) > 0) {
    // Rounded down: never "100%" while mining is still open (audit mine-6).
    minted = `  ·  ${ticker} minted ${fmtMintedPct(Number(tokenInfo.minted || 0), Number(tokenInfo.supply), 1).replace(/\.0%$/, "%")}`;
  }
  return line({ key: `tip:${ticker}:${height}`, kind: "sys", text: `tip #${fmtInt(height)}${minted}`, ts: at });
}

/** `build MINE LUCKY  inputs 2  vsize 214 vB  fee 321 sats @ 1.5 sat/vB` (vsize omitted when the builder gave none). */
export function buildLine(mine, ticker, at = Date.now()) {
  const inputs = mine.inputCount != null ? `  inputs ${fmtInt(mine.inputCount)}` : "";
  const vsize = mine.vsize != null ? `  vsize ${fmtInt(mine.vsize)} vB` : "";
  const fee = mine.feeSats != null ? `  fee ${fmtInt(mine.feeSats)} sats${mine.feeRateSatVb ? ` @ ${mine.feeRateSatVb} sat/vB` : ""}` : "";
  return line({ key: `phase:build:${mine.startedAt ?? mine.txid ?? secondBucket(at)}`, kind: "act", text: `build MINE ${ticker}${inputs}${vsize}${fee}`, ts: at });
}

/** `sign  waiting for UniSat…` */
export function signLine(providerName, startedAt, at = Date.now()) {
  return line({ key: `phase:signing:${startedAt ?? secondBucket(at)}`, kind: "act", text: `sign  waiting for ${providerName || "your wallet"}…`, ts: at });
}

/** `signed · broadcasting…` */
export function broadcastingLine(startedAt, at = Date.now()) {
  return line({ key: `phase:broadcasting:${startedAt ?? secondBucket(at)}`, kind: "act", text: "signed · broadcasting…", ts: at });
}

/** `broadcast accepted by node  txid a3f9c…21e` */
export function acceptedLine(txid, at = Date.now()) {
  return line({ key: `accepted:${txid}`, kind: "ok", text: `broadcast accepted by node  txid ${shortTxid(txid, 5, 3)}`, ts: at });
}

/**
 * `mempool  1 mine awaiting block #968,662` — or, while earlier MINEs of
 * this console are still waiting too (concurrent MINEs, decision F),
 * `mempool  3 of your mines awaiting block #968,662`.
 */
export function mempoolLine(nextHeight, txid, at = Date.now(), { count = 1 } = {}) {
  const h = Number.isInteger(nextHeight) ? ` #${fmtInt(nextHeight)}` : "";
  const n = Number.isInteger(count) && count > 1 ? `${fmtInt(count)} of your mines` : "1 mine";
  return line({ key: `mempool:${txid ?? nextHeight}`, kind: "act", text: `mempool  ${n} awaiting block${h}`, ts: at });
}

/** `awaiting block #968,662  ·  4:16 since last block  ·  16 possible digits` (one per minute while pending). */
export function heartbeatLine(nextHeight, sinceMs, at = Date.now()) {
  let since = "";
  if (Number.isFinite(sinceMs)) {
    const s = Math.max(0, Math.floor(sinceMs / 1000));
    since = `  ·  ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} since last block`;
  }
  const h = Number.isInteger(nextHeight) ? ` #${fmtInt(nextHeight)}` : "";
  return line({
    key: `hb:${nextHeight}:${Math.floor(Number(at) / 60_000)}`,
    kind: "sys",
    text: `awaiting block${h}${since}  ·  ${DIGIT_SPACE} possible digits`,
    ts: at,
  });
}

/**
 * Another miner's settlement for this ticker (indexer /mines row):
 *   `SATS mine settled  digit 1 → yield 100  block 968,661  (bc1q…9k2)`
 *   invalid       → `SATS invalid mine  block h  (addr)` in err colour
 *   cap_exhausted → `… digit d → yield 0 (supply exhausted)  block h  (addr)`
 */
export function settlementLine(row, ticker, at = Date.now()) {
  if (!row || !row.txid) return null;
  const tk = row.ticker || ticker;
  const who = row.sender ? `  (${shortAddr(row.sender, 4, 3)})` : "";
  const block = `  block ${fmtInt(row.block_height)}`;
  if (row.status === "invalid") {
    return line({ key: `settle:${row.txid}`, kind: "err", text: `${tk} invalid mine${block}${who}`, ts: at });
  }
  const d = yieldDigit(row.block_hash);
  const digit = d ? `  digit ${d} → ` : "  ";
  const y = row.cap_exhausted ? "yield 0 (supply exhausted)" : `yield ${fmtInt(row.yield_smallest)}`;
  const tier = tierOfHash(row.block_hash) ?? (row.cap_exhausted ? null : tierOfYield(row.yield_smallest));
  return line({ key: `settle:${row.txid}`, kind: "tier", tier, text: `${tk} mine settled${digit}${y}${block}${who}`, ts: at });
}

/**
 * `block 968,662 found  hash <64 hex>  txs 3,412  weight 99.9%`
 * `hash` / `pre` / `post` let the terminal wrap the hash in a mono span
 * with the last character enlarged when `lit` (the user's confirming block).
 */
export function blockFoundLine(block, { lit = false, at = Date.now() } = {}) {
  if (!block || !Number.isInteger(block.height)) return null;
  const hash = typeof block.hash === "string" ? block.hash.toLowerCase() : "";
  const txs = block.tx_count != null ? `  txs ${fmtInt(block.tx_count)}` : "";
  const w = weightPct(block.weight);
  const weight = w !== null ? `  weight ${w}%` : "";
  const pre = `block ${fmtInt(block.height)} found${hash ? "  hash " : ""}`;
  const post = `${txs}${weight}`;
  return line({
    key: `block:${Number(block.height)}`,
    kind: "block",
    text: `${pre}${hash}${post}`,
    tier: lit ? tierOfHash(hash) : null,
    hash: hash || null,
    pre,
    post,
    // raw capacity, so a later lit re-print can carry them over
    tx_count: block.tx_count ?? null,
    weight: block.weight ?? null,
    lit: !!lit && !!hash,
    ts: at,
  });
}

/** `mine no longer tracked on this page  tx a3f9c…21e  ·  tracking resumes when you return` — logged when the page unmounts while a mine is pending (useMine.resumeMineState keeps that promise). */
export function untrackedLine(txid, at = Date.now()) {
  return line({ key: `untracked:${txid}`, kind: "sys", text: `mine no longer tracked on this page  tx ${shortTxid(txid, 5, 3)}  ·  tracking resumes when you return`, ts: at });
}

/**
 * `last digit f → tier 1/16 → tier yield 1,000` — what the digit's tier
 * pays; the credit itself is the indexer's (it can be less near the cap)
 * and is printed only by the ✓ yours banner once reconcile has answered.
 */
export function digitLine(hash, yieldLocal, at = Date.now()) {
  const d = yieldDigit(hash);
  const b = bucketOf(d);
  if (!b) return null;
  return line({
    key: `digit:${String(hash).toLowerCase()}`,
    kind: "tier",
    tier: b.yield,
    text: `last digit ${d} → tier ${b.count}/${DIGIT_SPACE} → tier yield ${fmtInt(yieldLocal ?? b.yield)}`,
    ts: at,
  });
}

/**
 * Banner: `LUCKY mine settled  block 968,662  ✓ yours` + sum `+1,000 LUCKY`.
 * `credited` is what the indexer credited; `tierYield` the digit's tier
 * (defaults to `credited`). The tier colour is used only when the credit is
 * the full tier; a short credit names why in `note`
 * (`… ✓ yours  ·  cap reached: tier 1,000, credited 100`).
 */
export function yoursLine(ticker, height, credited, txid, at = Date.now(), { tierYield = credited, note = "" } = {}) {
  const full = Number(credited) === Number(tierYield);
  return line({
    key: `yours:${txid ?? height}`,
    kind: "tier",
    tier: full ? tierOfYield(credited) : null,
    yours: true,
    text: `${ticker} mine settled  block ${fmtInt(height)}  ✓ yours${note ? `  ·  ${note}` : ""}`,
    sum: `+${fmtInt(credited)} ${ticker}`,
    ts: at,
  });
}

/**
 * What the indexer credited a settled MINE whose digit's tier yields
 * `tierYield`: `{ credited, note }`, or null for an invalid mine / no row.
 * Near the cap the credit is what was left (a partial tier) or 0.
 */
export function creditOf(row, tierYield) {
  if (!row || row.status === "invalid") return null;
  if (row.cap_exhausted) return { credited: 0, note: "supply exhausted, 0 credited" };
  const y = Number(row.yield_smallest);
  if (!Number.isFinite(y)) return null;
  if (Number.isFinite(Number(tierYield)) && y < Number(tierYield)) {
    return { credited: y, note: `cap reached: tier ${fmtInt(tierYield)}, credited ${fmtInt(y)}` };
  }
  return { credited: y, note: "" };
}

/**
 * The ✓ yours banner for a reconciled MINE (`settle` from useMine: txid,
 * blockHeight, yieldLocal = the digit's tier, reconcile, indexed) — printed
 * only once the indexer has answered, with what it credited. null while
 * reconcile is pending, on a timeout and for an invalid mine.
 */
export function settledYoursLine(ticker, settle, at = Date.now()) {
  if (!settle || settle.reconcile !== "done") return null;
  const c = creditOf(settle.indexed, settle.yieldLocal);
  if (!c) return null;
  return yoursLine(ticker, settle.blockHeight, c.credited, settle.txid, at, { tierYield: settle.yieldLocal, note: c.note });
}

/** `resumed tracking  tx a3f9c…21e  ·  broadcast 20:20:39` — a MINE picked up again after a reload or a return to the page. */
export function resumedLine(txid, broadcastAt, at = Date.now()) {
  const when = Number.isFinite(Number(broadcastAt)) && broadcastAt ? `  ·  broadcast ${formatTime(broadcastAt)}` : "";
  return line({ key: `resumed:${txid}`, kind: "sys", text: `resumed tracking  tx ${shortTxid(txid, 5, 3)}${when}`, ts: at });
}

/**
 * The caption under the digit strip for a lit digit: the tier while the
 * indexer has not answered, the credit once it has.
 *   → { text, tierId, strong }
 */
export function mineCaption(litDigit, mine, ticker) {
  const b = litDigit ? bucketOf(litDigit) : null;
  if (!b) return { text: `${DIGIT_SPACE} possible digits · the confirming block decides`, tierId: null, strong: false };
  const head = `confirming digit ${litDigit}`;
  const tail = `${b.count} of ${DIGIT_SPACE}`;
  if (mine?.reconcile === "done") {
    const c = creditOf(mine.indexed, b.yield);
    if (!c) return { text: `${head} · tier ${fmtInt(b.yield)} · invalid mine, 0 credited`, tierId: null, strong: false };
    if (c.credited !== b.yield) return { text: `${head} · tier ${fmtInt(b.yield)} · ${fmtInt(c.credited)} ${ticker} credited (${c.credited === 0 ? "supply exhausted" : "cap reached"})`, tierId: null, strong: false };
    return { text: `${head} · ${fmtInt(b.yield)} ${ticker} · ${tail}`, tierId: b.id, strong: true };
  }
  if (mine?.reconcile === "timeout") return { text: `${head} · tier ${fmtInt(b.yield)} · credit not known yet`, tierId: b.id, strong: false };
  return { text: `${head} · tier ${fmtInt(b.yield)} · ${tail}`, tierId: b.id, strong: false };
}

/** The indexer's verdict, exactly as MinePanel's confirmed branch computed it; null while reconcile is pending. */
export function reconcileLine(mine, at = Date.now()) {
  if (!mine || mine.reconcile === "pending" || !mine.reconcile) return null;
  const key = `reconcile:${mine.txid ?? mine.blockHeight}:${mine.reconcile}`;
  if (mine.reconcile === "timeout") return line({ key, kind: "sys", text: "indexer has not indexed this mine yet — its credit shows under Portfolio › My mines once it does", ts: at });
  const row = mine.indexed;
  if (!row) return line({ key, kind: "sys", text: "indexer has not indexed this mine yet", ts: at });
  if (row.status === "invalid") return line({ key, kind: "sys", text: "indexer: invalid mine (0 credited)", ts: at });
  if (row.cap_exhausted) return line({ key, kind: "sys", text: "indexer: settled, supply exhausted (0 credited)", ts: at });
  const differs = row.yield_smallest !== mine.yieldLocal ? " · local yield differs from indexer — indexer is authoritative" : "";
  return line({ key, kind: "sys", text: `indexer: settled, ${fmtInt(row.yield_smallest)} ${row.ticker} credited${differs}`, ts: at });
}

/**
 * `stopped: <friendly error text>` — every flow error (a wallet refusal
 * says "declined" in its own text; nothing here claims someone rejected it).
 */
export function errorLine(text, startedAt, at = Date.now()) {
  return line({ key: `error:${startedAt ?? secondBucket(at)}`, kind: "err", text: `stopped: ${text || "failed"}`, ts: at });
}
