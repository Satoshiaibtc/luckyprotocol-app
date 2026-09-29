// Multi-wallet provider layer (PROTOCOL.md §6): UniSat + OKX Wallet,
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
import { MIN_FEE_INPUT_SATS_UNSAFE, assertSingleOpReturn, extractRawTxHex, p2trAddressOfXOnly, psbtInputKeys, rawTxSummary, signedTxMismatch } from "./psbt.js";
import { DUST_SATS } from "./payloads.js";
import { isAbortError, retryWhileSeeding, seedFailureText } from "./retry.js";
import { pendingSpentOutpoints, recordBroadcastTx, refreshTxRecords, txRecords } from "./txrecords.js";
import {
  PROVIDER_IDS,
  PROVIDER_META,
  WALLET_STORAGE_KEY,
  collectInscriptionOutpoints,
  defaultProviderId,
  firstAccount,
  intersectConfirmed,
  isConflictError,
  isMainnetAddress,
  normalizeBalance,
  normalizePubkey,
  normalizeTxid,
  normalizeUtxoList,
  providerMeta,
  pubkeyFromConnect,
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

/**
 * OKX injects several providers under `window.okxwallet`: the EVM one
 * (`window.okxwallet` itself / `.ethereum`), Solana, and the BITCOIN
 * MAINNET one at `window.okxwallet.bitcoin` (`.bitcoinTestnet` /
 * `.bitcoinSignet` exist too). Only `.bitcoin` is ever used — never the
 * EVM provider, never a testnet one — and connect() re-checks that the
 * returned account is a mainnet bc1q/bc1p address.
 */
const INJECTED = {
  unisat: () => (typeof window !== "undefined" && window.unisat ? window.unisat : null),
  okx: () => {
    if (typeof window === "undefined" || !window.okxwallet) return null;
    const p = window.okxwallet.bitcoin;
    return p && typeof p === "object" && p !== window.okxwallet ? p : null;
  },
};

let mockProvider = null; // set by enableMockWallet()
let detected = []; // last detectProviders() result
let current = null; // { id, provider, address }

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
    let res;
    try {
      res = await p.connect();
    } catch (e) {
      throw walletError(e, "connect");
    }
    address = firstAccount(res);
    // OKX answers a Taproot account with the 32-byte x-only key (and, in
    // newer builds, `compressedPublicKey`). Use whichever it gave — the
    // x-only one only after checking that it derives the returned address —
    // so the in-app browser, whose provider documents no getPublicKey(),
    // connects with this one prompt.
    pubkeyHex = pubkeyFromConnect(res, address, p2trAddressOfXOnly);
  } else {
    try {
      address = firstAccount(await p.requestAccounts());
    } catch (e) {
      throw walletError(e, "connect");
    }
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
    const wrongNet = `${name} is on "${network}" — LuckyProtocol is Bitcoin mainnet only. Switch the wallet to mainnet (livenet) and connect again.`;
    if (silent || typeof p.switchNetwork !== "function") throw new Error(wrongNet);
    // Ask the provider to switch; a refusal (or a provider that says it
    // switched but did not) is a clear error, never a silent testnet session.
    try {
      await p.switchNetwork("livenet");
    } catch (e) {
      throw new Error(`${wrongNet} (${_msg(e)})`);
    }
    let after = "livenet";
    try {
      after = String((await p.getNetwork()) || "livenet");
    } catch {
      after = "livenet";
    }
    if (after !== "livenet") throw new Error(wrongNet);
    network = "livenet";
    // The account may change with the network — re-read it.
    if (typeof p.getAccounts === "function") {
      try {
        address = firstAccount(await p.getAccounts()) || address;
      } catch {
        /* keep the address from the first prompt */
      }
    }
  }
  // Defence in depth: whatever the provider says about its network, the
  // account must be a mainnet bc1q / bc1p address (a `tb1…` testnet
  // account, or an EVM `0x…` from the wrong OKX provider, stops here).
  if (!isMainnetAddress(address)) {
    throw new Error(
      `${name} returned "${address}", which is not a Bitcoin mainnet Native SegWit (bc1q) or Taproot (bc1p) address — ` +
      `switch the wallet to Bitcoin mainnet and one of those address types, then connect again`,
    );
  }

  if (!pubkeyHex) {
    if (typeof p.getPublicKey !== "function") {
      // A page-load restore never errors for what only a prompt can give:
      // it stays disconnected and Connect asks for the key.
      if (silent) return null;
      throw new Error(`${name} did not share this account's public key, which is needed to build transactions — update the ${name} app or extension and connect again`);
    }
    try {
      pubkeyHex = normalizePubkey(await p.getPublicKey());
    } catch (e) {
      throw walletError(e, "connect");
    }
  }
  if (!pubkeyHex) throw new Error(`${name} returned an unexpected public key format`);

  current = { id: pid, provider: p, address };
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
 * Spendable BTC UTXOs as `{ source, assetSafe, utxos: [{ txid, vout, sats }], excludedOutpoints }`.
 *
 * `assetSafe:true` when the provider offers its own asset-aware list
 * (UniSat `getBitcoinUtxos()` excludes inscription / rune carriers). That
 * list is then INTERSECTED with the indexer's `/btc-utxos/:addr` rows and
 * only outputs the indexer lists as confirmed (at the same value) survive
 * (walletShapes.intersectConfirmed): a just-broadcast SEND's change output
 * — unconfirmed, and unknown to /utxos until the tx confirms — can never be
 * picked as a fee input. The indexer being unreachable fails the build
 * rather than trusting the wallet's list alone.
 *
 * OKX has no such method (the mock omits it on purpose), so the rows come
 * from the indexer's `/btc-utxos/:addr` CONFIRMED set. On that path:
 *   * if the provider has `getInscriptions`, every inscription outpoint is
 *     paged out and dropped → `assetSafe:"inscriptions-only"` (runes are
 *     still not covered — no provider exposes a runes UTXO list and the
 *     indexer is bitcoind-only); a failing pager degrades to `false`
 *   * otherwise `assetSafe:false`
 * Either way the builders apply the §4 filter (≤ 546 sats + token
 * outpoints) and, for any `assetSafe !== true` list, the fee-input floor
 * and largest-first selection (psbt.minFeeInputSats / selectionOrderFor);
 * the UI shows the notice and lists the inputs at signing time.
 *
 * On EVERY path, the inputs of transactions this browser broadcast that
 * have not confirmed yet are dropped (src/lib/txrecords.js): the
 * indexer's confirmed set only changes per block, so
 * without this a second build would re-spend them and — full-RBF — replace
 * the first transaction (a listing withdrawal undone by the next MINE).
 *
 * The first query of an address makes the indexer scan the UTXO set for
 * it (a few minutes) — and so does the next query after an indexer
 * restart (every address) or a chain reorganization that touched this
 * address's outputs. `onWait({ waitMs, busy, elapsedMs, queuePosition, etaSecs,
 * reason, rescan })` fires before each retry so the flow can say so
 * (src/lib/retry.js seedWaitNote); `rescan` is true when this browser has
 * read the address's UTXOs before, so the wait is not a first use.
 * `signal` stops the wait (the flow's Stop waiting): the AbortError is
 * thrown as is.
 */
export async function getBitcoinUtxos(address, { onWait, signal } = {}) {
  const p = need();
  const name = providerName();
  let res;
  if (typeof p.getBitcoinUtxos === "function") {
    let raw;
    try {
      raw = await p.getBitcoinUtxos();
    } catch (e) {
      throw new Error(`${name} getBitcoinUtxos failed: ${e?.message || e}`);
    }
    const rows = await indexerBtcRows(address, {
      onWait,
      signal,
      failure: (e) =>
        `Could not confirm your UTXOs with the indexer (${_msg(e)}) — a fee input must be an output the indexer lists as confirmed, so nothing is built until it answers; ` +
        `${SCAN_NOTE} — try again shortly`,
    });
    const listed = normalizeUtxoList(raw);
    const { utxos, unconfirmedOutpoints, unlistedOutpoints, mismatchedOutpoints } = intersectConfirmed(listed, rows);
    res = {
      source: current.id,
      assetSafe: true,
      utxos,
      excludedOutpoints: [...unconfirmedOutpoints, ...unlistedOutpoints, ...mismatchedOutpoints],
      unconfirmedOutpoints,
      unlistedOutpoints,
      mismatchedOutpoints,
      // Plain BTC held back only because it has not confirmed (or the
      // indexer has not listed it) yet — a flow that finds nothing to spend
      // says "wait for a confirmation" instead of "no spendable BTC".
      waitingSats: waitingSatsOf(listed, [...unconfirmedOutpoints, ...unlistedOutpoints], DUST_SATS),
    };
  } else {
    const rows = await indexerBtcRows(address, {
      onWait,
      signal,
      failure: (e) => `Could not read your UTXOs from the indexer (${_msg(e)}) — ${SCAN_NOTE}; try again shortly`,
    });
    let utxos = rows.filter((u) => u.confirmed).map(({ txid, vout, sats }) => ({ txid, vout, sats }));
    let assetSafe = false;
    let excludedOutpoints = [];
    if (typeof p.getInscriptions === "function") {
      try {
        const inscribed = await collectInscriptionOutpoints((cursor, size) => p.getInscriptions(cursor, size));
        excludedOutpoints = utxos.filter((u) => inscribed.has(`${u.txid}:${u.vout}`)).map(({ txid, vout }) => ({ txid, vout }));
        utxos = utxos.filter((u) => !inscribed.has(`${u.txid}:${u.vout}`));
        assetSafe = "inscriptions-only";
      } catch {
        assetSafe = false; // the pager failed: treat the whole list as unsafe
      }
    }
    // Unconfirmed rows above the fee-input floor become usable once they confirm.
    const waitingSats = rows.filter((u) => !u.confirmed && Number(u.sats) > MIN_FEE_INPUT_SATS_UNSAFE).reduce((s, u) => s + Number(u.sats), 0);
    res = { source: "indexer", assetSafe, utxos, excludedOutpoints, waitingSats };
  }
  return excludePendingSpends(address, res);
}

/**
 * The indexer's `/btc-utxos/:addr` rows, waiting out its scan of the
 * address (retryWhileSeeding, `onWait` / `signal` as getBitcoinUtxos). A
 * stopped wait throws its AbortError as is; a wait that ended without the
 * rows throws one plain sentence — this network's new-scan limit, a queue
 * that stayed full, a scan still running (seedFailureText) — and any other
 * failure `failure(e)`'s sentence (by default the indexer's own message).
 */
export async function indexerBtcRows(address, { onWait, signal, failure } = {}) {
  const rescan = scannedBefore(address);
  const onRetry = onWait ? (_n, info) => onWait({ ...info, rescan }) : undefined;
  let rows;
  try {
    rows = await retryWhileSeeding(() => indexer.btcUtxos(address, signal), { onRetry, signal });
  } catch (e) {
    if (isAbortError(e) || (signal && signal.aborted)) throw e;
    const seed = seedFailureText(e);
    if (seed) throw new Error(seed);
    throw failure ? new Error(failure(e)) : e;
  }
  markScanned(address);
  return rows;
}

// The indexer scans an address's UTXOs on its first use and again after a
// restart or a chain reorganization that touched the address; this browser
// remembers which addresses it has read before, so a later wait is not
// called a "first use".
const SCAN_NOTE = "the indexer scans an address's UTXOs on its first use and again after a chain reorganization, which can take a few minutes";
const SCANNED_KEY_PREFIX = "lp.scanned.";

function scannedBefore(address) {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(`${SCANNED_KEY_PREFIX}${String(address).toLowerCase()}`) === "1";
  } catch {
    return false;
  }
}

function markScanned(address) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(`${SCANNED_KEY_PREFIX}${String(address).toLowerCase()}`, "1");
  } catch {
    /* no storage — a later wait is simply called a first use */
  }
}

/** Sum of the `sats` of the rows in `list` whose outpoint is in `outpoints` and worth more than `floor`. */
function waitingSatsOf(list, outpoints, floor) {
  const keys = new Set((outpoints || []).map((o) => `${o.txid}:${o.vout}`));
  return (list || []).filter((u) => keys.has(`${u.txid}:${u.vout}`) && Number(u.sats) > floor).reduce((s, u) => s + Number(u.sats), 0);
}

/**
 * Drop the inputs of this address's own broadcasts from a `getBitcoinUtxos`
 * result (see txrecords.js): unconfirmed ones, and confirmed ones whose
 * block is not final yet — a chain reorganization can put such a tx back
 * in the mempool and its inputs back in the indexer's confirmed view. A
 * record whose status cannot be read keeps its inputs excluded (fail closed).
 */
async function excludePendingSpends(address, res) {
  const records = await refreshTxRecords(address, (txid) => indexer.txStatus(txid));
  const spent = pendingSpentOutpoints(records);
  // …and the inputs of a transaction this page is signing or broadcasting
  // right now (no record yet): a second flow must not pick them.
  const busy = inFlightOutpoints();
  for (const k of busy) spent.add(k);
  if (spent.size === 0) return { ...res, pendingSpentOutpoints: [] };
  const key = (u) => `${u.txid}:${u.vout}`.toLowerCase();
  const pendingSpent = res.utxos.filter((u) => spent.has(key(u))).map(({ txid, vout }) => ({ txid, vout }));
  const utxos = res.utxos.filter((u) => !spent.has(key(u)));
  if (utxos.length === 0 && pendingSpent.length > 0) {
    if (pendingSpent.every((u) => busy.has(key(u)))) throw inFlightError();
    const keys = new Set(pendingSpent.map(key));
    const ids = records
      .filter((r) => r.inputs.some((k) => keys.has(k)))
      .map((r) => `${r.txid.slice(0, 8)}…`)
      .join(", ");
    throw new Error(
      `Every spendable output of this wallet is an input of a transaction you already broadcast that is not final yet (tx ${ids}). ` +
        "Spending one again could replace that transaction — wait for it to confirm, then try again.",
    );
  }
  return { ...res, utxos, excludedOutpoints: [...(res.excludedOutpoints || []), ...pendingSpent], pendingSpentOutpoints: pendingSpent };
}

const DECLINE_RE = /reject|denied|cancel|declin/i;

/**
 * Wrap an error thrown by the WALLET (a prompt the user answered, or the
 * provider itself) so the UI can tell "you declined" from every other
 * failure: `declined` is "sign" | "connect" when the message reads like a
 * refusal (EIP-1193 code 4001 counts too). Node / relay errors never go
 * through here, so a node's "rejecting replacement" is shown as what it is.
 */
export function walletError(e, what = "sign") {
  const msg = _msg(e);
  const err = new Error(msg);
  if (DECLINE_RE.test(msg) || e?.code === 4001) err.declined = what;
  err.cause = e;
  return err;
}

// ---- inputs in flight ----------------------------------------------------------------------
//
// Between a signature and its broadcast a transaction has no record yet
// (txrecords.js), so a second flow on the page — a withdrawal while a fill
// waits in the wallet, a MINE started again after its tab was left and
// re-opened — would pick the same fee input: the later broadcast is then
// refused as a conflict, or replaces the earlier one. The inputs a
// broadcastable signature spends are held here from the moment it is
// asked for until its broadcast settles (then the record guards them), or
// for IN_FLIGHT_TTL_MS when a flow stops in between.

/** How long inputs stay held when a flow never reaches its broadcast. */
export const IN_FLIGHT_TTL_MS = 15 * 60 * 1000;
const inFlight = new Map(); // "txid:vout" → ms when the hold ends

/** The outpoints ("txid:vout") held by a signature or broadcast in progress on this page. */
export function inFlightOutpoints(now = Date.now()) {
  for (const [k, until] of inFlight) if (until <= now) inFlight.delete(k);
  return new Set(inFlight.keys());
}

/** Release the held inputs of `psbtHex` (all its inputs), or of a list of outpoints (keys or `{ txid, vout }`). */
export function releaseInputs(psbtOrKeys) {
  let keys = [];
  if (Array.isArray(psbtOrKeys)) keys = psbtOrKeys.map((k) => (typeof k === "string" ? k : `${k.txid}:${k.vout}`));
  else if (typeof psbtOrKeys === "string" && psbtOrKeys) {
    try {
      keys = psbtInputKeys(psbtOrKeys);
    } catch {
      keys = [];
    }
  }
  for (const k of keys) inFlight.delete(String(k).toLowerCase());
}

/** The refusal when a signature would spend what another transaction of this page is already spending. */
export function inFlightError() {
  const err = new Error(
    "Another transaction of yours is waiting for the wallet or its broadcast and uses the same BTC. Confirm or reject it in the wallet first, then try again.",
  );
  err.code = "busy";
  return err;
}

/**
 * The outpoints a new signature must not spend: those in flight, and the
 * inputs of this address's recorded broadcasts that are not final — except
 * those of `replaces` (the txids a Speed up deliberately replaces).
 */
function guardedOutpoints(address, replaces) {
  const out = inFlightOutpoints();
  const skip = new Set((replaces || []).map((t) => String(t).toLowerCase()));
  if (address) {
    for (const r of txRecords(address)) {
      if (skip.has(r.txid)) continue;
      for (const k of r.inputs) out.add(k);
    }
  }
  return out;
}

/**
 * Sign every input in `inputIndexes` with `address`.
 *
 *   autoFinalized (default true)  — false for a §7.1 listing, whose lone
 *                                   input must stay un-finalized
 *   sighashTypes  (default unset) — e.g. [0x83] for a listing; providers
 *                                   refuse non-default sighashes unless
 *                                   they are declared here
 *   replaces      (default none)  — txids of this wallet's own pending
 *                                   transactions this one replaces (Speed
 *                                   up): their inputs may be spent again
 *
 * A signature that is going to be broadcast holds its inputs (see above):
 * one that would spend an input already held, or an input of one of this
 * address's own broadcasts that is not final, is refused BEFORE the wallet
 * opens (`code: "busy"`). The PSBT the wallet returns must carry the very
 * transaction it was given — version, lock time, every input's outpoint
 * and nSequence, every output — or nothing is broadcast.
 *
 * Returns the signed PSBT hex.
 */
export async function signPsbt(psbtHex, { inputIndexes, address, autoFinalized = true, sighashTypes, replaces = null } = {}) {
  const p = need();
  let held = [];
  if (autoFinalized !== false) {
    let keys = [];
    try {
      keys = psbtInputKeys(psbtHex, inputIndexes);
    } catch {
      keys = [];
    }
    const guarded = guardedOutpoints(address || current?.address, replaces);
    if (keys.some((k) => guarded.has(k))) throw inFlightError();
    const until = Date.now() + IN_FLIGHT_TTL_MS;
    for (const k of keys) inFlight.set(k, until);
    held = keys;
  }
  const args = signPsbtArgs(current.id, psbtHex, { inputIndexes, address, autoFinalized, sighashTypes });
  let signed;
  try {
    try {
      signed = await p.signPsbt(...args);
    } catch (e) {
      throw walletError(e, "sign");
    }
    if (typeof signed !== "string" || !/^[0-9a-f]+$/i.test(signed) || signed.length % 2 !== 0) {
      throw new Error(`${providerName()} returned an unexpected signPsbt result`);
    }
    const changed = signedTxMismatch(psbtHex, signed);
    if (changed) {
      throw new Error(`${providerName()} changed the transaction while signing (${changed}), so nothing was sent. Update the wallet, or use another one, and try again.`);
    }
  } catch (e) {
    releaseInputs(held);
    throw e;
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

/** How long to wait before asking the indexer whether a "failed" broadcast reached the node anyway. */
export const LANDED_CHECK_DELAY_MS = 2_000;
/**
 * The waits before each look at a "failed" broadcast (2 s, 6 s and 15 s
 * after it): a tx the wallet's relay passed on before failing takes a few
 * seconds to reach the indexer's node over the network.
 */
export const LANDED_CHECK_WAITS_MS = [LANDED_CHECK_DELAY_MS, 4_000, 9_000];

/**
 * Record a broadcast tx under the address that built it (`meta.address`,
 * else the connected one): its inputs are then excluded from fee selection
 * until it confirms or drops; a DEPLOY / MINE is remembered with its
 * ticker. The building address is the one that spends — a wallet switched
 * while the signature was open must not get the record. Never throws.
 */
function remember(summary, meta) {
  try {
    const address = meta?.address || current?.address;
    if (!address || !summary) return;
    recordBroadcastTx(address, {
      txid: summary.txid,
      kind: meta?.kind || "other",
      ticker: meta?.ticker || null,
      inputs: summary.inputs,
      psbt: meta?.psbt ?? null,
      changeVout: meta?.changeVout ?? null,
      replaces: meta?.replaces ?? [],
    });
  } catch {
    /* the record is a safety net, never a reason to fail a broadcast */
  }
  notifyBroadcast(summary?.txid ?? null);
}

const broadcastListeners = new Set();

/**
 * Subscribe to "a transaction of the connected wallet was just broadcast"
 * (the balance shown in the top bar is re-read then).
 * Returns an unsubscribe function.
 */
export function onBroadcast(fn) {
  broadcastListeners.add(fn);
  return () => broadcastListeners.delete(fn);
}

function notifyBroadcast(txid) {
  for (const fn of broadcastListeners) {
    try {
      fn(txid);
    } catch {
      /* a listener never fails a broadcast */
    }
  }
}

// A Bitcoin node's own refusal of a transaction (consensus or relay policy)
// as the indexer's /broadcast relays it: such a tx is not in its mempool
// and no node with the standard rules takes it either. A full mempool's
// "mempool min fee not met" is left out — another node may still take it.
const NODE_REFUSAL_RE =
  /bad-txns|missingorspent|missing-inputs|mandatory-script-verify|non-final|non-BIP68-final|\bdust\b|tx-size|scriptpubkey|min relay fee not met|insufficient fee|txn-mempool-conflict|absurdly-high-fee|max-fee-exceeded|Fee exceeds maximum|TX decode failed|OP_RETURN outputs|not LUCKY-20/i;

/** Did the indexer's relay report that its node REFUSED the tx (not a transport failure)? */
export function nodeRefused(relayErr) {
  return !!relayErr && Number(relayErr.status) === 400 && NODE_REFUSAL_RE.test(String(relayErr.message || relayErr));
}

/**
 * Both relays failed. A relay can fail AFTER passing the tx on (a timeout
 * on the way back, a wallet backend that relayed and then errored), so
 * before telling the user anything the indexer is asked — with answers no
 * cache holds — whether its node has the tx, three times over ~15 s
 * (LANDED_CHECK_WAITS_MS). Returns the txid when it is there. Otherwise
 * throws `err` with the verdict appended:
 *
 *   `err.landed = false` — the indexer's node REFUSED it (`refused`): not
 *                          sent, nothing is held, a retry is safe;
 *   `err.landed = null`  — not seen yet, or no answer: it may still reach
 *                          the network, so it is RECORDED (`err.recorded`)
 *                          — its inputs stay out of the next build and a
 *                          DEPLOY / MINE keeps its ticker — until the record
 *                          resolves (seen, confirmed, or gone for good).
 */
export async function landedOrThrow(
  summary,
  meta,
  err,
  { txStatus = (txid) => indexer.txStatus(txid, undefined, { fresh: true }), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), record = remember, refused = false } = {},
) {
  if (!summary) throw err;
  let answered = false;
  for (const wait of LANDED_CHECK_WAITS_MS) {
    await sleep(wait);
    let st = null;
    try {
      st = await txStatus(summary.txid);
      answered = !!st;
    } catch {
      st = null;
    }
    if (st && (st.confirmed || st.seen)) {
      record(summary, meta);
      return summary.txid;
    }
    // Refused by the node itself: one look settles it.
    if (refused && answered) break;
  }
  err.txid = summary.txid;
  const tx = `${summary.txid.slice(0, 12)}…`;
  if (refused && answered) {
    err.message += ` · the indexer's node refused tx ${tx}, so nothing was spent — you can try again`;
    err.landed = false;
    throw err;
  }
  // Not seen yet, or not known: keep its inputs excluded and its ticker
  // remembered until the record resolves, so a retry cannot silently double
  // it (or replace it).
  record(summary, meta);
  err.recorded = true;
  err.message += answered
    ? ` · the indexer's node has not seen tx ${tx} yet. A relay can fail after passing a transaction on, so it may still arrive: its BTC inputs stay reserved for a few minutes — check the transaction before you try again`
    : ` · could not check whether tx ${tx} reached the network — wait a minute and check it before trying again`;
  err.landed = null;
  throw err;
}

