// The order book's listing acceptance rules the app checks BEFORE a listing
// is signed or published (PROTOCOL.md §7.4) — pure, unit-tested in
// test/listingrules.test.js.
//
//   shape      a listing no fill could ever relay is refused: the unsigned
//              tx's nVersion must be 1 or 2, input 0's nSequence must have
//              the relative-lock-time disable bit set (≥ 0x80000000, which
//              covers 0xFFFFFFFD / 0xFFFFFFFE / 0xFFFFFFFF), nLockTime 0,
//              exactly 1 input + 1 output. The seller's 0x83 signature
//              commits to all of these, so a buyer cannot repair them.
//   cheapest   per outpoint the book keeps the CHEAPEST live signed
//              listing: a signed listing is a bearer instrument that stays
//              fillable on-chain, so a higher re-listing would show a price
//              nobody has to pay. Raising the price therefore means
//              Withdraw first (move the tokens on-chain), then list the new
//              carrier; the same or a lower price replaces the listing.
//              The indexer keeps guarding it after the book dropped the
//              listing (TTL, eviction — the "listing floor"), and shows the
//              seller such an off-book listing as a row with status
//              "expired": it can still be bought at its price until the
//              seller withdraws it.
//   reserved   the first output of a step-1 reservation (COMMIT) that can
//              still be published is never listed: a listing's signature
//              covers only that output and the payment, so a buyer could
//              publish the reserved ticker with the seller named creator —
//              nor, after the reservation expired, until its last block is
//              final (a reorganization could still make it publishable).

//   cap        one seller address may hold at most MAX_OPEN_LISTINGS_PER_ADDRESS
//              OPEN listings at a time, across every ticker (spec §7.4
//              "Per-seller cap"). A listing of an outpoint that already
//              has an open listing replaces it and takes no extra place.

import { parseListing } from "./swap.js";
import { FINAL_DEPTH, confirmationsAt } from "./finality.js";

export const LISTING_VERSIONS = Object.freeze([1, 2]);

// ---- per-address listing cap (spec §7.4) --------------------------------------------------

/**
 * The most OPEN listings one seller address may have at a time, across all
 * tickers. Mirrors the order book's per-address cap (PROTOCOL.md §7.4);
 * keep the two equal. The only place the app states the number.
 */
export const MAX_OPEN_LISTINGS_PER_ADDRESS = 10;

/**
 * The order book's per-address refusal, the whole message and nothing else:
 * "seller has 10 open orders (cap 10)". Group 1 = the address's open count,
 * group 2 = the cap. Anchored and case-sensitive, so the per-TICKER refusal
 * ("<TICKER> has N open orders (cap N); a new ask must undercut …") never
 * matches, whatever the ticker is called (SELLER, RESELLER, …).
 */
export const SELLER_CAP_RE = /^seller has (\d+) open orders \(cap (\d+)\)$/;

/** The order book's exact per-address refusal for a seller with `count` open listings (what the mock answers too). */
export const sellerCapError = (count = MAX_OPEN_LISTINGS_PER_ADDRESS, cap = MAX_OPEN_LISTINGS_PER_ADDRESS) => `seller has ${count} open orders (cap ${cap})`;

/**
 * Why a new listing is refused at the cap, in plain words — the sell form
 * says it before the wallet is opened, and the book's refusal maps to it.
 * `used` is the address's open count when known: it can exceed the cap for a
 * while (a buyer's transaction that left the mempool unconfirmed turns that
 * listing open again).
 */
export function listingCapText(cap = MAX_OPEN_LISTINGS_PER_ADDRESS, used = cap) {
  const have = Number.isInteger(used) && used > cap
    ? `${used} open listings; the order book allows at most ${cap} for one address (all tokens together)`
    : `${cap} open listings, the most the order book allows for one address (all tokens together)`;
  return `This address already has ${have}. To list another UTXO, withdraw one of your listings (the Portfolio page shows all of them) or wait until one sells. A UTXO that is already listed can still be listed again at the same or a lower price.`;
}

// ---- listings that left the book --------------------------------------------------------

