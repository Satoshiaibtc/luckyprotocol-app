import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { friendlyError } from "../hooks/useWallet.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useDeployLog } from "../hooks/useMinerLog.js";
import { useFeeRate } from "../hooks/useFeeRate.js";
import { useCommitReveal } from "../hooks/useCommitReveal.js";
import { MAX_FEE_RATE_SAT_VB, estimateCommitFeeSats, estimateRevealFeeSats, speedUpFloorRate } from "../lib/psbt.js";
import { refreshTxRecords, txRecords } from "../lib/txrecords.js";
import { syncPauseText } from "../lib/sync.js";
import { clampCustomFee, missingFeeHint, needsHighFeeAck } from "../lib/feechoice.js";
import { DEPLOY_PROTOCOL_FEE_SATS, DUST_SATS, PROJECT_FEE_ADDRESS, REQUIRED_TOKEN_SUPPLY, TICKER_RE } from "../lib/payloads.js";
import { activationNotice, activationState, lockedHint } from "../lib/activation.js";
import {
  DEAD_END_PHASES,
  EXPIRY_WARN_BLOCKS,
  PUBLISH_CUTOFF_BLOCKS,
  PUBLISH_MIN_CONFIRMATIONS,
  commitStatusText,
  expiryText,
  invalidReasonText,
  publishMissedBlock,
  revealReasonText,
  rowConfirmations,
} from "../lib/commitReveal.js";
import { FINAL_DEPTH, confirmationsAt, confirmationsText } from "../lib/finality.js";
import { cleanTickerInput, cleanedCaret } from "../lib/tickerInput.js";
import { readyText } from "../lib/statusText.js";
import { BUCKETS, EXPECTED_YIELD } from "../lib/yield.js";
import { blockUrl, fmtDec, fmtInt, fmtSats, shortTxid, txUrl } from "../lib/format.js";
import { blockLineKey } from "../lib/minerlog.js";
import { DEPLOY_PHASES, blockFoundLine, deployHeartbeatLine, deployUntrackedLine, deployedLine, feeQuoteLine, registrationLine, tipLine, walletLine } from "../lib/deploylog.js";
import TokenCard from "../components/TokenCard.jsx";
import { ConnectPrompt, SpentInputs } from "../components/TxProgress.jsx";
import FeeSelector from "../components/FeeSelector.jsx";
import Panel from "../components/hud/Panel.jsx";
import Led from "../components/hud/Led.jsx";
import MinerLog from "../components/MinerLog.jsx";

const AVAIL_LED = { idle: "idle", checking: "busy", free: "ok", taken: "err", error: "err", lagging: "busy", own: "busy", mine: "ok", reserved: "ok", "reserved-dead": "err" };
const HEARTBEAT_MS = 60_000;
const FEE_LOG_MIN_MS = 10 * 60_000;
// Registered → hop to the token page after the banner had a moment on screen.
const HOP_MS = 4_000;
const PENDING_PHASES = new Set(["reserve-pending", "reserve-unsent", "reserve-unseen", "recording", "settling", "taken-tentative", "publish-pending", "publish-unsent", "publish-unseen", "publish-pending-taken", "publish-confirmed"]);

/**
 * This browser's own earlier DEPLOY of `ticker` from `address` that has not
 * been seen to settle (src/lib/txrecords.js, audit usertx-2), re-checked
 * against /tx-status: `{ txid, state }` or null.
 */
async function ownDeployFor(address, ticker) {
  if (!address) return null;
  if (!txRecords(address).some((r) => r.kind === "deploy" && r.ticker === ticker)) return null;
  const recs = await refreshTxRecords(address, (txid) => indexer.txStatus(txid));
  const rec = [...recs].reverse().find((r) => r.kind === "deploy" && r.ticker === ticker);
  return rec ? { txid: rec.txid, state: rec.state } : null;
}

/** Is the registry row `row` the user's own name (its deployer is the connected address)? */
function ownsRow(row, address) {
  return !!row && !!address && row.deployer === address;
}

function ownDeployText(ticker, own) {
  const tx = `tx ${own.txid.slice(0, 12)}…`;
  if (own.state === "confirmed") return `Your publish of ${ticker} (${tx}) has confirmed — waiting for the indexer to list it.`;
  if (own.state === "unknown") return `Your earlier publish of ${ticker} (${tx}) could not be checked right now — it stays paused until it can be checked.`;
  return `You already have a pending publish of ${ticker} (${tx}).`;
}

