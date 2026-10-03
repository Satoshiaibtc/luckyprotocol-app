// Pure-part tests for the wallet layer and the fee-rate choice.
// Plain Node, no framework, no window: exercises src/lib/walletShapes.js
// (provider argument shapes) and src/lib/feechoice.js (persistence format,
// clamping, resolution against /fees). The funding path (the wallet's own
// list checked with GET /txouts) is tested in test/unisat.test.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROVIDER_IDS,
  PROVIDER_META,
  WALLET_STORAGE_KEY,
  canSwitchWallet,
  chipLabel,
  defaultProviderId,
  firstAccount,
  isConflictError,
  isMainnetAddress,
  normalizeBalance,
  normalizePubkey,
  normalizeTxid,
  normalizeUtxo,
  pushTxArgs,
  shouldRestore,
  signPsbtArgs,
  toSignInputs,
} from "../src/lib/walletShapes.js";
import {
  DEFAULT_PRESET,
  FEE_CHOICE_KEY,
  FEE_PRESETS,
  FEE_READING_TEXT,
  RETIRED_FEE_CHOICE_KEY,
  loadFeeChoice,
  saveFeeChoice,
  clampCustomFee,
  isUsableFeeRate,
  parseFeeChoice,
  presetRows,
  presetUnavailableReason,
  presetUnavailableText,
  resolveFeeRate,
  serializeFeeChoice,
  missingFeeHint,
  HIGH_FEE_MIN_SAT_VB,
  highFeeThreshold,
  needsHighFeeAck,
} from "../src/lib/feechoice.js";
import { MAX_FEE_RATE_SAT_VB } from "../src/lib/psbt.js";

const ADDR = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const TXID = "ab".repeat(32);
const PSBT = "70736274ff01000a0200000000000000000000";

// ---- provider metadata ---------------------------------------------------------------------
assert.deepEqual(PROVIDER_IDS, ["unisat"], "UniSat is the one wallet offered");
assert.equal(PROVIDER_META.unisat.installUrl, "https://unisat.io");
assert.deepEqual(Object.keys(PROVIDER_META).sort(), ["mock", "unisat"], "no other provider is known");
assert.equal(WALLET_STORAGE_KEY, "lp.wallet");
assert.equal(chipLabel("unisat", "bc1p…62s"), "UniSat · bc1p…62s");
assert.equal(chipLabel("nope", "bc1p…62s"), "bc1p…62s");
for (const id of PROVIDER_IDS) {
  // The wallet cards show only the logo, name, status and action.
  assert.equal(PROVIDER_META[id].description, undefined, `${id}: no card description`);
  assert.ok(PROVIDER_META[id].mobileHint.includes("app"), `${id}: phone guidance names the app`);
}

