import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { fmtInt, shortAddr } from "../lib/format.js";
import { yieldDigit } from "../lib/yield.js";
import DigitChip from "./DigitChip.jsx";

const POLL_MS = 15_000;

/**
 * Newest mines as one slow, horizontally scrolling feed. Deliberately calm:
 * constant-speed marquee, pauses on hover, and becomes a plain scrollable
 * row under prefers-reduced-motion.
 */
export default function MineTicker() {
  const mines = usePoll((s) => indexer.minesFeed({ limit: 20 }, s), POLL_MS, []);
  const items = mines.data?.items || [];

  if (items.length === 0) {
    return (
      <div className="live" aria-label="Recent mines">
        <div className="live-empty muted">{mines.loading ? "Loading mines…" : "No mines indexed yet."}</div>
      </div>
    );
  }

  // Duplicate the run so the marquee loops seamlessly (second copy is aria-hidden).
  return (
    <div className="live" aria-label="Recent mines">
      <div className="live-track">
        <ul className="live-run">
          {items.map((r) => (
            <Item key={`m:${r.txid}`} r={r} />
          ))}
        </ul>
        <ul className="live-run" aria-hidden="true">
          {items.map((r) => (
            <Item key={`m:${r.txid}:dup`} r={r} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function Item({ r }) {
  const invalid = r.status === "invalid";
  return (
    <li className="live-item">
      <a href={tokenHref(r.ticker)}>
        <DigitChip digit={yieldDigit(r.block_hash)} size="sm" invalid={invalid} ticker={r.ticker} />
        <span>
          <span className="mono who">{shortAddr(r.sender, 4, 4)}</span> {invalid ? "sent an invalid mine for" : "mined"}{" "}
          <strong>
            {invalid ? "" : `${fmtInt(r.cap_exhausted ? 0 : r.yield_smallest)} `}
            {r.ticker}
          </strong>{" "}
          <span className="muted mono">#{fmtInt(r.block_height)}</span>
        </span>
      </a>
    </li>
  );
}
