import { BUCKETS, DIGIT_SPACE, EXPECTED_YIELD, YIELD_HIGH, YIELD_SD, expectedYieldCapped } from "../lib/yield.js";
import { fmtDec, fmtInt } from "../lib/format.js";
import { inTailZone } from "../lib/statusText.js";

/**
 * Expected yield per mine as a hero numeral, with its derivation and σ.
 * `size` = "lg" (44px, with the variance help line) | "md" (28px).
 * `remaining` (tokens left to mine, or null when not known / not a token
 * page): near the cap each tier is capped by what is left, and a minted-out
 * ticker reads 0 — never the uncapped 262.5 next to "credits 0" (audit
 * mine-1 / mine-7). In the tail zone (less than about one block of MINEs
 * left) MINEs queued ahead can take the rest, so the figure reads "at most".
 */
export default function EVReadout({ ticker = "", size = "md", remaining = null }) {
  const capped = remaining !== null && remaining !== undefined && remaining < YIELD_HIGH;
  const tail = !capped && remaining !== null && remaining !== undefined && inTailZone(remaining);
  const ev = capped ? expectedYieldCapped(remaining) : EXPECTED_YIELD;
  const cap = (y) => (capped ? Math.min(y, Math.max(0, remaining)) : y);
  const formula = `(${BUCKETS.map((b) => `${b.count}×${cap(b.yield)}`).join(" + ")}) ÷ ${DIGIT_SPACE} = ${fmtDec(ev)}`;
  return (
    <div className={`ev sz-${size}`}>
      <span className="label">{capped || tail ? (remaining > 0 ? "Expected yield / mine · at most" : "Expected yield / mine · minted out") : "Expected yield / mine"}</span>
      <div className="hero-num">
        {fmtDec(ev)}
        {ticker && <span className="unit">{ticker}</span>}
      </div>
      {!(capped && remaining <= 0) && <div className="formula">{formula}</div>}
      {!capped && <div className="sd">σ ≈ {fmtInt(Math.round(YIELD_SD))}</div>}
      {capped && <div className="sd">{remaining > 0 ? `capped by the ${fmtInt(remaining)} left` : "no supply left"}</div>}
      {size === "lg" && <p className="help">Per-mine variance, like block-time variance: wide for one mine, narrow over many.</p>}
    </div>
  );
}
