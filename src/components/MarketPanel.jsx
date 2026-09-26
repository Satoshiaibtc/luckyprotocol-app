import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { usePaged } from "../hooks/usePaged.js";
import { INTERVALS, WINDOWS, changeSign, fmtChangePct, orderSelectable } from "../lib/market.js";
import { fmtAgo, fmtBtcShort, fmtCompact, fmtInt, fmtUnit, fmtUsd } from "../lib/format.js";
import Panel from "./hud/Panel.jsx";
import Fold from "./hud/Fold.jsx";
import { ledFromPoll } from "./hud/Led.jsx";
import CandleChart from "./CandleChart.jsx";
import OrderBook from "./OrderBook.jsx";
import BuyPanel from "./BuyPanel.jsx";
import SellPanel from "./SellPanel.jsx";
import { TradesTable } from "./Tables.jsx";

const POLL_MS = 15_000;
const BOOK_LIMIT = 200;

/**
 * The Market tab of a token page: stat strip (24h | 7d) · candles + order
 * book · the persistent buy bar · List / Split / Withdraw · recent trades.
 * Everything is sats-first; USD sub-labels appear only while /price
 * reports a number.
 */
export default function MarketPanel({ ticker, token, onSettled }) {
  const { address, price } = useApp();
  const usd = price.data?.usd_per_btc ?? null;
  const [range, setRange] = useState("24h");
  const [interval, setInterval_] = useState("1h");
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedId, setSelectedId] = useState(null);

  const marketQ = usePoll((s) => indexer.market(ticker, range, s), POLL_MS, [ticker, range]);
  const candlesQ = usePoll((s) => indexer.candles(ticker, { interval, limit: INTERVALS.find((i) => i.id === interval)?.limit ?? 168 }, s), POLL_MS, [ticker, interval]);
  const bookQ = usePoll(
    async (s) => {
      const [open, filling] = await Promise.all([indexer.orders({ ticker, status: "open", limit: BOOK_LIMIT }, s), indexer.orders({ ticker, status: "filling", limit: BOOK_LIMIT }, s)]);
      return [...open.items, ...filling.items];
    },
    POLL_MS,
    [ticker],
  );
  const tradesPaged = usePaged((offset, limit, s) => indexer.trades({ ticker, offset, limit }, s), { limit: 25, deps: [ticker, refreshKey], refreshMs: 30_000 });

  const book = useMemo(() => bookQ.data || [], [bookQ.data]);
  const selected = useMemo(() => book.find((o) => o.id === selectedId) || null, [book, selectedId]);
  // A selection that vanished (filled, withdrawn, now filling) is dropped.
  useEffect(() => {
    if (selectedId && (!selected || !orderSelectable(selected, address).ok)) setSelectedId(null);
  }, [selectedId, selected, address]);

  const settled = useCallback(() => {
    marketQ.refresh();
    candlesQ.refresh();
    bookQ.refresh();
    setRefreshKey((k) => k + 1);
    onSettled?.();
  }, [marketQ, candlesQ, bookQ, onSettled]);

  const m = marketQ.data;
  const sign = changeSign(m?.change_pct);
  const floor = m?.floor_unit_price ?? token?.floor_unit_price ?? null;
  const last = m?.last_trade ?? token?.last_trade ?? null;

  return (
    <div className="market">
      <Panel
        title="Market"
        led={ledFromPoll(marketQ)}
        className="market-stats-panel"
        aria-label="Market summary"
        right={
          <>
            <div className="chips chips-sm" role="tablist" aria-label="Window">
              {WINDOWS.map((w) => (
                <button key={w.id} type="button" role="tab" aria-selected={range === w.id} className={`chip${range === w.id ? " active" : ""}`} onClick={() => setRange(w.id)}>
                  {w.label}
                </button>
              ))}
            </div>
            {m?.as_of ? <span className="label">as of {fmtAgo(m.as_of)}{m.tip_height ? ` · #${fmtInt(m.tip_height)}` : ""}</span> : null}
          </>
        }
      >
        <dl className="stats market-stats">
          <div>
            <dt>Floor · sats/{ticker}</dt>
            <dd>{floor !== null ? fmtUnit(floor) : "—"}</dd>
            {usd && floor !== null ? <span className="sub">{fmtUsd(floor, usd)}</span> : null}
          </div>
          <div>
            <dt>Listed</dt>
            <dd>{m?.listed_amount !== null && m?.listed_amount !== undefined ? fmtCompact(m.listed_amount) : "—"}</dd>
            <span className="sub">{m?.open_orders !== null && m?.open_orders !== undefined ? `${fmtInt(m.open_orders)} ask${m.open_orders === 1 ? "" : "s"}` : ""}</span>
          </div>
          <div>
            <dt>Volume · {range}</dt>
            <dd>{m?.volume_sats !== null && m?.volume_sats !== undefined ? fmtCompact(m.volume_sats) : "—"}</dd>
            <span className="sub">{m?.volume_sats ? `${fmtBtcShort(m.volume_sats)}${usd ? ` · ${fmtUsd(m.volume_sats, usd)}` : ""}` : "sats"}</span>
          </div>
          <div>
            <dt>Trades · {range}</dt>
            <dd>{m?.trades !== null && m?.trades !== undefined ? fmtInt(m.trades) : "—"}</dd>
            <span className="sub">{m?.buyers !== null && m?.buyers !== undefined ? `${fmtInt(m.buyers)} buyer${m.buyers === 1 ? "" : "s"} · ${fmtInt(m.sellers)} seller${m.sellers === 1 ? "" : "s"}` : ""}</span>
          </div>
          <div>
            <dt>High / low · {range}</dt>
            <dd>{m?.high_unit_price !== null && m?.high_unit_price !== undefined ? `${fmtUnit(m.high_unit_price)} / ${fmtUnit(m.low_unit_price)}` : "—"}</dd>
            <span className="sub">{m?.first_unit_price !== null && m?.first_unit_price !== undefined ? `opened ${fmtUnit(m.first_unit_price)}` : ""}</span>
          </div>
          <div>
            <dt>Change · {range}</dt>
            <dd className={sign ? `delta-${sign}` : ""}>{fmtChangePct(m?.change_pct)}</dd>
            {/* the live indexer sends the flag `true` (always excluded, §5), the mock a count: only a count worth mentioning is shown */}
            <span className="sub">{typeof m?.self_trades_excluded === "number" && m.self_trades_excluded > 0 ? `${fmtInt(m.self_trades_excluded)} self-trade${m.self_trades_excluded === 1 ? "" : "s"} excluded` : ""}</span>
          </div>
          <div>
            <dt>Last trade</dt>
            <dd>{last ? fmtUnit(last.unit_price) : "—"}</dd>
            <span className="sub">{last ? `${fmtInt(last.amount)} ${ticker} · ${last.block_time ? fmtAgo(last.block_time) : `#${fmtInt(last.block_height)}`}${usd ? ` · ${fmtUsd(last.unit_price, usd)}/token` : ""}` : "no trades yet"}</span>
          </div>
        </dl>
        {marketQ.error && !m && <div className="err">Could not load the market summary: {String(marketQ.error.message)}</div>}
      </Panel>

      <div className="market-grid">
        <Panel title={`Price · sats per ${ticker}`} led={ledFromPoll(candlesQ)} aria-label="Price chart">
          <CandleChart ticker={ticker} candles={candlesQ.data?.candles} interval={interval} onInterval={setInterval_} loading={candlesQ.loading} error={candlesQ.error} usd={usd} />
        </Panel>
        <Panel
          title="Asks"
          led={ledFromPoll(bookQ)}
          aria-label="Order book"
          right={
            <>
              <span className="label">{fmtInt(book.filter((o) => o.status === "open").length)} open{book.some((o) => o.status === "filling") ? ` · ${fmtInt(book.filter((o) => o.status === "filling").length)} filling` : ""}</span>
              <button className="btn btn-ghost btn-sm" type="button" onClick={bookQ.refresh} disabled={bookQ.loading}>
                Refresh
              </button>
            </>
          }
        >
          <OrderBook ticker={ticker} rows={book} loading={bookQ.loading} error={bookQ.error} address={address} selectedId={selectedId} onSelect={(o) => setSelectedId(o ? o.id : null)} usd={usd} />
        </Panel>
      </div>

      <BuyPanel ticker={ticker} token={token} order={selected} onClear={() => setSelectedId(null)} onSettled={settled} usd={usd} />

      <Fold title="List / Split / Withdraw" summary="List a whole carrier at a unit or total price · split part of it off first · renew or withdraw your listings" led={address ? "ok" : "idle"} aria-label="Sell">
        <SellPanel ticker={ticker} token={token} onSettled={settled} usd={usd} />
      </Fold>

      <Panel title="Recent trades" led={tradesPaged.error ? "err" : tradesPaged.loading && tradesPaged.rows.length === 0 ? "busy" : "ok"} right={<span className="label">{fmtInt(tradesPaged.total)} total</span>} aria-label="Recent trades">
        <TradesTable q={tradesPaged} self={address} usd={usd} empty={`No ${ticker} trades yet.`} />
      </Panel>
    </div>
  );
}
