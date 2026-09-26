import TokenAvatar from "./TokenAvatar.jsx";
import SupplyRing from "./SupplyRing.jsx";
import { fmtCompact, fmtInt, fmtPct, fmtUnit, shortAddr } from "../lib/format.js";
import { changeSign, fmtChangePct } from "../lib/market.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";

/** Floor · last · 24h volume · 24h change, straight from the /tokens row (sats-first, "—" when unknown). */
function MarketRow({ t, inline = false }) {
  const m = t.market_24h || null;
  const sign = changeSign(m?.change_pct);
  return (
    <dl className={`stat-row market-row${inline ? " stat-inline" : ""}`} aria-label="Market">
      <div>
        <dt>Floor</dt>
        <dd title="lowest open ask, sats per token">{t.floor_unit_price !== null && t.floor_unit_price !== undefined ? fmtUnit(t.floor_unit_price) : "—"}</dd>
      </div>
      <div>
        <dt>Last</dt>
        <dd title="last fill, sats per token">{t.last_trade ? fmtUnit(t.last_trade.unit_price) : "—"}</dd>
      </div>
      <div>
        <dt>Vol 24h</dt>
        <dd title="sats filled in the last 24 h (self-trades excluded)">{m && m.volume_sats !== null ? fmtCompact(m.volume_sats) : "—"}</dd>
      </div>
      <div>
        <dt>24h</dt>
        <dd className={sign ? `delta-${sign}` : ""} title="change of the unit price over the last 24 h">{fmtChangePct(m?.change_pct)}</dd>
      </div>
    </dl>
  );
}

export default function TokenCard({ token, preview = false, avatarPreview = null }) {
  const t = token;
  const mobile = useIsMobile();
  const href = preview ? undefined : tokenHref(t.ticker);
  const remaining = Math.max(0, (t.supply ?? 0) - (t.minted ?? 0));

  if (mobile) {
    // Phone card: identicon · ticker · by bc1… / ring · minted % · remaining / inline stats / market row / MINE + MARKET.
    return (
      <article className={`card token-card token-card-m${preview ? " preview" : ""}`}>
        <a className="token-card-head" href={href} aria-label={`${t.ticker} token page`}>
          <span className="ch chamfer identicon-wrap">
            <span className="ch-in chamfer">
              {preview && avatarPreview ? <img src={avatarPreview} alt={`${t.ticker} avatar preview`} width={44} height={44} /> : <TokenAvatar ticker={t.ticker} avatarTxid={t.avatar_txid} size={44} />}
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
        <MarketRow t={t} inline />

        <div className="token-card-actions">
          <a className="btn btn-primary" href={preview ? undefined : tokenHref(t.ticker, "mine")} aria-disabled={preview}>
            Mine
          </a>
          <a className="btn" href={preview ? undefined : tokenHref(t.ticker, "market")} aria-disabled={preview}>
            Market
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
            {preview && avatarPreview ? <img src={avatarPreview} alt={`${t.ticker} avatar preview`} width={48} height={48} /> : <TokenAvatar ticker={t.ticker} avatarTxid={t.avatar_txid} size={48} />}
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
      <MarketRow t={t} />

      <div className="token-card-actions">
        <a className="btn btn-primary" href={preview ? undefined : tokenHref(t.ticker, "mine")} aria-disabled={preview}>
          Mine
        </a>
        <a className="btn" href={preview ? undefined : tokenHref(t.ticker, "market")} aria-disabled={preview}>
          Market
        </a>
      </div>
    </article>
  );
}
