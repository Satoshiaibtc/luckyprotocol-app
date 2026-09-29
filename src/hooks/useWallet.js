import { useCallback, useEffect, useRef, useState } from "react";
import * as wallet from "../lib/wallet.js";

/** While connected, the balance is re-read this often (and on focus / tab-visible / after a broadcast). */
export const BALANCE_POLL_MS = 60_000;
/** A second read after a broadcast: the provider's own balance API can lag the node by a few seconds. */
const BALANCE_AFTER_BROADCAST_MS = 5_000;

const IDLE_WALLET = {
  status: "detecting",
  address: null,
  pubkeyHex: null,
  balance: null, // total sats (confirmed + unconfirmed), as the wallet reports it
  balanceConfirmed: null, // the confirmed part — fee inputs are confirmed outputs only
  switching: null, // provider id of a "Switch to …" in progress; the current session stays live meanwhile
  error: null,
  provider: null, // "unisat" | "okx" | "mock"
  providerName: null,
  assetSafe: null, // false when UTXOs come from the indexer (no asset-aware wallet list)
  providers: [], // [{ id, name, present }] from detection
};

/**
 * The message a flow shows for an error. "Declined" is said only for an
 * error the WALLET threw for a prompt the user refused (wallet.walletError
 * tags those) — never for a node rejection that merely contains "reject",
 * e.g. Core's "insufficient fee, rejecting replacement" after a successful
 * signature; that one is shown as what it is.
 */
export function friendlyError(e) {
  const msg = String(e?.message || e || "unknown error");
  if (e?.declined === "connect") return "Connection declined in the wallet.";
  if (e?.declined) return "Signature declined in the wallet.";
  // `conflict` is set by wallet.broadcastSignedPsbt / broadcastRawTx from the node's own answer.
  if (e?.conflict === true) {
    return `The node rejected the transaction: it spends an input that another pending transaction already spends — possibly one of yours that has not confirmed yet. (${msg})`;
  }
  return msg;
}

/**
 * The wallet state after a `connect()` attempt that failed with `message`.
 * A failed or declined SWITCH (`prev` was a live session and the attempt
 * was for another provider) keeps that session exactly as it was, so every
 * in-flight flow keyed on the address survives. Any other
 * failure leaves the wallet disconnected. `hasProvider` = a real provider is
 * injected. Pure; tested in test/wallet.test.js.
 */
export function afterConnectFailure(prev, { attemptedId, message, hasProvider }) {
  const wasSwitch = prev?.status === "connected" && !!prev.address && !!attemptedId && attemptedId !== prev.provider;
  // The error names what is still true, so a notice elsewhere (the mine
  // console shows wallet.error) never reads as "not connected".
  if (wasSwitch) return { ...prev, switching: null, error: `${message}${prev.providerName ? ` Still connected to ${prev.providerName}.` : ""}` };
  return {
    ...prev,
    status: hasProvider ? "disconnected" : "absent",
    address: null,
    pubkeyHex: null,
    balance: null,
    balanceConfirmed: null,
    provider: null,
    providerName: null,
    assetSafe: null,
    switching: null,
    error: message,
  };
}

/**
 * Wallet state machine: detecting → absent | disconnected → connecting →
 * connected. Detects UniSat and OKX Wallet, restores the last session
 * silently (never pops the wallet on load), and reacts to the provider's
 * accountsChanged / networkChanged. `onDisconnect` lets callers reset
 * in-flight flows. A switch to another provider keeps the current session
 * live (`switching`) until the new one is confirmed.
 */
export function useWallet({ onDisconnect } = {}) {
  const [w, setWallet] = useState(IDLE_WALLET);
  const stateRef = useRef(w);
  stateRef.current = w;

  const refreshBalance = useCallback(async () => {
    try {
      const b = await wallet.getBalance();
      setWallet((s) => (s.status === "connected" ? { ...s, balance: b.total, balanceConfirmed: b.confirmed } : s));
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
        // The same account again (a reconnect): keep the balance on screen.
        balance: prev.address === s.address ? prev.balance : null,
        balanceConfirmed: prev.address === s.address ? prev.balanceConfirmed : null,
        switching: null,
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

  /**
   * `connect("okx")`; with no id the only injected provider (or the current
   * one) is used. Resolves `true` on success, `false` on failure (the error
   * lands in `wallet.error`) — callers such as the wallet modal close on true.
   */
  const connect = useCallback(
    async (providerId) => {
      const id = typeof providerId === "string" ? providerId : undefined;
      // Switching away from a live session: keep it (status, address) while
      // the other wallet's prompt is open, so nothing keyed on the address
      // resets unless the switch succeeds with a different address.
      const cur = stateRef.current;
      const live = cur.status === "connected" && !!id && id !== cur.provider;
      setWallet((s) => (live ? { ...s, switching: id, error: null } : { ...s, status: "connecting", switching: null, error: null }));
      try {
        const session = await wallet.connect(id);
        applySession(session);
        return true;
      } catch (e) {
        // wallet.js keeps its previous provider (it switches only on
        // success). When the page ends up disconnected, drop it there too,
        // so storage (lp.wallet) and a reload agree with what is shown.
        if (!live) wallet.disconnect();
        const failure = { attemptedId: id, message: friendlyError(e), hasProvider: wallet.hasProvider() };
        setWallet((s) => afterConnectFailure(s, failure));
        return false;
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
      return connect("mock");
    } catch (e) {
      setWallet((s) => ({ ...s, error: friendlyError(e) }));
      return Promise.resolve(false);
    }
  }, [connect]);

  // Keep the balance current while connected: a slow
  // interval, whenever the tab comes back into view, and right after (and
  // again shortly after) every broadcast of this wallet.
  const connectedNow = w.status === "connected";
  useEffect(() => {
    if (!connectedNow) return undefined;
    let timer = null;
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") refreshBalance();
    }, BALANCE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshBalance();
    };
    const off = wallet.onBroadcast(() => {
      refreshBalance();
      clearTimeout(timer);
      timer = setTimeout(refreshBalance, BALANCE_AFTER_BROADCAST_MS);
    });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(id);
      clearTimeout(timer);
      off();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [connectedNow, refreshBalance]);

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
          balanceConfirmed: null,
          provider: null,
          providerName: null,
          assetSafe: null,
          switching: null,
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
