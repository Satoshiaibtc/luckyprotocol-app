import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { usePaged } from "../hooks/usePaged.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import Identicon from "../components/Identicon.jsx";
import TokenAvatar from "../components/TokenAvatar.jsx";
import SupplyRing from "../components/SupplyRing.jsx";
import MinePanel from "../components/MinePanel.jsx";
import MarketPanel from "../components/MarketPanel.jsx";
import YieldSpectrum from "../components/YieldSpectrum.jsx";
import TierTable from "../components/TierTable.jsx";
import Panel from "../components/hud/Panel.jsx";
import Fold from "../components/hud/Fold.jsx";
import { ledFromPoll } from "../components/hud/Led.jsx";
import { MinesTable, HoldersTable, AddrLink, TxLink } from "../components/Tables.jsx";
import { summarizeMix } from "../lib/mix.js";
import { BUCKETS, probabilityPct, yieldDigit } from "../lib/yield.js";
import { fmtAgo, fmtCompact, fmtDec, fmtInt, fmtPct, blockUrl } from "../lib/format.js";

const POLL_MS = 15_000;
const TABS = ["mine", "market"];
const TAB_LABEL = { mine: "Mine", market: "Market" };
const MIX_LIMIT = 200;
const DATA_TABS = [
  { id: "mines", label: "Mines" },
  { id: "holders", label: "Holders" },
];

/** "f 6.25% → 1000 · a–e 31.25% → 500 · 5–9 31.25% → 200 · 0–4 31.25% → 100" — from BUCKETS only. */
const TIER_SUMMARY = BUCKETS.map((b) => `${b.label} ${probabilityPct(b)}% → ${b.yield}`).join(" · ");

