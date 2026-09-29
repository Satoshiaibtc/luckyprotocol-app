// The transfer form's pure logic (src/pages/SendPage.jsx) — unit-tested in test/send.test.js.
//
// A SEND moves `AMT` of ONE ticker from the tx's input pool (the carriers
// it spends) to vout1; the rest of that ticker AND every other ticker on
// those carriers go to vout2, the sender's own 546-sat residual output
// (§2.3 / §4.1). vout0 is the protocol fee output. So the same page that
// sends tokens to someone else also splits a multi-ticker carrier: send the
// ticker to yourself and it lands alone on vout1, the other tickers
// together on vout2.
//
//   sendCarrierRows   the address's carriers of a ticker, with why a row
//                     cannot be spent right now (listed / fill pending /
//                     already spent by your own pending tx)
//   autoPickCarriers  which carriers to spend for an amount
//   sendAmountError   whole tokens, 1 … what the chosen carriers hold
//   recipientState    the recipient check + the self / fee-address warnings
//   sendLayout        the §2.3 reference layout, as the confirm screen shows it
//   parseSendAmount   the amount field → whole tokens ("1,000" allowed)
//   sendFormHint      the one line saying why Review is still off
//   sendReviewModel   what the confirm screen shows — frozen at signing
//   pendingSendsOf    this browser's unconfirmed sends of a ticker
//   sendVersions      every version of a sped-up send (switchSendVersion follows one)

import { checkRecipientAddress } from "./psbt.js";
import { DUST_SATS, PROJECT_FEE_ADDRESS, SEND_PROTOCOL_FEE_SATS, SEND_RESIDUAL_VOUT, SEND_TO_VOUT } from "./payloads.js";
import { fmtUnit } from "./format.js";

const key = (u) => `${String(u.txid).toLowerCase()}:${Number(u.vout)}`;

/** Your token outputs of a SEND just broadcast: vout2 (the residual output) always, vout1 too when it pays you. */
export function sendPendingOutpoints(txid, { toSelf = false } = {}) {
  return toSelf ? [{ txid, vout: SEND_TO_VOUT }, { txid, vout: SEND_RESIDUAL_VOUT }] : [{ txid, vout: SEND_RESIDUAL_VOUT }];
}

/** Every txid a send has had: the current version first, then the ones a Speed up replaced, newest first. */
export function sendVersions(chain) {
  if (!chain || !chain.txid) return [];
  return [chain.txid, ...[...(chain.replaces || [])].reverse()].filter((t, i, a) => t && a.indexOf(t) === i);
}

/**
 * The send following its version `txid` — an earlier one a block confirmed
 * instead of the faster copy: the other versions become `replaces`, and the
 * unsigned PSBT goes (a confirmed send has nothing left to speed up). It is
 * pending again until its own status check says confirmed.
 */
export function switchSendVersion(chain, txid) {
  if (!chain || !txid || txid === chain.txid) return chain;
  const all = sendVersions(chain);
  return { ...chain, txid, replaces: all.filter((t) => t !== txid).reverse(), psbt: null, phase: "pending", note: null };
}

/**
 * The carriers of `ticker` at this address, largest amount first:
 *   { key, txid, vout, amount, balances, others: [[ticker, amount]], sats,
 *     listing, offBook, blocked: null | "listed" | "filling" | "pending", note }
 * `tokenUtxos` = /utxos/:addr rows, `values` = `[{ txid, vout, sats }]`
 * (each carrier's BTC value, indexer.outputValues), `orders` = this address's
 * OrderViews (live ones mark a carrier listed / filling), `expired` = its
 * listings that left the book but can still be filled (`offBook`: spending
 * the carrier cancels them), `pendingSpent` = Set of "txid:vout" your own
 * unconfirmed broadcasts already spend (txrecords.pendingSpentOutpoints).
 */
