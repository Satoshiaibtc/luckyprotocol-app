import { useCallback, useEffect, useMemo, useRef } from "react";
import { useApp } from "../context.js";
import { useMine } from "../hooks/useMine.js";
import { useMinerLog } from "../hooks/useMinerLog.js";
import { usePoll } from "../hooks/usePoll.js";
import * as indexer from "../lib/indexer.js";
import { estimateMineFeeSats } from "../lib/psbt.js";
import { missingFeeHint } from "../lib/feechoice.js";
import { PROJECT_FEE_ADDRESS, DUST_SATS, MINE_PROTOCOL_FEE_SATS, ACTIVATION_HEIGHT } from "../lib/payloads.js";
import { fmtInt } from "../lib/format.js";
import { yieldDigit } from "../lib/yield.js";
import {
  acceptedLine,
  blockFoundLine,
  broadcastingLine,
  buildLine,
  digitLine,
  errorLine,
  feeQuoteLine,
  heartbeatLine,
  mempoolLine,
  reconcileLine,
  settlementLine,
  signLine,
  tipLine,
  untrackedLine,
  walletLine,
  yoursLine,
} from "../lib/minerlog.js";
import { ConnectPrompt, SpentInputs } from "./TxProgress.jsx";
import TipReadout from "./TipReadout.jsx";
import EVReadout from "./EVReadout.jsx";
import FeeSelector from "./FeeSelector.jsx";
import MinerLog from "./MinerLog.jsx";
import Led from "./hud/Led.jsx";

const HEARTBEAT_MS = 60_000;
const FEED_POLL_MS = 30_000;
const FEED_MAX_PER_POLL = 5;
const FEE_LOG_MIN_MS = 10 * 60_000;

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

/**
 * The mining console: latest block, expected yield, fee preview, the MINE
 * button, a one-line status and the MINE // LOG terminal — every event the
 * app observes (wallet, fee quotes, the tip, each phase of the flow, other
 * miners' settlements, found blocks) and, in the same log, the settlement
 * reveal: the confirming block's hash with its last digit lit.
 */
