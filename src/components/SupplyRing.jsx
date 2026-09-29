import { fmtInt, fmtMintedPct } from "../lib/format.js";
import { REQUIRED_TOKEN_SUPPLY } from "../lib/payloads.js";

/**
 * Minted share of the fixed supply as an SVG ring. Turns `--hot` once the
 * supply is essentially exhausted (pct ≥ 99).
 */
export default function SupplyRing({ ticker, minted = 0, supply = REQUIRED_TOKEN_SUPPLY, size = 56, showText = false }) {
  const pct = supply ? Math.min(100, (100 * minted) / supply) : 0;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  // Never "100%" before the supply is reached: at 99.5%
  // minted there can still be ~105,000 tokens to mine.
  const full = supply > 0 && minted >= supply;
  const centre = full ? "100%" : pct > 0 && pct < 10 ? `${pct.toFixed(1)}%` : `${Math.min(99, Math.round(pct))}%`;
  return (
    <div className="ring-wrap" role="progressbar" aria-valuemin={0} aria-valuemax={supply} aria-valuenow={minted} aria-label={`${ticker} supply minted`}>
      <svg className={`ring${pct >= 99 ? " full" : ""}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="track" cx={cx} cy={cx} r={r} strokeWidth={stroke} />
        <circle
          className="arc"
          cx={cx}
          cy={cx}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          transform={`rotate(-90 ${cx} ${cx})`}
        />
        <text x={cx} y={cx} textAnchor="middle" dominantBaseline="central" fontSize={size / 4}>
          {centre}
        </text>
      </svg>
      {showText && (
        <span className="ring-text">
          <span className="pct">{fmtMintedPct(minted, supply, minted && pct < 1 ? 3 : 2)} minted</span>
          <span className="of">
            {fmtInt(minted)} / {fmtInt(supply)}
          </span>
        </span>
      )}
    </div>
  );
}