// ---- mainnet-only account guard (wallet dialog / connect) -------------------------------------------
assert.equal(isMainnetAddress(ADDR), true, "bc1p taproot");
assert.equal(isMainnetAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), true, "bc1q native segwit");
assert.equal(isMainnetAddress("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4"), true, "upper-case bech32 is still mainnet");
assert.equal(isMainnetAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"), false, "testnet tb1 refused");
assert.equal(isMainnetAddress("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"), false, "regtest refused");
assert.equal(isMainnetAddress("1BoatSLRHtKNngkdXEeobR76b53LETtpyT"), false, "legacy P2PKH refused");
assert.equal(isMainnetAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"), false, "P2SH refused");
assert.equal(isMainnetAddress("0x52908400098527886E0F7030069857D2E4169EE7"), false, "an EVM account refused");
assert.equal(isMainnetAddress("bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), false, "mixed case refused");
assert.equal(isMainnetAddress(""), false);
assert.equal(isMainnetAddress(null), false);

// ---- signPsbt argument mapping ----------------------------------------------------------------
{
  const rows = toSignInputs({ inputIndexes: [0, 2], address: ADDR });
  assert.deepEqual(rows, [{ index: 0, address: ADDR }, { index: 2, address: ADDR }]);
  const withSighash = toSignInputs({ inputIndexes: [0], address: ADDR, sighashTypes: [0x83] });
  assert.deepEqual(withSighash, [{ index: 0, address: ADDR, sighashTypes: [0x83] }]);
  assert.throws(() => toSignInputs({ inputIndexes: [-1], address: ADDR }), /bad input index/);
  assert.throws(() => toSignInputs({ inputIndexes: [0], address: "" }), /address is required/);

  for (const id of ["unisat", "mock"]) {
    const [hex, opts] = signPsbtArgs(id, PSBT, { inputIndexes: [1, 2], address: ADDR });
    assert.equal(hex, PSBT, `${id}: psbt hex passed through`);
    assert.deepEqual(opts, { autoFinalized: true, toSignInputs: [{ index: 1, address: ADDR }, { index: 2, address: ADDR }] }, `${id}: default autoFinalized:true`);
  }
  // §7.1 listing shape: un-finalized, SINGLE|ANYONECANPAY declared.
  const [, listing] = signPsbtArgs("unisat", PSBT, { inputIndexes: [0], address: ADDR, autoFinalized: false, sighashTypes: [0x83] });
  assert.deepEqual(listing, { autoFinalized: false, toSignInputs: [{ index: 0, address: ADDR, sighashTypes: [0x83] }] });
  assert.throws(() => signPsbtArgs("ledger", PSBT, { inputIndexes: [0], address: ADDR }), /unknown wallet provider/);
  assert.throws(() => signPsbtArgs("okx", PSBT, { inputIndexes: [0], address: ADDR }), /unknown wallet provider/, "a provider this site does not offer");
  assert.throws(() => signPsbtArgs("unisat", "zz", { inputIndexes: [0], address: ADDR }), /hex/);
}

// ---- pushTx argument shapes -------------------------------------------------------------------
{
  const raw = "0200000001" + "00".repeat(40);
  assert.deepEqual(pushTxArgs("unisat", raw), [{ rawtx: raw }], "UniSat: pushTx({ rawtx })");
  assert.deepEqual(pushTxArgs("mock", raw), [{ rawtx: raw }], "the simulated wallet takes UniSat's shape");
  assert.throws(() => pushTxArgs("unisat", "abc"), /even-length hex/);
  assert.throws(() => pushTxArgs("other", raw), /unknown wallet provider/);
  assert.throws(() => pushTxArgs("okx", raw), /unknown wallet provider/);
}

// ---- result normalizers -----------------------------------------------------------------------
{
  assert.equal(firstAccount([ADDR]), ADDR, "requestAccounts() → [address]");
  assert.equal(firstAccount({ address: ADDR }), null, "only UniSat's [address] shape");
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
}

// ---- the connected dialog offers a switch only when there is another wallet ------------------------
{
  assert.equal(canSwitchWallet("unisat"), false, "UniSat only: the account is changed in UniSat");
  assert.equal(canSwitchWallet("unisat", { mock: true }), true, "mock mode: the simulated wallet is offered");
  assert.equal(canSwitchWallet("mock", { mock: true }), true, "on the simulated wallet: UniSat is offered");
}

// ---- silent-restore + default-provider policy --------------------------------------------------
{
  assert.equal(shouldRestore("unisat", ["unisat"]), true);
  assert.equal(shouldRestore("unisat", []), false, "stored provider not injected → no restore");
  assert.equal(shouldRestore("okx", ["unisat", "okx"]), false, "a provider this site does not offer → no restore");
  assert.equal(shouldRestore("ledger", ["unisat"]), false, "unknown id → no restore");
  assert.equal(shouldRestore(null, ["unisat"]), false);
  assert.equal(defaultProviderId(null, ["unisat"]), "unisat", "one injected → pick it");
  assert.equal(defaultProviderId(null, ["okx"]), null, "a provider this site does not offer is never picked");
  assert.equal(defaultProviderId(null, ["unisat", "mock"]), null, "two present (mock mode) → user must choose");
  assert.equal(defaultProviderId("unisat", ["unisat", "mock"]), "unisat", "connected one wins");
  assert.equal(defaultProviderId(null, []), null);
}

// ---- conflict detection ------------------------------------------------------------------------
assert.equal(isConflictError(new Error("txn-mempool-conflict")), true);
assert.equal(isConflictError(new Error("bad-txns-inputs-missingorspent")), true);
assert.equal(isConflictError(new Error("Signature declined")), false);
assert.equal(isConflictError(Object.assign(new Error("x"), { conflict: true })), true);

// ---- fee choice: presets ------------------------------------------------------------------------
assert.equal(FEE_CHOICE_KEY, "lp.feeTier");
assert.equal(RETIRED_FEE_CHOICE_KEY, "lp.feeChoice");
assert.equal(DEFAULT_PRESET, "fast", "the recommended rate is Fast (the next block's median)");
assert.deepEqual(FEE_PRESETS.map((p) => p.id), ["fast", "normal", "slow", "economy"]);
assert.deepEqual(FEE_PRESETS.map((p) => p.key), ["fastestFee", "halfHourFee", "hourFee", "economyFee"]);

const FEES = { fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 3, minimumFee: 1 };
assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, FEES), 12);
assert.equal(resolveFeeRate({ kind: "preset", id: "normal" }, FEES), 8);
assert.equal(resolveFeeRate({ kind: "preset", id: "slow" }, FEES), 5);
assert.equal(resolveFeeRate({ kind: "preset", id: "economy" }, FEES), 3);
assert.equal(resolveFeeRate({ kind: "preset", id: "normal" }, null), null, "no /fees → preset resolves to null (action disabled)");
assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, { fastestFee: 50_000 }), null, "a /fees value above the cap is REJECTED, not clamped");
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

