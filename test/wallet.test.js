// Pure-part tests for the multi-wallet layer and the fee-rate choice.
// Plain Node, no framework, no window: exercises src/lib/walletShapes.js
// (provider argument shapes) and src/lib/feechoice.js (persistence format,
// clamping, resolution against /fees).
import assert from "node:assert/strict";
import {
  PROVIDER_IDS,
  PROVIDER_META,
  WALLET_STORAGE_KEY,
  chipLabel,
  collectInscriptionOutpoints,
  defaultProviderId,
  inscriptionOutpoints,
  firstAccount,
  isConflictError,
  normalizeBalance,
  normalizePubkey,
  normalizeTxid,
  normalizeUtxo,
  normalizeUtxoList,
  pushTxArgs,
  shouldRestore,
  signPsbtArgs,
  toSignInputs,
} from "../src/lib/walletShapes.js";
import {
  DEFAULT_PRESET,
  FEE_CHOICE_KEY,
  FEE_PRESETS,
  clampCustomFee,
  parseFeeChoice,
  presetRows,
  presetUnavailableReason,
  presetUnavailableText,
  resolveFeeRate,
  serializeFeeChoice,
} from "../src/lib/feechoice.js";
import { MAX_FEE_RATE_SAT_VB } from "../src/lib/psbt.js";

const ADDR = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const TXID = "ab".repeat(32);
const PSBT = "70736274ff01000a0200000000000000000000";

// ---- provider metadata ---------------------------------------------------------------------
assert.deepEqual(PROVIDER_IDS, ["unisat", "okx"]);
assert.equal(PROVIDER_META.unisat.installUrl, "https://unisat.io");
assert.equal(PROVIDER_META.okx.installUrl, "https://web3.okx.com/download");
assert.equal(PROVIDER_META.okx.name, "OKX Wallet");
assert.equal(WALLET_STORAGE_KEY, "lp.wallet");
assert.equal(chipLabel("okx", "bc1p…62s"), "OKX · bc1p…62s");
assert.equal(chipLabel("unisat", "bc1p…62s"), "UniSat · bc1p…62s");
assert.equal(chipLabel("nope", "bc1p…62s"), "bc1p…62s");

// ---- signPsbt argument mapping ----------------------------------------------------------------
{
  const rows = toSignInputs({ inputIndexes: [0, 2], address: ADDR });
  assert.deepEqual(rows, [{ index: 0, address: ADDR }, { index: 2, address: ADDR }]);
  const withSighash = toSignInputs({ inputIndexes: [0], address: ADDR, sighashTypes: [0x83] });
  assert.deepEqual(withSighash, [{ index: 0, address: ADDR, sighashTypes: [0x83] }]);
  assert.throws(() => toSignInputs({ inputIndexes: [-1], address: ADDR }), /bad input index/);
  assert.throws(() => toSignInputs({ inputIndexes: [0], address: "" }), /address is required/);

  for (const id of ["unisat", "okx", "mock"]) {
    const [hex, opts] = signPsbtArgs(id, PSBT, { inputIndexes: [1, 2], address: ADDR });
    assert.equal(hex, PSBT, `${id}: psbt hex passed through`);
    assert.deepEqual(opts, { autoFinalized: true, toSignInputs: [{ index: 1, address: ADDR }, { index: 2, address: ADDR }] }, `${id}: default autoFinalized:true`);
  }
  // §7.1 listing shape: un-finalized, SINGLE|ANYONECANPAY declared.
  const [, listing] = signPsbtArgs("okx", PSBT, { inputIndexes: [0], address: ADDR, autoFinalized: false, sighashTypes: [0x83] });
  assert.deepEqual(listing, { autoFinalized: false, toSignInputs: [{ index: 0, address: ADDR, sighashTypes: [0x83] }] });
  assert.throws(() => signPsbtArgs("ledger", PSBT, { inputIndexes: [0], address: ADDR }), /unknown wallet provider/);
  assert.throws(() => signPsbtArgs("unisat", "zz", { inputIndexes: [0], address: ADDR }), /hex/);
}

