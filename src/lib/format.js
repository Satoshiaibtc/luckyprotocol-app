// Small display helpers — numbers, addresses, hashes, links.

export const MEMPOOL_TX_URL = "https://mempool.space/tx/";
export const MEMPOOL_BLOCK_URL = "https://mempool.space/block/";
export const UNISAT_INSTALL_URL = "https://unisat.io";

export function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-US");
}

export function fmtBtc(sats) {
  if (sats === null || sats === undefined || Number.isNaN(Number(sats))) return "—";
  const btc = Number(sats) / 1e8;
  // Up to 8 decimals, trailing zeros trimmed but at least 4 shown.
  const s = btc.toFixed(8).replace(/0+$/, "");
  const [int, frac = ""] = s.split(".");
  return `${int}.${frac.padEnd(4, "0")}`;
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
