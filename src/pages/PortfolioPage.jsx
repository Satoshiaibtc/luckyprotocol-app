import { useMemo } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import Identicon from "../components/Identicon.jsx";
import { ConnectPrompt } from "../components/TxProgress.jsx";
import { TradesTable, MinesTable, OrdersTable } from "../components/Tables.jsx";
import { fmtBtc, fmtInt, shortAddr, addrUrl } from "../lib/format.js";

const POLL_MS = 15_000;

const asQ = (poll) => ({ rows: poll.data || [], total: (poll.data || []).length, loading: poll.loading, error: poll.error, hasMore: false, loadMore: () => {} });

export default function PortfolioPage() {
  const { wallet, address, tokens } = useApp();
  const connected = wallet.status === "connected";

  const balances = usePoll(address ? (s) => indexer.balances(address, s) : null, POLL_MS, [address]);
  const mines = usePoll(address ? (s) => indexer.minesByAddress(address, s) : null, POLL_MS, [address]);
  const orders = usePoll(address ? (s) => indexer.ordersByAddress(address, s) : null, POLL_MS, [address]);
  const trades = usePoll(address ? (s) => indexer.tradesByAddress(address, s) : null, POLL_MS, [address]);

  const lastPrice = useMemo(() => {
    const m = new Map();
    for (const t of tokens.data?.items || []) if (t.last_trade) m.set(t.ticker, t.last_trade.unit_price);
    return m;
  }, [tokens.data]);

  const rows = useMemo(() => Object.entries(balances.data || {}).sort((a, b) => b[1] - a[1]), [balances.data]);
  const valueSats = rows.reduce((s, [t, a]) => s + (lastPrice.has(t) ? lastPrice.get(t) * a : 0), 0);

  if (!connected) {
    return (
      <main className="page">
        <div className="empty-state">
          <h2>Your portfolio</h2>
          <p className="muted">Balances, mines, listings and trades for the connected address.</p>
          <ConnectPrompt action="see your portfolio" />
        </div>
      </main>
    );
  }

  return (
    <main className="page portfolio">
      <header className="token-head">
        <div className="token-head-main">
          <h1 className="ticker">Portfolio</h1>
          <div className="meta">
            <a className="mono" href={addrUrl(address)} target="_blank" rel="noopener noreferrer" title={address}>
              {shortAddr(address, 10, 8)}
            </a>
            <span className="muted">{wallet.balance !== null ? `${fmtBtc(wallet.balance)} BTC` : ""}</span>
            {valueSats > 0 && <span className="muted">tokens ≈ {fmtBtc(valueSats)} BTC at last prices</span>}
          </div>
        </div>
      </header>

      <div className="portfolio-grid">
        <section className="panel">
          <div className="panel-head">
            <span className="label">Balances</span>
          </div>
          {balances.error && rows.length === 0 ? (
            <div className="err">Could not load: {String(balances.error.message)}</div>
          ) : rows.length === 0 ? (
            <div className="empty">{balances.loading ? "Loading…" : "No tokens on this address yet."}</div>
          ) : (
            <ul className="bal-list">
              {rows.map(([ticker, amount]) => (
                <li key={ticker}>
                  <a className="bal-row" href={tokenHref(ticker)}>
                    <Identicon ticker={ticker} size={28} />
                    <span className="t">{ticker}</span>
                    <span className="a">{fmtInt(amount)}</span>
                    <span className="v muted">{lastPrice.has(ticker) ? `≈ ${fmtBtc(lastPrice.get(ticker) * amount)} BTC` : "no trades yet"}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="label">My listings</span>
            <span className="label">{fmtInt((orders.data || []).filter((o) => o.status === "open").length)} open</span>
          </div>
          <OrdersTable q={asQ(orders)} showTicker empty="No listings yet — list from a token's Sell tab." />
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="label">My trades</span>
          </div>
          <TradesTable q={asQ(trades)} self={address} showTicker empty="No trades yet." />
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="label">My mines</span>
          </div>
          <MinesTable q={asQ(mines)} self={address} showTicker empty="No mines from this address yet." />
        </section>
      </div>
    </main>
  );
}
