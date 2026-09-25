// Pure, window-free half of the wallet layer: provider metadata and the
// per-provider argument shapes. src/lib/wallet.js (browser) and
// test/wallet.test.js (Node) both import this file, so it must not touch
// `window`, `localStorage` or the indexer module.
//
// Provider API matrix (both providers are UniSat-compatible):
//
//   method                 UniSat (window.unisat)          OKX (window.okxwallet.bitcoin)
//   requestAccounts()      → [address]                     → [address]
//   connect()              —                               → { address, publicKey }
//   getAccounts()          → [address] (no popup)          → [address] (no popup)
//   getPublicKey()         → 33-byte compressed hex        → same
//   getNetwork()           → 'livenet' | 'testnet'         may be absent → assume livenet
//   switchNetwork(net)     present                         may be absent
//   getBalance()           → { confirmed, unconfirmed, total }
//   getBitcoinUtxos()      asset-safe BTC list             ABSENT → indexer fallback, assetSafe:false
//   signPsbt(hex, opts)    opts = { autoFinalized, toSignInputs: [{ index, address | publicKey, sighashTypes?, disableTweakSigner? }] }
//   pushPsbt(hex)          → txid                          → txid
//   pushTx(...)            pushTx({ rawtx })               pushTx(rawHex)
//   on / removeListener    'accountsChanged' | 'networkChanged'

export const WALLET_STORAGE_KEY = "lp.wallet";

export const PROVIDER_META = {
  unisat: {
    id: "unisat",
    name: "UniSat",
    short: "UniSat",
    installUrl: "https://unisat.io",
    appUrl: "https://unisat.io/download",
  },
  okx: {
    id: "okx",
    name: "OKX Wallet",
    short: "OKX",
    installUrl: "https://web3.okx.com/download",
    appUrl: "https://web3.okx.com/download",
  },
  mock: {
    id: "mock",
    name: "Simulated wallet",
    short: "SIM",
    installUrl: null,
    appUrl: null,
  },
};

/** The two real providers, in display order. */
export const PROVIDER_IDS = ["unisat", "okx"];

export function providerMeta(id) {
  return PROVIDER_META[id] || null;
}

export const TXID_RE = /^[0-9a-f]{64}$/i;
export const HEX_RE = /^[0-9a-f]+$/i;
export const PUBKEY_RE = /^[0-9a-f]{66}$/;

/** `toSignInputs` rows for `signPsbt`: one per input index, same shape for every provider. */
export function toSignInputs({ inputIndexes, address, sighashTypes }) {
  if (!Array.isArray(inputIndexes)) throw new Error("signPsbt: inputIndexes must be an array");
  if (typeof address !== "string" || !address) throw new Error("signPsbt: address is required");
  return inputIndexes.map((index) => {
    if (!Number.isInteger(index) || index < 0) throw new Error(`signPsbt: bad input index ${index}`);
    const row = { index, address };
    if (Array.isArray(sighashTypes) && sighashTypes.length) row.sighashTypes = sighashTypes.map(Number);
    return row;
  });
}

/**
 * Positional arguments for `provider.signPsbt(...)`. Identical for UniSat
 * and OKX (the OKX API is UniSat-compatible here); kept per-provider so a
 * future divergence has one place to live.
 */
export function signPsbtArgs(providerId, psbtHex, { inputIndexes, address, autoFinalized = true, sighashTypes } = {}) {
  if (!providerMeta(providerId)) throw new Error(`unknown wallet provider "${providerId}"`);
  if (typeof psbtHex !== "string" || !HEX_RE.test(psbtHex) || psbtHex.length % 2 !== 0) {
    throw new Error("signPsbt: psbtHex must be an even-length hex string");
  }
  return [psbtHex, { autoFinalized: autoFinalized !== false, toSignInputs: toSignInputs({ inputIndexes, address, sighashTypes }) }];
}

