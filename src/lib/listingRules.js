// The order book's listing acceptance rules the app checks BEFORE a listing
// is signed or published (PROTOCOL.md §7.4, owner decision D, audits
// trading-1 / trading-4) — pure, unit-tested in test/listingrules.test.js.
//
//   trading-1  a listing no fill could ever relay is refused: the unsigned
//              tx's nVersion must be 1 or 2, input 0's nSequence must have
//              the relative-lock-time disable bit set (≥ 0x80000000, which
//              covers 0xFFFFFFFD / 0xFFFFFFFE / 0xFFFFFFFF), nLockTime 0,
//              exactly 1 input + 1 output. The seller's 0x83 signature
//              commits to all of these, so a buyer cannot repair them.
//   trading-4  per outpoint the book keeps the CHEAPEST live signed
//              listing: a signed listing is a bearer instrument that stays
//              fillable on-chain, so a higher re-listing would show a price
//              nobody has to pay. Raising the price therefore means
//              Withdraw first (move the tokens on-chain), then list the new
//              carrier; the same or a lower price replaces the listing.
//              The indexer keeps guarding it after the book dropped the
//              listing (TTL, eviction — the "listing floor", audit rvs-3).
//   rvs-2      the first output of a step-1 reservation (COMMIT) that can
//              still be published is never listed: a listing's signature
//              covers only that output and the payment, so a buyer could
//              publish the reserved ticker with the seller named creator.

//   cap        one seller address may hold at most MAX_OPEN_LISTINGS_PER_ADDRESS
//              OPEN listings at a time, across every ticker (spec §7.4
//              "Per-seller cap"). A listing of an outpoint that already
//              has an open listing replaces it and takes no extra place.

import { parseListing } from "./swap.js";

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
  return `This address already has ${have}. To list another UTXO, withdraw one of your listings (the Portfolio page shows all of them), or wait until one sells or expires. A UTXO that is already listed can still be listed again at the same or a lower price.`;
}

/**
 * Every order `address` has in the book, read page by page through
 * `fetchPage(offset, limit)` → `{ total, items }` (indexer.ordersByAddress).
 * The indexer lists them newest first, at most 200 a page, so an old open
 * listing can sit behind many closed ones: pages are read until `total` is
 * reached, at most `maxPages`. `complete: false` = some rows were not read,
 * so a count made from `items` is a lower bound.
 */
export async function readSellerOrders(fetchPage, { pageSize = 200, maxPages = 10 } = {}) {
  const items = [];
  for (let n = 0, offset = 0; n < maxPages; n++, offset += pageSize) {
    const pg = await fetchPage(offset, pageSize);
    const got = Array.isArray(pg?.items) ? pg.items : [];
    items.push(...got);
    const total = Number(pg?.total);
    const more = Number.isFinite(total) ? offset + pageSize < total : got.length >= pageSize;
    if (!more) return { items, complete: true };
    if (!got.length) return { items, complete: false };
  }
  return { items, complete: false };
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

/** The order book's exact trading-4 refusal (a higher price for a listed outpoint). */
export const WITHDRAW_FIRST_TEXT = "withdraw first: the cheaper signed listing stays fillable on-chain";

/** The order book's exact rvs-2 refusal (the first output of an open reservation). */
export const COMMIT_CARRIER_LISTING_TEXT =
  "outpoint reserves a ticker (the output of an open COMMIT, step 1 of a deploy): a listing of it would let the buyer publish that ticker with you named as its creator. Move it with a send to yourself, or publish your ticker, before listing";

/** The same rule in plain words for the sell form (audit rvs-2). */
export const COMMIT_CARRIER_PLAIN_TEXT =
  "This output holds a ticker reservation: it is the first output of a step 1 (Reserve) transaction that can still be published. A listing's signature covers only this output and your payment, so a buyer could use it to publish that reserved ticker with you named as its creator. Move it with a send to yourself (or publish your own reservation) before listing it.";

/**
 * Why outpoint `vout` of a tx whose /commits record is `commit` (a
 * CommitView, or null when the tx is not a recorded COMMIT) must not be
 * listed — or null. Only vout 0 of a COMMIT whose status is `open` and
 * whose window has not passed at `tip` (when known) is refused.
 */
export function commitCarrierProblem(vout, commit, tip = null) {
  if (Number(vout) !== 0 || !commit || commit.status !== "open") return null;
  if (Number.isInteger(tip) && Number.isInteger(commit.expires_at_height) && tip >= commit.expires_at_height) return null;
  return COMMIT_CARRIER_PLAIN_TEXT;
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
 * The trading-1 problems of a listing PSBT (hex) — [] when the order book
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
 * the book shows for it, or null)? →
 *   { ok: true, kind: "new" | "same" | "lower" }
 *   { ok: false, kind: "raise" | "filling", current }   — Withdraw first
 */
export function relistDecision(listing, priceSats, amount) {
  if (!listing || (listing.status !== "open" && listing.status !== "filling")) return { ok: true, kind: "new" };
  if (listing.status === "filling") return { ok: false, kind: "filling", current: listing };
  const newUnit = Number(priceSats) / Number(amount);
  const curUnit = Number(listing.unit_price ?? Number(listing.price_sats) / Number(listing.amount));
  if (!Number.isFinite(newUnit) || !Number.isFinite(curUnit)) return { ok: true, kind: "new" };
  // Compare totals when the amounts match (no float noise); unit prices otherwise.
  const higher = Number(listing.amount) === Number(amount) ? Number(priceSats) > Number(listing.price_sats) : newUnit > curUnit + 1e-9;
  if (higher) return { ok: false, kind: "raise", current: listing };
  const same = Number(listing.amount) === Number(amount) ? Number(priceSats) === Number(listing.price_sats) : Math.abs(newUnit - curUnit) <= 1e-9;
  return { ok: true, kind: same ? "same" : "lower" };
}
