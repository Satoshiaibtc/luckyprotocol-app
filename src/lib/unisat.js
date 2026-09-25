// UniSat wallet adapter (PROTOCOL-v3.md §6).
//
// The app holds no keys. Everything key-related is delegated to the
// `window.unisat` provider injected by the UniSat browser extension:
//
//   requestAccounts()     → connect, returns [address]
//   getPublicKey()        → 33-byte compressed pubkey hex
//   getNetwork()          → 'livenet' | 'testnet'
//   switchNetwork(net)
//   getBalance()          → { confirmed, unconfirmed, total } sats
//   getBitcoinUtxos()     → asset-safe BTC UTXO list (feature-detected)
//   signPsbt(hex, opts)   → signed (finalized) PSBT hex
//   pushPsbt(hex)         → txid
//   on / removeListener   → 'accountsChanged' | 'networkChanged'
//
// Mock mode (VITE_MOCK=1) without the extension installed can opt into a
// simulated provider (`enableMockWallet`) so the whole MINE state machine
// is demoable; it is never enabled automatically.

import * as indexer from "./indexer.js";
import { MOCK_WALLET } from "./mock.js";

export const INSTALL_URL = "https://unisat.io";

let provider = null;
let providerIsMock = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll for the injected provider for up to `timeoutMs` (extensions inject
 * asynchronously after the document loads). Returns the provider or null.
 */
export async function detect(timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof window !== "undefined" && window.unisat) {
      provider = window.unisat;
      providerIsMock = false;
      return provider;
    }
    await sleep(100);
  }
  if (typeof window !== "undefined" && window.unisat) {
    provider = window.unisat;
    providerIsMock = false;
    return provider;
  }
  return null;
}

export function getProvider() {
  return provider;
}
export function isMockWallet() {
  return providerIsMock;
}
export function hasProvider() {
  return provider !== null;
}

// ---- mock provider (VITE_MOCK=1 only) ------------------------------------------------

function makeMockProvider() {
  const listeners = new Map();
  return {
    __luckyprotocolMock: true,
    async requestAccounts() {
      await sleep(300);
      return [MOCK_WALLET.address];
    },
    async getAccounts() {
      return [MOCK_WALLET.address];
    },
    async getPublicKey() {
      return MOCK_WALLET.pubkeyHex;
    },
    async getNetwork() {
      return "livenet";
    },
    async switchNetwork() {
      return "livenet";
    },
    async getBalance() {
      const rows = await indexer.btcUtxos(MOCK_WALLET.address);
      const confirmed = rows.filter((u) => u.confirmed).reduce((s, u) => s + u.sats, 0);
      const unconfirmed = rows.filter((u) => !u.confirmed).reduce((s, u) => s + u.sats, 0);
      return { confirmed, unconfirmed, total: confirmed + unconfirmed };
    },
    // Deliberately absent: getBitcoinUtxos — exercises the indexer fallback.
    async signPsbt(psbtHex) {
      await sleep(900); // stands in for the extension's approval popup
      return psbtHex;
    },
    async pushPsbt() {
      throw new Error("mock wallet cannot broadcast — use indexer.broadcast()");
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    removeListener(event, fn) {
      listeners.get(event)?.delete(fn);
    },
  };
}

/** Opt into the simulated provider. Only allowed in mock mode. */
export function enableMockWallet() {
  if (!indexer.isMock()) throw new Error("mock wallet is only available with VITE_MOCK=1");
  provider = makeMockProvider();
  providerIsMock = true;
  return provider;
}

// ---- wallet operations -------------------------------------------------------------------

function need() {
  if (!provider) throw new Error("UniSat wallet not detected");
  return provider;
}

/**
 * Connect: request accounts, read the public key, and ensure mainnet
 * (switch to 'livenet' if the extension is on another network).
 */
export async function connect() {
  const p = need();
  const accounts = await p.requestAccounts();
  const address = Array.isArray(accounts) ? accounts[0] : null;
  if (!address || typeof address !== "string") {
    throw new Error("UniSat returned no account — unlock the wallet and try again");
  }
  let network = "livenet";
  try {
    network = await p.getNetwork();
  } catch { /* older extensions */ }
  if (network !== "livenet") {
    if (typeof p.switchNetwork === "function") {
      await p.switchNetwork("livenet");
      network = "livenet";
    } else {
      throw new Error(`UniSat is on "${network}" — LuckyProtocol is mainnet only; switch to livenet`);
    }
  }
  const pubkeyHex = String(await p.getPublicKey() || "").toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(pubkeyHex)) {
    throw new Error("UniSat returned an unexpected public key format");
  }
  return { address, pubkeyHex, network };
}

