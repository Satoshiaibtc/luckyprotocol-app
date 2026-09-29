// Second source for a listing's outpoint.
//
// Checks 1–5 of PROTOCOL.md §7.2 all read the same indexer, so a
// compromised indexer plus a colluding seller could vouch for an outpoint
// that carries nothing. Before a fill is signed the app therefore asks a
// second, independent source — mempool.space's public API — two questions:
//
//   GET https://mempool.space/api/tx/<txid>/outspend/<vout>   → spent must be false
//   GET https://mempool.space/api/tx/<txid>                    → vout[<vout>].value must equal
//                                                                the listing's carrier_sats,
//                                                                vout[<vout>].scriptpubkey must
//                                                                equal its witnessUtxo script, and
//                                                                the tx's OP_RETURN, re-parsed,
//                                                                must credit this vout (§7.2 step 3)
//
// The OP_RETURN re-parse is what ties the outpoint to the TOKENS the
// indexer vouches for (§7.6): value + script alone say nothing about them.
// A MINE carrier is vout0 and its amount must be exactly what §3 credits
// for the yield recomputed from the confirming block hash: the full tier,
// or — only in the block that completed the supply (`capHeight`, the
// token's minted_out_height) — the partial credit min(tier, remaining), a
// positive multiple of 100 below the tier, which the second source cannot
// confirm ("unverified"); a full tier in a block after
// the cap block is a disagreement (§3 credits 0 there). A SEND carrier is
// either vout1 (AMT of the SEND's own ticker must equal `amount`) or vout2,
// the residual output (§2.3 / §4.1; the default output when vout2 is
// missing or an OP_RETURN), which receives the residual of EVERY ticker the
// inputs carried — so a residual of another ticker than the SEND's is a
// normal carrier too — whose balance depends on the inputs: only the index
// is checked ("unverified"). Any other vout, opcode, or no LUCKY-20 payload
// at all is a disagreement, and so is a listing of 0 tokens. So is an
// output that received a listing's tokens because the spend was not an
// applied SEND of its ticker (§4 rule 6): it is not a MINE or SEND token
// output.
//
// A MINE's vout0 or a SEND's vout1 whose creating tx has no output paying
// exactly 546 sats to the protocol fee address is a disagreement: that MINE
// credited nothing, and that SEND moved nothing to vout1. When input 1 of a
// creating SEND is signed as a listing (0x83), its vout1 may hold that
// listing's tokens instead of AMT, so the amount is not confirmed
// ("unverified").
//
// What the second source still cannot see: whether a MINE was valid for
// other reasons (its ticker's DEPLOY block is registry state) and whether a
// SEND's pool held AMT (token state). A creating SEND whose pool was short
// left vout1 empty; that case is left to the indexer (§7.6).
//
// Verdicts: "agree" (proceed), "unverified" (the outpoint agrees, but the
// second source cannot confirm the TOKEN AMOUNT on it — mempool.space sees
// no token balances: the UI says "amount not independently verified" and
// requires an extra explicit confirmation), "disagree"
// (hard stop — the two sources do not describe the same UTXO, or the
// amount is one the rules can never credit), "unreachable" (timeout /
// network error / server error / non-JSON — the UI shows a notice and
// requires an explicit tick to proceed on the indexer's word alone). A 404
// is a disagreement, not an outage: mempool.space has no record of the
// transaction the indexer says exists.
//
// Nothing but the txid and the vout ever goes into the URL; no headers, no
// credentials, no body. Pure comparison in `compareSecondSource` /
// `carrierAmountCheck`; the transport in `checkSecondSource` takes an
// injectable fetch for tests.

import { hex } from "@scure/base";
import { MINE_PROTOCOL_FEE_SATS, PROJECT_FEE_ADDRESS, SEND_PROTOCOL_FEE_SATS, SEND_RESIDUAL_VOUT, SEND_TO_VOUT } from "./payloads.js";
import { decodeAddress, protocolPayloadOfScripts } from "./psbt.js";
import { LISTING_SIGHASH_BYTE, inputSighash, scriptTypeOfHex } from "./sighash.js";
import { mineYield } from "./yield.js";

