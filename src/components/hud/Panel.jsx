import Led from "./Led.jsx";

/**
 * HUD panel: luminous top edge + corner ticks (CSS), a head row with the
 * status LED, an uppercase title and an optional right-hand area.
 *
 *   <Panel title="YIELD MODEL" led="ok" right={<span className="label">…</span>}>
 */
export default function Panel({ title, led = "idle", right, className = "", as: Tag = "section", children, ...rest }) {
  return (
    <Tag className={`panel${className ? ` ${className}` : ""}`} {...rest}>
      {(title || right) && (
        <div className="panel-head">
          <Led state={led} />
          {title && <div className="panel-title">{title}</div>}
          {right && <div className="panel-right">{right}</div>}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </Tag>
  );
}