/** { confirmed, unconfirmed, total } in sats. */
export async function getBalance() {
  const b = await need().getBalance();
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  return { confirmed: n(b?.confirmed), unconfirmed: n(b?.unconfirmed), total: n(b?.total) };
}

const _TXID_RE = /^[0-9a-f]{64}$/i;

function _normalizeUnisatUtxo(u) {
  if (!u || typeof u !== "object") return null;
  const txid = String(u.txid || "").toLowerCase();
  const vout = Number(u.vout);
  const sats = Number(u.satoshis ?? u.satoshi ?? u.value ?? u.sats);
  if (!_TXID_RE.test(txid) || !Number.isInteger(vout) || vout < 0) return null;
  if (!Number.isInteger(sats) || sats < 0) return null;
  return { txid, vout, sats };
}

/**
 * Spendable BTC UTXOs as `[{ txid, vout, sats }]`.
 *
 * Prefers `unisat.getBitcoinUtxos()` — UniSat's own asset-safe list (it
 * already excludes inscription / rune carriers). If the method is missing
 * (older extension, mock provider), falls back to the indexer's
 * `/btc-utxos/:addr` CONFIRMED rows. Either way the PSBT builder still
 * applies the §4 filter (≤546 sats + token outpoints) on top.
 */
export async function getBitcoinUtxos(address) {
  const p = need();
  if (typeof p.getBitcoinUtxos === "function") {
    let raw;
    try {
      raw = await p.getBitcoinUtxos();
    } catch (e) {
      throw new Error(`UniSat getBitcoinUtxos failed: ${e?.message || e}`);
    }
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : [];
    return { source: "unisat", utxos: list.map(_normalizeUnisatUtxo).filter(Boolean) };
  }
  const rows = await indexer.btcUtxos(address);
  return {
    source: "indexer",
    utxos: rows.filter((u) => u.confirmed).map(({ txid, vout, sats }) => ({ txid, vout, sats })),
  };
}

/**
 * Sign every input in `inputIndexes` with `address` and finalize.
 * Returns the signed PSBT hex (finalized, ready for pushPsbt / extract).
 */
export async function signPsbt(psbtHex, inputIndexes, address) {
  const p = need();
  const opts = {
    autoFinalized: true,
    toSignInputs: inputIndexes.map((index) => ({ index, address })),
  };
  const signed = await p.signPsbt(psbtHex, opts);
  if (typeof signed !== "string" || !/^[0-9a-f]+$/i.test(signed)) {
    throw new Error("UniSat returned an unexpected signPsbt result");
  }
  return signed.toLowerCase();
}

/** Broadcast a signed PSBT via the extension. Returns the txid. */
export async function pushPsbt(signedPsbtHex) {
  const txid = String(await need().pushPsbt(signedPsbtHex) || "").toLowerCase();
  if (!_TXID_RE.test(txid)) throw new Error(`UniSat pushPsbt returned an unexpected value`);
  return txid;
}

/**
 * Subscribe to 'accountsChanged' | 'networkChanged'. Returns an
 * unsubscribe function. No-op when no provider is present.
 */
export function on(event, handler) {
  const p = provider;
  if (!p || typeof p.on !== "function") return () => {};
  p.on(event, handler);
  return () => {
    try {
      if (typeof p.removeListener === "function") p.removeListener(event, handler);
    } catch { /* ignore */ }
  };
}
