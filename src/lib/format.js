// Small display helpers — numbers, addresses, hashes, links.

export const MEMPOOL_TX_URL = "https://mempool.space/tx/";
export const MEMPOOL_BLOCK_URL = "https://mempool.space/block/";
export const MEMPOOL_ADDR_URL = "https://mempool.space/address/";

export function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-US");
}

/** 1234 → "1,234"; 1_234_567 → "1.23M"; 21_000_000 → "21M". For dense stat tiles. */
export function fmtCompact(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs < 10_000) return v.toLocaleString("en-US");
  if (abs < 1_000_000) return `${(v / 1_000).toFixed(abs < 100_000 ? 1 : 0)}K`;
  if (abs < 1_000_000_000) return `${(v / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1).replace(/\.?0+$/, "")}M`;
  return `${(v / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "")}B`;
}

/** Whole sats with thousands separators + unit. */
export function fmtSats(sats) {
  if (sats === null || sats === undefined || Number.isNaN(Number(sats))) return "—";
  return `${Math.round(Number(sats)).toLocaleString("en-US")} sats`;
}

/**
 * Unit price in sats per whole token. Adaptive precision: ≥100 → 1 dp,
 * ≥1 → 2 dp, below 1 at least 4 dp and as many as three significant
 * digits need (a 546-sat listing of 100,000 tokens is 0.00546 sats/token —
 * with a fixed 21,000,000 supply, sub-sat prices are the normal regime).
 */
export function fmtUnit(satsPerToken) {
  if (satsPerToken === null || satsPerToken === undefined || !Number.isFinite(Number(satsPerToken))) return "—";
  const v = Number(satsPerToken);
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 100) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(subUnitDecimals(v));
}

/** Decimals for a sub-sat unit price: three significant digits, never fewer than 4 dp, at most 8. */
export function subUnitDecimals(v) {
  if (!(v > 0)) return 4;
  return Math.min(8, Math.max(4, 2 - Math.floor(Math.log10(v))));
}

/** Sats → "0.0123 BTC" (trimmed to what matters; never scientific). */
export function fmtBtcShort(sats) {
  if (sats === null || sats === undefined || Number.isNaN(Number(sats))) return "—";
  const btc = Number(sats) / 1e8;
  if (btc === 0) return "0 BTC";
  if (btc >= 1000) return `${btc.toLocaleString("en-US", { maximumFractionDigits: 1 })} BTC`;
  if (btc >= 1) return `${btc.toFixed(3).replace(/\.?0+$/, "")} BTC`;
  if (btc >= 0.001) return `${btc.toFixed(4).replace(/0+$/, "")} BTC`;
  return `${btc.toFixed(8).replace(/0+$/, "")} BTC`;
}

export function addrUrl(address) {
  return `${MEMPOOL_ADDR_URL}${encodeURIComponent(address)}`;
}

