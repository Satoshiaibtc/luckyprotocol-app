import Identicon from "./Identicon.jsx";
import { tokenHref } from "../hooks/useHashRoute.js";

/**
 * The transfer form's state when the connected address holds none of
 * `ticker`: one line and a way on instead of a form that cannot be used.
 * On the token page's Transfer tab (`embedded`) the page header already
 * shows the token, so there is no second identicon or title.
 */
export default function TransferEmpty({ ticker, embedded = false }) {
  return (
    <div className="empty-state">
      {!embedded && <Identicon ticker={ticker} size={48} />}
      {!embedded && <h2>Transfer {ticker}</h2>}
      <p className="muted">You hold no {ticker} on this address.</p>
      <div className="empty-actions">
        {embedded ? (
          <a className="btn" href={tokenHref(ticker)}>
            Back to {ticker}
          </a>
        ) : (
          <>
            <a className="btn" href="#/me">
              ← Portfolio
            </a>
            <a className="btn" href={tokenHref(ticker)}>
              {ticker} page
            </a>
          </>
        )}
      </div>
    </div>
  );
}