function summarize(rawHex) {
  try {
    return rawTxSummary(rawHex);
  } catch {
    return null;
  }
}

/**
 * Broadcast a finalized PSBT: provider `pushPsbt` first, then the indexer's
 * `/broadcast` relay with the extracted raw tx. `meta` = `{ kind, ticker }`
 * names what is being broadcast for the tx record (txrecords.js). Throws
 * with both reasons if both fail and the tx is not in the node's mempool.
 */
export async function broadcastSignedPsbt(signedPsbtHex, meta = {}) {
  // Extract first: a PSBT that does not finalize, or a finalized tx with
  // more than one OP_RETURN output, never reaches any relay.
  let raw;
  try {
    raw = extractRawTxHex(signedPsbtHex);
  } catch (e) {
    releaseInputs(signedPsbtHex);
    throw e;
  }
  const summary = summarize(raw);
  try {
    try {
      // The wallet that signed relays it — unless another wallet (or none) is
      // connected by now: then only the indexer's relay is used.
      if (!sameWallet(meta)) throw new Error("the wallet changed after signing");
      const txid = await pushPsbt(signedPsbtHex);
      remember(summary, meta);
      return txid;
    } catch (pushErr) {
      try {
        const txid = await indexer.broadcast(raw);
        remember(summary, meta);
        return txid;
      } catch (bErr) {
        const err = new Error(`${_msg(pushErr)} · indexer relay: ${_msg(bErr)}`);
        err.conflict = isConflictError(pushErr) || isConflictError(bErr);
        return await landedOrThrow(summary, meta, err, { refused: nodeRefused(bErr) });
      }
    }
  } finally {
    // Recorded (or refused): the hold on its inputs ends here.
    releaseInputs(summary ? summary.inputs : signedPsbtHex);
  }
}

