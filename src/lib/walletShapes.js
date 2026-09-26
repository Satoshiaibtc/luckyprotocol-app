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
    logo: "/wallets/unisat.svg",
    installUrl: "https://unisat.io",
    appUrl: "https://unisat.io/download",
    description: "Extension and mobile app. Its asset-aware UTXO list keeps Ordinals and Runes out of fee inputs.",
    mobileHint: "On a phone, open this site inside the UniSat app (Discover tab), then connect.",
  },
  okx: {
    id: "okx",
    name: "OKX Wallet",
    short: "OKX",
    logo: "/wallets/okx.png",
    installUrl: "https://web3.okx.com/download",
    appUrl: "https://web3.okx.com/download",
    description: "Extension and mobile app via its Bitcoin mainnet provider. Fee inputs come from the indexer, 10,000-sat floor.",
    mobileHint: "On a phone, open this site inside the OKX Wallet app (DApp browser), then connect.",
  },
  mock: {
    id: "mock",
    name: "Simulated wallet",
    short: "SIM",
    logo: null,
    installUrl: null,
    appUrl: null,
    description: "VITE_MOCK=1 only: a deterministic in-page signer against the fake indexer. Nothing touches the network.",
    mobileHint: null,
  },
};

/**
 * True for a Bitcoin MAINNET Native SegWit (bc1q) or Taproot (bc1p)
 * address — the only account types the protocol supports (§6). A provider
 * that hands back anything else (a testnet `tb1…`, a legacy `1…`/`3…`, or an
 * EVM `0x…` because the wrong OKX provider was reached) is refused before
 * any network or key call. Case-insensitive on the bech32 body; the hrp
 * must be lower-case `bc1`.
 */
export function isMainnetAddress(address) {
  if (typeof address !== "string") return false;
  const a = address.trim();
  if (!/^bc1[qp][ac-hj-np-z02-9]{38,58}$/.test(a.toLowerCase())) return false;
  // bech32 forbids mixed case
  return a === a.toLowerCase() || a === a.toUpperCase();
}

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

/**
 * Outpoints ("txid:vout") of the inscriptions in one `getInscriptions`
 * page. Both UniSat and OKX answer `{ total, list: [{ inscriptionId,
 * output: "txid:vout", location: "txid:vout:offset", utxo: { txid, vout }, … }] }`
 * — any of the three shapes is accepted; malformed rows are skipped.
 */
export function inscriptionOutpoints(page) {
  const list = Array.isArray(page) ? page : Array.isArray(page?.list) ? page.list : [];
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    let txid = null;
    let vout = null;
    const parse = (s) => {
      const m = /^([0-9a-fA-F]{64}):(\d+)/.exec(String(s || ""));
      return m ? [m[1].toLowerCase(), Number(m[2])] : null;
    };
    const fromOutput = parse(row.output) || parse(row.location);
    if (fromOutput) [txid, vout] = fromOutput;
    else if (row.utxo && typeof row.utxo === "object") {
      const t = String(row.utxo.txid || "").toLowerCase();
      if (TXID_RE.test(t) && Number.isInteger(Number(row.utxo.vout))) [txid, vout] = [t, Number(row.utxo.vout)];
    }
    if (txid && Number.isInteger(vout) && vout >= 0) out.push(`${txid}:${vout}`);
  }
  return out;
}

/**
 * Page through a provider's `getInscriptions(cursor, size)` and collect
 * every inscription outpoint. Stops when a page is short, when `total`
 * is reached, or after `maxPages` (a runaway provider must not hang the
 * build). Throws if a page throws — the caller then falls back to
 * `assetSafe:false`. → Set<"txid:vout">
 */
export async function collectInscriptionOutpoints(getPage, { size = 100, maxPages = 50 } = {}) {
  const found = new Set();
  let cursor = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await getPage(cursor, size);
    const rows = inscriptionOutpoints(page);
    for (const k of rows) found.add(k);
    const listLen = Array.isArray(page) ? page.length : Array.isArray(page?.list) ? page.list.length : 0;
    const total = Number(page?.total);
    cursor += listLen;
    if (listLen < size || listLen === 0) break;
    if (Number.isFinite(total) && cursor >= total) break;
  }
  return found;
}

/**
 * Intersect a provider's UTXO list with the indexer's /btc-utxos rows and
 * keep only outputs the indexer lists as CONFIRMED with the same value.
 * Everything else is excluded — unconfirmed rows (a just-broadcast SEND's
 * change output is exactly this), outputs the indexer does not list at all
 * (its scan is behind, or the output is already spent) and value
 * mismatches (the sighash commits to the value; a disagreement means one
 * side is stale). Fails closed on purpose: the only outputs that can be
 * fee inputs are ones both sides agree are confirmed and unspent.
 *
 * → { utxos, unconfirmedOutpoints, unlistedOutpoints, mismatchedOutpoints }
 */
export function intersectConfirmed(providerUtxos, indexerRows) {
  const byKey = new Map();
  for (const r of indexerRows || []) {
    if (!r || !TXID_RE.test(String(r.txid || "")) || !Number.isInteger(r.vout)) continue;
    byKey.set(`${String(r.txid).toLowerCase()}:${r.vout}`, r);
  }
  const utxos = [];
  const unconfirmedOutpoints = [];
  const unlistedOutpoints = [];
  const mismatchedOutpoints = [];
  for (const u of providerUtxos || []) {
    const key = `${u.txid}:${u.vout}`;
    const row = byKey.get(key);
    const outpoint = { txid: u.txid, vout: u.vout };
    if (!row) unlistedOutpoints.push(outpoint);
    else if (row.confirmed !== true) unconfirmedOutpoints.push(outpoint);
    else if (Number(row.sats) !== Number(u.sats)) mismatchedOutpoints.push(outpoint);
    else utxos.push({ txid: u.txid, vout: u.vout, sats: u.sats });
  }
  return { utxos, unconfirmedOutpoints, unlistedOutpoints, mismatchedOutpoints };
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
