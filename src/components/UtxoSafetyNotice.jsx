import { useEffect, useState } from "react";
import { useApp } from "../context.js";

const KEY_PREFIX = "lp.utxoNotice.";

function readDismissed(providerId) {
  if (!providerId) return false;
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEY_PREFIX + providerId) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(providerId) {
  try {
    if (typeof localStorage !== "undefined" && providerId) localStorage.setItem(KEY_PREFIX + providerId, "1");
  } catch {
    /* private mode — shown again next time */
  }
}

/**
 * One-time, dismissible caveat for providers without an asset-aware UTXO
 * list (OKX Wallet; also the mock): the fee inputs come from the indexer's
 * raw BTC view, so an address holding Ordinals or Runes could see those
 * outputs spent as fees. Dismissal persists per provider in localStorage.
 */
export default function UtxoSafetyNotice() {
  const { wallet } = useApp();
  const [dismissed, setDismissed] = useState(() => readDismissed(wallet.provider));
  useEffect(() => {
    setDismissed(readDismissed(wallet.provider));
  }, [wallet.provider]);

  if (wallet.status !== "connected" || wallet.assetSafe !== false || dismissed) return null;
  const name = wallet.providerName || "This wallet";
  return (
    <div className="notice notice-row" role="note">
      <span>
        {name} does not expose an asset-safe UTXO list. Use an address that holds no Ordinals or Runes, or those outputs could be spent as network fees.
      </span>
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        onClick={() => {
          writeDismissed(wallet.provider);
          setDismissed(true);
        }}
        aria-label="Dismiss this notice"
      >
        Got it
      </button>
    </div>
  );
}
