import { useCallback, useEffect, useMemo, useRef } from "react";
import { useApp } from "../context.js";
import { useMine } from "../hooks/useMine.js";
import { useMinerLog } from "../hooks/useMinerLog.js";
import { usePoll } from "../hooks/usePoll.js";
import { droppedMessage } from "../hooks/useTxStatus.js";
import * as indexer from "../lib/indexer.js";
import { estimateMineFeeSats, inputCostSats, isP2tr } from "../lib/psbt.js";
import { missingFeeHint } from "../lib/feechoice.js";
import { PROJECT_FEE_ADDRESS, DUST_SATS, MINE_PROTOCOL_FEE_SATS } from "../lib/payloads.js";
import { fmtInt, txUrl } from "../lib/format.js";
import { syncPauseText } from "../lib/sync.js";
import { YIELD_HIGH, yieldDigit } from "../lib/yield.js";
import { activationNotice, activationState } from "../lib/activation.js";
import { deployWaitText, mineIdleReason, readyText, recentMintRate, tailWarning, waitingMineText } from "../lib/statusText.js";
import { deployDeepEnough } from "../lib/finality.js";
import { inMempoolCount, isFinished, mineButtonLabel, mineSpeedUpState, pendingMineRow } from "../lib/minePending.js";
import {
  acceptedLine,
  againAfterReorg,
  blockFoundLine,
  blockLineKey,
  broadcastingLine,
  buildLine,
  digitLine,
  errorLine,
  feeQuoteLine,
  finalLine,
  heartbeatLine,
  mempoolLine,
  reconcileLine,
  reorgLine,
  resumedLine,
  settledYoursLine,
  settlementLine,
  settlementSeenKey,
  signLine,
  speedUpMineLine,
  tipLine,
  untrackedLine,
  walletLine,
} from "../lib/minerlog.js";
import { ConnectPrompt, SpentInputs } from "./TxProgress.jsx";
import TipReadout from "./TipReadout.jsx";
import EVReadout from "./EVReadout.jsx";
import FeeSelector from "./FeeSelector.jsx";
import MinerLog from "./MinerLog.jsx";
import SpeedUpSend from "./SpeedUpSend.jsx";
import Led from "./hud/Led.jsx";

const HEARTBEAT_MS = 60_000;
const FEED_POLL_MS = 30_000;
const FEED_MAX_PER_POLL = 5;
// The settlements feed also gives the recent minting rate for the
// end-of-supply warning, so it reads a page of this size.
const FEED_LIMIT = 50;
const FEE_LOG_MIN_MS = 10 * 60_000;

/**
 * The mining console: latest block, expected yield, fee preview, the MINE
 * button, a one-line status, the list of this wallet's MINEs still in
 * flight and the MINE // LOG terminal — every event the app observes
 * (wallet, fee quotes, the tip, each phase of each MINE, other miners'
 * settlements, found blocks) and, in the same log, each settlement reveal:
 * the confirming block's hash with its last digit lit.
 *
 * The button is held only while a MINE is being assembled, signed or
 * broadcast: once broadcast it joins the pending list and another MINE can
 * be started at once.
 */
