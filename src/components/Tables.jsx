import { addrUrl, fmtAgo, fmtBtcShort, fmtDateUtc, fmtExpires, fmtInt, fmtUnit, fmtUsd, shortAddr, shortTxid, txUrl } from "../lib/format.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { bucketOfYield, yieldDigit } from "../lib/yield.js";
import { activityParties } from "../lib/activity.js";
import { ownPendingSpendOf, replacedOwnSpendOf } from "../lib/txrecords.js";
import { FINAL_DEPTH } from "../lib/finality.js";
import { indexerErrorText, indexerErrorTitle } from "../lib/errors.js";
import DigitChip from "./DigitChip.jsx";

export function TxLink({ txid, head = 4, tail = 4 }) {
  return (
    <a href={txUrl(txid)} target="_blank" rel="noopener noreferrer" className="mono" title={txid}>
      {shortTxid(txid, head, tail)}
    </a>
  );
}

export function AddrLink({ address, head = 5, tail = 4, self }) {
  // No address (e.g. a token registered with an empty deployer, spec §2.1): nothing to link.
  if (!address) return <span className="mono muted">—</span>;
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
        <div className="err" title={indexerErrorTitle(q.error)}>
          Could not load. {indexerErrorText(q.error)}
        </div>
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

/** A self-trade (§7.5: buyer script == seller script) — listed, but never a price or volume. */
function SelfTag() {
  return (
    <span className="status-tag s-self" title="Buyer and seller are the same script — recorded, but excluded from price, volume and the candles.">
      self
    </span>
  );
}

/**
 * Fills, newest first. `usd` (USD per BTC, or null) adds a secondary USD
 * line under each total; `self` highlights the connected address's fills
 * and, with `showTicker`, says which side it was on.
 */
export function TradesTable({ q, self, usd = null, showTicker = false, empty = "No trades yet." }) {
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
          <div className={`tr${self && (t.buyer === self || t.seller === self) ? " me" : ""}${t.self_trade ? " self-trade" : ""}`} key={t.txid} role="row">
            <span className="num" title={t.block_time ? fmtAgo(t.block_time) : ""}>
              {fmtInt(t.block_height)}
            </span>
            {showTicker ? (
              <span>
                <a href={tokenHref(t.ticker, "market")} className="mono strong">{t.ticker}</a>{" "}
                <span className="muted">{fmtInt(t.amount)}</span>
                {self && !t.self_trade && <span className={`side ${t.buyer === self ? "buy" : "sell"}`}>{t.buyer === self ? "bought" : "sold"}</span>}
                {t.self_trade && <SelfTag />}
              </span>
            ) : (
              <span className="num">
                {fmtInt(t.amount)}
                {t.self_trade && <SelfTag />}
              </span>
            )}
            <span className="num right">{fmtUnit(t.unit_price)}</span>
            <span className="num right">
              {fmtBtcShort(t.price_sats)}
              {usd ? <small className="usd">{fmtUsd(t.price_sats, usd)}</small> : null}
            </span>
            <span>
              {/* null when vout[TO_OUT] has no address form (§7.5) */}
              {t.buyer ? <AddrLink address={t.buyer} self={self} head={4} tail={4} /> : <span className="muted" title="the token output pays a script without an address form">—</span>}
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

const KIND_LABEL = { deploy: "Deploy", mine: "Mine", send: "Send", trade: "Trade" };

/**
 * The network ledger (GET /activity): date · block · kind · who · amount ·
 * tx. The "who" cell is from → to for a send, buyer ← seller for a trade,
 * the miner / deployer otherwise. `usd` adds a USD line to trade amounts.
 * `compact` (phones) drops the block column and shortens the date to MM-DD.
 */
export function ActivityTable({ q, self, usd = null, compact = false, empty = "Nothing indexed yet." }) {
  return (
    <Frame label="Activity" cols={compact ? "cols-activity-c" : "cols-activity"} q={q} empty={empty}>
      {{
        head: (
          <div className="tr th" role="row">
            <span>Date</span>
            {!compact && <span>Block</span>}
            <span>Kind</span>
            <span>Who</span>
            <span className="right">Amount</span>
            <span className="right">Tx</span>
          </div>
        ),
        // A fill is two rows with one txid (its SEND and its trade): the key is txid + kind.
        body: q.rows.map((it) => {
          const p = activityParties(it);
          const mine = self && [p.left, p.right].includes(self);
          return (
            <div className={`tr${mine ? " me" : ""}${it.applied === false ? " not-applied" : ""}`} key={`${it.kind}:${it.txid}`} role="row">
              <span className="num" title={it.block_time ? `${fmtDateUtc(it.block_time)} · ${fmtAgo(it.block_time)}` : "block time unknown"}>
                {compact ? fmtDateUtc(it.block_time).replace(/^\d{4}-/, "") : fmtDateUtc(it.block_time)}
              </span>
              {!compact && <span className="num">{fmtInt(it.block_height)}</span>}
              <span>
                <span className={`kind-tag k-${it.kind}`}>{KIND_LABEL[it.kind] || it.kind}</span>
                {it.self_trade && <SelfTag />}
                {it.applied === false && (
                  <span className="status-tag s-cancelled" title={it.kind === "mine" ? "An invalid MINE — no yield was credited." : "The indexer did not apply this SEND (amount shown is what it asked for)."}>
                    not applied
                  </span>
                )}
              </span>
              <span className="who">
                {p.left ? <AddrLink address={p.left} self={self} head={4} tail={4} /> : <span className="muted">—</span>}
                {p.join && (
                  <>
                    <span className="join" aria-label={p.join === "→" ? "to" : "from"}>{p.join}</span>
                    {p.right ? <AddrLink address={p.right} self={self} head={4} tail={4} /> : <span className="muted">—</span>}
                  </>
                )}
              </span>
              <span className="num right">
                {it.amount !== null ? (
                  <>
                    {fmtInt(it.amount)} <a href={tokenHref(it.ticker)} className="mono strong">{it.ticker}</a>
                  </>
                ) : (
                  <a href={tokenHref(it.ticker)} className="mono strong">{it.ticker}</a>
                )}
                {it.kind === "trade" && it.price_sats !== null && (
                  <small className="usd">
                    {fmtBtcShort(it.price_sats)}
                    {usd ? ` · ${fmtUsd(it.price_sats, usd)}` : ""}
                  </small>
                )}
              </span>
              <span className="right">
                <TxLink txid={it.txid} head={4} tail={3} />
              </span>
            </div>
          );
        }),
      }}
    </Frame>
  );
}

function yieldClass(row) {
  if (row.status === "invalid") return "yield y-invalid";
  const b = bucketOfYield(row.yield_smallest);
  return b ? `yield y-${b.id}` : "yield";
}

/** Yield cell: digit chip (when the block hash is known) + amount. */
/**
 * "2/6" on a mine whose block is not final yet (the indexer's `final:
 * false`): the credit is provisional — a chain reorganization can still
 * move the MINE to another block and change it.
 */
function ProvisionalTag({ r }) {
  if (r.final !== false) return null;
  const n = Number.isInteger(r.confirmations) ? Math.min(r.confirmations, FINAL_DEPTH) : null;
  return (
    <span className="status-tag s-filling" title={`provisional — final after ${FINAL_DEPTH} confirmations; until then a chain reorganization can still change this credit`}>
      {n !== null ? `${n}/${FINAL_DEPTH}` : "provisional"}
    </span>
  );
}

function YieldCell({ r }) {
  const invalid = r.status === "invalid";
  const amount = invalid ? null : r.cap_exhausted ? "0" : fmtInt(r.yield_smallest);
  const title = invalid ? "invalid mine — no yield" : `${fmtInt(r.cap_exhausted ? 0 : r.yield_smallest)} ${r.ticker}${r.final === false ? " (provisional)" : ""}`;
  const d = r.block_hash ? yieldDigit(r.block_hash) : null;
  if (!d && !invalid) {
    return (
      <span className={yieldClass(r)} title={title}>
        {amount}
        <ProvisionalTag r={r} />
      </span>
    );
  }
  return (
    <span className={yieldClass(r)} title={title}>
      <DigitChip digit={d} size="sm" invalid={invalid} ticker={r.ticker} />
      {amount !== null && <span>{amount}</span>}
      <ProvisionalTag r={r} />
    </span>
  );
}

/**
 * `compact` (phones): block · digit chip + yield · short txid — the miner
 * column is dropped (the row still highlights your own mines).
 */
export function MinesTable({ q, self, showTicker = false, empty = "No mines yet.", connectedGate, compact = false }) {
  if (compact) {
    return (
      <Frame label="Mines" cols={showTicker ? "cols-mines-ct" : "cols-mines-c"} q={q} empty={empty} connectedGate={connectedGate}>
        {{
          head: (
            <div className="tr th" role="row">
              <span>Block</span>
              {showTicker && <span>Token</span>}
              <span>Yield</span>
              <span className="right">Tx</span>
            </div>
          ),
          body: q.rows.map((r) => (
            <div className={`tr${self && r.sender === self ? " me" : ""}`} key={r.txid} role="row">
              <span className="num">{fmtInt(r.block_height)}</span>
              {showTicker && (
                <a href={tokenHref(r.ticker)} className="mono strong">{r.ticker}</a>
              )}
              <YieldCell r={r} />
              <span className="right">
                <TxLink txid={r.txid} head={4} tail={3} />
              </span>
            </div>
          )),
        }}
      </Frame>
    );
  }
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
            <YieldCell r={r} />
            <span className="right">
              <TxLink txid={r.txid} />
            </span>
          </div>
        )),
      }}
    </Frame>
  );
}

