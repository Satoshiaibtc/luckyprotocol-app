import { useCallback, useMemo } from "react";
import { useApp } from "../context.js";
import { useMine } from "../hooks/useMine.js";
import { estimateMineFeeSats } from "../lib/psbt.js";
import { missingFeeHint } from "../lib/feechoice.js";
import { PROJECT_FEE_ADDRESS, DUST_SATS, MINE_PROTOCOL_FEE_SATS, ACTIVATION_HEIGHT } from "../lib/payloads.js";
import { fmtInt, fmtTime, txUrl, shortTxid } from "../lib/format.js";
import { ConnectPrompt } from "./TxProgress.jsx";
import TipReadout from "./TipReadout.jsx";
import EVReadout from "./EVReadout.jsx";
import HashReveal from "./HashReveal.jsx";
import FeeSelector from "./FeeSelector.jsx";
import UtxoSafetyNotice from "./UtxoSafetyNotice.jsx";
import Led from "./hud/Led.jsx";
import RingGauge from "./hud/RingGauge.jsx";

function buttonLabel(phase) {
  switch (phase) {
    case "building":
      return "Assembling…";
    case "signing":
      return "Awaiting signature";
    case "broadcasting":
      return "Broadcasting…";
    case "pending":
      return "Awaiting block";
    case "confirmed":
      return "Mine again";
    default:
      return "Mine";
  }
}

const PHASES = ["Build", "Sign", "Broadcast", "Confirm"];

function litCount(mine) {
  switch (mine.phase) {
    case "building":
      return 1;
    case "signing":
      return 2;
    case "broadcasting":
      return 3;
    case "pending":
    case "confirmed":
      return 4;
    case "error":
      return mine.txid ? 4 : mine.inputCount != null ? 2 : 1;
    default:
      return 0;
  }
}

/**
 * The mining console: latest block, expected yield, fee preview, the MINE
 * button, the phase track and the idle→building→signing→broadcasting→
 * pending→confirmed state line with indexer reconcile.
 */
export default function MinePanel({ ticker, tokenInfo, onSettled }) {
  const { wallet, fee, indexerOk, tipBlock, refreshAll, health } = useApp();
  // Before the activation height the indexer ignores every protocol tx, so a
  // MINE would only burn fees — lock the button and say when it opens.
  const tipNow = health.data?.tip_height ?? null;
  const preActivation = tipNow !== null && tipNow < ACTIVATION_HEIGHT;
  const settled = useCallback(() => {
    refreshAll();
    onSettled?.();
  }, [refreshAll, onSettled]);
  const { mine, startMine, resetMine, busy } = useMine({
    wallet,
    ticker,
    tokenInfo,
    feeRateSatVb: fee.satVb,
    onSettled: settled,
  });

  const minted = tokenInfo?.minted ?? 0;
  const supply = tokenInfo?.supply ?? 0;
  const exhausted = !!tokenInfo && minted >= supply;
  const feeRate = fee.satVb;
  const feeEstimate = useMemo(() => {
    if (!feeRate || !tokenInfo) return null;
    try {
      return estimateMineFeeSats({ address: wallet.address || PROJECT_FEE_ADDRESS, ticker, feeRateSatVb: feeRate });
    } catch {
      return null;
    }
  }, [feeRate, tokenInfo, wallet.address, ticker]);

  const connected = wallet.status === "connected";
  const canMine = connected && indexerOk && !busy && !!tokenInfo && !exhausted && !preActivation && !!feeRate;
  const lit = litCount(mine);

  return (
    <div className="action-body">
      <TipReadout tipBlock={tipBlock} ticker={ticker} />
      <EVReadout size="md" ticker={ticker} />

      <FeeSelector fee={fee} disabled={busy} />

      <div className="fee-row">
        <span>
          <span className="k">Network fee</span>
          <span className="v">{feeEstimate ? `≈ ${fmtInt(feeEstimate.feeSats)} sats` : "—"}</span>
          {feeRate ? ` @ ${feeRate} sat/vB` : null}
        </span>
        <span>
          <span className="k">Protocol fee</span>
          <span className="v">{MINE_PROTOCOL_FEE_SATS} sats</span>
        </span>
        <span>
          <span className="k">Yield output</span>
          <span className="v">{DUST_SATS} sats</span>
        </span>
      </div>

      {!connected && <ConnectPrompt action="mine" />}
      {connected && wallet.error && <div className="notice">{wallet.error}</div>}
      <UtxoSafetyNotice />
      {exhausted && <div className="notice">{ticker} supply is fully minted. New mines credit 0.</div>}
      {preActivation && (
        <div className="notice">
          The protocol activates at block #{fmtInt(ACTIVATION_HEIGHT)} — {fmtInt(ACTIVATION_HEIGHT - tipNow)} blocks from now. Mining opens then; a
          transaction sent earlier is ignored and only costs fees.
        </div>
      )}

      <button className={`mine-btn${busy ? " busy" : ""}`} type="button" onClick={startMine} disabled={!canMine} aria-busy={busy}>
        <svg className="crawl" aria-hidden="true">
          <rect width="100%" height="100%" />
        </svg>
        {buttonLabel(mine.phase)}
      </button>

      <div className="phase-track" aria-hidden="true">
        {PHASES.map((p, i) => {
          let cls = "";
          if (i < lit) cls = mine.phase === "error" ? "fail" : mine.phase === "pending" && i === 3 ? "pulse" : "on";
          return (
            <div key={p} className={cls}>
              <span className="seg" />
              <span className="label">{p}</span>
            </div>
          );
        })}
      </div>

      <StatusLine mine={mine} ticker={ticker} wallet={wallet} onReset={resetMine} indexerOk={indexerOk} fee={fee} feeRate={feeRate} />
    </div>
  );
}