export default function CreatePage({ params, navigate }) {
  const { wallet: walletState, address, pubkeyHex, fee, fees, indexerOk, health, sync, tipBlock, refreshAll } = useApp();
  const connected = walletState.status === "connected";
  const providerName = walletState.providerName;
  // Reserving is locked below UNLOCK_HEIGHT (969,299); an UNKNOWN tip counts
  // as locked — the gate fails closed (audit L-12). The app's lock time
  // keeps anything sent from confirming before ACTIVATION_HEIGHT (decision B).
  const tipNow = health.data?.tip_height ?? null;
  const preActivation = activationState(tipNow).locked;

  // ---- the Deploy // log buffer (the flow hook writes into it) ------------------------------------
  const { lines, push, clear, meta } = useDeployLog();

  // ---- the two-step flow ---------------------------------------------------------------------------
  const cr = useCommitReveal({
    address: connected ? address : null,
    pubkeyHex,
    providerName,
    tip: tipNow,
    indexed: sync.indexed,
    incrementalRelayFee: fees.data?.incrementalrelayfee ?? null,
    log: push,
    onSettled: refreshAll,
  });
  const rec = cr.rec;
  const phase = cr.phase;
  // Step 2 pays with its own fee choice, "fast" by default: while a publish
  // waits in the mempool its ticker is public (owner decision A).
  const revealFee = useFeeRate(fees.error ? null : fees.data, { preset: "fast", persist: false });

  // `params.ticker` seeds the field; App keys this page on it.
  const [tickerState, setTickerState] = useState(() => cleanTickerInput(params.ticker || ""));
  const typed = tickerState.ticker;
  // An open reservation owns the field: its ticker is shown and locked.
  const ticker = rec ? rec.ticker : typed;
  const tickerNote = rec ? null : tickerState.note;
  const valid = TICKER_RE.test(ticker);
  const requested = cleanTickerInput(params.ticker || "").ticker;
  const inputRef = useRef(null);
  const caretRef = useRef(null);
  const onTickerChange = (e) => {
    const el = e.target;
    const raw = el.value;
    const next = cleanTickerInput(raw);
    const caret = cleanedCaret(raw, el.selectionStart);
    if (el.value !== next.ticker) {
      el.value = next.ticker;
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        /* not a text input */
      }
    }
    caretRef.current = caret;
    setTickerState(next);
  };
  useLayoutEffect(() => {
    const el = inputRef.current;
    const c = caretRef.current;
    caretRef.current = null;
    if (el && c !== null && document.activeElement === el && el.selectionStart !== c) {
      try {
        el.setSelectionRange(c, c);
      } catch {
        /* not a text input */
      }
    }
  }, [typed]);

  // Live availability of the TYPED ticker (no reservation open): /tokens/:ticker
  // → null is "free" only while the indexer has applied the tip (audit usertx-1).
  const [avail, setAvail] = useState({ ticker: "", state: "idle" });
  const indexedHeight = sync.indexed;
  useEffect(() => {
    if (rec || !TICKER_RE.test(typed)) {
      setAvail({ ticker: typed, state: "idle" });
      return undefined;
    }
    let alive = true;
    setAvail((a) => (a.ticker === typed && a.state !== "idle" ? a : { ticker: typed, state: "checking" }));
    const id = setTimeout(async () => {
      try {
        const row = await indexer.token(typed);
        if (!alive) return;
        if (row) {
          setAvail({ ticker: typed, state: ownsRow(row, address) ? "mine" : "taken", row });
          return;
        }
        const own = await ownDeployFor(address, typed);
        if (alive) setAvail(own ? { ticker: typed, state: "own", own } : { ticker: typed, state: "free", asOf: indexedHeight });
      } catch (e) {
        if (alive) setAvail({ ticker: typed, state: "error", error: friendlyError(e) });
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [typed, rec, address, indexedHeight]);
  // A reservation that can no longer be published says so here too (ux-6).
  const availState = rec ? (DEAD_END_PHASES.has(phase) ? "reserved-dead" : "reserved") : avail.ticker === typed ? (avail.state === "free" && !sync.synced ? "lagging" : avail.state) : TICKER_RE.test(typed) ? "checking" : "idle";
  const availFree = !rec && availState === "free";

  // ---- fee previews --------------------------------------------------------------------------------
  const feeRate = fee.satVb;
  const revealRate = revealFee.satVb;
  const commitEstimate = useMemo(() => {
    if (!feeRate) return null;
    try {
      return estimateCommitFeeSats({ address: address || PROJECT_FEE_ADDRESS, feeRateSatVb: feeRate });
    } catch {
      return null;
    }
  }, [feeRate, address]);
  const revealEstimate = useMemo(() => {
    const rate = rec ? revealRate : revealFee.presets.find((p) => p.id === "fast")?.satVb ?? revealRate;
    if (!rate || !valid) return null;
    try {
      return { ...estimateRevealFeeSats({ address: address || PROJECT_FEE_ADDRESS, ticker, feeRateSatVb: rate }), rate };
    } catch {
      return null;
    }
  }, [rec, revealRate, revealFee.presets, valid, address, ticker]);

  // ---- actions ---------------------------------------------------------------------------------------
  const canReserve = connected && !rec && valid && availFree && !cr.busy && indexerOk && !preActivation && !!feeRate;
  const onReserve = () => {
    if (canReserve) cr.reserve(ticker, feeRate);
  };
  const canPublish = connected && phase === "ready" && !cr.busy && indexerOk && !!revealRate;
  const onPublish = () => {
    if (canPublish) cr.publish(revealRate);
  };

  // Registered and final → hop to the token page once the banner has been
  // on screen. A provisional result stays here, where it is checked until
  // final (and a change by a chain reorganization is explained); the check
  // clears `provisional` then, and the hop follows.
  const finished = cr.finished;
  useEffect(() => {
    if (!finished || finished.verdict !== "registered" || finished.provisional) return undefined;
    const id = setTimeout(() => navigate(tokenHref(finished.ticker)), HOP_MS);
    return () => clearTimeout(id);
  }, [finished, navigate]);

  // ---- DEPLOY // LOG: wallet / fee / tip / block lines ----------------------------------------------
  const tipRef = useRef(tipBlock.data);
  tipRef.current = tipBlock.data;
  const tipNowRef = useRef(tipNow);
  tipNowRef.current = tipNow;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const tipHeight = tipBlock.data?.height ?? null;

  // (a) wallet connect / switch / disconnect — transitions only.
  useEffect(() => {
    const prev = meta.lastWallet;
    const cur = walletState.status === "connected" ? walletState.address : null;
    meta.lastWallet = cur;
    if (prev === undefined) {
      if (cur && lines.length === 0) push(walletLine(walletState));
      return;
    }
    if (cur !== prev) push(walletLine(walletState));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- transitions of status/address only
  }, [walletState.status, walletState.address, push]);

  // (b) fee quotes — throttled to one line per FEE_LOG_MIN_MS.
  useEffect(() => {
    if (!fees.data) return;
    const now = Date.now();
    if (meta.lastFeeLogAt && now - meta.lastFeeLogAt < FEE_LOG_MIN_MS) return;
    const l = feeQuoteLine(fees.data, now);
    if (!l) return;
    push(l);
    meta.lastFeeLogAt = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- meta is a stable per-buffer object
  }, [fees.data, push]);

  // (c) the tip, once per mount.
  const tipLoggedRef = useRef(false);
  useEffect(() => {
    if (tipLoggedRef.current || tipHeight === null) return;
    tipLoggedRef.current = true;
    push(tipLine(tipRef.current, "deploy", null));
  }, [tipHeight, push]);

  // (d) the registry's verdict of a publish (provisional until FINAL_DEPTH).
  useEffect(() => {
    if (!finished || finished.verdict !== "registered") return;
    push(deployedLine(finished.ticker, finished.height, finished.revealTxid, Date.now(), { provisional: !!finished.provisional }));
    push(registrationLine(finished.ticker, "registered", finished.revealTxid));
  }, [finished, push]);
  const revealTxid = rec?.reveal?.txid ?? null;
  useEffect(() => {
    if (!rec || !revealTxid) return;
    if (phase === "taken-after") push(registrationLine(rec.ticker, "taken", revealTxid));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per verdict
  }, [phase, revealTxid, push]);

  // (e) heartbeat every 60 s while a step waits for a block.
  const waitingBlock = phase === "reserve-pending" || phase === "publish-pending" || phase === "publish-pending-taken";
  useEffect(() => {
    if (!waitingBlock) return undefined;
    const beat = () => {
      const tip = tipRef.current;
      const known = Number.isInteger(tip?.height) ? tip.height : tipNowRef.current;
      const next = Number.isInteger(known) ? known + 1 : null;
      const since = tip?.time ? Date.now() - tip.time * 1000 : null;
      push(deployHeartbeatLine(next, since));
    };
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [waitingBlock, push]);

  // (f) a new tip block — plain line; filled in place when already printed.
  const prevTipRef = useRef(null);
  useEffect(() => {
    if (tipHeight === null) return;
    const prev = prevTipRef.current;
    prevTipRef.current = tipHeight;
    if (prev === null || prev === tipHeight) return;
    const tip = tipRef.current;
    const existing = linesRef.current.find((l) => l.key === blockLineKey(tipHeight, tip?.hash));
    if (existing) {
      if (!existing.post && tip && (tip.tx_count != null || tip.weight != null)) {
        push(blockFoundLine({ height: tipHeight, hash: existing.hash || tip.hash, tx_count: tip.tx_count, weight: tip.weight }, { at: existing.ts }), { replace: true });
      }
      return;
    }
    push(blockFoundLine(tip));
  }, [tipHeight, push]);

  // Leaving the page while a step is pending: the stored reservation brings it back on return.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const recRef = useRef(rec);
  recRef.current = rec;
  useEffect(
    () => () => {
      const r = recRef.current;
      if (r && PENDING_PHASES.has(phaseRef.current)) push(deployUntrackedLine(r.reveal?.txid || r.commit?.txid));
    },
    [push],
  );

  const onClear = useCallback(() => {
    clear();
    if (finished) cr.dismiss();
  }, [clear, finished, cr]);

  // ---- LEDs of the log: Reserve · Confirm · Publish · Registered -------------------------------------
  const leds = ledStatesFor(phase, cr.op, cr.error, finished);
  const logBusy = cr.busy || PENDING_PHASES.has(phase);

  const commitTx = rec?.commit?.sentAt ? rec.commit.txid : null;
  const footer = (
    <div className="chip-caption">
      <span>two transactions · reserve (the ticker stays hidden) → publish · the first valid publish claims the name</span>
      {(commitTx || revealTxid) && (
        <span>
          {commitTx && (
            <>
              step 1{" "}
              <a href={txUrl(commitTx)} target="_blank" rel="noopener noreferrer" className="mono" title={commitTx}>
                {shortTxid(commitTx)}
              </a>
            </>
          )}
          {revealTxid && rec?.reveal?.sentAt && (
            <>
              {" · step 2 "}
              <a href={txUrl(revealTxid)} target="_blank" rel="noopener noreferrer" className="mono" title={revealTxid}>
                {shortTxid(revealTxid)}
              </a>
            </>
          )}
        </span>
      )}
    </div>
  );

  const preview = {
    ticker: valid ? ticker : "",
    supply: REQUIRED_TOKEN_SUPPLY,
    minted: 0,
    deployer: address || "bc1p…you",
    deploy_txid: "0".repeat(64),
    deploy_block: health.data?.tip_height ? health.data.tip_height + 1 : 0,
    holders: 0,
    mine_count: 0,
  };
  const yieldsLine = `${BUCKETS.map((b) => b.yield).join(" / ")} by the confirming block's last hex digit (${BUCKETS.map((b) => b.label).join(" / ")}) · expected ${fmtDec(EXPECTED_YIELD)}`;
  const otherRequested = rec && requested && requested !== rec.ticker ? requested : null;

  return (
    <main className="page create-page">
      <div className="create-layout">
        <Panel title="Deploy // new ticker" led={AVAIL_LED[availState] || "idle"} right={<span className="label">RESERVE → PUBLISH · §2.1</span>} aria-label="Deploy a new ticker">
          {/* Before the ticker field: on a phone the lock must be read before
              a green "not in the registry" invites a reservation (audit visit-3). */}
          {preActivation && !rec && <div className="notice">{activationNotice(tipNow, "Reserving a ticker")}</div>}
          {otherRequested && (
            <div className="notice">
              You opened Create for {otherRequested}, but your reservation of {rec.ticker} is still open — publish or abandon it before reserving another name.
            </div>
          )}
          {rec && cr.storageBackend === "memory" && (
            <div className="notice">This browser does not let the site keep data, so the reservation lives only in this tab — keep it open until step 2 is done.</div>
          )}
          <label className="field">
            <span className="label">Ticker</span>
            <span className="ticker-field">
              {/* No maxLength of 8: the browser would cut a paste BEFORE the
                  spaces / symbols are removed (audit create-5). */}
              <input
                ref={inputRef}
                className="input mono ticker-input"
                value={ticker}
                onChange={onTickerChange}
                placeholder="TICKER"
                maxLength={64}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={cr.busy || !!rec}
                aria-describedby="ticker-help"
              />
              <Led state={AVAIL_LED[availState] || "idle"} />
            </span>
            {tickerNote && typed && (
              <span className="field-help" role="status">
                {tickerNote}
              </span>
            )}
            <span id="ticker-help" className={`field-help${availState === "taken" || availState === "own" || availState === "reserved-dead" ? " err" : availState === "free" || availState === "mine" || availState === "reserved" ? " ok" : ""}`}>
              <AvailHelp availState={availState} ticker={ticker} typed={typed} valid={valid} avail={avail} sync={sync} />
            </span>
          </label>

          <dl className="facts">
            <div>
              <dt>Supply</dt>
              <dd>{fmtInt(REQUIRED_TOKEN_SUPPLY)} — fixed</dd>
            </div>
            <div>
              <dt>Yield per mine</dt>
              <dd>{yieldsLine}</dd>
            </div>
            <div>
              <dt>Deployer allocation</dt>
              <dd>none — you mine like everyone else</dd>
            </div>
            <div>
              <dt>Protocol fee</dt>
              <dd>{fmtSats(DEPLOY_PROTOCOL_FEE_SATS)} (paid in step 2)</dd>
            </div>
            <div>
              <dt>Kept in your wallet</dt>
              <dd>
                {fmtSats(DUST_SATS)} (step 1, used again in step 2) and {fmtSats(DUST_SATS)} (step 2 proof)
              </dd>
            </div>
            <div>
              <dt>Network fees</dt>
              <dd>
                step 1 {commitEstimate ? `≈ ${fmtSats(commitEstimate.feeSats)}` : "—"}
                {feeRate ? <span className="muted"> @ {feeRate} sat/vB</span> : null}
                {" · "}step 2 {revealEstimate ? `≈ ${fmtSats(revealEstimate.feeSats)}` : "—"}
                {revealEstimate ? <span className="muted"> @ {revealEstimate.rate} sat/vB (fast)</span> : null}
              </dd>
            </div>
          </dl>

          <Steps cr={cr} rec={rec} phase={phase} tipNow={tipNow} revealFee={revealFee} fees={fees.data} connected={connected} />

          {connected && <SettlingNotes cr={cr} indexed={sync.indexed ?? tipNow} />}

          {!connected ? (
            <ConnectPrompt action="create a token" />
          ) : !rec && !finished ? (
            <>
              <FeeSelector fee={fee} disabled={cr.busy} />
              {!preActivation && valid && availFree && (
                <p className="fineprint">
                  Step 1 (Reserve) puts a sealed code on the chain: nobody can see which ticker you chose, and the code is tied to your address, so a copy of it is
                  useless to anyone else. When it has {PUBLISH_MIN_CONFIRMATIONS} confirmations, step 2 (Publish) shows the name and
                  pays the {fmtSats(DEPLOY_PROTOCOL_FEE_SATS)} protocol fee. The first valid publish of {ticker} claims it; a name created by someone else before your
                  publish cannot be taken over.
                </p>
              )}
              <button className="btn btn-primary btn-lg" type="button" onClick={onReserve} disabled={!canReserve}>
                {cr.busy && cr.op?.kind === "reserve" ? "Working…" : `Step 1 · Reserve ${valid ? ticker : "ticker"}`}
              </button>
            </>
          ) : phase === "ready" || (cr.op?.kind === "publish" && rec) ? (
            <>
              <FeeSelector fee={revealFee} disabled={cr.busy} />
              <p className="fineprint">
                Publishing shows {rec.ticker} in the mempool until it confirms, so the fee defaults to Fast: a slow publish gives others time to try to create the same
                name first. Others may have reserved {rec.ticker} too — only the first publish to confirm gets it, and a later one still pays its fees.
              </p>
              <button className="btn btn-primary btn-lg" type="button" onClick={onPublish} disabled={!canPublish}>
                {cr.busy && cr.op?.kind === "publish" ? "Working…" : `Step 2 · Publish ${rec.ticker}`}
              </button>
            </>
          ) : null}

          {connected && (
            <FlowStatus
              cr={cr}
              rec={rec}
              phase={phase}
              finished={finished}
              providerName={providerName}
              idle={{ indexerOk, preActivation, valid, availState, typed, sync, fee, feeRate, assetSafe: walletState.assetSafe }}
              revealRate={revealRate}
              revealFee={revealFee}
              indexed={sync.indexed ?? tipNow}
              onRestart={(t) => {
                // Start again with a NEW reservation (a new sealed code) of the same name.
                cr.abandon();
                setTickerState(cleanTickerInput(t));
              }}
            />
          )}
        </Panel>

        <aside className="create-preview">
          <span className="label">Preview</span>
          <TokenCard token={preview} preview />
          <p className="fineprint">Every token&apos;s picture is an identicon drawn from its ticker — nothing is uploaded or stored.</p>
          <MinerLog
            lines={lines}
            mine={{ phase: cr.error ? "error" : logBusy ? "pending" : "idle" }}
            ticker={ticker}
            onClear={onClear}
            title="Deploy // log"
            phases={DEPLOY_PHASES}
            lit={leds.filter((s) => s !== "idle").length}
            ledStates={leds}
            busy={logBusy}
            showDigits={false}
            footer={footer}
          />
        </aside>
      </div>
    </main>
  );
}

/** The help line under the ticker field. */
function AvailHelp({ availState, ticker, typed, valid, avail, sync }) {
  if (availState === "reserved") return <>Reserved by you — finish step 2 below.</>;
  if (availState === "reserved-dead") return <>This reservation can no longer be published — see below.</>;
  if (!typed) return <>1–8 characters, A–Z and 0–9. The first valid publish claims the name.</>;
  if (!valid) return <>Tickers are 1–8 characters, A–Z and 0–9.</>;
  switch (availState) {
    case "checking":
      return <>Checking availability…</>;
    case "free":
      return <>{`${ticker} is not in the registry as of block #${fmtInt(avail.asOf ?? sync.indexed)}.`}</>;
    case "lagging":
      return <>{`${ticker} is not in the indexer's registry yet. ${syncPauseText(sync, "an availability answer")}`}</>;
    case "own":
      return <>{ownDeployText(ticker, avail.own)}</>;
    case "mine":
      return (
        <>
          You created {ticker}
          {Number.isInteger(avail.row?.deploy_block) ? ` in block #${fmtInt(avail.row.deploy_block)}` : ""} — <a href={tokenHref(ticker)}>open it</a>.
        </>
      );
    case "taken":
      return (
        <>
          {ticker} is already created — <a href={tokenHref(ticker)}>open it</a>.
        </>
      );
    case "error":
      return <>{`Could not check availability: ${avail.error}`}</>;
    default:
      return null;
  }
}

/** Per-LED state of Reserve · Confirm · Publish · Registered. */
function ledStatesFor(phase, op, error, finished) {
  if (finished?.verdict === "registered") return ["ok", "ok", "ok", "ok"];
  let s;
  switch (phase) {
    case "draft":
      s = ["busy", "idle", "idle", "idle"];
      break;
    case "reserve-unsent":
    case "reserve-pending":
    case "reserve-unseen":
    case "recording":
    case "settling":
      s = ["ok", "busy", "idle", "idle"];
      break;
    case "ready":
      s = ["ok", "ok", "idle", "idle"];
      break;
    case "taken-tentative":
      s = ["ok", "ok", "busy", "idle"];
      break;
    case "taken":
    case "closing":
    case "expired":
    case "invalid":
    case "carrier-spent":
      s = ["ok", "ok", "err", "idle"];
      break;
    case "publish-unsent":
    case "publish-pending":
    case "publish-unseen":
    case "publish-confirmed":
      s = ["ok", "ok", "ok", "busy"];
      break;
    case "publish-pending-taken":
    case "taken-after":
    case "refused":
      s = ["ok", "ok", "ok", "err"];
      break;
    default:
      s = ["idle", "idle", "idle", "idle"];
  }
  if (op?.kind === "reserve") s = ["busy", "idle", "idle", "idle"];
  if (op?.kind === "publish") s = ["ok", "ok", "busy", "idle"];
  if (!op && error && (error.kind === "reserve" || error.kind === "publish")) {
    const i = error.kind === "reserve" ? 0 : 2;
    if (s[i] !== "ok") s = s.map((x, j) => (j === i ? "err" : x));
  }
  return s;
}

/**
 * The two steps with their state, the reservation window and the
 * keep-your-browser-data warning. Shown while a reservation is open.
 */
function Steps({ cr, rec, phase, tipNow, revealFee, fees, connected }) {
  if (!rec || !connected) return null;
  const c = rec.commit;
  const r = rec.reveal;
  const t = cr.timing;
  const step1 = !c ? (
    "waiting for your signature — nothing sent yet"
  ) : c.unseenAt && !Number.isInteger(c.height) ? (
    "not seen by the indexer's node for a few minutes — it may still confirm; this page keeps checking"
  ) : !c.sentAt ? (
      "signed — checking that it reached the network…"
    ) : Number.isInteger(c.height) ? (
      <>
        confirmed in block{" "}
        <a href={blockUrl(c.height)} target="_blank" rel="noopener noreferrer" className="mono">
          #{fmtInt(c.height)}
        </a>
        {t && !t.settled ? ` · ${t.confirmations} of ${PUBLISH_MIN_CONFIRMATIONS} confirmations` : ""}
      </>
    ) : (
      `waiting for ${PUBLISH_MIN_CONFIRMATIONS} confirmations`
    );
  const step2 = r?.unseenAt && !Number.isInteger(r.height)
    ? "not seen by the indexer's node for a few minutes — it may still confirm; this page keeps checking"
    : r?.sentAt
    ? Number.isInteger(r.height)
      ? `confirmed in block #${fmtInt(r.height)} — checking the registry`
      : "sent — waiting for a block"
    : phase === "ready"
      ? "ready — press Publish"
      : phase === "settling" && t
        ? `opens at step 1's ${PUBLISH_MIN_CONFIRMATIONS === 2 ? "2nd" : `${PUBLISH_MIN_CONFIRMATIONS}th`} confirmation (block #${fmtInt(t.publishFrom)})`
        : phase === "recording"
          ? "opens when the indexer has recorded step 1"
          : DEAD_END_PHASES.has(phase)
            ? "not possible (see below)"
            : `opens when step 1 has ${PUBLISH_MIN_CONFIRMATIONS} confirmations`;
  const warnExpiry = t && !t.expired && t.blocksLeft <= EXPIRY_WARN_BLOCKS;
  return (
    <div className="cr-steps" role="group" aria-label="Deploy steps">
      <div className={`cr-step${c?.sentAt ? " done" : ""}`}>
        <span className="cr-num mono">1</span>
        <div>
          <b>Reserve</b> <span className="muted">— nobody can see which ticker you chose</span>
          <div className="cr-state">
            {step1}
            {c?.txid && (
              <>
                {" · tx "}
                <a href={txUrl(c.txid)} target="_blank" rel="noopener noreferrer" className="mono" title={c.txid}>
                  {shortTxid(c.txid)}
                </a>
              </>
            )}
            {c?.feeSats != null ? ` · fee ${fmtInt(c.feeSats)} sats` : ""}
          </div>
          {c?.sentAt && !Number.isInteger(c.height) && <SpeedUp cr={cr} step="commit" fees={fees} />}
        </div>
      </div>
      <div className={`cr-step${r?.sentAt ? " done" : ""}`}>
        <span className="cr-num mono">2</span>
        <div>
          <b>Publish</b> <span className="muted">— shows {rec.ticker} and pays the {fmtSats(DEPLOY_PROTOCOL_FEE_SATS)} protocol fee</span>
          <div className="cr-state">
            {step2}
            {r?.sentAt && (
              <>
                {" · tx "}
                <a href={txUrl(r.txid)} target="_blank" rel="noopener noreferrer" className="mono" title={r.txid}>
                  {shortTxid(r.txid)}
                </a>
                {r.feeSats != null ? ` · fee ${fmtInt(r.feeSats)} sats` : ""}
              </>
            )}
          </div>
          {phase !== "publish-pending-taken" && publishMissedBlock(r, tipNow) && (
            <p className="notice" role="alert">
              Your publish missed block #{fmtInt(r.sentTip + 1)}{tipNow > r.sentTip + 1 ? ` and ${tipNow - r.sentTip - 1} more` : ""}. {rec.ticker} is visible in the mempool now, and every
              block it waits gives someone else time to reserve it and publish first — speed it up.
            </p>
          )}
          {/* never for a publish that is already beaten: speeding it up only pays more for nothing */}
          {r?.sentAt && !Number.isInteger(r.height) && phase !== "publish-pending-taken" && <SpeedUp cr={cr} step="reveal" fees={fees} />}
        </div>
      </div>
      {t && !r?.sentAt && !DEAD_END_PHASES.has(phase) && (
        <p className={`cr-window${warnExpiry || t.expired ? " warn" : ""}`}>
          {expiryText(t)}
          {Number.isInteger(tipNow) && !t.expired ? ` Now at block #${fmtInt(tipNow)}.` : ""}
          {warnExpiry && !t.expired ? " Publish soon: the later it goes out, the more a slow block or a chain reorganization can push it past the window." : ""}
        </p>
      )}
      {!r?.sentAt && !DEAD_END_PHASES.has(phase) && (
        <p className="notice">
          Do not clear this browser&apos;s data (cookies and site data) and do not switch browsers before step 2 is done: the code that proves which ticker you reserved
          is saved only here. Without it the reservation cannot be published.
        </p>
      )}
      {phase === "ready" && revealFee?.satVb == null && <p className="fineprint">{missingFeeHint(revealFee.choice, revealFee.satVb, "publish")}</p>}
    </div>
  );
}

/**
 * "Speed up" for a pending step: the same transaction with a higher fee taken
 * from its change (replace-by-fee). The suggested rate is the Fast estimate,
 * or the lowest rate a replacement may use when that is higher; the user may
 * enter a rate of their own (in a rush the estimates lag), and one above the
 * high-fee threshold is confirmed before it can be signed.
 */
function SpeedUp({ cr, step, fees }) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  // A rate of the user's own ("" = the suggested one); a high one is confirmed once, for that rate.
  const [customText, setCustomText] = useState("");
  const [ackRate, setAckRate] = useState(null);
  const s = cr.rec?.[step];
  const floor = useMemo(() => {
    try {
      return s?.psbt ? speedUpFloorRate(s.psbt, fees?.incrementalrelayfee ?? undefined) : null;
    } catch {
      return null;
    }
  }, [s?.psbt, fees?.incrementalrelayfee]);
  const fast = Number(fees?.fastestFee) || 0;
  const suggested = floor ? Math.max(fast, floor) : null;
  const custom = customText.trim() === "" ? null : clampCustomFee(customText);
  const rate = custom ? custom.value : suggested;
  // A typo here costs real sats: above the usual threshold the rate is confirmed first.
  const high = rate !== null && rate > (floor ?? 0) && needsHighFeeAck(rate, fees);
  const quote = open && rate ? cr.speedUpQuote(step, rate) : null;
  const busyHere = cr.op?.kind === "speedup" && cr.op.step === step;
  const err = cr.error?.kind === "speedup" && cr.error.step === step ? cr.error.message : null;
  const close = () => {
    setOpen(false);
    setCustomText("");
    setAckRate(null);
  };
  if (!s?.psbt) return null;
  const rateInput = (
    <span className="cr-speedup-rate">
      <label htmlFor={inputId}>Rate</label>
      <input
        id={inputId}
        className={`input mono${custom?.error ? " invalid" : ""}`}
        type="text"
        inputMode="decimal"
        pattern="[0-9]+([.][0-9]{0,2})?"
        placeholder={suggested ? String(suggested) : "sat/vB"}
        value={customText}
        onChange={(e) => setCustomText(e.target.value)}
        disabled={cr.busy}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!custom?.error}
      />
      <span className="unit">sat/vB · 1–{MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")}</span>
    </span>
  );
  return (
    <div className="cr-speedup">
      {!open ? (
        <button className="btn btn-sm" type="button" onClick={() => setOpen(true)} disabled={cr.busy}>
          Speed up
        </button>
      ) : quote && !quote.error ? (
        <>
          <span>
            New fee <span className="mono">{fmtInt(quote.feeSats)} sats</span> @ {quote.feeRateSatVb} sat/vB (now {fmtInt(quote.oldFeeSats)} sats @ {quote.oldFeeRateSatVb} sat/vB). The
            extra fee comes from your change; everything else stays the same. Leave the rate empty for the suggested {suggested} sat/vB, or enter your own.
          </span>
          {rateInput}
          {high && ackRate !== rate && (
            <span className="err" role="alert">
              {rate.toLocaleString("en-US")} sat/vB is high{fast ? ` — the fastest estimate is ${fast} sat/vB` : ""}. A typo here costs real sats.{" "}
              <button className="btn btn-sm" type="button" onClick={() => setAckRate(rate)} disabled={cr.busy}>
                Use {rate.toLocaleString("en-US")} sat/vB
              </button>
            </span>
          )}
          <span className="cr-speedup-actions">
            <button
              className="btn btn-sm btn-primary"
              type="button"
              disabled={cr.busy || (high && ackRate !== rate)}
              onClick={async () => {
                await cr.speedUp(step, rate);
                close();
              }}
            >
              {busyHere ? (cr.op.phase === "signing" ? "Confirm in wallet…" : "Working…") : "Sign faster version"}
            </button>
            <button className="btn btn-sm" type="button" onClick={close} disabled={cr.busy}>
              Cancel
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="err">{custom?.error || quote?.error || "No fee estimate to speed up with right now."}</span>
          {floor && rateInput}
          <button className="btn btn-sm" type="button" onClick={close}>
            Close
          </button>
        </>
      )}
      {err && !open && <span className="err">{err}</span>}
    </div>
  );
}

/**
 * One status block between the buttons and the log: why the action is off
 * (idle), the in-flight step with its signing detail, the waiting states,
 * the dead ends (taken / expired / …) with Abandon, and the verdict.
 */
function FlowStatus({ cr, rec, phase, finished, providerName, idle, revealRate, revealFee, indexed, onRestart }) {
  const who = providerName || "your wallet";
  const op = cr.op;
  // Abandon asks once, inline (no blocking browser dialog).
  const [confirming, setConfirming] = useState(false);
  let led = "idle";
  let text = null;
  let detail = null;
  let actions = null;
  const abandonBtn = () =>
    confirming ? (
      <>
        <span className="cr-confirm">
          {phase === "publish-pending-taken" ? (
            <>
              Abandon {rec?.ticker}? Your publish is still waiting in the mempool: if it confirms, it is ignored and still pays the {fmtSats(DEPLOY_PROTOCOL_FEE_SATS)} protocol fee and
              the network fee. Abandoning only forgets it on this page.
            </>
          ) : (
            <>
              Abandon {rec?.ticker}?{phase === "reserve-pending" || phase === "reserve-unseen" ? " Step 1 may still confirm." : ""}
              {phase === "publish-unseen" ? " Step 2 may still confirm — and still count as yours." : ""} Its {fmtInt(DUST_SATS)}-sat output stays in your wallet, but this reservation can no
              longer publish the name.
            </>
          )}
        </span>
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => {
            setConfirming(false);
            cr.abandon();
          }}
          disabled={cr.busy}
        >
          Yes, abandon
        </button>
        <button className="btn btn-sm" type="button" onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </>
    ) : (
      <button className="btn btn-sm" type="button" onClick={() => setConfirming(true)} disabled={cr.busy}>
        Abandon reservation
      </button>
    );
  const doneBtn = (
    <button className="btn btn-sm" type="button" onClick={cr.finish} disabled={cr.busy}>
      Done
    </button>
  );

  if (op && op.kind !== "speedup") {
    led = "busy";
    const what = op.kind === "reserve" ? "step 1 (reserve)" : "step 2 (publish)";
    if (op.phase === "building") text = op.waitNote || `Building ${what} — fee inputs never include token-bearing outputs.`;
    else if (op.phase === "signing") text = `Awaiting signature for ${what} — confirm in ${who}.`;
    else text = `Broadcasting ${what}…`;
    if (op.phase !== "building" && op.feeSats != null) {
      detail = (
        <>
          {op.inputCount != null ? `${op.inputCount} input${op.inputCount === 1 ? "" : "s"} · ` : ""}
          network fee <span className="mono">{fmtInt(op.feeSats)} sats</span>
          {op.feeRateSatVb ? ` @ ${op.feeRateSatVb} sat/vB` : ""}
          {op.kind === "publish" ? ` · protocol fee ${fmtInt(DEPLOY_PROTOCOL_FEE_SATS)} sats` : ""}
          {op.utxoSource === "indexer" ? " · inputs from indexer (no wallet UTXO API)" : ""}
          <SpentInputs inputs={op.inputs} assetSafe={op.assetSafe} />
        </>
      );
    }
  } else if (finished?.verdict === "registered") {
    led = finished.provisional ? "busy" : "ok";
    const at = Number.isInteger(finished.height) ? ` in block #${fmtInt(finished.height)}` : "";
    text = (
      <>
        Created {finished.ticker}
        {at} — your publish was the first valid one.
        {finished.provisional ? ` It is final after ${FINAL_DEPTH} confirmations (about an hour); this page keeps checking and opens the token page then.` : ""}{" "}
        <a href={tokenHref(finished.ticker)}>Open {finished.ticker}</a>.
      </>
    );
    actions = (
      <button className="btn btn-sm" type="button" onClick={cr.dismiss}>
        Done
      </button>
    );
  } else if (rec) {
    switch (phase) {
      case "draft":
        // A signature for step 1 may still be open (another tab, or before
        // this page was reopened): nothing has been sent yet.
        led = "busy";
        text = `Step 1 for ${rec.ticker} is waiting for a signature in ${who} (maybe in another tab). Nothing has been sent yet. If you closed that window, discard it.`;
        actions = (
          <button className="btn btn-sm" type="button" onClick={cr.abandon} disabled={cr.busy}>
            Discard
          </button>
        );
        break;
      case "reserve-unseen":
        led = "busy";
        text = `Step 1 has not been seen by the indexer's node for a few minutes and has not confirmed. It may still confirm, so your reservation code stays saved and this page keeps checking. If you are sure it is gone, abandon the reservation and reserve again.`;
        actions = abandonBtn();
        break;
      case "publish-unseen":
        led = "busy";
        text = `Step 2 has not been seen by the indexer's node for a few minutes. It may still confirm; this page keeps checking and opens Publish again if it is gone.`;
        actions = abandonBtn();
        break;
      case "reserve-unsent":
        led = "busy";
        text = "Checking whether step 1 reached the network…";
        break;
      case "reserve-pending":
        led = "busy";
        text = `Step 1 sent — step 2 opens at its ${PUBLISH_MIN_CONFIRMATIONS === 2 ? "2nd" : `${PUBLISH_MIN_CONFIRMATIONS}th`} confirmation. Details are in the Deploy log.`;
        actions = abandonBtn();
        break;
      case "recording":
        led = "busy";
        text =
          cr.commitInfo === null || cr.commitInfo === undefined
            ? "Step 1 confirmed — waiting for the indexer to record the reservation."
            : cr.commitInfo.status === "open" && cr.row === undefined
              ? `Checking that ${rec.ticker} is still free…`
              : `Your reservation is ${commitStatusText(cr.commitInfo.status)}.`;
        if (cr.commitInfoError) detail = `last check failed: ${cr.commitInfoError}`;
        else if (cr.rowError) detail = `last availability check failed: ${cr.rowError}`;
        actions = abandonBtn();
        break;
      case "settling": {
        led = "busy";
        const t = cr.timing;
        text = `Step 1 is confirmed (${t ? `${t.confirmations} of ${PUBLISH_MIN_CONFIRMATIONS}` : "1"} confirmations). Publish opens at block #${t ? fmtInt(t.publishFrom) : "…"}: sent earlier, a chain reorganization could put both steps into one block, where the publish does not count and the reservation is used up.`;
        actions = abandonBtn();
        break;
      }
      case "ready":
        led = "ok";
        text = revealRate ? `Step 1 is confirmed. Publish ${rec.ticker} now — availability is checked again right before it is sent.` : missingFeeHint(revealFee.choice, revealRate, "publish");
        actions = abandonBtn();
        break;
      case "taken-tentative": {
        led = "busy";
        const n = rowConfirmations(cr.row, indexed);
        text = `${rec.ticker} looks taken: another publish of it confirmed${Number.isInteger(n) ? ` (${confirmationsText(n)})` : ""}. That usually stands, but until it has ${FINAL_DEPTH} confirmations a chain reorganization could still change it — wait a few blocks before you abandon this reservation.`;
        actions = abandonBtn();
        break;
      }
      case "closing":
        led = "err";
        text = `Fewer than ${PUBLISH_CUTOFF_BLOCKS} blocks are left before this reservation expires${cr.timing ? ` at block #${fmtInt(cr.timing.expiresAt)}` : ""}. A publish sent now would most likely confirm too late — its fees paid and the name public for nothing — so Publish is closed. Abandon it (the ${fmtInt(DUST_SATS)}-sat output stays in your wallet) and reserve again.`;
        actions = abandonBtn();
        break;
      case "taken":
        led = "err";
        text = `${rec.ticker} was created by someone else before you published, so this reservation can no longer claim it. Abandon it — its ${fmtInt(DUST_SATS)}-sat output stays in your wallet — and reserve another name.`;
        actions = abandonBtn();
        break;
      case "expired":
        led = "err";
        text = `This reservation expired: step 2 must confirm within ${fmtInt(2016)} blocks of step 1. Abandon it (the ${fmtInt(DUST_SATS)}-sat output stays in your wallet) and reserve again.`;
        actions = abandonBtn();
        break;
      case "invalid":
        led = "err";
        text = invalidReasonText(cr.commitInfo?.invalid_reason);
        actions = (
          <>
            <button className="btn btn-sm btn-primary" type="button" onClick={() => onRestart?.(rec.ticker)} disabled={cr.busy}>
              Start again with a new code
            </button>
            {abandonBtn()}
          </>
        );
        break;
      case "carrier-spent":
        led = "err";
        text = `The ${fmtInt(DUST_SATS)}-sat output of step 1 was spent by another transaction, so it can no longer be published. Abandon it and reserve again.`;
        actions = abandonBtn();
        break;
      case "publish-unsent":
        led = "busy";
        text = "Checking whether step 2 reached the network…";
        break;
      case "publish-pending":
        led = "busy";
        text = `Step 2 sent — waiting for a block to confirm the publish of ${rec.ticker}. Details are in the Deploy log.`;
        break;
      case "publish-pending-taken": {
        led = "err";
        // Not final yet: a chain reorganization that takes the other publish out lets yours count.
        const n = rowConfirmations(cr.row, indexed);
        const tentative = Number.isInteger(n) && n < FINAL_DEPTH ? ` The other publish has ${confirmationsText(n)}: until it has ${FINAL_DEPTH}, a chain reorganization could still take it out, and yours could count.` : "";
        text = `${rec.ticker} was created by someone else while your publish was waiting — yours will be ignored when it confirms (the fees are still paid).${tentative}`;
        actions = abandonBtn();
        break;
      }
      case "publish-confirmed":
        led = "busy";
        text = `Step 2 confirmed — checking the registry for ${rec.ticker}.`;
        break;
      case "taken-after": {
        led = "err";
        const n = rowConfirmations(cr.row, indexed);
        const tentative = Number.isInteger(n) && n < FINAL_DEPTH ? ` (the other publish has ${confirmationsText(n)} — a chain reorganization could still change this)` : "";
        text = `${rec.ticker} was claimed by another publish that came first — yours was ignored; the ${fmtSats(DEPLOY_PROTOCOL_FEE_SATS)} protocol fee and the network fees were still paid${tentative}.`;
        actions = doneBtn;
        break;
      }
      case "refused":
        led = "err";
        text = `The indexer did not register ${rec.ticker} from your publish${cr.commitInfo?.reveal_reason ? `: ${revealReasonText(cr.commitInfo.reveal_reason)}` : ""}. The fees were paid.`;
        actions = doneBtn;
        break;
      default:
        break;
    }
  } else {
    const reason = idleReason(idle);
    if (reason) text = reason;
    else if (!idle.feeRate) text = missingFeeHint(idle.fee.choice, idle.feeRate, "reserve", { awaitingAck: !!idle.fee.highFee?.pending });
    else text = readyText(idle.assetSafe, "Reserve");
  }

  // A dead end already explains itself (a Publish that found the name taken says the same thing).
  const err = cr.error && cr.error.kind !== "speedup" && !op && !(rec && DEAD_END_PHASES.has(phase)) ? cr.error.message : null;
  if (!text && !err) return null;
  return (
    <div className="status" role="status" aria-live="polite">
      {text && (
        <div className="line">
          <Led state={led} />
          <span>{text}</span>
        </div>
      )}
      {detail && <div className="detail">{detail}</div>}
      {err && (
        <div className="line">
          <Led state="err" />
          <span>{err}</span>
        </div>
      )}
      {(actions || err) && (
        <div className="actions">
          {actions}
          {err && !rec && (
            <button className="btn btn-sm" type="button" onClick={cr.dismiss}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Created names that are not final yet (settling notes): each says where it
 * stands, until its block has FINAL_DEPTH confirmations — and plainly when
 * a chain reorganization changed it.
 */
function SettlingNotes({ cr, indexed }) {
  const notes = (cr.settling || []).filter((n) => n.revealTxid !== cr.finished?.revealTxid || n.verdict !== "provisional");
  if (!notes.length) return null;
  return (
    <div className="status" role="status" aria-live="polite">
      {notes.map((n) => {
        const conf = confirmationsAt(n.height, indexed);
        let led = "busy";
        let text;
        let actions = null;
        if (n.verdict === "changed-taken") {
          led = "err";
          text = `A chain reorganization changed this result: ${n.ticker} is now registered to another publish. This page keeps checking until it is final.`;
        } else if (n.verdict === "changed-missing") {
          led = "err";
          text = `A chain reorganization took your publish of ${n.ticker} out of its block — it is not in the registry right now. It usually confirms again within a block or two; this page keeps checking.`;
          if (!cr.rec) {
            actions = (
              <button className="btn btn-sm" type="button" onClick={() => cr.restoreSettling(n.revealTxid)} disabled={cr.busy}>
                Track the reservation again
              </button>
            );
          }
        } else {
          text = `Created ${n.ticker}${Number.isInteger(n.height) ? ` in block #${fmtInt(n.height)}` : ""} — provisional${Number.isInteger(conf) ? `, ${confirmationsText(conf)}` : ""}; final after ${FINAL_DEPTH}.`;
        }
        return (
          <div key={n.revealTxid}>
            <div className="line">
              <Led state={led} />
              <span>
                {text}{" "}
                <a href={txUrl(n.revealTxid)} target="_blank" rel="noopener noreferrer" className="mono" title={n.revealTxid}>
                  {shortTxid(n.revealTxid)}
                </a>
              </span>
            </div>
            <div className="actions">
              {actions}
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => cr.dismissSettling(n.revealTxid)}>
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Why Reserve is off while no reservation is open, or null when nothing but the fee rate can stop it. */
function idleReason({ indexerOk, preActivation, valid, availState, typed, sync }) {
  if (!indexerOk) return "Indexer offline — token creation paused until it is reachable.";
  if (preActivation) return lockedHint();
  if (!typed) return "Type a ticker to check whether it is free.";
  if (!valid) return "Tickers are 1–8 characters, A–Z and 0–9.";
  switch (availState) {
    case "checking":
    case "idle":
      return "Checking availability…";
    case "taken":
      return `${typed} is taken — pick another name.`;
    case "mine":
      return `You already created ${typed}.`;
    case "own":
      return `Your publish of ${typed} is still pending (see above).`;
    case "error":
      return "Availability could not be checked (see above).";
    case "lagging":
      return syncPauseText(sync, "token creation");
    default:
      return sync.synced ? null : syncPauseText(sync, "token creation");
  }
}
