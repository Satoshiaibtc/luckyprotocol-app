import { useMemo, useState } from "react";
import { useApp } from "../context.js";
import TokenCard from "../components/TokenCard.jsx";
import BlockTape from "../components/BlockTape.jsx";
import Panel from "../components/hud/Panel.jsx";
import { ledFromPoll } from "../components/hud/Led.jsx";
import { fmtInt, fmtMintedPct } from "../lib/format.js";
import { ACTIVATION_HEIGHT, DEPLOY_PROTOCOL_FEE_SATS, REQUIRED_TOKEN_SUPPLY, TICKER_RE } from "../lib/payloads.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import { emptyBoardState, isMintedOut, mintedOutFirst } from "../lib/marketBoard.js";
import { BUCKETS } from "../lib/yield.js";
import { UNLOCK_HEIGHT, activationState, countdownText } from "../lib/activation.js";
import { indexerErrorText, indexerErrorTitle } from "../lib/errors.js";

// Board views: Active (most mined first), Minted out (only
// fully minted tokens — the ones whose market is open) and Top volume.
const SORTS = [
  { id: "active", label: "Active" },
  { id: "mintedout", label: "Minted out" },
  { id: "volume", label: "Top volume" },
];

export function sortTokens(items, sort) {
  const rows = [...items];
  switch (sort) {
    case "mintedout":
      // Only tokens whose cumulative mined yield reached the supply; most recently
      // minted out first, then by 24 h volume.
      return rows
        .filter(isMintedOut)
        .sort((a, b) => (b.minted_out_height ?? -1) - (a.minted_out_height ?? -1) || (b.market_24h?.volume_sats ?? -1) - (a.market_24h?.volume_sats ?? -1) || a.ticker.localeCompare(b.ticker));
    case "volume":
      // 24 h fill volume (self-trades excluded by the indexer); tokens without a market row sink.
      // Only minted-out tokens have a market: they come first, the rest keep this order after them.
      return mintedOutFirst(rows.sort((a, b) => (b.market_24h?.volume_sats ?? -1) - (a.market_24h?.volume_sats ?? -1) || (b.market_24h?.trades ?? 0) - (a.market_24h?.trades ?? 0) || a.ticker.localeCompare(b.ticker)));
    default:
      return rows.sort((a, b) => (b.mine_count || 0) - (a.mine_count || 0) || b.deploy_block - a.deploy_block);
  }
}

