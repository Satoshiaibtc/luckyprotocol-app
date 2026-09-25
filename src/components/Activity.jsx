import { useState } from "react";
import { fmtInt, shortAddr, shortTxid, txUrl } from "../lib/format.js";

function yieldClass(row) {
  if (row.status === "invalid") return "yield y-invalid";
  if (row.yield_smallest >= 500) return "yield y-500";
  if (row.yield_smallest >= 100) return "yield y-100";
  return "yield y-21";
}

function Rows({ rows, showMiner, self }) {
  return rows.map((r) => (
    <div className={`tr${self && r.sender === self ? " me" : ""}`} key={r.txid}>
      <span className="num">{fmtInt(r.block_height)}</span>
      {showMiner ? (
        <span className="mono" title={r.sender}>
          {shortAddr(r.sender, 7, 5)}
        </span>
      ) : (
        <span className="mono muted">{r.ticker}</span>
      )}
      <span className={yieldClass(r)} title={r.status === "invalid" ? "invalid mine — no yield" : `${r.yield_smallest} ${r.ticker}`}>
        {r.status === "invalid" ? "invalid" : r.cap_exhausted ? "0" : fmtInt(r.yield_smallest)}
      </span>
      <span className="right">
        <a href={txUrl(r.txid)} target="_blank" rel="noopener noreferrer" className="mono" title={r.txid}>
          {shortTxid(r.txid, 4, 4)}
        </a>
      </span>
    </div>
  ));
}

export default function Activity({ feed, mine, connected, address }) {
  const [tab, setTab] = useState("network");
  const isNet = tab === "network";
  const q = isNet ? feed : mine;
  const rows = isNet ? q.data?.items || [] : q.data || [];

  return (
    <section className="panel" aria-labelledby="activity-label">
      <div className="panel-head">
        <span className="label" id="activity-label">
          Activity
        </span>
        <div className="tabs" role="tablist" aria-label="activity source">
          <button
            className="tab"
            role="tab"
            aria-selected={isNet}
            onClick={() => setTab("network")}
            type="button"
          >
            Network
          </button>
          <button
            className="tab"
            role="tab"
            aria-selected={!isNet}
            onClick={() => setTab("mine")}
            type="button"
          >
            Mine
          </button>
        </div>
      </div>

      <div className="table" role="table">
        <div className="tr th" role="row">
          <span>Block</span>
          <span>{isNet ? "Miner" : "Ticker"}</span>
          <span className="right">Yield</span>
          <span className="right">Tx</span>
        </div>
        {!isNet && !connected ? (
          <div className="empty">Connect UniSat to see your mines.</div>
        ) : q.error && rows.length === 0 ? (
          <div className="err">Could not load: {String(q.error.message)}</div>
        ) : rows.length === 0 ? (
          <div className="empty">{q.loading ? "Loading…" : isNet ? "No mines indexed yet." : "No mines from this address yet."}</div>
        ) : (
          <Rows rows={rows} showMiner={isNet} self={address} />
        )}
      </div>
    </section>
  );
}
