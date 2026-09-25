import { DIGIT_SPACE, bucketOf } from "../lib/yield.js";
import { fmtInt } from "../lib/format.js";

/** Tier class for a last hex digit (or the invalid / unknown fallbacks). */
export function tierClass(digit, invalid = false) {
  if (invalid) return "tier-invalid";
  const b = bucketOf(digit);
  return b ? `tier-${b.id}` : "tier-none";
}

/** `last digit c → 500 per mine` — the default title on every digit chip. */
export function digitTitle(digit, ticker) {
  const b = bucketOf(digit);
  if (!b) return "digit unknown";
  return `last digit ${digit} → ${b.yield}${ticker ? ` ${ticker}` : " per mine"}`;
}

/**
 * Chamfered digit tile in tier color.
 *   <DigitChip digit="c" size="sm|md|lg" showYield ticker="LUCKY" invalid bare />
 * `bare` renders the glowing digit alone (no box) for tape tiles / the reveal.
 */
export default function DigitChip({ digit, size = "sm", showYield = false, ticker, invalid = false, bare = false, title, className = "" }) {
  const d = typeof digit === "string" && digit.length === 1 ? digit.toLowerCase() : null;
  const b = d ? bucketOf(d) : null;
  const tier = tierClass(d, invalid);
  const t = title ?? (invalid ? "invalid mine — no yield" : digitTitle(d, ticker));
  const glyph = invalid ? "×" : d ?? "·";

  if (bare) {
    return (
      <span className={`digit-bare ${tier}${className ? ` ${className}` : ""}`} title={t}>
        {glyph}
      </span>
    );
  }
  return (
    <span className={`ch chamfer chip-d sz-${size} ${tier}${className ? ` ${className}` : ""}`} title={t}>
      <span className="ch-in chamfer">
        <span className="d">{glyph}</span>
        {showYield && b && !invalid && (
          <span className="yv">
            → {fmtInt(b.yield)}
            {ticker ? ` ${ticker}` : ""}
          </span>
        )}
      </span>
      <span className="sr-only">{invalid ? "invalid mine" : b ? `last digit ${d}, ${b.count} of ${DIGIT_SPACE}` : ""}</span>
    </span>
  );
}