export default function Board({ notice }) {
  const { tokens, health, navigate, chainTip } = useApp();
  const mobile = useIsMobile();
  const [sort, setSort] = useState("active");
  const [q, setQ] = useState("");

  const items = useMemo(() => tokens.data?.items || [], [tokens.data]);
  const needle = q.trim().toUpperCase();
  const matches = useMemo(() => (needle ? items.filter((t) => t.ticker.includes(needle)) : items), [items, needle]);
  const shown = useMemo(() => sortTokens(matches, sort), [matches, sort]);
  const empty = emptyBoardState({ items, shown, sort, q });
  const act = activationState(chainTip);
  // Some registry pages could not be read: a ticker missing from `items` may exist.
  const partial = tokens.data?.complete === false;
  // Before activation (tip known and below it) no ticker can be created yet.
  const preActivation = !act.unknown && act.locked;

  // Enter on a valid ticker opens its page (the phone header has no search box).
  const submitFilter = (e) => {
    e.preventDefault();
    const t = q.trim().toUpperCase();
    if (TICKER_RE.test(t)) navigate(tokenHref(t));
  };

  const led = ledFromPoll(health);

  return (
    <main className="page board">
      {notice && <div className="notice">{notice}</div>}

      <section className="hero">
        {/* What makes LUCKY-20 different: the name,
            what it is and its one rule as the title; the copy (one plain
            paragraph, no emphasis) with the fair-launch facts; then the four
            tiers. */}
        <div className="hero-copy">
          <h1>LUCKY-20 · open-mint Bitcoin L1 tokens, determined by the block hash</h1>
          <p>
            The block hash sets the yield. No premine, no allocation, no per-address cap: every LUCKY-20 ticker has {fmtInt(REQUIRED_TOKEN_SUPPLY)} supply and anyone can mine it. The last hex digit of the block that confirms your MINE decides how many tokens it credits — public, deterministic and checkable by anyone.
          </p>
          <a className="hero-tiers" href="#/probability" aria-label="Tokens per MINE by the confirming block's last hex digit — open the Probability page">
            {BUCKETS.map((b) => (
              <span key={b.id} className={`hero-tier tier-${b.id}`}>
                <i aria-hidden="true" />
                <span className="mono d">{b.label}</span>
                <span className="mono y">{fmtInt(b.yield)}</span>
              </span>
            ))}
            <span className="hero-tiers-more">per MINE · record →</span>
          </a>
        </div>
        <div className="telemetry">
          <Panel as="div" title="Tokens" led={led}>
            {/* Only the indexer's count: "0" from an empty, failed read would state a fact nobody knows. */}
            <div className="hero-num">{fmtInt(health.data?.token_count)}</div>
          </Panel>
          <Panel as="div" title={mobile ? "Mines" : "Mines settled"} led={led}>
            <div className="hero-num">{fmtInt(health.data?.mine_count)}</div>
          </Panel>
          <Panel as="div" title="Tip block" led={led}>
            {/* Phones drop the '#': "#970,100" ellipsizes in a 360px-wide three-up. */}
            <div className="hero-num hero-num-tip">{chainTip ? `${mobile ? "" : "#"}${fmtInt(chainTip)}` : "—"}</div>
          </Panel>
        </div>
      </section>

      <BlockTape />

      <div className="board-controls">
        <div className="chips" role="tablist" aria-label="Show">
          {SORTS.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={sort === s.id} className={`chip${sort === s.id ? " active" : ""}`} onClick={() => setSort(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <form className="board-search" role="search" onSubmit={submitFilter}>
          <input
            className="input mono"
            type="search"
            list="board-ticker-list"
            placeholder="Filter tickers"
            aria-label="Filter tickers — Enter opens a ticker"
            enterKeyHint="go"
            value={q}
            onChange={(e) => setQ(e.target.value.toUpperCase())}
            maxLength={8}
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id="board-ticker-list">
            {items.map((t) => (
              <option value={t.ticker} key={t.ticker} />
            ))}
          </datalist>
        </form>
      </div>

      {tokens.error && items.length === 0 ? (
        <div className="empty-state">
          <h2>Tokens unavailable</h2>
          <p className="err" title={indexerErrorTitle(tokens.error)}>
            {indexerErrorText(tokens.error, { retrySec: 30 })}
          </p>
        </div>
      ) : empty === "none" ? (
        <div className="empty-state">
          {tokens.loading ? (
            <p className="muted">Loading tokens…</p>
          ) : preActivation ? (
            <>
              <h2>No tokens yet</h2>
              <p className="muted">
                LUCKY-20 starts at block #{fmtInt(ACTIVATION_HEIGHT)}. Reserving a ticker opens one block earlier, at #{fmtInt(UNLOCK_HEIGHT)} — {countdownText(act.blocksLeft)}. Creating a ticker takes two steps (reserve, then publish) and costs {fmtInt(DEPLOY_PROTOCOL_FEE_SATS)} sats plus two network fees.
              </p>
              <a className="btn" href="#/create">
                See the Create page
              </a>
            </>
          ) : (
            <>
              <h2>No tokens yet</h2>
              <p className="muted">Be the first: creating a ticker takes two steps (reserve, then publish) and costs {fmtInt(DEPLOY_PROTOCOL_FEE_SATS)} sats plus two network fees.</p>
              <a className="btn btn-primary" href="#/create">
                Create the first one
              </a>
            </>
          )}
        </div>
      ) : empty === "no-mintedout" ? (
        <div className="empty-state">
          <h2>No token is minted out yet</h2>
          <p className="muted">A token&apos;s market opens once its mined yield reaches the full supply.</p>
        </div>
      ) : empty === "not-minted" ? (
        <div className="empty-state">
          <h2>{matches.length === 1 ? `${matches[0].ticker} is not minted out yet` : `No ticker matching “${needle}” is minted out yet`}</h2>
          <p className="muted">A token&apos;s market opens when it reaches 100%.</p>
          <div className="empty-actions">
            {matches.slice(0, 6).map((t) => (
              <a key={t.ticker} className="btn" href={tokenHref(t.ticker)}>
                {t.ticker} · {fmtMintedPct(t.minted, t.supply, 2)} minted
              </a>
            ))}
          </div>
        </div>
      ) : empty === "no-match" ? (
        <div className="empty-state">
          <h2>No ticker matches “{needle}”</h2>
          {TICKER_RE.test(needle) && partial ? (
            <>
              <p className="muted">
                Only {fmtInt(items.length)} of {fmtInt(tokens.data.total)} tokens could be loaded, so {needle} may exist. Its page says for sure.
              </p>
              <a className="btn" href={tokenHref(needle)}>
                Open {needle}
              </a>
            </>
          ) : TICKER_RE.test(needle) ? (
            preActivation ? (
              <p className="muted">{needle} is not deployed. Reserving a ticker opens at block #{fmtInt(UNLOCK_HEIGHT)}, {countdownText(act.blocksLeft)}.</p>
            ) : (
              <>
                <p className="muted">{needle} is not deployed yet — the first valid publish of a reserved name claims it.</p>
                <a className="btn btn-primary" href={`#/create?ticker=${encodeURIComponent(needle)}`}>
                  Create {needle}
                </a>
              </>
            )
          ) : (
            <p className="muted">Tickers are 1–8 characters, A–Z and 0–9.</p>
          )}
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
