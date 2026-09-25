import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { usePaged } from "../hooks/usePaged.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import Identicon from "../components/Identicon.jsx";
import SupplyRing from "../components/SupplyRing.jsx";
import MinePanel from "../components/MinePanel.jsx";
import YieldSpectrum from "../components/YieldSpectrum.jsx";
import TierTable from "../components/TierTable.jsx";
import EVReadout from "../components/EVReadout.jsx";
import ObservedMix from "../components/ObservedMix.jsx";
import Panel from "../components/hud/Panel.jsx";
import { ledFromPoll } from "../components/hud/Led.jsx";
import { MinesTable, HoldersTable, AddrLink, TxLink } from "../components/Tables.jsx";
import { summarizeMix } from "../lib/mix.js";
import { yieldDigit } from "../lib/yield.js";
import { fmtAgo, fmtCompact, fmtDec, fmtInt, fmtPct, blockUrl } from "../lib/format.js";

const POLL_MS = 15_000;
const TABS = ["mine"];
const MIX_LIMIT = 200;
const DATA_TABS = [
  { id: "mines", label: "Mines" },
  { id: "holders", label: "Holders" },
];

export default function TokenPage({ ticker, params, navigate }) {
  const { address, health, tipBlock } = useApp();
  const tokenQ = usePoll((s) => indexer.token(ticker, s), POLL_MS, [ticker]);
  const token = tokenQ.data;
  // A 404 resolves to `null` data with an updatedAt stamp; a still-loading
  // first fetch has no stamp yet (usePoll re-flags `loading` on every tick
  // while data is null, so `loading` alone would flicker every 15 s).
  const notFound = !tokenQ.error && token === null && tokenQ.updatedAt !== null;

  const deployBlock = usePoll(token?.deploy_block ? (s) => indexer.blockInfo(token.deploy_block, s) : null, 0, [token?.deploy_block]);

  const mixQ = usePoll((s) => indexer.minesFeed({ ticker, limit: MIX_LIMIT }, s), POLL_MS, [ticker]);

  // The mine console is the only action tab; stale `?tab=…` links resolve here.
  useEffect(() => {
    if (params.tab && !TABS.includes(params.tab)) navigate(tokenHref(ticker), { replace: true });
  }, [params.tab, ticker, navigate]);

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
    mixQ.refresh();
    setRefreshKey((k) => k + 1);
  }, [tokenQ, mixQ]);

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

  return (
    <main className="page token-page">
      <header className="token-head">
        <span className="ch chamfer identicon-wrap">
          <span className="ch-in chamfer">
            <Identicon ticker={token.ticker} size={72} />
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
              {deployBlock.data?.time ? <span className="muted"> · {fmtAgo(deployBlock.data.time)}</span> : tip ? <span className="muted"> · {fmtInt(Math.max(0, tip - token.deploy_block))} blocks ago</span> : null}
            </span>
          </div>
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

      <div className="token-layout">
        <div className="col">
          <Panel title="Yield model" led="ok" aria-label="Yield model">
            <YieldSpectrum tipDigit={yieldDigit(tipBlock.data?.hash)} />
            <TierTable ticker={token.ticker} />
            <EVReadout size="lg" ticker={token.ticker} />
          </Panel>

          <Panel title={`Observed mix · last ${MIX_LIMIT} mines`} led={ledFromPoll(mixQ)} aria-label="Observed mix">
            <ObservedMix rows={mixQ.data?.items} loading={mixQ.loading} error={mixQ.error} meanLabel="Observed mean" ticker={token.ticker} />
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
          <Panel title="Mine // console" led={ledFromPoll(tokenQ)} aria-label="Mine console">
            <MinePanel ticker={token.ticker} tokenInfo={token} onSettled={onSettled} />
          </Panel>
        </div>
      </div>
    </main>
  );
}
