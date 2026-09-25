import { useId, useState } from "react";
import { fmtInt, shortTxid, txUrl } from "../lib/format.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { commitAmountFor, envelopeScriptLen, estimateRevealFee } from "../lib/inscribe.js";
import { estimatePayFeeSats } from "../lib/psbt.js";
import { PROJECT_FEE_ADDRESS } from "../lib/payloads.js";

const LABELS = {
  compressing: "Preparing image...", securing: "Approve the recovery message in your wallet.",
  "commit-building": "Preparing avatar payment...", "commit-signing": "Approve the avatar payment in your wallet.",
  "commit-broadcast": "Sending avatar payment...", "reveal-building": "Preparing token creation...",
  "reveal-signing": "Approve token creation in your wallet.", "reveal-broadcast": "Sending token creation...",
  pending: "Token creation sent. Waiting for confirmation.",
  "reclaim-pending": "Refund sent. Waiting for confirmation.", reclaimed: "Avatar payment reclaimed.",
  "name-taken": "Another creation claimed this ticker first. Your transaction confirmed, but did not register the token; transaction fees were still paid.",
};

export default function CreateAvatarFields({ creation, ticker, address, feeRate, disabled }) {
  const { flow, busy, hasSaved, pickFile, unlock, resume, reclaim, retryBroadcast, discard } = creation;
  const [confirmReclaim, setConfirmReclaim] = useState(false);
  const inputId = useId();
  const rec = flow.record;
  const preview = flow.preview;
  let estimate = null;
  if (preview && feeRate) {
    const leafScriptLen = envelopeScriptLen(preview.contentType, preview.sizeBytes);
    const from = address || PROJECT_FEE_ADDRESS;
    const reveal = estimateRevealFee({ leafScriptLen, feeRateSatVb: feeRate, deployerAddress: from, ticker });
    estimate = {
      payment: commitAmountFor({ leafScriptLen, feeRateSatVb: feeRate }),
      network: reveal.totalFeeSats + estimatePayFeeSats({ address: from, toAddress: PROJECT_FEE_ADDRESS, feeRateSatVb: feeRate }).feeSats,
    };
  }
  return (
    <section className="create-avatar" aria-label="Token avatar">
      <div className="field">
        <span className="label">Avatar <span className="muted">(optional)</span></span>
        <div className="avatar-pick">
          <label htmlFor={inputId} className={`btn btn-sm${disabled || busy || hasSaved ? " is-disabled" : ""}`} aria-disabled={disabled || busy || hasSaved}>{preview ? "Choose another image" : "Choose image"}</label>
          <input id={inputId} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose token avatar" disabled={disabled || busy || hasSaved} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) pickFile(file); }} />
        </div>
      </div>
      {preview && (
        <div className="create-avatar-preview">
          <img src={preview.dataUrl} alt={`${ticker} avatar preview`} width="96" height="96" />
          <div>
            <span className="mono">{fmtInt(preview.sizeBytes)} bytes</span>
            {estimate && <p className="fineprint">Avatar prepayment: {fmtInt(estimate.payment)} sats.<br />Estimated network fees for both transactions: {fmtInt(estimate.network)} sats.</p>}
            {!hasSaved && !busy && <button type="button" className="btn btn-ghost btn-sm" onClick={discard}>Remove image</button>}
          </div>
        </div>
      )}
      {preview && <p className="fineprint">The image is public and permanent on Bitcoin. Creation with an avatar uses two transactions. The creation fee is still 5,460 sats, with no additional avatar protocol fee. Keep this browser's recovery record until creation or refund confirms.</p>}
      <div role="status" aria-live="polite">
        {LABELS[flow.phase] && <p>{LABELS[flow.phase]}</p>}
        {flow.phase === "confirmed" && <p>Created <a href={tokenHref(ticker)}>{ticker}</a>. {flow.avatarApplied ? "Avatar applied." : "The registry did not apply the image; you can replace it from Portfolio."}</p>}
        {flow.phase === "resumable" && <p>An unfinished creation is saved in this browser.</p>}
        {(flow.phase === "locked" || (hasSaved && !rec && flow.phase === "error")) && <p>Unlock the saved creation with the wallet that started it.</p>}
        {flow.phase === "invalid-record" && <p className="err">The recovery record cannot be read. Keep this browser's data; a paid avatar may still depend on it.</p>}
        {flow.error && <p className="err">{flow.error}</p>}
        {flow.note && <p className="muted">{flow.note}</p>}
      </div>
      {rec && <p className="fineprint">
        {[["Payment", rec.commitTxid], ["Creation", rec.revealTxid], ["Refund", rec.reclaimTxid]].filter(([, txid]) => txid).map(([label, txid]) => <span key={label}>{label}: <a href={txUrl(txid)} target="_blank" rel="noopener noreferrer">{shortTxid(txid)}</a>{" "}</span>)}
      </p>}
      <div className="actions create-avatar-actions">
        {hasSaved && !rec && flow.phase !== "invalid-record" && <button type="button" className="btn btn-sm" onClick={unlock} disabled={busy || !address}>Unlock recovery</button>}
        {rec && !["pending", "reclaim-pending"].includes(flow.phase) && <button type="button" className="btn btn-primary btn-sm" onClick={resume} disabled={busy || !address}>Resume creation</button>}
        {rec?.revealTxid && flow.phase === "pending" && flow.unseen && <button type="button" className="btn btn-sm" onClick={retryBroadcast} disabled={busy || !address}>Retry saved transaction</button>}
        {rec?.commitTxid && !rec.reclaimTxid && <button type="button" className="btn btn-sm" onClick={() => setConfirmReclaim(true)} disabled={busy || !feeRate || !address}>Reclaim avatar payment</button>}
        {confirmReclaim && rec && <>
          <span className="fineprint">Return the unspent avatar payment to your wallet, minus a network fee. This cancels the saved creation; the first payment's network fee is not refunded.</span>
          <button type="button" className="btn btn-sm" disabled={busy || !feeRate} onClick={() => { setConfirmReclaim(false); reclaim(); }}>Confirm reclaim</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmReclaim(false)}>Keep creation</button>
        </>}
        {rec && !rec.commitRawHex && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={discard}>Discard unpaid creation</button>}
      </div>
    </section>
  );
}
