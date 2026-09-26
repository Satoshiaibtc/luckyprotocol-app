import { useEffect, useMemo, useRef, useState } from "react";
import { INTERVALS, candleLayout, fmtTick, nearestCandle } from "../lib/market.js";
import { fmtBtcShort, fmtInt, fmtTime, fmtUnit, fmtUsd } from "../lib/format.js";

const H = 300;
const VOL_H = 56;

/**
 * Hand-built SVG candlestick chart (HASHDECK: mono axes, no library):
 * OHLC bodies coloured by sign, volume bars beneath, a dashed last-price
 * line, and a hover crosshair whose readout (o / h / l / c / v) sits above
 * the plot. `candles` ascending from /tokens/:ticker/candles; empty
 * buckets are omitted upstream, so columns are index-spaced. Keyboard:
 * the svg is focusable; ← → step through the buckets, Home / End jump,
 * Esc returns to the last one. The shown bucket's OHLC is in the svg's
 * accessible name rather than a live region, so a pointer crossing 168
 * columns does not announce 168 times.
 */
export default function CandleChart({ ticker, candles, interval, onInterval, loading, error, usd = null }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(640);
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

  const rows = useMemo(() => (Array.isArray(candles) ? candles : []), [candles]);
  const L = useMemo(() => candleLayout({ candles: rows, width, height: H, volumeHeight: VOL_H, interval }), [rows, width, interval]);

  useEffect(() => {
    setHover(null);
  }, [rows, interval]);

  const onMove = (e) => {
    if (!L) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(nearestCandle(L, e.clientX - rect.left));
  };
  const onTouch = (e) => {
    const t = e.touches && e.touches[0];
    if (t) onMove({ currentTarget: e.currentTarget, clientX: t.clientX });
  };

  const shown = hover !== null && L ? L.bars[hover] : L ? L.bars[L.bars.length - 1] : null;
  const c = shown ? shown.c : null;
  const onKey = (e) => {
    if (!L) return;
    const n = L.bars.length;
    const cur = hover ?? n - 1;
    let next = null;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(n - 1, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") next = -1;
    else return;
    e.preventDefault();
    setHover(next < 0 ? null : next);
  };
  const readout = c ? `${fmtTime(c.t)}: open ${fmtUnit(c.o)}, high ${fmtUnit(c.h)}, low ${fmtUnit(c.l)}, close ${fmtUnit(c.c)}, volume ${fmtBtcShort(c.v_sats)} over ${fmtInt(c.n)} fill${c.n === 1 ? "" : "s"}` : "";

  return (
    <div className="candles">
      <div className="candles-head">
        <div className="candles-readout mono" aria-hidden="true">
          {c ? (
            <>
              <span className="k">{fmtTime(c.t)}</span>
              <span>
                <span className="k">O</span> {fmtUnit(c.o)}
              </span>
              <span>
                <span className="k">H</span> {fmtUnit(c.h)}
              </span>
              <span>
                <span className="k">L</span> {fmtUnit(c.l)}
              </span>
              <span className={`delta-${shown.up ? "up" : "down"}`}>
                <span className="k">C</span> {fmtUnit(c.c)}
              </span>
              <span>
                <span className="k">V</span> {fmtBtcShort(c.v_sats)} · {fmtInt(c.v_amount)} {ticker} · {fmtInt(c.n)} fill{c.n === 1 ? "" : "s"}
                {usd ? ` · ${fmtUsd(c.v_sats, usd)}` : ""}
              </span>
            </>
          ) : (
            <span className="k">sats per {ticker}</span>
          )}
        </div>
        <div className="chips chips-sm" role="tablist" aria-label="Candle interval">
          {INTERVALS.map((iv) => (
            <button key={iv.id} type="button" role="tab" aria-selected={interval === iv.id} className={`chip${interval === iv.id ? " active" : ""}`} onClick={() => onInterval?.(iv.id)}>
              {iv.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chart-wrap" ref={wrapRef}>
        {error && rows.length === 0 ? (
          <div className="chart-empty err">Could not load candles: {String(error.message)}</div>
        ) : !L ? (
          <div className="chart-empty muted">{loading ? "Loading candles…" : "no trades yet — the first fill prints the first candle"}</div>
        ) : (
          <svg
            className="chart candle-svg"
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            role="img"
            tabIndex={0}
            aria-label={`${ticker} ${interval} candles, ${rows.length} buckets, last ${fmtUnit(L.last.v)} sats. ${readout}. Arrow keys step through the buckets.`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            onTouchStart={onTouch}
            onTouchMove={onTouch}
            onKeyDown={onKey}
          >
            {L.priceTicks.map((t) => (
              <g key={`y${t.v}`}>
                <line className="grid" x1={L.left} x2={L.right} y1={t.y} y2={t.y} />
                <text className="tick" x={L.left - 8} y={t.y + 4} textAnchor="end">
                  {fmtTick(t.v, L.priceStep)}
                </text>
              </g>
            ))}
            <line className="axis" x1={L.left} x2={L.right} y1={L.priceBottom} y2={L.priceBottom} />
            <line className="axis" x1={L.left} x2={L.right} y1={L.volBottom} y2={L.volBottom} />
            {L.timeTicks.map((t) => (
              <text key={`x${t.i}`} className="tick" x={t.x} y={H - 6} textAnchor={t.i === 0 ? "start" : t.i === rows.length - 1 ? "end" : "middle"}>
                {t.label}
              </text>
            ))}
            {L.bars.map((b) => (
              <g key={b.i} className={`candle ${b.up ? "up" : "down"}${hover === b.i ? " hot" : ""}`}>
                <line className="wick" x1={b.x} x2={b.x} y1={b.yH} y2={b.yL} />
                <rect className="body" x={b.x - L.bodyW / 2} y={Math.min(b.yO, b.yC)} width={L.bodyW} height={Math.max(1, Math.abs(b.yC - b.yO))} />
                <rect className="vol" x={b.x - L.bodyW / 2} y={b.yV} width={L.bodyW} height={Math.max(0, L.volBottom - b.yV)} />
              </g>
            ))}
            <g className="last-line">
              <line x1={L.left} x2={L.right} y1={L.last.y} y2={L.last.y} />
              <text x={L.right} y={L.last.y - 4} textAnchor="end">
                {fmtUnit(L.last.v)}
              </text>
            </g>
            {hover !== null && L.bars[hover] && (
              <g className="crosshair">
                <line x1={L.bars[hover].x} x2={L.bars[hover].x} y1={L.priceTop} y2={L.volBottom} />
                <line x1={L.left} x2={L.right} y1={L.bars[hover].yC} y2={L.bars[hover].yC} />
                <text x={L.left - 8} y={L.bars[hover].yC + 4} textAnchor="end" className="crosshair-label">
                  {fmtTick(L.bars[hover].c.c)}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
