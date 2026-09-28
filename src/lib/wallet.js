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
import { MIN_FEE_INPUT_SATS_UNSAFE, assertSingleOpReturn, extractRawTxHex, p2trAddressOfXOnly, rawTxSummary } from "./psbt.js";
import { DUST_SATS } from "./payloads.js";
import { retryWhileSeeding } from "./retry.js";
import { pendingSpentOutpoints, recordBroadcastTx, refreshTxRecords } from "./txrecords.js";
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
    // connects with this one prompt (audit wallet-4).
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
 * from the indexer's `/btc-utxos/:addr` CONFIRMED set. On that path
 * (audit M-8):
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
 * have not confirmed yet are dropped (src/lib/txrecords.js, audit
 * usertx-6): the indexer's confirmed set only changes per block, so
 * without this a second build would re-spend them and — full-RBF — replace
 * the first transaction (a listing withdrawal undone by the next MINE).
 *
 * The first query of an address makes the indexer scan the UTXO set for
 * it (a minute or two); `onWait({ waitMs, busy, elapsedMs })` fires before
 * each retry so the flow can say so (src/lib/retry.js).
 */
export async function getBitcoinUtxos(address, { onWait } = {}) {
  const p = need();
  const name = providerName();
  const onRetry = onWait ? (_n, info) => onWait(info) : undefined;
  let res;
  if (typeof p.getBitcoinUtxos === "function") {
    let raw;
    try {
      raw = await p.getBitcoinUtxos();
    } catch (e) {
      throw new Error(`${name} getBitcoinUtxos failed: ${e?.message || e}`);
    }
    let rows;
    try {
      rows = await retryWhileSeeding(() => indexer.btcUtxos(address), { onRetry });
    } catch (e) {
      throw new Error(
        `Could not confirm your UTXOs with the indexer (${_msg(e)}) — a fee input must be an output the indexer lists as confirmed, so nothing is built until it answers; ` +
          "the first use of an address makes the indexer scan for it, which can take a few minutes — try again shortly",
      );
    }
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
    let rows;
    try {
      rows = await retryWhileSeeding(() => indexer.btcUtxos(address), { onRetry });
    } catch (e) {
      throw new Error(
        `Could not read your UTXOs from the indexer (${_msg(e)}) — the first use of an address makes the indexer scan for it, which can take a few minutes; try again shortly`,
      );
    }
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

/** Sum of the `sats` of the rows in `list` whose outpoint is in `outpoints` and worth more than `floor`. */
function waitingSatsOf(list, outpoints, floor) {
  const keys = new Set((outpoints || []).map((o) => `${o.txid}:${o.vout}`));
  return (list || []).filter((u) => keys.has(`${u.txid}:${u.vout}`) && Number(u.sats) > floor).reduce((s, u) => s + Number(u.sats), 0);
}

/**
 * Drop the inputs of this address's own unconfirmed broadcasts from a
 * `getBitcoinUtxos` result (see txrecords.js). A record whose status
 * cannot be read keeps its inputs excluded (fail closed).
 */
async function excludePendingSpends(address, res) {
  const records = await refreshTxRecords(address, (txid) => indexer.txStatus(txid));
  const spent = pendingSpentOutpoints(records);
  if (spent.size === 0) return { ...res, pendingSpentOutpoints: [] };
  const key = (u) => `${u.txid}:${u.vout}`.toLowerCase();
  const pendingSpent = res.utxos.filter((u) => spent.has(key(u))).map(({ txid, vout }) => ({ txid, vout }));
  const utxos = res.utxos.filter((u) => !spent.has(key(u)));
  if (utxos.length === 0 && pendingSpent.length > 0) {
    const keys = new Set(pendingSpent.map(key));
    const ids = records
      .filter((r) => !r.confirmed && r.inputs.some((k) => keys.has(k)))
      .map((r) => `${r.txid.slice(0, 8)}…`)
      .join(", ");
    throw new Error(
      `Every spendable output of this wallet is an input of a transaction you already broadcast that has not confirmed yet (tx ${ids}). ` +
        "Spending one again would replace that transaction — wait for it to confirm, then try again.",
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
 * through here, so a node's "rejecting replacement" is shown as what it is
 * (audit usertx-9).
 */
export function walletError(e, what = "sign") {
  const msg = _msg(e);
  const err = new Error(msg);
  if (DECLINE_RE.test(msg) || e?.code === 4001) err.declined = what;
  err.cause = e;
  return err;
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
  let signed;
  try {
    signed = await p.signPsbt(...args);
  } catch (e) {
    throw walletError(e, "sign");
  }
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

/** How long to wait before asking the indexer whether a "failed" broadcast reached the node anyway. */
export const LANDED_CHECK_DELAY_MS = 2_000;

/**
 * Record a broadcast tx under the connected address (its inputs are then
 * excluded from fee selection until it confirms or drops; a DEPLOY / MINE
 * is remembered with its ticker). Never throws.
 */
function remember(summary, meta) {
  try {
    const address = current?.address;
    if (!address || !summary) return;
    recordBroadcastTx(address, { txid: summary.txid, kind: meta?.kind || "other", ticker: meta?.ticker || null, inputs: summary.inputs });
  } catch {
    /* the record is a safety net, never a reason to fail a broadcast */
  }
  notifyBroadcast(summary?.txid ?? null);
}

const broadcastListeners = new Set();

/**
 * Subscribe to "a transaction of the connected wallet was just broadcast"
 * (the balance shown in the top bar is re-read then, audit wallet-5).
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

/**
 * Both relays failed. A relay can fail AFTER the node accepted the tx (a
 * timeout on the way back), so before telling the user to try again ask
 * the indexer whether the tx is in its node's mempool — a blind retry of a
 * DEPLOY would pay the fees twice (audit usertx-2). Returns the txid when
 * it landed; otherwise throws `err` with the verdict appended
 * (`err.landed` false = not seen by the node, null = could not tell).
 */
export async function landedOrThrow(summary, meta, err, { txStatus = (txid) => indexer.txStatus(txid), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), record = remember } = {}) {
  if (!summary) throw err;
  await sleep(LANDED_CHECK_DELAY_MS);
  let st = null;
  try {
    st = await txStatus(summary.txid);
  } catch {
    st = null;
  }
  if (st && (st.confirmed || st.seen)) {
    record(summary, meta);
    return summary.txid;
  }
  err.txid = summary.txid;
  if (st) {
    err.message += ` · the indexer's node has not seen tx ${summary.txid.slice(0, 12)}…, so nothing was spent — you can try again`;
    err.landed = false;
    throw err;
  }
  // Unknown: keep its inputs excluded and its ticker remembered until the
  // record resolves, so a retry cannot silently double it.
  record(summary, meta);
  err.message += ` · could not check whether tx ${summary.txid.slice(0, 12)}… reached the network — wait a minute and check it before trying again`;
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
  // more than one OP_RETURN output (M-3), never reaches any relay.
  const raw = extractRawTxHex(signedPsbtHex);
  const summary = summarize(raw);
  try {
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
      return landedOrThrow(summary, meta, err);
    }
  }
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
      return landedOrThrow(summary, meta, err);
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
