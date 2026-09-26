import { orderSelectable, sortAsks } from "../lib/market.js";
import { fmtBtcShort, fmtInt, fmtUnit, fmtUsd, shortAddr } from "../lib/format.js";

/**
 * Open asks (plus `filling` ones, greyed) sorted by unit price. A row is a
 * radio-like control: click / Enter / Space selects it for the buy bar.
 * Own listings are flagged "you" and cannot be selected; a `filling` row
 * says which fee rate the pending fill pays and cannot be selected either.
 */
export default function OrderBook({ ticker, rows, loading, error, address, selectedId, onSelect, usd = null }) {
  const asks = sortAsks(rows || []);
  return (
    <div className="table cols-book" role="listbox" aria-label={`${ticker} asks`}>
      <div className="tr th" role="presentation">
        <span className="right">Amount</span>
        <span className="right">Unit · sats</span>
        <span className="right">Total</span>
        <span>Seller</span>
      </div>
      {error && asks.length === 0 ? (
        <div className="err">Could not load asks: {String(error.message)}</div>
      ) : asks.length === 0 ? (
        <div className="empty">{loading ? "Loading asks…" : `No open asks for ${ticker}. Holders can list under List / Split / Withdraw below.`}</div>
      ) : (
        asks.map((o) => {
          const sel = orderSelectable(o, address);
          const on = selectedId === o.id;
          const pick = () => {
            if (sel.ok) onSelect?.(on ? null : o);
          };
          return (
            <div
              key={o.id}
              className={`tr ask${on ? " on" : ""}${sel.reason === "own" ? " me" : ""}${sel.reason === "filling" ? " filling" : ""}${sel.ok ? " pickable" : ""}`}
              role="option"
              aria-selected={on}
              aria-disabled={!sel.ok}
              tabIndex={sel.ok ? 0 : -1}
              onClick={pick}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick();
                }
              }}
              title={sel.reason === "own" ? "Your own listing — manage it under List / Split / Withdraw" : sel.reason === "filling" ? `A fill of this listing is already in the mempool${o.pending_feerate !== null ? ` at ${o.pending_feerate} sat/vB` : ""} — a second one would only be rejected as a double-spend` : undefined}
            >
              <span className="num right">{fmtInt(o.amount)}</span>
              <span className="num right strong">{fmtUnit(o.unit_price)}</span>
              <span className="num right">
                {fmtBtcShort(o.price_sats)}
                {usd ? <small className="usd">{fmtUsd(o.price_sats, usd)}</small> : null}
              </span>
              <span className="mono seller" title={o.seller}>
                {address && o.seller === address ? <span className="me">you</span> : shortAddr(o.seller, 4, 4)}
                {sel.reason === "filling" && (
                  <small className="usd">
                    fill pending{o.pending_feerate !== null ? ` · ${o.pending_feerate} sat/vB` : ""}
                  </small>
                )}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
