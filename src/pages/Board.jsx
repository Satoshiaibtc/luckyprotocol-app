import { useMemo, useState } from "react";
import { useApp } from "../context.js";
import TokenCard from "../components/TokenCard.jsx";
import BlockTape from "../components/BlockTape.jsx";
import YieldSpectrum from "../components/YieldSpectrum.jsx";
import TierTable from "../components/TierTable.jsx";
import EVReadout from "../components/EVReadout.jsx";
import Panel from "../components/hud/Panel.jsx";
import { ledFromPoll } from "../components/hud/Led.jsx";
import ObservedMix from "../components/ObservedMix.jsx";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { fmtInt } from "../lib/format.js";
import { yieldDigit } from "../lib/yield.js";
import { DEPLOY_PROTOCOL_FEE_SATS, REQUIRED_TOKEN_SUPPLY } from "../lib/payloads.js";

const MIX_LIMIT = 200;

const SORTS = [
  { id: "active", label: "Active" },
  { id: "new", label: "New" },
  { id: "minted", label: "Most minted" },
  { id: "open", label: "Open supply" },
];

export function sortTokens(items, sort) {
  const rows = [...items];
  switch (sort) {
    case "new":
      return rows.sort((a, b) => b.deploy_block - a.deploy_block || a.ticker.localeCompare(b.ticker));
    case "minted":
      return rows.sort((a, b) => b.minted - a.minted || a.ticker.localeCompare(b.ticker));
    case "open":
      return rows.sort((a, b) => b.supply - b.minted - (a.supply - a.minted) || a.ticker.localeCompare(b.ticker));
    default:
      return rows.sort((a, b) => (b.mine_count || 0) - (a.mine_count || 0) || b.deploy_block - a.deploy_block);
  }
}

export default function Board({ notice }) {
  const { tokens, health, tipBlock } = useApp();
  const [sort, setSort] = useState("active");
  const [q, setQ] = useState("");

  const mixQ = usePoll((s) => indexer.minesFeed({ limit: MIX_LIMIT }, s), 30_000, []);

  const items = useMemo(() => tokens.data?.items || [], [tokens.data]);
  const shown = useMemo(() => {
    const needle = q.trim().toUpperCase();
    const filtered = needle ? items.filter((t) => t.ticker.includes(needle)) : items;
    return sortTokens(filtered, sort);
  }, [items, q, sort]);

  const led = ledFromPoll(health);

  return (
    <main className="page board">
      {notice && <div className="notice">{notice}</div>}

      <section className="hero">
        <div>
          <h1>Mining telemetry on Bitcoin.</h1>
          <p>
            Fixed {fmtInt(REQUIRED_TOKEN_SUPPLY)} supply per token. Anyone can mine; the confirming block&apos;s last hex digit sets the yield.
          </p>
        </div>
        <div className="telemetry">
          <Panel as="div" title="Tokens" led={led}>
            <div className="hero-num">{fmtInt(health.data?.token_count ?? items.length)}</div>
          </Panel>
          <Panel as="div" title="Mines settled" led={led}>
            <div className="hero-num">{fmtInt(health.data?.mine_count)}</div>
          </Panel>
          <Panel as="div" title="Tip block" led={led}>
            <div className="hero-num">{health.data?.tip_height ? `#${fmtInt(health.data.tip_height)}` : "—"}</div>
          </Panel>
        </div>
      </section>

      <BlockTape />

      <Panel title="Yield model" led="ok" aria-label="Yield model">
        <YieldSpectrum compact tipDigit={yieldDigit(tipBlock.data?.hash)} />
        <TierTable compact />
        <EVReadout size="md" />
      </Panel>

      <Panel title={`Observed mix · network · last ${MIX_LIMIT} mines`} led={ledFromPoll(mixQ)} aria-label="Observed mix">
        <ObservedMix rows={mixQ.data?.items} loading={mixQ.loading} error={mixQ.error} meanLabel="Observed mean" />
      </Panel>

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
              <p className="muted">Be the first: deploying a ticker costs {fmtInt(DEPLOY_PROTOCOL_FEE_SATS)} sats plus the network fee.</p>
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
