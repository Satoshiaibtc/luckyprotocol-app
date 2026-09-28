import { createContext, useContext } from "react";

/**
 * App-wide state supplied by App.jsx: wallet + connect/disconnect, the
 * wallet dialog (`walletModalOpen`, `openWalletModal`, `closeWalletModal`),
 * indexer health, fee estimates (`fees`) and the user's fee-rate choice
 * (`fee`, see useFeeRate), the USD price poll (`price` — `data.usd_per_btc`
 * is null whenever USD must not be shown), the token registry poll,
 * routing, and the mock flag.
 */
export const AppContext = createContext(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppContext.Provider>");
  return ctx;
}
