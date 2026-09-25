import { fmtInt, shortAddr } from "../lib/format.js";

export default function BalanceCard({ address, balances, connected }) {
  const entries = Object.entries(balances.data || {}).sort((a, b) => b[1] - a[1]);

  return (
    <section className="panel" aria-labelledby="balance-label">
      <div className="panel-head">
        <span className="label" id="balance-label">
          Token balance
        </span>
        {address && (
          <span className="label mono" title={address}>
            {shortAddr(address, 5, 5)}
          </span>
        )}
      </div>
      {!connected ? (
        <div className="empty">Connect UniSat to view balances.</div>
      ) : balances.error && entries.length === 0 ? (
        <div className="err">Could not load: {String(balances.error.message)}</div>
      ) : entries.length === 0 ? (
        <div className="empty">{balances.loading ? "Loading…" : "No tokens at this address."}</div>
      ) : (
        <div>
          {entries.map(([ticker, amount]) => (
            <div className="bal-row" key={ticker}>
              <span className="t">{ticker}</span>
              <span className="a">{fmtInt(amount)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
