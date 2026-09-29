// Pure, window-free half of the wallet layer: provider metadata and the
// provider argument shapes. src/lib/wallet.js (browser) and
// test/wallet.test.js (Node) both import this file, so it must not touch
// `window`, `localStorage` or the indexer module.

import { bech32, bech32m } from "@scure/base";
import { DUST_SATS } from "./payloads.js";
//
// The UniSat provider API (window.unisat; the simulated wallet of mock
// mode answers the same shapes):
//
//   requestAccounts()          → [address]
//   getAccounts()              → [address] (no popup)
//   getPublicKey()             → 33-byte compressed hex
//   getNetwork()               → 'livenet' | 'testnet'
//   switchNetwork(net)
//   getBalance()               → { confirmed, unconfirmed, total }
//   getBitcoinUtxos(cursor, size)
//                              → [{ txid, vout, satoshis, scriptPk, addressType, pubkey,
//                                   inscriptions: [], atomicals: [], runes?: [] }]
//                                the account's plain BTC outputs (inscription and rune
//                                outputs left out). Current builds answer the whole
//                                list whatever cursor / size say; collectWalletUtxos
//                                reads it either way.
//   signPsbt(hex, opts)        opts = { autoFinalized, toSignInputs: [{ index, address | publicKey, sighashTypes?, disableTweakSigner? }] }
//   pushPsbt(hex)              → txid
//   pushTx({ rawtx })          → txid
//   on / removeListener        'accountsChanged' | 'networkChanged'

export const WALLET_STORAGE_KEY = "lp.wallet";

