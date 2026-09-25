/**
 * Quarter-arc scanner: a track circle and a 25% arc that sweeps while
 * `sweeping` (CSS rotation; static under prefers-reduced-motion). Used only
 * for "awaiting a block" states — it is not a ring of segments and carries
 * no digits.
 */
export default function RingGauge({ size = 72, sweeping = true, label = "" }) {
  const stroke = Math.max(2, Math.round(size / 18));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  return (
    <svg className="gauge" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label || "awaiting"}>
      <circle className="track" cx={cx} cy={cx} r={r} strokeWidth={stroke} />
      <g className={`sweep${sweeping ? "" : " static"}`}>
        <circle className="arc" cx={cx} cy={cx} r={r} strokeWidth={stroke} strokeDasharray={`${c * 0.25} ${c * 0.75}`} transform={`rotate(-90 ${cx} ${cx})`} />
      </g>
      {label && (
        <text x={cx} y={cx} textAnchor="middle" dominantBaseline="central">
          {label}
        </text>
      )}
    </svg>
  );
}
