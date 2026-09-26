import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { useTxStatus } from "../hooks/useTxStatus.js";
import { friendlyError } from "../hooks/useWallet.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useDeployLog } from "../hooks/useMinerLog.js";
import { buildDeployPsbt, estimateDeployFeeSats, expectPsbtPayload, minFeeInputSats } from "../lib/psbt.js";
import { withPending } from "../lib/pending.js";
import { isUsableFeeRate, missingFeeHint } from "../lib/feechoice.js";
import { ACTIVATION_HEIGHT, DEPLOY_PROTOCOL_FEE_SATS, DUST_SATS, PROJECT_FEE_ADDRESS, REQUIRED_TOKEN_SUPPLY, TICKER_RE } from "../lib/payloads.js";
import { BUCKETS, EXPECTED_YIELD } from "../lib/yield.js";
import { blockUrl, fmtDec, fmtInt, fmtSats, shortTxid, txUrl } from "../lib/format.js";
import {
  AVATAR_PHASES,
  PLAIN_PHASES,
  acceptedLine,
  avatarLeds,
  avatarLine,
  blockFoundLine,
  broadcastingLine,
  commitAcceptedLine,
  commitLine,
  deployBuildLine,
  deployConfirmedLine,
  deployHeartbeatLine,
  deployMempoolLine,
  deployUntrackedLine,
  deployedLine,
  errorLine,
  feeQuoteLine,
  pendingLine,
  reclaimLine,
  reclaimedLine,
  registrationLine,
  registrationVerdict,
  resumeLine,
  revealBuildLine,
  savedRecordLine,
  securedLine,
  securingLine,
  signLine,
  tipLine,
  unseenLine,
  walletLine,
} from "../lib/deploylog.js";
import TokenCard from "../components/TokenCard.jsx";
import { ConnectPrompt, SpentInputs } from "../components/TxProgress.jsx";
import FeeSelector from "../components/FeeSelector.jsx";
import Panel from "../components/hud/Panel.jsx";
import Led from "../components/hud/Led.jsx";
import CreateAvatarFields from "../components/CreateAvatarFields.jsx";
import MinerLog from "../components/MinerLog.jsx";
import { WAITING_FOR_REGISTRY, useDeployAvatar } from "../hooks/useDeployAvatar.js";
import { savedDeployTickers } from "../lib/inscribe.js";

const IDLE = { phase: "idle" };
const AVAIL_LED = { idle: "idle", checking: "busy", free: "ok", taken: "err", error: "err" };
const HEARTBEAT_MS = 60_000;
const FEE_LOG_MIN_MS = 10 * 60_000;
const REGISTRY_POLL_MS = 15_000;
const REGISTRY_MAX_ATTEMPTS = 8;
// Registered → hop to the token page after the banner had a moment on screen.
const HOP_MS = 4_000;
const NO_REG = { txid: null, state: "idle", row: null }; // idle | pending | done | timeout
const AVATAR_OUTCOMES = ["confirmed", "name-taken", "reclaimed"];