export const SECOND_SOURCE_ORIGIN = "https://mempool.space";
export const SECOND_SOURCE_NAME = "mempool.space";
export const SECOND_SOURCE_TIMEOUT_MS = 5_000;

const TXID_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]*$/;
const TICKER_RE = /^[A-Z0-9]{1,8}$/;
/** §3: every tier and the supply are multiples of 100, so every credit is too. */
const CREDIT_GRAIN = 100;

function checkOutpoint(txid, vout) {
  const t = String(txid || "").toLowerCase();
  const v = Number(vout);
  if (!TXID_RE.test(t)) throw new Error(`second source: invalid txid "${txid}"`);
  if (!Number.isInteger(v) || v < 0 || v > 1e6) throw new Error(`second source: invalid vout ${vout}`);
  return { txid: t, vout: v };
}

/** The two URLs for an outpoint — path segments only, never a query string. */
export function secondSourceUrls(txid, vout, origin = SECOND_SOURCE_ORIGIN) {
  const o = checkOutpoint(txid, vout);
  return {
    outspend: `${origin}/api/tx/${o.txid}/outspend/${o.vout}`,
    tx: `${origin}/api/tx/${o.txid}`,
  };
}

/**
 * The creating tx's LUCKY-20 payload as the indexer would read it (§2,
 * the lowest-index OP_RETURN whose single push parses), from
 * the explorer's `vout[].scriptpubkey` hex. Null when there is none.
 */
export function payloadOfTxVouts(vouts) {
  const scripts = [];
  for (const v of Array.isArray(vouts) ? vouts : []) {
    const spk = String((v && v.scriptpubkey) || "").toLowerCase();
    if (!HEX_RE.test(spk) || spk.length % 2 !== 0) {
      scripts.push(new Uint8Array());
      continue;
    }
    scripts.push(hex.decode(spk));
  }
  return protocolPayloadOfScripts(scripts).payload;
}

/**
 * Compare what the listing claims with what the second source answered.
 * `listing` = { txid, vout, carrierSats, scriptHex, ticker, amount,
 * capHeight? } (from the order id, the PSBT's witnessUtxo, the OrderView
 * and the token's `minted_out_height`); `outspend` / `tx` are the parsed
 * JSON bodies. Returns `{ verdict: "agree" | "unverified" | "disagree",
 * reasons: string[], notes: string[] }` — `reasons` are disagreements,
 * `notes` say why the amount could not be confirmed (set only when the
 * verdict is "unverified").
 */
