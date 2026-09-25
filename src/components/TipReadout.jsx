import { DIGIT_SPACE, bucketOfHash, yieldDigit } from "../lib/yield.js";
import { blockUrl, fmtAgo, fmtInt } from "../lib/format.js";
import DigitChip from "./DigitChip.jsx";

/** `LATEST BLOCK  #969,800  …a91[c]  → 500 LUCKY · tier a–e · 5 of 16  12 min ago` */
export default function TipReadout({ tipBlock, ticker = "" }) {
  const hash = tipBlock?.data?.hash;
  if (!hash) return null;
  const { height, time } = tipBlock.data;
  const d = yieldDigit(hash);
  const b = bucketOfHash(hash);
  if (!b) return null;
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
        <span className="rd">
          → <b>{fmtInt(b.yield)}{ticker ? ` ${ticker}` : ""}</b> · tier {b.label} · {b.count} of {DIGIT_SPACE}
        </span>
        {time ? <span className="ago">{fmtAgo(time)}</span> : null}
      </div>
    </div>
  );
}
