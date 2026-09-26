import { useMemo, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { usePaged } from "../hooks/usePaged.js";
import { useSendToSelf } from "../hooks/useSendToSelf.js";
import { friendlyError } from "../hooks/useWallet.js";
import AvatarPanel from "../components/AvatarPanel.jsx";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import TokenAvatar from "../components/TokenAvatar.jsx";
import TxProgress, { ConnectPrompt } from "../components/TxProgress.jsx";
import { MinesTable, OrdersTable, TradesTable } from "../components/Tables.jsx";
import ObservedMix from "../components/ObservedMix.jsx";
import Panel from "../components/hud/Panel.jsx";
import { ledFromPoll } from "../components/hud/Led.jsx";
import { summarizeMix } from "../lib/mix.js";
import { fmtBtc, fmtInt, fmtPct, fmtUnit, shortAddr, addrUrl } from "../lib/format.js";

const POLL_MS = 15_000;
const IDLE = { phase: "idle" };

const asQ = (poll) => ({ rows: poll.data || [], total: (poll.data || []).length, loading: poll.loading, error: poll.error, hasMore: false, loadMore: () => {} });

export default function PortfolioPage() {
  const { wallet, address, tokens, price } = useApp();
  const connected = wallet.status === "connected";
  const mobile = useIsMobile();
  const usd = price.data?.usd_per_btc ?? null;

  const balances = usePoll(address ? (s) => indexer.balances(address, s) : null, POLL_MS, [address]);
  const mines = usePoll(address ? (s) => indexer.minesByAddress(address, s) : null, POLL_MS, [address]);
  const orders = usePoll(address ? (s) => indexer.ordersByAddress(address, s) : null, POLL_MS, [address]);
  const trades = usePoll(address ? (s) => indexer.tradesByAddress(address, s) : null, POLL_MS, [address]);
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

  // Listings: live first (open / filling), then closed, newest first.
  const listings = useMemo(() => {
    const live = (o) => (o.status === "open" || o.status === "filling" ? 0 : 1);
    return [...(orders.data || [])].sort((a, b) => live(a) - live(b) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  }, [orders.data]);
  const liveCount = listings.filter((o) => o.status === "open" || o.status === "filling").length;
  const fillingCount = listings.filter((o) => o.status === "filling").length;

  // Cancel = SEND-to-self of the listed carrier (M-9 rule inside the hook); Renew = re-POST.
  const { chain, status, run, reset, busy } = useSendToSelf({ onSettled: () => orders.refresh() });
  const [renew, setRenew] = useState(IDLE);
  const renewOrder = async (o) => {
    setRenew({ phase: "busy", id: o.id });
    try {
      await indexer.renewOrder(o.id);
      setRenew({ phase: "done", id: o.id });
      orders.refresh();
    } catch (e) {
      setRenew({ phase: "error", id: o.id, error: friendlyError(e) });
    }
  };
  const cancelOrder = (o) => {
    const [txid, vout] = o.id.split(":");
    run({ kind: "cancel", ticker: o.ticker, amount: o.amount, utxo: { txid, vout: Number(vout), sats: o.carrier_sats }, order: o });
  };

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
                      <span className="v muted">
                        {t && t.minted ? `${fmtPct(amount, t.minted, 2)} of minted` : "—"}
                        {t?.floor_unit_price ? ` · floor ${fmtUnit(t.floor_unit_price)}` : ""}
                      </span>
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

        <Panel
          title="My listings"
          led={ledFromPoll(orders)}
          className="span-2"
          aria-label="My listings"
          right={
            <span className="label">
              {fmtInt(liveCount)} live{fillingCount ? ` · ${fmtInt(fillingCount)} filling` : ""} · {fmtInt(listings.length)} total
            </span>
          }
        >
          {renew.phase === "busy" && <div className="muted">Renewing…</div>}
          {renew.phase === "done" && <div className="ok">Renewed — the book keeps it 14 more days.</div>}
          {renew.phase === "error" && <div className="err">{renew.error}</div>}
          {chain.phase !== "idle" && (
            <>
              {chain.rule?.raised && (
                <div className="notice">
                  <strong>Replacement fee (M-9).</strong> A fill of this listing is pending in the mempool at {chain.order?.pending_feerate ?? "?"} sat/vB; replacing it requires at least {chain.rule.floorSatVb} sat/vB — this transaction uses {chain.rule.satVb} sat/vB.
                </div>
              )}
              <TxProgress
                flow={chain}
                status={status}
                onReset={reset}
                labels={{
                  building: "Building the withdrawal — a SEND of the listed UTXO to yourself.",
                  pending: "Withdrawal broadcast. Pending confirmation — checking every 15 s.",
                  confirmed: "Withdrawn on-chain. The old signed listing can no longer be filled.",
                }}
              />
            </>
          )}
          <OrdersTable q={{ ...asQ(orders), rows: listings }} showTicker onCancel={cancelOrder} onRenew={renewOrder} busy={busy || renew.phase === "busy"} empty="No listings from this address. List a carrier on a token's Market tab." />
          <p className="fineprint">
            A listing expires 14 days after it was (re)published; <strong>Renew</strong> re-POSTs the same signed PSBT for free. <strong>Cancel</strong> is a SEND to yourself — the only thing that voids a signed listing. A <em>filling</em> row has a fill in the mempool: if it confirms you are paid; withdrawing it must out-bid that fill.
          </p>
        </Panel>

        <Panel title="My trades" led={ledFromPoll(trades)} className="span-2" aria-label="My trades" right={<span className="label">{fmtInt((trades.data || []).length)} total</span>}>
          <TradesTable q={asQ(trades)} self={address} usd={usd} showTicker empty="No fills yet — as buyer or seller." />
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