/** Turn a block-count difference into "3d 4h" style text. */
export function fmtBlocksAgo(blocks) {
  if (blocks === null || blocks === undefined || !Number.isFinite(Number(blocks))) return "—";
  const b = Math.max(0, Math.floor(Number(blocks)));
  if (b === 0) return "this block";
  if (b < 6) return `${b} block${b === 1 ? "" : "s"} ago`;
  const mins = b * 10;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

export function fmtBtc(sats) {
  if (sats === null || sats === undefined || Number.isNaN(Number(sats))) return "—";
  const btc = Number(sats) / 1e8;
  // Up to 8 decimals, trailing zeros trimmed but at least 4 shown.
  const s = btc.toFixed(8).replace(/0+$/, "");
  const [int, frac = ""] = s.split(".");
  return `${int}.${frac.padEnd(4, "0")}`;
}

/**
 * A wallet balance with its unconfirmed part named (fee inputs are
 * confirmed outputs only, so a fresh deposit must not read as spendable):
 *   total only / all confirmed → "0.0131 BTC"
 *   nothing confirmed          → "0.00005 BTC (unconfirmed)"
 *   partly unconfirmed         → "0.0131 BTC (0.0002 unconfirmed)"  — `short` drops this part
 * "" while the balance is unknown.
 */
export function walletBalanceText(total, confirmed, { short = false } = {}) {
  if (total === null || total === undefined || !Number.isFinite(Number(total))) return "";
  const t = Number(total);
  const base = `${fmtBtc(t)} BTC`;
  if (confirmed === null || confirmed === undefined || !Number.isFinite(Number(confirmed))) return base;
  const c = Number(confirmed);
  if (t > 0 && c <= 0) return `${base} (unconfirmed)`;
  if (!short && t > c) return `${base} (${fmtBtc(t - c)} unconfirmed)`;
  return base;
}

/**
 * The minted share as a percentage string that never reads "100%" before
 * the supply is actually reached (audit mine-6): rounded as usual, but
 * capped just under 100 while `minted < supply` ("99.99%" at 20,999,900 of
 * 21,000,000 — not "100.00%" next to "Remaining 100"). `digits` decimals
 * ("5.88%").
 */
export function fmtMintedPct(minted, supply, digits = 2) {
  const s = Number(supply);
  const m = Number(minted);
  if (!(s > 0) || !Number.isFinite(m)) return `${(0).toFixed(digits)}%`;
  if (m >= s) return "100%";
  const scale = 10 ** digits;
  const cap = 100 - 1 / scale;
  const v = Math.min(cap, Math.round(((100 * Math.max(0, m)) / s) * scale) / scale);
  return `${v.toFixed(digits)}%`;
}

/** Sats in a narrow column: "16,324 sats" below a million, "1.23M sats" above. */
export function fmtSatsShort(sats) {
  if (sats === null || sats === undefined || !Number.isFinite(Number(sats))) return "—";
  const v = Math.round(Number(sats));
  return v < 1_000_000 ? `${v.toLocaleString("en-US")} sats` : `${fmtCompact(v)} sats`;
}

/** Fixed decimals with trailing zeros trimmed: 312.5 → "312.5", 276 → "276", 533.33 (d=1) → "533.3". */
export function fmtDec(x, d = 2) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return "—";
  return String(Number(Number(x).toFixed(d)));
}

export function fmtPct(part, whole, digits = 2) {
  if (!whole) return "0%";
  return `${((100 * part) / whole).toFixed(digits)}%`;
}

export function shortAddr(a, head = 6, tail = 6) {
  if (typeof a !== "string" || a.length <= head + tail + 1) return a || "—";
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function shortTxid(t, head = 8, tail = 8) {
  return shortAddr(t, head, tail);
}

export function txUrl(txid) {
  return `${MEMPOOL_TX_URL}${encodeURIComponent(txid)}`;
}

export function blockUrl(hashOrHeight) {
  return `${MEMPOOL_BLOCK_URL}${encodeURIComponent(hashOrHeight)}`;
}

export function fmtTime(unixSeconds) {
  if (!unixSeconds) return "—";
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString("en-US", { hour12: false });
}

/** "2026-09-27" (UTC) for a unix-seconds timestamp. */
export function fmtDateUtc(unixSeconds) {
  if (!unixSeconds) return "—";
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * USD for an amount of sats at `usdPerBtc` (from /price). USD is always
 * secondary: with no price this is "—" and callers hide the label.
 */
export function fmtUsd(sats, usdPerBtc) {
  if (sats === null || sats === undefined || !Number.isFinite(Number(sats))) return "—";
  if (!Number.isFinite(usdPerBtc) || usdPerBtc <= 0) return "—";
  const usd = (Number(sats) / 1e8) * usdPerBtc;
  const abs = Math.abs(usd);
  if (abs === 0) return "$0";
  if (abs < 0.01) return `$${usd.toFixed(4)}`;
  if (abs < 1) return `$${usd.toFixed(3)}`;
  if (abs < 1000) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** "expires in 3d" / "expires in 5h" / "expired" for an `expires_at` stamp; "" when unknown. */
export function fmtExpires(expiresAt, nowSec = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(expiresAt)) return "";
  const left = expiresAt - nowSec;
  if (left <= 0) return "expired";
  if (left < 3600) return `expires in ${Math.max(1, Math.floor(left / 60))}m`;
  if (left < 86400) return `expires in ${Math.floor(left / 3600)}h`;
  return `expires in ${Math.floor(left / 86400)}d`;
}

export function fmtAgo(unixSeconds) {
  if (!unixSeconds) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