/** Is the wallet that built and signed (`meta.address`) still the connected one? (no address named: yes) */
function sameWallet(meta) {
  return !meta?.address || (!!current && String(current.address).toLowerCase() === String(meta.address).toLowerCase());
}

/**
 * Broadcast a raw tx: provider `pushTx` first, then the indexer's
 * `/broadcast` relay. A node rejection surfaces from BOTH paths, so the
 * caller can detect a double-spend race (see isConflictError).
 */
export async function broadcastRawTx(rawHex, meta = {}) {
  assertSingleOpReturn(rawHex);
  const summary = summarize(rawHex);
  try {
    try {
      if (!sameWallet(meta)) throw new Error("the wallet changed after signing");
      const txid = await pushTx(rawHex);
      remember(summary, meta);
      return txid;
    } catch (pushErr) {
      try {
        const txid = await indexer.broadcast(rawHex);
        remember(summary, meta);
        return txid;
      } catch (bErr) {
        const err = new Error(`${_msg(pushErr)} · indexer relay: ${_msg(bErr)}`);
        err.conflict = isConflictError(pushErr) || isConflictError(bErr);
        return await landedOrThrow(summary, meta, err, { refused: nodeRefused(bErr) });
      }
    }
  } finally {
    if (summary) releaseInputs(summary.inputs);
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
