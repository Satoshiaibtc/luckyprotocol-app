import Identicon from "./Identicon.jsx";
import MintProgress from "./MintProgress.jsx";
import { fmtCompact, fmtBtcShort, fmtInt, fmtUnit, shortAddr } from "../lib/format.js";
import { tokenHref } from "../hooks/useHashRoute.js";

/** Implied market value = last unit price × minted, in sats. null when never traded. */
export function impliedMcapSats(token) {
  const unit = token?.last_trade?.unit_price;
  if (!Number.isFinite(unit) || !token?.minted) return null;
  return unit * token.minted;
}

export default function TokenCard({ token, preview = false }) {
  const t = token;
  const last = t.last_trade?.unit_price ?? null;
  const mcap = impliedMcapSats(t);
  const href = preview ? undefined : tokenHref(t.ticker);

  return (
    <article className={`card token-card${preview ? " preview" : ""}`}>
      <a className="token-card-head" href={href} aria-label={`${t.ticker} token page`}>
        <Identicon ticker={t.ticker} size={48} />
        <div className="token-card-title">
          <h3 className="ticker">{t.ticker}</h3>
          <div className="meta">
            <span>
              created by <span className="mono">{shortAddr(t.deployer, 4, 4)}</span>
            </span>
            <span className="mono">block #{fmtInt(t.deploy_block)}</span>
          </div>
        </div>
      </a>

      <MintProgress ticker={t.ticker} minted={t.minted} supply={t.supply} compact />

      <dl className="stat-row">
        <div>
          <dt>Holders</dt>
          <dd>{fmtCompact(t.holders ?? 0)}</dd>
        </div>
        <div>
          <dt>Mines</dt>
          <dd>{fmtCompact(t.mine_count)}</dd>
        </div>
        <div>
          <dt>Last price</dt>
          <dd>{last !== null ? <>{fmtUnit(last)} <small>sats</small></> : "—"}</dd>
        </div>
        <div>
          <dt>Mcap</dt>
          <dd>{mcap !== null ? fmtBtcShort(mcap) : "—"}</dd>
        </div>
      </dl>

      <div className="token-card-actions">
        <a className="btn btn-primary" href={preview ? undefined : tokenHref(t.ticker, "mine")} aria-disabled={preview}>
          Mine
        </a>
        <a className="btn" href={preview ? undefined : tokenHref(t.ticker, "buy")} aria-disabled={preview}>
          Trade
        </a>
      </div>
    </article>
  );
}
