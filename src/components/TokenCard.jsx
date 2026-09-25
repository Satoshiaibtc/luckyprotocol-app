import TokenAvatar from "./TokenAvatar.jsx";
import SupplyRing from "./SupplyRing.jsx";
import { fmtCompact, fmtInt, fmtPct, shortAddr } from "../lib/format.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";

export default function TokenCard({ token, preview = false }) {
  const t = token;
  const mobile = useIsMobile();
  const href = preview ? undefined : tokenHref(t.ticker);
  const remaining = Math.max(0, (t.supply ?? 0) - (t.minted ?? 0));

  if (mobile) {
    // Phone card: identicon · ticker · by bc1… / ring · minted % · remaining / inline stats / full-width MINE.
    return (
      <article className={`card token-card token-card-m${preview ? " preview" : ""}`}>
        <a className="token-card-head" href={href} aria-label={`${t.ticker} token page`}>
          <span className="ch chamfer identicon-wrap">
            <span className="ch-in chamfer">
              <TokenAvatar ticker={t.ticker} avatarTxid={t.avatar_txid} size={44} />
            </span>
          </span>
          <div className="token-card-title">
            <h3 className="ticker">{t.ticker}</h3>
            <span className="meta">
              by <span className="mono">{shortAddr(t.deployer, 4, 4)}</span>
            </span>
          </div>
        </a>

        <div className="supply-row">
          <SupplyRing ticker={t.ticker} minted={t.minted} supply={t.supply} size={48} />
          <div className="k">
            <span className="hero-num">
              {fmtPct(t.minted, t.supply, 2)}
              <small>minted</small>
            </span>
            <span className="sub">{fmtInt(remaining)} remaining</span>
          </div>
        </div>

        <dl className="stat-row stat-inline">
          <div>
            <dt>Holders</dt>
            <dd>{fmtCompact(t.holders ?? 0)}</dd>
          </div>
          <div>
            <dt>Mines</dt>
            <dd>{fmtCompact(t.mine_count)}</dd>
          </div>
          <div>
            <dt>Since</dt>
            <dd>#{fmtInt(t.deploy_block)}</dd>
          </div>
        </dl>

        <div className="token-card-actions">
          <a className="btn btn-primary" href={preview ? undefined : tokenHref(t.ticker, "mine")} aria-disabled={preview}>
            Mine
          </a>
        </div>
      </article>
    );
  }

  return (
    <article className={`card token-card${preview ? " preview" : ""}`}>
      <a className="token-card-head" href={href} aria-label={`${t.ticker} token page`}>
        <span className="ch chamfer identicon-wrap">
          <span className="ch-in chamfer">
            <TokenAvatar ticker={t.ticker} avatarTxid={t.avatar_txid} size={48} />
          </span>
        </span>
        <div className="token-card-title">
          <h3 className="ticker">{t.ticker}</h3>
          <div className="meta">
            <span>
              deployed by <span className="mono">{shortAddr(t.deployer, 4, 4)}</span>
            </span>
            <span className="mono">block #{fmtInt(t.deploy_block)}</span>
          </div>
        </div>
      </a>

      <div className="supply-row">
        <SupplyRing ticker={t.ticker} minted={t.minted} supply={t.supply} size={56} />
        <div className="k">
          <span className="label">Remaining</span>
          <span className="hero-num">{fmtInt(remaining)}</span>
          <span className="sub">
            minted {fmtInt(t.minted)} / {fmtInt(t.supply)}
          </span>
        </div>
      </div>

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
          <dt>Since</dt>
          <dd>#{fmtInt(t.deploy_block)}</dd>
        </div>
      </dl>

      <div className="token-card-actions">
        <a className="btn btn-primary" href={preview ? undefined : tokenHref(t.ticker, "mine")} aria-disabled={preview}>
          Mine
        </a>
      </div>
    </article>
  );
}
