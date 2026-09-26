// Second source for a listing's outpoint (audit M-12).
//
// Checks 1–5 of PROTOCOL-v3.md §7.2 all read the same indexer, so a
// compromised indexer plus a colluding seller could vouch for an outpoint
// that carries nothing. Before a fill is signed the app therefore asks a
// second, independent source — mempool.space's public API — two questions:
//
//   GET https://mempool.space/api/tx/<txid>/outspend/<vout>   → spent must be false
//   GET https://mempool.space/api/tx/<txid>                    → vout[<vout>].value must equal
//                                                                the listing's carrier_sats and
//                                                                vout[<vout>].scriptpubkey must
//                                                                equal its witnessUtxo script
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

export const SECOND_SOURCE_ORIGIN = "https://mempool.space";
export const SECOND_SOURCE_NAME = "mempool.space";
export const SECOND_SOURCE_TIMEOUT_MS = 5_000;

const TXID_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]*$/;

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
 * Compare what the listing claims with what the second source answered.
 * `listing` = { txid, vout, carrierSats, scriptHex } (from the order id and
 * the PSBT's witnessUtxo); `outspend` / `tx` are the parsed JSON bodies.
 * Returns `{ verdict: "agree" | "disagree", reasons: string[] }`.
 */
export function compareSecondSource(listing, { outspend, tx }) {
  const { txid, vout } = checkOutpoint(listing.txid, listing.vout);
  const carrier = Number(listing.carrierSats);
  const script = String(listing.scriptHex || "").toLowerCase();
  const reasons = [];
  if (!Number.isInteger(carrier) || carrier <= 0) reasons.push("listing has no carrier value to compare");
  if (!HEX_RE.test(script) || script.length === 0 || script.length % 2 !== 0) reasons.push("listing has no witnessUtxo script to compare");

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
  }
  return { verdict: reasons.length ? "disagree" : "agree", reasons };
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
 * disagreement; any other failure is "unreachable".
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

  let outspendRes;
  let txRes;
  try {
    [outspendRes, txRes] = await Promise.all([get(urls.outspend, "outspend"), get(urls.tx, "tx")]);
  } catch (e) {
    clearTimeout(timer);
    return { verdict: "unreachable", reasons: [], detail: e.message || String(e), urls };
  }
  clearTimeout(timer);

  const notFound = [];
  if (outspendRes.notFound) notFound.push(`${SECOND_SOURCE_NAME} has no record of outpoint ${String(listing.txid).slice(0, 8)}…:${listing.vout}`);
  if (txRes.notFound) notFound.push(`${SECOND_SOURCE_NAME} has no record of transaction ${String(listing.txid).slice(0, 8)}…`);
  if (notFound.length) return { verdict: "disagree", reasons: notFound, detail: notFound.join("; "), urls };

  const cmp = compareSecondSource(listing, { outspend: outspendRes.body, tx: txRes.body });
  return {
    verdict: cmp.verdict,
    reasons: cmp.reasons,
    detail: cmp.verdict === "agree" ? `${SECOND_SOURCE_NAME} agrees: unspent, ${Number(listing.carrierSats).toLocaleString("en-US")} sats, same script` : cmp.reasons.join("; "),
    urls,
  };
}