/** `compact` (phones): address · balance. */
export function HoldersTable({ q, minted, self, compact = false }) {
  if (compact) {
    return (
      <Frame label="Holders" cols="cols-holders-c" q={q} empty="No holders yet.">
        {{
          head: (
            <div className="tr th" role="row">
              <span>Address</span>
              <span className="right">Balance</span>
            </div>
          ),
          body: q.rows.map((h) => (
            <div className={`tr${self && h.address === self ? " me" : ""}`} key={h.address} role="row">
              <span>
                <AddrLink address={h.address} self={self} head={6} tail={5} />
              </span>
              <span className="num right">{fmtInt(h.balance)}</span>
            </div>
          )),
        }}
      </Frame>
    );
  }
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

const STATUS_LABEL = { open: "open", filling: "filling", filled: "filled", cancelled: "cancelled" };
const LIVE = new Set(["open", "filling"]);

/**
 * A seller's listings, every status. Live rows (`open`, `filling`) show
 * their expiry (§7.4 TTL) and take Renew (re-POST the same PSBT) /
 * Withdraw (the spec's cancel: a SEND-to-self; for a `filling` row the M-9
 * replacement rule applies — the row says which fill is pending and at
 * what rate). Closed rows link the spending tx.
 *
 * `records` = this browser's tx records for the address (txrecords.js).
 * The indexer marks a listing `filling` for ANY mempool spend of it —
 * including the seller's own withdrawal (§7.3). A row whose pending spend
 * is one of the user's own transactions says "your withdrawal is pending"
 * — and that the listing can still be bought until it confirms — and
 * offers no second Withdraw: that would only out-bid the user's own
 * transaction (audit portfolio-1). A row whose pending spend is someone
 * else's although the user's own withdrawal spent it too says the
 * withdrawal was replaced, and offers Withdraw again (it must out-bid).
 */
export function OrdersTable({ q, showTicker = false, onCancel, onRenew, busy = false, records = null, empty = "No listings from this address." }) {
  const actions = !!(onCancel || onRenew);
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
            <span className="right">{actions ? "" : "Since"}</span>
          </div>
        ),
        body: q.rows.map((o) => {
          const live = LIVE.has(o.status);
          const own = live && records ? ownPendingSpendOf(records, o.id, o.pending_spend_txid) : null;
          const replaced = !own && o.status === "filling" && records ? replacedOwnSpendOf(records, o.id, o.pending_spend_txid) : null;
          // A `filling` order is exempt from the 14-day expiry while its spend sits in the mempool.
          const expires = o.status === "open" && !own ? fmtExpires(o.expires_at) : "";
          return (
            <div className={`tr${o.status === "filling" || own ? " filling" : ""}`} key={o.id} role="row">
              {showTicker && (
                <a href={tokenHref(o.ticker, "market")} className="mono strong">{o.ticker}</a>
              )}
              <span className="num">
                {fmtInt(o.amount)}
                <small className="unit-sub">@ {fmtUnit(o.unit_price)}</small>
              </span>
              <span className="num right">{fmtUnit(o.unit_price)}</span>
              <span className="num right">{fmtBtcShort(o.price_sats)}</span>
              <span className="status-cell">
                {own ? (
                  <>
                    <span className="status-tag s-filling">withdrawing</span>
                    <small className="usd">
                      your {own.kind === "send" ? "withdrawal" : "transaction"} is pending · tx <TxLink txid={own.txid} head={4} tail={3} />
                    </small>
                    <small className="usd">until it confirms, the listing can still be bought</small>
                  </>
                ) : (
                  <span className={`status-tag s-${o.status}`}>{STATUS_LABEL[o.status] || o.status}</span>
                )}
                {o.status === "filling" && !own && (
                  <small className="usd" title={o.pending_spend_txid ? `pending spend ${o.pending_spend_txid}` : undefined}>
                    fill pending{o.pending_feerate !== null ? ` · ${o.pending_feerate} sat/vB` : ""}
                    {o.pending_fee_sats !== null ? ` · ${fmtInt(o.pending_fee_sats)} sats` : ""}
                  </small>
                )}
                {replaced && (
                  <small className="usd">your withdrawal (tx <TxLink txid={replaced.txid} head={4} tail={3} />) was replaced by this fill — if it confirms you are paid; Withdraw again to out-bid it</small>
                )}
                {expires && <small className="usd">{expires}</small>}
                {!live && o.spent_txid && (
                  <small className="usd">
                    tx <TxLink txid={o.spent_txid} head={4} tail={3} />
                  </small>
                )}
              </span>
              <span className="right row-actions">
                {actions ? (
                  own ? (
                    <span className="muted" title="Your own transaction spends this listing; it settles when that confirms.">pending</span>
                  ) : live ? (
                    <>
                      {/* a `filling` order is exempt from expiry and POST /orders answers 409 for it — nothing to renew */}
                      {onRenew && o.status === "open" && (
                        <button className="btn btn-sm" type="button" onClick={() => onRenew(o)} disabled={busy} title="Re-publish the same signed listing so it does not expire (nothing to sign)">
                          Renew
                        </button>
                      )}
                      {onCancel && (
                        <button className="btn btn-sm btn-danger" type="button" onClick={() => onCancel(o)} disabled={busy} title="Move the listed tokens to a fresh UTXO of yours (a SEND to yourself) — the only thing that voids the signed listing">
                          Withdraw
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )
                ) : (
                  <span className="muted">{fmtAgo(o.created_at)}</span>
                )}
              </span>
            </div>
          );
        }),
      }}
    </Frame>
  );
}
