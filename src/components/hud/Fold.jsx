import Led from "./Led.jsx";

/**
 * Collapsible HUD panel on native <details>: the head row is the <summary>
 * (LED · title · caret) with an optional one-line `summary` under it that
 * stays visible while folded. No state, no deps.
 *
 *   <Fold title="Yield model" summary="f 6.25% → 1000 · …" open={false}>…</Fold>
 */
export default function Fold({ title, summary, led = "ok", open = false, className = "", children, ...rest }) {
  return (
    <details className={`panel fold${className ? ` ${className}` : ""}`} open={open || undefined} {...rest}>
      <summary className="panel-head fold-head">
        <Led state={led} />
        <div className="panel-title">{title}</div>
        <span className="fold-caret" aria-hidden="true" />
        {summary && <div className="fold-summary">{summary}</div>}
      </summary>
      <div className="panel-body">{children}</div>
    </details>
  );
}