export default function CreatePage({ params, navigate }) {
  const { wallet: walletState, address, pubkeyHex, fee, fees, indexerOk, health, tipBlock, refreshAll } = useApp();
  const connected = walletState.status === "connected";
  const providerName = walletState.providerName;
  // A DEPLOY below the activation height is ignored by the indexer (fees
  // lost). An UNKNOWN tip counts as pre-activation: the gate must fail
  // closed, never open (audit L-12).
  const tipNow = health.data?.tip_height ?? null;
  const tipUnknown = tipNow === null;
  const preActivation = tipUnknown || tipNow < ACTIVATION_HEIGHT;
  const [ticker, setTicker] = useState(() => String(params.ticker || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8));
  const valid = TICKER_RE.test(ticker);

  // Live availability: /tokens/:ticker → null (404) means free.
  const [avail, setAvail] = useState({ ticker: "", state: "idle" }); // idle | checking | free | taken | error
  useEffect(() => {
    if (!valid) {
      setAvail({ ticker, state: "idle" });
      return undefined;
    }
    let alive = true;
    setAvail({ ticker, state: "checking" });
    const id = setTimeout(async () => {
      try {
        const row = await indexer.token(ticker);
        if (alive) setAvail({ ticker, state: row ? "taken" : "free", row });
      } catch (e) {
        if (alive) setAvail({ ticker, state: "error", error: friendlyError(e) });
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [ticker, valid]);

  const feeRate = fee.satVb;
  const creation = useDeployAvatar({ wallet: walletState, ticker, feeRateSatVb: feeRate, onSettled: refreshAll });
  const avatarFlow = creation.flow;
  const feeEstimate = useMemo(() => {
    if (!feeRate || !valid) return null;
    try {
      return estimateDeployFeeSats({ address: address || PROJECT_FEE_ADDRESS, ticker, feeRateSatVb: feeRate });
    } catch {
      return null;
    }
  }, [feeRate, valid, address, ticker]);

  const [flow, setFlow] = useState(IDLE);
  useEffect(() => {
    setFlow(IDLE);
  }, [address]);
  const status = useTxStatus(flow.phase === "pending" || flow.phase === "confirmed" ? flow.txid : null, {
    onConfirmed: () => {
      setFlow((f) => ({ ...f, phase: "confirmed" }));
      refreshAll();
    },
  });
  const busy = creation.busy || ["pending", "reclaim-pending"].includes(avatarFlow.phase) || ["building", "signing", "broadcasting", "pending"].includes(flow.phase);

  // Plain path, confirmed → the registry's verdict: /tokens/:ticker names
  // the deploy_txid that claimed the name (ours, another's, or no row yet).
  // Confirmation alone does not settle a DEPLOY.
  const [reg, setReg] = useState(NO_REG);
  useEffect(() => {
    if (flow.phase !== "confirmed" || !flow.txid) return undefined;
    const txid = flow.txid;
    const t = flow.ticker;
    let alive = true;
    let attempts = 0;
    let id = null;
    setReg({ txid, state: "pending", row: null });
    const check = async () => {
      attempts += 1;
      try {
        const row = await indexer.token(t);
        if (!alive) return;
        if (row) {
          if (id) clearInterval(id);
          setReg({ txid, state: "done", row });
          return;
        }
      } catch {
        /* transient — retry on next tick */
      }
      if (alive && attempts >= REGISTRY_MAX_ATTEMPTS) {
        if (id) clearInterval(id);
        setReg({ txid, state: "timeout", row: null });
      }
    };
    check();
    id = setInterval(() => {
      if (attempts < REGISTRY_MAX_ATTEMPTS) check();
    }, REGISTRY_POLL_MS);
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
  }, [flow.phase, flow.txid, flow.ticker]);
  const verdict =
    flow.phase === "confirmed" && reg.txid === flow.txid ? (reg.state === "done" ? registrationVerdict(reg.row, flow.txid) : reg.state === "timeout" ? "unindexed" : null) : null;

  // The registry now holds a row for the ticker in the field: availability
  // follows it (ours → "Created", another's → "already deployed").
  useEffect(() => {
    if (reg.state !== "done" || !reg.row || reg.row.ticker !== ticker) return;
    setAvail({ ticker, state: "taken", row: reg.row });
  }, [reg, ticker]);

  // Registered → hop to the token page once the banner has been on screen.
  useEffect(() => {
    if (verdict !== "registered") return undefined;
    const id = setTimeout(() => navigate(tokenHref(flow.ticker)), HOP_MS);
    return () => clearTimeout(id);
  }, [verdict, flow.ticker, navigate]);

  const create = async () => {
    if (!connected || !valid || avail.ticker !== ticker || avail.state !== "free" || busy || !indexerOk || preActivation || creation.hasSaved || creation.fileError) return;
    if (avatarFlow.preview) { await creation.start(); return; }
    const t = ticker;
    const startedAt = Date.now(); // keys the terminal's per-attempt lines
    setFlow({ phase: "building", ticker: t, startedAt });
    try {
      if (!isUsableFeeRate(feeRate)) {
        throw new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.");
      }
      const [utxoRes, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(address), indexer.tokenUtxos(address)]);
      // A DEPLOY routes nothing (§4.2): a token UTXO spent as a fee input
      // would have its tokens default-routed to vout0 — the §4 filter is
      // applied here exactly as for MINE.
      const built = buildDeployPsbt({
        address,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), address),
        feeRateSatVb: feeRate,
        ticker: t,
        minInputSats: minFeeInputSats(utxoRes.assetSafe), // M-8
      });
      setFlow({
        phase: "signing",
        ticker: t,
        startedAt,
        feeSats: built.feeSats,
        feeRateSatVb: built.feeRateSatVb,
        vsize: built.estimatedVsize,
        inputCount: built.inputIndexes.length,
        inputs: built.inputs,
        assetSafe: utxoRes.assetSafe,
        utxoSource: utxoRes.source,
      });
      // Sign-time guard: exactly one OP_RETURN, and it is DEPLOY|<this ticker>.
      expectPsbtPayload(built.psbtHex, { op: "DEPLOY", ticker: t });
      const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
      setFlow((f) => ({ ...f, phase: "broadcasting" }));
      const txid = await wallet.broadcastSignedPsbt(signed);
      setFlow((f) => ({ ...f, phase: "pending", txid }));
    } catch (e) {
      setFlow((f) => ({ ...f, phase: "error", error: friendlyError(e) }));
    }
  };

  // ---- DEPLOY // LOG -------------------------------------------------------------------------
  // Every line is an event this page observed; the wiring mirrors MinePanel.
  const { lines, push, clear, meta } = useDeployLog();
  const avatarPath = !!avatarFlow.preview || avatarFlow.phase !== "idle" || creation.hasSaved;

  // Refs so the event effects read the latest state without re-running on every change.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const avatarRef = useRef(avatarFlow);
  avatarRef.current = avatarFlow;
  const statusRef = useRef(status);
  statusRef.current = status;
  const tipRef = useRef(tipBlock.data);
  tipRef.current = tipBlock.data;
  const tipNowRef = useRef(tipNow);
  tipNowRef.current = tipNow;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const fileErrorRef = useRef(creation.fileError);
  fileErrorRef.current = creation.fileError;
  const tipHeight = tipBlock.data?.height ?? null;
  // The last record the avatar flow held: confirmation / refund clear
  // `flow.record`, and the outcome lines still need its txids.
  const lastRecordRef = useRef(null);
  if (avatarFlow.record) lastRecordRef.current = avatarFlow.record;
  const avatarRecord = avatarFlow.record || (AVATAR_OUTCOMES.includes(avatarFlow.phase) ? lastRecordRef.current : null);

  /** txs / weight for a block line: from the tip poll when it names the block, else from a plain line already printed. */
  const blockStats = useCallback((height) => {
    const tip = tipRef.current;
    if (tip && tip.height === height) return { tx_count: tip.tx_count, weight: tip.weight };
    const prev = linesRef.current.find((l) => l.key === `block:${height}`);
    return prev ? { tx_count: prev.tx_count, weight: prev.weight } : {};
  }, []);

  // (a) wallet connect / switch / disconnect — transitions only, remembered
  // in meta so a change made on another page is still logged on return; the
  // very first observation is logged only while the log is empty.
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

  // (b) fee quotes — keyed by value and throttled to one line per FEE_LOG_MIN_MS.
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

  // (c) the tip, once per mount (as soon as it is known).
  const tipLoggedRef = useRef(false);
  useEffect(() => {
    if (tipLoggedRef.current || tipHeight === null) return;
    tipLoggedRef.current = true;
    push(tipLine(tipRef.current, "deploy", null));
  }, [tipHeight, push]);

  // (d) plain DEPLOY phase transitions.
  useEffect(() => {
    const f = flowRef.current;
    switch (f.phase) {
      case "signing":
        push(deployBuildLine(f, f.ticker));
        push(signLine(providerName, f.startedAt));
        break;
      case "broadcasting":
        push(broadcastingLine(f.startedAt));
        break;
      case "pending": {
        const tip = tipRef.current?.height ?? tipNowRef.current;
        push(acceptedLine(f.txid));
        push(deployMempoolLine(f.ticker, Number.isInteger(tip) ? tip + 1 : null, f.txid));
        break;
      }
      case "confirmed": {
        // tx-status confirmed it (the callback and the status state land in
        // the same render). The block line is re-appended (`move`) so it
        // sits right before the confirmation, as in the mine log.
        const s = statusRef.current;
        if (Number.isInteger(s.block_height)) {
          push(blockFoundLine({ height: s.block_height, hash: s.block_hash, ...blockStats(s.block_height) }), { move: true });
          push(deployConfirmedLine(f.ticker, s.block_height, f.txid));
        }
        break;
      }
      case "error":
        push(errorLine(f.error, f.startedAt ?? f.txid));
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one line set per phase transition
  }, [flow.phase, flow.txid, flow.startedAt, push]);

  // (e) plain path: the registry's verdict (banner only when it is ours).
  useEffect(() => {
    if (!verdict) return;
    const f = flowRef.current;
    const height = statusRef.current.block_height;
    if (verdict === "registered") push(deployedLine(f.ticker, height, f.txid));
    push(registrationLine(f.ticker, verdict, f.txid));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per verdict
  }, [verdict, push]);

  // (f) avatar flow transitions (useDeployAvatar phases), one line set per
  // real transition; same-phase updates are only the poll's note / unseen
  // flag and a fresh error text.
  const prevAvatarPhaseRef = useRef(null);
  useEffect(() => {
    const f = avatarRef.current;
    const phase = f.phase;
    const prev = prevAvatarPhaseRef.current;
    prevAvatarPhaseRef.current = phase;
    const rec = f.record || lastRecordRef.current;
    const tk = rec?.ticker || ticker;
    const signed = !wallet.isMockWallet();
    const blockLine = () => {
      if (Number.isInteger(f.blockHeight)) push(blockFoundLine({ height: f.blockHeight, hash: f.blockHash, ...blockStats(f.blockHeight) }), { move: true });
    };
    if (prev === phase) {
      if (phase === "pending" && rec?.revealTxid) {
        if (f.note === WAITING_FOR_REGISTRY && Number.isInteger(f.blockHeight)) {
          blockLine();
          push(deployConfirmedLine(tk, f.blockHeight, rec.revealTxid));
          push(registrationLine(tk, "unindexed", rec.revealTxid));
        } else if (f.unseen) {
          push(unseenLine(rec.revealTxid));
        }
      } else if (phase === "error" && f.error) {
        push(errorLine(f.error));
      }
      return;
    }
    switch (phase) {
      case "idle":
        // compressAvatar finished (the flow returns to idle with a preview) or refused the file.
        if (prev === "compressing") push(fileErrorRef.current ? errorLine(fileErrorRef.current) : avatarLine(f.preview));
        break;
      case "securing":
        push(securingLine(providerName, null, { signed }));
        break;
      case "commit-building":
        if (prev === "securing" && rec) push(securedLine(rec.createdAt, { signed }));
        break;
      case "commit-signing":
        push(commitLine(rec, f));
        push(signLine(providerName, `commit:${rec?.createdAt ?? ""}`));
        break;
      case "commit-broadcast":
        push(broadcastingLine(`commit:${rec?.createdAt ?? ""}`));
        break;
      case "reveal-building":
        if (rec?.commitTxid) push(commitAcceptedLine(rec.commitTxid));
        break;
      case "reveal-signing":
        push(revealBuildLine(tk, rec, f));
        push(signLine(providerName, `reveal:${rec?.createdAt ?? ""}`));
        break;
      case "reveal-broadcast":
        push(broadcastingLine(`reveal:${rec?.createdAt ?? ""}`));
        break;
      case "pending": {
        if (!rec?.revealTxid) break;
        if (prev === "reveal-broadcast") {
          const tip = tipRef.current?.height ?? tipNowRef.current;
          push(acceptedLine(rec.revealTxid));
          push(deployMempoolLine(tk, Number.isInteger(tip) ? tip + 1 : null, rec.revealTxid));
        } else {
          // A saved, already-signed reveal resumed — whether the node has it is for the poll to say.
          push(resumeLine(rec));
          push(pendingLine(tk, rec.revealTxid));
        }
        break;
      }
      case "confirmed":
        blockLine();
        push(deployedLine(tk, f.blockHeight, rec?.revealTxid));
        push(registrationLine(tk, "registered", rec?.revealTxid, { avatarApplied: !!f.avatarApplied }));
        break;
      case "name-taken":
        blockLine();
        push(registrationLine(tk, "taken", rec?.revealTxid));
        break;
      case "reclaim-pending":
        push(reclaimLine(rec, address));
        if (rec?.reclaimTxid) push(acceptedLine(rec.reclaimTxid));
        break;
      case "reclaimed":
        push(reclaimedLine(rec, address, f.blockHeight));
        break;
      case "resumable":
        push(resumeLine(rec));
        break;
      case "locked":
      case "invalid-record":
        push(savedRecordLine(ticker, phase));
        break;
      case "error":
        push(errorLine(f.error));
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one line set per phase transition (+ note / unseen / error text)
  }, [avatarFlow.phase, avatarFlow.error, avatarFlow.note, avatarFlow.unseen, push]);

  // (g) heartbeat every 60 s while a deploy (or a refund) awaits a block.
  const pendingKind = flow.phase === "pending" ? "plain" : ["pending", "reclaim-pending"].includes(avatarFlow.phase) ? "avatar" : null;
  useEffect(() => {
    if (!pendingKind) return undefined;
    const beat = () => {
      const tip = tipRef.current;
      const known = Number.isInteger(tip?.height) ? tip.height : tipNowRef.current;
      const next = Number.isInteger(known) ? known + 1 : null;
      const since = tip?.time ? Date.now() - tip.time * 1000 : null;
      push(deployHeartbeatLine(next, since));
    };
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [pendingKind, push]);

  // (h) a new tip block — plain line; when the confirming block was already
  // printed from tx-status, its txs / weight are filled in place instead.
  const prevTipRef = useRef(null);
  useEffect(() => {
    if (tipHeight === null) return;
    const prev = prevTipRef.current;
    prevTipRef.current = tipHeight;
    if (prev === null || prev === tipHeight) return;
    const tip = tipRef.current;
    const existing = linesRef.current.find((l) => l.key === `block:${tipHeight}`);
    if (existing) {
      if (!existing.post && tip && (tip.tx_count != null || tip.weight != null)) {
        push(blockFoundLine({ height: tipHeight, hash: existing.hash || tip.hash, tx_count: tip.tx_count, weight: tip.weight }, { at: existing.ts }), { replace: true });
      }
      return;
    }
    push(blockFoundLine(tip));
  }, [tipHeight, push]);

  // Leaving the page while a deploy is pending: the plain flow's state does
  // not travel; the avatar flow's record does (resume here later).
  useEffect(
    () => () => {
      const f = flowRef.current;
      if (f.phase === "pending" && f.txid) push(deployUntrackedLine(f.txid));
      const a = avatarRef.current;
      const rec = a.record || lastRecordRef.current;
      if (["pending", "reclaim-pending"].includes(a.phase) && rec) {
        const txid = a.phase === "reclaim-pending" ? rec.reclaimTxid : rec.revealTxid;
        if (txid) push(deployUntrackedLine(txid, { saved: true }));
      }
    },
    [push],
  );

  // Clear empties the log; a finished flow (confirmed / errored, never a
  // busy one) is reset with it. A saved avatar record is never discarded here.
  const onClear = useCallback(() => {
    clear();
    if (flow.phase === "confirmed" || flow.phase === "error") setFlow(IDLE);
    const avatarDone = AVATAR_OUTCOMES.includes(avatarFlow.phase) || (avatarFlow.phase === "error" && !avatarFlow.record && !creation.hasSaved);
    if (avatarDone) creation.discard();
  }, [clear, flow.phase, avatarFlow.phase, avatarFlow.record, creation]);

  const leds = avatarPath ? avatarLeds(avatarFlow) : null;
  const trackedTxid = avatarPath
    ? avatarFlow.phase === "reclaim-pending" || avatarFlow.phase === "reclaimed"
      ? avatarRecord?.reclaimTxid
      : avatarRecord?.revealTxid || avatarRecord?.commitTxid
    : flow.txid;
  const trackedBlock = avatarPath ? (AVATAR_OUTCOMES.includes(avatarFlow.phase) ? avatarFlow.blockHeight : null) : flow.phase === "confirmed" ? status.block_height : null;
  const footer = (
    <div className="chip-caption">
      <span>
        {avatarPath
          ? "two transactions · commit (avatar payment) → reveal (DEPLOY + avatar) · the first DEPLOY to confirm claims the name"
          : `one transaction · DEPLOY ${valid ? ticker : "TICKER"} · the first DEPLOY to confirm claims the name`}
      </span>
      {trackedTxid && (
        <span>
          tx{" "}
          <a href={txUrl(trackedTxid)} target="_blank" rel="noopener noreferrer" className="mono" title={trackedTxid}>
            {shortTxid(trackedTxid)}
          </a>
          {trackedBlock ? (
            <>
              {" · block "}
              <a href={blockUrl(trackedBlock)} target="_blank" rel="noopener noreferrer" className="mono">
                #{fmtInt(trackedBlock)}
              </a>
              {!avatarPath && verdict === null ? " · indexer reconciling…" : ""}
            </>
          ) : pendingKind ? (
            <>
              {" · checking every 15 s"}
              {pendingKind === "plain" && status.pollError ? ` · last check failed: ${status.pollError}` : ""}
            </>
          ) : null}
        </span>
      )}
    </div>
  );

  // "Created" only once the registry says the name is ours — a confirmed
  // DEPLOY may still have been beaten by a competing one.
  const created = verdict === "registered" || avatarFlow.phase === "confirmed";
  const buttonLabel = created
    ? `Created ${ticker}`
    : flow.phase === "confirmed" && verdict === null
      ? "Checking the registry…"
      : busy
        ? "Working…"
        : `Create ${valid ? ticker : "token"}`;

  const preview = {
    ticker: valid ? ticker : "TICKER",
    supply: REQUIRED_TOKEN_SUPPLY,
    minted: 0,
    deployer: address || "bc1p…you",
    deploy_txid: "0".repeat(64),
    deploy_block: health.data?.tip_height ? health.data.tip_height + 1 : 0,
    holders: 0,
    mine_count: 0,
  };

  const yieldsLine = `${BUCKETS.map((b) => b.yield).join(" / ")} by the confirming block's last hex digit (${BUCKETS.map((b) => b.label).join(" / ")}) · expected ${fmtDec(EXPECTED_YIELD)}`;

  return (
    <main className="page create-page">
      <div className="create-layout">
        <Panel title="Deploy // new ticker" led={ledFor(avail.state)} right={<span className="label">DEPLOY · §2.1</span>} aria-label="Deploy a new ticker">
          {savedDeployTickers().length > 0 && <div className="notice">
            <span className="label">Saved creations</span>
            <div className="actions create-avatar-actions">{savedDeployTickers().map((saved) => <button key={saved} type="button" className="btn btn-sm" disabled={busy} onClick={() => setTicker(saved)}>Resume {saved}</button>)}</div>
          </div>}
          <label className="field">
            <span className="label">Ticker</span>
            <span className="ticker-field">
              <input
                className="input mono ticker-input"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                placeholder="TICKER"
                maxLength={8}
                autoComplete="off"
                spellCheck={false}
                disabled={busy || creation.hasSaved}
                aria-describedby="ticker-help"
              />
              <Led state={ledFor(avail.state)} />
            </span>
            <span id="ticker-help" className={`field-help${avail.state === "taken" ? " err" : avail.state === "free" ? " ok" : ""}`}>
              {!ticker
                ? "1–8 characters, A–Z and 0–9. The first deploy claims the name forever."
                : !valid
                  ? "Tickers are 1–8 characters, A–Z and 0–9."
                  : avail.state === "checking"
                    ? "Checking availability…"
                    : avail.state === "free"
                      ? `${ticker} is available.`
                      : avail.state === "taken"
                        ? (
                          <>
                            {ticker} is already deployed — <a href={tokenHref(ticker)}>open it</a>.
                          </>
                        )
                        : avail.state === "error"
                          ? `Could not check availability: ${avail.error}`
                          : ""}
            </span>
          </label>

          <CreateAvatarFields creation={creation} ticker={ticker} address={address} feeRate={feeRate} feeChoice={fee.choice} disabled={busy} />

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
                {/* CreateAvatarFields renders its estimate only with a valid ticker AND a rate. */}
                {avatarFlow.preview && valid && feeRate ? "See avatar transaction estimate above" : feeEstimate ? `≈ ${fmtSats(feeEstimate.feeSats)}` : "—"}
                {feeRate ? <span className="muted"> @ {feeRate} sat/vB</span> : null}
              </dd>
            </div>
          </dl>

          <FeeSelector fee={fee} disabled={busy} />

          {preActivation && (
            <div className="notice">
              {tipUnknown
                ? `The indexer has not reported the chain tip yet, so it cannot be confirmed that block #${fmtInt(ACTIVATION_HEIGHT)} has been reached. Token creation stays locked until it does — a DEPLOY sent before activation is ignored and only costs fees.`
                : `The protocol activates at block #${fmtInt(ACTIVATION_HEIGHT)} — ${fmtInt(ACTIVATION_HEIGHT - tipNow)} blocks from now. Token creation opens then; a transaction sent earlier is ignored and only costs fees.`}
            </div>
          )}
          {connected && !preActivation && valid && avail.state === "free" && (
            <p className="fineprint">
              First DEPLOY to confirm claims {ticker}. Availability is checked against confirmed state only: a competing DEPLOY for {ticker} that is already in the mempool,
              or one that pays a higher fee and confirms first, takes the name — yours is then ignored, and the {fmtSats(DEPLOY_PROTOCOL_FEE_SATS)} protocol fee plus the network fee
              are still paid.
            </p>
          )}
          {!connected ? (
            <ConnectPrompt action="create a token" />
          ) : (
            <button className="btn btn-primary btn-lg" type="button" onClick={create} disabled={!valid || avail.ticker !== ticker || avail.state !== "free" || busy || creation.hasSaved || !!creation.fileError || !indexerOk || preActivation || !feeRate || flow.phase === "confirmed" || avatarFlow.phase === "confirmed"}>
              {buttonLabel}
            </button>
          )}

          {connected && (
            <DeployStatus
              flow={flow}
              avatarFlow={avatarFlow}
              avatarPath={avatarPath}
              providerName={providerName}
              ticker={flow.ticker || ticker}
              onReset={() => setFlow(IDLE)}
              indexerOk={indexerOk}
              fee={fee}
              feeRate={feeRate}
            />
          )}

          <MinerLog
            lines={lines}
            mine={avatarPath ? avatarFlow : flow}
            ticker={ticker}
            onClear={onClear}
            title="Deploy // log"
            phases={avatarPath ? AVATAR_PHASES : PLAIN_PHASES}
            lit={leds?.lit}
            ledStates={leds?.states}
            busy={busy}
            showDigits={false}
            footer={footer}
          />
        </Panel>

        <aside className="create-preview">
          <span className="label">Preview</span>
          <TokenCard token={preview} preview avatarPreview={avatarFlow.preview?.dataUrl} />
          <p className="fineprint">
            {avatarFlow.preview ? "Your image will be included in the token creation transaction." : "Without an image, your token uses an identicon derived from its ticker."}
          </p>
        </aside>
      </div>
    </main>
  );
}

function ledFor(state) {
  return AVAIL_LED[state] || "idle";
}

/**
 * One-line status between the Create button and the terminal: idle hints,
 * the in-flight phases with the signing-time input listing (audit M-8), and
 * the plain flow's error with its Reset. Pending / confirmed and the avatar
 * flow's saved-record states are the terminal's and CreateAvatarFields' job.
 */
function DeployStatus({ flow, avatarFlow, avatarPath, providerName, ticker, onReset, indexerOk, fee, feeRate }) {
  const f = avatarPath ? avatarFlow : flow;
  const who = providerName || "your wallet";
  const competing = `If a competing DEPLOY for ${ticker} confirms first, this one is ignored and the ${fmtSats(DEPLOY_PROTOCOL_FEE_SATS)} protocol fee + network fee are still paid.`;
  let led = "idle";
  let text;
  let detail = null;
  let actions = null;

  const signingDetail = (
    <>
      {f.inputCount != null ? `${f.inputCount} input${f.inputCount === 1 ? "" : "s"} · ` : ""}
      network fee <span className="mono">{fmtInt(f.feeSats)} sats</span>
      {f.feeRateSatVb ? ` @ ${f.feeRateSatVb} sat/vB` : ""}
      {f.utxoSource === "indexer" ? " · inputs from indexer (no wallet UTXO API)" : ""}
      <SpentInputs inputs={f.inputs} assetSafe={f.assetSafe} />
    </>
  );

  switch (f.phase) {
    case "compressing":
      led = "busy";
      text = "Preparing the image…";
      break;
    case "securing":
      led = "busy";
      text = wallet.isMockWallet() ? "Saving the recovery record (simulated wallet: unencrypted)." : `Securing the recovery record — approve the message in ${who}.`;
      break;
    case "building":
      led = "busy";
      text = "Building the DEPLOY — fee inputs never include token-bearing UTXOs.";
      break;
    case "commit-building":
      led = "busy";
      text = "Building the avatar payment (commit) — fee inputs never include token-bearing UTXOs.";
      break;
    case "reveal-building":
      led = "busy";
      text = "Building the token creation (reveal: DEPLOY + avatar).";
      break;
    case "signing":
      led = "busy";
      text = `Awaiting signature — confirm in ${who}. ${competing}`;
      detail = signingDetail;
      break;
    case "commit-signing":
      led = "busy";
      text = `Awaiting signature — approve the avatar payment (commit) in ${who}.`;
      detail = signingDetail;
      break;
    case "reveal-signing":
      led = "busy";
      text = `Awaiting signature — approve the token creation (reveal) in ${who}. ${competing}`;
      detail = signingDetail;
      break;
    case "broadcasting":
    case "commit-broadcast":
    case "reveal-broadcast":
      led = "busy";
      text = "Broadcasting…";
      break;
    case "error":
      if (avatarPath) return null; // CreateAvatarFields shows the error with the recovery controls
      led = "err";
      text = f.error || "Failed.";
      actions = (
        <button className="btn btn-sm" type="button" onClick={onReset}>
          Reset
        </button>
      );
      break;
    case "idle":
      if (!indexerOk) text = "Indexer offline — token creation paused until it is reachable.";
      else if (!feeRate) text = missingFeeHint(fee.choice, feeRate, "deploy");
      else text = "Ready. Fee inputs are selected from spendable BTC only — dust and token-bearing outputs are never spent.";
      break;
    default:
      // pending / confirmed / name-taken / reclaim-pending / reclaimed:
      // the terminal below is the status; resumable / locked / invalid-record
      // are described next to their controls above.
      return null;
  }
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