export function compareSecondSource(listing, { outspend, tx }) {
  const { txid, vout } = checkOutpoint(listing.txid, listing.vout);
  const carrier = Number(listing.carrierSats);
  const script = String(listing.scriptHex || "").toLowerCase();
  const ticker = String(listing.ticker || "");
  const amount = Number(listing.amount);
  const reasons = [];
  const notes = [];
  if (!Number.isInteger(carrier) || carrier <= 0) reasons.push("listing has no carrier value to compare");
  if (!HEX_RE.test(script) || script.length === 0 || script.length % 2 !== 0) reasons.push("listing has no witnessUtxo script to compare");
  if (!TICKER_RE.test(ticker) || !Number.isInteger(amount)) reasons.push("listing has no ticker / amount to check the OP_RETURN against");
  else if (amount < 1) reasons.push("the listing carries 0 tokens — a zero-token carrier is never buyable");

  if (!outspend || typeof outspend !== "object") {
    reasons.push(`${SECOND_SOURCE_NAME} returned no outspend record for ${txid.slice(0, 8)}…:${vout}`);
  } else if (outspend.spent !== false) {
    const by = typeof outspend.txid === "string" && TXID_RE.test(outspend.txid.toLowerCase()) ? ` by ${outspend.txid.slice(0, 8)}…` : "";
    reasons.push(outspend.spent === true ? `${SECOND_SOURCE_NAME} says the outpoint is already spent${by}` : `${SECOND_SOURCE_NAME} did not answer whether the outpoint is spent`);
  }

  if (!tx || typeof tx !== "object" || !Array.isArray(tx.vout)) {
    reasons.push(`${SECOND_SOURCE_NAME} returned no transaction for ${txid.slice(0, 8)}…`);
  } else {
    if (typeof tx.txid === "string" && tx.txid.toLowerCase() !== txid) reasons.push(`${SECOND_SOURCE_NAME} answered for a different txid (${String(tx.txid).slice(0, 8)}…)`);
    const out = tx.vout[vout];
    if (!out || typeof out !== "object") {
      reasons.push(`${SECOND_SOURCE_NAME} shows only ${tx.vout.length} output(s) — vout ${vout} does not exist`);
    } else {
      const value = Number(out.value);
      if (value !== carrier) reasons.push(`${SECOND_SOURCE_NAME} shows ${Number.isFinite(value) ? value.toLocaleString("en-US") : "?"} sats on vout ${vout}, the listing says ${Number.isFinite(carrier) ? carrier.toLocaleString("en-US") : "?"}`);
      const spk = String(out.scriptpubkey || "").toLowerCase();
      if (spk !== script) reasons.push(`${SECOND_SOURCE_NAME} shows a different scriptPubKey on vout ${vout} than the listing's witnessUtxo`);
    }
    // §7.2 step 3 / §7.6: the OP_RETURN must say this vout carries the
    // tokens — the only thing here that speaks about tokens at all.
    if (TICKER_RE.test(ticker) && Number.isInteger(amount) && amount >= 1) {
      const v = carrierAmountCheck({ vout, ticker, amount, capHeight: listing.capHeight ?? null }, tx);
      for (const r of v.reasons) reasons.push(r);
      for (const n of v.notes) notes.push(n);
    }
  }
  const verdict = reasons.length ? "disagree" : notes.length ? "unverified" : "agree";
  return { verdict, reasons, notes: verdict === "unverified" ? notes : [] };
}

const isOpReturnVout = (v) => String((v && v.scriptpubkey) || "").toLowerCase().startsWith("6a");

let feeSpkHex = null;
/** Does the explorer's `vouts` list hold an output of exactly `sats` to PROJECT_FEE_ADDRESS (compared by script)? */
function paysProtocolFee(vouts, sats) {
  if (!feeSpkHex) feeSpkHex = hex.encode(decodeAddress(PROJECT_FEE_ADDRESS).script);
  return vouts.some((v) => String((v && v.scriptpubkey) || "").toLowerCase() === feeSpkHex && Number(v.value) === sats);
}

/** Is input `i` of the explorer's tx JSON signed as a listing (0x83, read like the indexer: §2, §4 rule 6)? */
function inputIsListingSigned(tx, i) {
  const vin = Array.isArray(tx?.vin) ? tx.vin[i] : null;
  if (!vin || !Array.isArray(vin.witness)) return false;
  return inputSighash(vin.witness, scriptTypeOfHex(vin.prevout?.scriptpubkey)) === LISTING_SIGHASH_BYTE;
}

/**
 * What the creating tx's OP_RETURN says about `amount` of `ticker` on
 * `vout` → `{ reasons, notes }`: a reason = a disagreement (the rules can
 * never put that amount there); a note = the second source cannot confirm
 * the amount (it depends on something mempool.space does not see). Both
 * empty = the payload alone proves the amount. `tx` is the explorer's tx
 * JSON (`vout[]`, `vin[].witness|prevout`, `status.block_hash` /
 * `status.block_height`);
 * `capHeight` is the block that completed the ticker's supply according
 * to the indexer (`minted_out_height`), or null when unknown.
 */
