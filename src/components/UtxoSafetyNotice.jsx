import { useState } from "react";
import { useApp } from "../context.js";
import { MIN_FEE_INPUT_SATS_UNSAFE } from "../lib/psbt.js";
import { DUST_SATS } from "../lib/payloads.js";
import { fmtInt } from "../lib/format.js";

const KEY_PREFIX = "lp.walletSafety.";

// Session-scoped dismissal: once per session per address (sessionStorage is
// per tab and cleared when the tab closes), so the caveat comes back on the
// next visit — never "forever". A blocked storage simply shows it every time.
function readDismissed(address) {
  if (!address) return false;
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(KEY_PREFIX + address) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(address) {
  try {
    if (typeof sessionStorage !== "undefined" && address) sessionStorage.setItem(KEY_PREFIX + address, "1");
  } catch {
    /* private mode — shown again next time */
  }
}

/**
 * The universal wallet-safety notice, shown once per session to EVERY
 * connected wallet. It is rendered app-wide (App.jsx, between the mine
 * ticker and the page) so it appears on Mine / Create / Portfolio and the
 * board alike without any page repeating it: LUCKY-20 tokens sit on
 * 546-sat outputs, and under default routing a BTC spend from this address
 * made with any other wallet (one that does not apply the §4 filter) hands
 * those tokens to whoever receives that transaction's first output — so
 * the address should be dedicated to LUCKY-20.
 *
 * Providers without an asset-aware UTXO list (OKX Wallet; the mock) get a
 * second sentence: fee inputs come from the indexer's raw BTC view, so an
 * address holding Ordinals or Runes could see those outputs spent as fees.
 * Mitigations in force: inscriptions the wallet can list are excluded,
 * outputs under the 10,000-sat floor are never used, and every signing
 * step lists the exact inputs.
 */
export default function UtxoSafetyNotice() {
  const { wallet } = useApp();
  const address = wallet.status === "connected" ? wallet.address : null;
  // Derived during render, not in an effect: the notice is mounted before
  // the wallet restores, and an effect would paint one frame of the notice
  // for an address that already dismissed it this session.
  const [dismissedFor, setDismissedFor] = useState(null);
  const dismissed = !address || dismissedFor === address || readDismissed(address);

  if (dismissed) return null;
  const unsafeList = wallet.assetSafe !== true && wallet.assetSafe !== null;
  const name = wallet.providerName || "This wallet";
  return (
    <div className="app-notice">
      <div className="notice notice-row" role="note">
      <span>
        Your LUCKY-20 tokens sit on {DUST_SATS}-sat outputs at this address. Spending BTC from it with any other wallet can hand those tokens to whoever receives that
        transaction&apos;s first output — keep a dedicated address for LUCKY-20.
        {unsafeList
          ? ` ${name} has no asset-aware UTXO list either: use an address that holds no Ordinals or Runes. Inscriptions the wallet can list are skipped and outputs under ${fmtInt(MIN_FEE_INPUT_SATS_UNSAFE)} sats are never spent, but Runes cannot be detected.`
          : ""}{" "}
        The inputs of every transaction are listed before you sign.
      </span>
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        onClick={() => {
          writeDismissed(address);
          setDismissedFor(address);
        }}
        aria-label="Dismiss this notice for this session"
      >
        Got it
      </button>
      </div>
    </div>
  );
}
