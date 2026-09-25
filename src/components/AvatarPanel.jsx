import { useId, useMemo, useState } from "react";
import { useApp } from "../context.js";
import { useAvatar, AVATAR_RECORD_PHASES } from "../hooks/useAvatar.js";
import { estimatePayFeeSats } from "../lib/psbt.js";
import { estimateRevealFee, revealInput0Vsize, envelopeScriptLen, MAX_AVATAR_BYTES, TARGET_AVATAR_BYTES } from "../lib/inscribe.js";
import { missingFeeHint } from "../lib/feechoice.js";
import { AVATAR_PROTOCOL_FEE_SATS, DUST_SATS } from "../lib/payloads.js";
import { fmtInt, fmtTime, txUrl, shortTxid, shortAddr } from "../lib/format.js";
import TokenAvatar from "./TokenAvatar.jsx";
import FeeSelector from "./FeeSelector.jsx";
import UtxoSafetyNotice from "./UtxoSafetyNotice.jsx";
import Led from "./hud/Led.jsx";

const PHASES = ["Commit", "Reveal", "Confirm"];
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

function litCount(av) {
  switch (av.phase) {
    case "commit-checking":
    case "commit-building":
    case "commit-signing":
    case "commit-broadcast":
      return 1;
    case "reveal-building":
    case "reveal-signing":
    case "reveal-broadcast":
    case "commit-unverified":
    case "commit-spent":
      return 2;
    case "pending":
    case "confirmed":
      return 3;
    case "error":
      return av.revealTxid ? 3 : av.commitTxid ? 2 : av.record ? 1 : 0;
    default:
      return 0;
  }
}

function buttonLabel(phase) {
  switch (phase) {
    case "compressing":
      return "Compressing…";
    case "commit-checking":
      return "Checking commit…";
    case "commit-building":
    case "reveal-building":
      return "Assembling…";
    case "commit-signing":
    case "reveal-signing":
      return "Awaiting signature";
    case "commit-broadcast":
    case "reveal-broadcast":
      return "Broadcasting…";
    case "pending":
      return "Awaiting block";
    case "confirmed":
      return "Inscribe another";
    default:
      return "Inscribe avatar";
  }
}

/** What forgetting the record costs, given how far it got. */
function discardWarning(rec) {
  if (!rec) return null;
  const sats = fmtInt(rec.commitAmount);
  const prior = rec.priorCommits && rec.priorCommits.length ? ` It also forgets ${rec.priorCommits.length} earlier commit output(s) (${fmtInt(rec.priorCommits.reduce((a, o) => a + o.sats, 0))} sats) that could still be swept back.` : "";
  if (rec.revealTxid) return `Discarding forgets the key: if the reveal never confirms, the ${sats} sats at the commit address become unspendable.${prior}`;
  if (rec.commitTxid) return `Discarding forgets the key: the ${sats} sats at the commit address become unspendable.${prior}`;
  if (rec.commitAttemptedAt) return `Discarding forgets the key: if the earlier commit payment did go out, its ${sats} sats become unspendable.${prior}`;
  return prior ? `Discarding forgets the key.${prior}` : null;
}

/** Two-step action (click → confirm / cancel) with an explanation shown only on the confirm step. */
function ConfirmControl({ label, confirmLabel, warning, onConfirm, disabled = false, className = "btn btn-sm" }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <button className={className} type="button" onClick={() => setConfirm(true)} disabled={disabled}>
        {label}
      </button>
    );
  }
  return (
    <>
      <button className="btn btn-danger btn-sm" type="button" onClick={() => { setConfirm(false); onConfirm(); }} disabled={disabled}>
        {confirmLabel || label}
      </button>
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => setConfirm(false)}>
        Cancel
      </button>
      {warning && <span className="err">{warning}</span>}
    </>
  );
}

