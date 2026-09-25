import { useMemo, useState } from "react";
import { useApp } from "../context.js";
import TokenCard from "../components/TokenCard.jsx";
import { fmtInt } from "../lib/format.js";

const SORTS = [
  { id: "trending", label: "Trending" },
  { id: "new", label: "New" },
  { id: "minted", label: "Most minted" },
  { id: "price", label: "Top price" },
];

const trendScore = (t) => (t.mine_count || 0) + 3 * (t.trade_count || 0);
const lastPrice = (t) => (Number.isFinite(t.last_trade?.unit_price) ? t.last_trade.unit_price : null);

export function sortTokens(items, sort) {
  const rows = [...items];
  switch (sort) {
    case "new":
      return rows.sort((a, b) => b.deploy_block - a.deploy_block || a.ticker.localeCompare(b.ticker));
    case "minted":
      return rows.sort((a, b) => b.minted - a.minted || a.ticker.localeCompare(b.ticker));
    case "price":
      return rows.sort((a, b) => {
        const pa = lastPrice(a);
        const pb = lastPrice(b);
        if (pa === null && pb === null) return a.ticker.localeCompare(b.ticker);
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pb - pa;
      });
    default:
      return rows.sort((a, b) => trendScore(b) - trendScore(a) || b.deploy_block - a.deploy_block);
  }
}

export default function Board({ notice }) {
  const { tokens, health } = useApp();
  const [sort, setSort] = useState("trending");
  const [q, setQ] = useState("");

  const items = useMemo(() => tokens.data?.items || [], [tokens.data]);
  const shown = useMemo(() => {
    const needle = q.trim().toUpperCase();
    const filtered = needle ? items.filter((t) => t.ticker.includes(needle)) : items;
    return sortTokens(filtered, sort);
  }, [items, q, sort]);

  return (
    <main className="page board">
      {notice && <div className="notice">{notice}</div>}

      <section className="hero">
        <div>
          <h1>Mine, hold, trade — on Bitcoin.</h1>
          <p className="muted">
            Every token has a fixed 21,000,000 supply. Anyone can mine it; the yield is decided by the confirming block&apos;s hash.
            Holders trade peer-to-peer with signed listings that settle on-chain.
          </p>
        </div>
        <div className="hero-stats">
          <div>
            <dt>Tokens</dt>
            <dd>{fmtInt(health.data?.token_count ?? items.length)}</dd>
          </div>
          <div>
            <dt>Mines</dt>
            <dd>{fmtInt(health.data?.mine_count)}</dd>
          </div>
          <div>
            <dt>Block</dt>
            <dd>{health.data?.tip_height ? `#${fmtInt(health.data.tip_height)}` : "—"}</dd>
          </div>
        </div>
      </section>

      <div className="board-controls">
        <div className="chips" role="tablist" aria-label="Sort">
          {SORTS.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={sort === s.id} className={`chip${sort === s.id ? " active" : ""}`} onClick={() => setSort(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <input className="input mono board-search" type="search" placeholder="Filter tickers" aria-label="Filter tickers" value={q} onChange={(e) => setQ(e.target.value.toUpperCase())} maxLength={8} />
      </div>

      {tokens.error && items.length === 0 ? (
        <div className="empty-state">
          <h2>Indexer unreachable</h2>
          <p className="err">{String(tokens.error.message)}</p>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          {tokens.loading ? (
            <p className="muted">Loading tokens…</p>
          ) : (
            <>
              <h2>No tokens yet</h2>
              <p className="muted">Be the first: deploying a ticker costs 5,460 sats plus the network fee.</p>
              <a className="btn btn-primary" href="#/create">
                Create the first one
              </a>
            </>
          )}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-state">
          <h2>No ticker matches “{q}”</h2>
          <p className="muted">Tickers are 1–8 characters, A–Z and 0–9.</p>
          <a className="btn btn-primary" href="#/create">
            Create {q}
          </a>
        </div>
      ) : (
        <div className="grid-cards">
          {shown.map((t) => (
            <TokenCard token={t} key={t.ticker} />
          ))}
        </div>
      )}
    </main>
  );
}
