import { useId } from "react";
import { MAX_FEE_RATE_SAT_VB } from "../lib/psbt.js";
import { FEE_READING_TEXT } from "../lib/feechoice.js";

/**
 * Compact segmented fee-rate control (fits 375 px): Fast / Normal / Slow /
 * Economy from the indexer's /fees, each with its sat/vB, ETA and tooltip
 * (Fast: from the next block — its median fee rate, or a rate it has room
 * at — "next block"), plus a Custom decimal input (1–1000, up to 2 decimal
 * places). With no estimate yet it says the rates are still being read
 * while a read is outstanding (`fee.reading`), and that there are none
 * only after.
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
        {!fee.feesAvailable && !overCap && fee.reading && <span className="fee-sel-note">{FEE_READING_TEXT}</span>}
        {!fee.feesAvailable && !overCap && !fee.reading && <span className="fee-sel-note">No fee estimates from the indexer or mempool.space — presets off, Custom still works.</span>}
        {fee.feesAvailable && fee.sourceNote && <span className="fee-sel-note">{fee.sourceNote}</span>}
        {overCap && <span className="fee-sel-note">The fee estimate is above the {MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")} sat/vB safety cap — rejected, not clamped. Custom still works.</span>}
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
              title={p.title}
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
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{0,2})?"
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
          {fee.highFee && (
            <div className={`fee-custom-high${fee.highFee.pending ? " pending" : ""}`} role={fee.highFee.pending ? "alert" : undefined}>
              <span>
                {fee.highFee.satVb.toLocaleString("en-US")} sat/vB is high
                {fee.highFee.fastest ? ` — the fastest estimate is ${fee.highFee.fastest} sat/vB` : ""}. A typo here costs real sats.
              </span>
              {fee.highFee.pending ? (
                <button className="btn btn-sm" type="button" onClick={fee.ackHighFee} disabled={disabled}>
                  Use {fee.highFee.satVb.toLocaleString("en-US")} sat/vB
                </button>
              ) : (
                <span className="muted">Confirmed.</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