export function sendCarrierRows({ tokenUtxos, values, orders, expired = [], pendingSpent, ticker }) {
  const sats = new Map((values || []).map((u) => [key(u), Number(u.sats)]));
  const live = new Map((orders || []).filter((o) => o && (o.status === "open" || o.status === "filling")).map((o) => [String(o.id).toLowerCase(), o]));
  const floors = new Map((expired || []).filter((o) => o && o.id).map((o) => [String(o.id).toLowerCase(), o]));
  const spent = pendingSpent instanceof Set ? pendingSpent : new Set(pendingSpent || []);
  return (tokenUtxos || [])
    .filter((u) => Number(u.balances?.[ticker]) > 0)
    .map((u) => {
      const k = key(u);
      const listing = live.get(k) || null;
      const others = Object.entries(u.balances).filter(([t, a]) => t !== ticker && Number(a) > 0);
      let blocked = null;
      if (spent.has(k)) blocked = "pending";
      else if (listing?.status === "filling") blocked = "filling";
      else if (listing) blocked = "listed";
      return {
        key: k,
        txid: String(u.txid).toLowerCase(),
        vout: Number(u.vout),
        amount: Number(u.balances[ticker]),
        balances: u.balances,
        others,
        sats: sats.has(k) ? sats.get(k) : null,
        listing,
        offBook: listing ? null : floors.get(k) || null,
        blocked,
      };
    })
    .sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
}

/** Plain words for a row's state (never shown for a free row). */
export function carrierNote(row, ticker) {
  if (row.blocked === "pending") return "already spent by one of your transactions that has not confirmed yet";
  if (row.blocked === "filling") return "a fill of its listing is in the mempool — it cannot be spent until that confirms or drops";
  if (row.blocked === "listed") return `listed for sale — transferring it withdraws that listing (its signed listing can no longer be filled)`;
  if (!Number.isInteger(row.sats)) return "its BTC value is not known: the indexer could not read this output right now, and a SEND signs its exact value — try again in a moment";
  if (row.offBook) {
    return `an earlier listing of it can still be bought at ${fmtUnit(row.offBook.unit_price)} sats per token — transferring it cancels that listing`;
  }
  if (row.others.length) return `also carries ${row.others.map(([t, a]) => `${Number(a).toLocaleString("en-US")} ${t}`).join(", ")} — those go to your residual carrier (vout2), not to the recipient`;
  if (Number.isInteger(row.sats) && row.sats > DUST_SATS) return `also holds ${row.sats.toLocaleString("en-US")} sats of BTC — they come back to you as change`;
  return `${ticker} only`;
}

/**
 * Rows that may be picked automatically: free (never a listed carrier) and
 * of a known BTC value — a SEND signs each input's exact value, so a
 * carrier whose value the indexer could not read cannot be spent.
 */
const autoEligible = (r) => !r.blocked && Number.isInteger(r.sats);

/**
 * Which carriers (keys) to spend for `amount` of the ticker, or null when
 * the free carriers do not hold that much. Preference: one single-ticker
 * carrier holding exactly the amount; else the smallest single-ticker
 * carrier that covers it; else single-ticker carriers largest-first; only
 * then carriers that also hold other tickers (they drag those tickers
 * into the residual output — harmless, but not what a plain send expects).
 */
export function autoPickCarriers(rows, amount) {
  const a = Number(amount);
  if (!Number.isInteger(a) || a < 1) return [];
  const free = (rows || []).filter(autoEligible);
  const single = free.filter((r) => r.others.length === 0);
  const exact = single.find((r) => r.amount === a);
  if (exact) return [exact.key];
  const cover = single.filter((r) => r.amount >= a).sort((x, y) => x.amount - y.amount)[0];
  if (cover) return [cover.key];
  const picked = [];
  let sum = 0;
  for (const r of [...single].sort((x, y) => y.amount - x.amount).concat([...free.filter((r) => r.others.length)].sort((x, y) => y.amount - x.amount))) {
    if (sum >= a) break;
    picked.push(r.key);
    sum += r.amount;
  }
  return sum >= a ? picked : null;
}

/** Sum of the ticker held by the rows whose key is in `keys`. */
export function pickedAmount(rows, keys) {
  const set = new Set(keys || []);
  return (rows || []).filter((r) => set.has(r.key)).reduce((s, r) => s + r.amount, 0);
}