/**
 * Positional arguments for `provider.pushTx(...)`: UniSat takes
 * `{ rawtx }`, OKX (and the mock) take the raw hex string.
 */
export function pushTxArgs(providerId, rawHex) {
  if (typeof rawHex !== "string" || !HEX_RE.test(rawHex) || rawHex.length % 2 !== 0) {
    throw new Error("pushTx: rawHex must be an even-length hex string");
  }
  switch (providerId) {
    case "unisat":
      return [{ rawtx: rawHex }];
    case "okx":
    case "mock":
      return [rawHex];
    default:
      throw new Error(`unknown wallet provider "${providerId}"`);
  }
}

/** `{ txid, vout, sats }` from a provider UTXO row, or null when malformed. */
export function normalizeUtxo(u) {
  if (!u || typeof u !== "object") return null;
  const txid = String(u.txid || "").toLowerCase();
  const vout = Number(u.vout);
  const sats = Number(u.satoshis ?? u.satoshi ?? u.value ?? u.sats);
  if (!TXID_RE.test(txid) || !Number.isInteger(vout) || vout < 0) return null;
  if (!Number.isInteger(sats) || sats < 0) return null;
  return { txid, vout, sats };
}

/** Provider UTXO payloads come as an array or `{ list }`; either way → normalized rows. */
export function normalizeUtxoList(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : [];
  return list.map(normalizeUtxo).filter(Boolean);
}

export function normalizeBalance(b) {
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  return { confirmed: n(b?.confirmed), unconfirmed: n(b?.unconfirmed), total: n(b?.total) };
}

/** A txid as returned by pushPsbt / pushTx, lowercased, or null when it is not one. */
export function normalizeTxid(v) {
  const txid = String(v || "").toLowerCase();
  return TXID_RE.test(txid) ? txid : null;
}

/** First account from `requestAccounts()` / `getAccounts()` (`[address]`) or `connect()` (`{ address }`). */
export function firstAccount(raw) {
  if (Array.isArray(raw)) return typeof raw[0] === "string" && raw[0] ? raw[0] : null;
  if (raw && typeof raw === "object" && typeof raw.address === "string" && raw.address) return raw.address;
  return null;
}

/** Lowercased 33-byte compressed public key hex, or null. */
export function normalizePubkey(v) {
  const hex = String(v || "").toLowerCase();
  return PUBKEY_RE.test(hex) ? hex : null;
}

/**
 * Should a page load try a SILENT reconnect to `storedId`? Only when the
 * stored provider is one we know and it is injected right now. (The caller
 * still checks `getAccounts()` — the wallet is never popped on load.)
 */
export function shouldRestore(storedId, presentIds) {
  if (typeof storedId !== "string" || !providerMeta(storedId)) return false;
  return Array.isArray(presentIds) && presentIds.includes(storedId);
}

/**
 * Which provider a bare `connect()` (no id) should use: the connected one,
 * else the only injected one; null when the caller must let the user pick.
 */
export function defaultProviderId(currentId, presentIds) {
  if (currentId && providerMeta(currentId)) return currentId;
  const ids = (presentIds || []).filter((id) => providerMeta(id));
  return ids.length === 1 ? ids[0] : null;
}

/** Connected-chip label: "OKX · bc1p…62s". */
export function chipLabel(providerId, shortAddress) {
  const m = providerMeta(providerId);
  return m ? `${m.short} · ${shortAddress}` : shortAddress;
}

function _msg(e) {
  return String(e?.message || e || "unknown error");
}

/**
 * True when a broadcast error reads like a double-spend / already-spent
 * input rejection (the listed UTXO was filled or moved by someone else).
 */
export function isConflictError(e) {
  if (e && e.conflict === true) return true;
  const m = _msg(e);
  return /missingorspent|missing.?inputs|mempool-conflict|txn-mempool-conflict|conflict|already.?spent|double.?spend|bad-txns-inputs|insufficient fee, rejecting replacement|replacement/i.test(m);
}
