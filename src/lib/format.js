// Small display helpers — numbers, addresses, hashes, links.

export const MEMPOOL_TX_URL = "https://mempool.space/tx/";
export const MEMPOOL_BLOCK_URL = "https://mempool.space/block/";
export const MEMPOOL_ADDR_URL = "https://mempool.space/address/";
export const UNISAT_INSTALL_URL = "https://unisat.io";

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
 * ≥1 → 2 dp, otherwise 4 dp (SATS-like tokens trade well under 1 sat).
 */
export function fmtUnit(satsPerToken) {
  if (satsPerToken === null || satsPerToken === undefined || !Number.isFinite(Number(satsPerToken))) return "—";
  const v = Number(satsPerToken);
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 100) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
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

/** Fixed decimals with trailing zeros trimmed: 281.25 → "281.25", 276 → "276", 533.33 (d=1) → "533.3". */
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

export function fmtAgo(unixSeconds) {
  if (!unixSeconds) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