/** How much of the ticker the rows could send at most (free rows + listed ones, never pending / filling). */
export function spendableAmount(rows) {
  return (rows || []).filter((r) => r.blocked !== "pending" && r.blocked !== "filling").reduce((s, r) => s + r.amount, 0);
}

/**
 * The whole-token amount the field text means, or null: plain digits, or
 * digits grouped by commas in threes ("1,000" — how the page itself prints
 * amounts, so a pasted figure works). Anything else is null.
 */
export function parseSendAmount(text) {
  const t = String(text ?? "").trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (/^\d{1,3}(,\d{3})+$/.test(t)) return Number(t.replace(/,/g, ""));
  return null;
}

/**
 * Why `text` is not a usable amount (whole tokens, 1 … `max`), or null.
 * `max` = what the chosen carriers hold (or the free balance).
 */
export function sendAmountError(text, max, ticker) {
  const t = String(text ?? "").trim();
  if (t === "") return null;
  const cap = Number(max) || 0;
  if (cap < 1) return `No ${ticker} available to transfer right now.`;
  const range = `Enter a whole number of ${ticker} from 1 to ${cap.toLocaleString("en-US")}`;
  const n = parseSendAmount(t);
  if (n === null) {
    return t.includes(",") && !/[.]/.test(t)
      ? `${range} — digits only, for example 1500 (commas only between groups of three digits).`
      : `${range} — whole tokens only, digits only (for example 1500).`;
  }
  if (n < 1) return `${range} (not zero).`;
  if (n > cap) return `${range} — you have ${cap.toLocaleString("en-US")} available here.`;
  return null;
}

/**
 * The recipient check for the form: `{ state: "empty" | "invalid" | "ok",
 * address, label, error, self, feeAddress }`. The address rules are the
 * SEND builder's own (psbt.checkRecipientAddress: legacy 1…, P2SH 3…,
 * bc1q…, bc1p…); bech32 is lower-cased first (it is case-insensitive).
 */
export function recipientState(text, self) {
  const raw = String(text ?? "").trim();
  if (!raw) return { state: "empty", address: "", label: null, error: null, self: false, feeAddress: false };
  const address = /^bc1/i.test(raw) ? raw.toLowerCase() : raw;
  const r = checkRecipientAddress(address, self || null);
  if (!r.ok) return { state: "invalid", address, label: null, error: r.error, self: false, feeAddress: false };
  return { state: "ok", address, label: r.label, error: null, self: !!self && address === self, feeAddress: address === PROJECT_FEE_ADDRESS };
}

/**
 * The one line under the form saying why Review is still off, or null when
 * nothing (or a message already on screen) explains it. A specific amount
 * error is shown by the field itself, so no second, contradicting line is
 * added for it.
 */
export function sendFormHint({ connected, indexerOk, lagText, rcptState, amount, amountErr, keysCount, pickedTotal, mode, freeTotal, ticker, feeHint, unknownValue = false, ordersIncomplete = false }) {
  if (!connected) return null;
  if (!indexerOk) return "The indexer is not answering right now — transfers are paused until it does.";
  if (lagText) return lagText;
  if (rcptState === "empty") return "Enter the recipient's address.";
  if (rcptState === "invalid") return null;
  if (amountErr) return null;
  if (!amount) return `Enter how many ${ticker} to transfer.`;
  if (mode === "auto" && ordersIncomplete) return ORDERS_INCOMPLETE_TEXT;
  if (!keysCount || pickedTotal < amount) {
    return mode === "auto"
      ? `Your free ${ticker} carriers hold ${Number(freeTotal).toLocaleString("en-US")} — not enough for ${Number(amount).toLocaleString("en-US")}.`
      : "Tick the carriers to spend — together they must hold the amount.";
  }
  if (unknownValue) return "A carrier you ticked has no known BTC value right now (see its line) — untick it, or try again in a moment.";
  return feeHint || null;
}

/**
 * Not every one of this address's listings could be read: a carrier that
 * is listed may not be marked, so none is chosen automatically.
 */