/** A listing the book no longer shows whose signature is still valid (the seller's by-address rows with status "expired"). */
export const isOffBook = (o) => !!o && o.status === "expired";

/**
 * The seller's words for an off-book listing of `amount` `ticker` at
 * `unitText` sats per token (already formatted): what it still means, and
 * the one thing that ends it.
 */
export function offBookText({ amount, ticker, unitText }) {
  const what = amount ? `${Number(amount).toLocaleString("en-US")} ${ticker || ""}`.trim() : "these tokens";
  return `An earlier listing of this output can still be bought at ${unitText} sats per token — withdraw to cancel it. It left the order book, but anyone who saved its signature can still complete it; until you withdraw, ${what} can be bought at that price.`;
}

/** The sell form's note under its carrier list when one of them has an off-book listing. */
export const OFF_BOOK_LISTING_TEXT =
  "an earlier listing of this output left the order book, but its signature is still valid: anyone who saved it can still buy these tokens at that price. Select it and Withdraw to cancel it.";

/** The short status note of an off-book row in the listings tables. */
export const OFF_BOOK_NOTE = "off the book · the signature is still valid until you withdraw";

/**
 * How a seller's listings table shows a closed or off-book row (`o` an
 * OrderView) → `{ label, note }`:
 *   filled, buyer = seller   "filled · self" — its own signature was used and
 *                            the tokens came back to the seller's address
 *   filled, no buyer         "filled" — paid, the tokens burned
 *   filled                   "filled" — sold
 *   cancelled, spent         "withdrawn" — spent on-chain without a fill (a
 *                            withdrawal, a split or a transfer); never "sold"
 *   cancelled, unspent       "cancelled" — the book dropped it after a chain
 *                            reorganization; its signature may still be filled
 *   expired                  "still buyable" — it left the book, the
 *                            signature is valid until the seller withdraws
 * Live rows (open / filling) keep their own words: null.
 */
export function listingStatusView(o) {
  if (!o) return null;
  if (o.status === "filled") {
    if (o.buyer && o.buyer === o.seller) return { label: "filled · self", note: "filled with its own listing signature; the tokens came back to this address" };
    if (!o.buyer) return { label: "filled", note: "paid in full; the tokens went to no address (burned)" };
    return { label: "filled", note: null };
  }
  if (o.status === "cancelled") {
    return o.spent_txid
      ? { label: "withdrawn", note: "spent on-chain without a fill (a withdrawal, a split or a transfer)" }
      : { label: "cancelled", note: "dropped after a chain reorganization — its signature can still be filled until you withdraw" };
  }
  if (isOffBook(o)) return { label: "still buyable", note: OFF_BOOK_NOTE };
  return null;
}

// ---- sell-form row states ---------------------------------------------------------------

/**
 * The least BTC value a listed output may hold: the order book refuses a
 * listing of a smaller one (a buyer's standard carriers are 546 sats).
 */
export const MIN_CARRIER_SATS = 546;

/**
 * The state of one of the seller's carriers in the sell form, first match wins:
 *   "pending"   one of this browser's own unconfirmed transactions spends it
 *               (`pendingSpent`, a Set of "txid:vout")
 *   "multi"     it carries more than one ticker
 *   "filling"   a spend of its live listing is in the mempool
 *   "listed"    it has an open listing
 *   "offbook"   an earlier listing left the book but can still be bought
 *   "unknown"   its BTC value is not known (the indexer does not list the
 *               output right now) — a listing commits the exact value
 *   "small"     it holds fewer than 546 sats of BTC: the book lists only a
 *               carrier of at least 546 (move the tokens to one first)
 *   "fat"       it holds more than 546 sats of BTC (split first)
 *   "listable"  none of the above
 */
export function sellRowState(row, pendingSpent = null) {
  if (!row) return null;
  if (pendingSpent && pendingSpent.has(String(row.key || "").toLowerCase())) return "pending";
  if (row.multi) return "multi";
  if (row.listing && row.listing.status === "filling") return "filling";
  if (row.listing && row.listing.status === "open") return "listed";
  if (row.offBook) return "offbook";
  if (!Number.isInteger(row.sats)) return "unknown";
  if (row.sats < MIN_CARRIER_SATS) return "small";
  if (row.sats > MIN_CARRIER_SATS) return "fat";
  return "listable";
}

