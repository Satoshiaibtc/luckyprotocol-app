import { fmtAgo, fmtInt, blockUrl } from "../lib/format.js";
import { mineYield } from "../lib/yield.js";

/**
 * The tip block's hash in monospace with the LAST character highlighted —
 * that single hex digit is what decides the yield of every MINE the block
 * confirms.
 */
export default function BlockStrip({ block, loading, error, ticker }) {
  const hash = block?.hash || null;
  const head = hash ? hash.slice(0, -1) : null;
  const digit = hash ? hash.slice(-1) : null;
  const y = hash ? mineYield(hash) : null;

  return (
    <section className="panel" aria-labelledby="block-strip-label">
      <div className="panel-head">
        <span className="label" id="block-strip-label">
          Latest block
        </span>
        <span className="label">{block?.time ? fmtAgo(block.time) : ""}</span>
      </div>
      {error && !block ? (
        <div className="err">Could not load the tip block: {String(error.message)}</div>
      ) : !block ? (
        <div className="muted">{loading ? "Loading tip block…" : "No block data."}</div>
      ) : (
        <div className="block-strip">
          <a className="height mono" href={blockUrl(block.height)} target="_blank" rel="noopener noreferrer" title="Open block on mempool.space">
            #{fmtInt(block.height)}
          </a>
          <div className="hash" aria-label={`block hash ${hash}, last digit ${digit}`}>
            {head}
            <span className="digit">{digit}</span>
          </div>
          <div className="caption">
            ← yield digit{" "}
            {y !== null && (
              <span className="y">
                → {y} {ticker}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