// A saved preset follows each new quote; an explicit custom rate does not.
{
  const updated = { fastestFee: 7, halfHourFee: 4, hourFee: 2, economyFee: 1 };
  assert.deepEqual(presetRows(updated).map((p) => p.satVb), [7, 4, 2, 1]);
  const normal = parseFeeChoice("normal");
  assert.equal(resolveFeeRate(normal, FEES), 8);
  assert.equal(resolveFeeRate(normal, updated), 4);
  assert.equal(resolveFeeRate(normal, null), null, "failed quote must not preserve a spendable estimate");
  assert.equal(resolveFeeRate(parseFeeChoice("27"), updated), 27);
  const fractional = { fastestFee: 3.75, halfHourFee: 2.5, hourFee: 1.25, economyFee: 1.01 };
  assert.deepEqual(presetRows(fractional).map((p) => p.satVb), [3.75, 2.5, 1.25, 1.01]);
  assert.equal(missingFeeHint({ kind: "custom", value: 1.25 }, 1.25), null);
}

// ---- fee choice: the one spend gate (fractional rates are usable; an integer check is not) ----------
{
  for (const ok of [1, 1.02, 1.25, 2.38, MAX_FEE_RATE_SAT_VB]) assert.equal(isUsableFeeRate(ok), true, `usable: ${ok}`);
  for (const bad of [0, 0.99, NaN, Infinity, null, undefined, MAX_FEE_RATE_SAT_VB + 0.01]) assert.equal(isUsableFeeRate(bad), false, `not usable: ${bad}`);
  assert.equal(isUsableFeeRate("2"), false, "a string is not a rate");
}

// ---- fee choice: custom validation — out of range is unusable, never clamped -------
{
  assert.deepEqual(clampCustomFee("27"), { value: 27, error: null });
  assert.deepEqual(clampCustomFee(" 1 "), { value: 1, error: null });
  assert.deepEqual(clampCustomFee("1000"), { value: 1000, error: null });
  const over = clampCustomFee("1001");
  assert.equal(over.value, null, "above the cap is unusable, not clamped to it");
  assert.match(over.error, /1,000 sat\/vB safety cap — not used/);
  const typo = clampCustomFee("5000"); // meant 50
  assert.equal(typo.value, null);
  assert.equal(isUsableFeeRate(typo.value), false, "the typo cannot reach a builder");
  assert.equal(clampCustomFee("999999").value, null);
  const zero = clampCustomFee("0");
  assert.equal(zero.value, null);
  assert.match(zero.error, /minimum/);
  assert.equal(clampCustomFee("-5").value, null);
  const frac = clampCustomFee("12.7");
  assert.deepEqual(frac, { value: 12.7, error: null }, "fractional rates are never floored");
  assert.deepEqual(clampCustomFee("1.25"), { value: 1.25, error: null });
  assert.deepEqual(clampCustomFee("1."), { value: 1, error: null }, "typing a decimal separator is allowed");
  assert.deepEqual(clampCustomFee("1000.00"), { value: 1000, error: null });
  assert.equal(clampCustomFee("1000.01").value, null);
  assert.equal(clampCustomFee("1.234").value, null);
  assert.match(clampCustomFee("1.234").error, /2 decimal/);
  for (const bad of ["1.2.3", "1e3", "NaN", "Infinity", "."]) assert.equal(clampCustomFee(bad).value, null);
  const empty = clampCustomFee("");
  assert.equal(empty.value, null);
  assert.match(empty.error, /1–1,000/);
  assert.equal(clampCustomFee("abc").value, null);
  assert.equal(clampCustomFee(undefined).value, null);
}

