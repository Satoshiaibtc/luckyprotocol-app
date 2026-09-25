import { fmtInt, txUrl, shortTxid } from "../lib/format.js";
import { MIN_FEE_INPUT_SATS_UNSAFE } from "../lib/psbt.js";
import { isMobileBrowser } from "../lib/wallet.js";
import { useApp } from "../context.js";

/**
 * The inputs a PSBT is about to spend, shown at signing time (audit M-8).
 * With an asset-safe list it is a plain listing; without one it carries
 * the warning that any of these outputs could hold Ordinals or Runes the
 * indexer cannot see (inscriptions are excluded when the wallet can list
 * them; outputs under the floor are never used).
 */
export function SpentInputs({ inputs, assetSafe }) {
  if (!Array.isArray(inputs) || inputs.length === 0) return null;
  const unsafe = assetSafe !== true;
  return (
    <div className={`spent-inputs${unsafe ? " warn" : ""}`}>
      <span className="label">Spending</span>{" "}
      {inputs.map((u, i) => (
        <span key={`${u.txid}:${u.vout}`} className="mono" title={`${u.txid}:${u.vout}`}>
          {i ? " · " : ""}
          {shortTxid(u.txid, 6, 4)}:{u.vout} ({fmtInt(u.sats)} sats)
        </span>
      ))}
      {unsafe ? (
        <span className="muted">
          {" "}— this wallet has no asset-safe UTXO list: {assetSafe === "inscriptions-only" ? "inscriptions the wallet lists are excluded and Runes cannot be detected" : "Ordinals or Runes on these outputs cannot be detected"}; outputs under {fmtInt(MIN_FEE_INPUT_SATS_UNSAFE)} sats are never used.
        </span>
      ) : null}
    </div>
  );
}

/**
 * One status line for every sign-and-broadcast flow (buy / sell / split /
 * cancel / create). `flow` = { phase, txid, error, feeSats, detail, inputs, assetSafe } with
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
          <SpentInputs inputs={flow.inputs} assetSafe={flow.assetSafe} />
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
 * "Connect a wallet to …" block: one Connect Wallet button that opens the
 * wallet dialog (provider cards, install links, phone guidance, simulated
 * wallet in mock mode all live there).
 */
export function ConnectPrompt({ action = "continue" }) {
  const { wallet, openWalletModal } = useApp();
  const phone = wallet.status === "absent" && isMobileBrowser();
  const detecting = wallet.status === "detecting";
  return (
    <div className="cta">
      <div>
        {phone
          ? `No wallet detected in this browser. To ${action}, open this site inside the UniSat app or the OKX Wallet app — Connect Wallet shows how. LuckyProtocol never holds keys.`
          : `A Bitcoin wallet (UniSat or OKX Wallet) is required to ${action}. LuckyProtocol never holds keys — every transaction is signed in your wallet.`}
      </div>
      <div className="row">
        <button className="btn btn-primary" type="button" onClick={openWalletModal} disabled={detecting} aria-haspopup="dialog">
          {wallet.status === "connecting" ? "Connecting…" : detecting ? "Detecting wallets…" : "Connect Wallet"}
        </button>
      </div>
      {wallet.error && <div className="err">{wallet.error}</div>}
    </div>
  );
}
