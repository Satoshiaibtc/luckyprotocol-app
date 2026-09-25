import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex, base64 } from "@scure/base";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import {
  buildEnvelopeScript, ephemeralXonly, commitPayment, commitAmountFor,
  buildDeployRevealPsbt, finalizeReveal, signRevealEphemeral, parseAvatarRecord,
  writeDeployRecord, loadDeployRecord, unlockDeployRecord, deriveRecordKey,
  deployRecordKey, avatarRecordKey, buildSweepPsbt, signSweep, assertRevealWalletResult,
} from "../src/lib/inscribe.js";
import { buildPayPsbt, extractRawTxHex, expectPsbtPayload } from "../src/lib/psbt.js";
import { MOCK_WALLET, mockSignPsbt, simulateBroadcast, mockGet } from "../src/lib/mock.js";
import { PROJECT_FEE_ADDRESS } from "../src/lib/payloads.js";
import { decodeRawTx } from "../src/lib/swap.js";

// Fixed, unfunded test keys; no RPC, provider, or real broadcast is used.
const priv = new Uint8Array(32).fill(7);
const body = new TextEncoder().encode("RIFF0000WEBPtest-avatar");
const leaf = buildEnvelopeScript(ephemeralXonly(priv), "image/webp", body);
const pay = commitPayment(priv, leaf);
const amount = commitAmountFor({ leafScriptLen: leaf.length, feeRateSatVb: 4 });
const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
const signer = (psbt, indexes) => mockSignPsbt(psbt, { autoFinalized: true, toSignInputs: indexes.map((index) => ({ index, address: MOCK_WALLET.address })) });

const commit = buildPayPsbt({ address: MOCK_WALLET.address, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: [{ txid: "aa".repeat(32), vout: 0, sats: 100_000 }], tokenOutpoints: [], feeRateSatVb: 4, toAddress: pay.address, amountSats: amount });
const signedCommit = signer(commit.psbtHex, commit.inputIndexes);
assertRevealWalletResult(commit.psbtHex, signedCommit);
const commitRawHex = extractRawTxHex(signedCommit);
const commitTx = decodeRawTx(commitRawHex);
const commitOut = { txid: commitTx.txid, vout: 0, sats: amount };
let built, reveal;
for (const type of ["tr", "wpkh"]) {
  const walletPriv = new Uint8Array(32).fill(9);
  const publicKey = pubECDSA(walletPriv);
  const address = type === "tr" ? MOCK_WALLET.address : btc.p2wpkh(publicKey).address;
  const pubkeyHex = type === "tr" ? MOCK_WALLET.pubkeyHex : hex.encode(publicKey);
  built = buildDeployRevealPsbt({
    commit: commitOut, ephemeralPriv: priv, leafScript: leaf, deployerAddress: address,
    deployerPubkeyHex: pubkeyHex, feeRateSatVb: 4, ticker: "IMAGE",
    utxos: [{ txid: "dd".repeat(32), vout: 0, sats: 546 }, { txid: "ee".repeat(32), vout: 1, sats: 6000 }, { txid: commitTx.txid, vout: 1, sats: commitTx.outputs[1].sats }],
    tokenOutpoints: [{ txid: "ee".repeat(32), vout: 1 }],
  });
  assert.equal(built.inputs.length, 1);
  assert.equal(built.inputs[0].txid, commitTx.txid, "dust and token-bearing inputs excluded");
  expectPsbtPayload(built.psbtHex, { op: "DEPLOY", ticker: "IMAGE" });
  let signed;
  if (type === "tr") signed = signer(built.psbtHex, built.walletInputIndexes);
  else {
    const tx = btc.Transaction.fromPSBT(hex.decode(built.psbtHex), opts);
    for (const i of built.walletInputIndexes) { tx.signIdx(walletPriv, i); tx.finalizeIdx(i); }
    signed = hex.encode(tx.toPSBT());
  }
  assertRevealWalletResult(built.psbtHex, signed);
  const bad = btc.Transaction.fromPSBT(hex.decode(built.psbtHex), opts);
  bad.addOutputAddress(address, 546n);
  assert.throws(() => assertRevealWalletResult(built.psbtHex, hex.encode(bad.toPSBT())), /changed/);
  reveal = finalizeReveal(signRevealEphemeral(signed, priv));
  const tx = decodeRawTx(reveal.rawHex);
  assert.equal(tx.outputs[0].sats, 546);
  assert.equal(tx.outputs[0].address, address);
  assert.equal(tx.outputs[1].sats, 5460);
  assert.equal(tx.outputs[1].address, PROJECT_FEE_ADDRESS);
  assert.equal(tx.payload.op, "DEPLOY");
  assert.equal(tx.payload.ticker, "IMAGE");
  assert.deepEqual(reveal.envelope.bytes, body);
  assert.equal(amount + built.inputs.reduce((s, u) => s + u.sats, 0) - tx.outputs.reduce((s, o) => s + o.sats, 0), built.feeSats);
  assert.ok(built.feeSats >= reveal.vsize * 4, `fee covers actual signed vsize (${type}: ${built.feeSats} / ${reveal.vsize})`);
  if (type === "tr") {
    simulateBroadcast(commitRawHex);
    assert.equal(simulateBroadcast(reveal.rawHex), reveal.txid);
    assert.equal(simulateBroadcast(commitRawHex), commitTx.txid, "exact retry does not pay twice");
    const now = Date.now;
    try {
      Date.now = () => now() + 60_000;
      const token = await mockGet("/tokens/IMAGE");
      assert.equal(token.avatar_txid, reveal.txid);
      assert.equal(token.deployer, MOCK_WALLET.address);
      const own = await mockGet(`/tokens?deployer=${MOCK_WALLET.address}&limit=1`);
      assert.ok(own.items.every((t) => t.deployer === MOCK_WALLET.address));
      assert.ok(own.items.length <= 1);
    } finally { Date.now = now; }
  }
}