// ---- fee choice: persistence round-trip -----------------------------------------------------------
{
  assert.deepEqual(parseFeeChoice(null), { kind: "preset", id: "fast" }, "first visit → Fast");
  assert.deepEqual(parseFeeChoice("garbage"), { kind: "preset", id: "fast" });
  assert.deepEqual(parseFeeChoice("normal"), { kind: "preset", id: "normal" }, "a stored choice is kept");
  assert.deepEqual(parseFeeChoice("fast"), { kind: "preset", id: "fast" });
  assert.deepEqual(parseFeeChoice("economy"), { kind: "preset", id: "economy" });
  assert.deepEqual(parseFeeChoice("27"), { kind: "custom", value: 27 });
  assert.deepEqual(parseFeeChoice("1.25"), { kind: "custom", value: 1.25 });
  assert.deepEqual(parseFeeChoice(2.5), { kind: "custom", value: 2.5 });
  assert.deepEqual(parseFeeChoice("1.234"), { kind: "preset", id: DEFAULT_PRESET });
  assert.deepEqual(parseFeeChoice("5000"), { kind: "preset", id: DEFAULT_PRESET }, "a stale over-cap value from an older build is dropped on load, never clamped");
  assert.deepEqual(parseFeeChoice("0"), { kind: "preset", id: DEFAULT_PRESET });
  assert.equal(resolveFeeRate({ kind: "custom", value: 5000 }, null), null, "an out-of-range custom value resolves to no rate");
  assert.equal(serializeFeeChoice({ kind: "preset", id: "slow" }), "slow");
  assert.equal(serializeFeeChoice({ kind: "custom", value: 42 }), "42");
  assert.equal(serializeFeeChoice({ kind: "custom", value: null }), "fast", "an unusable custom falls back to the default");
  assert.equal(serializeFeeChoice({ kind: "preset", id: "bogus" }), "fast");
  for (const c of [{ kind: "preset", id: "fast" }, { kind: "custom", value: 250 }, { kind: "custom", value: 1.25 }]) {
    assert.deepEqual(parseFeeChoice(serializeFeeChoice(c)), c, "round-trip");
  }
}

