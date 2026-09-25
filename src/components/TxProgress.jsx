import { fmtInt, txUrl, shortTxid } from "../lib/format.js";
import { isMobileBrowser } from "../lib/wallet.js";
import { PROVIDER_IDS, PROVIDER_META } from "../lib/walletShapes.js";
import { useApp } from "../context.js";
import WalletMobileGuide from "./WalletMobileGuide.jsx";

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
      text = labels.signing || "Awaiting signature — confirm in your wallet.";
      detail = flow.feeSats != null ? (
        <>
          network fee <span className="mono">{fmtInt(flow.feeSats)} sats</span>
          {flow.feeRateSatVb ? ` @ ${flow.feeRateSatVb} sat/vB` : ""}
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

/**
 * "Install …" links for every provider that is not injected (desktop), or
 * one "Connect <name>" / two provider buttons when they are. Shared by the
 * top bar and the ConnectPrompt.
 */
export function ProviderButtons({ wallet, onConnect, size = "btn-sm", className = "" }) {
  const present = (wallet.providers || []).filter((p) => p.present);
  const busy = wallet.status === "connecting" || wallet.status === "detecting";
  if (present.length === 0) {
    return PROVIDER_IDS.map((id) => (
      <a key={id} className={`btn btn-primary ${size} ${className}`.trim()} href={PROVIDER_META[id].installUrl} target="_blank" rel="noopener noreferrer">
        Install {PROVIDER_META[id].name}
      </a>
    ));
  }
  if (present.length === 1) {
    const p = present[0];
    return (
      <button className={`btn btn-primary ${size} ${className}`.trim()} type="button" onClick={() => onConnect(p.id)} disabled={busy}>
        {wallet.status === "connecting" ? "Connecting…" : `Connect ${p.name}`}
      </button>
    );
  }
  return present.map((p) => (
    <button key={p.id} className={`btn btn-primary ${size} ${className}`.trim()} type="button" onClick={() => onConnect(p.id)} disabled={busy}>
      {p.name}
    </button>
  ));
}

/** "Connect a wallet to …" block with the install / simulated-wallet affordances. */
export function ConnectPrompt({ action = "continue" }) {
  const { wallet, mock, connect, useMock } = useApp();
  // No provider on a phone: the extension links are useless there — point at
  // the wallet apps' built-in browsers instead (simulated wallet stays in mock mode).
  if (wallet.status === "absent" && isMobileBrowser()) {
    return (
      <>
        <WalletMobileGuide
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
  const present = (wallet.providers || []).filter((p) => p.present);
  return (
    <div className="cta">
      <div>
        {wallet.status === "absent"
          ? `A Bitcoin wallet extension (UniSat or OKX Wallet) is required to ${action}. LuckyProtocol never holds keys.`
          : present.length > 1
            ? `Choose a wallet to ${action}. LuckyProtocol never holds keys — every transaction is signed in your wallet.`
            : `Connect ${present[0]?.name || "a wallet"} to ${action}. LuckyProtocol never holds keys — every transaction is signed in your wallet.`}
      </div>
      <div className="row">
        <ProviderButtons wallet={wallet} onConnect={connect} />
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
