// Compatibility shim over src/lib/wallet.js.
//
// The wallet layer grew from UniSat-only to UniSat + OKX Wallet; the
// unified API lives in wallet.js. This module keeps the original names so
// the (unrendered) trading panels and older imports keep working, and
// adapts the one signature that changed (`signPsbt` positional → options).

import * as wallet from "./wallet.js";
import { PROVIDER_META } from "./walletShapes.js";

export const INSTALL_URL = PROVIDER_META.unisat.installUrl;
export const DOWNLOAD_URL = PROVIDER_META.unisat.appUrl;

export {
  isMobileBrowser,
  hasProvider,
  isMockWallet,
  enableMockWallet,
  connect,
  disconnect,
  getBalance,
  getBitcoinUtxos,
  pushPsbt,
  pushTx,
  broadcastSignedPsbt,
  broadcastRawTx,
  isConflictError,
  on,
  providerName,
  providerId,
} from "./wallet.js";

/** Poll for injected providers; resolves to the detection list (truthy when any is present). */
export async function detect(timeoutMs = 2000) {
  const list = await wallet.detectProviders(timeoutMs);
  return list.some((p) => p.present) ? list : null;
}

/** Legacy positional form: signPsbt(psbtHex, inputIndexes, address, { autoFinalized, sighashTypes }). */
export function signPsbt(psbtHex, inputIndexes, address, options = {}) {
  return wallet.signPsbt(psbtHex, { inputIndexes, address, ...options });
}
