import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import Panel from "../components/hud/Panel.jsx";
import { ledFromPoll } from "../components/hud/Led.jsx";
import { fmtAgo, fmtDec, fmtInt } from "../lib/format.js";
import { isIndexerBusy } from "../lib/errors.js";
import { BUCKETS, DIGIT_SPACE, EXPECTED_YIELD, YIELD_SD, probabilityPct } from "../lib/yield.js";
import {
  BLOCKS_PER_DAY,
  DAYS_DEFAULT,
  WINDOWS,
  windowLabel,
  visibleColumns,
  plateRows,
  blocksSinceTier,
  chiSquare,
  cumulativeMeanYield,
  currentRun,
  digitCounts,
  expectedRunLength,
  gridLayoutRows,
  longestRunPerTier,
  meanRunLengthPerTier,
  meanYield,
  pValueChiSquare,
  roadColumns,
  roadWidth,
  latestRoad,
  rollingMeanYield,
  runs as runsOf,
  standardError,
  tierCounts,
  tierProbability,
  wilson,
  yieldOfDigit,
} from "../lib/digits.js";

const POLL_MS = 30_000;
const HEX = "0123456789abcdef";
// Digit grid sizing: the grid
// fills the panel width; its row count grows with the window (plateRows) so
// digits stay legible, and a window too long for the width keeps 11 px
// cells and scrolls sideways, newest end in view. Only the columns in view
// are drawn, so 60 days (~10k cells) stays light.
const CELL_MIN = 11; // px — the densest the grid gets before it scrolls (a letter still fits)
const CELL_MAX = 26;
const GLYPH_MIN = 16; // preferred cell size when choosing the grid's row count
const GLYPH_FONT_MIN = 7; // every cell carries its digit; small cells get small letters
const PLATE_BUFFER = 12; // extra columns drawn each side of the viewport
// Sequence chart: 8 rows of 26 px cells (tall and big enough to fill the
// space beside the stats); the panel scrolls sideways.
const ROAD_ROWS = 8;
const ROAD_CELL = 26;
const ROAD_CELL_PHONE = 22;
const ROAD_MAX_COLS = 240; // newest columns drawn; statistics still cover the whole window
const CHI_DF = DIGIT_SPACE - 1;
const CHI_MIN_N = 5 * DIGIT_SPACE; // below 5 expected per cell the χ² approximation is rough
const TIER_LABEL = Object.fromEntries(BUCKETS.map((b) => [b.id, b.label]));

/**
 * #/probability — the record of block-hash last digits, laid out like an
 * analysis board (bead plate, run columns) with the observed counts held
 * against the uniform model. Strictly descriptive: every block's digit is
 * independent of the last, and nothing here predicts the next one.
 */
