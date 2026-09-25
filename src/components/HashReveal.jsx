import { DIGIT_SPACE, bucketOfHash, probabilityPct, yieldDigit } from "../lib/yield.js";
import { blockUrl, fmtInt } from "../lib/format.js";

/**
 * The block-confirmation reveal: the confirming block's hash appears
 * character by character (CSS stagger), the last digit scales up in its
 * tier color, then the yield rises in. Rendered with `key={mine.txid}` by
 * the parent so re-renders never restart the stagger. The yield text is in
 * the DOM immediately — only opacity animates (no count-up).
 */
export default function HashReveal({ mine, ticker, reconcileLine, onReset }) {
  // (`txLink` is also passed by MinePanel; the reconcile line already carries it.)
  const hash = mine.blockHash || "";
  const d = yieldDigit(hash);
  const b = bucketOfHash(hash);
  const chars = hash.split("");
  const last = chars.length - 1;
  const tier = b ? `tier-${b.id}` : "tier-none";

  return (
    <div className={`reveal ${tier}`}>
      <span className="label ok">Block confirmed</span>
      <a className="hero-num reveal-height" href={blockUrl(mine.blockHeight)} target="_blank" rel="noopener noreferrer">
        #{fmtInt(mine.blockHeight)}
      </a>
      <div className="reveal-hash" title={hash}>
        {chars.map((ch, i) => (
          <span key={i} style={{ "--i": i }} className={i === last ? "lit" : undefined}>
            {ch}
          </span>
        ))}
      </div>
      {b && (
        <>
          <div className="reveal-sentence">{`last digit ${d} · a ${b.count}-in-${DIGIT_SPACE} outcome (${probabilityPct(b)}%)`}</div>
          <div className="reveal-yield">
            {fmtInt(mine.yieldLocal)}
            <span className="unit">{ticker}</span>
          </div>
        </>
      )}
      <div className="reveal-reconcile">{reconcileLine}</div>
      <div className="actions actions-flush">
        <button className="btn btn-sm" type="button" onClick={onReset}>
          Clear
        </button>
      </div>
    </div>
  );
}
