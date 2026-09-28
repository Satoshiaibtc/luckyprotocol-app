// Fee-rate choice: presets from the indexer's /fees plus a custom rate.
// Pure and window-free so test/wallet.test.js can exercise it in Node;
// src/hooks/useFeeRate.js owns the localStorage side.
//
// Stored form ('lp.feeChoice'): a preset id ("fast" | "normal" | "slow" |
// "economy") or the custom rate as a decimal string ("27" or "1.25").

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
 * The one gate every builder / action uses before it spends: a finite
 * sat/vB inside [MIN_FEE_RATE_SAT_VB, MAX_FEE_RATE_SAT_VB]. Rates are
 * fractional (the indexer's /fees returns hundredths, e.g. 1.02), so an
 * integer check would refuse most real quotes.
 */
export function isUsableFeeRate(v) {
  return Number.isFinite(v) && v >= MIN_FEE_RATE_SAT_VB && v <= MAX_FEE_RATE_SAT_VB;
}

/**
 * Validate a custom rate the user typed. Returns `{ value, error }`:
 * `value` is the rate that will be USED, or null when nothing usable was
 * entered; `error` is the inline message or null. A rate outside
 * [1, cap] is UNUSABLE (null), never clamped: a typo such as 5000 for 50
 * must not quietly become the 1,000 sat/vB cap and a ~227,000-sat MINE fee
 * — the same rule the presets follow (audit L-11, usertx-8).
 */
export function clampCustomFee(input, cap = MAX_FEE_RATE_SAT_VB) {
  const text = String(input ?? "").trim();
  if (text === "") return { value: null, error: `Enter a fee rate, ${MIN_FEE_RATE_SAT_VB}–${cap.toLocaleString("en-US")} sat/vB.` };
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return { value: null, error: "Enter a valid fee rate." };
  const n = Number(text);
  if (!Number.isFinite(n)) return { value: null, error: "Enter a valid fee rate." };
  if (n < MIN_FEE_RATE_SAT_VB) return { value: null, error: `Below the ${MIN_FEE_RATE_SAT_VB} sat/vB minimum — enter ${MIN_FEE_RATE_SAT_VB}–${cap.toLocaleString("en-US")} sat/vB.` };
  if (n > cap) return { value: null, error: `Above the ${cap.toLocaleString("en-US")} sat/vB safety cap — not used. Enter ${MIN_FEE_RATE_SAT_VB}–${cap.toLocaleString("en-US")} sat/vB.` };
  if ((text.split(".")[1] || "").length > 2) return { value: null, error: "Use at most 2 decimal places." };
  return { value: n, error: null };
}

/**
 * Parse the stored string → `{ kind: "preset", id }` | `{ kind: "custom", value }`.
 * Anything malformed — including a stored custom value outside [1, cap]
 * from an older build — falls back to the default preset.
 */
export function parseFeeChoice(raw) {
  if (isPresetId(raw)) return { kind: "preset", id: raw };
  if (typeof raw === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim())) {
    const { value } = clampCustomFee(raw);
    if (value !== null) return { kind: "custom", value };
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const { value } = clampCustomFee(String(raw));
    if (value !== null) return { kind: "custom", value };
  }
  return { kind: "preset", id: DEFAULT_PRESET };
}

export function serializeFeeChoice(choice) {
  if (!choice) return DEFAULT_PRESET;
  if (choice.kind === "custom" && Number.isFinite(choice.value)) return String(choice.value);
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
  if (!Number.isFinite(v) || v < MIN_FEE_RATE_SAT_VB) return "missing";
  if (v > MAX_FEE_RATE_SAT_VB) return "over-cap";
  return null;
}

/**
 * The sat/vB to use for a choice given the latest /fees read (may be null
 * when the indexer is unreachable). A preset without fee data — or with a
 * value above the safety cap — resolves to null: the caller disables the
 * action until the user picks Custom. A Custom value outside [1, cap]
 * resolves to null as well.
 */
export function resolveFeeRate(choice, feesData) {
  if (!choice) return null;
  if (choice.kind === "custom") return isUsableFeeRate(choice.value) ? choice.value : null;
  if (presetUnavailableReason(choice.id, feesData) !== null) return null;
  const preset = FEE_PRESETS.find((p) => p.id === choice.id);
  return Number(feesData[preset.key]);
}

/**
 * Why there is no usable fee rate right now (for the idle status line),
 * or null when `satVb` is set. `action` completes the sentence ("mine").
 */
export function missingFeeHint(choice, satVb, action = "continue", { awaitingAck = false } = {}) {
  if (Number.isFinite(satVb) && satVb >= MIN_FEE_RATE_SAT_VB) return null;
  if (choice && choice.kind === "custom" && awaitingAck) return `Confirm the high custom fee rate under "Fee rate" to ${action}.`;
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

// ---- high custom rates need an explicit confirmation (audit usertx-8) ------------------------------------

/** A custom rate at or below this never asks for confirmation, whatever the estimates say. */
export const HIGH_FEE_MIN_SAT_VB = 50;
/** …and above this multiple of the indexer's fastest estimate it does. */
export const HIGH_FEE_FASTEST_MULTIPLE = 2;

/** The custom rate above which the user must confirm: max(50, 2 × fastestFee). */
export function highFeeThreshold(feesData) {
  const fastest = Number(feesData && feesData.fastestFee);
  const fromEstimate = isUsableFeeRate(fastest) ? fastest * HIGH_FEE_FASTEST_MULTIPLE : 0;
  return Math.max(HIGH_FEE_MIN_SAT_VB, fromEstimate);
}

/**
 * Does this custom `value` need an explicit "use it anyway"? Only for a
 * usable rate above highFeeThreshold — presets never do (they are the
 * indexer's own estimates, rejected above the cap).
 */
export function needsHighFeeAck(value, feesData) {
  return isUsableFeeRate(value) && value > highFeeThreshold(feesData);
}