// ---- pushTx argument shapes -------------------------------------------------------------------
{
  const raw = "0200000001" + "00".repeat(40);
  assert.deepEqual(pushTxArgs("unisat", raw), [{ rawtx: raw }], "UniSat: pushTx({ rawtx })");
  assert.deepEqual(pushTxArgs("okx", raw), [raw], "OKX: pushTx(rawHex)");
  assert.deepEqual(pushTxArgs("mock", raw), [raw]);
  assert.throws(() => pushTxArgs("unisat", "abc"), /even-length hex/);
  assert.throws(() => pushTxArgs("other", raw), /unknown wallet provider/);
}

// ---- result normalizers -----------------------------------------------------------------------
{
  assert.equal(firstAccount([ADDR]), ADDR, "requestAccounts() → [address]");
  assert.equal(firstAccount({ address: ADDR, publicKey: "02" + "ab".repeat(32) }), ADDR, "OKX connect() → { address }");
  assert.equal(firstAccount([]), null);
  assert.equal(firstAccount(null), null);
  assert.equal(normalizePubkey("02" + "AB".repeat(32)), "02" + "ab".repeat(32));
  assert.equal(normalizePubkey("ab".repeat(32)), null, "x-only is not accepted (need 33 bytes)");
  assert.equal(normalizeTxid(TXID.toUpperCase()), TXID);
  assert.equal(normalizeTxid("not a txid"), null);
  assert.deepEqual(normalizeBalance({ confirmed: "10", unconfirmed: 2.9, total: 12 }), { confirmed: 10, unconfirmed: 2, total: 12 });
  assert.deepEqual(normalizeBalance(null), { confirmed: 0, unconfirmed: 0, total: 0 });
  assert.deepEqual(normalizeUtxo({ txid: TXID.toUpperCase(), vout: 1, satoshis: 5000 }), { txid: TXID, vout: 1, sats: 5000 });
  assert.deepEqual(normalizeUtxo({ txid: TXID, vout: 0, value: 700 }), { txid: TXID, vout: 0, sats: 700 });
  assert.equal(normalizeUtxo({ txid: "xx", vout: 0, satoshis: 1 }), null);
  assert.equal(normalizeUtxo({ txid: TXID, vout: -1, satoshis: 1 }), null);
  assert.deepEqual(normalizeUtxoList({ list: [{ txid: TXID, vout: 3, satoshis: 900 }, { bogus: true }] }), [{ txid: TXID, vout: 3, sats: 900 }]);
  assert.deepEqual(normalizeUtxoList(undefined), []);
}

// ---- silent-restore + default-provider policy --------------------------------------------------
{
  assert.equal(shouldRestore("okx", ["unisat", "okx"]), true);
  assert.equal(shouldRestore("okx", ["unisat"]), false, "stored provider not injected → no restore");
  assert.equal(shouldRestore("ledger", ["unisat", "okx"]), false, "unknown id → no restore");
  assert.equal(shouldRestore(null, ["unisat"]), false);
  assert.equal(defaultProviderId(null, ["okx"]), "okx", "one injected → pick it");
  assert.equal(defaultProviderId(null, ["unisat", "okx"]), null, "two injected → user must choose");
  assert.equal(defaultProviderId("unisat", ["unisat", "okx"]), "unisat", "connected one wins");
  assert.equal(defaultProviderId(null, []), null);
}

