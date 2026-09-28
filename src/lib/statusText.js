// Idle status lines shared by the mine console and the Create page — pure,
// tested in test/flows.test.js.

import { MIN_FEE_INPUT_SATS_UNSAFE } from "./psbt.js";
import { lockedHint } from "./activation.js";

/**
 * The "Ready" line. A wallet without an asset-safe UTXO list (OKX, the
 * simulated wallet) is told plainly what that means BEFORE its first
 * transaction (spec §6: the app warns OKX users; audit mine-8) — not only
 * in the signing detail, while the wallet's own popup has the attention.
 */
export function readyText(assetSafe, action) {
  if (assetSafe === true) return "Ready. Fee inputs are selected from spendable BTC only — dust and token-bearing outputs are never spent.";
  return (
    `Ready to ${String(action).toLowerCase()}. This wallet has no asset-safe UTXO list: LUCKY-20 carriers and outputs of ` +
    `${MIN_FEE_INPUT_SATS_UNSAFE.toLocaleString("en-US")} sats or less are skipped, but Ordinals or Runes on larger outputs cannot be detected — use an address that holds none.`
  );
}

/**
 * Why the MINE button is off while idle (audit visit-6 / mine-7), or null
 * when nothing but the fee rate stops it. The order is the order of the
 * notices above the button.
 */
export function mineIdleReason({ connected, indexerOk, preActivation, exhausted, lagText, ticker }) {
  if (!connected) return "Connect a wallet to mine.";
  if (!indexerOk) return "Indexer offline — mining paused until it is reachable.";
  if (preActivation) return lockedHint();
  if (exhausted) return `${ticker} is fully minted — mining is closed; a MINE would credit 0.`;
  if (lagText) return "Paused until the indexer catches up with the chain tip (see above).";
  return null;
}
