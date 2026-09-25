import { useEffect, useState } from "react";
import { useApp } from "../context.js";
import { MIN_FEE_INPUT_SATS_UNSAFE } from "../lib/psbt.js";
import { fmtInt } from "../lib/format.js";

const KEY_PREFIX = "lp.utxoNotice.";

// Session-scoped dismissal (audit M-8): the caveat comes back on the next
// visit, never "forever". sessionStorage is per tab and cleared when the
// tab closes; a blocked storage simply shows the notice every time.
function readDismissed(providerId) {
  if (!providerId) return false;
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(KEY_PREFIX + providerId) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(providerId) {
  try {
    if (typeof sessionStorage !== "undefined" && providerId) sessionStorage.setItem(KEY_PREFIX + providerId, "1");
  } catch {
    /* private mode — shown again next time */
  }
}

/**
 * Per-session, dismissible caveat for providers without an asset-aware
 * UTXO list (OKX Wallet; also the mock): the fee inputs come from the
 * indexer's raw BTC view, so an address holding Ordinals or Runes could
 * see those outputs spent as fees. Mitigations in force: inscriptions the
 * wallet can list are excluded, outputs under the 10,000-sat floor are
 * never used, and every signing step lists the exact inputs.
 */
export default function UtxoSafetyNotice() {
  const { wallet } = useApp();
  const [dismissed, setDismissed] = useState(() => readDismissed(wallet.provider));
  useEffect(() => {
    setDismissed(readDismissed(wallet.provider));
  }, [wallet.provider]);

  if (wallet.status !== "connected" || wallet.assetSafe === true || wallet.assetSafe === null || dismissed) return null;
  const name = wallet.providerName || "This wallet";
  return (
    <div className="notice notice-row" role="note">
      <span>
        {name} does not expose an asset-safe UTXO list. Use an address that holds no Ordinals or Runes: inscriptions the wallet can list are skipped and outputs under {fmtInt(MIN_FEE_INPUT_SATS_UNSAFE)} sats are never spent, but Runes cannot be detected. The inputs of every transaction are listed before you sign.
      </span>
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        onClick={() => {
          writeDismissed(wallet.provider);
          setDismissed(true);
        }}
        aria-label="Dismiss this notice for this session"
      >
        Got it
      </button>
    </div>
  );
}
