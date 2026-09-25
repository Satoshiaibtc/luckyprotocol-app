import { createContext, useContext } from "react";

/**
 * App-wide state supplied by App.jsx: wallet + connect/disconnect, indexer
 * health, fee estimates (`fees`) and the user's fee-rate choice (`fee`, see
 * useFeeRate), the token registry poll, routing, and the mock flag.
 */
export const AppContext = createContext(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppContext.Provider>");
  return ctx;
}
