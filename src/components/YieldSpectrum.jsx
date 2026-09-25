import { BUCKETS, DIGITS, DIGIT_SPACE, bucketOf, distributionSentence } from "../lib/yield.js";

/**
 * The 16 possible last hex digits as a chamfered strip, colored by tier,
 * with the bucket brackets beneath and (unless `compact`) a legend.
 * `tipDigit` marks the latest block's digit; `litDigit` marks a reveal.
 */
export default function YieldSpectrum({ tipDigit = null, litDigit = null, compact = false }) {
  const tip = typeof tipDigit === "string" ? tipDigit.toLowerCase() : null;
  const lit = typeof litDigit === "string" ? litDigit.toLowerCase() : null;
  return (
    <div className="spectrum-wrap">
      <span className="label">Last hex digit of the confirming block</span>
      <div className="spectrum" role="img" aria-label={distributionSentence()}>
        {DIGITS.map(({ d, bucket }) => (
          <span
            key={d}
            className={`ch chamfer cell tier-${bucket}${d === tip ? " is-tip" : ""}${d === lit ? " is-lit" : ""}`}
            aria-hidden="true"
          >
            <span className="ch-in chamfer">{d}</span>
          </span>
        ))}
      </div>
      {tip && bucketOf(tip) && (
        <div className="spectrum-tags" aria-hidden="true">
          <span className="tag label" style={{ gridColumn: DIGITS.findIndex((x) => x.d === tip) + 1 }}>
            TIP
          </span>
        </div>
      )}
      <div className="spectrum-brackets" aria-hidden="true">
        {[...BUCKETS].reverse().map((b) => (
          <span key={b.id} className={`b-${b.id} tier-${b.id}`}>
            {`${b.label} · ${b.count}/${DIGIT_SPACE} · ${b.yield}`}
          </span>
        ))}
      </div>
      {!compact && (
        <div className="spectrum-legend" aria-hidden="true">
          {[...BUCKETS].reverse().map((b) => (
            <span key={b.id} className={`tier-${b.id}`}>
              <i />
              {`${b.label} → ${b.yield} · ${b.count} of ${DIGIT_SPACE}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
