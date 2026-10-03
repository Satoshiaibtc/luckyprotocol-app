import { useCallback, useMemo, useState } from "react";
import { feeSourceNote } from "../lib/network.js";
import {
  DEFAULT_PRESET,
  clampCustomFee,
  highFeeThreshold,
  loadFeeChoice,
  needsHighFeeAck,
  parseFeeChoice,
  presetRows,
  resolveFeeRate,
  saveFeeChoice,
} from "../lib/feechoice.js";

// The browser's localStorage, or null where there is none or the site's
// storage is blocked (reading the property itself throws then).
function browserStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * The fee-rate choice shared by every builder (MINE / DEPLOY / SEND):
 * a preset from the indexer's /fees or a custom 1–1000 sat/vB. Only a
 * choice the visitor makes (a preset, Custom, a typed rate, a named rate)
 * is stored, in localStorage ('lp.feeTier', src/lib/feechoice.js); opening
 * the page stores nothing, so a visitor who never chose starts on the
 * current default.
 *
 *   const fee = useFeeRate(fees.data, { reading: fees.reading });
 *   fee.satVb            → number | null (null = preset chosen but /fees unavailable)
 *   fee.choice           → { kind: "preset", id } | { kind: "custom", value }
 *   fee.presets          → [{ id, label, eta, satVb | null, reason, title }]
 *   fee.customText       → the input's current text
 *   fee.customError      → inline message | null
 *   fee.reading          → no estimate yet, but a read that may bring one has not
 *                          answered (the `reading` option): say so, not "none"
 *   fee.sourceNote       → where the estimates came from when that is worth saying
 *                          (the second source standing in), else null
 *   fee.highFee          → null, or { satVb, threshold, fastest, pending } when the
 *                          custom rate is above max(50, 2 × fastestFee): satVb stays
 *                          null until fee.ackHighFee()
 *   fee.pickPreset(id) / fee.pickCustom() / fee.setCustomText(text) / fee.ackHighFee()
 *   fee.pickRate(satVb)  → that exact custom rate, already confirmed (a button that names it)
 *
 * Options: `{ preset, persist = true, reading = false }` — `preset` starts
 * from that preset instead of the stored choice, `persist: false` keeps the
 * choice local to the component (the Create page's DEPLOY starts at "fast"
 * without touching the choice every other builder uses), and `reading`
 * says fee rates are still on their way (App.jsx `fees.reading`).
 */
export function useFeeRate(feesData, { preset = null, persist = true, reading = false } = {}) {
  const [initial] = useState(() => (preset ? parseFeeChoice(preset) : loadFeeChoice(browserStorage())));
  const [choice, setChoice] = useState(initial);
  const [customText, setCustomText] = useState(() => (initial.kind === "custom" ? String(initial.value) : ""));

  // Every change of choice comes from the visitor, so this is where it is stored.
  const choose = useCallback(
    (next) => {
      setChoice(next);
      if (persist) saveFeeChoice(browserStorage(), next);
    },
    [persist],
  );

  const presets = useMemo(() => presetRows(feesData), [feesData]);
  const feesAvailable = presets.some((p) => p.satVb !== null);
  const custom = useMemo(() => clampCustomFee(customText), [customText]);

  const pickPreset = useCallback((id) => choose({ kind: "preset", id: id || DEFAULT_PRESET }), [choose]);

  const pickCustom = useCallback(() => {
    if (choice.kind === "custom") return;
    const text = customText.trim() || String(resolveFeeRate(choice, feesData) ?? "");
    setCustomText(text);
    choose({ kind: "custom", value: clampCustomFee(text).value });
  }, [choice, customText, feesData, choose]);

  const onCustomText = useCallback(
    (text) => {
      const t = String(text ?? "").slice(0, 32);
      setCustomText(t);
      const { value } = clampCustomFee(t);
      choose({ kind: "custom", value: value ?? null });
    },
    [choose],
  );

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

  // A button that names the exact rate ("Use 14 sat/vB") sets it as the
  // custom rate; pressing it is the confirmation a high rate asks for.
  const pickRate = useCallback(
    (value) => {
      const { value: v } = clampCustomFee(String(value ?? ""));
      if (v === null) return;
      setCustomText(String(v));
      choose({ kind: "custom", value: v });
      setAckedRate(v);
    },
    [choose],
  );

  return {
    choice,
    satVb,
    presets,
    feesAvailable,
    reading: !feesAvailable && reading === true,
    customText,
    customError: choice.kind === "custom" ? custom.error : null,
    sourceNote: feeSourceNote(feesData),
    highFee,
    ackHighFee,
    pickPreset,
    pickCustom,
    pickRate,
    setCustomText: onCustomText,
  };
}