export function carrierAmountCheck({ vout, ticker, amount, capHeight = null }, tx) {
  const reasons = [];
  const notes = [];
  const done = () => ({ reasons, notes });
  if (!Number.isInteger(amount) || amount < 1) {
    reasons.push("the listing carries 0 tokens — a zero-token carrier is never buyable");
    return done();
  }
  const vouts = Array.isArray(tx?.vout) ? tx.vout : [];
  const p = payloadOfTxVouts(vouts);
  if (!p) {
    reasons.push(`${SECOND_SOURCE_NAME} shows no LUCKY-20 OP_RETURN on the creating tx — vout ${vout} is not a MINE or SEND token output`);
    return done();
  }
  if (p.op !== "MINE" && p.op !== "SEND") {
    reasons.push(`the creating tx is a ${p.op}, which credits no token output`);
    return done();
  }
  // The residual output (§2.3 / §4.1): vout2, or the default output (lowest
  // non-OP_RETURN) when vout2 is missing or an OP_RETURN.
  const residualUsable = !!vouts[SEND_RESIDUAL_VOUT] && !isOpReturnVout(vouts[SEND_RESIDUAL_VOUT]);
  const residualSlot = residualUsable ? SEND_RESIDUAL_VOUT : vouts.findIndex((v) => !isOpReturnVout(v));
  if (p.op === "SEND") {
    // §4.1: the residual of every ticker in the inputs lands on the residual
    // output, whatever ticker the SEND names — checked before the ticker.
    if (p.ticker !== ticker) {
      if (vout === residualSlot) {
        notes.push(`vout ${vout} is the residual output of a SEND of ${p.ticker}: it holds whatever ${ticker} the transaction's inputs carried, and ${SECOND_SOURCE_NAME} cannot see token balances`);
        return done();
      }
      reasons.push(`${SECOND_SOURCE_NAME} shows a SEND of ${p.ticker} whose ${ticker} residual goes to vout ${residualSlot}, the listing is vout ${vout}`);
      return done();
    }
  } else if (p.ticker !== ticker) {
    reasons.push(`${SECOND_SOURCE_NAME} shows an OP_RETURN for ${p.ticker}, the listing says ${ticker}`);
    return done();
  }

  if (p.op === "MINE") {
    if (vout !== 0) reasons.push(`a MINE credits vout 0, the listing is vout ${vout}`);
    else if (!paysProtocolFee(vouts, MINE_PROTOCOL_FEE_SATS)) {
      reasons.push(`the creating MINE has no ${MINE_PROTOCOL_FEE_SATS}-sat fee output, so it credited nothing to vout ${vout}`);
      return done();
    }
    const hash = tx.status && typeof tx.status.block_hash === "string" ? tx.status.block_hash : null;
    const height = tx.status && Number.isInteger(tx.status.block_height) ? tx.status.block_height : null;
    const cap = Number.isInteger(capHeight) && capHeight > 0 ? capHeight : null;
    const y = hash ? mineYield(hash) : null;
    if (y === null) {
      reasons.push(`${SECOND_SOURCE_NAME} does not show the MINE as confirmed — its yield cannot be recomputed`);
      return done();
    }
    const at = height !== null ? `#${height.toLocaleString("en-US")}` : "its block";
    const capAt = cap !== null ? `#${cap.toLocaleString("en-US")}` : "";
    if (amount === y) {
      // §3: once the supply is complete a MINE credits 0 — a full tier in a
      // block after the one that completed it is not a credit §3 gives.
      if (cap !== null && height !== null && height > cap) {
        reasons.push(`the MINE confirmed in block ${at}, after block ${capAt} completed the ${ticker} supply — §3 credits 0 there, the listing says ${amount}`);
      }
      return done();
    }
    const partial = amount > 0 && amount < y && amount % CREDIT_GRAIN === 0;
    if (!partial) {
      reasons.push(`block hash …${hash.slice(-1)} yields ${y} ${ticker} (§3), the listing says ${amount}`);
      return done();
    }
    // §3 partial credit, min(tier, remaining): only the MINE that completed
    // the supply gets it, so only in the cap block.
    if (cap !== null && height !== null && height !== cap) {
      reasons.push(`a MINE is credited less than its tier (${y}) only in the block that completed the ${ticker} supply (${capAt}); this one confirmed in block ${at}`);
      return done();
    }
    notes.push(
      `block hash …${hash.slice(-1)} yields a ${y} tier and the listing says ${amount}: the MINE that completed the ${ticker} supply is credited only what was left (§3), and ${SECOND_SOURCE_NAME} cannot see how much was left`,
    );
    return done();
  }

  if (p.op === "SEND") {
    if (vout === SEND_TO_VOUT) {
      const feePaid = paysProtocolFee(vouts, SEND_PROTOCOL_FEE_SATS);
      if (feePaid && p.amount === amount) {
        if (inputIsListingSigned(tx, SEND_TO_VOUT)) {
          notes.push(`input 1 of the creating tx is signed as a listing, so vout 1 may hold that listing's tokens rather than the amount the SEND names`);
        }
        return done();
      }
      if (vout === residualSlot && (!feePaid || amount > p.amount)) {
        notes.push(`the SEND's residual lands on vout ${vout} too (vout2 is unusable) — ${SECOND_SOURCE_NAME} cannot see how much the residual was`);
        return done();
      }
      if (!feePaid) {
        reasons.push(`the creating SEND has no ${SEND_PROTOCOL_FEE_SATS}-sat fee output, so it credited nothing to vout ${vout}`);
        return done();
      }
      reasons.push(`the SEND's OP_RETURN moves ${p.amount} ${ticker} to vout ${vout}, the listing says ${amount}`);
      return done();
    }
    if (vout === residualSlot) {
      notes.push(`vout ${vout} is the SEND's residual output (vout2): it holds whatever the transaction's inputs carried beyond the amount sent (all of it if the SEND did not apply), and ${SECOND_SOURCE_NAME} cannot see token balances`);
      return done();
    }
    reasons.push(`the SEND's OP_RETURN routes ${ticker} to vout ${SEND_TO_VOUT} and the residual to vout ${residualSlot} — vout ${vout} carries no tokens`);
    return done();
  }
  return done();
}

