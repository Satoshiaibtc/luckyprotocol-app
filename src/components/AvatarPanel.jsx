import { useId, useMemo, useState } from "react";
import { useApp } from "../context.js";
import { useAvatar } from "../hooks/useAvatar.js";
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
    case "commit-building":
    case "commit-signing":
    case "commit-broadcast":
      return 1;
    case "reveal-building":
    case "reveal-signing":
    case "reveal-broadcast":
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

/**
 * Deployer-only console for the on-chain token avatar (spec §8): file
 * picker → 256 px preview + byte size → fee breakdown (commit + reveal +
 * protocol fee) → permanent-on-chain warning → two-step progress
 * (Commit → Reveal → Confirm) with the recovery record's Resume / Discard.
 * Renders nothing unless the connected address is the token's deployer.
 */
export default function AvatarPanel({ ticker, tokenInfo, onSettled }) {
  const { wallet, fee, indexerOk } = useApp();
  const { avatar: av, isDeployer, pickFile, start, resume, discard, reset, busy } = useAvatar({
    wallet,
    ticker,
    tokenInfo,
    feeRateSatVb: fee.satVb,
    onSettled,
  });
  const inputId = useId();
  const [confirmDiscard, setConfirmDiscard] = useState(false);

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

  const canStart = av.phase === "compressed" && !!preview && indexerOk && !!feeRate && !busy;
  const canPick = !busy && av.phase !== "resumable";
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

      <FeeSelector fee={fee} disabled={busy} />

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
                : " — nothing was paid yet; resume to start the commit."}
            {" "}The throw-away key is kept in this browser until the reveal confirms.
          </span>
          <button className="btn btn-primary btn-sm" type="button" onClick={resume} disabled={!indexerOk}>
            Resume
          </button>
          {confirmDiscard ? (
            <>
              <button className="btn btn-danger btn-sm" type="button" onClick={() => { setConfirmDiscard(false); discard(); }}>
                {av.record.commitTxid && !av.record.revealTxid ? "Discard and abandon the commit" : "Discard"}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setConfirmDiscard(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setConfirmDiscard(true)}>
              Discard
            </button>
          )}
          {confirmDiscard && av.record.commitTxid && !av.record.revealTxid && (
            <span className="err">Discarding forgets the key: the {fmtInt(av.record.commitAmount)} sats at the commit address become unspendable.</span>
          )}
        </div>
      )}

      {av.phase !== "resumable" && (
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
          if (i < lit) cls = av.phase === "error" ? "fail" : av.phase === "pending" && i === 2 ? "pulse" : "on";
          return (
            <div key={p} className={cls}>
              <span className="seg" />
              <span className="label">{p}</span>
            </div>
          );
        })}
      </div>

      <StatusLine av={av} ticker={ticker} providerName={providerName} onReset={reset} onResume={resume} indexerOk={indexerOk} fee={fee} feeRate={feeRate} />
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

function StatusLine({ av, ticker, providerName, onReset, onResume, indexerOk, fee, feeRate }) {
  let led = "idle";
  let text;
  let detail = null;
  let actions = null;
  const commitTxid = av.commitTxid || av.record?.commitTxid || null;
  const revealTxid = av.revealTxid || av.record?.revealTxid || null;
  const links = (
    <>
      <TxA txid={commitTxid} label="commit" />
      {commitTxid && revealTxid ? " · " : ""}
      <TxA txid={revealTxid} label="reveal" />
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
      text = "Building the reveal — input 0 spends the commit output, input 1 is your UTXO (authorization + fee).";
      detail = links;
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
      text = "Broadcasting the reveal…";
      break;
    case "pending":
      led = "busy";
      text = revealTxid ? "Reveal broadcast. Pending confirmation — checking every 15 s." : "The commit output is already spent — watching the token for its avatar to change (every 15 s).";
      detail = (
        <>
          {links}
          {av.broadcastAt ? ` · broadcast ${fmtTime(av.broadcastAt / 1000)}` : ""}
          {av.lastChecked ? ` · last check ${fmtTime(av.lastChecked / 1000)}` : ""}
          {av.pollError ? ` · last check failed: ${av.pollError}` : ""}
        </>
      );
      break;
    case "confirmed":
      led = "ok";
      text = `${ticker} avatar inscribed.`;
      detail = (
        <>
          {links}
          {av.blockHeight ? ` · block ${fmtInt(av.blockHeight)}` : ""} ·{" "}
          {av.reconcile === "done"
            ? "indexer: avatar applied"
            : av.reconcile === "timeout"
              ? "indexer has not applied this avatar yet — the recovery record stays until it does"
              : "reconciling with indexer…"}
        </>
      );
      break;
    case "error":
      led = "err";
      text = av.error || "Failed.";
      detail = commitTxid || revealTxid ? links : null;
      actions = (
        <>
          {av.record && (
            <button className="btn btn-primary btn-sm" type="button" onClick={onResume} disabled={!indexerOk}>
              Resume
            </button>
          )}
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