export default function TokenPage({ ticker, params, navigate }) {
  const { address, health, tipBlock } = useApp();
  const mobile = useIsMobile();
  const tokenQ = usePoll((s) => indexer.token(ticker, s), POLL_MS, [ticker]);
  const token = tokenQ.data;
  // A 404 resolves to `null` data with an updatedAt stamp; a still-loading
  // first fetch has no stamp yet (usePoll re-flags `loading` on every tick
  // while data is null, so `loading` alone would flicker every 15 s).
  const notFound = !tokenQ.error && token === null && tokenQ.updatedAt !== null;

  const deployBlock = usePoll(token?.deploy_block ? (s) => indexer.blockInfo(token.deploy_block, s) : null, 0, [token?.deploy_block]);

  // The observed-mix stats are desktop-only; a phone never polls the 200-row feed.
  const mixQ = usePoll(mobile ? null : (s) => indexer.minesFeed({ ticker, limit: MIX_LIMIT }, s), POLL_MS, [ticker, mobile]);

  // Two action tabs: the mine console (default) and the market. Stale
  // `?tab=…` links (buy / sell from the old layout) resolve to the console.
  useEffect(() => {
    if (params.tab && !TABS.includes(params.tab)) navigate(tokenHref(ticker), { replace: true });
  }, [params.tab, ticker, navigate]);
  const tab = TABS.includes(params.tab) ? params.tab : "mine";
  const setTab = (id) => navigate(tokenHref(ticker, id === "mine" ? undefined : id));

  const [dataTab, setDataTab] = useState("mines");
  const [refreshKey, setRefreshKey] = useState(0);
  const minesPaged = usePaged((offset, limit, s) => indexer.minesFeed({ ticker, offset, limit }, s), { limit: 25, deps: [ticker, refreshKey], refreshMs: 30_000 });
  const holdersPaged = usePaged(
    async (offset, limit, s) => {
      const r = await indexer.tokenHolders(ticker, { offset, limit }, s);
      return { items: r.holders, total: r.total };
    },
    { limit: 25, deps: [ticker, refreshKey], refreshMs: 60_000 },
  );

  const onSettled = useCallback(() => {
    tokenQ.refresh();
    if (!mobile) mixQ.refresh();
    setRefreshKey((k) => k + 1);
  }, [tokenQ, mixQ, mobile]);

  const mix = useMemo(() => summarizeMix(mixQ.data?.items || []), [mixQ.data]);
  const tip = health.data?.tip_height ?? null;

  if (notFound) {
    return (
      <main className="page">
        <div className="empty-state">
          <Identicon ticker={ticker} size={64} />
          <h2>{ticker} is not deployed</h2>
          <p className="muted">
            No DEPLOY for this ticker has been indexed. If you just created it, the indexer will list it once the transaction confirms —
            this page re-checks every 15 s.
          </p>
          <a className="btn btn-primary" href={`#/create?ticker=${encodeURIComponent(ticker)}`}>
            Create {ticker}
          </a>
        </div>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="page">
        <div className="empty-state">
          {tokenQ.error ? <p className="err">Could not load {ticker}: {String(tokenQ.error.message)}</p> : <p className="muted">Loading {ticker}…</p>}
        </div>
      </main>
    );
  }

  const activeQ = dataTab === "mines" ? minesPaged : holdersPaged;
  const activeLed = activeQ.error ? "err" : activeQ.loading && activeQ.rows.length === 0 ? "busy" : "ok";
  const age = deployBlock.data?.time ? fmtAgo(deployBlock.data.time) : tip ? `${fmtInt(Math.max(0, tip - token.deploy_block))} blocks ago` : null;

  const yieldModel = (
    <>
      <YieldSpectrum tipDigit={yieldDigit(tipBlock.data?.hash)} />
      <TierTable ticker={token.ticker} />
    </>
  );
  const mineConsole = (
    <Panel title="Mine // console" led={ledFromPoll(tokenQ)} aria-label="Mine console">
      <MinePanel ticker={token.ticker} tokenInfo={token} onSettled={onSettled} />
    </Panel>
  );
  const market = <MarketPanel ticker={token.ticker} token={token} onSettled={onSettled} />;
  const actionTabs = (kind) => (
    <div className={kind === "seg" ? "seg" : "tabs token-tabs"} role="tablist" aria-label="Token actions">
      {TABS.map((id) => (
        <button key={id} className={kind === "seg" ? "seg-btn" : "tab"} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} type="button">
          {TAB_LABEL[id]}
        </button>
      ))}
    </div>
  );

  if (mobile) {
    // Phone order: compact header → 2×2 stats → Mine | Market segmented control →
    // the chosen console (within the first 1.5 screens) → folded yield model →
    // segmented activity.
    return (
      <main className="page token-page token-page-m">
        <header className="token-head token-head-m">
          <span className="ch chamfer identicon-wrap">
            <span className="ch-in chamfer">
              <TokenAvatar ticker={token.ticker} avatarTxid={token.avatar_txid} size={56} />
            </span>
          </span>
          <div className="token-head-main">
            <h1 className="ticker">{token.ticker}</h1>
            <div className="meta">
              {/* No "tx …" segment on phones — the age must fit on the one line. */}
              by <AddrLink address={token.deployer} self={address} head={4} tail={4} /> ·{" "}
              <a className="mono" href={blockUrl(token.deploy_block)} target="_blank" rel="noopener noreferrer">
                #{fmtInt(token.deploy_block)}
              </a>
              {age ? ` · ${age}` : ""}
            </div>
          </div>
          <SupplyRing ticker={token.ticker} minted={token.minted} supply={token.supply} size={64} />
        </header>

        <dl className="stats stats-4">
          <div>
            <dt>Minted</dt>
            <dd>{fmtPct(token.minted, token.supply, 2)}</dd>
          </div>
          <div>
            <dt>Remaining</dt>
            <dd>{fmtCompact(Math.max(0, token.supply - token.minted))}</dd>
          </div>
          <div>
            <dt>Holders</dt>
            <dd>{fmtCompact(token.holders ?? 0)}</dd>
          </div>
          <div>
            <dt>Mines</dt>
            <dd>{fmtCompact(token.mine_count)}</dd>
          </div>
        </dl>

        {actionTabs("seg")}
        {tab === "market" ? market : mineConsole}

        <Fold title="Yield model" summary={TIER_SUMMARY} led="ok" aria-label="Yield model">
          {yieldModel}
        </Fold>

        <Panel led={activeLed} title="Activity" right={<span className="label">{fmtInt(activeQ.total)} total</span>} aria-label="Token activity">
          <div className="seg" role="tablist" aria-label="Token activity">
            {DATA_TABS.map((t) => (
              <button key={t.id} className="seg-btn" role="tab" aria-selected={dataTab === t.id} onClick={() => setDataTab(t.id)} type="button">
                {t.label}
              </button>
            ))}
          </div>
          {dataTab === "mines" && <MinesTable q={minesPaged} self={address} compact empty={`No ${token.ticker} mines yet.`} />}
          {dataTab === "holders" && <HoldersTable q={holdersPaged} minted={token.minted} self={address} compact />}
        </Panel>
      </main>
    );
  }

  return (
    <main className="page token-page">
      <header className="token-head">
        <span className="ch chamfer identicon-wrap">
          <span className="ch-in chamfer">
            <TokenAvatar ticker={token.ticker} avatarTxid={token.avatar_txid} size={72} />
          </span>
        </span>
        <div className="token-head-main">
          <h1 className="ticker">{token.ticker}</h1>
          <div className="meta">
            <span>
              deployed by <AddrLink address={token.deployer} self={address} head={6} tail={5} />
            </span>
            <span>
              tx <TxLink txid={token.deploy_txid} head={6} tail={5} />
            </span>
            <span>
              block{" "}
              <a className="mono" href={blockUrl(token.deploy_block)} target="_blank" rel="noopener noreferrer">
                #{fmtInt(token.deploy_block)}
              </a>
              {age ? <span className="muted"> · {age}</span> : null}
            </span>
          </div>
        </div>
        <div className="token-head-supply">
          <SupplyRing ticker={token.ticker} minted={token.minted} supply={token.supply} size={96} showText />
        </div>
      </header>

      <dl className="stats">
        <div>
          <dt>Minted</dt>
          <dd>{fmtPct(token.minted, token.supply, 2)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{fmtCompact(Math.max(0, token.supply - token.minted))}</dd>
        </div>
        <div>
          <dt>Holders</dt>
          <dd>{fmtCompact(token.holders ?? 0)}</dd>
        </div>
        <div>
          <dt>Mines</dt>
          <dd>{fmtCompact(token.mine_count)}</dd>
        </div>
        <div>
          <dt>Observed mean</dt>
          <dd>{mix.n >= 1 ? fmtDec(mix.mean, 1) : "—"}</dd>
        </div>
      </dl>

      {actionTabs("tabs")}

      {tab === "market" ? (
        market
      ) : (
        <div className="token-layout">
          <div className="col">
            <Panel title="Yield model" led="ok" aria-label="Yield model">
              {yieldModel}
            </Panel>

            <Panel
              led={activeLed}
              title={
                <div className="tabs" role="tablist" aria-label="Token activity">
                  {DATA_TABS.map((t) => (
                    <button key={t.id} className="tab" role="tab" aria-selected={dataTab === t.id} onClick={() => setDataTab(t.id)} type="button">
                      {t.label}
                    </button>
                  ))}
                </div>
              }
              right={<span className="label">{fmtInt(activeQ.total)} total</span>}
            >
              {dataTab === "mines" && <MinesTable q={minesPaged} self={address} empty={`No ${token.ticker} mines yet.`} />}
              {dataTab === "holders" && <HoldersTable q={holdersPaged} minted={token.minted} self={address} />}
            </Panel>
          </div>

          <div className="col">
            {mineConsole}
          </div>
        </div>
      )}
    </main>
  );
}
