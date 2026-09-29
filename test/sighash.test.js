// The signature type of an input (src/lib/sighash.js), read the way the
// indexer reads it (PROTOCOL.md §2): from a raw witness for the type of the
// output it spends, and from a signed PSBT (finalized or not) — what the
// wallet layer checks after every signature. Plain Node, no framework.
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import {
  LISTING_SIGHASH_BYTE,
  inputSighash,
  listedScriptType,
  scriptTypeOfHex,
  signedInputSighash,
  signedSighashMismatch,
} from "../src/lib/sighash.js";

const enc = (s) => new TextEncoder().encode(s);
const TXID = (i) => "cd".repeat(31) + String(i).padStart(2, "0");

function keyFor(seed, type) {
  const priv = sha256(enc(`sighash-test:${seed}`));
  const pub = pubECDSA(priv, true);
  if (type === "wpkh") {
    const p = btc.p2wpkh(pub, btc.NETWORK);
    return { priv, address: p.address, script: p.script, type };
  }
  const xonly = pubSchnorr(priv);
  const p = btc.p2tr(xonly, undefined, btc.NETWORK);
  return { priv, address: p.address, script: p.script, xonly, type: "tr" };
}

/**
 * A two-input PSBT spending two outputs of `key`, signed: input 0 with
 * `sighash0` (undefined = the default for the script type), input 1 with
 * the default. `finalize` finalizes both.
 */
function signedPsbt(key, { sighash0, finalize }) {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  for (let i = 0; i < 2; i++) {
    const input = { txid: TXID(i), index: 0, witnessUtxo: { script: key.script, amount: 10_000n } };
    if (key.type === "tr") input.tapInternalKey = key.xonly;
    if (i === 0 && sighash0 !== undefined) input.sighashType = sighash0;
    tx.addInput(input);
  }
  tx.addOutput({ script: key.script, amount: 5_000n });
  tx.addOutput({ script: key.script, amount: 5_000n });
  tx.signIdx(key.priv, 0, sighash0 !== undefined ? [sighash0] : undefined);
  tx.signIdx(key.priv, 1);
  if (finalize) {
    tx.finalizeIdx(0);
    tx.finalizeIdx(1);
  }
  return hex.encode(tx.toPSBT());
}

// ---- script types -------------------------------------------------------------------------------------------
const tr = keyFor("a", "tr");
const wpkh = keyFor("b", "wpkh");
assert.equal(scriptTypeOfHex(hex.encode(tr.script)), "tr");
assert.equal(scriptTypeOfHex(hex.encode(wpkh.script)), "wpkh");
assert.equal(scriptTypeOfHex(hex.encode(tr.script).toUpperCase()), "tr", "hex case does not matter");
assert.equal(scriptTypeOfHex("0020" + "11".repeat(32)), null, "P2WSH has no signature type");
assert.equal(scriptTypeOfHex("a914" + "11".repeat(20) + "87"), null, "P2SH has none");
assert.equal(scriptTypeOfHex("76a914" + "11".repeat(20) + "88ac"), null, "P2PKH has none");
assert.equal(scriptTypeOfHex("5120" + "11".repeat(31)), null, "a 31-byte v1 program is not P2TR");
assert.equal(scriptTypeOfHex(null), null);
assert.equal(listedScriptType(tr.address), "tr");
assert.equal(listedScriptType(wpkh.address), "wpkh");
assert.equal(listedScriptType("3" + "1".repeat(33)), null);
console.log("sighash: only P2TR (5120 + 32 bytes) and P2WPKH (0014 + 20 bytes) outputs yield a signature type");

