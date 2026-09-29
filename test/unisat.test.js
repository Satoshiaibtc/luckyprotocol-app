// Funding with the UniSat wallet: the wallet's own list of plain BTC
// outputs, every one checked with the indexer's GET /txouts before it is
// spent. Plain Node, no framework:
//
//   1. the wallet's list is read in full, whether the wallet answers
//      everything at once or page by page;
//   2. only outputs the node has unspent and confirmed, paying this
//      address's script with the value the wallet listed, without tokens,
//      are kept — the rest is waiting (not confirmed yet) or left out;
//   3. through wallet.getBitcoinUtxos with a fake UniSat and a fake
//      GET /txouts: kept, spent, unconfirmed, wrong script, wrong value,
//      token carrier; the list is asked in chunks of 100; a /txouts failure
//      is one plain retryable sentence and nothing unchecked is used; at
//      one indexed height an output that passed is not asked again;
//   4. the simulated wallet answers like UniSat, and the mock's /txouts
//      keeps its carriers and pending outputs out;
//   5. UniSat is the one wallet: no other provider in the code or the
//      served files, and nothing calls GET /btc-utxos.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hex } from "@scure/base";
import * as wallet from "../src/lib/wallet.js";
import * as mock from "../src/lib/mock.js";
import { PROVIDER_IDS, PROVIDER_META, COINBASE_MATURITY, collectWalletUtxos, verifyWalletUtxos, walletRowHasAssets } from "../src/lib/walletShapes.js";
import { decodeAddress } from "../src/lib/psbt.js";
import { fundingMessage } from "../src/lib/funding.js";
import { noSpendableError } from "../src/lib/psbt.js";
import { setIndexedTip } from "../src/lib/txrecords.js";
import { mockSpendable } from "./mockspend.js";

