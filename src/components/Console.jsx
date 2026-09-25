import { fmtInt, fmtPct, txUrl, shortTxid, UNISAT_INSTALL_URL } from "../lib/format.js";
import { REQUIRED_TOKEN_SUPPLY, DUST_SATS, MINE_PROTOCOL_FEE_SATS } from "../lib/payloads.js";
import { YIELD_BASE, YIELD_MID, YIELD_HIGH } from "../lib/yield.js";

const BUSY = new Set(["building", "signing", "broadcasting", "pending"]);

function buttonLabel(phase) {
  switch (phase) {
    case "building":
      return "Building…";
    case "signing":
      return "Awaiting signature";
    case "broadcasting":
      return "Broadcasting…";
    case "pending":
      return "Pending confirmation";
    case "confirmed":
      return "Mine again";
    default:
      return "Mine";
  }
}

export default function Console({
  tokens,
  ticker,
  onTicker,
  tokenInfo,
  feeRate,
  feeEstimate,
  mine,
  onMine,
  onReset,
  wallet,
  mock,
  indexerOk,
}) {
  const minted = tokenInfo?.minted ?? 0;
  const supply = tokenInfo?.supply ?? REQUIRED_TOKEN_SUPPLY;
  const pct = supply ? Math.min(100, (100 * minted) / supply) : 0;
  const exhausted = tokenInfo && minted >= supply;

  const connected = wallet.status === "connected";
  const busy = BUSY.has(mine.phase);
  const canMine = connected && indexerOk && !busy && !!tokenInfo && !exhausted;

  return (
    <section className="panel" aria-labelledby="console-label">
      <div className="panel-head">
        <span className="label" id="console-label">
          Mining console
        </span>
        <span className="label">{mock ? "simulation" : "mainnet"}</span>
      </div>

      <div className="console-row">
        <label className="muted" htmlFor="ticker-select">
          Ticker
        </label>
        <select
          id="ticker-select"
          className="select"
          value={ticker}
          onChange={(e) => onTicker(e.target.value)}
          disabled={busy || tokens.length === 0}
        >
          {tokens.length === 0 && <option value={ticker}>{ticker}</option>}
          {tokens.map((t) => (
            <option key={t.ticker} value={t.ticker}>
              {t.ticker}
            </option>
          ))}
        </select>
      </div>

      <div className="supply">
        <div className="nums">
          <span>
            <span className="big">{fmtInt(minted)}</span> <span className="of">/ {fmtInt(supply)} minted</span>
          </span>
          <span className="of">{fmtPct(minted, supply)}</span>
        </div>
        <div
          className="bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={supply}
          aria-valuenow={minted}
          aria-label={`${ticker} supply minted`}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>

      <p className="rule">
        Each mine yields <strong>{YIELD_BASE}</strong>, <strong>{YIELD_MID}</strong> or{" "}
        <strong>{YIELD_HIGH} {ticker}</strong> depending on the confirming block&apos;s last hash
        digit: <strong>0–9</strong> → {YIELD_BASE}, <strong>a–e</strong> → {YIELD_MID},{" "}
        <strong>f</strong> → {YIELD_HIGH}. Every valid mine yields; nothing is chosen by the
        miner.
      </p>

      <div className="fee-row">
        <span>
          Miner fee{" "}
          <span className="v">
            {feeEstimate ? `≈ ${fmtInt(feeEstimate.feeSats)} sats` : "—"}
          </span>{" "}
          {feeRate ? `@ ${feeRate} sat/vB` : ""}
        </span>
        <span>
          Protocol fee <span className="v">{MINE_PROTOCOL_FEE_SATS} sats</span> · yield slot{" "}
          <span className="v">{DUST_SATS} sats</span>
        </span>
      </div>

      {wallet.status === "absent" && (
        <div className="cta">
          <div>
            The UniSat browser extension is required to sign mining transactions. LuckyProtocol never
            holds keys.
          </div>
          <div className="row">
            <a className="btn btn-primary btn-sm" href={UNISAT_INSTALL_URL} target="_blank" rel="noopener noreferrer">
              Install UniSat
            </a>
          </div>
        </div>
      )}

      {wallet.error && <div className="notice">{wallet.error}</div>}

      {exhausted && <div className="notice">{ticker} supply is fully minted. New mines credit 0.</div>}

      <button
        className={`mine-btn${busy ? " busy" : ""}`}
        type="button"
        onClick={onMine}
        disabled={!canMine}
        aria-busy={busy}
      >
        {buttonLabel(mine.phase)}
      </button>

      <StatusLine mine={mine} ticker={ticker} wallet={wallet} onReset={onReset} indexerOk={indexerOk} />
    </section>
  );
}

