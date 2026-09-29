import { useEffect, useMemo, useRef, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus.js";
import { PROJECT_FEE_ADDRESS } from "../lib/payloads.js";
import { copyText } from "../lib/clipboard.js";
import { paymentUri, qrMatrix, qrPath } from "../lib/qr.js";

const QUIET = 4; // quiet zone around the code, in modules

/**
 * The Donate dialog opened from the footer: why donations matter, the
 * donation address as a QR code and as text, Copy and Open in wallet.
 * Same dialog behaviour as the wallet dialog (useModalFocus).
 */
export default function DonateModal({ open, onClose }) {
  const dialogRef = useRef(null);
  const [copied, setCopied] = useState(null); // null | "ok" | "fail"
  useModalFocus(dialogRef, open, onClose);

  useEffect(() => {
    if (copied === null) return undefined;
    const id = setTimeout(() => setCopied(null), 2200);
    return () => clearTimeout(id);
  }, [copied]);

  const uri = paymentUri(PROJECT_FEE_ADDRESS);
  const code = useMemo(() => {
    const m = qrMatrix(uri);
    return { box: m.size + QUIET * 2, path: qrPath(m, QUIET) };
  }, [uri]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal donate-modal" role="dialog" aria-modal="true" aria-labelledby="donate-modal-title" ref={dialogRef} tabIndex={-1}>
        <div className="modal-head">
          <h2 id="donate-modal-title">Support LuckyProtocol</h2>
          <button className="btn btn-ghost btn-sm modal-close" type="button" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="donate-copy">
          <p>
            LUCKY-20 launched with no premine and no allocation. Nobody was paid in tokens to build it, so donations are what keep it
            running and growing.
          </p>
          <p>
            They pay for the servers and the full Bitcoin node behind this site, and they fund what comes next: independent security
            reviews, open tools that let anyone run their own indexer and check every balance, wallet support so LUCKY-20 tokens show up
            where you already hold Bitcoin, and a market that stays open and non-custodial.
          </p>
          <p>Every satoshi goes into building a fair, open token standard on Bitcoin.</p>
        </div>

        <figure className="donate-qr">
          <svg viewBox={`0 0 ${code.box} ${code.box}`} role="img" aria-label="QR code of the donation address" shapeRendering="crispEdges">
            <rect width={code.box} height={code.box} fill="#fff" />
            <path d={code.path} fill="#000" />
          </svg>
          <figcaption className="mono">{PROJECT_FEE_ADDRESS}</figcaption>
        </figure>

        <div className="donate-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={async () => setCopied((await copyText(PROJECT_FEE_ADDRESS)) ? "ok" : "fail")}
            aria-label="Copy the donation address"
          >
            {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy address"}
          </button>
          <a className="btn btn-sm" href={uri}>
            Open in wallet
          </a>
        </div>

        <p className="donate-note">
          BTC on Bitcoin mainnet only. A donation is a voluntary gift: it is not an investment and carries no tokens or rights.
        </p>
      </div>
    </div>
  );
}
