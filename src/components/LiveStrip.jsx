import { useMemo } from "react";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { fmtBtcShort, fmtInt, shortAddr } from "../lib/format.js";

const POLL_MS = 15_000;
const MAX_ITEMS = 40;

/**
 * Newest mines + trades merged into one slow, horizontally scrolling feed.
 * Deliberately calm: constant-speed marquee, pauses on hover, and becomes a
 * plain scrollable row under prefers-reduced-motion.
 */
export default function LiveStrip() {
  const mines = usePoll((s) => indexer.minesFeed({ limit: 20 }, s), POLL_MS, []);
  const trades = usePoll((s) => indexer.trades({ limit: 20 }, s), POLL_MS, []);

  const items = useMemo(() => {
    const m = (mines.data?.items || []).map((r) => ({ kind: "mine", key: `m:${r.txid}`, height: r.block_height, row: r }));
    const t = (trades.data?.items || []).map((r) => ({ kind: "trade", key: `t:${r.txid}`, height: r.block_height, row: r }));
    return [...m, ...t]
      .sort((a, b) => b.height - a.height || (a.kind === "trade" ? -1 : 1))
      .slice(0, MAX_ITEMS);
  }, [mines.data, trades.data]);

  if (items.length === 0) {
    return (
      <div className="live" aria-label="Live activity">
        <div className="live-empty muted">{mines.loading || trades.loading ? "Loading activity…" : "No activity indexed yet."}</div>
      </div>
    );
  }

  // Duplicate the run so the marquee loops seamlessly (second copy is aria-hidden).
  return (
    <div className="live" aria-label="Live activity">
      <div className="live-track">
        <ul className="live-run">
          {items.map((it) => (
            <Item key={it.key} it={it} />
          ))}
        </ul>
        <ul className="live-run" aria-hidden="true">
          {items.map((it) => (
            <Item key={`${it.key}:dup`} it={it} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function Item({ it }) {
  const r = it.row;
  if (it.kind === "mine") {
    const invalid = r.status === "invalid";
    return (
      <li className="live-item">
        <a href={tokenHref(r.ticker)}>
          <span className="mono who">{shortAddr(r.sender, 4, 4)}</span>{" "}
          {invalid ? "sent an invalid mine for" : "mined"}{" "}
          <strong>
            {invalid ? "" : `${fmtInt(r.cap_exhausted ? 0 : r.yield_smallest)} `}
            {r.ticker}
          </strong>{" "}
          <span className="muted mono">#{fmtInt(r.block_height)}</span>
        </a>
      </li>
    );
  }
  return (
    <li className="live-item trade">
      <a href={tokenHref(r.ticker, "buy")}>
        <span className="mono who">{shortAddr(r.buyer, 4, 4)}</span> bought{" "}
        <strong>
          {fmtInt(r.amount)} {r.ticker}
        </strong>{" "}
        for <strong>{fmtBtcShort(r.price_sats)}</strong>{" "}
        <span className="muted mono">#{fmtInt(r.block_height)}</span>
      </a>
    </li>
  );
}