export default function MinePanel({ ticker, tokenInfo, onSettled }) {
  const { wallet, fee, fees, indexerOk, tipBlock, refreshAll, health } = useApp();
  // Before the activation height the indexer ignores every protocol tx, so a
  // MINE would only cost fees — lock the button and say when it opens. An
  // unknown tip counts as pre-activation (fail closed, audit L-12).
  const tipNow = health.data?.tip_height ?? null;
  const tipUnknown = tipNow === null;
  const preActivation = tipUnknown || tipNow < ACTIVATION_HEIGHT;
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
  const { lines, push, clear, meta } = useMinerLog(ticker);

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

  // Refs so the event effects read the latest mine / tip without re-running on every change.
  const mineRef = useRef(mine);
  mineRef.current = mine;
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

  // (d) + (g) + (h) phase transitions of the user's own mine.
  useEffect(() => {
    const m = mineRef.current;
    switch (m.phase) {
      case "signing":
        push(buildLine(m, ticker));
        push(signLine(wallet.providerName, m.startedAt));
        break;
      case "broadcasting":
        push(broadcastingLine(m.startedAt));
        break;
      case "pending": {
        const tip = tipRef.current?.height ?? tipNowRef.current;
        ownTxidsRef.current.add(m.txid);
        push(acceptedLine(m.txid));
        push(mempoolLine(Number.isInteger(tip) ? tip + 1 : null, m.txid));
        break;
      }
      case "confirmed": {
        // The lit block line is re-appended (`move`) so it sits right before
        // the digit and banner lines even when feed or heartbeat lines landed
        // after the plain "block found" print; its txs/weight come from the
        // tip poll when it already names this block, else from that plain line.
        const tip = tipRef.current;
        const prev = linesRef.current.find((l) => l.key === `block:${m.blockHeight}`);
        const stats = tip && tip.height === m.blockHeight ? { tx_count: tip.tx_count, weight: tip.weight } : prev ? { tx_count: prev.tx_count, weight: prev.weight } : {};
        push(blockFoundLine({ height: m.blockHeight, hash: m.blockHash, ...stats }, { lit: true }), { move: true });
        push(digitLine(m.blockHash, m.yieldLocal));
        push(yoursLine(ticker, m.blockHeight, m.yieldLocal, m.txid));
        break;
      }
      case "error":
        push(errorLine(m.error, m.startedAt ?? m.txid));
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one line set per phase transition
  }, [mine.phase, mine.txid, mine.startedAt, push]);

  // (g) the indexer's verdict once reconcile leaves "pending".
  useEffect(() => {
    if (mine.phase !== "confirmed") return;
    push(reconcileLine(mine));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires when reconcile / indexed change
  }, [mine.phase, mine.reconcile, mine.indexed, push]);

  // (e) heartbeat every 60 s while pending.
  useEffect(() => {
    if (mine.phase !== "pending") return undefined;
    const beat = () => {
      const tip = tipRef.current;
      const known = Number.isInteger(tip?.height) ? tip.height : tipNowRef.current;
      const next = Number.isInteger(known) ? known + 1 : null;
      const since = tip?.time ? Date.now() - tip.time * 1000 : null;
      push(heartbeatLine(next, since));
    };
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [mine.phase, push]);

  // (f) a new tip block — plain line, unless it is the user's confirming
  // block: that one is printed lit by (g), and when the tip poll names it
  // only afterwards, its txs/weight are filled into the lit line in place.
  const prevTipRef = useRef(null);
  useEffect(() => {
    if (tipHeight === null) return;
    const prev = prevTipRef.current;
    prevTipRef.current = tipHeight;
    if (prev === null || prev === tipHeight) return;
    const m = mineRef.current;
    if (m.phase === "confirmed" && m.blockHeight === tipHeight) {
      const tip = tipRef.current;
      const existing = linesRef.current.find((l) => l.key === `block:${tipHeight}`);
      if (existing && existing.lit && !existing.post && tip && (tip.tx_count != null || tip.weight != null)) {
        push(blockFoundLine({ height: tipHeight, hash: m.blockHash, tx_count: tip.tx_count, weight: tip.weight }, { lit: true, at: existing.ts }), { replace: true });
      }
      return;
    }
    push(blockFoundLine(tipRef.current));
  }, [tipHeight, push]);

  // Leaving the page while a mine is pending: the flow state does not travel,
  // so say so instead of leaving "awaiting block" as the last word.
  useEffect(
    () => () => {
      const m = mineRef.current;
      if (m.phase === "pending" && m.txid) push(untrackedLine(m.txid));
    },
    [push],
  );

  // (i) other miners' settlements for this ticker, diffed by txid.
  const feed = usePoll((s) => indexer.minesFeed({ ticker, limit: 10 }, s), FEED_POLL_MS, [ticker]);
  const seenRef = useRef({ ticker: null, txids: new Set() });
  useEffect(() => {
    const items = feed.data?.items;
    if (!items) return;
    const seen = seenRef.current;
    if (seen.ticker !== ticker) {
      // First result after mount: seed silently so a page load does not dump history.
      seenRef.current = { ticker, txids: new Set(items.map((r) => r.txid)) };
      return;
    }
    const own = ownTxidsRef.current;
    const fresh = items.filter((r) => !seen.txids.has(r.txid));
    for (const r of items) seen.txids.add(r.txid);
    fresh
      .filter((r) => !own.has(r.txid))
      .slice(0, FEED_MAX_PER_POLL)
      .reverse()
      .forEach((r) => push(settlementLine(r, ticker)));
  }, [feed.data, ticker, push]);

  const onClear = useCallback(() => {
    clear();
    if (mine.phase === "confirmed" || mine.phase === "error") resetMine();
  }, [clear, mine.phase, resetMine]);

  const litDigit = mine.phase === "confirmed" ? yieldDigit(mine.blockHash) : null;

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
      {exhausted && <div className="notice">{ticker} supply is fully minted. New mines credit 0.</div>}
      {preActivation && (
        <div className="notice">
          {tipUnknown
            ? `The indexer has not reported the chain tip yet, so it cannot be confirmed that block #${fmtInt(ACTIVATION_HEIGHT)} has been reached. Mining stays locked until it does — a transaction sent before activation is ignored and only costs fees.`
            : `The protocol activates at block #${fmtInt(ACTIVATION_HEIGHT)} — ${fmtInt(ACTIVATION_HEIGHT - tipNow)} blocks from now. Mining opens then; a transaction sent earlier is ignored and only costs fees.`}
        </div>
      )}

      <button className={`mine-btn${busy ? " busy" : ""}`} type="button" onClick={startMine} disabled={!canMine} aria-busy={busy}>
        <svg className="crawl" aria-hidden="true">
          <rect width="100%" height="100%" />
        </svg>
        {buttonLabel(mine.phase)}
      </button>

      <StatusLine mine={mine} wallet={wallet} onReset={resetMine} indexerOk={indexerOk} fee={fee} feeRate={feeRate} />

      <MinerLog lines={lines} mine={mine} ticker={ticker} onClear={onClear} litDigit={litDigit} />
    </div>
  );
}

/** One-line status above the terminal: idle hints, the in-flight phases, and the error with its Reset. */
function StatusLine({ mine, wallet, onReset, indexerOk, fee, feeRate }) {
  let led = "idle";
  let text;
  let detail = null;
  let actions = null;

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
          <SpentInputs inputs={mine.inputs} assetSafe={mine.assetSafe} />
        </>
      );
      break;
    case "broadcasting":
      led = "busy";
      text = "Broadcasting…";
      break;
    case "pending":
    case "confirmed":
      // The terminal below is the status for these phases.
      return null;
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