// ---- M-8: inscription outpoints from getInscriptions pages ------------------------------------------
{
  const A = "aa".repeat(32);
  const B = "bb".repeat(32);
  const C = "cc".repeat(32);
  assert.deepEqual(
    inscriptionOutpoints({ total: 3, list: [{ inscriptionId: `${A}i0`, output: `${A.toUpperCase()}:1` }, { location: `${B}:0:333` }, { utxo: { txid: C, vout: "2" } }, { output: "nope" }, null] }),
    [`${A}:1`, `${B}:0`, `${C}:2`],
    "output / location / utxo shapes, malformed rows skipped",
  );
  assert.deepEqual(inscriptionOutpoints([{ output: `${A}:0` }]), [`${A}:0`], "bare array page");
  assert.deepEqual(inscriptionOutpoints(undefined), []);
  // paging: 2 full pages + 1 short page, cursor advances by list length
  const pages = [
    { total: 5, list: [{ output: `${A}:0` }, { output: `${A}:1` }] },
    { total: 5, list: [{ output: `${B}:0` }, { output: `${B}:1` }] },
    { total: 5, list: [{ output: `${C}:0` }] },
  ];
  const calls = [];
  const set = await collectInscriptionOutpoints((cursor, size) => { calls.push([cursor, size]); return pages[calls.length - 1]; }, { size: 2 });
  assert.deepEqual([...set].sort(), [`${A}:0`, `${A}:1`, `${B}:0`, `${B}:1`, `${C}:0`]);
  assert.deepEqual(calls, [[0, 2], [2, 2], [4, 2]]);
  // total reached exactly at a page boundary → no extra call
  const calls2 = [];
  await collectInscriptionOutpoints((cursor) => { calls2.push(cursor); return { total: 2, list: [{ output: `${A}:0` }, { output: `${A}:1` }] }; }, { size: 2 });
  assert.deepEqual(calls2, [0]);
  // maxPages bounds a runaway provider
  let n = 0;
  await collectInscriptionOutpoints(() => { n += 1; return { total: 1e9, list: [{ output: `${A}:${n}` }, { output: `${B}:${n}` }] }; }, { size: 2, maxPages: 3 });
  assert.equal(n, 3);
  // a throwing pager rejects (the wallet layer then falls back to assetSafe:false)
  await assert.rejects(collectInscriptionOutpoints(() => { throw new Error("provider down"); }), /provider down/);
}

// ---- conflict detection ------------------------------------------------------------------------
assert.equal(isConflictError(new Error("txn-mempool-conflict")), true);
assert.equal(isConflictError(new Error("bad-txns-inputs-missingorspent")), true);
assert.equal(isConflictError(new Error("Signature declined")), false);
assert.equal(isConflictError(Object.assign(new Error("x"), { conflict: true })), true);

// ---- fee choice: presets ------------------------------------------------------------------------
assert.equal(FEE_CHOICE_KEY, "lp.feeChoice");
assert.equal(DEFAULT_PRESET, "normal");
assert.deepEqual(FEE_PRESETS.map((p) => p.id), ["fast", "normal", "slow", "economy"]);
assert.deepEqual(FEE_PRESETS.map((p) => p.key), ["fastestFee", "halfHourFee", "hourFee", "economyFee"]);

const FEES = { fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 3, minimumFee: 1 };
assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, FEES), 12);
assert.equal(resolveFeeRate({ kind: "preset", id: "normal" }, FEES), 8);
assert.equal(resolveFeeRate({ kind: "preset", id: "slow" }, FEES), 5);
assert.equal(resolveFeeRate({ kind: "preset", id: "economy" }, FEES), 3);
assert.equal(resolveFeeRate({ kind: "preset", id: "normal" }, null), null, "no /fees → preset resolves to null (action disabled)");
assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, { fastestFee: 50_000 }), null, "a /fees value above the cap is REJECTED, not clamped (L-11)");
assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, { fastestFee: MAX_FEE_RATE_SAT_VB + 1 }), null);
assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, { fastestFee: MAX_FEE_RATE_SAT_VB }), MAX_FEE_RATE_SAT_VB, "exactly the cap is allowed");
assert.equal(resolveFeeRate({ kind: "preset", id: "normal" }, { fastestFee: 12, halfHourFee: null }), null, "a missing key is unavailable, never a default");
assert.equal(presetUnavailableReason("fast", { fastestFee: 50_000 }), "over-cap");
assert.equal(presetUnavailableReason("fast", { fastestFee: 12 }), null);
assert.equal(presetUnavailableReason("fast", null), "missing");
assert.equal(presetUnavailableReason("normal", { fastestFee: 12 }), "missing");
assert.deepEqual(presetRows({ fastestFee: 50_000, halfHourFee: 8 }).map((p) => [p.id, p.satVb, p.reason]), [["fast", null, "over-cap"], ["normal", 8, null], ["slow", null, "missing"], ["economy", null, "missing"]]);
assert.match(presetUnavailableText("over-cap"), /safety cap/);
assert.equal(presetUnavailableText("missing"), "estimate unavailable");
assert.equal(presetUnavailableText(null), null);
assert.equal(resolveFeeRate({ kind: "custom", value: 27 }, null), 27, "custom works without /fees");
assert.equal(resolveFeeRate({ kind: "custom", value: null }, FEES), null);
assert.deepEqual(
  presetRows(null).map((p) => p.satVb),
  [null, null, null, null],
  "presets disabled without /fees",
);
assert.deepEqual(presetRows(FEES).map((p) => [p.id, p.satVb]), [["fast", 12], ["normal", 8], ["slow", 5], ["economy", 3]]);
assert.ok(presetRows(FEES).every((p) => typeof p.eta === "string" && p.eta.length > 0));