const ADDR = mock.MOCK_WALLET.address;
const SCRIPT = hex.encode(decodeAddress(ADDR).script);
const OTHER_SCRIPT = hex.encode(decodeAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").script);
const T = (c, i = 0) => `${c}${i.toString(16).padStart(64 - c.length, "0")}`;
const key = (u) => `${u.txid}:${u.vout}`;

/** A UniSat getBitcoinUtxos row. */
const uni = (txid, vout, satoshis, extra = {}) => ({ txid, vout, satoshis, scriptPk: SCRIPT, addressType: 2, pubkey: mock.MOCK_WALLET.pubkeyHex, inscriptions: [], atomicals: [], ...extra });
/** A GET /txouts row for an unspent output. */
const out = (txid, vout, sats, extra = {}) => ({ txid, vout, unspent: true, sats, script_hex: SCRIPT, address: ADDR, confirmations: 3, coinbase: false, token_carrier: false, tokens: null, ...extra });
/** A GET /txouts row for an outpoint the node's confirmed set does not have. */
const none = (txid, vout, extra = {}) => ({ txid, vout, unspent: false, sats: null, script_hex: null, address: null, confirmations: 0, coinbase: false, token_carrier: false, tokens: null, ...extra });

// ---- 1. the wallet's list, read in full ----------------------------------------------------------------
{
  const rows = Array.from({ length: 250 }, (_, i) => uni(T("a1", i), i % 3, 1_000 + i));
  // Current UniSat builds answer the whole list whatever cursor / size say: more rows than asked for, read in one call.
  const calls = [];
  const all = await collectWalletUtxos((cursor, size) => {
    calls.push([cursor, size]);
    return rows;
  });
  assert.equal(all.length, 250);
  assert.deepEqual(calls, [[0, 100]]);
  // Exactly `size` rows every time: one more call, which adds nothing and ends the read.
  const exact = [];
  assert.equal((await collectWalletUtxos((cursor, size) => (exact.push([cursor, size]), rows.slice(0, 100)))).length, 100);
  assert.deepEqual(exact, [[0, 100], [100, 100]]);
  assert.deepEqual(all[0], { txid: T("a1", 0), vout: 0, sats: 1_000, assets: false });
  // A build that pages by cursor: walked until a short page.
  const paged = [];
  const walked = await collectWalletUtxos((cursor, size) => {
    paged.push(cursor);
    return rows.slice(cursor, cursor + size);
  });
  assert.equal(walked.length, 250);
  assert.deepEqual(paged, [0, 100, 200]);
  // `{ list, total }` pages stop at `total`.
  const byTotal = [];
  await collectWalletUtxos((cursor, size) => {
    byTotal.push(cursor);
    return { total: 200, list: rows.slice(cursor, cursor + size) };
  });
  assert.deepEqual(byTotal, [0, 100]);
  // A small wallet: one call.
  let n = 0;
  assert.equal((await collectWalletUtxos(() => (n++, rows.slice(0, 7)))).length, 7);
  assert.equal(n, 1);
  // Malformed rows are skipped; an output the wallet says holds an inscription, an Atomicals asset or a rune is marked.
  const mixed = await collectWalletUtxos(() => [uni("zz", 0, 5), uni(T("b1"), 0, 700, { inscriptions: [{ inscriptionId: "x" }] }), uni(T("b2"), 1, 800, { runes: [{ rune: "X" }] }), uni(T("b3"), 0, 900), null]);
  assert.deepEqual(mixed.map((u) => [u.txid, u.assets]), [[T("b1"), true], [T("b2"), true], [T("b3"), false]]);
  assert.equal(walletRowHasAssets({ atomicals: [{}] }), true);
  assert.equal(walletRowHasAssets({ inscriptions: [] }), false);
  await assert.rejects(collectWalletUtxos(() => { throw new Error("wallet locked"); }), /wallet locked/);
  console.log("unisat list: read in full, whether the wallet answers everything at once or page by page");
}

// ---- 2. the check against the node's confirmed UTXO set ---------------------------------------------
{
  const listed = [
    { txid: T("c1"), vout: 0, sats: 50_000, assets: false }, // kept
    { txid: T("c2"), vout: 1, sats: 20_000, assets: false }, // spent / not in the confirmed set → waiting
    { txid: T("c3"), vout: 0, sats: 9_000, assets: false }, //  in a block the indexer has not applied (0 confirmations) → waiting
    { txid: T("c4"), vout: 2, sats: 7_000, assets: false }, //  pays another script → left out
    { txid: T("c5"), vout: 0, sats: 6_000, assets: false }, //  another value than the wallet listed → left out
    { txid: T("c6"), vout: 1, sats: 546, assets: false }, //    a LUCKY-20 carrier → left out
    { txid: T("c7"), vout: 0, sats: 30_000, assets: true }, //  the wallet names an inscription on it → left out
    { txid: T("c8"), vout: 0, sats: 60_000, assets: false }, // a coinbase output with 99 confirmations → waiting
    { txid: T("c9"), vout: 0, sats: 70_000, assets: false }, // no row at all → waiting
    { txid: T("ca"), vout: 3, sats: 500, assets: false }, //    unconfirmed dust: waiting, but not counted
  ];
  const rows = [
    out(T("c1"), 0, 50_000),
    // A stale answer that still carries a value, script and confirmations: `unspent` alone decides.
    none(T("c2"), 1, { confirmations: 3, sats: 20_000, script_hex: SCRIPT }),
    out(T("c3"), 0, 9_000, { confirmations: 0 }),
    out(T("c4"), 2, 7_000, { script_hex: OTHER_SCRIPT }),
    out(T("c5"), 0, 6_500),
    out(T("c6"), 1, 546, { token_carrier: true, tokens: { LUCKY: 100 } }),
    out(T("c7"), 0, 30_000),
    out(T("c8"), 0, 60_000, { coinbase: true, confirmations: COINBASE_MATURITY - 1 }),
    none(T("ca"), 3),
  ];
  const v = verifyWalletUtxos(listed, rows, { scriptHex: SCRIPT });
  assert.deepEqual(v.utxos, [{ txid: T("c1"), vout: 0, sats: 50_000 }], "only the confirmed, unspent, own, value-matched plain output");
  assert.deepEqual(v.waitingOutpoints.map(key), [`${T("c2")}:1`, `${T("c3")}:0`, `${T("c8")}:0`, `${T("c9")}:0`, `${T("ca")}:3`]);
  assert.deepEqual(v.mismatchedOutpoints.map(key), [`${T("c4")}:2`, `${T("c5")}:0`]);
  assert.deepEqual(v.carrierOutpoints.map(key), [`${T("c6")}:1`]);
  assert.deepEqual(v.assetOutpoints.map(key), [`${T("c7")}:0`]);
  assert.equal(v.waitingSats, 20_000 + 9_000 + 60_000 + 70_000, "waiting BTC above 546 sats");
  // A mature coinbase output is spendable.
  assert.equal(verifyWalletUtxos([listed[7]], [out(T("c8"), 0, 60_000, { coinbase: true, confirmations: COINBASE_MATURITY })], { scriptHex: SCRIPT }).utxos.length, 1);
  // Without the address's script nothing is kept.
  assert.deepEqual(verifyWalletUtxos(listed, rows, {}).utxos, []);
  // A spent carrier is still a carrier (its tokens are the indexer's fact, whatever the node says).
  assert.deepEqual(verifyWalletUtxos([listed[5]], [none(T("c6"), 1, { token_carrier: true, tokens: { LUCKY: 1 } })], { scriptHex: SCRIPT }).carrierOutpoints.length, 1);
  console.log("unisat check: only unspent, confirmed, own, value-matched outputs without tokens are kept; the rest is waiting or left out");
}

// ---- 3. wallet.getBitcoinUtxos: a fake UniSat and a fake GET /txouts ------------------------------------
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
let walletRows = [];
let walletCalls = 0;
const unisat = {
  async requestAccounts() {
    return [ADDR];
  },
  async getAccounts() {
    return [ADDR];
  },
  async getPublicKey() {
    return mock.MOCK_WALLET.pubkeyHex;
  },
  async getNetwork() {
    return "livenet";
  },
  async getBitcoinUtxos() {
    walletCalls += 1;
    return walletRows;
  },
};
globalThis.window = { unisat };

let nodeRows = new Map(); // "txid:vout" → /txouts row
let failWith = null; // [status, headers, body] or "network"
const requested = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  requested.push(u.pathname + u.search);
  if (failWith === "network") throw new TypeError("Failed to fetch");
  if (failWith) {
    const [status, headers, body] = failWith;
    return { ok: false, status, headers: { get: (k) => headers[k] ?? null }, text: async () => body, json: async () => JSON.parse(body) };
  }
  assert.equal(u.pathname, "/txouts", "the funding path asks only GET /txouts");
  const keys = [...new Set(u.searchParams.get("o").split(","))];
  assert.ok(keys.length <= 100, "at most 100 outpoints a request");
  const body = keys.map((k) => nodeRows.get(k) || none(k.split(":")[0], Number(k.split(":")[1])));
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
};

