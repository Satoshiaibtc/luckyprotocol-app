import { fmtInt, fmtPct } from "../lib/format.js";
import { REQUIRED_TOKEN_SUPPLY } from "../lib/payloads.js";

/** "12.3% minted · 2,594,000 / 21,000,000" + bar. Our analogue of a launch curve. */
export default function MintProgress({ ticker, minted = 0, supply = REQUIRED_TOKEN_SUPPLY, compact = false }) {
  const pct = supply ? Math.min(100, (100 * minted) / supply) : 0;
  return (
    <div className={`mint${compact ? " compact" : ""}`}>
      <div className="mint-nums">
        <span className="mint-pct">{fmtPct(minted, supply, minted && pct < 1 ? 3 : 1)} minted</span>
        <span className="mint-of">
          {fmtInt(minted)} / {fmtInt(supply)}
        </span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={supply}
        aria-valuenow={minted}
        aria-label={`${ticker} supply minted`}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