// ---- fee choice: custom clamping ---------------------------------------------------------------
{
  assert.deepEqual(clampCustomFee("27"), { value: 27, error: null });
  assert.deepEqual(clampCustomFee(" 1 "), { value: 1, error: null });
  assert.deepEqual(clampCustomFee("1000"), { value: 1000, error: null });
  const over = clampCustomFee("1001");
  assert.equal(over.value, MAX_FEE_RATE_SAT_VB, "clamped to the safety cap");
  assert.match(over.error, /1,000 sat\/vB/);
  assert.equal(clampCustomFee("999999").value, MAX_FEE_RATE_SAT_VB);
  const zero = clampCustomFee("0");
  assert.equal(zero.value, 1);
  assert.match(zero.error, /Minimum/);
  assert.equal(clampCustomFee("-5").value, 1);
  const frac = clampCustomFee("12.7");
  assert.equal(frac.value, 12, "fractions floor");
  assert.match(frac.error, /Whole numbers/);
  const empty = clampCustomFee("");
  assert.equal(empty.value, null);
  assert.match(empty.error, /1–1,000/);
  assert.equal(clampCustomFee("abc").value, null);
  assert.equal(clampCustomFee(undefined).value, null);
}

// ---- fee choice: persistence round-trip -----------------------------------------------------------
{
  assert.deepEqual(parseFeeChoice(null), { kind: "preset", id: "normal" }, "first visit → Normal");
  assert.deepEqual(parseFeeChoice("garbage"), { kind: "preset", id: "normal" });
  assert.deepEqual(parseFeeChoice("fast"), { kind: "preset", id: "fast" });
  assert.deepEqual(parseFeeChoice("economy"), { kind: "preset", id: "economy" });
  assert.deepEqual(parseFeeChoice("27"), { kind: "custom", value: 27 });
  assert.deepEqual(parseFeeChoice("5000"), { kind: "custom", value: MAX_FEE_RATE_SAT_VB }, "a stale over-cap value is re-clamped on load");
  assert.deepEqual(parseFeeChoice("0"), { kind: "custom", value: 1 });
  assert.equal(serializeFeeChoice({ kind: "preset", id: "slow" }), "slow");
  assert.equal(serializeFeeChoice({ kind: "custom", value: 42 }), "42");
  assert.equal(serializeFeeChoice({ kind: "custom", value: null }), "normal", "an unusable custom falls back to the default");
  assert.equal(serializeFeeChoice({ kind: "preset", id: "bogus" }), "normal");
  for (const c of [{ kind: "preset", id: "fast" }, { kind: "custom", value: 250 }]) {
    assert.deepEqual(parseFeeChoice(serializeFeeChoice(c)), c, "round-trip");
  }
}

console.log("wallet: provider shapes + fee choice ok");
