import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { usePaged } from "../hooks/usePaged.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import Identicon from "../components/Identicon.jsx";
import MintProgress from "../components/MintProgress.jsx";
import PriceChart from "../components/PriceChart.jsx";
import MinePanel from "../components/MinePanel.jsx";
import BuyPanel from "../components/BuyPanel.jsx";
import SellPanel from "../components/SellPanel.jsx";
import { TradesTable, MinesTable, HoldersTable, AddrLink, TxLink } from "../components/Tables.jsx";
import { impliedMcapSats } from "../components/TokenCard.jsx";
import { fmtAgo, fmtBtcShort, fmtCompact, fmtInt, fmtPct, fmtUnit, blockUrl } from "../lib/format.js";

const POLL_MS = 15_000;
const TABS = ["mine", "buy", "sell"];
const DATA_TABS = [
  { id: "trades", label: "Trades" },
  { id: "mines", label: "Mines" },
  { id: "holders", label: "Holders" },
];

export default function TokenPage({ ticker, params, navigate }) {
  const { address, health } = useApp();
  const tokenQ = usePoll((s) => indexer.token(ticker, s), POLL_MS, [ticker]);
  const token = tokenQ.data;
  // A 404 resolves to `null` data with an updatedAt stamp; a still-loading
  // first fetch has no stamp yet (usePoll re-flags `loading` on every tick
  // while data is null, so `loading` alone would flicker every 15 s).
  const notFound = !tokenQ.error && token === null && tokenQ.updatedAt !== null;

  const deployBlock = usePoll(token?.deploy_block ? (s) => indexer.blockInfo(token.deploy_block, s) : null, 0, [token?.deploy_block]);

  const tradesQ = usePoll((s) => indexer.trades({ ticker, limit: 200 }, s), POLL_MS, [ticker]);

  const [tab, setTab] = useState(TABS.includes(params.tab) ? params.tab : "mine");
  useEffect(() => {
    if (TABS.includes(params.tab)) setTab(params.tab);
  }, [params.tab]);
  const pickTab = (t) => {
    setTab(t);
    navigate(tokenHref(ticker, t), { replace: true });
  };

  const [dataTab, setDataTab] = useState("trades");
  const [refreshKey, setRefreshKey] = useState(0);
  const tradesPaged = usePaged((offset, limit, s) => indexer.trades({ ticker, offset, limit }, s), { limit: 25, deps: [ticker, refreshKey], refreshMs: 30_000 });
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
    tradesQ.refresh();
    setRefreshKey((k) => k + 1);
  }, [tokenQ, tradesQ]);

  const mcap = useMemo(() => (token ? impliedMcapSats(token) : null), [token]);
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

  const last = token.last_trade?.unit_price ?? null;

  return (
    <main className="page token-page">
      <header className="token-head">
        <Identicon ticker={token.ticker} size={72} />
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
          <MintProgress ticker={token.ticker} minted={token.minted} supply={token.supply} />
        </div>
      </header>

      <dl className="stats">
        <div>
          <dt>Minted</dt>
          <dd>{fmtPct(token.minted, token.supply, 1)}</dd>
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
          <dt>Last price</dt>
          <dd>{last !== null ? <>{fmtUnit(last)} <small>sats</small></> : "—"}</dd>
        </div>
        <div>
          <dt>Mcap</dt>
          <dd>{mcap !== null ? fmtBtcShort(mcap) : "—"}</dd>
        </div>
        <div>
          <dt>Open asks</dt>
          <dd>{fmtInt(token.open_orders)}</dd>
        </div>
        <div>
          <dt>Floor</dt>
          <dd>{token.floor_unit_price !== null ? <>{fmtUnit(token.floor_unit_price)} <small>sats</small></> : "—"}</dd>
        </div>
        <div>
          <dt>Volume</dt>
          <dd>{fmtBtcShort(token.volume_sats)}</dd>
        </div>
      </dl>

      <div className="token-layout">
        <div className="col">
          <PriceChart trades={tradesQ.data?.items || []} ticker={token.ticker} loading={tradesQ.loading} error={tradesQ.error} />

          <section className="panel">
            <div className="panel-head">
              <div className="tabs" role="tablist" aria-label="Token activity">
                {DATA_TABS.map((t) => (
                  <button key={t.id} className="tab" role="tab" aria-selected={dataTab === t.id} onClick={() => setDataTab(t.id)} type="button">
                    {t.label}
                  </button>
                ))}
              </div>
              <span className="label">
                {dataTab === "trades" ? `${fmtInt(tradesPaged.total)} total` : dataTab === "mines" ? `${fmtInt(minesPaged.total)} total` : `${fmtInt(holdersPaged.total)} total`}
              </span>
            </div>
            {dataTab === "trades" && <TradesTable q={tradesPaged} self={address} empty={`No ${token.ticker} trades yet.`} />}
            {dataTab === "mines" && <MinesTable q={minesPaged} self={address} empty={`No ${token.ticker} mines yet.`} />}
            {dataTab === "holders" && <HoldersTable q={holdersPaged} minted={token.minted} self={address} />}
          </section>
        </div>

        <div className="col">
          <section className="panel action-panel" aria-label="Actions">
            <div className="action-tabs" role="tablist" aria-label="Action">
              {TABS.map((t) => (
                <button key={t} className="action-tab" role="tab" aria-selected={tab === t} onClick={() => pickTab(t)} type="button">
                  {t === "mine" ? "Mine" : t === "buy" ? "Buy" : "Sell"}
                </button>
              ))}
            </div>
            {tab === "mine" && <MinePanel ticker={token.ticker} tokenInfo={token} />}
            {tab === "buy" && <BuyPanel ticker={token.ticker} token={token} onSettled={onSettled} />}
            {tab === "sell" && <SellPanel ticker={token.ticker} token={token} onSettled={onSettled} />}
          </section>
        </div>
      </div>
    </main>
  );
}
