import { useMemo } from "react";
import { useApp } from "../context.js";
import { useMine } from "../hooks/useMine.js";
import { estimateMineFeeSats } from "../lib/psbt.js";
import { PROJECT_FEE_ADDRESS, DUST_SATS, MINE_PROTOCOL_FEE_SATS } from "../lib/payloads.js";
import { YIELD_BASE, YIELD_MID, YIELD_HIGH, EXPECTED_YIELD, mineYield } from "../lib/yield.js";
import { fmtInt, txUrl, shortTxid, blockUrl, fmtAgo } from "../lib/format.js";
import { ConnectPrompt } from "./TxProgress.jsx";

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

/**
 * The mining console (ported from the v3 console): yield table, fee
 * preview, the MINE button and the idle→building→signing→broadcasting→
 * pending→confirmed state line with indexer reconcile.
 */
export default function MinePanel({ ticker, tokenInfo }) {
  const { wallet, fees, indexerOk, tipBlock, refreshAll } = useApp();
  const { mine, startMine, resetMine, busy } = useMine({
    wallet,
    ticker,
    tokenInfo,
    feesData: fees.data,
    onSettled: refreshAll,
  });

  const minted = tokenInfo?.minted ?? 0;
  const supply = tokenInfo?.supply ?? 0;
  const exhausted = !!tokenInfo && minted >= supply;
  const feeRate = fees.data?.halfHourFee ?? null;
  const feeEstimate = useMemo(() => {
    if (!feeRate || !tokenInfo) return null;
    try {
      return estimateMineFeeSats({ address: wallet.address || PROJECT_FEE_ADDRESS, ticker, feeRateSatVb: feeRate });
    } catch {
      return null;
    }
  }, [feeRate, tokenInfo, wallet.address, ticker]);

  const connected = wallet.status === "connected";
  const canMine = connected && indexerOk && !busy && !!tokenInfo && !exhausted;
  const tipHash = tipBlock.data?.hash || null;
  const tipYield = tipHash ? mineYield(tipHash) : null;

  return (
    <div className="action-body">
      <div className="yield-table" role="table" aria-label="Yield by last hash digit">
        <div className="yr" role="row">
          <span className="d mono">f</span>
          <span className="y y-high">{YIELD_HIGH} {ticker}</span>
          <span className="p muted">1 in 16</span>
        </div>
        <div className="yr" role="row">
          <span className="d mono">a–e</span>
          <span className="y y-mid">{YIELD_MID} {ticker}</span>
          <span className="p muted">5 in 16</span>
        </div>
        <div className="yr" role="row">
          <span className="d mono">0–9</span>
          <span className="y y-base">{YIELD_BASE} {ticker}</span>
          <span className="p muted">10 in 16</span>
        </div>
      </div>
      <p className="rule">
        Every valid mine yields. The amount is the last hex digit of the block that confirms your transaction — public,
        deterministic, and nothing is chosen by the miner. Expected yield ≈ {EXPECTED_YIELD} {ticker} per mine.
      </p>

      {tipHash && (
        <div className="tip-line">
          <span className="muted">Latest block</span>
          <a className="mono" href={blockUrl(tipBlock.data.height)} target="_blank" rel="noopener noreferrer">
            #{fmtInt(tipBlock.data.height)}
          </a>
          <span className="mono hash-tail">
            …{tipHash.slice(-7, -1)}
            <span className="digit">{tipHash.slice(-1)}</span>
          </span>
          <span className="muted">
            → {tipYield} {ticker}{tipBlock.data.time ? ` · ${fmtAgo(tipBlock.data.time)}` : ""}
          </span>
        </div>
      )}

      <div className="fee-row">
        <span>
          Network fee <span className="v">{feeEstimate ? `≈ ${fmtInt(feeEstimate.feeSats)} sats` : "—"}</span>
          {feeRate ? <span className="muted"> @ {feeRate} sat/vB</span> : null}
        </span>
        <span>
          Protocol fee <span className="v">{MINE_PROTOCOL_FEE_SATS} sats</span> · yield slot <span className="v">{DUST_SATS} sats</span>
        </span>
      </div>

      {!connected && <ConnectPrompt action="mine" />}
      {connected && wallet.error && <div className="notice">{wallet.error}</div>}
      {exhausted && <div className="notice">{ticker} supply is fully minted. New mines credit 0.</div>}

      <button className={`mine-btn${busy ? " busy" : ""}`} type="button" onClick={startMine} disabled={!canMine} aria-busy={busy}>
        {buttonLabel(mine.phase)}
      </button>

      <StatusLine mine={mine} ticker={ticker} wallet={wallet} onReset={resetMine} indexerOk={indexerOk} />
    </div>
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
          {mine.inputCount} input{mine.inputCount === 1 ? "" : "s"} · network fee <span className="mono">{fmtInt(mine.feeSats)} sats</span>
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
      else text = "Ready. Fee inputs are selected from spendable BTC only — dust and token-bearing outputs are never spent.";
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
