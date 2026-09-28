// Ticker text boxes — pure, tested in test/payloads.test.js.
//
// A ticker is 1–8 characters, A–Z and 0–9 (spec §2.1). What a person types
// or pastes is cleaned FIRST and cut to 8 AFTER: an input-level maxLength
// would cut a pasted "    LUCKY" to "    LUCK" before the spaces are
// stripped and silently leave "LUCK" — a different, free name (audit
// create-5). Any change beyond upper-casing is said out loud (`note`).

export const TICKER_MAX = 8;

/**
 * `raw` text → `{ ticker, note }`: `ticker` upper-cased, only A–Z / 0–9,
 * at most 8 characters; `note` a plain sentence when characters were
 * removed or the name was cut, else null.
 */
export function cleanTickerInput(raw) {
  const upper = String(raw ?? "").toUpperCase();
  const stripped = upper.replace(/[^A-Z0-9]/g, "");
  const ticker = stripped.slice(0, TICKER_MAX);
  const removed = stripped.length < upper.length;
  const cut = stripped.length > TICKER_MAX;
  let note = null;
  if (removed && cut) note = `Spaces and symbols were removed and the name was cut to ${TICKER_MAX} characters: ${ticker}.`;
  else if (removed) note = "Spaces and symbols were removed — a ticker uses only A–Z and 0–9.";
  else if (cut) note = `Cut to ${TICKER_MAX} characters: ${ticker}.`;
  return { ticker, note };
}

/**
 * Where the caret belongs in the cleaned value when it stood at `caret` in
 * `raw`: the length of the cleaned text before it. Keeps the cursor in
 * place when a lower-case letter typed mid-word is upper-cased (audit
 * create-9).
 */
export function cleanedCaret(raw, caret) {
  const text = String(raw ?? "");
  const at = Number.isInteger(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length;
  return Math.min(cleanTickerInput(text.slice(0, at)).ticker.length, cleanTickerInput(text).ticker.length);
}
