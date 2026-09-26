import { useMemo } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { usePaged } from "../hooks/usePaged.js";
import AvatarPanel from "../components/AvatarPanel.jsx";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import TokenAvatar from "../components/TokenAvatar.jsx";
import { ConnectPrompt } from "../components/TxProgress.jsx";
import { MinesTable } from "../components/Tables.jsx";
import ObservedMix from "../components/ObservedMix.jsx";
import Panel from "../components/hud/Panel.jsx";
import { ledFromPoll } from "../components/hud/Led.jsx";
import { summarizeMix } from "../lib/mix.js";
import { fmtBtc, fmtInt, fmtPct, shortAddr, addrUrl } from "../lib/format.js";

const POLL_MS = 15_000;

const asQ = (poll) => ({ rows: poll.data || [], total: (poll.data || []).length, loading: poll.loading, error: poll.error, hasMore: false, loadMore: () => {} });

export default function PortfolioPage() {
  const { wallet, address, tokens } = useApp();
  const connected = wallet.status === "connected";
  const mobile = useIsMobile();

  const balances = usePoll(address ? (s) => indexer.balances(address, s) : null, POLL_MS, [address]);
  const mines = usePoll(address ? (s) => indexer.minesByAddress(address, s) : null, POLL_MS, [address]);
  const created = usePaged(address ? (offset, limit, s) => indexer.tokens({ deployer: address, offset, limit }, s) : null, { limit: 10, deps: [address], refreshMs: 30_000 });

  const tokenByTicker = useMemo(() => {
    const m = new Map();
    for (const t of tokens.data?.items || []) m.set(t.ticker, t);
    return m;
  }, [tokens.data]);

  const rows = useMemo(() => Object.entries(balances.data || {}).sort((a, b) => b[1] - a[1]), [balances.data]);
  const mix = useMemo(() => summarizeMix(mines.data || []), [mines.data]);
  // Unit on the mix total only when every mine is the same ticker.
  const mixTicker = useMemo(() => {
    const set = new Set((mines.data || []).map((r) => r.ticker));
    return set.size === 1 ? [...set][0] : "";
  }, [mines.data]);

  if (!connected) {
    return (
      <main className="page">
        <div className="empty-state">
          <h2>Your portfolio</h2>
          <p className="muted">Balances and mines for the connected address.</p>
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
          </div>
        </div>
      </header>

      <div className="portfolio-grid">
        <Panel title="Balances" led={ledFromPoll(balances)} aria-label="Balances">
          {balances.error && rows.length === 0 ? (
            <div className="err">Could not load: {String(balances.error.message)}</div>
          ) : rows.length === 0 ? (
            <div className="empty">{balances.loading ? "Loading…" : "No tokens on this address yet."}</div>
          ) : (
            <ul className="bal-list">
              {rows.map(([ticker, amount]) => {
                const t = tokenByTicker.get(ticker);
                return (
                  <li key={ticker}>
                    <a className="bal-row" href={tokenHref(ticker)}>
                      <TokenAvatar ticker={ticker} avatarTxid={t?.avatar_txid} size={28} />
                      <span className="t">{ticker}</span>
                      <span className="a">{fmtInt(amount)}</span>
                      <span className="v muted">{t && t.minted ? `${fmtPct(amount, t.minted, 2)} of minted` : "—"}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title={`My mix · ${fmtInt(mix.n)} mines`} led={ledFromPoll(mines)} aria-label="My yield mix">
          <ObservedMix rows={mines.data} loading={mines.loading} error={mines.error} meanLabel="Your mean" showTotal ticker={mixTicker} help="Small samples sit far from the model; that is expected." />
        </Panel>

        <Panel title="My mines" led={ledFromPoll(mines)} className="span-2" aria-label="My mines">
          <MinesTable q={asQ(mines)} self={address} showTicker compact={mobile} empty="No mines from this address yet." />
        </Panel>
        <Panel title="My created tokens" className="span-2" aria-label="My created tokens">
          {created.error && <p className="err">Could not load created tokens: {String(created.error.message)}</p>}
          {!created.rows.length && <p className="muted">{created.loading ? "Loading..." : "No tokens created by this address."}</p>}
          {created.rows.filter((t) => t.deployer === address).map((t) => (
            <details className="created-token" key={`${address}:${t.ticker}`}>
              <summary><TokenAvatar ticker={t.ticker} avatarTxid={t.avatar_txid} size={28} /><strong>{t.ticker}</strong><span>Change avatar</span></summary>
              <AvatarPanel ticker={t.ticker} tokenInfo={t} onSettled={created.refresh} />
            </details>
          ))}
          {created.hasMore && <button type="button" className="btn btn-sm" disabled={created.loading} onClick={created.loadMore}>Load more</button>}
        </Panel>
      </div>
    </main>
  );
}
