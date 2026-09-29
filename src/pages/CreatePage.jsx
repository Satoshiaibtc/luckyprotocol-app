import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { friendlyError } from "../hooks/useWallet.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useDeployLog } from "../hooks/useMinerLog.js";
import { useFeeRate } from "../hooks/useFeeRate.js";
import { ownDeployFor, useCreate } from "../hooks/useCreate.js";
import { MAX_FEE_RATE_SAT_VB, estimateDeployFeeSats, speedUpFloorRate } from "../lib/psbt.js";
import { DROP_GRACE_MS } from "../lib/txrecords.js";
import { syncPauseText } from "../lib/sync.js";
import { clampCustomFee, isUsableFeeRate, missingFeeHint, needsHighFeeAck } from "../lib/feechoice.js";
import { DEPLOY_PROTOCOL_FEE_SATS, DUST_SATS, PROJECT_FEE_ADDRESS, REQUIRED_TOKEN_SUPPLY, TICKER_RE, buildDeployPayload, payloadToString } from "../lib/payloads.js";
import { activationNotice, activationState, lockedHint } from "../lib/activation.js";
import { deployLeds, headroomText, isOwnVerdict, ownDeployText, rowConfirmations, rowIsFinal } from "../lib/createFlow.js";
import { FINAL_DEPTH, confirmationsAt, confirmationsText } from "../lib/finality.js";
import { cleanTickerInput, cleanedCaret } from "../lib/tickerInput.js";
import { readyText } from "../lib/statusText.js";
import { BUCKETS, EXPECTED_YIELD } from "../lib/yield.js";
import { blockUrl, fmtDec, fmtInt, fmtSats, shortTxid, txUrl } from "../lib/format.js";
import { blockLineKey } from "../lib/minerlog.js";
import { DEPLOY_PHASES, blockFoundLine, deployHeartbeatLine, deployUntrackedLine, feeQuoteLine, tipLine, walletLine } from "../lib/deploylog.js";
import TokenCard from "../components/TokenCard.jsx";
import { ConnectPrompt, SpentInputs } from "../components/TxProgress.jsx";
import FeeSelector from "../components/FeeSelector.jsx";
import Panel from "../components/hud/Panel.jsx";
import Led from "../components/hud/Led.jsx";
import MinerLog from "../components/MinerLog.jsx";

const AVAIL_LED = { idle: "idle", checking: "busy", free: "ok", taken: "err", error: "err", lagging: "busy", own: "busy", mine: "ok" };
const HEARTBEAT_MS = 60_000;
const FEE_LOG_MIN_MS = 10 * 60_000;
// Registered → hop to the token page after the banner had a moment on screen.
const HOP_MS = 4_000;
/** Phases in which the flow owns the ticker field (its ticker is shown and locked). */
const HOLDS_TICKER = new Set(["building", "review", "signing", "broadcasting", "pending", "confirmed"]);

/** Is the registry row `row` the user's own name (its deployer is the connected address)? */
function ownsRow(row, address) {
  return !!row && !!address && row.deployer === address;
}

const txLink = (txid) => (
  <a href={txUrl(txid)} target="_blank" rel="noopener noreferrer" className="mono" title={txid}>
    {shortTxid(txid)}
  </a>
);