export const PROVIDER_META = {
  unisat: {
    id: "unisat",
    name: "UniSat",
    short: "UniSat",
    logo: "/wallets/unisat.svg",
    installUrl: "https://unisat.io",
    appUrl: "https://unisat.io/download",
    mobileHint: "On a phone, open this site inside the UniSat app (Discover tab), then connect.",
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
 * that hands back anything else (a testnet `tb1…`, a legacy `1…`/`3…`, or
 * an EVM `0x…`) is refused before any network or key call. Case-insensitive on the bech32 body; the hrp
 * must be lower-case `bc1`.
 */
export function isMainnetAddress(address) {
  if (typeof address !== "string") return false;
  const a = address.trim();
  if (!/^bc1[qp][ac-hj-np-z02-9]{38,58}$/.test(a.toLowerCase())) return false;
  // bech32 forbids mixed case
  return a === a.toLowerCase() || a === a.toUpperCase();
}

/**
 * `isMainnetAddress` plus a valid bech32 (bc1q, witness v0) / bech32m
 * (bc1p, witness v1) checksum — for addresses a person types or pastes
 * (the Activity filter). Upper case is accepted; callers lower-case it.
 */
export function isValidBech32Address(address) {
  if (!isMainnetAddress(address)) return false;
  const a = address.trim().toLowerCase();
  try {
    const coder = a.startsWith("bc1p") ? bech32m : bech32;
    const { prefix, words } = coder.decode(a, 90);
    if (prefix !== "bc" || words.length === 0) return false;
    const version = words[0];
    const program = coder.fromWords(words.slice(1));
    if (version === 0) return program.length === 20 || program.length === 32;
    return version === 1 && program.length === 32;
  } catch {
    return false;
  }
}

/** The real providers, in display order: UniSat only. */
export const PROVIDER_IDS = ["unisat"];

export function providerMeta(id) {
  return PROVIDER_META[id] || null;
}

/**
 * Can the wallet dialog, connected to `currentId`, offer another wallet? Only
 * when a real provider other than the connected one exists, or the simulated
 * wallet is offered (`mock`) and is not the connected one.
 */
export function canSwitchWallet(currentId, { mock = false } = {}) {
  return PROVIDER_IDS.some((id) => id !== currentId) || (mock === true && currentId !== "mock");
}

export const TXID_RE = /^[0-9a-f]{64}$/i;
export const HEX_RE = /^[0-9a-f]+$/i;
export const PUBKEY_RE = /^[0-9a-f]{66}$/;

/** `toSignInputs` rows for `signPsbt`: one per input index. */
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

/** Positional arguments for `provider.signPsbt(...)` (UniSat's shape; the simulated wallet takes the same). */
export function signPsbtArgs(providerId, psbtHex, { inputIndexes, address, autoFinalized = true, sighashTypes } = {}) {
  if (!providerMeta(providerId)) throw new Error(`unknown wallet provider "${providerId}"`);
  if (typeof psbtHex !== "string" || !HEX_RE.test(psbtHex) || psbtHex.length % 2 !== 0) {
    throw new Error("signPsbt: psbtHex must be an even-length hex string");
  }
  return [psbtHex, { autoFinalized: autoFinalized !== false, toSignInputs: toSignInputs({ inputIndexes, address, sighashTypes }) }];
}

/** Positional arguments for `provider.pushTx(...)`: `{ rawtx }` (UniSat's shape; the simulated wallet takes the same). */
export function pushTxArgs(providerId, rawHex) {
  if (typeof rawHex !== "string" || !HEX_RE.test(rawHex) || rawHex.length % 2 !== 0) {
    throw new Error("pushTx: rawHex must be an even-length hex string");
  }
  if (!providerMeta(providerId)) throw new Error(`unknown wallet provider "${providerId}"`);
  return [{ rawtx: rawHex }];
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

export function normalizeBalance(b) {
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  return { confirmed: n(b?.confirmed), unconfirmed: n(b?.unconfirmed), total: n(b?.total) };
}

/** A txid as returned by pushPsbt / pushTx, lowercased, or null when it is not one. */
export function normalizeTxid(v) {
  const txid = String(v || "").toLowerCase();
  return TXID_RE.test(txid) ? txid : null;
}

/** First account from `requestAccounts()` / `getAccounts()` (`[address]`), or null. */
export function firstAccount(raw) {
  if (Array.isArray(raw)) return typeof raw[0] === "string" && raw[0] ? raw[0] : null;
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

/** Connected-chip label: "UniSat · bc1p…62s". */
export function chipLabel(providerId, shortAddress) {
  const m = providerMeta(providerId);
  return m ? `${m.short} · ${shortAddress}` : shortAddress;
}

/** How many rows one `getBitcoinUtxos(cursor, size)` call asks for, and how many calls at most. */
export const WALLET_UTXO_PAGE = 100;
export const WALLET_UTXO_MAX_PAGES = 100;

/** True when a wallet UTXO row names an inscription, an Atomicals asset or a rune on the output. */
export function walletRowHasAssets(u) {
  if (!u || typeof u !== "object") return false;
  return [u.inscriptions, u.atomicals, u.runes].some((a) => Array.isArray(a) && a.length > 0);
}

/**
 * Read a wallet's whole `getBitcoinUtxos(cursor, size)` list. A build that
 * answers everything at once, whatever the cursor and size say, is read in
 * one call (it returned more rows than asked for); a list of exactly `size`
 * rows takes one more call, which adds nothing new and ends the read. A
 * build that pages is walked page by page until a short page, `total`, or
 * `maxPages`.
 * Rows are merged by outpoint; malformed rows are skipped. A throwing call
 * rejects.
 *
 * → [{ txid, vout, sats, assets }]  (`assets`: the wallet names an
 *   inscription, Atomicals asset or rune on the output)
 */
export async function collectWalletUtxos(getPage, { size = WALLET_UTXO_PAGE, maxPages = WALLET_UTXO_MAX_PAGES } = {}) {
  const byKey = new Map();
  let cursor = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await getPage(cursor, size);
    const list = Array.isArray(page) ? page : Array.isArray(page?.list) ? page.list : [];
    let added = 0;
    for (const raw of list) {
      const u = normalizeUtxo(raw);
      if (!u) continue;
      const k = `${u.txid}:${u.vout}`;
      if (byKey.has(k)) continue;
      byKey.set(k, { ...u, assets: walletRowHasAssets(raw) });
      added++;
    }
    cursor += list.length;
    const total = Number(page?.total);
    if (list.length !== size || added === 0) break;
    if (Number.isFinite(total) && cursor >= total) break;
  }
  return [...byKey.values()];
}

/** Coinbase outputs can be spent from this many confirmations on. */
export const COINBASE_MATURITY = 100;

/**
 * Check a wallet's listed outputs (`listed`, from collectWalletUtxos)
 * against the node's answers for them (`rows`, GET /txouts) and keep only
 * outputs every rule allows as a fee input:
 *
 *   * the wallet names no inscription, Atomicals asset or rune on it;
 *   * the node has it unspent in its confirmed UTXO set, with at least one
 *     confirmation on the indexed chain (a coinbase output: COINBASE_MATURITY);
 *   * it carries no LUCKY-20 tokens (`token_carrier`);
 *   * it pays `scriptHex` (the connected address's script) with exactly the
 *     value the wallet listed — the signature commits to the value.
 *
 * Outputs the node does not have as confirmed (not yet confirmed, in a block
 * the indexer has not applied yet, or no row at all) are WAITING: their
 * value above DUST_SATS is `waitingSats`, so a flow can say "wait for a
 * confirmation" rather than "no BTC".
 *
 * → { utxos: [{ txid, vout, sats }], waitingOutpoints, mismatchedOutpoints,
 *     carrierOutpoints, assetOutpoints, waitingSats }
 */
export function verifyWalletUtxos(listed, rows, { scriptHex } = {}) {
  const script = String(scriptHex || "").toLowerCase();
  const byKey = new Map();
  for (const r of rows || []) {
    if (!r || !TXID_RE.test(String(r.txid || "")) || !Number.isInteger(r.vout)) continue;
    byKey.set(`${String(r.txid).toLowerCase()}:${r.vout}`, r);
  }
  const out = { utxos: [], waitingOutpoints: [], mismatchedOutpoints: [], carrierOutpoints: [], assetOutpoints: [], waitingSats: 0 };
  for (const u of listed || []) {
    const outpoint = { txid: u.txid, vout: u.vout };
    const row = byKey.get(`${u.txid}:${u.vout}`);
    const unspent = !!row && row.unspent === true;
    if (u.assets) out.assetOutpoints.push(outpoint);
    else if (row && row.token_carrier === true) out.carrierOutpoints.push(outpoint);
    else if (unspent && (!script || String(row.script_hex || "").toLowerCase() !== script || Number(row.sats) !== Number(u.sats))) {
      out.mismatchedOutpoints.push(outpoint);
    } else if (!unspent || !(Number(row.confirmations) >= (row.coinbase === true ? COINBASE_MATURITY : 1))) {
      out.waitingOutpoints.push(outpoint);
      if (Number(u.sats) > DUST_SATS) out.waitingSats += Number(u.sats);
    } else out.utxos.push({ txid: u.txid, vout: u.vout, sats: u.sats });
  }
  return out;
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
