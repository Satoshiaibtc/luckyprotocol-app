import { useMemo, useState } from "react";
import { useApp } from "../context.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import Identicon from "../components/Identicon.jsx";
import Panel from "../components/hud/Panel.jsx";
import { ledFromPoll } from "../components/hud/Led.jsx";
import { MARKET_SORTS, isMarketPending, mintedPct, partitionMarkets } from "../lib/marketBoard.js";
import { mintedProgressNote } from "../lib/tokenTabs.js";
import { FINAL_DEPTH } from "../lib/finality.js";
import { changeSign, fmtChangePct } from "../lib/market.js";
import { fmtAgo, fmtCompact, fmtInt, fmtMintedPct, fmtUnit, fmtUsd } from "../lib/format.js";
import { REQUIRED_TOKEN_SUPPLY } from "../lib/payloads.js";
import { indexerErrorText, indexerErrorTitle } from "../lib/errors.js";

/**
 * #/market — every OPEN market (a token whose cumulative credited yield
 * reached its supply — minted out, for good) as a sortable table, then the
 * tokens closest to 100 % ("Next to open"). Reads the same /tokens poll as
 * the board (App.jsx, limit 200, every 30 s); sats-first, USD sub-labels
 * only while /price answers.
 */
export default function MarketPage() {
  const { tokens, health, price } = useApp();
  const mobile = useIsMobile();
  const usd = price.data?.usd_per_btc ?? null;
  const [sort, setSort] = useState("volume");

  const items = useMemo(() => tokens.data?.items || [], [tokens.data]);
  const { open, next } = useMemo(() => partitionMarkets(items, { sort }), [items, sort]);
  const tip = health.data?.tip_height ?? null;
  const led = ledFromPoll(tokens);
  // No answer yet (or only a failed one): the counts are unknown, not 0 (audit visit-7).
  const unknown = !tokens.data;

  return (
    <main className="page market-page">
      <header className="token-head">
        <div className="token-head-main">
          <h1 className="ticker">Market</h1>
          <div className="meta">
            <span>
              {tip ? (
                <>
                  as of block <span className="mono">#{fmtInt(tip)}</span>
                  {health.data?.last_progress_at ? <span className="muted"> · indexed {fmtAgo(health.data.last_progress_at)}</span> : null}
                </>
              ) : health.error ? (
                <span className="err">indexer offline</span>
              ) : (
                "connecting…"
              )}
            </span>
            <span className="muted">Markets open when a token is fully minted (100% of {fmtInt(REQUIRED_TOKEN_SUPPLY)} credited to miners) and that block has {FINAL_DEPTH} confirmations</span>
          </div>
        </div>
      </header>

      <Panel title="Open markets" led={led} right={<span className="label">{unknown ? "—" : fmtInt(open.length)} open</span>} aria-label="Open markets">
        <div className="board-controls">
          <div className="chips" role="tablist" aria-label="Sort">
            {MARKET_SORTS.map((s) => (
              <button key={s.id} type="button" role="tab" aria-selected={sort === s.id} className={`chip${sort === s.id ? " active" : ""}`} onClick={() => setSort(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {tokens.error && items.length === 0 ? (
          <div className="err" title={indexerErrorTitle(tokens.error)}>
            {indexerErrorText(tokens.error, { retrySec: 30 })}
          </div>
        ) : items.length === 0 && tokens.loading ? (
          <div className="empty">Loading tokens…</div>
        ) : open.length === 0 ? (
          <div className="empty-state market-empty">
            <h2>No market is open yet</h2>
            <p className="muted">The first one opens when a token reaches 100%.</p>
          </div>
        ) : (
          <div className="table cols-markets" role="table" aria-label="Open markets">
            <div className="tr th" role="row">
              <span>Token</span>
              <span>Opened</span>
              <span className="right">Floor</span>
              <span className="right">Last</span>
              <span className="right">Vol 24h</span>
              <span className="right">24h</span>
              <span className="right">Listings</span>
              <span className="right">Holders</span>
              <span className="right">Trades 24h</span>
            </div>
            {open.map((t) => (
              <MarketRow key={t.ticker} t={t} usd={usd} />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Next to open" led={led} right={<span className="label">closest to 100%</span>} aria-label="Next to open">
        {next.length === 0 ? (
          <div className="empty">
            {tokens.error && items.length === 0 ? indexerErrorText(tokens.error) : items.length === 0 ? (tokens.loading ? "Loading tokens…" : "No tokens yet.") : "Every token is minted out."}
          </div>
        ) : (
          <ul className="next-open">
            {next.map((t) => (
              <NextRow key={t.ticker} t={t} mobile={mobile} />
            ))}
          </ul>
        )}
      </Panel>
    </main>
  );
}

/** One open market: the whole row opens the token's Market tab. */
function MarketRow({ t, usd }) {
  const m = t.market_24h || null;
  const floor = t.floor_unit_price ?? null;
  const sign = changeSign(m?.change_pct);
  return (
    <a className="tr" role="row" href={tokenHref(t.ticker, "market")} aria-label={`${t.ticker} market`}>
      <span className="cell-token">
        <Identicon ticker={t.ticker} size={28} />
        <span className="ticker">{t.ticker}</span>
      </span>
      <span className="num" data-l="Opened" title="block of the mine that completed the supply">
        {t.minted_out_height !== null && t.minted_out_height !== undefined ? `#${fmtInt(t.minted_out_height)}` : "—"}
      </span>
      <span className="num right" data-l="Floor" title="lowest open ask, sats per token">
        {floor !== null ? fmtUnit(floor) : "—"}
        {usd && floor !== null ? <small className="usd">{fmtUsd(floor, usd)}</small> : null}
      </span>
      <span className="num right" data-l="Last" title="last fill, sats per token">
        {t.last_trade ? fmtUnit(t.last_trade.unit_price) : "—"}
      </span>
      <span className="num right" data-l="Vol 24h" title="sats filled in the last 24 h (self-trades excluded)">
        {m && m.volume_sats !== null ? fmtCompact(m.volume_sats) : "—"}
        {usd && m && m.volume_sats ? <small className="usd">{fmtUsd(m.volume_sats, usd)}</small> : null}
      </span>
      <span className={`num right${sign ? ` delta-${sign}` : ""}`} data-l="24h" title="change of the unit price over the last 24 h">
        {fmtChangePct(m?.change_pct)}
      </span>
      <span className="num right" data-l="Listings">
        {fmtInt(t.open_orders ?? 0)}
      </span>
      <span className="num right" data-l="Holders">
        {fmtCompact(t.holders ?? 0)}
      </span>
      <span className="num right" data-l="Trades 24h">
        {m && m.trades !== null ? fmtInt(m.trades) : "—"}
      </span>
    </a>
  );
}

/** A token on its way to 100%: progress bar, minted / supply, mines, and the way to mine it. */
function NextRow({ t, mobile }) {
  const pct = mintedPct(t);
  // Minted out, its market opening once the completing block is deep enough.
  const pending = isMarketPending(t);
  return (
    <li className="next-row">
      <a className="next-avatar" href={tokenHref(t.ticker)} aria-label={`${t.ticker} token page`}>
        <Identicon ticker={t.ticker} size={36} />
      </a>
      <div className="next-main">
        <div className="next-head">
          <a className="ticker" href={tokenHref(t.ticker)}>
            {t.ticker}
          </a>
          <span className="num next-pct">{fmtMintedPct(t.minted, t.supply, 2)}</span>
        </div>
        <div className="next-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${t.ticker} minted`}>
          <span className="next-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="next-sub">
          {pending ? mintedProgressNote(t) : `${mobile ? `${fmtCompact(t.minted)} / ${fmtCompact(t.supply)}` : `minted ${fmtInt(t.minted)} / ${fmtInt(t.supply)}`} · ${fmtCompact(t.mine_count)} mines`}
        </div>
      </div>
      <a className="btn btn-sm" href={tokenHref(t.ticker, pending ? undefined : "mine")}>
        {pending ? "Open" : "Mine"}
      </a>
    </li>
  );
}