export default function MinePanel({ ticker, tokenInfo, onSettled }) {
  const { wallet, fee, fees, indexerOk, tipBlock, refreshAll, sync, chainTip } = useApp();
  // Before the activation height the indexer ignores every protocol tx, so a
  // MINE would only cost fees — lock the button and say when it opens. An
  // unknown tip counts as pre-activation (fail closed).
  const tipNow = chainTip;
  const preActivation = activationState(tipNow).locked;
  const settled = useCallback(() => {
    refreshAll();
    onSettled?.();
  }, [refreshAll, onSettled]);
  const { mine, flow, pendings, spare, startMine, resetMine, dismissMine, clearFinished, speedUp, speedUpQuote, busy } = useMine({
    wallet,
    ticker,
    tokenInfo,
    feeRateSatVb: fee.satVb,
    onSettled: settled,
    // confirmations are counted on the indexer's applied height; its node's
    // "unknown" drops nothing while it lags or has no peers
    tip: sync.indexed,
    trustUnseen: sync.trustUnseen,
    incrementalRelayFee: fees.data?.incrementalrelayfee ?? undefined,
  });
  const { lines, push, clear, meta } = useMinerLog(ticker);

  const minted = tokenInfo?.minted ?? 0;
  const supply = tokenInfo?.supply ?? 0;
  const exhausted = !!tokenInfo && minted >= supply;
  // Near the cap a MINE is credited at most what is left — and 0 when other
  // MINEs confirm first (spec §3). Said before signing.
  const remaining = tokenInfo ? Math.max(0, supply - minted) : null;
  const nearCap = !exhausted && remaining !== null && remaining < YIELD_HIGH;
  const feeRate = fee.satVb;
  // The preview counts ONE fee input; each further input the wallet needs
  // (small outputs are combined) adds `perInput`. The exact fee and inputs
  // are shown before the wallet opens.
  const feeEstimate = useMemo(() => {
    if (!feeRate || !tokenInfo) return null;
    try {
      const address = wallet.address || PROJECT_FEE_ADDRESS;
      const est = estimateMineFeeSats({ address, ticker, feeRateSatVb: feeRate });
      return { ...est, perInput: inputCostSats(isP2tr(address) ? "tr" : "wpkh", feeRate) };
    } catch {
      return null;
    }
  }, [feeRate, tokenInfo, wallet.address, ticker]);

  const connected = wallet.status === "connected";
  // While the indexer is behind the tip, `minted` (and so "supply left") is
  // older than the chain: a ticker may already be exhausted in a block it
  // has not applied, and a MINE then pays 546 + fee for 0.
  const lagText = indexerOk ? syncPauseText(sync, "mining") : null;
  // A brand-new ticker opens to mining at its DEPLOY's 2nd confirmation: a
  // MINE in the DEPLOY's block is invalid, and one a reorganization puts
  // ahead of the DEPLOY is too (fees paid for nothing).
  const deployBlock = Number.isInteger(tokenInfo?.deploy_block) ? tokenInfo.deploy_block : null;
  const deployTooNew = !!tokenInfo && !deployDeepEnough(sync.indexed, deployBlock);
  const canMine = connected && indexerOk && !lagText && !busy && !!tokenInfo && !exhausted && !preActivation && !deployTooNew && !!feeRate;
  const waiting = inMempoolCount(pendings);

  // Refs so the event effects read the latest state / tip without re-running on every change.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const pendingsRef = useRef(pendings);
  pendingsRef.current = pendings;
  const tipRef = useRef(tipBlock.data);
  tipRef.current = tipBlock.data;
  const tipNowRef = useRef(tipNow);
  tipNowRef.current = tipNow;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const tipHeight = tipBlock.data?.height ?? null;
  // Every txid this page broadcast, so the settlements feed never re-prints
  // the user's own mine as another miner's (also after Clear / Mine again).
  const ownTxidsRef = useRef(new Set());

  // (a) wallet connect / switch / disconnect — transitions only, remembered
  // per ticker (meta) so a wallet change made on another page is still
  // logged on return; the very first observation is logged only when this
  // ticker's log is still empty.
  useEffect(() => {
    const prev = meta.lastWallet;
    const cur = wallet.status === "connected" ? wallet.address : null;
    meta.lastWallet = cur;
    if (prev === undefined) {
      if (cur && lines.length === 0) push(walletLine(wallet));
      return;
    }
    if (cur !== prev) push(walletLine(wallet));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- transitions of status/address only
  }, [wallet.status, wallet.address, push]);

  // (b) fee quotes — keyed by value (a repeat quote is a no-op) AND throttled:
  // mainnet estimates drift by a few hundredths on most 30 s polls, which
  // would otherwise fill the log with fee lines. One line at most per
  // FEE_LOG_MIN_MS unless the log is still empty of fee lines.
  useEffect(() => {
    if (!fees.data) return;
    const now = Date.now();
    if (meta.lastFeeLogAt && now - meta.lastFeeLogAt < FEE_LOG_MIN_MS) return;
    const l = feeQuoteLine(fees.data, now);
    if (!l) return;
    push(l);
    meta.lastFeeLogAt = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- meta is a stable per-ticker object
  }, [fees.data, push]);

  // (c) the tip, once per ticker mount (as soon as the tip is known).
  const tipLoggedRef = useRef(null);
  useEffect(() => {
    if (tipLoggedRef.current === ticker || tipHeight === null) return;
    tipLoggedRef.current = ticker;
    push(tipLine(tipRef.current, ticker, tokenInfo));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ticker, when the tip is first known
  }, [ticker, tipHeight, push]);

  // (d) phase transitions of the MINE being assembled (build / sign / broadcast / error).
  useEffect(() => {
    const f = flowRef.current;
    switch (f.phase) {
      case "signing":
        push(buildLine(f, ticker));
        push(signLine(wallet.providerName, f.startedAt));
        break;
      case "broadcasting":
        push(broadcastingLine(f.startedAt));
        break;
      case "error":
        push(errorLine(f.error, f.startedAt));
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one line set per phase transition
  }, [flow.phase, flow.startedAt, push]);

  // (e) each MINE in the pending list, diffed by txid: accepted (or resumed)
  // → its lit confirming block + digit → the indexer's credit (✓ yours) —
  // or dropped. Several can be in flight at once; every line is keyed by
  // its txid (or its block), so the order of events never mixes them up.
  // txid → { stage: "pending" | "confirmed" | "reconciled" | "final" | "dropped", reorgs }.
  // A chain reorganization that moved a MINE (item.reorgs grew) prints its
  // line and sends the stage back to "pending", so the new block, digit and
  // credit print again — their keys carry the block hash and, after a move,
  // the move's count (againAfterReorg), so none is dropped as a repeat, not
  // even when the MINE confirms again in the very block it left.
  const loggedRef = useRef(new Map());
  useEffect(() => {
    loggedRef.current = new Map();
  }, [ticker, wallet.address]);
  useEffect(() => {
    const logged = loggedRef.current;
    const stageOf = (txid) => logged.get(txid)?.stage;
    const setStage = (txid, stage, reorgs) => logged.set(txid, { stage, reorgs: reorgs ?? logged.get(txid)?.reorgs ?? 0 });
    for (const item of pendings) {
      const was = logged.get(item.txid);
      const fromTxid = item.replaces?.length ? item.replaces[item.replaces.length - 1] : null;
      if (!was && fromTxid && logged.has(fromTxid)) {
        // A Speed up: the same MINE under a new txid.
        ownTxidsRef.current.add(item.txid);
        push(speedUpMineLine(fromTxid, item));
        setStage(item.txid, "pending", item.reorgs || 0);
      } else if (!was) {
        ownTxidsRef.current.add(item.txid);
        if (item.resumed) {
          // Picked up again after a reload / a return: one line with the
          // original broadcast time — no "accepted" / "awaiting block #tip+1"
          // claims until /tx-status has answered.
          push(resumedLine(item.txid, item.broadcastAt));
        } else {
          const tip = tipRef.current?.height ?? tipNowRef.current;
          push(acceptedLine(item.txid));
          push(mempoolLine(Number.isInteger(tip) ? tip + 1 : null, item.txid, Date.now(), { count: inMempoolCount(pendings) }));
        }
        setStage(item.txid, "pending", item.reorgs || 0);
      }
      if ((item.reorgs || 0) > (logged.get(item.txid)?.reorgs ?? 0)) {
        push(reorgLine(item, ticker));
        setStage(item.txid, "pending", item.reorgs || 0);
      }
      const stage = stageOf(item.txid);
      if (item.phase === "confirmed" && (stage === "pending" || stage === "dropped")) {
        // The lit block line is re-appended (`move`) so it sits right before
        // the digit and banner lines even when feed or heartbeat lines landed
        // after the plain "block found" print; its txs/weight come from the
        // tip poll when it already names this block, else from that plain line.
        const tip = tipRef.current;
        const prev = linesRef.current.find((l) => l.key === blockLineKey(item.blockHeight, item.blockHash));
        const stats = tip && tip.height === item.blockHeight && tip.hash === item.blockHash ? { tx_count: tip.tx_count, weight: tip.weight } : prev ? { tx_count: prev.tx_count, weight: prev.weight } : {};
        push(blockFoundLine({ height: item.blockHeight, hash: item.blockHash, ...stats }, { lit: true }), { move: true });
        push(againAfterReorg(digitLine(item.blockHash, item.yieldLocal), item.reorgs));
        setStage(item.txid, "confirmed");
      }
      // The ✓ yours banner waits for the indexer's credit: near the cap the
      // tier and the credit differ. It says "provisional"
      // until the block is final; the final line follows then.
      if (item.phase === "confirmed" && item.reconcile && item.reconcile !== "pending" && stageOf(item.txid) === "confirmed") {
        push(againAfterReorg(settledYoursLine(ticker, item), item.reorgs));
        push(againAfterReorg(reconcileLine(item), item.reorgs));
        setStage(item.txid, "reconciled");
      }
      if (item.phase === "confirmed" && item.final && stageOf(item.txid) === "reconciled") {
        push(againAfterReorg(finalLine(ticker, item), item.reorgs));
        setStage(item.txid, "final");
      }
      if (item.phase === "dropped" && stageOf(item.txid) !== "dropped") {
        push(errorLine(droppedMessage(item.txid, "MINE"), item.txid));
        setStage(item.txid, "dropped");
      }
      if (item.phase === "pending" && stageOf(item.txid) === "dropped") setStage(item.txid, "pending");
    }
  }, [pendings, ticker, push]);

  // (f) heartbeat every 60 s while any MINE waits for a block.
  useEffect(() => {
    if (waiting === 0) return undefined;
    const beat = () => {
      const tip = tipRef.current;
      const known = Number.isInteger(tip?.height) ? tip.height : tipNowRef.current;
      const next = Number.isInteger(known) ? known + 1 : null;
      const since = tip?.time ? Date.now() - tip.time * 1000 : null;
      push(heartbeatLine(next, since));
    };
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [waiting, push]);

  // (g) a new tip block — plain line, unless it confirms one of the user's
  // MINEs: that one is printed lit by (e), and when the tip poll names it
  // only afterwards, its txs/weight are filled into the lit line in place.
  const prevTipRef = useRef(null);
  useEffect(() => {
    if (tipHeight === null) return;
    const prev = prevTipRef.current;
    prevTipRef.current = tipHeight;
    if (prev === null || prev === tipHeight) return;
    const own = pendingsRef.current.find((x) => x.phase === "confirmed" && x.blockHeight === tipHeight && (!tipRef.current?.hash || x.blockHash === tipRef.current.hash));
    if (own) {
      const tip = tipRef.current;
      const existing = linesRef.current.find((l) => l.key === blockLineKey(tipHeight, own.blockHash));
      if (existing && existing.lit && !existing.post && tip && (tip.tx_count != null || tip.weight != null)) {
        push(blockFoundLine({ height: tipHeight, hash: own.blockHash, tx_count: tip.tx_count, weight: tip.weight }, { lit: true, at: existing.ts }), { replace: true });
      }
      return;
    }
    push(blockFoundLine(tipRef.current));
  }, [tipHeight, push]);

  // Leaving the page while MINEs are pending: the flow state does not travel,
  // so say so instead of leaving "awaiting block" as the last word.
  useEffect(
    () => () => {
      for (const x of pendingsRef.current) if (x.phase === "pending" && x.txid) push(untrackedLine(x.txid));
    },
    [push],
  );

  // (h) other miners' settlements for this ticker.
  const feed = usePoll((s) => indexer.minesFeed({ ticker, limit: FEED_LIMIT }, s), FEED_POLL_MS, [ticker]);
  // Near the end of the supply: MINEs already queued in the mempool may use
  // up the rest — said from the recent minting rate the feed shows.
  const mintRate = useMemo(() => recentMintRate(feed.data?.items, sync.indexed, { limit: FEED_LIMIT }), [feed.data, sync.indexed]);
  const tailText = !exhausted && !nearCap && remaining !== null ? tailWarning({ ticker, remaining, rate: mintRate }) : null;
  // Diffed by txid AND block hash: a settlement a chain reorganization moved
  // to another block is printed again, with its new block.
  const seenRef = useRef({ ticker: null, keys: new Set() });
  useEffect(() => {
    const items = feed.data?.items;
    if (!items) return;
    const seen = seenRef.current;
    if (seen.ticker !== ticker) {
      // First result after mount: seed silently so a page load does not dump history.
      seenRef.current = { ticker, keys: new Set(items.map(settlementSeenKey)) };
      return;
    }
    const own = ownTxidsRef.current;
    const fresh = items.filter((r) => !seen.keys.has(settlementSeenKey(r)));
    for (const r of items) seen.keys.add(settlementSeenKey(r));
    fresh
      .filter((r) => !own.has(r.txid))
      .slice(0, FEED_MAX_PER_POLL)
      .reverse()
      .forEach((r) => push(settlementLine(r, ticker)));
  }, [feed.data, ticker, push]);

  // Clear empties the terminal and the finished rows; MINEs still in flight keep being tracked.
  const onClear = useCallback(() => {
    clear();
    resetMine();
    clearFinished();
  }, [clear, resetMine, clearFinished]);

  const litDigit = mine.phase === "confirmed" ? yieldDigit(mine.blockHash) : null;

  return (
    <div className="action-body">
      <TipReadout tipBlock={tipBlock} ticker={ticker} remaining={remaining} />
      <EVReadout size="md" ticker={ticker} remaining={remaining} />

      <FeeSelector fee={fee} disabled={busy} />

      <div className="fee-row">
        <span>
          <span className="k">Network fee</span>
          <span className="v">{feeEstimate ? `≈ ${fmtInt(feeEstimate.feeSats)} sats` : "—"}</span>
          {feeRate ? ` @ ${feeRate} sat/vB` : null}
          {feeEstimate ? <span className="muted"> · one input; each extra input adds ≈ {fmtInt(feeEstimate.perInput)}</span> : null}
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
      {exhausted && <div className="notice">{ticker} supply is fully minted. New mines credit 0.</div>}
      {nearCap && !preActivation && (
        <div className="notice">
          Only {fmtInt(remaining)} {ticker} left. A MINE is credited at most {fmtInt(remaining)}, and 0 if other MINEs confirm first. The {MINE_PROTOCOL_FEE_SATS}-sat protocol fee and
          the network fee are paid either way.
        </div>
      )}
      {tailText && !preActivation && <div className="notice">{tailText}</div>}
      {deployTooNew && Number.isInteger(sync.indexed) && !exhausted && !preActivation && <div className="notice">{deployWaitText(ticker, deployBlock)}</div>}
      {lagText && !exhausted && !preActivation && <div className="notice">{lagText} The remaining supply shown may already be gone.</div>}
      {preActivation && <div className="notice">{activationNotice(tipNow, "Mining")}</div>}

      <button className={`mine-btn${busy ? " busy" : ""}`} type="button" onClick={startMine} disabled={!canMine} aria-busy={busy}>
        <svg className="crawl" aria-hidden="true">
          <rect width="100%" height="100%" />
        </svg>
        {mineButtonLabel(flow.phase, pendings.length)}
      </button>

      <StatusLine
        flow={flow}
        waiting={waiting}
        spare={spare}
        wallet={wallet}
        onReset={resetMine}
        indexerOk={indexerOk}
        lagText={lagText}
        fee={fee}
        feeRate={feeRate}
        exhausted={exhausted}
        preActivation={preActivation}
        ticker={ticker}
        deployBlock={deployBlock}
        deployTooNew={deployTooNew}
      />

      <PendingMines pendings={pendings} ticker={ticker} onDismiss={dismissMine} onClearFinished={clearFinished} speedUp={speedUp} speedUpQuote={speedUpQuote} fees={fees.data} />

      <MinerLog lines={lines} mine={mine} ticker={ticker} onClear={onClear} litDigit={litDigit} busy={busy || waiting > 0} clearable={!busy} />
    </div>
  );
}

/**
 * This wallet's MINEs of this ticker that are in flight or just finished,
 * one row each: waiting for a block → confirmed (digit, tier) → the
 * indexer's credit, or dropped. Hidden when there are none.
 */
function PendingMines({ pendings, ticker, onDismiss, onClearFinished, speedUp, speedUpQuote, fees }) {
  if (!pendings.length) return null;
  const waiting = inMempoolCount(pendings);
  const finished = pendings.filter(isFinished).length;
  return (
    <section className="mine-pending" aria-label={`Your ${ticker} mines`}>
      <div className="mine-pending-head">
        <span className="label">
          Your mines · {fmtInt(pendings.length)}
          {waiting ? ` · ${fmtInt(waiting)} waiting for a block` : ""}
        </span>
        {finished > 0 && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClearFinished}>
            Clear finished
          </button>
        )}
      </div>
      <ul className="mine-pending-list">
        {[...pendings].reverse().map((item) => {
          const row = pendingMineRow(item, ticker);
          return (
            <li key={item.txid} className={`mine-pending-row t-${row.tone}`}>
              <Led state={row.tone === "idle" ? "idle" : row.tone} />
              <a className="mono" href={txUrl(item.txid)} target="_blank" rel="noopener noreferrer" title={item.txid}>
                {row.tx}
              </a>
              <span className="mine-pending-text">{row.text}</span>
              {isFinished(item) && (
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => onDismiss(item.txid)} aria-label={`Dismiss ${item.txid}`}>
                  ×
                </button>
              )}
              <MineSpeedUp item={item} speedUp={speedUp} speedUpQuote={speedUpQuote} fees={fees} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Speed up for one MINE still waiting for a block: the same transaction
 * with a higher fee from its change (SpeedUpSend's controls). A MINE
 * without a change output, one whose OP_RETURN is not a LUCKY-20 MINE, or
 * one whose PSBT this browser no longer holds, says so instead.
 */
function MineSpeedUp({ item, speedUp, speedUpQuote, fees }) {
  const state = mineSpeedUpState(item);
  if (item.phase !== "pending") return null;
  if (state === "no-change") {
    return <div className="mine-pending-extra muted">No change output to take a higher fee from — it confirms when a block includes it.</div>;
  }
  if (state === "not-protocol") {
    return <div className="mine-pending-extra muted">This transaction&apos;s OP_RETURN is not a LUCKY-20 payload, so it credits nothing: its fees are spent.</div>;
  }
  if (state !== "yes") return null;
  const send = {
    chain: { phase: "pending", psbt: item.psbt, txid: item.txid, speeding: item.speeding || null, speedError: item.speedError || null },
    speedUpQuote: (rate) => speedUpQuote(item.txid, rate),
    speedUp: (rate) => speedUp(item.txid, rate),
  };
  return (
    <div className="mine-pending-extra">
      <SpeedUpSend send={send} fees={fees} note="A MINE credits only if it confirms before the supply is used up." />
    </div>
  );
}

/**
 * One-line status above the terminal: why MINE is off (or Ready), the
 * in-flight phases, and the error with its Reset.
 */
function StatusLine({ flow, waiting, spare, wallet, onReset, indexerOk, lagText, fee, feeRate, exhausted, preActivation, ticker, deployBlock, deployTooNew }) {
  let led = "idle";
  let text;
  let detail = null;
  let actions = null;

  switch (flow.phase) {
    case "building":
      led = "busy";
      text = "Building transaction — selecting fee inputs, laying out outputs.";
      if (waiting) detail = `Inputs of your ${waiting === 1 ? "MINE" : `${fmtInt(waiting)} MINEs`} still waiting for a block are left out, so this one cannot replace ${waiting === 1 ? "it" : "them"}.`;
      break;
    case "signing":
      led = "busy";
      text = `Awaiting signature — confirm in ${wallet.providerName || "your wallet"}.`;
      detail = (
        <>
          {flow.inputCount} input{flow.inputCount === 1 ? "" : "s"} · network fee <span className="mono">{fmtInt(flow.feeSats)} sats</span>
          {flow.feeRateSatVb ? ` @ ${flow.feeRateSatVb} sat/vB` : ""}
          <SpentInputs inputs={flow.inputs} />
        </>
      );
      break;
    case "broadcasting":
      led = "busy";
      text = "Broadcasting…";
      break;
    case "error":
      led = "err";
      text = flow.error || "Failed.";
      actions = (
        <button className="btn btn-sm" type="button" onClick={onReset}>
          Reset
        </button>
      );
      break;
    default: {
      const reason = mineIdleReason({ connected: wallet.status === "connected", indexerOk, preActivation, exhausted, lagText, ticker, deployBlock, deployTooNew });
      if (reason) text = reason;
      else if (!feeRate) text = missingFeeHint(fee.choice, feeRate, "mine", { awaitingAck: !!fee.highFee?.pending });
      else if (waiting) {
        led = "ok";
        text = waitingMineText(waiting, spare);
      } else text = readyText(wallet.assetSafe, "Mine");
    }
  }

  return (
    <div className="status" role="status" aria-live="polite">
      <div className="line">
        <Led state={led} />
        <span>{text}</span>
      </div>
      {detail && <div className="detail">{detail}</div>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
