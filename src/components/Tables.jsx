import { addrUrl, fmtAgo, fmtBtcShort, fmtInt, fmtUnit, shortAddr, shortTxid, txUrl } from "../lib/format.js";
import { tokenHref } from "../hooks/useHashRoute.js";

export function TxLink({ txid, head = 4, tail = 4 }) {
  return (
    <a href={txUrl(txid)} target="_blank" rel="noopener noreferrer" className="mono" title={txid}>
      {shortTxid(txid, head, tail)}
    </a>
  );
}

export function AddrLink({ address, head = 5, tail = 4, self }) {
  return (
    <a href={addrUrl(address)} target="_blank" rel="noopener noreferrer" className={`mono${self && self === address ? " me" : ""}`} title={address}>
      {self && self === address ? "you" : shortAddr(address, head, tail)}
    </a>
  );
}

function Frame({ label, cols, children, q, empty, connectedGate }) {
  const rows = q.rows;
  return (
    <div className={`table ${cols}`} role="table" aria-label={label}>
      {children.head}
      {connectedGate ? (
        <div className="empty">{connectedGate}</div>
      ) : q.error && rows.length === 0 ? (
        <div className="err">Could not load: {String(q.error.message)}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{q.loading ? "Loading…" : empty}</div>
      ) : (
        children.body
      )}
      {q.hasMore && rows.length > 0 && (
        <div className="table-more">
          <button className="btn btn-sm" type="button" onClick={q.loadMore} disabled={q.loading}>
            {q.loading ? "Loading…" : `Load more (${fmtInt(q.total - rows.length)} left)`}
          </button>
        </div>
      )}
    </div>
  );
}

export function TradesTable({ q, self, showTicker = false, empty = "No trades yet." }) {
  return (
    <Frame label="Trades" cols="cols-trades" q={q} empty={empty}>
      {{
        head: (
          <div className="tr th" role="row">
            <span>Block</span>
            <span>{showTicker ? "Token" : "Amount"}</span>
            <span className="right">Unit</span>
            <span className="right">Total</span>
            <span>Buyer</span>
            <span className="right">Tx</span>
          </div>
        ),
        body: q.rows.map((t) => (
          <div className={`tr${self && (t.buyer === self || t.seller === self) ? " me" : ""}`} key={t.txid} role="row">
            <span className="num" title={t.block_time ? fmtAgo(t.block_time) : ""}>
              {fmtInt(t.block_height)}
            </span>
            {showTicker ? (
              <span>
                <a href={tokenHref(t.ticker)} className="mono strong">{t.ticker}</a>{" "}
                <span className="muted">{fmtInt(t.amount)}</span>
                {self && <span className={`side ${t.buyer === self ? "buy" : "sell"}`}>{t.buyer === self ? "bought" : "sold"}</span>}
              </span>
            ) : (
              <span className="num">{fmtInt(t.amount)}</span>
            )}
            <span className="num right">{fmtUnit(t.unit_price)}</span>
            <span className="num right">{fmtBtcShort(t.price_sats)}</span>
            <span>
              <AddrLink address={t.buyer} self={self} head={4} tail={4} />
            </span>
            <span className="right">
              <TxLink txid={t.txid} />
            </span>
          </div>
        )),
      }}
    </Frame>
  );
}

function yieldClass(row) {
  if (row.status === "invalid") return "yield y-invalid";
  if (row.yield_smallest >= 1000) return "yield y-high";
  if (row.yield_smallest >= 500) return "yield y-mid";
  return "yield y-base";
}

export function MinesTable({ q, self, showTicker = false, empty = "No mines yet.", connectedGate }) {
  return (
    <Frame label="Mines" cols="cols-mines" q={q} empty={empty} connectedGate={connectedGate}>
      {{
        head: (
          <div className="tr th" role="row">
            <span>Block</span>
            <span>{showTicker ? "Token" : "Miner"}</span>
            <span className="right">Yield</span>
            <span className="right">Tx</span>
          </div>
        ),
        body: q.rows.map((r) => (
          <div className={`tr${self && r.sender === self ? " me" : ""}`} key={r.txid} role="row">
            <span className="num">{fmtInt(r.block_height)}</span>
            {showTicker ? (
              <a href={tokenHref(r.ticker)} className="mono strong">{r.ticker}</a>
            ) : (
              <span>
                <AddrLink address={r.sender} self={self} head={5} tail={4} />
              </span>
            )}
            <span className={yieldClass(r)} title={r.status === "invalid" ? "invalid mine — no yield" : `${r.yield_smallest} ${r.ticker}`}>
              {r.status === "invalid" ? "invalid" : r.cap_exhausted ? "0" : fmtInt(r.yield_smallest)}
            </span>
            <span className="right">
              <TxLink txid={r.txid} />
            </span>
          </div>
        )),
      }}
    </Frame>
  );
}

export function HoldersTable({ q, minted, self }) {
  return (
    <Frame label="Holders" cols="cols-holders" q={q} empty="No holders yet.">
      {{
        head: (
          <div className="tr th" role="row">
            <span>#</span>
            <span>Address</span>
            <span className="right">Balance</span>
            <span className="right">Share</span>
          </div>
        ),
        body: q.rows.map((h, i) => (
          <div className={`tr${self && h.address === self ? " me" : ""}`} key={h.address} role="row">
            <span className="num muted">{i + 1}</span>
            <span>
              <AddrLink address={h.address} self={self} head={6} tail={5} />
            </span>
            <span className="num right">{fmtInt(h.balance)}</span>
            <span className="num right muted">{minted ? `${((100 * h.balance) / minted).toFixed(2)}%` : "—"}</span>
          </div>
        )),
      }}
    </Frame>
  );
}

const STATUS_LABEL = { open: "open", filled: "filled", cancelled: "cancelled" };

export function OrdersTable({ q, showTicker = false, onCancel, cancelling, empty = "No listings from this address." }) {
  return (
    <Frame label="Listings" cols={showTicker ? "cols-orders-t" : "cols-orders"} q={q} empty={empty}>
      {{
        head: (
          <div className="tr th" role="row">
            {showTicker && <span>Token</span>}
            <span>Amount</span>
            <span className="right">Unit</span>
            <span className="right">Total</span>
            <span>Status</span>
            <span className="right">{onCancel ? "" : "Since"}</span>
          </div>
        ),
        body: q.rows.map((o) => (
          <div className="tr" key={o.id} role="row">
            {showTicker && (
              <a href={tokenHref(o.ticker, "sell")} className="mono strong">{o.ticker}</a>
            )}
            <span className="num">{fmtInt(o.amount)}</span>
            <span className="num right">{fmtUnit(o.unit_price)}</span>
            <span className="num right">{fmtBtcShort(o.price_sats)}</span>
            <span>
              <span className={`status-tag s-${o.status}`}>{STATUS_LABEL[o.status] || o.status}</span>
              {o.status !== "open" && o.spent_txid && (
                <>
                  {" "}
                  <TxLink txid={o.spent_txid} head={4} tail={3} />
                </>
              )}
            </span>
            <span className="right">
              {onCancel ? (
                o.status === "open" ? (
                  <button className="btn btn-sm btn-danger" type="button" onClick={() => onCancel(o)} disabled={!!cancelling}>
                    Cancel on-chain
                  </button>
                ) : (
                  <span className="muted">—</span>
                )
              ) : (
                <span className="muted">{fmtAgo(o.created_at)}</span>
              )}
            </span>
          </div>
        )),
      }}
    </Frame>
  );
}