// ---- fee choice: stored only when the visitor makes one; the retired key is ignored ----------------
{
  const memStorage = (init = {}) => {
    const m = new Map(Object.entries(init));
    return {
      m,
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => void m.set(k, String(v)),
      removeItem: (k) => void m.delete(k),
    };
  };
  // A browser that opened the site before has the retired key: ignored once, then gone.
  const old = memStorage({ [RETIRED_FEE_CHOICE_KEY]: "normal" });
  assert.deepEqual(loadFeeChoice(old), { kind: "preset", id: "fast" }, "the retired key is not read: the visitor starts on Fast");
  assert.equal(old.m.has(RETIRED_FEE_CHOICE_KEY), false, "…and it is removed");
  assert.equal(old.m.has(FEE_CHOICE_KEY), false, "loading stores nothing");
  // A choice the visitor made is kept.
  for (const [raw, choice] of [["normal", { kind: "preset", id: "normal" }], ["economy", { kind: "preset", id: "economy" }], ["2.5", { kind: "custom", value: 2.5 }]]) {
    assert.deepEqual(loadFeeChoice(memStorage({ [FEE_CHOICE_KEY]: raw, [RETIRED_FEE_CHOICE_KEY]: "slow" })), choice, `stored ${raw} is kept`);
  }
  assert.deepEqual(loadFeeChoice(memStorage()), { kind: "preset", id: "fast" }, "nothing stored: Fast");
  assert.deepEqual(loadFeeChoice(null), { kind: "preset", id: "fast" }, "no storage: Fast");
  const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); }, removeItem: () => { throw new Error("SecurityError"); } };
  assert.deepEqual(loadFeeChoice(throwing), { kind: "preset", id: "fast" }, "blocked storage reads as nothing stored");
  assert.equal(saveFeeChoice(throwing, { kind: "preset", id: "slow" }), false, "a failing write never throws");
  // Saving: presets and usable custom rates; an empty or rejected entry keeps the last choice.
  const st = memStorage();
  assert.equal(saveFeeChoice(st, { kind: "preset", id: "slow" }), true);
  assert.equal(st.m.get(FEE_CHOICE_KEY), "slow");
  assert.equal(saveFeeChoice(st, { kind: "custom", value: 1.25 }), true);
  assert.equal(st.m.get(FEE_CHOICE_KEY), "1.25");
  for (const bad of [{ kind: "custom", value: null }, { kind: "custom", value: 5000 }, { kind: "custom", value: 0.5 }, { kind: "preset", id: "bogus" }, { kind: "x" }, null]) {
    assert.equal(saveFeeChoice(st, bad), false, `not stored: ${JSON.stringify(bad)}`);
  }
  assert.equal(st.m.get(FEE_CHOICE_KEY), "1.25", "the last choice made stays");
  assert.equal(saveFeeChoice(null, { kind: "preset", id: "fast" }), false);
  // The hook stores only from the visitor's own picks — never on mount or on a re-render.
  const hook = readFileSync(new URL("../src/hooks/useFeeRate.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  assert.doesNotMatch(hook, /useEffect/, "no effect stores the choice");
  assert.equal((hook.match(/saveFeeChoice\(/g) || []).length, 1, "one place stores it…");
  assert.match(hook, /const choose = useCallback\(\s*\(next\) => \{\s*setChoice\(next\);\s*if \(persist\) saveFeeChoice\(browserStorage\(\), next\);/, "…the visitor's choose()");
  const segment = (name) => {
    const at = hook.indexOf(`const ${name} = useCallback(`);
    assert.ok(at > 0, `${name} exists`);
    const end = hook.indexOf("\n  const ", at + 1);
    return hook.slice(at, end > 0 ? end : undefined);
  };
  for (const fn of ["pickPreset", "pickCustom", "onCustomText", "pickRate"]) assert.match(segment(fn), /\bchoose\(\{/, `${fn} goes through choose()`);
  assert.equal((hook.match(/\bsetChoice\(/g) || []).length, 1, "nothing else sets the choice");
  console.log("fee choice: stored only when the visitor picks; the retired key is ignored and removed");
}

// ---- fee choice: rates still on their way are not called missing ---------------------------------
{
  assert.equal(FEE_READING_TEXT, "Reading fee rates…");
  assert.equal(missingFeeHint({ kind: "preset", id: "fast" }, null, "mine", { reading: true }), "Reading fee rates…");
  assert.match(missingFeeHint({ kind: "preset", id: "fast" }, null, "mine"), /^No fee estimate from the indexer or mempool\.space — choose Custom/);
  assert.match(missingFeeHint({ kind: "custom", value: null }, null, "mine", { reading: true }), /^Enter a custom fee rate/, "a custom choice does not wait for estimates");
  const sel = readFileSync(new URL("../src/components/FeeSelector.jsx", import.meta.url), "utf8");
  assert.match(sel, /!fee\.feesAvailable && !overCap && fee\.reading && <span className="fee-sel-note">\{FEE_READING_TEXT\}<\/span>/, "the selector says the rates are being read");
  assert.match(sel, /!fee\.feesAvailable && !overCap && !fee\.reading && <span className="fee-sel-note">No fee estimates/, "…and that there are none only after");
}

// ---- high custom rates need an explicit confirmation -----------------------------------
{
  assert.equal(highFeeThreshold(null), HIGH_FEE_MIN_SAT_VB, "no estimates → the absolute floor");
  assert.equal(highFeeThreshold({ fastestFee: 12 }), HIGH_FEE_MIN_SAT_VB, "2 × 12 is below the floor");
  assert.equal(highFeeThreshold({ fastestFee: 80 }), 160);
  assert.equal(highFeeThreshold({ fastestFee: 5000 }), HIGH_FEE_MIN_SAT_VB, "an over-cap estimate is ignored");
  assert.equal(needsHighFeeAck(50, { fastestFee: 12 }), false);
  assert.equal(needsHighFeeAck(500, { fastestFee: 12 }), true, "a 500 sat/vB typo for 50 asks first");
  assert.equal(needsHighFeeAck(150, { fastestFee: 80 }), false, "inside 2 × a busy mempool's fastest rate");
  assert.equal(needsHighFeeAck(null, { fastestFee: 12 }), false);
  assert.match(missingFeeHint({ kind: "custom", value: 500 }, null, "mine", { awaitingAck: true }), /Confirm the high custom fee rate/);
}

console.log("wallet: provider shapes + fee choice ok");
