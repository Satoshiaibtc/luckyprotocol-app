// The indexer's error bodies → one readable sentence — pure, shared by the
// HTTP transport (src/lib/indexer.js) and the mock (src/lib/mock.js), tested
// in test/views.test.js.
//
// Trading routes answer `{ "error": "…" }`; /broadcast answers plain text.
// Showing the raw body put JSON punctuation and an HTTP prefix in front of
// a seller, and cutting it at 200 characters broke longer refusals
// mid-sentence (audit market-6).

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
