import { fmtInt, fmtPct } from "../lib/format.js";
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
  const centre = pct > 0 && pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
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
          <span className="pct">{fmtPct(minted, supply, minted && pct < 1 ? 3 : 2)} minted</span>
          <span className="of">
            {fmtInt(minted)} / {fmtInt(supply)}
          </span>
        </span>
      )}
    </div>
  );
}
