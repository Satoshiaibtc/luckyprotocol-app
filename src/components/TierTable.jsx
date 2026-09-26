import { BUCKETS, DIGIT_SPACE, probabilityPct } from "../lib/yield.js";
import { fmtInt } from "../lib/format.js";

/**
 * The yield buckets (one row / chip per BUCKETS entry) as a table (full) or
 * as chips with a 16-segment rail (compact). Every number derives from BUCKETS.
 */
export default function TierTable({ ticker = "", compact = false }) {
  if (compact) {
    return (
      <div className="tier-chips">
        {BUCKETS.map((b) => (
          <span key={b.id} className={`ch chamfer tier-chip tier-${b.id}`} role="img" aria-label={`${b.label}: ${b.count} in ${DIGIT_SPACE}, yields ${b.yield}`}>
            <span className="ch-in chamfer">
              <span className="t">
                <b>{b.label}</b> · {probabilityPct(b)}% · {b.yield}
              </span>
              <span className="rail">
                {Array.from({ length: DIGIT_SPACE }, (_, i) => (
                  <i key={i} className={i < b.count ? "on" : ""} />
                ))}
              </span>
            </span>
          </span>
        ))}
      </div>
    );
  }

  const unit = ticker ? ` ${ticker}` : "";
  return (
    <>
      <div className="tier-table" role="table" aria-label="Yield by last hex digit">
        <div className="th" role="row">
          <span className="label" role="columnheader">
            Digits
          </span>
          <span className="label" role="columnheader">
            Probability
          </span>
          <span className="label" role="columnheader" aria-hidden="true" />
          <span className="label th-right" role="columnheader">
            Yield
          </span>
        </div>
        {BUCKETS.map((b) => (
          <div key={b.id} className={`row tier-${b.id}`} role="row">
            <span className="dg" role="cell">
              {b.label}
            </span>
            <span className="pr" role="cell">
              {b.count} of {DIGIT_SPACE}
            </span>
            <span className="pc" role="cell">
              {probabilityPct(b)}%
            </span>
            <span className="yl" role="cell">
              {fmtInt(b.yield)}
              {unit}
            </span>
            <span className="bar-track" aria-hidden="true">
              <span className="bar-fill" style={{ width: `${probabilityPct(b)}%` }} />
            </span>
          </div>
        ))}
      </div>
      <p className="tier-sub">Every valid mine yields. The miner chooses nothing; the digit is public and deterministic.</p>
    </>
  );
}
