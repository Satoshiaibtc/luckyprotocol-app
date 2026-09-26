import { useMemo, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { usePaged } from "../hooks/usePaged.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import { DAILY_DAYS, KINDS, dailySeries, fillDays, isSearchableAddress } from "../lib/activity.js";
import { fmtAgo, fmtBtcShort, fmtCompact, fmtInt, fmtUsd, shortAddr } from "../lib/format.js";
import Panel from "../components/hud/Panel.jsx";
import { ledFromPoll } from "../components/hud/Led.jsx";
import DailyChart from "../components/DailyChart.jsx";
import { ActivityTable } from "../components/Tables.jsx";

const POLL_MS = 60_000;

/**
 * #/activity — the network ledger: header (as of tip, 30-day totals), the
 * daily chart (one metric at a time, bars + cumulative line), then the
 * paginated ledger filtered by kind and, optionally, by one bc1 address.
 */
export default function ActivityPage() {
  const { health, address, price } = useApp();
  const mobile = useIsMobile();
  const usd = price.data?.usd_per_btc ?? null;
  const [metric, setMetric] = useState("events");
  const [kind, setKind] = useState("all");
  const [addrText, setAddrText] = useState("");
  const [addrFilter, setAddrFilter] = useState("");

  const dailyQ = usePoll((s) => indexer.activityDaily(DAILY_DAYS, s), POLL_MS, []);
  // The zero-filled 30-day window exists only once the indexer has answered:
  // before that (first load, or an error with nothing cached) `rows` is null
  // so the chart shows its Loading… / error text instead of a flat zero chart.
  const rows = useMemo(() => (dailyQ.data ? fillDays(dailyQ.data.days || [], DAILY_DAYS, Math.floor(Date.now() / 1000)) : null), [dailyQ.data]);
  const totals = useMemo(() => {
    const has = !!rows;
    const sum = (k) => (has ? dailySeries(rows, k).total : null);
    return { events: sum("events"), sends: sum("sends"), volume: sum("volume_sats"), peakAddresses: has ? dailySeries(rows, "active_addresses").max : null, days: has ? rows.filter((r) => r.events > 0).length : null };
  }, [rows]);

  const ledger = usePaged((offset, limit, s) => indexer.activity({ offset, limit, kind, address: addrFilter || undefined }, s), { limit: 50, deps: [kind, addrFilter], refreshMs: 60_000 });

  const addrValid = addrText.trim() === "" || isSearchableAddress(addrText);
  const submitAddr = (e) => {
    e.preventDefault();
    const t = addrText.trim();
    if (t === "") setAddrFilter("");
    else if (isSearchableAddress(t)) setAddrFilter(t);
  };
  const tip = health.data?.tip_height ?? null;

  return (
    <main className="page activity-page">
      <header className="token-head">
        <div className="token-head-main">
          <h1 className="ticker">Activity</h1>
          <div className="meta">
            <span>
              {tip ? (
                <>
                  as of block <span className="mono">#{fmtInt(tip)}</span>
                  {health.data?.last_progress_at ? <span className="muted"> · indexed {fmtAgo(health.data.last_progress_at)}</span> : null}
                </>
              ) : health.error ? (
                <span className="err">indexer offline</span>
              ) : (
                "connecting…"
              )}
            </span>
            <span className="muted">every DEPLOY, MINE, SEND and fill the indexer has applied · a fill is a SEND and a trade</span>
          </div>
        </div>
      </header>

      <dl className="stats stats-4 activity-stats">
        <div>
          <dt>Events · 30d</dt>
          <dd>{totals.events !== null ? fmtCompact(totals.events) : "—"}</dd>
          <span className="sub">{totals.days !== null ? `${fmtInt(totals.days)} active day${totals.days === 1 ? "" : "s"}` : ""}</span>
        </div>
        <div>
          <dt>Sends · 30d</dt>
          <dd>{totals.sends !== null ? fmtCompact(totals.sends) : "—"}</dd>
        </div>
        <div>
          <dt>Peak addresses / day</dt>
          <dd>{totals.peakAddresses !== null ? fmtCompact(totals.peakAddresses) : "—"}</dd>
        </div>
        <div>
          <dt>Volume · 30d</dt>
          <dd>{totals.volume !== null ? fmtCompact(totals.volume) : "—"}</dd>
          <span className="sub">{totals.volume ? `${fmtBtcShort(totals.volume)}${usd ? ` · ${fmtUsd(totals.volume, usd)}` : ""}` : "sats"}</span>
        </div>
      </dl>

      <Panel title="Daily · last 30 days (UTC)" led={ledFromPoll(dailyQ)} aria-label="Daily activity chart">
        <DailyChart rows={rows} metric={metric} onMetric={setMetric} usd={usd} loading={dailyQ.loading} error={dailyQ.error} />
      </Panel>

      <Panel title="Ledger" led={ledger.error ? "err" : ledger.loading && ledger.rows.length === 0 ? "busy" : "ok"} right={<span className="label">{fmtInt(ledger.total)} total</span>} aria-label="Activity ledger">
        <div className="board-controls">
          <div className="chips" role="tablist" aria-label="Kind">
            {KINDS.map((k) => (
              <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} className={`chip${kind === k.id ? " active" : ""}`} onClick={() => setKind(k.id)}>
                {k.label}
              </button>
            ))}
          </div>
          <form className="board-search addr-search" role="search" onSubmit={submitAddr}>
            <input
              className={`input mono${addrValid ? "" : " invalid"}`}
              type="search"
              placeholder="bc1… address"
              aria-label="Filter by address — Enter applies"
              aria-invalid={!addrValid}
              enterKeyHint="search"
              value={addrText}
              onChange={(e) => setAddrText(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={90}
            />
            {address && !addrFilter && (
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setAddrText(address); setAddrFilter(address); }}>
                Mine
              </button>
            )}
            {addrFilter && (
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setAddrText(""); setAddrFilter(""); }}>
                Clear
              </button>
            )}
          </form>
        </div>
        {!addrValid && <div className="err">Enter a mainnet bc1q… / bc1p… address.</div>}
        {addrFilter && (
          <div className="notice">
            Showing rows where <span className="mono">{shortAddr(addrFilter, 8, 6)}</span> is a party.
          </div>
        )}
        <ActivityTable q={ledger} self={address} usd={usd} compact={mobile} empty={addrFilter ? "No activity for this address." : kind === "all" ? "Nothing indexed yet." : `No ${kind} rows yet.`} />
      </Panel>
    </main>
  );
}
