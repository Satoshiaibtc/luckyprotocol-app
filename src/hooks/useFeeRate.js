import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_PRESET,
  FEE_CHOICE_KEY,
  clampCustomFee,
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
 *   fee.pickPreset(id) / fee.pickCustom() / fee.setCustomText(text)
 */
export function useFeeRate(feesData) {
  const [choice, setChoice] = useState(readStoredChoice);
  const [customText, setCustomText] = useState(() => {
    const c = readStoredChoice();
    return c.kind === "custom" ? String(c.value) : "";
  });

  useEffect(() => {
    writeStoredChoice(choice);
  }, [choice]);

  const presets = useMemo(() => presetRows(feesData), [feesData]);
  const feesAvailable = presets.some((p) => p.satVb !== null);
  const custom = useMemo(() => clampCustomFee(customText), [customText]);

  const pickPreset = useCallback((id) => setChoice({ kind: "preset", id: id || DEFAULT_PRESET }), []);

  const pickCustom = useCallback(() => {
    setChoice((c) => {
      if (c.kind === "custom") return c;
      const { value } = clampCustomFee(customText);
      return { kind: "custom", value: value ?? null };
    });
  }, [customText]);

  const onCustomText = useCallback((text) => {
    const t = String(text ?? "").replace(/[^\d.]/g, "").slice(0, 6);
    setCustomText(t);
    const { value } = clampCustomFee(t);
    setChoice({ kind: "custom", value: value ?? null });
  }, []);

  const satVb = choice.kind === "custom" ? resolveFeeRate({ kind: "custom", value: custom.value }, null) : resolveFeeRate(choice, feesData);

  return {
    choice,
    satVb,
    presets,
    feesAvailable,
    customText,
    customError: choice.kind === "custom" ? custom.error : null,
    pickPreset,
    pickCustom,
    setCustomText: onCustomText,
  };
}
