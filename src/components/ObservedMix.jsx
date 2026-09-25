import { useMemo } from "react";
import { summarizeMix } from "../lib/mix.js";
import { BUCKETS, DIGIT_SPACE, EXPECTED_YIELD, probabilityPct } from "../lib/yield.js";
import { fmtDec, fmtInt } from "../lib/format.js";

const MIN_N = 16;

/**
 * Observed yield mix vs the model. Each row: a hollow ghost bar at the model
 * share and a filled bar at the observed share, with the counts beside it.
 * `showTotal` (portfolio) relaxes the n ≥ 16 rule: the user's own record
 * always shows percentages.
 */
export default function ObservedMix({ rows, loading = false, error = null, meanLabel = "Observed mean", help, showTotal = false, ticker = "" }) {
  const mix = useMemo(() => summarizeMix(rows || []), [rows]);
  const { n, counts, total, mean } = mix;
  const showPct = showTotal ? n >= 1 : n >= MIN_N;
  const hasRows = Array.isArray(rows) && rows.length > 0;

  if (loading && !hasRows) {
    return (
      <div className="mix" aria-busy="true">
        {BUCKETS.map((b) => (
          <Row key={b.id} b={b} count={0} n={0} showPct={false} />
        ))}
        <div className="mix-foot">Loading…</div>
      </div>
    );
  }
  if (error && !hasRows) {
    return <div className="err">Could not load: {String(error.message || error)}</div>;
  }

  const unit = ticker ? ` ${ticker}` : "";
  let foot;
  if (n === 0) {
    foot = <span>No mines yet — model shares shown.</span>;
  } else if (!showPct) {
    foot = <span>n = {fmtInt(n)} — too few mines to compare yet</span>;
  } else {
    foot = (
      <>
        <span>
          <span className="label">{meanLabel}</span> {fmtDec(mean, 1)} · <span className="label">Model</span> {fmtDec(EXPECTED_YIELD)} · n = {fmtInt(n)}
          {showTotal ? (
            <>
              {" "}
              · total {fmtInt(total)}
              {unit}
            </>
          ) : null}
        </span>
        <span className="help">{help || "Converges to the model as n grows."}</span>
      </>
    );
  }

  return (
    <div className="mix">
      {BUCKETS.map((b) => (
        <Row key={b.id} b={b} count={counts[b.id]} n={n} showPct={showPct} />
      ))}
      <div className="mix-foot">{foot}</div>
    </div>
  );
}

function Row({ b, count, n, showPct }) {
  const obsPct = n > 0 ? (100 * count) / n : 0;
  const modelPct = probabilityPct(b);
  const label = `${b.label}: ${count} of ${n}${showPct ? ` (${fmtDec(obsPct, 1)}%)` : ""}, model ${modelPct}% (${b.count} of ${DIGIT_SPACE})`;
  return (
    <div className={`mix-row tier-${b.id}`} role="img" aria-label={label}>
      <span className="lb">{fmtInt(b.yield)}</span>
      <span className="track">
        <span className="ghost" style={{ width: `${modelPct}%` }} />
        <span className="fill" style={{ width: `${obsPct}%` }} />
      </span>
      <span className="rd">
        {count} of {n}
        {showPct ? ` · ${fmtDec(obsPct, 1)}%` : ""} <span className="model">(model {modelPct}%)</span>
      </span>
    </div>
  );
}