function StatusLine({ mine, ticker, wallet, onReset, indexerOk }) {
  let cls = "status";
  let text;
  let detail = null;
  let result = null;
  let actions = null;

  const txLink = mine.txid && (
    <a href={txUrl(mine.txid)} target="_blank" rel="noopener noreferrer" className="mono" title={mine.txid}>
      {shortTxid(mine.txid)}
    </a>
  );

  switch (mine.phase) {
    case "building":
      cls += " s-busy";
      text = "Building transaction — selecting fee inputs, laying out outputs.";
      break;
    case "signing":
      cls += " s-busy";
      text = "Awaiting signature — confirm in the UniSat popup.";
      detail = (
        <>
          {mine.inputCount} input{mine.inputCount === 1 ? "" : "s"} · miner fee{" "}
          <span className="mono">{fmtInt(mine.feeSats)} sats</span>
          {mine.utxoSource === "indexer" ? " · inputs from indexer (UniSat UTXO API unavailable)" : ""}
        </>
      );
      break;
    case "broadcasting":
      cls += " s-busy";
      text = "Broadcasting…";
      break;
    case "pending":
      cls += " s-busy";
      text = "Broadcast. Pending confirmation — checking every 15 s.";
      detail = (
        <>
          tx {txLink}
          {mine.pollError ? ` · last check failed: ${mine.pollError}` : ""}
        </>
      );
      break;
    case "confirmed":
      cls += " s-ok";
      text = "Confirmed.";
      result = (
        <>
          Block {fmtInt(mine.blockHeight)} · yield{" "}
          <span className="y">
            {mine.yieldLocal} {ticker}
          </span>
        </>
      );
      detail = (
        <>
          tx {txLink} · hash …<span className="mono">{mine.blockHash?.slice(-8)}</span> ·{" "}
          {mine.reconcile === "done" && mine.indexed
            ? mine.indexed.status === "invalid"
              ? "indexer: invalid mine (0 credited)"
              : mine.indexed.cap_exhausted
                ? "indexer: settled, supply exhausted (0 credited)"
                : `indexer: settled, ${fmtInt(mine.indexed.yield_smallest)} ${mine.indexed.ticker} credited`
            : mine.reconcile === "timeout"
              ? "indexer has not indexed this mine yet"
              : "reconciling with indexer…"}
          {mine.reconcile === "done" && mine.indexed && mine.indexed.status !== "invalid" && mine.indexed.yield_smallest !== mine.yieldLocal
            ? " · local yield differs from indexer — indexer is authoritative"
            : ""}
        </>
      );
      actions = (
        <button className="btn btn-sm" type="button" onClick={onReset}>
          Clear
        </button>
      );
      break;
    case "error":
      cls += " s-err";
      text = mine.error || "Failed.";
      actions = (
        <button className="btn btn-sm" type="button" onClick={onReset}>
          Reset
        </button>
      );
      break;
    default:
      if (wallet.status !== "connected") text = "Connect UniSat to mine.";
      else if (!indexerOk) text = "Indexer offline — mining paused until it is reachable.";
      else
        text =
          "Ready. Fee inputs are selected from spendable BTC only — dust and token-bearing outputs are never spent.";
  }

  return (
    <div className={cls} role="status" aria-live="polite">
      <div className="line">
        <span className="dot" aria-hidden="true" />
        <span>{text}</span>
      </div>
      {result && <div className="result">{result}</div>}
      {detail && <div className="detail">{detail}</div>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