/** The sell form's words for a carrier below MIN_CARRIER_SATS. */
export function smallCarrierText(sats) {
  return `This UTXO holds ${Number(sats).toLocaleString("en-US")} sats of BTC; the order book lists only a carrier of at least ${MIN_CARRIER_SATS} sats. Move the tokens to a fresh ${MIN_CARRIER_SATS}-sat carrier (a transfer to yourself) and list that once it confirms.`;
}

/**
 * The words for a carrier whose BTC value is not known: the indexer does
 * not list the output among the address's outputs right now (a signature
 * commits to the exact value, so nothing can be signed for it yet).
 */
export const UNKNOWN_VALUE_TEXT =
  "The BTC value of this UTXO is not known: the indexer does not list it among this address's outputs right now, and a signature must commit to the exact value. Try again after the next block.";

/** The sell form's words for a carrier this browser is already spending. */
export const OWN_PENDING_SPEND_TEXT =
  "One of your transactions that has not confirmed yet already spends this UTXO. It cannot be listed, split or moved again; its new carrier appears here once that transaction confirms.";

/**
 * Why the carrier `sel` cannot be split or moved right now — or null.
 * `ownPending` = this browser's own transaction spends it; a `filling`
 * listing has a fill (or a withdrawal) in the mempool that a split would
 * have to out-bid — only Withdraw replaces a pending fill on purpose.
 */
export function splitBlockedReason(sel, { ownPending = false } = {}) {
  if (!sel) return null;
  if (sel.pending) return OWN_PENDING_SPEND_TEXT;
  if (sel.listing && sel.listing.status === "filling") {
    return ownPending
      ? "Your own transaction spending this UTXO is in the mempool — split it after that confirms."
      : "A fill of this listing is in the mempool — this UTXO cannot be split until that fill confirms or drops. Withdraw is the only way to replace it.";
  }
  return null;
}

/**
 * Every order `address` has in the book, read page by page through
 * `fetchPage(offset, limit)` → `{ total, items, expired? }`
 * (indexer.ordersByAddress). The indexer lists them newest first, at most
 * 200 a page, so an old open listing can sit behind many closed ones:
 * pages are read until `total` is reached, at most `maxPages`.
 * `complete: false` = some rows were not read, so a count made from
 * `items` is a lower bound. `expired` = the listings that left the book
 * but can still be filled (sent with every page; kept from the first).
 */
export async function readSellerOrders(fetchPage, { pageSize = 200, maxPages = 10 } = {}) {
  const items = [];
  let expired = null;
  for (let n = 0, offset = 0; n < maxPages; n++) {
    const pg = await fetchPage(offset, pageSize);
    const got = Array.isArray(pg?.items) ? pg.items : [];
    if (expired === null) expired = Array.isArray(pg?.expired) ? pg.expired : [];
    items.push(...got);
    // The next page starts where the server's page ended: its own `limit`
    // when it names one (a server that clamps lower is still walked in
    // full), else the size asked for.
    const served = Number(pg?.limit);
    offset += Number.isInteger(served) && served > 0 ? Math.min(served, pageSize) : pageSize;
    const total = Number(pg?.total);
    const more = Number.isFinite(total) ? offset < total : got.length >= pageSize;
    if (!more) return { items, expired, complete: true };
    if (!got.length) return { items, expired, complete: false };
  }
  return { items, expired: expired || [], complete: false };
}

/**
 * How many of the cap `address` uses: its OPEN listings among `orders`
 * (OrderViews of any ticker / status; a later row for the same id wins, so
 * fresher reads go last). Counts what the order book counts: status
 * `open` only — a `filling` listing does not count — and a listing whose
 * `expires_at` has passed at `nowSec` does not count either (the book
 * drops expired listings before it counts). →
 *   { used, cap, full, complete, ids: Set<outpoint id> }
 */
