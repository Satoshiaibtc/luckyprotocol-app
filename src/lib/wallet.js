// Multi-wallet provider layer (PROTOCOL-v3.md §6): UniSat + OKX Wallet,
// plus the simulated provider in mock mode.
//
// The app holds no keys. Every key operation is delegated to whichever
// provider the user picked:
//
//   unisat  window.unisat               (extension on desktop; injected in the UniSat app's browser)
//   okx     window.okxwallet.bitcoin    (extension on desktop; injected in the OKX app's DApp browser)
//   mock    in-memory provider          (VITE_MOCK=1 only; REALLY signs with the public-seed mock key)
//
// The per-provider API differences (argument shapes, missing methods) are
// isolated in src/lib/walletShapes.js and in `connect()` below. Everything
// the rest of the app sees is one uniform surface:
//
//   detectProviders() → [{ id, name, present }]
//   connect(id) / restoreSession() / disconnect()
//   getBalance() / getBitcoinUtxos(addr) → { source, assetSafe, utxos }
//   signPsbt(hex, { inputIndexes, address, autoFinalized, sighashTypes })
//   pushPsbt(hex) / pushTx(rawHex) / broadcastSignedPsbt / broadcastRawTx
//   on(event, handler) / providerName() / providerId()
//
// The chosen provider id is the ONLY thing persisted ('lp.wallet'), and a
// page load reconnects silently only when the provider already reports an
// authorized account (`getAccounts()`), never by popping the wallet.

import * as indexer from "./indexer.js";
import { MOCK_WALLET, mockSignPsbt } from "./mock.js";
import { assertSingleOpReturn, extractRawTxHex } from "./psbt.js";
import {
  PROVIDER_IDS,
  PROVIDER_META,
  WALLET_STORAGE_KEY,
  defaultProviderId,
  firstAccount,
  isConflictError,
  normalizeBalance,
  normalizePubkey,
  normalizeTxid,
  normalizeUtxoList,
  providerMeta,
  pushTxArgs,
  shouldRestore,
  signPsbtArgs,
} from "./walletShapes.js";

export { PROVIDER_IDS, PROVIDER_META, providerMeta, isConflictError, WALLET_STORAGE_KEY };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * True on phone / tablet browsers, where no extension can be installed and
 * the way in is a wallet app's built-in browser. UA sniff first (Android,
 * iOS, iPadOS-as-Mac with touch), then `pointer: coarse` as the fallback.
 */
export function isMobileBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && Number(navigator.maxTouchPoints) > 1) return true;
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

// ---- injected objects ------------------------------------------------------------------

const INJECTED = {
  unisat: () => (typeof window !== "undefined" && window.unisat ? window.unisat : null),
  okx: () => (typeof window !== "undefined" && window.okxwallet && window.okxwallet.bitcoin ? window.okxwallet.bitcoin : null),
};

let mockProvider = null; // set by enableMockWallet()
let detected = []; // last detectProviders() result
let current = null; // { id, provider }

function injected(id) {
  if (id === "mock") return mockProvider;
  const get = INJECTED[id];
  return get ? get() : null;
}

function snapshot() {
  return PROVIDER_IDS.map((id) => ({ id, name: PROVIDER_META[id].name, present: !!injected(id) }));
}

/**
 * Poll for the injected providers (extensions and in-app browsers inject
 * asynchronously after the document loads). Returns once both are present,
 * or `timeoutMs` after start, or ~400 ms after the first one shows up (so a
 * second, slower injector still gets a chance). → [{ id, name, present }]
 */
export async function detectProviders(timeoutMs = 2000) {
  const start = Date.now();
  let firstSeenAt = null;
  for (;;) {
    detected = snapshot();
    const n = detected.filter((p) => p.present).length;
    if (n === PROVIDER_IDS.length) break;
    if (n > 0 && firstSeenAt === null) firstSeenAt = Date.now();
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) break;
    if (firstSeenAt !== null && Date.now() - firstSeenAt >= 400) break;
    await sleep(100);
  }
  return detected.slice();
}

/** Last detection result (synchronous). */
export function providersPresent() {
  return detected.slice();
}

function presentIds() {
  const ids = snapshot().filter((p) => p.present).map((p) => p.id);
  if (mockProvider) ids.push("mock");
  return ids;
}

/** True when a real provider is injected (the mock is opt-in every time, so it does not count). */
export function hasProvider() {
  return snapshot().some((p) => p.present);
}

export function providerId() {
  return current ? current.id : null;
}
export function providerName() {
  return current ? PROVIDER_META[current.id].name : null;
}
export function isMockWallet() {
  return !!current && current.id === "mock";
}
export function isConnected() {
  return current !== null;
}