export default function CreatePage({ params, navigate }) {
  const { wallet: walletState, address, pubkeyHex, fees, indexerOk, sync, tipBlock, refreshAll, chainTip } = useApp();
  const connected = walletState.status === "connected";
  const providerName = walletState.providerName;
  // Creating is locked below UNLOCK_HEIGHT (969,599); an UNKNOWN tip counts
  // as locked — the gate fails closed. The app's lock time keeps anything
  // sent from confirming before ACTIVATION_HEIGHT.
  const tipNow = chainTip;
  const preActivation = activationState(tipNow).locked;

  // ---- the Deploy // log buffer (the flow hook writes into it) ------------------------------------
  const { lines, push, clear, meta } = useDeployLog();

  // The DEPLOY pays its own fee choice, "fast" by default: while it waits in
  // the mempool its ticker is public. Not persisted — every other builder
  // keeps the user's usual choice.
  const createFee = useFeeRate(fees.error ? null : fees.data, { preset: "fast", persist: false });
  const rate = createFee.satVb;

  // `params.ticker` seeds the field; App keys this page on it.
  const [tickerState, setTickerState] = useState(() => cleanTickerInput(params.ticker || ""));
  const requested = cleanTickerInput(params.ticker || "").ticker || null;

  // ---- the DEPLOY flow ---------------------------------------------------------------------------------
  const cr = useCreate({
    address: connected ? address : null,
    pubkeyHex,
    providerName,
    tip: tipNow,
    indexed: sync.indexed,
    trustUnseen: sync.trustUnseen,
    incrementalRelayFee: fees.data?.incrementalrelayfee ?? null,
    requested,
    log: push,
    onSettled: refreshAll,
  });
  const flow = cr.flow;
  const holds = HOLDS_TICKER.has(flow.phase) && !!flow.ticker;

  const typed = tickerState.ticker;
  // A DEPLOY in progress owns the field: its ticker is shown and locked.
  const ticker = holds ? flow.ticker : typed;
  const tickerNote = holds ? null : tickerState.note;
  const valid = TICKER_RE.test(ticker);
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
  // A resumed DEPLOY shows its ticker; once it is over, the field keeps it.
  useEffect(() => {
    if (holds && flow.ticker && flow.ticker !== typed) setTickerState(cleanTickerInput(flow.ticker));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the flow's ticker only
  }, [holds, flow.ticker]);

  // Live availability of the TYPED ticker (no DEPLOY in progress): /tokens/:ticker
  // → null is "free" only while the indexer has applied the tip and this
  // browser has no pending DEPLOY of it.
  const [avail, setAvail] = useState({ ticker: "", state: "idle" });
  const indexedHeight = sync.indexed;
  useEffect(() => {
    if (holds || !TICKER_RE.test(typed)) {
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
        const own = await ownDeployFor(connected ? address : null, typed);
        if (alive) setAvail(own ? { ticker: typed, state: "own", own } : { ticker: typed, state: "free", asOf: indexedHeight });
      } catch (e) {
        if (alive) setAvail({ ticker: typed, state: "error", error: friendlyError(e) });
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [typed, holds, address, connected, indexedHeight]);
  const availState = holds
    ? "own"
    : avail.ticker === typed
      ? avail.state === "free" && !sync.synced
        ? "lagging"
        : avail.state
      : TICKER_RE.test(typed)
        ? "checking"
        : "idle";
  const availFree = !holds && availState === "free";

  // ---- fee preview ---------------------------------------------------------------------------------
  const estimate = useMemo(() => {
    if (!rate || !valid) return null;
    try {
      return estimateDeployFeeSats({ address: address || PROJECT_FEE_ADDRESS, ticker, feeRateSatVb: rate });
    } catch {
      return null;
    }
  }, [rate, valid, address, ticker]);
  const payloadText = useMemo(() => {
    if (!valid) return null;
    try {
      return payloadToString(buildDeployPayload(ticker));
    } catch {
      return null;
    }
  }, [valid, ticker]);

  // ---- actions ---------------------------------------------------------------------------------------
  const idleish = flow.phase === "idle" || flow.phase === "error" || flow.phase === "done" || flow.phase === "released";
  const canCreate = connected && valid && availFree && sync.synced && !cr.busy && idleish && indexerOk && !preActivation && isUsableFeeRate(rate);
  const onCreate = () => {
    if (canCreate) cr.create(ticker, rate);
  };

  // A reviewed DEPLOY signs exactly the transaction it shows (its rate and
  // fee included): a later change of the Fast estimate does not cancel it.
  const { dismiss } = cr;

  // Registered → hop to the token page once the banner has been on screen.
  // Not for a DEPLOY picked up again on return: the user opened Create on
  // purpose, and the result links to the token instead.
  const hop = flow.phase === "done" && isOwnVerdict(flow.verdict) && !flow.resumed ? flow.ticker : null;
  useEffect(() => {
    if (!hop) return undefined;
    const id = setTimeout(() => navigate(tokenHref(hop)), HOP_MS);
    return () => clearTimeout(id);
  }, [hop, navigate]);

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

  // (d) heartbeat every 60 s while the DEPLOY waits for a block.
  const waitingBlock = flow.phase === "pending";
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

  // (e) a new tip block — plain line; filled in place when already printed.
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

  // Leaving the page while the DEPLOY is pending: the broadcast record brings it back on return.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  useEffect(
    () => () => {
      const f = flowRef.current;
      if ((f.phase === "pending" || f.phase === "confirmed") && f.txid) push(deployUntrackedLine(f.txid));
    },
    [push],
  );

  const onClear = useCallback(() => {
    clear();
    dismiss();
  }, [clear, dismiss]);

  // ---- LEDs of the log: Sign · Broadcast · Confirm · Registered -------------------------------------
  const leds = deployLeds(flow);
  const logBusy = cr.busy || flow.phase === "pending" || flow.phase === "confirmed";

  const trackedTxid = flow.phase === "pending" || flow.phase === "confirmed" || flow.phase === "done" || flow.phase === "released" ? flow.txid : null;
  const footerTicker = trackedTxid ? flow.ticker : valid ? ticker : "";
  const footer = (
    <div className="chip-caption">
      <span>{`one transaction · DEPLOY${footerTicker ? ` ${footerTicker}` : ""} · the first DEPLOY to confirm claims the name`}</span>
      {trackedTxid && (
        <span>
          tx {txLink(trackedTxid)}
          {Number.isInteger(flow.height) ? (
            <>
              {" · block "}
              <a href={blockUrl(flow.height)} target="_blank" rel="noopener noreferrer" className="mono">
                #{fmtInt(flow.height)}
              </a>
            </>
          ) : flow.phase === "pending" ? (
            <>
              {" · checking every 15 s"}
              {cr.status.pollError ? ` · last check failed: ${cr.status.pollError}` : ""}
            </>
          ) : null}
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
    deploy_block: chainTip ? chainTip + 1 : 0,
    holders: 0,
    mine_count: 0,
  };
  const yieldsLine = `${BUCKETS.map((b) => b.yield).join(" / ")} by the confirming block's last hex digit (${BUCKETS.map((b) => b.label).join(" / ")}) · expected ${fmtDec(EXPECTED_YIELD)}`;
  const otherPending = cr.otherPending && !holds ? cr.otherPending : null;
  const releasedNote = !holds && valid ? (cr.settling || []).find((n) => n.ticker === ticker && n.verdict === "released") : null;
  const totalSats = estimate ? DEPLOY_PROTOCOL_FEE_SATS + DUST_SATS + estimate.feeSats : null;
  const showForm = connected && !holds && flow.phase !== "done";

  return (
    <main className="page create-page">
      <div className="create-layout">
        <Panel title="Deploy // new ticker" led={AVAIL_LED[availState] || "idle"} right={<span className="label">DEPLOY · §2.1</span>} aria-label="Deploy a new ticker">
          {/* Before the ticker field: on a phone the lock must be read before
              a green "not in the registry" invites a DEPLOY. */}
          {preActivation && !holds && <div className="notice">{activationNotice(tipNow, "Creating a ticker")}</div>}
          {otherPending && (
            <div className="notice">
              Your DEPLOY of {otherPending.ticker} (tx {otherPending.txid.slice(0, 12)}…) is still waiting for its result — <a href="#/create">open it</a>.
            </div>
          )}
          <label className="field">
            <span className="label">Ticker</span>
            <span className="ticker-field">
              {/* No maxLength of 8: the browser would cut a paste BEFORE the
                  spaces / symbols are removed. */}
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
                disabled={cr.busy || holds}
                aria-describedby="ticker-help"
              />
              <Led state={AVAIL_LED[availState] || "idle"} />
            </span>
            {tickerNote && typed && (
              <span className="field-help" role="status">
                {tickerNote}
              </span>
            )}
            <span id="ticker-help" className={`field-help${availState === "taken" || (availState === "own" && !holds) ? " err" : availState === "free" || availState === "mine" ? " ok" : ""}`}>
              <AvailHelp availState={availState} holds={holds} ticker={ticker} typed={typed} valid={valid} avail={avail} sync={sync} />
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
              <dd>{fmtSats(DEPLOY_PROTOCOL_FEE_SATS)}</dd>
            </div>
            <div>
              <dt>Proof output</dt>
              <dd>{fmtSats(DUST_SATS)} back to you</dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>
                {estimate ? `≈ ${fmtSats(estimate.feeSats)}` : "—"}
                {rate ? <span className="muted"> @ {rate} sat/vB</span> : null}
              </dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{totalSats !== null ? `≈ ${fmtSats(totalSats)}` : "—"}</dd>
            </div>
            {payloadText && (
              <div>
                <dt>OP_RETURN</dt>
                <dd>
                  <span className="mono">{payloadText}</span> <span className="muted">(compact, exactly what goes on chain)</span>
                </dd>
              </div>
            )}
          </dl>

          {showForm && (
            <>
              <FeeSelector fee={createFee} disabled={cr.busy} />
              <p className="fineprint">
                While your DEPLOY waits for a block, anyone who reads the mempool can see {valid ? ticker : "the ticker"} in it and send another DEPLOY of {valid ? ticker : "it"} that
                pays a higher fee. The first DEPLOY to confirm takes the name. If another one confirms first, yours is ignored, and its{" "}
                {fmtInt(DEPLOY_PROTOCOL_FEE_SATS)}-sat protocol fee and its network fee are spent and not refunded. That is why the fee starts at Fast, and why you can speed
                your DEPLOY up while it waits.
              </p>
            </>
          )}
          {!connected ? (
            <ConnectPrompt action="create a token" />
          ) : flow.phase === "review" ? (
            <Review key={flow.startedAt} cr={cr} flow={flow} />
          ) : showForm ? (
            <>
              <button className="btn btn-primary btn-lg" type="button" onClick={onCreate} disabled={!canCreate}>
                {cr.busy ? "Working…" : `Create ${valid ? ticker : "token"}`}
              </button>
              {releasedNote && (
                <p className="notice">
                  An earlier DEPLOY of {releasedNote.ticker} from this browser may still confirm (tx {releasedNote.txid.slice(0, 12)}…). Creating again can pay the fees twice.
                </p>
              )}
            </>
          ) : null}

          {connected && (
            <FlowStatus
              cr={cr}
              flow={flow}
              tipNow={tipNow}
              providerName={providerName}
              fees={fees.data}
              indexed={sync.indexed ?? tipNow}
              idle={{ indexerOk, preActivation, valid, availState, typed, sync, fee: createFee, rate, assetSafe: walletState.assetSafe }}
              onRetry={() => cr.create(flow.ticker || ticker, rate)}
            />
          )}

          {connected && <SettlingNotes cr={cr} flow={flow} fieldTicker={holds ? null : ticker} indexed={sync.indexed ?? tipNow} />}
        </Panel>

        <aside className="create-preview">
          <span className="label">Preview</span>
          <TokenCard token={preview} preview />
          <p className="fineprint">Every token&apos;s picture is an identicon drawn from its ticker — nothing is uploaded or stored.</p>
          <MinerLog
            lines={lines}
            mine={{ phase: flow.phase === "error" ? "error" : logBusy ? "pending" : "idle" }}
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
function AvailHelp({ availState, holds, ticker, typed, valid, avail, sync }) {
  if (holds) return <>Your DEPLOY of {ticker} is in progress — see below.</>;
  if (!typed) return <>1–8 characters, A–Z and 0–9. The first DEPLOY to confirm claims the name.</>;
  if (!valid) return <>Tickers are 1–8 characters, A–Z and 0–9.</>;
  switch (availState) {
    case "checking":
      return <>Checking availability…</>;
    case "free":
      return <>{`${ticker} is not in the registry as of block #${fmtInt(avail.asOf ?? sync.indexed)}.`}</>;
    case "lagging":
      return <>{`${ticker} is not in the indexer's registry yet. ${syncPauseText(sync, "an availability answer")}`}</>;
    case "own":
      return <>{avail.own ? ownDeployText(ticker, avail.own) : null}</>;
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

/**
 * The Speed up headroom warning of a built DEPLOY (the headroom review): signed only
 * after "Create {T} anyway" is ticked. Keyed on the build, so a new build
 * starts unticked.
 */
function Review({ cr, flow }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="status" role="status" aria-live="polite">
      <div className="line">
        <Led state="err" />
        <span>{headroomText(flow.headroom, flow.ticker)}</span>
      </div>
      <div className="detail">
        {flow.inputCount != null ? `${flow.inputCount} input${flow.inputCount === 1 ? "" : "s"} · ` : ""}
        network fee <span className="mono">{fmtInt(flow.feeSats)} sats</span>
        {flow.feeRateSatVb ? ` @ ${flow.feeRateSatVb} sat/vB` : ""}
        {flow.vsize ? ` · ${fmtInt(flow.vsize)} vB` : ""}
        <SpentInputs inputs={flow.inputs} />
      </div>
      <div className="notice-row">
        <label className="ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={cr.busy} />
          <span>Create {flow.ticker} anyway</span>
        </label>
      </div>
      <div className="actions">
        <button className="btn btn-primary" type="button" onClick={cr.confirmCreate} disabled={!ack || cr.busy}>
          Sign DEPLOY {flow.ticker}
        </button>
        <button className="btn btn-sm" type="button" onClick={cr.cancelReview} disabled={cr.busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * "Speed up" for the pending DEPLOY: the same transaction with a higher fee
 * taken from its change (replace-by-fee). The suggested rate is the Fast
 * estimate, or the lowest rate a replacement may use when that is higher;
 * the user may enter a rate of their own (in a rush the estimates lag), and
 * one above the high-fee threshold is confirmed before it can be signed.
 */
function SpeedUp({ cr, flow, fees }) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  // A rate of the user's own ("" = the suggested one); a high one is confirmed once, for that rate.
  const [customText, setCustomText] = useState("");
  const [ackRate, setAckRate] = useState(null);
  const floor = useMemo(() => {
    try {
      return flow.psbt ? speedUpFloorRate(flow.psbt, fees?.incrementalrelayfee ?? undefined) : null;
    } catch {
      return null;
    }
  }, [flow.psbt, fees?.incrementalrelayfee]);
  const fast = Number(fees?.fastestFee) || 0;
  const suggested = floor ? Math.max(fast, floor) : null;
  const custom = customText.trim() === "" ? null : clampCustomFee(customText);
  const rate = custom ? custom.value : suggested;
  // A typo here costs real sats: above the usual threshold the rate is confirmed first.
  const high = rate !== null && rate > (floor ?? 0) && needsHighFeeAck(rate, fees);
  const quote = open && rate ? cr.speedUpQuote(rate) : null;
  const busy = !!cr.speeding;
  const close = () => {
    setOpen(false);
    setCustomText("");
    setAckRate(null);
  };
  if (!cr.canSpeedUp) return null;
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
        disabled={busy}
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
        <button className="btn btn-sm" type="button" onClick={() => setOpen(true)} disabled={busy}>
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
              <button className="btn btn-sm" type="button" onClick={() => setAckRate(rate)} disabled={busy}>
                Use {rate.toLocaleString("en-US")} sat/vB
              </button>
            </span>
          )}
          <span className="cr-speedup-actions">
            <button
              className="btn btn-sm btn-primary"
              type="button"
              disabled={busy || (high && ackRate !== rate)}
              onClick={async () => {
                await cr.speedUp(rate);
                close();
              }}
            >
              {busy ? (cr.speeding === "signing" ? "Confirm in wallet…" : "Working…") : "Sign faster version"}
            </button>
            <button className="btn btn-sm" type="button" onClick={close} disabled={busy}>
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
      {cr.speedError && !open && <span className="err">{cr.speedError}</span>}
    </div>
  );
}

/**
 * One status block between the button and the settling notes: why Create
 * is off (idle), the in-flight step with its signing detail, the pending
 * DEPLOY with its Speed up and notices, and the verdict.
 */
function FlowStatus({ cr, flow, tipNow, providerName, fees, indexed, idle, onRetry }) {
  const who = providerName || "your wallet";
  const t = flow.ticker;
  let led = "idle";
  let text = null;
  let detail = null;
  let actions = null;
  let body = null;
  const dismissBtn = (label = "Done") => (
    <button className="btn btn-sm" type="button" onClick={cr.dismiss}>
      {label}
    </button>
  );
  const signingDetail = (
    <>
      {flow.inputCount != null ? `${flow.inputCount} input${flow.inputCount === 1 ? "" : "s"} · ` : ""}
      network fee <span className="mono">{fmtInt(flow.feeSats)} sats</span>
      {flow.feeRateSatVb ? ` @ ${flow.feeRateSatVb} sat/vB` : ""}
      {flow.vsize ? ` · ${fmtInt(flow.vsize)} vB` : ""}
      {` · protocol fee ${fmtInt(DEPLOY_PROTOCOL_FEE_SATS)} sats`}
      <SpentInputs inputs={flow.inputs} />
    </>
  );

  switch (flow.phase) {
    case "building":
      led = "busy";
      text = `Building the DEPLOY of ${t} — fee inputs never include token-bearing outputs.`;
      break;
    case "review":
      return null; // the Review block says it
    case "signing":
      led = "busy";
      text = `Awaiting signature for the DEPLOY of ${t} — confirm in ${who}.`;
      detail = signingDetail;
      break;
    case "broadcasting":
      led = "busy";
      text = "Broadcasting…";
      detail = signingDetail;
      break;
    case "pending":
      body = <Pending cr={cr} flow={flow} tipNow={tipNow} fees={fees} indexed={indexed} />;
      break;
    case "confirmed":
      led = "busy";
      text = `DEPLOY of ${t} confirmed${Number.isInteger(flow.height) ? ` in block #${fmtInt(flow.height)}` : ""} — waiting for the indexer's registry.`;
      break;
    case "done": {
      const row = flow.row;
      const at = Number.isInteger(row?.deploy_block) ? ` — block #${fmtInt(row.deploy_block)}` : "";
      const provisional = !flow.final ? ` Provisional until ${FINAL_DEPTH} confirmations.` : "";
      if (flow.verdict === "registered") {
        led = flow.final ? "ok" : "busy";
        text = (
          <>
            Created {t}
            {at}.{provisional} <a href={tokenHref(t)}>Open {t}</a>.
          </>
        );
      } else if (flow.verdict === "registered-own") {
        led = flow.final ? "ok" : "busy";
        text = (
          <>
            Created {t}
            {at}, by a transaction this page did not send (tx {row?.deploy_txid ? txLink(row.deploy_txid) : "…"}). It is registered to your address.{provisional}{" "}
            <a href={tokenHref(t)}>Open {t}</a>.
          </>
        );
      } else if (flow.verdict === "taken") {
        led = "err";
        const n = rowConfirmations(row, indexed);
        text = (
          <>
            Another DEPLOY of {t} confirmed first (tx {row?.deploy_txid ? txLink(row.deploy_txid) : "…"}
            {Number.isInteger(row?.deploy_block) ? `, block #${fmtInt(row.deploy_block)}` : ""}).
            {Number.isInteger(flow.height) ? ` Yours confirmed in block #${fmtInt(flow.height)} and was ignored;` : " Yours was ignored;"} its{" "}
            {fmtInt(DEPLOY_PROTOCOL_FEE_SATS)}-sat protocol fee and its network fee are spent and not refunded.
            {!rowIsFinal(row, indexed) ? ` Until that block has ${FINAL_DEPTH} confirmations${Number.isInteger(n) ? ` (now ${n})` : ""}, a chain reorganization could still change this.` : ""}
          </>
        );
      } else {
        led = "busy";
        text = `The indexer has not listed ${t} yet — this page checks again when you return.`;
      }
      actions = dismissBtn();
      break;
    }
    case "released":
      led = "err";
      text = `None of your DEPLOY's versions is in the node's mempool any more. It may still confirm; creating again can pay the fees twice.`;
      detail = flow.txid ? <>last version tx {txLink(flow.txid)}</> : null;
      actions = dismissBtn("Dismiss");
      break;
    case "error":
      led = "err";
      text = flow.error || "Failed.";
      actions = (
        <>
          <button className="btn btn-sm" type="button" onClick={onRetry}>
            Retry
          </button>
          {dismissBtn("Dismiss")}
        </>
      );
      break;
    default: {
      const reason = idleReason(idle);
      if (reason) text = reason;
      else if (!idle.rate) text = missingFeeHint(idle.fee.choice, idle.rate, "deploy", { awaitingAck: !!idle.fee.highFee?.pending });
      else text = readyText(idle.assetSafe, "Create");
    }
  }
  if (body) return body;
  if (!text) return null;
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

/** The pending DEPLOY, and its taken-while-pending notice: sent and waiting for a block. */
function Pending({ cr, flow, tipNow, fees, indexed }) {
  const t = flow.ticker;
  const taken = flow.takenRow;
  const unseenMinutes = cr.newestUnseen ? Math.max(Math.round(DROP_GRACE_MS / 60_000), Math.round((Date.now() - (cr.unseenAt ?? Date.now()) + DROP_GRACE_MS) / 60_000)) : 0;
  const missedFrom = Number.isInteger(flow.sentTip) ? flow.sentTip + 1 : null;
  const more = Number.isInteger(missedFrom) && Number.isInteger(tipNow) ? tipNow - missedFrom : 0;
  const n = taken ? confirmationsAt(taken.deploy_block, indexed) : null;
  return (
    <div className="cr-steps" role="status" aria-live="polite">
      <div className="line">
        <Led state={taken ? "err" : "busy"} />
        <span>
          DEPLOY of {t} sent — waiting for a block. tx {txLink(flow.txid)}
          {flow.feeSats != null ? ` · fee ${fmtInt(flow.feeSats)} sats` : ""}
          {flow.feeRateSatVb ? ` @ ${flow.feeRateSatVb} sat/vB` : ""}. {t} is visible in the mempool until this confirms.
        </span>
      </div>
      {flow.resumed && !flow.psbt && <p className="cr-state">This DEPLOY was picked up again without its unsigned copy, so it cannot be sped up from this page.</p>}
      {flow.unsent && <p className="notice">No relay confirmed that it was sent; it may still reach the network — this page keeps checking.</p>}
      {taken ? (
        <p className="notice" role="alert">
          {t} was registered by another DEPLOY (tx {txLink(taken.deploy_txid)}
          {Number.isInteger(taken.deploy_block) ? `, block #${fmtInt(taken.deploy_block)}` : ""}) while yours was waiting. Yours will be ignored when it confirms; its{" "}
          {fmtInt(DEPLOY_PROTOCOL_FEE_SATS)}-sat protocol fee and its network fee are spent and not refunded.
          {n === null || n < FINAL_DEPTH ? ` Until that block has ${FINAL_DEPTH} confirmations, a chain reorganization could still change this.` : ""}
        </p>
      ) : (
        <>
          {cr.missed && Number.isInteger(missedFrom) && (
            <p className="notice" role="alert">
              Your DEPLOY missed block #{fmtInt(missedFrom)}
              {more > 0 ? ` and ${more} more` : ""}. {t} is visible in the mempool, and another DEPLOY of {t} that pays more can confirm first. Speed it up.
            </p>
          )}
          {cr.newestUnseen && <p className="notice">The node has not seen your DEPLOY for {unseenMinutes} minutes — it may have been replaced or dropped. Still checking.</p>}
          <SpeedUp cr={cr} flow={flow} fees={fees} />
          {cr.speedError && !cr.canSpeedUp && <p className="err">{cr.speedError}</p>}
        </>
      )}
    </div>
  );
}

/**
 * Results that are not final yet (settling notes): each says where it
 * stands until its block has FINAL_DEPTH confirmations — and plainly when a
 * chain reorganization changed it. A released DEPLOY stays listed until its
 * note expires: one of its versions may still confirm.
 */
function SettlingNotes({ cr, flow, fieldTicker, indexed }) {
  const shown = new Set(flow.phase === "done" ? [flow.txid, flow.row?.deploy_txid].filter(Boolean).map((x) => String(x).toLowerCase()) : []);
  const notes = (cr.settling || []).filter((n) => {
    if (n.verdict === "released" && n.ticker === fieldTicker) return false; // said under the button
    if (flow.phase === "done" && n.verdict !== "changed-missing" && n.versions.some((x) => shown.has(x))) return false; // the result above says it
    return true;
  });
  if (!notes.length) return null;
  return (
    <div className="status" role="status" aria-live="polite">
      {notes.map((n) => {
        const conf = confirmationsAt(n.height, indexed);
        let led = "busy";
        let text;
        if (n.verdict === "changed-taken") {
          led = "err";
          if (n.origin === "taken") text = `Another DEPLOY of ${n.ticker} holds the name. Until its block has ${FINAL_DEPTH} confirmations, a chain reorganization could still change this.`;
          else if (n.origin === "released") text = `${n.ticker} is registered to another DEPLOY. If your earlier DEPLOY confirms, it is ignored; its fees are spent and not refunded.`;
          else text = `A chain reorganization changed this result: ${n.ticker} is now registered to another DEPLOY. This page keeps checking until it is final.`;
        } else if (n.verdict === "changed-missing") {
          led = "err";
          text = `A chain reorganization took your DEPLOY of ${n.ticker} out of its block — it is not in the registry right now. It usually confirms again within a block or two; this page keeps checking.`;
        } else if (n.verdict === "released") {
          text = `An earlier DEPLOY of ${n.ticker} from this browser left the node's mempool and may still confirm. Creating ${n.ticker} again can pay the fees twice.`;
        } else {
          text = `Created ${n.ticker}${Number.isInteger(n.height) ? ` in block #${fmtInt(n.height)}` : ""} — provisional${Number.isInteger(conf) ? `, ${confirmationsText(conf)}` : ""}; final after ${FINAL_DEPTH}.`;
        }
        return (
          <div key={n.txid}>
            <div className="line">
              <Led state={led} />
              <span>
                {text} {txLink(n.txid)}
              </span>
            </div>
            <div className="actions">
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => cr.dismissSettling(n.txid)}>
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Why Create is off while nothing is in progress, or null when nothing but the fee rate can stop it. */
function idleReason({ indexerOk, preActivation, valid, availState, typed, sync }) {
  if (!indexerOk) return "The indexer is not answering right now — token creation is paused until it does.";
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
      return `Your DEPLOY of ${typed} is still pending (see above).`;
    case "error":
      return "Availability could not be checked (see above).";
    case "lagging":
      return syncPauseText(sync, "token creation");
    default:
      return sync.synced ? null : syncPauseText(sync, "token creation");
  }
}