export function listingQuota(orders, address, { nowSec = Date.now() / 1000, complete = true, cap = MAX_OPEN_LISTINGS_PER_ADDRESS } = {}) {
  const byId = new Map();
  for (const o of orders || []) if (o && o.id && o.seller === address) byId.set(String(o.id).toLowerCase(), o);
  const ids = new Set();
  for (const [id, o] of byId) {
    if (o.status !== "open") continue;
    if (Number.isFinite(o.expires_at) && o.expires_at <= nowSec) continue;
    ids.add(id);
  }
  return { used: ids.size, cap, full: ids.size >= cap, complete: !!complete, ids };
}

/** "3 of 10 listings used" ("At least 3 of 10 listings used" when not every row was read). */
export function listingQuotaText(q) {
  if (!q) return "";
  return `${q.complete ? "" : "At least "}${q.used} of ${q.cap} listings used`;
}

/**
 * May a listing of outpoint `outpointId` be published under the cap, given
 * the seller's `quota` (listingQuota)? →
 *   { ok: true,  kind: "unknown" }             — the quota is not known; the book decides
 *   { ok: true,  kind: "replace", used, cap }  — the outpoint already has an open listing (re-pricing / renewing takes no new place, even when `used` is above the cap)
 *   { ok: true,  kind: "new", used, cap }      — a new listing, below the cap
 *   { ok: false, kind: "cap", used, cap }      — a new listing at the cap: refused before signing
 */
export function listingCapDecision(quota, outpointId) {
  if (!quota) return { ok: true, kind: "unknown" };
  const { used, cap } = quota;
  if (quota.ids.has(String(outpointId || "").toLowerCase())) return { ok: true, kind: "replace", used, cap };
  if (used >= cap) return { ok: false, kind: "cap", used, cap };
  return { ok: true, kind: "new", used, cap };
}

/** The order book's exact refusal of a higher price for a listed outpoint. */
export const WITHDRAW_FIRST_TEXT = "withdraw first: the cheaper signed listing stays fillable on-chain";

/** The order book's exact refusal of the first output of an open reservation. */
export const COMMIT_CARRIER_LISTING_TEXT =
  "outpoint reserves a ticker (the output of an open COMMIT, step 1 of a deploy): a listing of it would let the buyer publish that ticker with you named as its creator. Move it with a send to yourself, or publish your ticker, before listing";

/** The same rule in plain words for the sell form. */
export const COMMIT_CARRIER_PLAIN_TEXT =
  "This output holds a ticker reservation: it is the first output of a step 1 (Reserve) transaction that can still be published. A listing's signature covers only this output and your payment, so a buyer could use it to publish that reserved ticker with you named as its creator. Move it with a send to yourself (or publish your own reservation) before listing it.";

/** The sell form's words while an expired reservation's last block is not final yet. */
export function commitExpiredWaitText(lastBlock, indexed) {
  const n = Number.isInteger(lastBlock) && Number.isInteger(indexed) ? Math.max(1, FINAL_DEPTH - (confirmationsAt(lastBlock, indexed) ?? 0)) : null;
  const when = Number.isInteger(lastBlock) ? ` from block ${(lastBlock + FINAL_DEPTH - 1).toLocaleString("en-US")}` : "";
  return `This output held a ticker reservation that has just expired. The order book lists it only once the reservation's last block has ${FINAL_DEPTH} confirmations${when}${n ? ` — about ${n} more block${n === 1 ? "" : "s"}` : ""}. Nothing needs to be sent; list it then.`;
}

/**
 * Why outpoint `vout` of a tx whose /commits record is `commit` (a
 * CommitView, or null when the tx is not a recorded COMMIT) must not be
 * listed — or null, exactly as the order book decides it: vout 0 of an
 * unspent COMMIT whose status is `open`, or `expired` while its last
 * reveal block (`expires_at_height`) has fewer than FINAL_DEPTH
 * confirmations at `indexed` (the same indexer's applied height; unknown →
 * refused, the book decides after the wait).
 */
