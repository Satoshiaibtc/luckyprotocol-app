import { useCallback, useEffect, useState } from "react";
import * as unisat from "../lib/unisat.js";

const IDLE_WALLET = { status: "detecting", address: null, pubkeyHex: null, balance: null, error: null };

export function friendlyError(e) {
  const msg = String(e?.message || e || "unknown error");
  if (/reject|denied|cancel/i.test(msg) && !/cancelled by someone/i.test(msg)) return "Signature declined in UniSat.";
  return msg;
}

/**
 * Wallet state machine: detecting → absent | disconnected → connecting →
 * connected. Reacts to the extension's accountsChanged / networkChanged.
 * `onDisconnect` lets callers reset in-flight flows.
 */
export function useWallet({ onDisconnect } = {}) {
  const [wallet, setWallet] = useState(IDLE_WALLET);

  useEffect(() => {
    let alive = true;
    unisat.detect(2000).then((p) => {
      if (alive) setWallet((w) => ({ ...w, status: p ? "disconnected" : "absent" }));
    });
    return () => {
      alive = false;
    };
  }, []);

  const refreshBalance = useCallback(async () => {
    try {
      const b = await unisat.getBalance();
      setWallet((w) => (w.status === "connected" ? { ...w, balance: b.total } : w));
    } catch {
      /* balance is cosmetic */
    }
  }, []);

  const connect = useCallback(async () => {
    setWallet((w) => ({ ...w, status: "connecting", error: null }));
    try {
      const { address, pubkeyHex } = await unisat.connect();
      setWallet({ status: "connected", address, pubkeyHex, balance: null, error: null });
      refreshBalance();
    } catch (e) {
      setWallet((w) => ({ ...w, status: unisat.hasProvider() ? "disconnected" : "absent", error: friendlyError(e) }));
    }
  }, [refreshBalance]);

  const disconnect = useCallback(() => {
    setWallet((w) => ({ ...IDLE_WALLET, status: unisat.hasProvider() ? "disconnected" : "absent", error: w.error }));
    onDisconnect?.();
  }, [onDisconnect]);

  const useMock = useCallback(() => {
    try {
      unisat.enableMockWallet();
      connect();
    } catch (e) {
      setWallet((w) => ({ ...w, error: friendlyError(e) }));
    }
  }, [connect]);

  // Account / network changes from the extension.
  useEffect(() => {
    if (wallet.status !== "connected") return undefined;
    const offAcc = unisat.on("accountsChanged", (accounts) => {
      const next = Array.isArray(accounts) ? accounts[0] : null;
      if (!next) disconnect();
      else if (next !== wallet.address) connect();
    });
    const offNet = unisat.on("networkChanged", (net) => {
      if (net && net !== "livenet") {
        setWallet((w) => ({ ...w, status: "disconnected", address: null, pubkeyHex: null, balance: null, error: `UniSat switched to "${net}" — LuckyProtocol is mainnet only.` }));
        onDisconnect?.();
      }
    });
    return () => {
      offAcc();
      offNet();
    };
  }, [wallet.status, wallet.address, connect, disconnect, onDisconnect]);

  const connected = wallet.status === "connected";
  return {
    wallet,
    connected,
    address: connected ? wallet.address : null,
    pubkeyHex: connected ? wallet.pubkeyHex : null,
    connect,
    disconnect,
    useMock,
    refreshBalance,
  };
}