const record = { kind: "deploy", address: MOCK_WALLET.address, ticker: "IMAGE", ephemeralPrivHex: hex.encode(priv), leafScriptHex: hex.encode(leaf), contentType: "image/webp", bytesBase64: base64.encode(body), commitAddress: pay.address, commitAmount: amount, commitSats: amount, commitTxid: commitTx.txid, commitVout: 0, commitRawHex, commitInputs: commit.inputs, createdAt: Date.now() };
assert.equal(parseAvatarRecord(record).kind, "deploy");
assert.equal(parseAvatarRecord({ ...record, commitTxid: "ff".repeat(32) }), null);
assert.equal(parseAvatarRecord({ ...record, commitAddress: MOCK_WALLET.address }), null);
assert.equal(parseAvatarRecord({ ...record, address: "not-an-address" }), null);
assert.equal(parseAvatarRecord({ ...record, commitRawHex: undefined }), null);
assert.equal(parseAvatarRecord({ ...record, commitVout: 1 }), null);
assert.equal(parseAvatarRecord({ ...record, commitSats: amount + 1 }), null);
assert.equal(parseAvatarRecord({ ...record, commitInputs: [] }), null);
assert.equal(parseAvatarRecord({ ...record, commitChange: { vout: 0, sats: amount } }), null);
const values = new Map();
globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
const key = await deriveRecordKey(new Uint8Array(64).fill(1), MOCK_WALLET.address);
const wrong = await deriveRecordKey(new Uint8Array(64).fill(2), MOCK_WALLET.address);
await writeDeployRecord(record, key);
assert.equal(loadDeployRecord("IMAGE").status, "encrypted");
assert.ok(!values.get(deployRecordKey("IMAGE")).includes(record.ephemeralPrivHex));
assert.equal(values.has(avatarRecordKey("IMAGE")), false);
assert.equal((await unlockDeployRecord("IMAGE", wrong)).status, "wrong-key");
assert.equal((await unlockDeployRecord("IMAGE", key)).record.commitRawHex, commitRawHex);
const sweep = buildSweepPsbt({ commit: commitOut, ephemeralPriv: priv, leafScript: leaf, toAddress: MOCK_WALLET.address, feeRateSatVb: 1 });
const refund = signSweep(sweep.psbtHex, priv);
const refunded = decodeRawTx(refund.rawHex);
assert.equal(refunded.outputs[0].address, MOCK_WALLET.address);
assert.equal(refunded.payload, null);
assert.equal(refunded.outputs[0].sats, amount - sweep.feeSats);
await writeDeployRecord({ ...record, reclaimTxid: refund.txid, reclaimRawHex: refund.rawHex }, key);
assert.equal((await unlockDeployRecord("IMAGE", key)).record.reclaimTxid, refund.txid);
globalThis.localStorage.setItem = () => { throw new Error("quota"); };
await assert.rejects(() => writeDeployRecord(record, key), /quota/);
delete globalThis.localStorage;
console.log("deploy avatar: real signatures, layout, protected inputs, encryption, exact retries, refund and mock registration passed");