export const ORDERS_INCOMPLETE_TEXT =
  "Not all of your listings could be read, so carriers are not chosen automatically — tick the ones to transfer (a listed carrier's listing is withdrawn when it is spent).";

/**
 * Which carriers the page spends: the automatic pick — only while every
 * listing of the address was read (`ordersComplete`), else none (the user
 * ticks them) — or the ticked ones.
 */
export function carriersToSpend({ mode, rows, amount, manual, ordersComplete = true }) {
  if (mode === "auto") return ordersComplete && amount ? autoPickCarriers(rows, amount) || [] : [];
  return (manual || []).filter((k) => (rows || []).some((r) => r.key === k && r.blocked !== "pending" && r.blocked !== "filling"));
}

/**
 * What the confirm screen shows for a SEND of `amount` from the carriers
 * `keys` of `rows` to `toAddress` (`self` = your address): the §2.3 layout,
 * the other tickers riding along and the listed carriers it withdraws. The
 * page freezes this at signing: afterwards the live rows no
 * longer hold the spent carriers, so a model rebuilt from them would
 * describe a transaction that was never sent.
 */
export function sendReviewModel({ rows, keys, ticker, amount, toAddress, self, payloadText, feeRateSatVb = null }) {
  const set = new Set(keys || []);
  const picked = (rows || []).filter((r) => set.has(r.key)).map((r) => ({ ...r, balances: { ...r.balances }, others: r.others.map(([t, a]) => [t, a]) }));
  return {
    ticker,
    amount: Number(amount) || 0,
    toAddress,
    toSelf: !!self && toAddress === self,
    keys: picked.map((r) => r.key),
    layout: sendLayout({ rows: picked, keys: picked.map((r) => r.key), ticker, amount, toAddress, self, payloadText }),
    others: picked.filter((r) => r.others.length),
    listed: picked.filter((r) => r.blocked === "listed"),
    // earlier listings that left the book but can still be filled: spending cancels them
    offBook: picked.filter((r) => !!r.offBook),
    feeRateSatVb,
  };
}

/** This browser's unconfirmed SEND records of `ticker` (txrecords rows). */
export function pendingSendsOf(records, ticker) {
  return (records || []).filter((r) => !r.confirmed && r.kind === "send" && r.ticker === ticker);
}

/**
 * What each output of the SEND carries, for the confirm screen:
 * `[{ vout, sats, to, carries }]` in the §2.3 reference layout, from the
 * picked rows' balances (the input pool) — vout0 is the protocol fee,
 * vout1 gets `amount` of the ticker, vout2 the rest of it plus every other
 * ticker. `changeSats` null = "BTC change, if ≥ 546 sats".
 */
export function sendLayout({ rows, keys, ticker, amount, toAddress, self, payloadText, changeSats = null }) {
  const set = new Set(keys || []);
  const pool = {};
  for (const r of rows || []) {
    if (!set.has(r.key)) continue;
    for (const [t, a] of Object.entries(r.balances || {})) pool[t] = (pool[t] || 0) + Number(a);
  }
  const amt = Number(amount) || 0;
  const residual = { ...pool, [ticker]: Math.max(0, (pool[ticker] || 0) - amt) };
  const residualText = Object.entries(residual)
    .filter(([, a]) => a > 0)
    .map(([t, a]) => `${a.toLocaleString("en-US")} ${t}`)
    .join(" + ");
  return [
    { vout: 0, sats: SEND_PROTOCOL_FEE_SATS, to: "protocol fee address", carries: "—" },
    { vout: SEND_TO_VOUT, sats: DUST_SATS, to: toAddress === self ? "you (new carrier)" : toAddress, carries: `${amt.toLocaleString("en-US")} ${ticker}` },
    { vout: SEND_RESIDUAL_VOUT, sats: DUST_SATS, to: "you (residual carrier)", carries: residualText || "nothing (this output is always there)" },
    { vout: 3, sats: 0, to: "OP_RETURN", carries: payloadText || "" },
    { vout: 4, sats: changeSats, to: "you (BTC change)", carries: "— never tokens" },
  ];
}