/** "Sweep abandoned commit" rows for every prior commit output the record still holds. */
function SweepControls({ av, onSweep, canAct }) {
  const list = av.sweepable || av.record?.priorCommits || [];
  if (!list.length) return null;
  const sw = av.sweep || null;
  return (
    <>
      {list.map((o) => {
        const key = `${o.txid}:${o.vout}`;
        const mine = sw && sw.outpoint === key ? sw : null;
        const busy = mine && (mine.phase === "building" || mine.phase === "broadcast");
        return (
          <span key={key} className="sweep-row">
            <button className="btn btn-sm" type="button" onClick={() => onSweep(key)} disabled={!canAct || busy} title={`Key-path spend of ${key} back to your address with the throw-away key — no image, no OP_RETURN`}>
              {busy ? "Sweeping…" : `Sweep abandoned commit ${shortTxid(o.txid, 6, 4)}:${o.vout} (${fmtInt(o.sats)} sats)`}
            </button>
            {mine && mine.phase === "error" ? <span className="err">{mine.error}</span> : null}
          </span>
        );
      })}
      {sw && sw.phase === "done" && sw.txid ? (
        <span>
          Swept — <TxA txid={sw.txid} label="tx" />
          {sw.outSats ? ` · ${fmtInt(sw.outSats)} sats back to you` : ""}
        </span>
      ) : null}
      {sw && sw.phase === "gone" ? <span className="muted">The node says {shortTxid(sw.outpoint.split(":")[0], 6, 4)} was already spent — dropped from the record.</span> : null}
    </>
  );
}

/** Two-step Discard (click → confirm / keep) with the record-specific warning. */
function DiscardControl({ label = "Discard", confirmLabel, warning, onDiscard }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => setConfirm(true)}>
        {label}
      </button>
    );
  }
  return (
    <>
      <button className="btn btn-danger btn-sm" type="button" onClick={() => { setConfirm(false); onDiscard(); }}>
        {confirmLabel || label}
      </button>
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => setConfirm(false)}>
        Keep
      </button>
      {warning && <span className="err">{warning}</span>}
    </>
  );
}

/**
 * Deployer-only console for the on-chain token avatar (spec §8): file
 * picker → 256 px preview + byte size → fee breakdown (commit + reveal +
 * protocol fee) → permanent-on-chain warning → two-step progress
 * (Commit → Reveal → Confirm) with the recovery record's Resume / Pay
 * commit again / Rebuild reveal / Discard. Renders nothing unless the
 * connected address is the token's deployer.
 */
