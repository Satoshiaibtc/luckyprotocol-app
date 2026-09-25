import { BUCKETS, DIGIT_SPACE, EXPECTED_YIELD, YIELD_SD } from "../lib/yield.js";
import { fmtDec, fmtInt } from "../lib/format.js";

/**
 * Expected yield per mine as a hero numeral, with its derivation and σ.
 * `size` = "lg" (44px, with the variance help line) | "md" (28px).
 */
export default function EVReadout({ ticker = "", size = "md" }) {
  const formula = `(${BUCKETS.map((b) => `${b.count}×${b.yield}`).join(" + ")}) ÷ ${DIGIT_SPACE} = ${fmtDec(EXPECTED_YIELD)}`;
  return (
    <div className={`ev sz-${size}`}>
      <span className="label">Expected yield / mine</span>
      <div className="hero-num">
        {fmtDec(EXPECTED_YIELD)}
        {ticker && <span className="unit">{ticker}</span>}
      </div>
      <div className="formula">{formula}</div>
      <div className="sd">σ ≈ {fmtInt(Math.round(YIELD_SD))}</div>
      {size === "lg" && <p className="help">Per-mine variance, like block-time variance: wide for one mine, narrow over many.</p>}
    </div>
  );
}
