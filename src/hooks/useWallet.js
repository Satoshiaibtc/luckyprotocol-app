import { useCallback, useEffect, useState } from "react";
import * as wallet from "../lib/wallet.js";

const IDLE_WALLET = {
  status: "detecting",
  address: null,
  pubkeyHex: null,
  balance: null,
  error: null,
  provider: null, // "unisat" | "okx" | "mock"
  providerName: null,
  assetSafe: null, // false when UTXOs come from the indexer (no asset-aware wallet list)
  providers: [], // [{ id, name, present }] from detection
};

export function friendlyError(e) {
  const msg = String(e?.message || e || "unknown error");
  if (/reject|denied|cancel/i.test(msg) && !/cancelled by someone/i.test(msg)) return "Signature declined in the wallet.";
  return msg;
}

/**
 * Wallet state machine: detecting → absent | disconnected → connecting →
 * connected. Detects UniSat and OKX Wallet, restores the last session
 * silently (never pops the wallet on load), and reacts to the provider's
 * accountsChanged / networkChanged. `onDisconnect` lets callers reset
 * in-flight flows.
 */
export function useWallet({ onDisconnect } = {}) {
  const [w, setWallet] = useState(IDLE_WALLET);

  const refreshBalance = useCallback(async () => {
    try {
      const b = await wallet.getBalance();
      setWallet((s) => (s.status === "connected" ? { ...s, balance: b.total } : s));
    } catch {
      /* balance is cosmetic */
    }
  }, []);

  const applySession = useCallback(
    (s) => {
      setWallet((prev) => ({
        ...prev,
        status: "connected",
        address: s.address,
        pubkeyHex: s.pubkeyHex,
        balance: null,
        error: null,
        provider: s.providerId,
        providerName: s.providerName,
        assetSafe: s.assetSafe,
      }));
      refreshBalance();
    },
    [refreshBalance],
  );

  // Detect the injected providers, then try a silent restore of the last session.
  useEffect(() => {
    let alive = true;
    (async () => {
      const providers = await wallet.detectProviders(2000);
      if (!alive) return;
      setWallet((s) => ({ ...s, providers, status: providers.some((p) => p.present) ? "disconnected" : "absent" }));
      try {
        const session = await wallet.restoreSession();
        if (alive && session) applySession(session);
      } catch (e) {
        if (alive) setWallet((s) => ({ ...s, error: friendlyError(e) }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [applySession]);

  /** `connect("okx")`; with no id the only injected provider (or the current one) is used. */
  const connect = useCallback(
    async (providerId) => {
      const id = typeof providerId === "string" ? providerId : undefined;
      setWallet((s) => ({ ...s, status: "connecting", error: null }));
      try {
        const session = await wallet.connect(id);
        applySession(session);
      } catch (e) {
        setWallet((s) => ({
          ...s,
          status: wallet.hasProvider() ? "disconnected" : "absent",
          address: null,
          pubkeyHex: null,
          balance: null,
          provider: null,
          providerName: null,
          assetSafe: null,
          error: friendlyError(e),
        }));
      }
    },
    [applySession],
  );

  const disconnect = useCallback(() => {
    wallet.disconnect();
    setWallet((s) => ({ ...IDLE_WALLET, providers: s.providers, status: wallet.hasProvider() ? "disconnected" : "absent", error: s.error }));
    onDisconnect?.();
  }, [onDisconnect]);

  const useMock = useCallback(() => {
    try {
      wallet.enableMockWallet();
      connect("mock");
    } catch (e) {
      setWallet((s) => ({ ...s, error: friendlyError(e) }));
    }
  }, [connect]);

  // Account / network changes from the connected provider.
  useEffect(() => {
    if (w.status !== "connected") return undefined;
    const offAcc = wallet.on("accountsChanged", (accounts) => {
      const next = Array.isArray(accounts) ? accounts[0] : null;
      if (!next) disconnect();
      else if (next !== w.address) connect(w.provider);
    });
    const offNet = wallet.on("networkChanged", (net) => {
      if (net && net !== "livenet") {
        wallet.disconnect();
        setWallet((s) => ({
          ...s,
          status: "disconnected",
          address: null,
          pubkeyHex: null,
          balance: null,
          provider: null,
          providerName: null,
          assetSafe: null,
          error: `${w.providerName || "The wallet"} switched to "${net}" — LuckyProtocol is mainnet only.`,
        }));
        onDisconnect?.();
      }
    });
    return () => {
      offAcc();
      offNet();
    };
  }, [w.status, w.address, w.provider, w.providerName, connect, disconnect, onDisconnect]);

  const connected = w.status === "connected";
  return {
    wallet: w,
    connected,
    address: connected ? w.address : null,
    pubkeyHex: connected ? w.pubkeyHex : null,
    connect,
    disconnect,
    useMock,
    refreshBalance,
  };
}
