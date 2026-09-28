import { useMemo, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { usePaged } from "../hooks/usePaged.js";
import { useSendToSelf } from "../hooks/useSendToSelf.js";
import { friendlyError } from "../hooks/useWallet.js";
import { sendHref, tokenHref } from "../hooks/useHashRoute.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import Identicon from "../components/Identicon.jsx";
import TxProgress, { ConnectPrompt } from "../components/TxProgress.jsx";
import { MinesTable, OrdersTable, TradesTable } from "../components/Tables.jsx";
import ObservedMix from "../components/ObservedMix.jsx";
import Panel from "../components/hud/Panel.jsx";
import { ledFromPoll } from "../components/hud/Led.jsx";
import { txRecords } from "../lib/txrecords.js";
import { indexerErrorText, indexerErrorTitle } from "../lib/errors.js";
import { WITHDRAW_CONFIRMED_TEXT, WITHDRAW_PENDING_TEXT, listingRefusalText } from "../lib/market.js";
import { fmtInt, fmtMintedPct, fmtPct, fmtUnit, shortAddr, shortTxid, addrUrl, walletBalanceText } from "../lib/format.js";

const POLL_MS = 15_000;
const IDLE = { phase: "idle" };

export default function PortfolioPage() {
  const { wallet, address, tokens, price } = useApp();
  const connected = wallet.status === "connected";
  const mobile = useIsMobile();
  const usd = price.data?.usd_per_btc ?? null;

  const balances = usePoll(address ? (s) => indexer.balances(address, s) : null, POLL_MS, [address]);
  // Carriers that hold more than one ticker cannot be listed (§7.1) — the
  // Balances panel offers to split them (a SEND to yourself, audits
  // portfolio-2 / portfolio-3).
  const carriers = usePoll(address ? (s) => indexer.tokenUtxos(address, s) : null, POLL_MS, [address]);
  const multiCarriers = useMemo(() => (carriers.data || []).filter((u) => Object.keys(u.balances || {}).length > 1), [carriers.data]);
  // /mines/:addr is paged by the indexer (50 / page, max 200, indexer API): the
  // table pages with Load more, and the mix reads the newest 200 and says so
  // — never a silent "50 mines" (audit portfolio-4).
  const mines = usePaged(address ? (offset, limit, s) => indexer.minesByAddress(address, { offset, limit }, s) : null, { limit: 50, deps: [address], refreshMs: POLL_MS });
  const mixQ = usePoll(address ? (s) => indexer.minesByAddress(address, { limit: indexer.ADDR_LIST_MAX_LIMIT }, s) : null, POLL_MS, [address]);
  const mixRows = mixQ.data?.items || null;
  const minesTotal = mixQ.data?.total ?? (mines.error ? null : mines.total);
  // Both per-address lists are paged by the indexer (50 / page, indexer API);
  // `total` is the real count and Load more walks the rest.
  const orders = usePaged(address ? (offset, limit, s) => indexer.ordersByAddress(address, { offset, limit }, s) : null, { limit: 50, deps: [address], refreshMs: POLL_MS });
  const trades = usePaged(address ? (offset, limit, s) => indexer.tradesByAddress(address, { offset, limit }, s) : null, { limit: 50, deps: [address], refreshMs: POLL_MS });
  const created = usePaged(address ? (offset, limit, s) => indexer.tokens({ deployer: address, offset, limit }, s) : null, { limit: 10, deps: [address], refreshMs: 30_000 });

  const tokenByTicker = useMemo(() => {
    const m = new Map();
    for (const t of tokens.data?.items || []) m.set(t.ticker, t);
    return m;
  }, [tokens.data]);

  const rows = useMemo(() => Object.entries(balances.data || {}).sort((a, b) => b[1] - a[1]), [balances.data]);
  // Unit on the mix total only when every mine is the same ticker.
  const mixTicker = useMemo(() => {
    const set = new Set((mixRows || []).map((r) => r.ticker));
    return set.size === 1 ? [...set][0] : "";
  }, [mixRows]);

  // Listings: live first (open / filling), then closed, newest first — within the loaded pages.
  const listings = useMemo(() => {
    const live = (o) => (o.status === "open" || o.status === "filling" ? 0 : 1);
    return [...orders.rows].sort((a, b) => live(a) - live(b) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  }, [orders.rows]);
  const liveCount = listings.filter((o) => o.status === "open" || o.status === "filling").length;
  const fillingCount = listings.filter((o) => o.status === "filling").length;

  // Withdraw = SEND-to-self of the listed carrier (the spec's cancel; M-9 rule inside the hook); Renew = re-POST.
  const { chain, status, run, reset, busy } = useSendToSelf({ onSettled: () => orders.refresh() });
  // This browser's own pending transactions: a listing whose pending spend
  // is one of them is the user's own withdrawal, not a buyer's fill.
  // Re-read whenever the listings poll answers.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read the store on each listings refresh
  const records = useMemo(() => (address ? txRecords(address) : []), [address, orders.rows, chain.phase]);
  const [renew, setRenew] = useState(IDLE);
  const renewOrder = async (o) => {
    setRenew({ phase: "busy", id: o.id });
    try {
      await indexer.renewOrder(o.id);
      setRenew({ phase: "done", id: o.id });
      orders.refresh();
    } catch (e) {
      // A refusal of the book (price band, withdraw first, …) in the sell form's plain words.
      setRenew({ phase: "error", id: o.id, error: listingRefusalText(e) ?? friendlyError(e) });
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
            <span className="muted">{walletBalanceText(wallet.balance, wallet.balanceConfirmed)}</span>
          </div>
        </div>
      </header>

      <div className="portfolio-grid">
        <Panel title="Balances" led={ledFromPoll(balances)} aria-label="Balances">
          {balances.error && rows.length === 0 ? (
            <div className="err" title={indexerErrorTitle(balances.error)}>
              Could not load. {indexerErrorText(balances.error, { retrySec: POLL_MS / 1000 })}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">{balances.loading ? "Loading…" : "No tokens on this address yet."}</div>
          ) : (
            <ul className="bal-list">
              {rows.map(([ticker, amount]) => {
                const t = tokenByTicker.get(ticker);
                return (
                  <li key={ticker} className="bal-item">
                    <a className="bal-row" href={tokenHref(ticker)}>
                      <Identicon ticker={ticker} size={28} />
                      <span className="t">{ticker}</span>
                      <span className="a">{fmtInt(amount)}</span>
                      <span className="v muted">
                        {t && t.minted ? `${fmtPct(amount, t.minted, 2)} of minted` : "—"}
                        {t?.floor_unit_price ? ` · floor ${fmtUnit(t.floor_unit_price)}` : ""}
                      </span>
                    </a>
                    {/* Any token can be sent, market open or not (decision G). */}
                    <a className="btn btn-sm bal-send" href={sendHref(ticker)} aria-label={`Send ${ticker}`}>
                      Send
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          {multiCarriers.length > 0 && (
            <div className="bal-multi">
              <span className="label">
                Carriers holding several tickers · {fmtInt(multiCarriers.length)}
              </span>
              <ul className="bal-multi-list">
                {multiCarriers.map((u) => {
                  const utxo = `${u.txid}:${u.vout}`;
                  return (
                    <li key={utxo}>
                      <span className="mono muted" title={utxo}>
                        {shortTxid(u.txid, 6, 4)}:{u.vout}
                      </span>
                      <span className="bal-multi-amounts">
                        {Object.entries(u.balances)
                          .map(([tk, a]) => `${fmtInt(a)} ${tk}`)
                          .join(" + ")}
                      </span>
                      <span className="bal-multi-actions">
                        {Object.keys(u.balances).map((tk) => (
                          <a key={tk} className="btn btn-ghost btn-sm" href={sendHref(tk, { utxo, toSelf: true })}>
                            Split off {tk}
                          </a>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="fineprint">
                A carrier with more than one ticker cannot be listed for sale. <strong>Split off</strong> sends that ticker to yourself: it lands alone on a new 546-sat carrier, and the other tickers stay
                together on your residual carrier.
              </p>
            </div>
          )}
        </Panel>

        <Panel title={`My mix · ${minesTotal === null ? "—" : fmtInt(minesTotal)} mines`} led={ledFromPoll(mixQ)} aria-label="My yield mix">
          <ObservedMix
            rows={mixRows}
            loading={mixQ.loading}
            error={mixQ.error}
            meanLabel="Your mean"
            showTotal
            of={minesTotal}
            ticker={mixTicker}
            help="Small samples sit far from the model; that is expected."
          />
        </Panel>

        <Panel
          title="My listings"
          led={orders.error ? "err" : orders.loading && orders.rows.length === 0 ? "busy" : "ok"}
          className="span-2"
          aria-label="My listings"
          right={
            <span className="label">
              {fmtInt(liveCount)} live{fillingCount ? ` · ${fmtInt(fillingCount)} filling` : ""}{orders.total > orders.rows.length ? ` of ${fmtInt(orders.rows.length)} loaded` : ""} · {fmtInt(orders.total)} total
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
                  pending: WITHDRAW_PENDING_TEXT,
                  confirmed: WITHDRAW_CONFIRMED_TEXT,
                  final: "Withdrawn on-chain and final. The old signed listing can no longer be filled.",
                }}
              />
            </>
          )}
          <OrdersTable q={{ ...orders, rows: listings }} showTicker onCancel={cancelOrder} onRenew={renewOrder} busy={busy || renew.phase === "busy"} records={records} empty="No listings from this address. List a carrier on a token's Market tab." />
          <p className="fineprint">
            A listing expires 14 days after it was (re)published; <strong>Renew</strong> re-POSTs the same signed PSBT for free. <strong>Withdraw</strong> is a SEND to yourself — the only thing that voids a signed listing. A <em>filling</em> row has someone else&apos;s fill in the mempool: if it confirms you are paid, and withdrawing it must out-bid that fill. A <em>withdrawing</em> row is your own withdrawal waiting for a block — until it confirms, the listing can still be bought.
          </p>
        </Panel>

        <Panel title="My trades" led={trades.error ? "err" : trades.loading && trades.rows.length === 0 ? "busy" : "ok"} className="span-2" aria-label="My trades" right={<span className="label">{fmtInt(trades.total)} total</span>}>
          <TradesTable q={trades} self={address} usd={usd} showTicker empty="No fills yet — as buyer or seller." />
        </Panel>

        <Panel
          title="My mines"
          led={mines.error ? "err" : mines.loading && mines.rows.length === 0 ? "busy" : "ok"}
          className="span-2"
          aria-label="My mines"
          right={<span className="label">{mines.error && mines.rows.length === 0 ? "—" : fmtInt(mines.total)} total</span>}
        >
          <MinesTable q={mines} self={address} showTicker compact={mobile} empty="No mines from this address yet." />
        </Panel>
        <Panel title="My created tokens" className="span-2" aria-label="My created tokens">
          {created.error && <p className="err" title={indexerErrorTitle(created.error)}>Could not load created tokens. {indexerErrorText(created.error)}</p>}
          {!created.rows.length && <p className="muted">{created.loading ? "Loading..." : "No tokens created by this address."}</p>}
          {created.rows.length > 0 && (
            <ul className="bal-list">
              {created.rows.filter((t) => t.deployer === address).map((t) => (
                <li key={`${address}:${t.ticker}`}>
                  <a className="bal-row" href={tokenHref(t.ticker)}>
                    <Identicon ticker={t.ticker} size={28} />
                    <span className="t">{t.ticker}</span>
                    <span className="a">{fmtMintedPct(t.minted, t.supply, 2)}</span>
                    <span className="v muted">minted · since #{fmtInt(t.deploy_block)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {created.hasMore && <button type="button" className="btn btn-sm" disabled={created.loading} onClick={created.loadMore}>Load more</button>}
        </Panel>
      </div>
    </main>
  );
}