export function commitCarrierProblem(vout, commit, indexed = null) {
  if (Number(vout) !== 0 || !commit || commit.spent_txid) return null;
  if (commit.status === "open") return COMMIT_CARRIER_PLAIN_TEXT;
  if (commit.status !== "expired") return null;
  const last = Number.isInteger(commit.expires_at_height) ? commit.expires_at_height : null;
  if (last !== null && Number.isInteger(indexed) && (confirmationsAt(last, indexed) ?? 0) >= FINAL_DEPTH) return null;
  return commitExpiredWaitText(last, Number.isInteger(indexed) ? indexed : null);
}
/** BIP68: bit 31 of nSequence disables the relative lock-time. */
export const SEQUENCE_DISABLE_FLAG = 0x80000000;

const hex32 = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;

/** Does this input-0 nSequence leave the listing fillable (no relative lock-time)? */
export function listingSequenceOk(sequence) {
  const s = Number(sequence);
  return Number.isInteger(s) && s >= SEQUENCE_DISABLE_FLAG && s <= 0xffffffff;
}

/**
 * The shape problems of a listing PSBT (hex) — [] when the order book
 * would accept its shape. Each entry is one plain sentence.
 */
export function listingShapeProblems(psbtHex) {
  let L;
  try {
    L = parseListing(psbtHex);
  } catch (e) {
    return [`the listing does not decode as a PSBT (${e?.message || e})`];
  }
  const out = [];
  if (L.inputCount !== 1 || L.outputCount !== 1) out.push(`a listing has exactly 1 input and 1 output (this one has ${L.inputCount} and ${L.outputCount})`);
  if (!LISTING_VERSIONS.includes(L.version)) out.push(`the transaction version is ${L.version}; only version 1 or 2 can be completed and relayed by a buyer`);
  const seq = L.input0?.sequence;
  if (!listingSequenceOk(seq)) out.push(`input 0 has sequence ${Number.isInteger(seq) ? hex32(seq) : "?"}, which sets a relative time lock; it must be ${hex32(SEQUENCE_DISABLE_FLAG)} or higher (e.g. 0xFFFFFFFF)`);
  if (L.lockTime !== 0) out.push(`the lock time is ${L.lockTime}; a listing must use lock time 0`);
  return out;
}

/**
 * May the seller publish a listing of an outpoint at `priceSats` for
 * `amount` tokens, given the outpoint's current `listing` (the OrderView
 * the book shows for it — open, filling, or an off-book "expired" row — or
 * null)? →
 *   { ok: true, kind: "new" | "same" | "lower", offBook? }
 *   { ok: false, kind: "raise" | "filling", current, offBook? }   — Withdraw first
 * An off-book listing guards its price like a live one (its signature can
 * still be filled), but a new listing of it takes a new place under the
 * per-address cap: `offBook: true`.
 */
export function relistDecision(listing, priceSats, amount) {
  const offBook = isOffBook(listing);
  if (!listing || (listing.status !== "open" && listing.status !== "filling" && !offBook)) return { ok: true, kind: "new" };
  if (listing.status === "filling") return { ok: false, kind: "filling", current: listing };
  const newUnit = Number(priceSats) / Number(amount);
  const curUnit = Number(listing.unit_price ?? Number(listing.price_sats) / Number(listing.amount));
  if (!Number.isFinite(newUnit) || !Number.isFinite(curUnit)) return { ok: true, kind: "new" };
  // Compare totals when the amounts match (no float noise); unit prices otherwise.
  const higher = Number(listing.amount) === Number(amount) ? Number(priceSats) > Number(listing.price_sats) : newUnit > curUnit + 1e-9;
  if (higher) return offBook ? { ok: false, kind: "raise", current: listing, offBook } : { ok: false, kind: "raise", current: listing };
  const same = Number(listing.amount) === Number(amount) ? Number(priceSats) === Number(listing.price_sats) : Math.abs(newUnit - curUnit) <= 1e-9;
  return offBook ? { ok: true, kind: same ? "same" : "lower", offBook } : { ok: true, kind: same ? "same" : "lower" };
}
