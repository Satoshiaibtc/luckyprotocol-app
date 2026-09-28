import { useCallback, useEffect, useMemo, useState } from "react";
import { feeSourceNote } from "../lib/network.js";
import {
  DEFAULT_PRESET,
  FEE_CHOICE_KEY,
  clampCustomFee,
  highFeeThreshold,
  needsHighFeeAck,
  parseFeeChoice,
  presetRows,
  resolveFeeRate,
  serializeFeeChoice,
} from "../lib/feechoice.js";

function readStoredChoice() {
  try {
    return parseFeeChoice(typeof localStorage !== "undefined" ? localStorage.getItem(FEE_CHOICE_KEY) : null);
  } catch {
    return parseFeeChoice(null);
  }
}

function writeStoredChoice(choice) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(FEE_CHOICE_KEY, serializeFeeChoice(choice));
  } catch {
    /* private mode — selection just won't persist */
  }
}

/**
 * The fee-rate choice shared by every builder (MINE / DEPLOY / SEND):
 * a preset from the indexer's /fees or a custom 1–1000 sat/vB, persisted
 * in localStorage ('lp.feeChoice').
 *
 *   const fee = useFeeRate(fees.data);
 *   fee.satVb            → number | null (null = preset chosen but /fees unavailable)
 *   fee.choice           → { kind: "preset", id } | { kind: "custom", value }
 *   fee.presets          → [{ id, label, eta, satVb | null }]
 *   fee.customText       → the input's current text
 *   fee.customError      → inline message | null
 *   fee.sourceNote       → where the estimates came from when that is worth saying
 *                          (the second source standing in, or its higher Fast), else null
 *   fee.highFee          → null, or { satVb, threshold, fastest, pending } when the
 *                          custom rate is above max(50, 2 × fastestFee): satVb stays
 *                          null until fee.ackHighFee() (audit usertx-8)
 *   fee.pickPreset(id) / fee.pickCustom() / fee.setCustomText(text) / fee.ackHighFee()
 *
 * Options: `{ preset, persist = true }` — `preset` starts from that preset
 * instead of the stored choice, and `persist: false` keeps the choice local
 * to the component (the Create page's Publish step starts at "fast" without
 * touching the choice every other builder uses).
 */
export function useFeeRate(feesData, { preset = null, persist = true } = {}) {
  const [choice, setChoice] = useState(() => (preset ? parseFeeChoice(preset) : readStoredChoice()));
  const [customText, setCustomText] = useState(() => {
    const c = preset ? parseFeeChoice(preset) : readStoredChoice();
    return c.kind === "custom" ? String(c.value) : "";
  });

  useEffect(() => {
    if (persist) writeStoredChoice(choice);
  }, [choice, persist]);

  const presets = useMemo(() => presetRows(feesData), [feesData]);
  const feesAvailable = presets.some((p) => p.satVb !== null);
  const custom = useMemo(() => clampCustomFee(customText), [customText]);

  const pickPreset = useCallback((id) => setChoice({ kind: "preset", id: id || DEFAULT_PRESET }), []);

  const pickCustom = useCallback(() => {
    if (choice.kind === "custom") return;
    const text = customText.trim() || String(resolveFeeRate(choice, feesData) ?? "");
    setCustomText(text);
    setChoice({ kind: "custom", value: clampCustomFee(text).value });
  }, [choice, customText, feesData]);

  const onCustomText = useCallback((text) => {
    const t = String(text ?? "").slice(0, 32);
    setCustomText(t);
    const { value } = clampCustomFee(t);
    setChoice({ kind: "custom", value: value ?? null });
  }, []);

  // A high custom rate is held back until the user confirms that exact
  // value; typing anything else clears the confirmation.
  const [ackedRate, setAckedRate] = useState(null);
  const customRate = choice.kind === "custom" ? resolveFeeRate({ kind: "custom", value: custom.value }, null) : null;
  const highPending = customRate !== null && needsHighFeeAck(customRate, feesData);
  const acked = highPending && ackedRate === customRate;
  const satVb = choice.kind === "custom" ? (highPending && !acked ? null : customRate) : resolveFeeRate(choice, feesData);
  const highFee = highPending
    ? { satVb: customRate, threshold: highFeeThreshold(feesData), fastest: Number(feesData?.fastestFee) || null, pending: !acked }
    : null;
  const ackHighFee = useCallback(() => setAckedRate(customRate), [customRate]);

  return {
    choice,
    satVb,
    presets,
    feesAvailable,
    customText,
    customError: choice.kind === "custom" ? custom.error : null,
    sourceNote: feeSourceNote(feesData),
    highFee,
    ackHighFee,
    pickPreset,
    pickCustom,
    setCustomText: onCustomText,
  };
}
