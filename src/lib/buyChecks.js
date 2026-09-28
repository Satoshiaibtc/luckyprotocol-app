// Buyer-side carrier checks for a fill (PROTOCOL.md §7.2 step 3, audit
// trading-2) — pure, unit-tested in test/listingrules.test.js.
//
// `sellerCarrierCheck` judges the indexer's own word on the listed
// outpoint: `GET /utxos/:seller` must still list it carrying exactly
// `{ TICKER: amount }` with amount > 0. A zero-token carrier is never
// buyable: the fill would pay the seller and move nothing. The buy sheet
// runs it when the sheet opens (check 3) and AGAIN right before the
// wallet is asked to sign, so a carrier emptied in between is refused.

import { fmtInt } from "./format.js";

const TICKER_RE = /^[A-Z0-9]{1,8}$/;

/** The row of `utxos` (the /utxos/:seller list) for order id "txid:vout", or null. */
export function carrierRowOf(utxos, orderId) {
  const [txid, voutStr] = String(orderId || "").toLowerCase().split(":");
  const vout = Number(voutStr);
  return (utxos || []).find((u) => String(u.txid).toLowerCase() === txid && Number(u.vout) === vout) || null;
}

/**
 * `{ ok, detail }` for the indexer's carrier row `row` (`{ txid, vout,
 * balances }` or null) against `order` (`{ id, ticker, amount }`).
 * ok only when the row exists, carries exactly one ticker — the order's —
 * and that balance is a whole number > 0 equal to the order's amount.
 */
export function sellerCarrierCheck(row, order) {
  const ticker = String(order?.ticker || "");
  const amount = Number(order?.amount);
  if (!TICKER_RE.test(ticker) || !Number.isInteger(amount)) return { ok: false, detail: "the listing names no ticker / amount" };
  if (amount < 1) return { ok: false, detail: `the listing is for 0 ${ticker} — a zero-token carrier is never buyable` };
  if (!row) return { ok: false, detail: "seller no longer holds this outpoint" };
  const bal = Object.entries(row.balances || {});
  const [id] = String(order.id || "").split(":");
  const where = `${id.slice(0, 8)}…:${String(order.id || "").split(":")[1] ?? "?"}`;
  if (bal.length === 0) return { ok: false, detail: `the indexer lists no tokens on ${where} — a zero-token carrier is never buyable` };
  if (bal.length !== 1 || bal[0][0] !== ticker) return { ok: false, detail: `outpoint carries ${JSON.stringify(row.balances)}, order says { ${ticker}: ${amount} }` };
  const have = Number(bal[0][1]);
  if (!Number.isInteger(have) || have <= 0) return { ok: false, detail: `the indexer says ${where} carries 0 ${ticker} — a zero-token carrier is never buyable` };
  if (have !== amount) return { ok: false, detail: `outpoint carries ${fmtInt(have)} ${ticker}, order says ${fmtInt(amount)}` };
  return { ok: true, detail: `seller holds ${fmtInt(amount)} ${ticker} on ${where}` };
}
