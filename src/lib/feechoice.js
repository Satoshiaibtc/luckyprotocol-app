// Fee-rate choice: presets from the indexer's /fees plus a custom rate.
// Pure and window-free so test/wallet.test.js can exercise it in Node;
// src/hooks/useFeeRate.js owns the localStorage side.
//
// Stored form ('lp.feeChoice'): a preset id ("fast" | "normal" | "slow" |
// "economy") or the custom rate as a decimal string ("27").

import { MAX_FEE_RATE_SAT_VB } from "./psbt.js";

export const FEE_CHOICE_KEY = "lp.feeChoice";
export const MIN_FEE_RATE_SAT_VB = 1;
export const DEFAULT_PRESET = "normal";

export const FEE_PRESETS = [
  { id: "fast", label: "Fast", key: "fastestFee", eta: "~10 min" },
  { id: "normal", label: "Normal", key: "halfHourFee", eta: "~30 min" },
  { id: "slow", label: "Slow", key: "hourFee", eta: "~1 h" },
  { id: "economy", label: "Economy", key: "economyFee", eta: "> 1 h" },
];

const PRESET_IDS = new Set(FEE_PRESETS.map((p) => p.id));

export function isPresetId(id) {
  return typeof id === "string" && PRESET_IDS.has(id);
}

/**
 * Validate a custom rate the user typed. Returns `{ value, error }`:
 * `value` is the integer that will be USED (clamped into [1, cap]) or null
 * when nothing usable was entered; `error` is the inline message or null.
 */
export function clampCustomFee(input, cap = MAX_FEE_RATE_SAT_VB) {
  const text = String(input ?? "").trim();
  if (text === "") return { value: null, error: `Enter a whole number, ${MIN_FEE_RATE_SAT_VB}–${cap.toLocaleString("en-US")} sat/vB.` };
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { value: null, error: "Whole numbers only." };
  const n = Number(text);
  if (!Number.isFinite(n)) return { value: null, error: "Whole numbers only." };
  if (!Number.isInteger(n)) {
    const v = Math.floor(n);
    if (v < MIN_FEE_RATE_SAT_VB) return { value: MIN_FEE_RATE_SAT_VB, error: `Minimum is ${MIN_FEE_RATE_SAT_VB} sat/vB.` };
    if (v > cap) return { value: cap, error: `Capped at ${cap.toLocaleString("en-US")} sat/vB (safety limit).` };
    return { value: v, error: `Whole numbers only — using ${v}.` };
  }
  if (n < MIN_FEE_RATE_SAT_VB) return { value: MIN_FEE_RATE_SAT_VB, error: `Minimum is ${MIN_FEE_RATE_SAT_VB} sat/vB.` };
  if (n > cap) return { value: cap, error: `Capped at ${cap.toLocaleString("en-US")} sat/vB (safety limit).` };
  return { value: n, error: null };
}

/**
 * Parse the stored string → `{ kind: "preset", id }` | `{ kind: "custom", value }`.
 * Anything malformed falls back to the default preset; a stored custom
 * value is re-clamped so an old out-of-range entry can never exceed the cap.
 */
export function parseFeeChoice(raw) {
  if (isPresetId(raw)) return { kind: "preset", id: raw };
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const { value } = clampCustomFee(raw);
    if (value !== null) return { kind: "custom", value };
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const { value } = clampCustomFee(String(Math.floor(raw)));
    if (value !== null) return { kind: "custom", value };
  }
  return { kind: "preset", id: DEFAULT_PRESET };
}

export function serializeFeeChoice(choice) {
  if (!choice) return DEFAULT_PRESET;
  if (choice.kind === "custom" && Number.isInteger(choice.value)) return String(choice.value);
  if (choice.kind === "preset" && isPresetId(choice.id)) return choice.id;
  return DEFAULT_PRESET;
}

/**
 * Why a preset has no usable rate: 'missing' (no /fees, or the key is
 * absent / malformed), 'over-cap' (the indexer's value exceeds the
 * MAX_FEE_RATE_SAT_VB safety cap — a wrong estimate is REJECTED, never
 * clamped to a number that still overpays; audit L-11), or null when it
 * resolves.
 */
export function presetUnavailableReason(id, feesData) {
  const preset = FEE_PRESETS.find((p) => p.id === id);
  if (!preset || !feesData) return "missing";
  const v = Number(feesData[preset.key]);
  if (!Number.isInteger(v) || v < MIN_FEE_RATE_SAT_VB) return "missing";
  if (v > MAX_FEE_RATE_SAT_VB) return "over-cap";
  return null;
}

/**
 * The sat/vB to use for a choice given the latest /fees read (may be null
 * when the indexer is unreachable). A preset without fee data — or with a
 * value above the safety cap — resolves to null: the caller disables the
 * action until the user picks Custom. Only the explicitly typed Custom
 * value is clamped.
 */
export function resolveFeeRate(choice, feesData) {
  if (!choice) return null;
  if (choice.kind === "custom") return Number.isInteger(choice.value) ? Math.min(MAX_FEE_RATE_SAT_VB, Math.max(MIN_FEE_RATE_SAT_VB, choice.value)) : null;
  if (presetUnavailableReason(choice.id, feesData) !== null) return null;
  const preset = FEE_PRESETS.find((p) => p.id === choice.id);
  return Number(feesData[preset.key]);
}

/**
 * Why there is no usable fee rate right now (for the idle status line),
 * or null when `satVb` is set. `action` completes the sentence ("mine").
 */
export function missingFeeHint(choice, satVb, action = "continue") {
  if (Number.isInteger(satVb) && satVb >= MIN_FEE_RATE_SAT_VB) return null;
  if (choice && choice.kind === "custom") return `Enter a custom fee rate (${MIN_FEE_RATE_SAT_VB}–${MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")} sat/vB) to ${action}.`;
  return `No fee estimate from the indexer — choose Custom and enter a sat/vB to ${action}.`;
}

/** Preset rows for the selector: `{ id, label, eta, satVb | null, reason: null | 'missing' | 'over-cap' }`. */
export function presetRows(feesData) {
  return FEE_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    eta: p.eta,
    satVb: resolveFeeRate({ kind: "preset", id: p.id }, feesData),
    reason: presetUnavailableReason(p.id, feesData),
  }));
}

/** Short reason text for a preset without a rate (tooltip / note). */
export function presetUnavailableText(reason) {
  if (reason === "over-cap") return `estimate unavailable — the indexer's value is above the ${MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")} sat/vB safety cap and looks wrong`;
  if (reason === "missing") return "estimate unavailable";
  return null;
}
