// Second source for a listing's outpoint (audit M-12).
//
// Checks 1–5 of PROTOCOL-v3.md §7.2 all read the same indexer, so a
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
// A MINE carrier is vout0 and the yield recomputed from the confirming
// block hash (§3) must equal `amount`; a SEND carrier is either TO_OUT
// (AMT must equal `amount`) or the CHANGE_OUT residual slot (§2.3 / §4.1,
// whose balance depends on the inputs — only the slot is checked). Any
// other vout, opcode, or no LUCKY-20 payload at all is a disagreement.
//
// Verdicts: "agree" (proceed), "disagree" (hard stop — the two sources do
// not describe the same UTXO), "unreachable" (timeout / network error /
// server error / non-JSON — the UI shows a notice and requires an explicit
// tick to proceed on the indexer's word alone). A 404 is a disagreement,
// not an outage: mempool.space has no record of the transaction the
// indexer says exists.
//
// Nothing but the txid and the vout ever goes into the URL; no headers, no
// credentials, no body. Pure comparison in `compareSecondSource`; the
// transport in `checkSecondSource` takes an injectable fetch for tests.

import { hex } from "@scure/base";
import { protocolPayloadOfScripts } from "./psbt.js";
import { mineYield } from "./yield.js";

export const SECOND_SOURCE_ORIGIN = "https://mempool.space";
export const SECOND_SOURCE_NAME = "mempool.space";
export const SECOND_SOURCE_TIMEOUT_MS = 5_000;

const TXID_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]*$/;
const TICKER_RE = /^[A-Z0-9]{1,8}$/;

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
 * audit M-3: the lowest-index OP_RETURN whose single push parses), from
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
 * `listing` = { txid, vout, carrierSats, scriptHex, ticker, amount } (from
 * the order id, the PSBT's witnessUtxo and the OrderView); `outspend` /
 * `tx` are the parsed JSON bodies. Returns `{ verdict: "agree" |
 * "disagree", reasons: string[] }`.
 */
export function compareSecondSource(listing, { outspend, tx }) {
  const { txid, vout } = checkOutpoint(listing.txid, listing.vout);
  const carrier = Number(listing.carrierSats);
  const script = String(listing.scriptHex || "").toLowerCase();
  const ticker = String(listing.ticker || "");
  const amount = Number(listing.amount);
  const reasons = [];
  if (!Number.isInteger(carrier) || carrier <= 0) reasons.push("listing has no carrier value to compare");
  if (!HEX_RE.test(script) || script.length === 0 || script.length % 2 !== 0) reasons.push("listing has no witnessUtxo script to compare");
  if (!TICKER_RE.test(ticker) || !Number.isInteger(amount) || amount < 1) reasons.push("listing has no ticker / amount to check the OP_RETURN against");

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
      for (const r of opReturnReasons({ vout, ticker, amount }, tx)) reasons.push(r);
    }
  }
  return { verdict: reasons.length ? "disagree" : "agree", reasons };
}

function opReturnReasons({ vout, ticker, amount }, tx) {
  const p = payloadOfTxVouts(tx.vout);
  if (!p) return [`${SECOND_SOURCE_NAME} shows no LUCKY-20 OP_RETURN on the creating tx — vout ${vout} is not a MINE or SEND token output`];
  if (p.ticker !== ticker) return [`${SECOND_SOURCE_NAME} shows an OP_RETURN for ${p.ticker}, the listing says ${ticker}`];
  if (p.op === "MINE") {
    const out = [];
    if (vout !== 0) out.push(`a MINE credits vout 0, the listing is vout ${vout}`);
    const hash = tx.status && typeof tx.status.block_hash === "string" ? tx.status.block_hash : null;
    const y = hash ? mineYield(hash) : null;
    if (y === null) out.push(`${SECOND_SOURCE_NAME} does not show the MINE as confirmed — its yield cannot be recomputed`);
    else if (y !== amount) out.push(`block hash …${hash.slice(-1)} yields ${y} ${ticker} (§3), the listing says ${amount}`);
    return out;
  }
  if (p.op === "SEND") {
    if (vout === p.toOutIdx) return p.amount === amount ? [] : [`the SEND's OP_RETURN moves ${p.amount} ${ticker} to vout ${vout}, the listing says ${amount}`];
    if (vout === p.changeOutIdx) return []; // the residual slot (§2.3 / §4.1): its balance depends on the inputs
    return [`the SEND's OP_RETURN routes ${ticker} to vout ${p.toOutIdx} and the residual to vout ${p.changeOutIdx} — vout ${vout} carries no tokens`];
  }
  return [`the creating tx is a ${p.op}, which credits no token output`];
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
 *   { verdict: "agree" | "disagree" | "unreachable", reasons: string[], detail: string, urls }
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
    return { verdict: "disagree", reasons: [e.message], detail: e.message, urls: null };
  }
  if (!f) return { verdict: "unreachable", reasons: [], detail: "no fetch available in this environment", urls };

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
  if (notFound.length) return { verdict: "disagree", reasons: notFound, detail: notFound.join("; "), urls };

  const failed = [outspendSettled, txSettled].find((r) => r.status === "rejected");
  if (failed) return { verdict: "unreachable", reasons: [], detail: failed.reason?.message || String(failed.reason), urls };

  const cmp = compareSecondSource(listing, { outspend: outspendRes.body, tx: txRes.body });
  return {
    verdict: cmp.verdict,
    reasons: cmp.reasons,
    detail: cmp.verdict === "agree" ? `${SECOND_SOURCE_NAME} agrees: unspent, ${Number(listing.carrierSats).toLocaleString("en-US")} sats, same script, OP_RETURN credits vout ${listing.vout}` : cmp.reasons.join("; "),
    urls,
  };
}