export default function ProbabilityPage() {
  const { health, chainTip } = useApp();
  const mobile = useIsMobile();
  const [days, setDays] = useState(DAYS_DEFAULT);
  const tip = chainTip;

  // One /digits?days read per window (and per new block). Windows are by
  // real time: blocks per day are not fixed, so a window holds however many
  // blocks were mined in it. The window (in days) is stamped on the result:
  // while a new chip's read is in flight the previous record stays on
  // screen, dimmed and labelled with its own window, so the page does not
  // collapse to "Loading…" on every switch.
  const q = usePoll((s) => indexer.digitsByDays(days, s).then((r) => ({ ...r, window: days })), POLL_MS, [days, tip]);
  const rec = q.data || null;
  const stale = !!rec && rec.window !== days;
  const digits = rec ? rec.digits : "";
  const n = digits.length;
  const led = ledFromPoll(q);

  // null → the record is on screen. An empty "ok" window means one of two
  // things (indexer API): complete → the log holds blocks but none inside the
  // window (its newest, #to, is older than the window); not complete → the
  // log holds nothing yet. "unsupported" / "invalid" carry no window at all.
  let state = null;
  if (!rec) state = q.error ? "Indexer unreachable." : "Loading…";
  else if (rec.status === "unsupported") state = "Day windows need a newer indexer.";
  else if (rec.status === "invalid") state = "The indexer's answer for this window could not be read.";
  else if (n === 0 && rec.complete) state = `No blocks in the last ${windowLabel(rec.window)} — the newest block held, #${fmtInt(rec.to)}, is older.`;
  else if (n === 0) state = "No blocks held yet.";
  const isErr = (!rec && !!q.error) || rec?.status === "invalid";

  const heightAt = useCallback((i) => (rec ? rec.from + i : null), [rec]);

  // "1,008 blocks · #969,189 → #970,196" — the count is whatever the window
  // holds; it is never compared with a nominal blocks-per-day figure.
  const held =
    !rec || n === 0 ? null : (
      <>
        <span className="num">{fmtInt(n)}</span> block{n === 1 ? "" : "s"}
        <span className="muted">
          {" "}
          · #{fmtInt(rec.from)} → #{fmtInt(rec.to)}
        </span>
      </>
    );

  return (
    <main className={`page probability-page${stale ? " is-stale" : ""}`} aria-busy={stale}>
      <header className="token-head">
        <div className="token-head-main">
          <h1 className="ticker">Probability</h1>
          <div className="meta">
            <span>
              {tip ? (
                <>
                  as of block <span className="mono">#{fmtInt(tip)}</span>
                  {health.data?.last_progress_at ? <span className="muted"> · indexed {fmtAgo(health.data.last_progress_at)}</span> : null}
                </>
              ) : health.error ? (
                <span className="err">{isIndexerBusy(health.error) ? "indexer busy" : "indexer offline"}</span>
              ) : (
                "connecting…"
              )}
            </span>
            <span className="pb-rule">Every block&apos;s digit is independent of the last. This page describes the record; nothing on it predicts the next block.</span>
          </div>
        </div>
      </header>

      <div className="board-controls pb-controls">
        <div className="chips" role="tablist" aria-label="Window, by time">
          {WINDOWS.map((w) => (
            <button key={w.days} type="button" role="tab" aria-selected={days === w.days} className={`chip${days === w.days ? " active" : ""}`} onClick={() => setDays(w.days)} aria-label={`Last ${w.label}`}>
              {w.label}
            </button>
          ))}
        </div>
        <div className="pb-held mono" aria-live="polite">
          {stale ? (
            <span className="muted">
              loading the last {windowLabel(days)}… showing {windowLabel(rec.window)}
              {held ? " · " : ""}
            </span>
          ) : null}
          {held}
          {rec && rec.status === "ok" && rec.complete === false ? <span className="pb-partial muted">history still loading — the indexer is filling older blocks</span> : null}
        </div>
      </div>

      <Panel title="Digit grid" led={led} right={<span className="label">oldest top-left · newest last</span>} aria-label="Digit grid">
        {state ? <StateLine text={state} err={isErr} /> : <BeadPlate digits={digits} heightAt={heightAt} />}
      </Panel>

      <Panel title="Same-tier sequences" led={led} right={<span className="label">new column = tier changed</span>} aria-label="Same-tier sequences">
        {state ? <StateLine text={state} err={isErr} /> : <RunColumns digits={digits} heightAt={heightAt} mobile={mobile} />}
      </Panel>

      <Panel title="Distribution vs model" led={led} right={<span className="label">model: each digit 1 in {DIGIT_SPACE}</span>} aria-label="Distribution vs model">
        {state ? <StateLine text={state} err={isErr} /> : <Distribution digits={digits} />}
      </Panel>

      <Panel title="Convergence" led={led} right={<span className="label">model mean {fmtDec(EXPECTED_YIELD, 1)}</span>} aria-label="Convergence">
        {state ? <StateLine text={state} err={isErr} /> : <Convergence digits={digits} heightAt={heightAt} />}
      </Panel>
    </main>
  );
}

function StateLine({ text, err }) {
  return <div className={err ? "err" : "empty"}>{text}</div>;
}

// ---- shared bits ---------------------------------------------------------------------------------

/** Measure an element's width (callback ref: survives conditional mounts). */
function useWidth(fallback = 720) {
  const obs = useRef(null);
  const elRef = useRef(null);
  const [width, setWidth] = useState(fallback);
  const ref = useCallback((el) => {
    if (obs.current) {
      obs.current.disconnect();
      obs.current = null;
    }
    elRef.current = el;
    if (!el) return;
    // Content width: clientWidth includes padding, and a drawing sized to it
    // would overflow a padded scroller by exactly that padding.
    const update = () => {
      const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
      const pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
      const w = Math.floor(el.clientWidth - pad);
      if (w > 0) setWidth(w);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    obs.current = new ResizeObserver(update);
    obs.current.observe(el);
  }, []);
  return [ref, width, elRef];
}

/** Pitch of a square cell so `cols` columns fit `width` where they can, else the floor (the wrapper scrolls). */
function cellSize(width, cols) {
  if (!(cols > 0)) return CELL_MAX;
  return Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor(width / cols)));
}

