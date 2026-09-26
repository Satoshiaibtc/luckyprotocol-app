import { useEffect, useMemo, useRef, useState } from "react";
import { METRICS, dailyLayout, nearestBar } from "../lib/activity.js";
import { fmtBtcShort, fmtCompact, fmtInt, fmtUsd } from "../lib/format.js";

const H = 220;

/**
 * Hand-built SVG: one bar per UTC day for the selected metric (left axis)
 * and the cumulative line over the window (right axis), with a hover
 * readout. Static drawing — nothing animates, so prefers-reduced-motion
 * needs no exception here; the hover crosshair is instant either way.
 */
export default function DailyChart({ rows, metric, onMetric, usd = null, loading, error }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const L = useMemo(() => dailyLayout({ rows, metric, width, height: H }), [rows, metric, width]);
  useEffect(() => {
    setHover(null);
  }, [rows, metric]);

  const m = METRICS.find((x) => x.id === metric) || METRICS[0];
  const isSats = metric === "volume_sats";
  const fmtV = (v) => (isSats ? `${fmtCompact(v)} sats` : fmtInt(v));
  const onMove = (e) => {
    if (!L) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(nearestBar(L, e.clientX - rect.left));
  };
  const onTouch = (e) => {
    const t = e.touches && e.touches[0];
    if (t) onMove({ currentTarget: e.currentTarget, clientX: t.clientX });
  };
  const bar = hover !== null && L ? L.bars[hover] : null;

  return (
    <div className="daily">
      <div className="daily-head">
        <div className="chips chips-sm" role="tablist" aria-label="Metric">
          {METRICS.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={metric === x.id} className={`chip${metric === x.id ? " active" : ""}`} onClick={() => onMetric?.(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <div className="daily-readout mono" role="status" aria-live="polite">
          {bar ? (
            <>
              <span className="k">{bar.date}</span>
              <span>
                <span className="k">{m.label}</span> {fmtV(bar.v)}
                {isSats ? ` · ${fmtBtcShort(bar.v)}${usd ? ` · ${fmtUsd(bar.v, usd)}` : ""}` : ""}
              </span>
              <span>
                <span className="k">cumulative</span> {fmtV(bar.cum)}
                {isSats && usd ? ` · ${fmtUsd(bar.cum, usd)}` : ""}
              </span>
            </>
          ) : L ? (
            <>
              <span className="k">{L.bars.length} days</span>
              <span>
                <span className="k">total</span> {fmtV(L.total)}
                {isSats ? ` · ${fmtBtcShort(L.total)}${usd ? ` · ${fmtUsd(L.total, usd)}` : ""}` : ""}
              </span>
              <span>
                <span className="k">peak day</span> {fmtV(L.max)}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <div className="chart-wrap" ref={wrapRef}>
        {error && !L ? (
          <div className="chart-empty err">Could not load the daily series: {String(error.message)}</div>
        ) : !L ? (
          <div className="chart-empty muted">{loading ? "Loading…" : "Nothing indexed in the last 30 days."}</div>
        ) : (
          <svg className="chart daily-svg" width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={`${m.label} per day, ${L.bars.length} days, total ${fmtV(L.total)}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} onTouchStart={onTouch} onTouchMove={onTouch}>
            {L.yTicks.map((t) => (
              <g key={`y${t.v}`}>
                <line className="grid" x1={L.left} x2={L.right} y1={t.y} y2={t.y} />
                <text className="tick" x={L.left - 8} y={t.y + 4} textAnchor="end">
                  {isSats ? fmtCompact(t.v) : fmtInt(t.v)}
                </text>
              </g>
            ))}
            <text className="tick tick-r" x={L.right + 8} y={L.top + 4} textAnchor="start">
              {isSats ? fmtCompact(L.total) : fmtInt(L.total)}
            </text>
            <text className="tick tick-r" x={L.right + 8} y={L.bottom + 4} textAnchor="start">
              0
            </text>
            <line className="axis" x1={L.left} x2={L.right} y1={L.bottom} y2={L.bottom} />
            {L.xTicks.map((t) => (
              <text key={`x${t.x}`} className="tick" x={t.x} y={H - 6} textAnchor="middle">
                {t.label}
              </text>
            ))}
            {L.bars.map((b) => (
              <rect key={b.i} className={`bar${hover === b.i ? " hot" : ""}`} x={b.x - L.barW / 2} y={b.y} width={L.barW} height={b.h} />
            ))}
            <path className="cum" d={L.line} />
            {bar && (
              <g className="crosshair">
                <line x1={bar.x} x2={bar.x} y1={L.top} y2={L.bottom} />
                <circle cx={bar.x} cy={L.yLine(bar.cum)} r={3.5} />
              </g>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