/**
 * Would a buyer's second-source check refuse this carrier because of where
 * it came from — a plain transfer with no LUCKY-20 payload, a DEPLOY
 * output, a listing's payment output, a MINE output holding more than its
 * yield, a SEND output that is neither vout1 nor the residual output, the
 * output of a MINE or SEND without its fee? `result` is what
 * checkSecondSource answered for the seller's own carrier. True only for a
 * "disagree" on the creating transaction; an unreachable source or a
 * mismatch of value / script / spent state says nothing about the origin.
 */
const ORIGIN_REASON_RE = /no LUCKY-20 OP_RETURN|the creating tx is a|shows a SEND of|OP_RETURN for|a MINE credits vout|credits 0 there|yields \d|less than its tier|OP_RETURN moves|OP_RETURN routes|has no 546-sat fee output/;
export function originRefused(result) {
  if (!result || result.verdict !== "disagree") return false;
  return (result.reasons || []).some((r) => ORIGIN_REASON_RE.test(String(r)));
}

/** The sell form's words for a carrier a buyer's check would refuse (originRefused). */
export const ORIGIN_REFUSED_TEXT =
  "Buyers cannot confirm where this UTXO's tokens came from: it was not created as a MINE's or a SEND's token output (a Bitcoin payment with no LUCKY-20 payload, a DEPLOY's output, a listing's payment output, the output of a MINE or SEND without its fee, or a mine that also received other tokens). A buyer's check refuses such a listing, so it would never sell. Move the tokens to a fresh carrier with a send to yourself first, then list that carrier once it confirms.";

/**
 * The sell form's view of the origin check for the selected carrier
 * (`check` = `{ key, refused, checking }` as the form keeps it, `sel` = the
 * selected row): `blocked` once the check answered that a buyer would
 * refuse this carrier, `pending` while it has not answered for THIS
 * carrier yet — signing waits for the answer. An unreachable source is an
 * answer too (it fails open), and a carrier that holds more than one
 * ticker is not checked.
 */
export function originCheckState(check, sel) {
  if (!sel || sel.multi) return { blocked: false, pending: false };
  const answered = !!check && check.key === sel.key && !check.checking;
  return { blocked: answered && !!check.refused, pending: !answered };
}

/**
 * May the buyer sign on this verdict? "agree" as is; "unverified" (amount
 * not independently verified) and "unreachable" (only the indexer
 * answered) each only with their own explicit confirmation; "disagree" and
 * anything else never.
 */