/** "#970,196 · digit c → 500" */
function cellTitle(height, digit) {
  return `#${fmtInt(height)} · digit ${digit} → ${fmtInt(yieldOfDigit(digit))}`;
}

/** The four tiers with yield and model share. */
function TierLegend() {
  return (
    <ul className="pb-legend" aria-label="Tiers">
      {BUCKETS.map((b) => (
        <li key={b.id} className={`tier-${b.id}`}>
          <i aria-hidden="true" />
          <span className="mono">{b.label}</span>
          <span className="muted">→ {fmtInt(b.yield)} · model {probabilityPct(b)}%</span>
        </li>
      ))}
    </ul>
  );
}

/** Scrolling wrapper for the grid / road: keeps the newest end in view whenever the drawing changes. */
function useScrollToEnd(elRef, deps) {
  useEffect(() => {
    const el = elRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scroll on every drawing change
  }, deps);
}

/** Simple "nice" ticks between lo and hi. */
function niceTicks(lo, hi, count = 4) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

// ---- a) digit grid (bead plate) ------------------------------------------------------------------

function BeadPlate({ digits, heightAt }) {
  const [ref, width, elRef] = useWidth();
  const [hover, setHover] = useState(null);
  const [scrollCol, setScrollCol] = useState(0); // first column in view
  const n = digits.length;
  const rows = plateRows(n, width, GLYPH_MIN);
  // Row-major: blocks run left to right, then the next row.
  const cols = useMemo(() => gridLayoutRows(digits, rows), [digits, rows]);
  const cell = cellSize(width, cols.length);
  const W = Math.max(1, cols.length * cell);
  const H = rows * cell;
  const scrolls = W > width + 1;

  // Newest block in view whenever the drawing changes: it sits in the last
  // row at column (n − 1) % width, so scroll that column to the right edge.
  // The drawn column range follows the scroller.
  useEffect(() => {
    const el = elRef.current;
    if (!el || !cols.length) return;
    const newestCol = (digits.length - 1) % cols.length;
    el.scrollLeft = Math.max(0, (newestCol + 1) * cell - el.clientWidth + cell);
    setScrollCol(Math.floor(el.scrollLeft / cell));
  }, [elRef, digits, cell, rows, cols.length]);
  useEffect(() => setHover(null), [digits]);
  // State is the first column in view, so a scroll re-renders only when a
  // new column enters (React bails out on an unchanged value).
  const onScroll = (e) => setScrollCol(Math.floor(e.currentTarget.scrollLeft / cell));
  const range = visibleColumns(scrollCol * cell, width, cell, cols.length, PLATE_BUFFER);

  const pick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width);
    const y = (e.clientY - rect.top) * (H / rect.height);
    const c = Math.floor(x / cell);
    const r = Math.floor(y / cell);
    const i = r * cols.length + c;
    setHover(c >= 0 && c < cols.length && r >= 0 && r < rows && i >= 0 && i < n ? i : null);
  };
  const onTouch = (e) => {
    const t = e.touches && e.touches[0];
    if (t) pick({ currentTarget: e.currentTarget, clientX: t.clientX, clientY: t.clientY });
  };

  const newest = n - 1;
  const focus = hover ?? newest;
  const readout = focus !== null && focus >= 0 ? cellTitle(heightAt(focus), digits[focus]) : "";
  const shown = range ? cols.slice(range.first, range.last + 1) : [];
  const fontSize = Math.max(GLYPH_FONT_MIN, Math.round(cell * (cell < GLYPH_MIN ? 0.64 : 0.56)));

  return (
    <div className="pb-grid">
      <div className="pb-scroll" ref={ref} onScroll={onScroll}>
        <svg className="pb-plate" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Digit grid, ${fmtInt(n)} blocks in ${cols.length} columns of ${rows}, oldest first, newest ${readout}.`} onMouseMove={pick} onMouseLeave={() => setHover(null)} onTouchStart={onTouch} onTouchMove={onTouch}>
          {shown.map((col, j) => {
            const c = range.first + j;
            return col.map((k) => {
              const x = c * cell;
              const y = k.row * cell;
              return (
                <g key={k.index} className={`pb-cell tier-${k.tier ?? "none"}${k.index === newest ? " is-newest" : ""}${hover === k.index ? " is-hover" : ""}`}>
                  <title>{cellTitle(heightAt(k.index), k.digit)}</title>
                  <rect x={x + 0.5} y={y + 0.5} width={cell - 1} height={cell - 1} />
                  <text x={x + cell / 2} y={y + cell / 2} dy="0.36em" textAnchor="middle" fontSize={fontSize}>
                    {k.digit}
                  </text>
                </g>
              );
            });
          })}
        </svg>
      </div>
      <div className="pb-readout mono">
        <span className="k">{hover === null ? "newest" : "block"}</span> {readout}
        {scrolls && <span className="muted"> · scroll left for older blocks</span>}
      </div>
      <TierLegend />
    </div>
  );
}

// ---- b) same-tier sequences (big road) ----------------------------------------------------------

/** "■ f 1,000" — the tier swatch used by every tier label on the page. */
function TierTag({ id, showYield = true }) {
  const b = BUCKETS.find((x) => x.id === id);
  if (!b) return <span className="pb-tier">?</span>;
  return (
    <span className={`pb-tier tier-${b.id}`}>
      <i aria-hidden="true" />
      <span className="mono">{b.label}</span>
      {showYield && <span className="muted">{fmtInt(b.yield)}</span>}
    </span>
  );
}

function RunColumns({ digits, heightAt, mobile }) {
  const [ref, , elRef] = useWidth();
  const [hover, setHover] = useState(null);
  const runList = useMemo(() => runsOf(digits), [digits]);
  const allCells = useMemo(() => roadColumns(runList, ROAD_ROWS), [runList]);
  const { cells, dropped } = useMemo(() => latestRoad(allCells, ROAD_MAX_COLS), [allCells]);
  const byPos = useMemo(() => new Map(cells.map((c) => [`${c.col},${c.row}`, c])), [cells]);
  const cols = roadWidth(cells);
  const cell = mobile ? ROAD_CELL_PHONE : ROAD_CELL;
  const W = Math.max(1, cols * cell);
  const H = ROAD_ROWS * cell;
  const n = digits.length;
  useScrollToEnd(elRef, [cells, cell]);
  useEffect(() => setHover(null), [digits]);

  const pick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width);
    const y = (e.clientY - rect.top) * (H / rect.height);
    const k = byPos.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`);
    setHover(k ? k.index : null);
  };
  const onTouch = (e) => {
    const t = e.touches && e.touches[0];
    if (t) pick({ currentTarget: e.currentTarget, clientX: t.clientX, clientY: t.clientY });
  };

  const cur = currentRun(runList);
  const longest = longestRunPerTier(runList);
  const means = meanRunLengthPerTier(runList);
  const since = blocksSinceTier(digits, "high");
  const newest = n - 1;
  const focus = hover ?? newest;
  const readout = focus >= 0 ? cellTitle(heightAt(focus), digits[focus]) : "";
  const r = cell / 2 - 1.5;
  // The latest few sequences in words, newest last: "7–b ×3 → c–e ×1 → 0–6 ×2 (now)".
  const recent = runList.slice(-5);

  return (
    <div className="pb-road">
      <div className="pb-road-main">
        <p className="pb-howto">
          Each column is one <b>sequence</b>: blocks in a row whose digits fall in the same tier. Read top to bottom, then left to right. When the tier changes, a new column starts; a sequence longer than {ROAD_ROWS} bends right along the bottom row.
        </p>
        {recent.length > 0 && (
          <div className="pb-recent mono" aria-label="Latest sequences, oldest to newest">
            <span className="k">latest</span>
            {recent.map((q, i) => (
              <span key={q.start} className={`pb-seq tier-${q.tier}`}>
                {i > 0 && <span className="arrow" aria-hidden="true">→</span>}
                <i aria-hidden="true" />
                {TIER_LABEL[q.tier] ?? "?"} × {fmtInt(q.length)}
                {i === recent.length - 1 && <span className="muted"> (now)</span>}
              </span>
            ))}
          </div>
        )}
        <div className="pb-scroll pb-road-scroll" ref={ref}>
          <svg className="pb-roadsvg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Same-tier sequences: ${fmtInt(runList.length)} sequences over ${fmtInt(n)} blocks, one column per sequence. Newest ${readout}.`} onMouseMove={pick} onMouseLeave={() => setHover(null)} onTouchStart={onTouch} onTouchMove={onTouch}>
            {cells.map((k) => {
              const cx = k.col * cell + cell / 2;
              const cy = k.row * cell + cell / 2;
              return (
                <g key={k.index} className={`pb-dot tier-${k.tier ?? "none"}${k.index === newest ? " is-newest" : ""}${hover === k.index ? " is-hover" : ""}`}>
                  <circle cx={cx} cy={cy} r={r} />
                  <text x={cx} y={cy} dy="0.36em" textAnchor="middle" fontSize={Math.round(cell * 0.5)}>
                    {digits[k.index]}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="pb-readout mono">
          <span className="k">{hover === null ? "newest" : "block"}</span> {readout}
          {dropped > 0 ? <span className="muted"> · latest {fmtInt(ROAD_MAX_COLS)} columns drawn — scroll left for older ones; the table covers the whole window</span> : null}
        </div>
      </div>

      <div className="pb-stats">
        <dl className="pb-kv">
          <div>
            <dt>Current sequence</dt>
            <dd>
              {cur ? (
                <>
                  <TierTag id={cur.tier} showYield={false} /> × {fmtInt(cur.length)} <span className="muted">block{cur.length === 1 ? "" : "s"} in a row</span>
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>Blocks since the last f</dt>
            <dd>{since === null ? <>no f in these {fmtInt(n)} blocks</> : fmtInt(since)}</dd>
            <dd className="sub">Every block is 1 in {DIGIT_SPACE} for f, however long since the last one.</dd>
          </div>
        </dl>

        <div className="table pb-runtable" role="table" aria-label="Sequence length per tier">
          <div className="tr th" role="row">
            <span>Tier</span>
            <span className="right" title="longest sequence in this window">
              Longest
            </span>
            <span className="right" title="average sequence length in this window">
              Average
            </span>
            <span className="right" title="expected average length: 1 ÷ (1 − tier share)">
              Expected
            </span>
          </div>
          {BUCKETS.map((b) => (
            <div className="tr" role="row" key={b.id}>
              <TierTag id={b.id} showYield={!mobile} />
              <span className="num right">{longest[b.id] > 0 ? fmtInt(longest[b.id]) : "—"}</span>
              <span className="num right">{means[b.id] === null ? "—" : fmtDec(means[b.id], 2)}</span>
              <span className="num right muted">{fmtDec(expectedRunLength(tierProbability(b.id)), 2)}</span>
            </div>
          ))}
        </div>
        <p className="pb-note muted">Length = blocks in one sequence. Expected = 1 ÷ (1 − tier share).</p>
      </div>
    </div>
  );
}

// ---- c) distribution vs model ---------------------------------------------------------------------

function Distribution({ digits }) {
  const [ref, width] = useWidth();
  const counts = useMemo(() => digitCounts(digits), [digits]);
  const tiers = useMemo(() => tierCounts(digits), [digits]);
  const n = digits.length;
  const expected = n / DIGIT_SPACE;
  const stat = chiSquare(counts, expected);
  const p = pValueChiSquare(stat, CHI_DF);

  // Bars: measured width, fixed height; the expected count is a dashed line.
  const H = 190;
  const left = 34;
  const right = 8;
  const top = 12;
  const bottom = 26;
  const innerW = Math.max(60, width - left - right);
  const innerH = H - top - bottom;
  const yMax = Math.max(1, Math.max(...counts, expected) * 1.12);
  const yOf = (v) => top + innerH - (v / yMax) * innerH;
  const pitch = innerW / DIGIT_SPACE;
  const barW = Math.max(3, pitch * 0.62);
  const ticks = niceTicks(0, yMax, 4).filter((t) => t <= yMax);

  let verdict;
  if (p === null) verdict = "—";
  else if (p >= 0.05) verdict = "consistent with a uniform digit";
  else verdict = "deviates from uniform at this sample size — expected in about 1 window of 20 even for a perfectly uniform digit";

  return (
    <div className="pb-dist">
      <div className="chart-wrap" ref={ref}>
        <svg className="chart pb-bars" width="100%" height={H} viewBox={`0 0 ${Math.max(1, width)} ${H}`} role="img" aria-label={`Observed count of each last digit over ${fmtInt(n)} blocks against the expected ${fmtDec(expected, 1)} per digit.`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={left} x2={left + innerW} y1={yOf(t)} y2={yOf(t)} />
              <text className="tick" x={left - 6} y={yOf(t) + 3.5} textAnchor="end">
                {fmtInt(t)}
              </text>
            </g>
          ))}
          {HEX.split("").map((d, i) => {
            const b = BUCKETS.find((x) => x.digits.includes(d));
            const x = left + i * pitch + (pitch - barW) / 2;
            const h = innerH - (yOf(counts[i]) - top);
            return (
              <g key={d} className={`pb-bar tier-${b.id}`}>
                <title>{`digit ${d} · ${fmtInt(counts[i])} observed · ${fmtDec(expected, 1)} expected`}</title>
                <rect x={x} y={yOf(counts[i])} width={barW} height={Math.max(0, h)} />
                <text className="pb-x" x={left + i * pitch + pitch / 2} y={H - 8} textAnchor="middle">
                  {d}
                </text>
              </g>
            );
          })}
          <line className="axis" x1={left} x2={left + innerW} y1={top + innerH} y2={top + innerH} />
          <g className="pb-expected">
            <line x1={left} x2={left + innerW} y1={yOf(expected)} y2={yOf(expected)} />
          </g>
        </svg>
      </div>
      <div className="pb-note muted">
        Dashed line = expected {fmtDec(expected, 1)} per digit ({fmtInt(n)} blocks ÷ {DIGIT_SPACE}).
      </div>

      <div className="pb-shares">
        {BUCKETS.map((b) => {
          const k = tiers[b.id];
          const w = wilson(k, n) || { lo: 0, hi: 1 };
          const obs = n > 0 ? (100 * k) / n : 0;
          const model = Number(probabilityPct(b));
          return (
            <div className={`pb-share tier-${b.id}`} key={b.id} role="img" aria-label={`${b.label}: ${fmtInt(k)} of ${fmtInt(n)}, ${fmtDec(obs, 1)}% (95% interval ${fmtDec(100 * w.lo, 1)} to ${fmtDec(100 * w.hi, 1)}), model ${model}%`}>
              <span className="lb">
                <TierTag id={b.id} />
              </span>
              <span className="track">
                <span className="ghost" style={{ width: `${model}%` }} />
                <span className="fill" style={{ width: `${obs}%` }} />
                <span className="ci" style={{ left: `${100 * w.lo}%`, width: `${100 * (w.hi - w.lo)}%` }} />
              </span>
              <span className="rd">
                {fmtDec(obs, 1)}% <span className="muted">[{fmtDec(100 * w.lo, 1)}–{fmtDec(100 * w.hi, 1)}]</span> <span className="model">model {model}%</span> <span className="muted">· {fmtInt(k)}</span>
              </span>
            </div>
          );
        })}
        <div className="pb-note muted">Filled bar = observed share; outline = model share; the thin line under each bar is the 95% Wilson interval.</div>
      </div>

      <div className="pb-chi mono">
        <span>
          <span className="k">chi-square</span> {stat === null ? "—" : fmtDec(stat, 2)} <span className="muted">(df {CHI_DF})</span> · <span className="k">p</span> {p === null ? "—" : p < 0.001 ? "< 0.001" : fmtDec(p, 3)}
        </span>
        <span className={p !== null && p < 0.05 ? "pb-verdict pb-verdict-dev" : "pb-verdict"}>{verdict}</span>
        {n > 0 && n < CHI_MIN_N ? <span className="muted">fewer than {CHI_MIN_N} blocks — the χ² approximation is rough here</span> : null}
      </div>
    </div>
  );
}

// ---- d) convergence -------------------------------------------------------------------------------

function Convergence({ digits, heightAt }) {
  const [ref, width] = useWidth();
  const cum = useMemo(() => cumulativeMeanYield(digits), [digits]);
  const rolling = useMemo(() => rollingMeanYield(digits, BLOCKS_PER_DAY), [digits]);
  const n = digits.length;
  const mean = meanYield(digits);
  const se = standardError(n);
  const lastRoll = [...rolling].reverse().find((v) => v !== null) ?? null;

  const H = 220;
  const left = 44;
  const right = 12;
  const top = 12;
  const bottom = 24;
  const innerW = Math.max(60, width - left - right);
  const innerH = H - top - bottom;

  // Domain: from the 16th block on (the first few running means are the
  // single-block yields and would flatten everything else), the rolling
  // mean, and the model — the early points enter from off-scale.
  const startIdx = Math.min(15, Math.max(0, n - 1));
  let lo = EXPECTED_YIELD;
  let hi = EXPECTED_YIELD;
  for (let i = startIdx; i < n; i++) {
    if (cum[i] < lo) lo = cum[i];
    if (cum[i] > hi) hi = cum[i];
    const v = rolling[i];
    if (v !== null) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const pad = Math.max(10, (hi - lo) * 0.15);
  lo = Math.max(0, lo - pad);
  hi += pad;
  const xOf = (i) => left + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const yOf = (v) => top + innerH - ((v - lo) / (hi - lo)) * innerH;
  const path = (series) => {
    let d = "";
    let pen = false;
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const ticks = niceTicks(lo, hi, 5);
  const xTicks = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 1 ? [0] : [];
  const clipId = "pb-conv-clip";

  return (
    <div className="pb-conv">
      <div className="chart-wrap" ref={ref}>
        <svg className="chart pb-convsvg" width="100%" height={H} viewBox={`0 0 ${Math.max(1, width)} ${H}`} role="img" aria-label={`Cumulative mean yield over ${fmtInt(n)} blocks, ending at ${mean === null ? "—" : fmtDec(mean, 1)} against the model ${fmtDec(EXPECTED_YIELD, 1)}; rolling ${BLOCKS_PER_DAY}-block mean ${lastRoll === null ? "not yet full" : fmtDec(lastRoll, 1)}.`}>
          <defs>
            <clipPath id={clipId}>
              <rect x={left} y={top} width={innerW} height={innerH} />
            </clipPath>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={left} x2={left + innerW} y1={yOf(t)} y2={yOf(t)} />
              <text className="tick" x={left - 6} y={yOf(t) + 3.5} textAnchor="end">
                {fmtInt(Math.round(t))}
              </text>
            </g>
          ))}
          <text className="tick pb-ylabel" x={left - 6} y={top - 2} textAnchor="end">
            yield
          </text>
          <line className="axis" x1={left} x2={left + innerW} y1={top + innerH} y2={top + innerH} />
          {xTicks.map((i, k) => (
            <text key={i} className="tick" x={xOf(i)} y={H - 6} textAnchor={k === 0 ? "start" : k === xTicks.length - 1 ? "end" : "middle"}>
              #{fmtInt(heightAt(i))}
            </text>
          ))}
          <g clipPath={`url(#${clipId})`}>
            <path className="pb-rolling" d={path(rolling)} />
            <path className="pb-cum" d={path(cum)} />
          </g>
          <g className="pb-model">
            <line x1={left} x2={left + innerW} y1={yOf(EXPECTED_YIELD)} y2={yOf(EXPECTED_YIELD)} />
            <text x={left + innerW} y={yOf(EXPECTED_YIELD) - 4} textAnchor="end">
              model {fmtDec(EXPECTED_YIELD, 1)}
            </text>
          </g>
        </svg>
      </div>
      <div className="pb-legend pb-lines" aria-hidden="true">
        <span>
          <i className="l-cum" /> cumulative mean
        </span>
        <span>
          <i className="l-rolling" /> rolling {BLOCKS_PER_DAY}-block mean
        </span>
        <span>
          <i className="l-model" /> model {fmtDec(EXPECTED_YIELD, 1)}
        </span>
      </div>
      <div className="pb-chi mono">
        <span>
          <span className="k">observed mean</span> {mean === null ? "—" : fmtDec(mean, 1)} <span className="muted">vs model {fmtDec(EXPECTED_YIELD, 1)}</span>
        </span>
        <span>
          <span className="k">standard error</span> {se === null ? "—" : `±${fmtDec(se, 1)}`} <span className="muted">= √(σ² / n), σ = {fmtDec(YIELD_SD, 1)}, n = {fmtInt(n)}</span>
        </span>
        <span>
          <span className="k">rolling {BLOCKS_PER_DAY}</span> {lastRoll === null ? <span className="muted">needs {BLOCKS_PER_DAY} blocks</span> : fmtDec(lastRoll, 1)}
        </span>
      </div>
    </div>
  );
}
