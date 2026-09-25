// unrendered since 2026-09-25 (trading removed from UI)
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtInt, fmtTime, fmtUnit, fmtBtcShort } from "../lib/format.js";

const H = 240;
const PAD = { top: 16, right: 16, bottom: 28, left: 52 };

function niceTicks(min, max, count = 4) {
  if (!(max > min)) return [min];
  const span = max - min;
  const rough = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function fmtTick(v) {
  if (v >= 1000) return fmtInt(Math.round(v));
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function fmtXTick(ts, spanSec) {
  const d = new Date(ts * 1000);
  if (spanSec > 3 * 86400) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * Single-series line chart: unit price (sats / token) over block time, from
 * /trades. Crosshair snaps to the nearest trade; values live in text tokens,
 * the mark carries the accent.
 */
export default function PriceChart({ trades, ticker, loading, error }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState(null); // index into pts

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = useMemo(() => {
    const rows = (trades || [])
      .filter((t) => Number.isFinite(t.unit_price) && Number.isFinite(t.block_time))
      .sort((a, b) => a.block_time - b.block_time || a.block_height - b.block_height);
    return rows;
  }, [trades]);

  const model = useMemo(() => {
    if (pts.length === 0) return null;
    const xs = pts.map((p) => p.block_time);
    const ys = pts.map((p) => p.unit_price);
    let xMin = Math.min(...xs);
    let xMax = Math.max(...xs);
    if (xMax === xMin) { xMin -= 1800; xMax += 1800; }
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    if (yMax === yMin) { yMin *= 0.9; yMax *= 1.1; }
    const yPadding = (yMax - yMin) * 0.12;
    yMin = Math.max(0, yMin - yPadding);
    yMax += yPadding;
    const iw = Math.max(10, width - PAD.left - PAD.right);
    const ih = H - PAD.top - PAD.bottom;
    const x = (t) => PAD.left + ((t - xMin) / (xMax - xMin)) * iw;
    const y = (v) => PAD.top + ih - ((v - yMin) / (yMax - yMin)) * ih;
    const coords = pts.map((p) => [x(p.block_time), y(p.unit_price)]);
    const line = coords.map(([cx, cy], i) => `${i === 0 ? "M" : "L"}${cx.toFixed(1)} ${cy.toFixed(1)}`).join(" ");
    const area = `${line} L${coords[coords.length - 1][0].toFixed(1)} ${(PAD.top + ih).toFixed(1)} L${coords[0][0].toFixed(1)} ${(PAD.top + ih).toFixed(1)} Z`;
    const yTicks = niceTicks(yMin, yMax, 4);
    const xTickCount = Math.max(2, Math.min(6, Math.floor(iw / 110)));
    const xTicks = Array.from({ length: xTickCount }, (_, i) => xMin + ((xMax - xMin) * i) / (xTickCount - 1));
    return { coords, line, area, x, y, yTicks, xTicks, xMin, xMax, iw, ih, spanSec: xMax - xMin };
  }, [pts, width]);

  const onMove = (e) => {
    if (!model) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    model.coords.forEach(([cx], i) => {
      const d = Math.abs(cx - px);
      if (d < bestD) { bestD = d; best = i; }
    });
    setHover(best);
  };

  const last = pts.length ? pts[pts.length - 1] : null;
  const first = pts.length ? pts[0] : null;
  const change = last && first && first.unit_price > 0 ? ((last.unit_price - first.unit_price) / first.unit_price) * 100 : null;

  return (
    <section className="panel chart-panel" aria-labelledby="chart-label">
      <div className="panel-head">
        <div>
          <span className="label" id="chart-label">
            Price · sats per {ticker}
          </span>
          {last && (
            <div className="chart-headline">
              <span className="chart-last">{fmtUnit(last.unit_price)}</span>
              <span className="chart-unit">sats</span>
              {change !== null && (
                <span className={`chart-change ${change >= 0 ? "up" : "down"}`}>
                  {change >= 0 ? "+" : ""}
                  {change.toFixed(1)}% over {pts.length} trade{pts.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="chart-wrap" ref={wrapRef}>
        {error && pts.length === 0 ? (
          <div className="chart-empty err">Could not load trades: {String(error.message)}</div>
        ) : !model ? (
          <div className="chart-empty muted">{loading ? "Loading trades…" : "No trades yet — the first fill sets the price."}</div>
        ) : (
          <svg
            className="chart"
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            role="img"
            aria-label={`${ticker} unit price over time, ${pts.length} trades`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            onTouchStart={(e) => onMove(e.touches[0] ? { currentTarget: e.currentTarget, clientX: e.touches[0].clientX } : e)}
            onTouchMove={(e) => onMove(e.touches[0] ? { currentTarget: e.currentTarget, clientX: e.touches[0].clientX } : e)}
          >
            {model.yTicks.map((v) => (
              <g key={`y${v}`}>
                <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={model.y(v)} y2={model.y(v)} />
                <text className="tick" x={PAD.left - 8} y={model.y(v) + 4} textAnchor="end">
                  {fmtTick(v)}
                </text>
              </g>
            ))}
            {model.xTicks.map((t, i) => (
              <text key={`x${i}`} className="tick" x={model.x(t)} y={H - 8} textAnchor={i === 0 ? "start" : i === model.xTicks.length - 1 ? "end" : "middle"}>
                {fmtXTick(t, model.spanSec)}
              </text>
            ))}
            <path className="area" d={model.area} />
            <path className="line" d={model.line} />
            {hover !== null && model.coords[hover] && (
              <g className="crosshair">
                <line x1={model.coords[hover][0]} x2={model.coords[hover][0]} y1={PAD.top} y2={PAD.top + model.ih} />
                <circle cx={model.coords[hover][0]} cy={model.coords[hover][1]} r={5} />
              </g>
            )}
            {hover === null && last && (
              <circle className="end-dot" cx={model.coords[model.coords.length - 1][0]} cy={model.coords[model.coords.length - 1][1]} r={4} />
            )}
          </svg>
        )}
        {hover !== null && model && pts[hover] && (
          <Tooltip pt={pts[hover]} x={model.coords[hover][0]} width={width} />
        )}
      </div>
    </section>
  );
}

function Tooltip({ pt, x, width }) {
  const right = x > width * 0.6;
  return (
    <div className={`chart-tip${right ? " right" : ""}`} style={right ? { right: `${width - x + 10}px` } : { left: `${x + 10}px` }} role="status">
      <div className="v">
        {fmtUnit(pt.unit_price)} <small>sats / token</small>
      </div>
      <div className="k">
        {fmtInt(pt.amount)} {pt.ticker} · {fmtBtcShort(pt.price_sats)}
      </div>
      <div className="k">
        #{fmtInt(pt.block_height)} · {fmtTime(pt.block_time)}
      </div>
    </div>
  );
}
