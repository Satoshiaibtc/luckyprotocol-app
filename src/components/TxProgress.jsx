import { fmtInt, txUrl, shortTxid, UNISAT_INSTALL_URL } from "../lib/format.js";
import { isMobileBrowser } from "../lib/unisat.js";
import { useApp } from "../context.js";
import UniSatMobileGuide from "./UniSatMobileGuide.jsx";

/**
 * One status line for every sign-and-broadcast flow (buy / sell / split /
 * cancel / create). `flow` = { phase, txid, error, feeSats, detail } with
 * phase ∈ idle | verifying | building | signing | broadcasting | pending | confirmed | error.
 */
export default function TxProgress({ flow, status, labels = {}, onReset, idleText }) {
  let cls = "status";
  let text = idleText || "";
  let detail = null;
  let actions = null;

  const txLink = flow.txid && (
    <a href={txUrl(flow.txid)} target="_blank" rel="noopener noreferrer" className="mono" title={flow.txid}>
      {shortTxid(flow.txid)}
    </a>
  );

  switch (flow.phase) {
    case "verifying":
      cls += " s-busy";
      text = labels.verifying || "Verifying the listing…";
      break;
    case "building":
      cls += " s-busy";
      text = labels.building || "Building transaction — selecting fee inputs, laying out outputs.";
      break;
    case "signing":
      cls += " s-busy";
      text = labels.signing || "Awaiting signature — confirm in the UniSat popup.";
      detail = flow.feeSats != null ? (
        <>
          network fee <span className="mono">{fmtInt(flow.feeSats)} sats</span>
          {flow.detail ? ` · ${flow.detail}` : ""}
        </>
      ) : flow.detail || null;
      break;
    case "broadcasting":
      cls += " s-busy";
      text = labels.broadcasting || "Broadcasting…";
      break;
    case "pending":
      cls += " s-busy";
      text = labels.pending || "Broadcast. Pending confirmation — checking every 15 s.";
      detail = (
        <>
          tx {txLink}
          {status?.pollError ? ` · last check failed: ${status.pollError}` : ""}
        </>
      );
      break;
    case "confirmed":
      cls += " s-ok";
      text = labels.confirmed || "Confirmed.";
      detail = (
        <>
          tx {txLink}
          {status?.block_height ? ` · block ${fmtInt(status.block_height)}` : ""}
          {flow.detail ? ` · ${flow.detail}` : ""}
        </>
      );
      actions = onReset && (
        <button className="btn btn-sm" type="button" onClick={onReset}>
          Done
        </button>
      );
      break;
    case "error":
      cls += " s-err";
      text = flow.error || "Failed.";
      actions = onReset && (
        <button className="btn btn-sm" type="button" onClick={onReset}>
          Reset
        </button>
      );
      break;
    default:
      if (!text) return null;
  }

  return (
    <div className={cls} role="status" aria-live="polite">
      <div className="line">
        <span className="dot" aria-hidden="true" />
        <span>{text}</span>
      </div>
      {detail && <div className="detail">{detail}</div>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/** "Connect UniSat to …" block with the install / simulated-wallet affordances. */
export function ConnectPrompt({ action = "continue" }) {
  const { wallet, mock, connect, useMock } = useApp();
  // No provider on a phone: the extension link is useless there — point at the
  // UniSat app's built-in browser instead (simulated wallet stays in mock mode).
  if (wallet.status === "absent" && isMobileBrowser()) {
    return (
      <>
        <UniSatMobileGuide
          action={action}
          extra={
            mock ? (
              <button className="btn btn-sm" type="button" onClick={useMock}>
                Use simulated wallet
              </button>
            ) : null
          }
        />
        {wallet.error && <div className="err">{wallet.error}</div>}
      </>
    );
  }
  return (
    <div className="cta">
      <div>
        {wallet.status === "absent"
          ? `The UniSat browser extension is required to ${action}. LuckyProtocol never holds keys.`
          : `Connect UniSat to ${action}. LuckyProtocol never holds keys — every transaction is signed in your wallet.`}
      </div>
      <div className="row">
        {wallet.status === "absent" ? (
          <a className="btn btn-primary btn-sm" href={UNISAT_INSTALL_URL} target="_blank" rel="noopener noreferrer">
            Install UniSat
          </a>
        ) : (
          <button className="btn btn-primary btn-sm" type="button" onClick={connect} disabled={wallet.status === "connecting" || wallet.status === "detecting"}>
            {wallet.status === "connecting" ? "Connecting…" : "Connect UniSat"}
          </button>
        )}
        {mock && (
          <button className="btn btn-sm" type="button" onClick={useMock}>
            Use simulated wallet
          </button>
        )}
      </div>
      {wallet.error && <div className="err">{wallet.error}</div>}
    </div>
  );
}
