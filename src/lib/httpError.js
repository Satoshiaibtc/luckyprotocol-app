// The indexer's error bodies → one readable sentence — pure, shared by the
// HTTP transport (src/lib/indexer.js) and the mock (src/lib/mock.js), tested
// in test/views.test.js.
//
// Trading routes answer `{ "error": "…" }`; /broadcast answers plain text.
// Showing the raw body would put JSON punctuation and an HTTP prefix in
// front of a seller, and cutting it at 200 characters would break longer
// refusals mid-sentence.

/** Longest error text kept; longer bodies are cut at a word boundary with "…". */
export const MAX_ERROR_TEXT = 600;

/** `{ "error": "sentence" }` or plain text → the sentence ("" for an empty body). */
export function serverErrorText(body) {
  const text = String(body ?? "").trim();
  if (!text) return "";
  let out = text;
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j.error === "string" && j.error.trim()) out = j.error.trim();
      else if (j && typeof j.message === "string" && j.message.trim()) out = j.message.trim();
    } catch {
      /* not JSON after all — keep the text */
    }
  }
  if (out.length <= MAX_ERROR_TEXT) return out;
  const cut = out.slice(0, MAX_ERROR_TEXT);
  const at = cut.lastIndexOf(" ");
  return `${at > MAX_ERROR_TEXT / 2 ? cut.slice(0, at) : cut}…`;
}

/** Plain-text 429 bodies of an indexer that predates the JSON reason. */
const SEED_REASON_TEXT = [
  [/too many new wallet scans/i, "client_limit"],
  [/queue is full/i, "queue_full"],
];

/**
 * The first-use UTXO-scan fields of a `/btc-utxos` 503 / 429 body →
 * `{ queuePosition, etaSecs, reason }`, each null when absent or malformed:
 * `queue_position` (0 = in the scan pass that is running, n = addresses
 * ahead), `eta_secs` (the indexer's estimate in seconds, or null) and
 * `reason` ("client_limit": this network started too many new scans lately;
 * "queue_full": the scan queue has no room). A plain-text body (an indexer
 * that answers without JSON) still gives its reason when it names one.
 */
export function seedWaitFields(body) {
  const out = { queuePosition: null, etaSecs: null, reason: null };
  const text = String(body ?? "").trim();
  if (!text) return out;
  let j = null;
  if (text.startsWith("{")) {
    try {
      j = JSON.parse(text);
    } catch {
      j = null;
    }
  }
  if (j && typeof j === "object") {
    const pos = j.queue_position;
    if (Number.isSafeInteger(pos) && pos >= 0) out.queuePosition = pos;
    const eta = j.eta_secs;
    if (typeof eta === "number" && Number.isFinite(eta) && eta >= 0 && eta <= 86_400) out.etaSecs = eta;
    if (j.reason === "client_limit" || j.reason === "queue_full") out.reason = j.reason;
    return out;
  }
  for (const [re, reason] of SEED_REASON_TEXT) {
    if (re.test(text)) {
      out.reason = reason;
      break;
    }
  }
  return out;
}
