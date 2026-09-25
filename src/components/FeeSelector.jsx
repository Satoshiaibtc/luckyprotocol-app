import { useId } from "react";
import { MAX_FEE_RATE_SAT_VB } from "../lib/psbt.js";
import { presetUnavailableText } from "../lib/feechoice.js";

/**
 * Compact segmented fee-rate control (fits 375 px): Fast / Normal / Slow /
 * Economy from the indexer's /fees, each with its sat/vB and ETA, plus a
 * Custom integer input (1–1000, clamped; inline error shown above it).
 * `fee` is the object from useFeeRate.
 */
export default function FeeSelector({ fee, disabled = false }) {
  const inputId = useId();
  const isCustom = fee.choice.kind === "custom";
  const overCap = fee.presets.some((p) => p.reason === "over-cap");
  return (
    <div className="fee-sel">
      <div className="fee-sel-head">
        <span className="label">Fee rate</span>
        {!fee.feesAvailable && !overCap && <span className="fee-sel-note">No estimates from the indexer — presets off, Custom still works.</span>}
        {overCap && <span className="fee-sel-note">Fee estimate unavailable — the indexer reports rates above the {MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")} sat/vB safety cap; they are rejected, not clamped. Custom still works.</span>}
      </div>
      <div className="fee-seg" role="radiogroup" aria-label="Fee rate">
        {fee.presets.map((p) => {
          const on = !isCustom && fee.choice.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`fee-opt${on ? " on" : ""}`}
              disabled={disabled || p.satVb === null}
              onClick={() => fee.pickPreset(p.id)}
              title={p.satVb !== null ? `${p.label} — ${p.satVb} sat/vB, ${p.eta}` : `${p.label} — ${presetUnavailableText(p.reason) || "estimate unavailable"}`}
            >
              <span className="fo-l">{p.label}</span>
              <span className="fo-v">{p.satVb !== null ? p.satVb : "—"}</span>
              <span className="fo-e">{p.eta}</span>
            </button>
          );
        })}
        <button type="button" role="radio" aria-checked={isCustom} className={`fee-opt${isCustom ? " on" : ""}`} disabled={disabled} onClick={fee.pickCustom} title="Custom fee rate">
          <span className="fo-l">Custom</span>
          <span className="fo-v">{isCustom && fee.satVb ? fee.satVb : "…"}</span>
          <span className="fo-e">sat/vB</span>
        </button>
      </div>
      {isCustom && (
        <div className="fee-custom">
          {fee.customError && (
            <div className="fee-custom-err" role="alert">
              {fee.customError}
            </div>
          )}
          <div className="row">
            <label className="sr-only" htmlFor={inputId}>
              Custom fee rate in sat/vB
            </label>
            <input
              id={inputId}
              className={`input mono${fee.customError ? " invalid" : ""}`}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="sat/vB"
              value={fee.customText}
              onChange={(e) => fee.setCustomText(e.target.value)}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!fee.customError}
            />
            <span className="unit">sat/vB · 1–{MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