{
  const session = await wallet.connect("unisat");
  assert.deepEqual([session.providerId, session.providerName, session.assetSafe], ["unisat", "UniSat", true]);
  walletRows = [
    uni(T("d1"), 0, 50_000), // kept
    uni(T("d2"), 0, 40_000), // spent
    uni(T("d3"), 1, 30_000), // unconfirmed
    uni(T("d4"), 0, 20_000), // wrong script
    uni(T("d5"), 2, 10_000), // wrong value
    uni(T("d6"), 1, 546), //    token carrier
  ];
  nodeRows = new Map([
    [`${T("d1")}:0`, out(T("d1"), 0, 50_000)],
    [`${T("d4")}:0`, out(T("d4"), 0, 20_000, { script_hex: OTHER_SCRIPT })],
    [`${T("d5")}:2`, out(T("d5"), 2, 12_000)],
    [`${T("d6")}:1`, out(T("d6"), 1, 546, { token_carrier: true, tokens: { LUCKY: 50 } })],
  ]);
  requested.length = 0;
  const res = await wallet.getBitcoinUtxos(ADDR);
  assert.deepEqual(res.utxos, [{ txid: T("d1"), vout: 0, sats: 50_000 }], "kept: only the checked output");
  assert.deepEqual([res.source, res.assetSafe], ["unisat", true]);
  assert.deepEqual(res.waitingOutpoints.map(key), [`${T("d2")}:0`, `${T("d3")}:1`], "spent / unconfirmed: waiting");
  assert.equal(res.waitingSats, 70_000);
  assert.deepEqual(res.mismatchedOutpoints.map(key), [`${T("d4")}:0`, `${T("d5")}:2`], "wrong script / wrong value: left out");
  assert.deepEqual(res.carrierOutpoints.map(key), [`${T("d6")}:1`], "token carrier: left out");
  assert.equal(walletCalls, 1, "the wallet was asked once for its list");
  assert.equal(requested.length, 1, "one /txouts request for six outputs");
  assert.ok(requested.every((r) => r.startsWith("/txouts?o=")) && !requested.some((r) => /btc-utxos/.test(r)), "no address scan is asked for");

  // Nothing kept, some waiting: the flow says "wait for a confirmation", not "no BTC".
  nodeRows.delete(`${T("d1")}:0`);
  const waiting = await wallet.getBitcoinUtxos(ADDR);
  assert.deepEqual([waiting.utxos.length, waiting.waitingSats], [0, 120_000]);
  assert.match(fundingMessage(noSpendableError(ADDR, 0), waiting, { action: "this MINE" }), /^Your 120,000 sats have not confirmed yet/);

  // A big wallet: its list is checked 100 outputs a request.
  walletRows = Array.from({ length: 230 }, (_, i) => uni(T("e1", i), 0, 2_000 + i));
  nodeRows = new Map(walletRows.map((r) => [key(r), out(r.txid, r.vout, r.satoshis)]));
  requested.length = 0;
  const big = await wallet.getBitcoinUtxos(ADDR);
  assert.equal(big.utxos.length, 230);
  assert.deepEqual(requested.map((r) => new URL(`http://x${r}`).searchParams.get("o").split(",").length), [100, 100, 30]);

  // The account in the wallet changed under the page: its outputs pay another script, so nothing is spent.
  nodeRows = new Map(walletRows.map((r) => [key(r), out(r.txid, r.vout, r.satoshis, { script_hex: OTHER_SCRIPT })]));
  assert.equal((await wallet.getBitcoinUtxos(ADDR)).utxos.length, 0);

  // GET /txouts fails: one plain sentence to retry, and nothing unchecked is used.
  walletRows = [uni(T("f1"), 0, 90_000)];
  nodeRows = new Map([[`${T("f1")}:0`, out(T("f1"), 0, 90_000)]]);
  for (const [fail, why] of [
    [[503, { "Retry-After": "30" }, "the node did not answer in time; retry shortly"], /\(the node did not answer in time; retry shortly\)/],
    [[500, {}, ""], /\(HTTP 500\)/],
    ["network", /\(the indexer could not be reached\)/],
  ]) {
    failWith = fail;
    const e = await wallet.getBitcoinUtxos(ADDR).catch((x) => x);
    assert.ok(e instanceof Error, "rejects, never a list");
    assert.match(e.message, /^Could not check this wallet's BTC with the indexer right now/);
    assert.match(e.message, why);
    assert.match(e.message, /Nothing was signed — try again in a moment\.$/);
    assert.ok(!/txouts|https?:|\?o=/.test(e.message), "no request path in the sentence");
  }
  failWith = null;
  assert.equal((await wallet.getBitcoinUtxos(ADDR)).utxos.length, 1, "and the next try works");

  // The wallet's own list fails, or the wallet has none: plain sentences, nothing built.
  const saved = unisat.getBitcoinUtxos;
  unisat.getBitcoinUtxos = async () => {
    throw new Error("wallet locked");
  };
  await assert.rejects(wallet.getBitcoinUtxos(ADDR), /^Error: UniSat could not list this wallet's BTC outputs \(wallet locked\) — try again\.$/);
  delete unisat.getBitcoinUtxos;
  await assert.rejects(wallet.getBitcoinUtxos(ADDR), /UniSat did not offer its list of BTC outputs.*update UniSat/);
  unisat.getBitcoinUtxos = saved;

  // A stopped build (the wallet changed while it read): an AbortError, no sentence.
  const ctrl = new AbortController();
  ctrl.abort();
  const stopped = await wallet.getBitcoinUtxos(ADDR, { signal: ctrl.signal }).catch((x) => x);
  assert.equal(stopped.name, "AbortError");
  console.log("unisat funding: kept / spent / unconfirmed / wrong script / wrong value / carrier; chunks of 100; a /txouts failure is a plain retry");
}

// ---- 3b. at one indexed height, an output that passed is not asked again ----------------------------------
{
  const asked = () => requested.flatMap((r) => new URL(`http://x${r}`).searchParams.get("o").split(","));
  walletRows = [uni(T("a7"), 0, 40_000), uni(T("a8"), 1, 30_000), uni(T("a9"), 0, 20_000)];
  nodeRows = new Map([
    [`${T("a7")}:0`, out(T("a7"), 0, 40_000)],
    [`${T("a8")}:1`, out(T("a8"), 1, 30_000)],
    // g3: not confirmed yet → waiting, asked again on every build
  ]);
  setIndexedTip(900_000);
  requested.length = 0;
  const first = await wallet.getBitcoinUtxos(ADDR);
  assert.deepEqual(first.utxos.map(key), [`${T("a7")}:0`, `${T("a8")}:1`]);
  assert.equal(asked().length, 3);
  // Same height: only the waiting output is asked again; the checked ones are still spendable.
  requested.length = 0;
  const second = await wallet.getBitcoinUtxos(ADDR);
  assert.deepEqual(second.utxos.map(key), [`${T("a7")}:0`, `${T("a8")}:1`]);
  assert.deepEqual(second.waitingOutpoints.map(key), [`${T("a9")}:0`]);
  assert.deepEqual(asked(), [`${T("a9")}:0`], "only the output that did not pass is asked again");
  // A new output in the wallet: only it (and the waiting one) is asked.
  walletRows = [...walletRows, uni(T("aa"), 2, 10_000)];
  nodeRows.set(`${T("aa")}:2`, out(T("aa"), 2, 10_000));
  requested.length = 0;
  assert.equal((await wallet.getBitcoinUtxos(ADDR)).utxos.length, 3);
  assert.deepEqual(asked(), [`${T("a9")}:0`, `${T("aa")}:2`]);
  // The checks still run on the wallet's current list: a remembered row with another value than listed now is left out.
  walletRows = [uni(T("a7"), 0, 41_000)];
  requested.length = 0;
  const changed = await wallet.getBitcoinUtxos(ADDR);
  assert.deepEqual([changed.utxos.length, changed.mismatchedOutpoints.map(key)], [0, [`${T("a7")}:0`]]);
  assert.equal(requested.length, 0, "nothing new to ask");
  // A new height forgets them all: the whole list is asked again.
  walletRows = [uni(T("a7"), 0, 40_000), uni(T("a8"), 1, 30_000)];
  setIndexedTip(900_001);
  requested.length = 0;
  await wallet.getBitcoinUtxos(ADDR);
  assert.deepEqual(asked(), [`${T("a7")}:0`, `${T("a8")}:1`]);
  // An output spent in the new block is no longer spendable once the height moves.
  nodeRows.delete(`${T("a8")}:1`);
  setIndexedTip(900_002);
  const spent = await wallet.getBitcoinUtxos(ADDR);
  assert.deepEqual([spent.utxos.map(key), spent.waitingOutpoints.map(key)], [[`${T("a7")}:0`], [`${T("a8")}:1`]]);
  // An unknown height remembers nothing: every build asks the whole list.
  setIndexedTip(null);
  for (let i = 0; i < 2; i++) {
    requested.length = 0;
    await wallet.getBitcoinUtxos(ADDR);
    assert.deepEqual(asked(), [`${T("a7")}:0`, `${T("a8")}:1`]);
  }
  console.log("unisat funding: at one indexed height a checked output is not asked again; a new or unknown height asks the whole list");
}

// ---- 4. the simulated wallet answers like UniSat; the mock's /txouts keeps carriers and pending outputs out ----------
{
  const listed = await mock.mockWalletUtxos(ADDR);
  assert.ok(listed.length > 0 && listed.every((u) => Number.isInteger(u.satoshis) && u.scriptPk === SCRIPT && Array.isArray(u.inscriptions) && Array.isArray(u.atomicals)), "UniSat's row shape");
  const v = await mockSpendable(mock, ADDR);
  const tokenKeys = new Set((await mock.mockGet(`/utxos/${ADDR}`)).utxos.map(key));
  assert.ok(v.utxos.length > 0 && v.utxos.every((u) => !tokenKeys.has(key(u)) && u.sats > 546), "fee inputs: plain confirmed BTC only");
  assert.ok(v.carrierOutpoints.length > 0 && v.carrierOutpoints.every((u) => tokenKeys.has(key(u))), "the wallet lists its carriers; the check leaves them out");
  assert.equal(v.waitingSats, 5_000, "the seeded pending output is waiting");
  const bal = await mock.mockWalletBalance(ADDR);
  assert.equal(bal.total, bal.confirmed + bal.unconfirmed);
  assert.equal(bal.unconfirmed, 5_000);
  console.log("simulated wallet: UniSat's list shape; the mock's /txouts leaves carriers and pending outputs out");
}

// ---- 5. UniSat only; nothing calls /btc-utxos --------------------------------------------------------
{
  assert.deepEqual(PROVIDER_IDS, ["unisat"]);
  assert.deepEqual(Object.keys(PROVIDER_META).sort(), ["mock", "unisat"]);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(join(root, "src"));
  walk(join(root, "public"));
  for (const f of ["index.html", "package.json"]) if (existsSync(join(root, f))) files.push(join(root, f));
  const rel = (p) => relative(root, p).split(sep).join("/");
  const okx = /okx/i;
  const hits = [];
  const scans = [];
  for (const f of files) {
    if (okx.test(rel(f))) hits.push(`${rel(f)}: file name`);
    if (!/\.(js|jsx|css|html|json|md|txt|svg)$/i.test(f) && !/_redirects$/.test(f)) continue;
    readFileSync(f, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (okx.test(line)) hits.push(`${rel(f)}:${i + 1}`);
        if (/btc-utxos|btcUtxos|retryWhileSeeding|seedWaitNote/.test(line)) scans.push(`${rel(f)}:${i + 1}`);
      });
  }
  assert.deepEqual(hits, [], "no other wallet is named in the code or the served files");
  assert.deepEqual(scans, [], "nothing calls GET /btc-utxos or waits for an address scan");
  console.log("unisat only: no other provider in src/, public/, index.html or package.json; no /btc-utxos call");
}

console.log("unisat: all checks passed");