function StatusLine({ mine, ticker, wallet, onReset, indexerOk, fee, feeRate }) {
  let led = "idle";
  let text;
  let detail = null;
  let actions = null;
  let reveal = null;
  let pending = null;

  const txLink = mine.txid && (
    <a href={txUrl(mine.txid)} target="_blank" rel="noopener noreferrer" className="mono" title={mine.txid}>
      {shortTxid(mine.txid)}
    </a>
  );

  switch (mine.phase) {
    case "building":
      led = "busy";
      text = "Building transaction — selecting fee inputs, laying out outputs.";
      break;
    case "signing":
      led = "busy";
      text = `Awaiting signature — confirm in ${wallet.providerName || "your wallet"}.`;
      detail = (
        <>
          {mine.inputCount} input{mine.inputCount === 1 ? "" : "s"} · network fee <span className="mono">{fmtInt(mine.feeSats)} sats</span>
          {mine.feeRateSatVb ? ` @ ${mine.feeRateSatVb} sat/vB` : ""}
          {mine.utxoSource === "indexer" ? " · inputs from indexer (no wallet UTXO API)" : ""}
        </>
      );
      break;
    case "broadcasting":
      led = "busy";
      text = "Broadcasting…";
      break;
    case "pending":
      led = "busy";
      text = "Broadcast. Pending confirmation — checking every 15 s.";
      detail = (
        <>
          tx {txLink}
          {mine.pollError ? ` · last check failed: ${mine.pollError}` : ""}
        </>
      );
      pending = (
        <>
          <div className="stamps">
            <span>
              <span className="label">Broadcast</span>
              {mine.broadcastAt ? fmtTime(mine.broadcastAt / 1000) : "—"}
            </span>
            {mine.lastChecked ? (
              <span>
                <span className="label">Last check</span>
                {fmtTime(mine.lastChecked / 1000)}
              </span>
            ) : null}
          </div>
          <div className="copy">
            Awaiting a block. The next block&apos;s last hex digit decides the yield — there is nothing to choose: every valid mine yields.
          </div>
          <div className="placeholder" aria-hidden="true">
            — — — —
          </div>
        </>
      );
      break;
    case "confirmed":
      led = "ok";
      text = "Confirmed.";
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
      reveal = <HashReveal key={mine.txid} mine={mine} ticker={ticker} reconcileLine={detail} txLink={txLink} onReset={onReset} />;
      detail = null;
      break;
    case "error":
      led = "err";
      text = mine.error || "Failed.";
      actions = (
        <button className="btn btn-sm" type="button" onClick={onReset}>
          Reset
        </button>
      );
      break;
    default:
      if (wallet.status !== "connected") text = "Connect a wallet to mine.";
      else if (!indexerOk) text = "Indexer offline — mining paused until it is reachable.";
      else if (!feeRate) text = missingFeeHint(fee.choice, feeRate, "mine");
      else text = "Ready. Fee inputs are selected from spendable BTC only — dust and token-bearing outputs are never spent.";
  }

  if (mine.phase === "pending") {
    return (
      <div className="status" role="status" aria-live="polite">
        <div className="pending">
          <RingGauge size={72} sweeping label="NEXT" />
          <div className="pending-body">
            <div className="line">
              <Led state={led} />
              <span>{text}</span>
            </div>
            {detail && <div className="detail">{detail}</div>}
            {pending}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="status" role="status" aria-live="polite">
      <div className="line">
        <Led state={led} />
        <span>{text}</span>
      </div>
      {reveal}
      {detail && <div className="detail">{detail}</div>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