export default function AvatarPanel({ ticker, tokenInfo, onSettled }) {
  const { wallet, fee, indexerOk } = useApp();
  const { avatar: av, isDeployer, pickFile, start, resume, payCommit, retryReveal, checkCommit, sweepCommit, rebuildReveal, discard, reset, busy } = useAvatar({
    wallet,
    ticker,
    tokenInfo,
    feeRateSatVb: fee.satVb,
    onSettled,
  });
  const inputId = useId();

  const feeRate = fee.satVb;
  const address = wallet.address;
  const preview = av.preview || null;
  const breakdown = useMemo(() => {
    if (!feeRate || !preview || !address) return null;
    try {
      const leafLen = envelopeScriptLen(preview.contentType, preview.sizeBytes);
      const reveal = estimateRevealFee({ leafScriptLen: leafLen, feeRateSatVb: feeRate, deployerAddress: address, ticker });
      const commitFee = estimatePayFeeSats({ address, toAddress: address, feeRateSatVb: feeRate }).feeSats;
      const envelopeShare = av.record?.commitAmount ? av.record.commitAmount - DUST_SATS : reveal.input0FeeSats;
      return {
        commitFee,
        commitAmount: DUST_SATS + envelopeShare,
        envelopeShare,
        input0Vsize: Math.ceil(revealInput0Vsize(leafLen)),
        revealRemainder: reveal.remainderFeeSats,
        protocolFee: AVATAR_PROTOCOL_FEE_SATS,
        total: commitFee + envelopeShare + reveal.remainderFeeSats + AVATAR_PROTOCOL_FEE_SATS,
      };
    } catch {
      return null;
    }
  }, [feeRate, preview, address, ticker, av.record?.commitAmount]);

  if (!isDeployer) return null;

  const recordOwned = AVATAR_RECORD_PHASES.has(av.phase);
  const canStart = av.phase === "compressed" && !!preview && indexerOk && !!feeRate && !busy;
  const canPick = !busy && !recordOwned;
  // The fee rate stays adjustable while a reveal is pending, so a rebuild can use a fresh one.
  const feeLocked = busy && av.phase !== "pending";
  const lit = litCount(av);
  const providerName = wallet.providerName || "your wallet";

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) pickFile(f);
  };

  return (
    <div className="action-body avatar-body">
      <div className="avatar-current">
        <span className="ch chamfer identicon-wrap">
          <span className="ch-in chamfer">
            <TokenAvatar ticker={ticker} avatarTxid={tokenInfo?.avatar_txid} size={48} />
          </span>
        </span>
        <span>
          {tokenInfo?.avatar_txid ? (
            <>
              Current avatar: inscribed in tx{" "}
              <a className="mono" href={txUrl(tokenInfo.avatar_txid)} target="_blank" rel="noopener noreferrer" title={tokenInfo.avatar_txid}>
                {shortTxid(tokenInfo.avatar_txid, 6, 6)}
              </a>
              {tokenInfo.avatar_content_type ? ` · ${tokenInfo.avatar_content_type}` : ""}. Inscribing again replaces it (the latest applied AVATAR is the one shown).
            </>
          ) : (
            <>No avatar yet — the board shows the identicon derived from the ticker. As deployer you can inscribe one.</>
          )}
        </span>
      </div>

      <div className="avatar-pick">
        <label className={`btn btn-sm${canPick ? "" : " is-disabled"}`} htmlFor={inputId} aria-disabled={!canPick}>
          {preview ? "Choose another image" : "Choose image"}
        </label>
        <input id={inputId} className="sr-only" type="file" accept={ACCEPT} onChange={onFile} disabled={!canPick} />
        <span className="fineprint">PNG, JPEG, WebP or GIF. Resized to 256×256 and compressed to ≤ {fmtInt(TARGET_AVATAR_BYTES)} bytes before anything is signed.</span>
      </div>
      {av.fileError && <div className="err">{av.fileError}</div>}

      {preview && (
        <div className="avatar-preview">
          <span className="frame">
            <img src={preview.dataUrl} alt={`${ticker} avatar preview`} width={256} height={256} />
          </span>
          <dl className="facts-mini">
            <div>
              <dt>Encoded</dt>
              <dd>
                {preview.contentType}
                {preview.width ? ` · ${preview.width}×${preview.height}` : ""}
                {preview.quality ? ` · q ${preview.quality}` : ""}
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd className={preview.sizeBytes > TARGET_AVATAR_BYTES ? "warn" : ""}>
                {fmtInt(preview.sizeBytes)} bytes
                {preview.sizeBytes > TARGET_AVATAR_BYTES ? ` (over the ${fmtInt(TARGET_AVATAR_BYTES)}-byte target, within the ${fmtInt(MAX_AVATAR_BYTES)}-byte limit)` : ""}
              </dd>
            </div>
            {breakdown && (
              <div>
                <dt>Envelope</dt>
                <dd>≈ {fmtInt(breakdown.input0Vsize)} vB in the reveal</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      <FeeSelector fee={fee} disabled={feeLocked} />

      <div className="fee-row avatar-fees">
        <span>
          <span className="k">Commit</span>
          <span className="v">{breakdown ? `${fmtInt(breakdown.commitAmount)} sats` : "—"}</span>
          {breakdown ? ` = ${DUST_SATS} inscribed sat + ${fmtInt(breakdown.envelopeShare)} envelope fee` : null}
        </span>
        <span>
          <span className="k">Commit fee</span>
          <span className="v">{breakdown ? `≈ ${fmtInt(breakdown.commitFee)} sats` : "—"}</span>
        </span>
        <span>
          <span className="k">Reveal fee</span>
          <span className="v">{breakdown ? `≈ ${fmtInt(breakdown.revealRemainder)} sats` : "—"}</span>
          {breakdown ? " from your wallet" : null}
        </span>
        <span>
          <span className="k">Protocol fee</span>
          <span className="v">{AVATAR_PROTOCOL_FEE_SATS} sats</span>
        </span>
        <span>
          <span className="k">Total</span>
          <span className="v">{breakdown ? `≈ ${fmtInt(breakdown.total)} sats` : "—"}</span>
          {feeRate ? ` @ ${feeRate} sat/vB` : null}
        </span>
      </div>

      <div className="notice" role="note">
        Images are inscribed on Bitcoin permanently and cannot be removed; anyone can see them.
      </div>
      <UtxoSafetyNotice />

      {av.phase === "resumable" && av.record && (
        <div className="notice notice-row" role="note">
          <span>
            An avatar inscription for {ticker} from an earlier session is unfinished
            {av.record.revealTxid
              ? " — the reveal was broadcast; resume to watch it confirm."
              : av.record.commitTxid
                ? ` — the commit (${fmtInt(av.record.commitAmount)} sats to ${shortAddr(av.record.commitAddress, 6, 4)}) was paid; resume to sign and broadcast the reveal.`
                : av.record.commitAttemptedAt
                  ? ` — a commit payment (${fmtInt(av.record.commitAmount)} sats to ${shortAddr(av.record.commitAddress, 6, 4)}) was started but its txid was not recorded; resume to look for it at the commit address before anything is paid again.`
                  : " — nothing was paid yet; resume to start the commit."}
            {" "}The throw-away key is kept in this browser until the reveal confirms.
          </span>
          <button className="btn btn-primary btn-sm" type="button" onClick={resume} disabled={!indexerOk}>
            Resume
          </button>
          <DiscardControl
            confirmLabel={av.record.commitTxid && !av.record.revealTxid ? "Discard and abandon the commit" : "Discard"}
            warning={discardWarning(av.record)}
            onDiscard={discard}
          />
        </div>
      )}

      {av.phase === "invalid-record" && (
        <div className="notice notice-row" role="note">
          <span>
            The stored avatar record for {ticker} is invalid — it failed its checks and cannot be read back, so it cannot be resumed. Discard it to start over. If a commit was ever paid from it, those sats cannot be recovered.
          </span>
          <DiscardControl confirmLabel="Discard invalid record" onDiscard={discard} />
        </div>
      )}

      {!recordOwned && (
        <button className={`mine-btn${busy ? " busy" : ""}`} type="button" onClick={av.phase === "confirmed" ? reset : start} disabled={av.phase === "confirmed" ? false : !canStart} aria-busy={busy}>
          <svg className="crawl" aria-hidden="true">
            <rect width="100%" height="100%" />
          </svg>
          {buttonLabel(av.phase)}
        </button>
      )}

      <div className="phase-track three" aria-hidden="true">
        {PHASES.map((p, i) => {
          let cls = "";
          if (i < lit) cls = av.phase === "error" || av.phase === "commit-spent" || av.phase === "commit-unverified" ? "fail" : av.phase === "pending" && i === 2 ? "pulse" : "on";
          return (
            <div key={p} className={cls}>
              <span className="seg" />
              <span className="label">{p}</span>
            </div>
          );
        })}
      </div>

      <StatusLine
        av={av}
        ticker={ticker}
        providerName={providerName}
        onReset={reset}
        onResume={resume}
        onPayCommit={payCommit}
        onRetryReveal={retryReveal}
        onCheckCommit={checkCommit}
        onSweep={sweepCommit}
        onRebuild={rebuildReveal}
        onDiscard={discard}
        indexerOk={indexerOk}
        fee={fee}
        feeRate={feeRate}
      />
    </div>
  );
}

function TxA({ txid, label }) {
  if (!txid) return null;
  return (
    <>
      {label}{" "}
      <a href={txUrl(txid)} target="_blank" rel="noopener noreferrer" className="mono" title={txid}>
        {shortTxid(txid, 6, 6)}
      </a>
    </>
  );
}

function rebuildHint(reason) {
  if (reason === "unseen") return "The indexer has never seen this reveal and the commit output is still unspent — it may never have been relayed. Rebuild it with fresh inputs at the current fee rate.";
  if (reason === "stale") return "Pending for over 30 minutes. If it was dropped from the mempool, rebuild it with fresh inputs at the current fee rate.";
  return null;
}

function commitSpentText(av) {
  const outpoint = av.commitTxid ? `${shortTxid(av.commitTxid, 6, 6)}:${av.record?.commitVout ?? 0}` : "the commit output";
  const lead =
    av.spendKind === "mempool"
      ? `An unconfirmed transaction already spends the commit output ${outpoint} — most likely an earlier reveal from this browser whose txid was not recorded.`
      : `The commit output ${outpoint} is spent: the commit tx is confirmed${av.commitStatus?.blockHeight ? ` (block ${fmtInt(av.commitStatus.blockHeight)})` : ""} and the confirmed UTXO set no longer lists its output — an earlier reveal must have used it.`;
  return `${lead} Watching the token for its avatar to change (every 15 s).`;
}

function commitUnverifiedText(av) {
  const outpoint = av.commitTxid ? `${shortTxid(av.commitTxid, 6, 6)}:${av.record?.commitVout ?? 0}` : "the commit output";
  const cs = av.commitStatus;
  let status;
  if (!cs) status = "the indexer could not report the commit tx's status";
  else if (cs.confirmed) status = `the commit tx is confirmed (block ${fmtInt(cs.blockHeight)})`;
  else if (cs.inMempool || cs.seen) status = "the indexer sees the commit tx unconfirmed in the mempool";
  else status = "the indexer has not seen the commit tx yet";
  const listing =
    av.listing === "unavailable"
      ? "the commit address could not be listed (the indexer was still scanning or unreachable)"
      : av.listing === "listed"
        ? "the commit output IS listed unspent"
        : "the commit output is not in the confirmed UTXO listing";
  return (
    `The node refused the reveal because its commit input ${outpoint} was missing or already spent, but nothing proves the commit is gone: ${listing}, and ${status}. ` +
    "An unconfirmed commit is invisible to the listing until it confirms (~10 min) unless the indexer watched it arrive. " +
    "Retry the reveal or check again — do not pay a second commit unless you accept that the first one may confirm later (it is kept and can be swept back)."
  );
}

function StatusLine({ av, ticker, providerName, onReset, onResume, onPayCommit, onRetryReveal, onCheckCommit, onSweep, onRebuild, onDiscard, indexerOk, fee, feeRate }) {
  let led = "idle";
  let text;
  let detail = null;
  let actions = null;
  const commitTxid = av.commitTxid || av.record?.commitTxid || null;
  const revealTxid = av.revealTxid || av.record?.revealTxid || null;
  const canAct = indexerOk && !!feeRate;
  const links = (
    <>
      <TxA txid={commitTxid} label="commit" />
      {commitTxid && revealTxid ? " · " : ""}
      <TxA txid={revealTxid} label="reveal" />
    </>
  );
  const checks = (
    <>
      {av.lastChecked ? ` · last check ${fmtTime(av.lastChecked / 1000)}` : ""}
      {av.pollError ? ` · last check failed: ${av.pollError}` : ""}
    </>
  );

  switch (av.phase) {
    case "compressing":
      led = "busy";
      text = "Compressing the image…";
      break;
    case "compressed":
      led = "ok";
      text = !feeRate ? missingFeeHint(fee.choice, feeRate, "inscribe") : !indexerOk ? "Indexer offline — inscribing paused until it is reachable." : "Ready. Two signatures: the commit payment, then the reveal. Fee inputs are spendable BTC only — dust and token-bearing outputs are never spent.";
      break;
    case "commit-checking":
      led = "busy";
      text = av.note || "Checking the commit address for an earlier payment before asking for one…";
      detail = av.record ? (
        <>
          {fmtInt(av.record.commitAmount)} sats expected at <span className="mono">{shortAddr(av.record.commitAddress, 8, 6)}</span>
        </>
      ) : null;
      break;
    case "commit-unpaid":
      led = "idle";
      text = `A commit payment was started in an earlier session, but the indexer lists nothing at the commit address. The indexer lists an unconfirmed commit only if it watched it arrive; otherwise it appears once it confirms (~10 min). If ${providerName} shows that payment as sent, wait for it and check again; pay again only if it was never sent.`;
      detail = av.record ? (
        <>
          {fmtInt(av.record.commitAmount)} sats to <span className="mono">{shortAddr(av.record.commitAddress, 8, 6)}</span>
          {av.checkedAt ? ` · checked ${fmtTime(av.checkedAt / 1000)}` : ""}
        </>
      ) : null;
      actions = (
        <>
          <button className="btn btn-primary btn-sm" type="button" onClick={onResume} disabled={!indexerOk}>
            Check again
          </button>
          <ConfirmControl
            label="Pay commit again"
            confirmLabel={`Pay ${fmtInt(av.record?.commitAmount)} sats again`}
            warning="Only if the earlier payment was never sent — a payment that is still confirming would be a second commit to the same address (an unspent one found there is adopted instead of paying)."
            onConfirm={onPayCommit}
            disabled={!canAct}
          />
          <DiscardControl warning={discardWarning(av.record)} onDiscard={onDiscard} />
        </>
      );
      break;
    case "commit-unverified": {
      led = "err";
      text = commitUnverifiedText(av);
      detail = (
        <>
          {links}
          {av.nodeMessage ? ` · node: ${av.nodeMessage}` : ""}
          {av.checkedAt ? ` · checked ${fmtTime(av.checkedAt / 1000)}` : ""}
        </>
      );
      const outpoint = av.commitTxid ? `${shortTxid(av.commitTxid, 6, 4)}:${av.record?.commitVout ?? 0}` : "the earlier commit";
      const sats = av.record?.commitSats ?? av.record?.commitAmount;
      actions = (
        <>
          <button className="btn btn-primary btn-sm" type="button" onClick={onRetryReveal} disabled={!canAct}>
            Retry reveal
          </button>
          <button className="btn btn-sm" type="button" onClick={onCheckCommit} disabled={!indexerOk}>
            Check again
          </button>
          <ConfirmControl
            label="Pay commit again"
            confirmLabel={`Pay a new commit (${fmtInt(av.record?.commitAmount)} sats)`}
            warning={`The earlier commit ${outpoint}${sats ? ` (${fmtInt(sats)} sats)` : ""} stays in the record: if it turns out unspent you can sweep it back with the throw-away key. If it is found unspent at the commit address it is adopted instead of paying.`}
            onConfirm={onPayCommit}
            disabled={!canAct}
          />
          <DiscardControl warning={discardWarning(av.record)} onDiscard={onDiscard} />
        </>
      );
      break;
    }
    case "commit-building":
      led = "busy";
      text = "Building the commit — a plain payment to the commit address.";
      break;
    case "commit-signing":
      led = "busy";
      text = `Awaiting signature 1 of 2 (commit) — confirm in ${providerName}.`;
      detail = (
        <>
          network fee <span className="mono">{fmtInt(av.commitFeeSats)} sats</span>
          {av.commitFeeRate ? ` @ ${av.commitFeeRate} sat/vB` : ""}
          {av.utxoSource === "indexer" ? " · inputs from indexer (no wallet UTXO API)" : ""}
        </>
      );
      break;
    case "commit-broadcast":
      led = "busy";
      text = "Broadcasting the commit…";
      break;
    case "reveal-building":
      led = "busy";
      text = av.note || "Building the reveal — input 0 spends the commit output, input 1 is your UTXO (authorization + fee).";
      detail = (
        <>
          {links}
          {av.adoptedCommit ? " · commit found at the commit address and adopted" : ""}
        </>
      );
      break;
    case "reveal-signing":
      led = "busy";
      text = `Awaiting signature 2 of 2 (reveal) — confirm in ${providerName}. Your wallet signs only its own input; the commit input is signed here with the throw-away key.`;
      detail = (
        <>
          {av.revealInputCount} wallet input{av.revealInputCount === 1 ? "" : "s"} · network fee <span className="mono">{fmtInt(av.revealFeeSats)} sats</span>
          {av.revealFeeRate ? ` @ ${av.revealFeeRate} sat/vB` : ""} · {links}
        </>
      );
      break;
    case "reveal-broadcast":
      led = "busy";
      text = av.note || "Broadcasting the reveal…";
      break;
    case "pending": {
      led = "busy";
      const hint = rebuildHint(av.rebuildReason);
      text = `Reveal broadcast. Pending confirmation — checking every 15 s.${av.seen === false ? " The indexer has not seen this reveal yet." : ""}${av.note ? ` ${av.note}` : ""}${hint ? ` ${hint}` : ""}`;
      detail = (
        <>
          {links}
          {av.broadcastAt ? ` · broadcast ${fmtTime(av.broadcastAt / 1000)}` : ""}
          {checks}
        </>
      );
      actions = (
        <>
          {av.rebuildReason && (
            <button className="btn btn-primary btn-sm" type="button" onClick={onRebuild} disabled={!canAct}>
              Rebuild reveal
            </button>
          )}
          <DiscardControl warning={discardWarning(av.record)} onDiscard={onDiscard} />
        </>
      );
      break;
    }
    case "commit-spent":
      led = "err";
      text = commitSpentText(av);
      detail = (
        <>
          {links}
          {av.nodeMessage ? ` · node: ${av.nodeMessage}` : ""}
          {checks}
        </>
      );
      actions = (
        <>
          <button className="btn btn-primary btn-sm" type="button" onClick={onPayCommit} disabled={!canAct} title="Pays a new commit to the same address (an unspent payment already there is adopted instead), then reveals">
            Pay commit again
          </button>
          <DiscardControl warning={discardWarning(av.record)} onDiscard={onDiscard} />
        </>
      );
      break;
    case "confirmed": {
      led = "ok";
      text = `${ticker} avatar inscribed.`;
      const prior = av.sweepable || [];
      detail = (
        <>
          {links}
          {av.blockHeight ? ` · block ${fmtInt(av.blockHeight)}` : ""} ·{" "}
          {av.reconcile === "done"
            ? "indexer: avatar applied"
            : av.reconcile === "timeout"
              ? "indexer has not applied this avatar yet — the recovery record stays until it does"
              : "reconciling with indexer…"}
          {av.reconcile === "done" && prior.length ? ` · the record is kept: ${prior.length} earlier commit output(s) may still be unspent — sweep them back or discard.` : ""}
        </>
      );
      if (av.reconcile === "done" && (prior.length || av.sweep)) {
        actions = (
          <>
            <SweepControls av={av} onSweep={onSweep} canAct={canAct} />
            {prior.length ? <DiscardControl label="Forget them" confirmLabel="Forget the earlier commits" warning={discardWarning(av.record)} onDiscard={onDiscard} /> : null}
          </>
        );
      }
      break;
    }
    case "error":
      led = "err";
      text = av.error || "Failed.";
      detail = commitTxid || revealTxid ? links : null;
      actions = (
        <>
          {av.record?.revealTxid ? (
            <>
              <button className="btn btn-primary btn-sm" type="button" onClick={onRebuild} disabled={!canAct}>
                Rebuild reveal
              </button>
              <button className="btn btn-sm" type="button" onClick={onResume} disabled={!indexerOk}>
                Keep waiting
              </button>
            </>
          ) : av.record ? (
            <button className="btn btn-primary btn-sm" type="button" onClick={onResume} disabled={!indexerOk}>
              Resume
            </button>
          ) : null}
          <button className="btn btn-sm" type="button" onClick={onReset}>
            Reset
          </button>
        </>
      );
      break;
    case "resumable":
      led = "idle";
      text = "Resume the unfinished inscription above, or discard it.";
      break;
    case "invalid-record":
      led = "err";
      text = "Stored avatar record is invalid — discard it above to continue.";
      break;
    default:
      if (!indexerOk) text = "Indexer offline — inscribing paused until it is reachable.";
      else text = "Pick an image to inscribe. It becomes an Ordinals-style inscription in the deployer's wallet and the token's avatar everywhere this board is shown.";
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
