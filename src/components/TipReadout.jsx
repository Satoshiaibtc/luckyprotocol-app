import { DIGIT_SPACE, bucketOfHash, yieldDigit } from "../lib/yield.js";
import { blockUrl, fmtAgo, fmtInt } from "../lib/format.js";
import DigitChip from "./DigitChip.jsx";

/**
 * `LATEST BLOCK  #970,100  …a91[c]  → 500 LUCKY · tier a–e · 5 of 16  12 min ago`
 * `remaining` (tokens left, or null): a minted-out ticker drops the arrow —
 * no MINE is credited anything — and near the cap the arrow reads
 * "at most N".
 */
export default function TipReadout({ tipBlock, ticker = "", remaining = null }) {
  const hash = tipBlock?.data?.hash;
  if (!hash) return null;
  const { height, time } = tipBlock.data;
  const d = yieldDigit(hash);
  const b = bucketOfHash(hash);
  if (!b) return null;
  const known = remaining !== null && remaining !== undefined;
  const unit = ticker ? ` ${ticker}` : "";
  let arrow;
  if (known && remaining <= 0) arrow = <>minted out · tier {b.label} · {b.count} of {DIGIT_SPACE}</>;
  else if (known && remaining < b.yield) arrow = <>→ <b>at most {fmtInt(remaining)}{unit}</b> · tier {b.label} ({fmtInt(b.yield)}) · {b.count} of {DIGIT_SPACE}</>;
  else arrow = <>→ <b>{fmtInt(b.yield)}{unit}</b> · tier {b.label} · {b.count} of {DIGIT_SPACE}</>;
  return (
    <div className={`tip-readout tier-${b.id}`}>
      <span className="label">Latest block</span>
      <div className="tip-row">
        <a className="num" href={blockUrl(height)} target="_blank" rel="noopener noreferrer">
          #{fmtInt(height)}
        </a>
        <span className="hash-tail">
          …{hash.slice(-4, -1)}
          <DigitChip digit={d} size="sm" ticker={ticker} />
        </span>
        <span className="rd">{arrow}</span>
        {time ? <span className="ago">{fmtAgo(time)}</span> : null}
      </div>
    </div>
  );
}