export function secondSourceAllowsSigning(verdict, { unverifiedAck = false, unreachableAck = false } = {}) {
  if (verdict === "agree") return true;
  if (verdict === "unverified") return unverifiedAck === true;
  if (verdict === "unreachable") return unreachableAck === true;
  return false;
}

async function readJson(res, what) {
  let body;
  try {
    body = await res.json();
  } catch {
    throw Object.assign(new Error(`${SECOND_SOURCE_NAME} ${what}: response is not JSON`), { unreachable: true });
  }
  return body;
}

/**
 * Ask the second source about a listing's outpoint. Resolves (never
 * rejects) to
 *
 *   { verdict: "agree" | "unverified" | "disagree" | "unreachable", reasons: string[], notes: string[], detail: string, urls }
 *
 * `fetchImpl` defaults to the global fetch; `timeoutMs` bounds BOTH requests
 * together (one AbortController). A 404 on either request is a
 * disagreement — even when the other request failed in transport, since
 * "no record of this tx" is an answer, not an outage; only when neither
 * is a 404 does a failure make the verdict "unreachable".
 */
export async function checkSecondSource(listing, { fetchImpl, timeoutMs = SECOND_SOURCE_TIMEOUT_MS, origin = SECOND_SOURCE_ORIGIN } = {}) {
  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  let urls;
  try {
    urls = secondSourceUrls(listing.txid, listing.vout, origin);
  } catch (e) {
    return { verdict: "disagree", reasons: [e.message], notes: [], detail: e.message, urls: null };
  }
  if (!f) return { verdict: "unreachable", reasons: [], notes: [], detail: "no fetch available in this environment", urls };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const get = async (url, what) => {
    let res;
    try {
      res = await f(url, { method: "GET", signal: ctrl.signal, credentials: "omit", cache: "no-store" });
    } catch (e) {
      const timedOut = ctrl.signal.aborted;
      throw Object.assign(new Error(timedOut ? `${SECOND_SOURCE_NAME} did not answer within ${Math.round(timeoutMs / 1000)} s` : `${SECOND_SOURCE_NAME} ${what}: ${e?.message || "network error"}`), { unreachable: true });
    }
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw Object.assign(new Error(`${SECOND_SOURCE_NAME} ${what}: HTTP ${res.status}`), { unreachable: true });
    return { body: await readJson(res, what) };
  };

  const [outspendSettled, txSettled] = await Promise.allSettled([get(urls.outspend, "outspend"), get(urls.tx, "tx")]);
  clearTimeout(timer);
  const outspendRes = outspendSettled.status === "fulfilled" ? outspendSettled.value : null;
  const txRes = txSettled.status === "fulfilled" ? txSettled.value : null;

  // A 404 is a verdict and wins over the other request's outage.
  const notFound = [];
  if (outspendRes?.notFound) notFound.push(`${SECOND_SOURCE_NAME} has no record of outpoint ${String(listing.txid).slice(0, 8)}…:${listing.vout}`);
  if (txRes?.notFound) notFound.push(`${SECOND_SOURCE_NAME} has no record of transaction ${String(listing.txid).slice(0, 8)}…`);
  if (notFound.length) return { verdict: "disagree", reasons: notFound, notes: [], detail: notFound.join("; "), urls };

  const failed = [outspendSettled, txSettled].find((r) => r.status === "rejected");
  if (failed) return { verdict: "unreachable", reasons: [], notes: [], detail: failed.reason?.message || String(failed.reason), urls };

  const cmp = compareSecondSource(listing, { outspend: outspendRes.body, tx: txRes.body });
  const same = `unspent, ${Number(listing.carrierSats).toLocaleString("en-US")} sats, same script, OP_RETURN credits vout ${listing.vout}`;
  return {
    verdict: cmp.verdict,
    reasons: cmp.reasons,
    notes: cmp.notes,
    detail:
      cmp.verdict === "agree"
        ? `${SECOND_SOURCE_NAME} agrees: ${same}`
        : cmp.verdict === "unverified"
          ? `${SECOND_SOURCE_NAME} agrees on the outpoint (${same}) but cannot confirm the amount: ${cmp.notes.join("; ")}`
          : cmp.reasons.join("; "),
    urls,
  };
}
