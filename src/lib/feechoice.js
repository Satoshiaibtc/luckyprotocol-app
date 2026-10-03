// Fee-rate choice: presets from the indexer's /fees plus a custom rate.
// Pure and window-free so test/wallet.test.js can exercise it in Node;
// src/hooks/useFeeRate.js hands it the browser's localStorage.
//
// Stored form ('lp.feeTier'): a preset id ("fast" | "normal" | "slow" |
// "economy") or the custom rate as a decimal string ("27" or "1.25").
// Only a choice the visitor makes is stored; until then the default applies.

import { MAX_FEE_RATE_SAT_VB } from "./psbt.js";

export const FEE_CHOICE_KEY = "lp.feeTier";
// A retired key: never read, removed when found.
export const RETIRED_FEE_CHOICE_KEY = "lp.feeChoice";
export const MIN_FEE_RATE_SAT_VB = 1;
// The recommended rate: Fast, normally the next block's live median fee
// rate. A choice the visitor made is kept.
export const DEFAULT_PRESET = "fast";

export const FEE_PRESETS = [
  // Fast normally comes from the next block itself (`fastFromNextBlock` on
  // the merged fees, src/lib/network.js) and then shows FAST_NEXT_BLOCK_ETA;
  // this ETA is for the node's next-block estimate (2 blocks at best).
  { id: "fast", label: "Fast", key: "fastestFee", eta: "~10–20 min" },
  { id: "normal", label: "Normal", key: "halfHourFee", eta: "~30 min" },
  { id: "slow", label: "Slow", key: "hourFee", eta: "~1 h" },
  { id: "economy", label: "Economy", key: "economyFee", eta: "> 1 h" },
];

/** Fast's ETA while it comes from the next block (its median, or a rate it has room at). */
export const FAST_NEXT_BLOCK_ETA = "next block";

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
 * — the same rule the presets follow.
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
 * The visitor's stored choice from `storage` (a Storage, or null when there
 * is none), else the default. Drops the retired key on the way. Never
 * throws: blocked or failing storage reads as nothing stored.
 */
export function loadFeeChoice(storage) {
  if (!storage) return parseFeeChoice(null);
  try {
    storage.removeItem(RETIRED_FEE_CHOICE_KEY);
  } catch {
    /* read-only storage: the retired key is ignored anyway */
  }
  try {
    return parseFeeChoice(storage.getItem(FEE_CHOICE_KEY));
  } catch {
    return parseFeeChoice(null);
  }
}

/**
 * Store a choice the visitor just made. A custom choice without a usable
 * rate (an empty or rejected entry) is not stored: the last choice made
 * stays. Returns true when it was written. Never throws.
 */
export function saveFeeChoice(storage, choice) {
  if (!storage || !choice) return false;
  if (choice.kind === "custom" && !isUsableFeeRate(choice.value)) return false;
  if (choice.kind !== "custom" && !(choice.kind === "preset" && isPresetId(choice.id))) return false;
  try {
    storage.setItem(FEE_CHOICE_KEY, serializeFeeChoice(choice));
    return true;
  } catch {
    return false; // private mode / full storage: the choice just won't persist
  }
}

/**
 * Why a preset has no usable rate: 'missing' (no /fees, or the key is
 * absent / malformed), 'over-cap' (the estimate exceeds the
 * MAX_FEE_RATE_SAT_VB safety cap — a wrong estimate is REJECTED, never
 * clamped to a number that still overpays), or null when it
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

/** What the fee selector and the status lines say while fee rates are still on their way. */
export const FEE_READING_TEXT = "Reading fee rates…";

/**
 * Why there is no usable fee rate right now (for the idle status line),
 * or null when `satVb` is set. `action` completes the sentence ("mine").
 * `reading`: no estimate yet, but a read that may bring one has not
 * answered (useFeeRate's `reading`) — a preset then waits for it.
 */
export function missingFeeHint(choice, satVb, action = "continue", { awaitingAck = false, reading = false } = {}) {
  if (Number.isFinite(satVb) && satVb >= MIN_FEE_RATE_SAT_VB) return null;
  if (choice && choice.kind === "custom" && awaitingAck) return `Confirm the high custom fee rate under "Fee rate" to ${action}.`;
  if (choice && choice.kind === "custom") return `Enter a custom fee rate (${MIN_FEE_RATE_SAT_VB}–${MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")} sat/vB) to ${action}.`;
  if (reading) return FEE_READING_TEXT;
  return `No fee estimate from the indexer or mempool.space — choose Custom and enter a sat/vB to ${action}.`;
}

/**
 * Preset rows for the selector: `{ id, label, eta, satVb | null, reason:
 * null | 'missing' | 'over-cap', title }` — `title` is the preset's tooltip.
 */
export function presetRows(feesData) {
  return FEE_PRESETS.map((p) => {
    const satVb = resolveFeeRate({ kind: "preset", id: p.id }, feesData);
    const reason = presetUnavailableReason(p.id, feesData);
    const nextBlock = p.id === "fast" && satVb !== null && feesData.fastFromNextBlock === true;
    const eta = nextBlock ? FAST_NEXT_BLOCK_ETA : p.eta;
    return { id: p.id, label: p.label, eta, satVb, reason, title: presetTitle(p.label, satVb, eta, reason, nextBlock ? feesData : null) };
  });
}

/**
 * A preset's tooltip. `nextBlockOf` is the fees object when the rate comes
 * from the next block: it is called the next block's median only when it
 * is that median (`fastIsMedian`) — a median below the 1 sat/vB minimum is
 * said, the rate then being the minimum — and otherwise a rate the next
 * block has room at.
 */
function presetTitle(label, satVb, eta, reason, nextBlockOf) {
  if (satVb === null) return `${label} — ${presetUnavailableText(reason) || "estimate unavailable"}`;
  if (!nextBlockOf) return `${label} — ${satVb} sat/vB, ${eta}`;
  if (nextBlockOf.fastIsMedian !== true) return `${label} — ${satVb} sat/vB, the next block has room at this rate`;
  const m = nextBlockOf.nextBlockMedianFee;
  if (Number.isFinite(m) && m < MIN_FEE_RATE_SAT_VB) {
    return `${label} — ${satVb} sat/vB, the minimum: the next block's median fee rate is ${m} sat/vB right now`;
  }
  return `${label} — ${satVb} sat/vB, the next block's median fee rate right now`;
}

/** Short reason text for a preset without a rate (tooltip / note). */
export function presetUnavailableText(reason) {
  if (reason === "over-cap") return `estimate unavailable — the fee estimate is above the ${MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")} sat/vB safety cap and looks wrong`;
  if (reason === "missing") return "estimate unavailable";
  return null;
}

// ---- high custom rates need an explicit confirmation ------------------------------------

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
 * fee estimates themselves, rejected above the cap).
 */
export function needsHighFeeAck(value, feesData) {
  return isUsableFeeRate(value) && value > highFeeThreshold(feesData);
}