// ---- mock provider (VITE_MOCK=1 only) -------------------------------------------------

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
    // Deliberately absent: getBitcoinUtxos — exercises the indexer fallback
    // (and the "no asset-safe UTXO list" notice) exactly like OKX does.
    async signPsbt(psbtHex, opts = {}) {
      await sleep(900); // stands in for the extension's approval popup
      return mockSignPsbt(psbtHex, opts);
    },
    async pushPsbt(psbtHex) {
      return indexer.broadcast(extractRawTxHex(psbtHex));
    },
    async pushTx(rawHex) {
      return indexer.broadcast(rawHex);
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
  if (!mockProvider) mockProvider = makeMockProvider();
  return mockProvider;
}

// ---- storage -----------------------------------------------------------------------------

function readStored() {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(WALLET_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}
function writeStored(id) {
  try {
    if (typeof localStorage === "undefined") return;
    if (id) localStorage.setItem(WALLET_STORAGE_KEY, id);
    else localStorage.removeItem(WALLET_STORAGE_KEY);
  } catch {
    /* private mode / blocked storage — the session just won't persist */
  }
}

// ---- connect / disconnect ------------------------------------------------------------------

function need() {
  if (!current) throw new Error("No wallet connected");
  return current.provider;
}

function nameOf(id) {
  return providerMeta(id)?.name || "wallet";
}

/**
 * Connect to `id` ("unisat" | "okx" | "mock"; omitted → the connected one
 * or the only injected one). Requests accounts, reads the public key and
 * ensures mainnet. With `silent: true` (page-load restore) nothing may pop
 * up: accounts come from `getAccounts()` and a wrong network is an error
 * instead of a switch prompt.
 *
 * → { address, pubkeyHex, network, providerId, providerName, assetSafe }
 */
export async function connect(id, { silent = false } = {}) {
  const pid = typeof id === "string" && id ? id : defaultProviderId(providerId(), presentIds());
  if (!pid) throw new Error("Choose a wallet to connect");
  if (!providerMeta(pid)) throw new Error(`Unknown wallet "${pid}"`);
  if (pid === "mock" && !mockProvider) enableMockWallet();
  const p = injected(pid);
  const name = nameOf(pid);
  if (!p) throw new Error(`${name} is not installed in this browser`);

  let address = null;
  let pubkeyHex = null;
  if (silent) {
    if (typeof p.getAccounts !== "function") return null;
    address = firstAccount(await p.getAccounts());
    if (!address) return null;
  } else if (typeof p.connect === "function" && pid === "okx") {
    // OKX: connect() → { address, publicKey } in one prompt.
    const res = await p.connect();
    address = firstAccount(res);
    pubkeyHex = normalizePubkey(res?.publicKey);
  } else {
    address = firstAccount(await p.requestAccounts());
  }
  if (!address) throw new Error(`${name} returned no account — unlock the wallet and try again`);

  let network = "livenet";
  if (typeof p.getNetwork === "function") {
    try {
      network = String(await p.getNetwork() || "livenet");
    } catch {
      network = "livenet"; // older builds
    }
  }
  if (network !== "livenet") {
    if (!silent && typeof p.switchNetwork === "function") {
      await p.switchNetwork("livenet");
      network = "livenet";
    } else {
      throw new Error(`${name} is on "${network}" — LuckyProtocol is mainnet only; switch to livenet`);
    }
  }

  if (!pubkeyHex) pubkeyHex = normalizePubkey(await p.getPublicKey());
  if (!pubkeyHex) throw new Error(`${name} returned an unexpected public key format`);

  current = { id: pid, provider: p };
  writeStored(pid);
  return { address, pubkeyHex, network, providerId: pid, providerName: name, assetSafe: typeof p.getBitcoinUtxos === "function" };
}

/**
 * Page-load reconnect: only when 'lp.wallet' names a provider that is
 * injected right now AND it already reports an authorized account. Never
 * opens the wallet. → session | null
 */
export async function restoreSession() {
  const stored = readStored();
  if (stored === "mock") {
    if (!indexer.isMock()) {
      writeStored(null);
      return null;
    }
    enableMockWallet();
  } else if (!shouldRestore(stored, presentIds())) {
    return null;
  }
  const session = await connect(stored, { silent: true });
  return session || null;
}

export function disconnect() {
  current = null;
  writeStored(null);
}

// ---- wallet operations ---------------------------------------------------------------------

/** { confirmed, unconfirmed, total } in sats. */
export async function getBalance() {
  return normalizeBalance(await need().getBalance());
}

/**
 * Spendable BTC UTXOs as `[{ txid, vout, sats }]`.
 *
 * `assetSafe:true` when the provider offers its own asset-aware list
 * (UniSat `getBitcoinUtxos()` excludes inscription / rune carriers).
 * OKX has no such method (the mock omits it on purpose), so the rows come
 * from the indexer's `/btc-utxos/:addr` CONFIRMED set with `assetSafe:false`
 * — the UI warns that Ordinals / Runes on that address could be spent as
 * fees. Either way the PSBT builder applies the §4 filter (≤546 sats +
 * token outpoints) on top.
 */
export async function getBitcoinUtxos(address) {
  const p = need();
  const name = providerName();
  if (typeof p.getBitcoinUtxos === "function") {
    let raw;
    try {
      raw = await p.getBitcoinUtxos();
    } catch (e) {
      throw new Error(`${name} getBitcoinUtxos failed: ${e?.message || e}`);
    }
    return { source: current.id, assetSafe: true, utxos: normalizeUtxoList(raw) };
  }
  const rows = await indexer.btcUtxos(address);
  return {
    source: "indexer",
    assetSafe: false,
    utxos: rows.filter((u) => u.confirmed).map(({ txid, vout, sats }) => ({ txid, vout, sats })),
  };
}

/**
 * Sign every input in `inputIndexes` with `address`.
 *
 *   autoFinalized (default true)  — false for a §7.1 listing, whose lone
 *                                   input must stay un-finalized
 *   sighashTypes  (default unset) — e.g. [0x83] for a listing; providers
 *                                   refuse non-default sighashes unless
 *                                   they are declared here
 *
 * Returns the signed PSBT hex.
 */
export async function signPsbt(psbtHex, { inputIndexes, address, autoFinalized = true, sighashTypes } = {}) {
  const p = need();
  const args = signPsbtArgs(current.id, psbtHex, { inputIndexes, address, autoFinalized, sighashTypes });
  const signed = await p.signPsbt(...args);
  if (typeof signed !== "string" || !/^[0-9a-f]+$/i.test(signed) || signed.length % 2 !== 0) {
    throw new Error(`${providerName()} returned an unexpected signPsbt result`);
  }
  return signed.toLowerCase();
}

/** Broadcast a signed PSBT via the provider. Returns the txid. */
export async function pushPsbt(signedPsbtHex) {
  const p = need();
  if (typeof p.pushPsbt !== "function") throw new Error(`${providerName()} pushPsbt is not available`);
  const txid = normalizeTxid(await p.pushPsbt(signedPsbtHex));
  if (!txid) throw new Error(`${providerName()} pushPsbt returned an unexpected value`);
  return txid;
}

/** Broadcast a raw signed tx via the provider (argument shape per provider). Returns the txid. */
export async function pushTx(rawHex) {
  const p = need();
  if (typeof p.pushTx !== "function") throw new Error(`${providerName()} pushTx is not available in this version`);
  const txid = normalizeTxid(await p.pushTx(...pushTxArgs(current.id, rawHex)));
  if (!txid) throw new Error(`${providerName()} pushTx returned an unexpected value`);
  return txid;
}

function _msg(e) {
  return String(e?.message || e || "unknown error");
}

/**
 * Broadcast a finalized PSBT: provider `pushPsbt` first, then the indexer's
 * `/broadcast` relay with the extracted raw tx. Throws with both reasons if
 * both fail.
 */
export async function broadcastSignedPsbt(signedPsbtHex) {
  // Extract first: a PSBT that does not finalize, or a finalized tx with
  // more than one OP_RETURN output (M-3), never reaches any relay.
  const raw = extractRawTxHex(signedPsbtHex);
  try {
    return await pushPsbt(signedPsbtHex);
  } catch (pushErr) {
    try {
      return await indexer.broadcast(raw);
    } catch (bErr) {
      throw new Error(`${_msg(pushErr)} · indexer relay: ${_msg(bErr)}`);
    }
  }
}

/**
 * Broadcast a raw tx: provider `pushTx` first, then the indexer's
 * `/broadcast` relay. A node rejection surfaces from BOTH paths, so the
 * caller can detect a double-spend race (see isConflictError).
 */
export async function broadcastRawTx(rawHex) {
  assertSingleOpReturn(rawHex);
  try {
    return await pushTx(rawHex);
  } catch (pushErr) {
    try {
      return await indexer.broadcast(rawHex);
    } catch (bErr) {
      const err = new Error(`${_msg(pushErr)} · indexer relay: ${_msg(bErr)}`);
      err.conflict = isConflictError(pushErr) || isConflictError(bErr);
      throw err;
    }
  }
}

/**
 * Subscribe to 'accountsChanged' | 'networkChanged' on the CONNECTED
 * provider. Returns an unsubscribe function. No-op when nothing is connected.
 */
export function on(event, handler) {
  const p = current ? current.provider : null;
  if (!p || typeof p.on !== "function") return () => {};
  p.on(event, handler);
  return () => {
    try {
      if (typeof p.removeListener === "function") p.removeListener(event, handler);
    } catch { /* ignore */ }
  };
}