// ---- inputSighash over raw witnesses ------------------------------------------------------------------------
const sig64 = "11".repeat(64);
const sig65 = (b) => "11".repeat(64) + b;
const der = (b) => "30" + "44".repeat(70) + b;
const key33 = "02" + "22".repeat(32);
assert.equal(inputSighash([sig64], "tr"), 0x00, "a 64-byte P2TR signature is SIGHASH_DEFAULT");
assert.equal(inputSighash([sig65("83")], "tr"), 0x83);
assert.equal(inputSighash([sig65("01")], "tr"), 0x01);
assert.equal(inputSighash([sig65("83"), "50aa"], "tr"), 0x83, "an annex is set aside");
assert.equal(inputSighash([sig64, "aa"], "tr"), null, "two elements without an annex: a script-path spend");
assert.equal(inputSighash(["11".repeat(63)], "tr"), null);
assert.equal(inputSighash([der("01"), key33], "wpkh"), 0x01);
assert.equal(inputSighash([der("83"), key33], "wpkh"), 0x83);
assert.equal(inputSighash([der("81")], "wpkh"), null, "P2WPKH needs exactly two elements");
assert.equal(inputSighash(["30" + "44".repeat(73) + "01", key33], "wpkh"), null, "a first element above 73 bytes");
assert.equal(inputSighash([sig65("83")], null), null, "a spent output with no type gives no type");
assert.equal(inputSighash([der("83"), key33], null), null);
assert.equal(inputSighash([der("83"), key33]), 0x83, "without a type the witness shape decides (never used by consensus-shaped code)");
assert.equal(LISTING_SIGHASH_BYTE, 0x83);
console.log("sighash: raw witnesses — P2TR 64 → 0x00, 65 → last byte, annex set aside; P2WPKH → last byte of the signature; no type → null");

// ---- signed PSBTs, finalized and not --------------------------------------------------------------------------
for (const key of [tr, wpkh]) {
  const dflt = key.type === "tr" ? 0x00 : 0x01;
  for (const finalize of [false, true]) {
    const plain = signedPsbt(key, { finalize });
    assert.equal(signedInputSighash(plain, 0), dflt, `${key.type} ${finalize ? "finalized" : "unfinalized"}: default type`);
    assert.equal(signedInputSighash(plain, 1), dflt);
    assert.equal(signedSighashMismatch(plain, [0, 1], [0x00, 0x01]), null, "whole-tx signatures pass the default check");
    assert.match(String(signedSighashMismatch(plain, [0], [0x83])), /input 0 was signed with type 0x0[01]/, "a listing asks for exactly 0x83");

    const listing = signedPsbt(key, { sighash0: 0x83, finalize });
    assert.equal(signedInputSighash(listing, 0), 0x83, `${key.type} ${finalize ? "finalized" : "unfinalized"}: 0x83`);
    assert.equal(signedInputSighash(listing, 1), dflt);
    assert.equal(signedSighashMismatch(listing, [0], [0x83]), null, "the listing's own signature passes");
    assert.equal(signedSighashMismatch(listing, [1], [0x00, 0x01]), null, "only the asked inputs are checked");
    assert.equal(signedSighashMismatch(listing, [0, 1], [0x00, 0x01]), "input 0 was signed with type 0x83", "a 0x83 signature where a whole-tx one was asked for");
    assert.equal(signedSighashMismatch(listing, null, [0x00, 0x01]), "input 0 was signed with type 0x83", "no index list: every input is checked");

    const anyone = signedPsbt(key, { sighash0: 0x81, finalize });
    assert.equal(signedInputSighash(anyone, 0), 0x81);
    assert.equal(signedSighashMismatch(anyone, [0, 1], [0x00, 0x01]), "input 0 was signed with type 0x81");
  }
}
// Unsigned, out of range, unreadable.
const unsigned = (() => {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: TXID(9), index: 0, witnessUtxo: { script: tr.script, amount: 10_000n }, tapInternalKey: tr.xonly });
  tx.addOutput({ script: tr.script, amount: 9_000n });
  return hex.encode(tx.toPSBT());
})();
assert.equal(signedInputSighash(unsigned, 0), null, "no signature, no type");
assert.equal(signedSighashMismatch(unsigned, [0], [0x00, 0x01]), "input 0 carries no signature this app can read");
assert.equal(signedInputSighash(unsigned, 5), null);
assert.equal(signedSighashMismatch(unsigned, [5], [0x00]), "input 5 carries no signature this app can read");
assert.equal(signedInputSighash("zz", 0), null);
assert.equal(signedSighashMismatch("00", [0], [0x00]), "the signed result is not a readable PSBT");
console.log("sighash: signed PSBTs (P2TR / P2WPKH, finalized or not) — default types pass, 0x83 / 0x81 on an asked input are named, unsigned inputs are refused");
