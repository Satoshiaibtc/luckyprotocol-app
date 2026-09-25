// Structural + signing tests for src/lib/inscribe.js (PROTOCOL-v3.md §8) and
// buildPayPsbt. Plain Node, no framework. Covers:
//   * envelope script round-trip (build → parse → same content type + bytes),
//     ord tag encodings, ≤ 520-byte chunks, the indexer's alternate tag forms
//   * deterministic commit address for a fixed key
//   * commit (buildPayPsbt) → reveal (buildRevealPsbt) → wallet signs first
//     (mock provider, really signs) → ephemeral script-path signature →
//     finalize → extract; §8.1 output layout; OP_RETURN text; fee == in − out
//   * the same reveal with a P2WPKH deployer signed directly with btc-signer
//   * the recovery record's parse / serialize round-trip
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import * as btc from "@scure/btc-signer";
import { hex, base64 } from "@scure/base";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import {
  AVATAR_CONTENT_TYPES,
  MAX_AVATAR_BYTES,
  MAX_CHUNK_BYTES,
  REVEAL_SIGNING_ORDER,
  buildEnvelopeScript,
  parseEnvelopeScript,
  parseEnvelopeFromWitness,
  checkEnvelopeLimits,
  tokenizeScript,
  envelopeScriptLen,
  generateEphemeralKey,
  ephemeralXonly,
  commitPayment,
  commitAddress,
  commitAmountFor,
  revealInput0Vsize,
  estimateRevealFee,
  buildRevealPsbt,
  signRevealEphemeral,
  finalizeReveal,
  parseAvatarRecord,
  serializeAvatarRecord,
  avatarRecordKey,
  bytesToDataUrl,
} from "../src/lib/inscribe.js";
import { buildPayPsbt, estimatePayFeeSats, extractRawTxHex } from "../src/lib/psbt.js";
import { PROJECT_FEE_ADDRESS, buildAvatarPayload, parsePayload, payloadToString } from "../src/lib/payloads.js";
import { MOCK_WALLET, mockSignPsbt } from "../src/lib/mock.js";
import { decodeRawTx } from "../src/lib/swap.js";

const T = (i) => "cd".repeat(31) + String(i).padStart(2, "0");
const addrOf = (script) => {
  try { return btc.Address(btc.NETWORK).encode(btc.OutScript.decode(script)); } catch { return null; }
};
function parsePsbt(psbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
  const ins = [];
  for (let i = 0; i < tx.inputsLength; i++) ins.push(tx.getInput(i));
  const outs = [];
  for (let i = 0; i < tx.outputsLength; i++) outs.push(tx.getOutput(i));
  return { tx, ins, outs };
}

// A fixed ephemeral key + a 1,200-byte pseudo-image (3 chunks: 520 + 520 + 160).
const PRIV = sha256(new TextEncoder().encode("luckyprotocol test ephemeral key (never fund)"));
const XONLY = ephemeralXonly(PRIV);
const BODY = new Uint8Array(1_200).map((_, i) => (i * 7 + 3) & 0xff);

// ---- envelope ----------------------------------------------------------------------------------
{
  const leaf = buildEnvelopeScript(XONLY, "image/webp", BODY);
  assert.equal(leaf.length, envelopeScriptLen("image/webp", BODY.length), "envelopeScriptLen matches the built script");
  // <xonly> OP_CHECKSIG OP_FALSE OP_IF push("ord") OP_PUSHBYTES_1 0x01 push(ct) OP_0 …
  assert.equal(leaf[0], 32, "32-byte key push");
  assert.equal(hex.encode(leaf.subarray(1, 33)), hex.encode(XONLY));
  assert.deepEqual([...leaf.subarray(33, 40)], [0xac, 0x00, 0x63, 0x03, 0x6f, 0x72, 0x64], "CHECKSIG FALSE IF push('ord')");
  assert.deepEqual([...leaf.subarray(40, 42)], [0x01, 0x01], "content-type tag as OP_PUSHBYTES_1 0x01 (ord convention)");
  assert.equal(leaf[42], 10, "push('image/webp')");
  assert.equal(leaf[53], 0x00, "body tag as OP_0");
  assert.equal(leaf[leaf.length - 1], 0x68, "OP_ENDIF last");
  const toks = tokenizeScript(leaf);
  const chunks = toks.slice(toks.findIndex((t) => t.op === 0x63) + 5).filter((t) => t.data);
  assert.equal(chunks.length, 3, "3 body chunks");
  assert.ok(chunks.every((c) => c.data.length <= MAX_CHUNK_BYTES), "every chunk ≤ 520 bytes");
  assert.equal(chunks[0].data.length, 520);
  assert.equal(chunks[2].data.length, 160);

  const env = parseEnvelopeScript(leaf);
  assert.ok(env, "envelope parses");
  assert.equal(env.contentType, "image/webp");
  assert.equal(hex.encode(env.bytes), hex.encode(BODY), "round-trip bytes identical");
  assert.equal(checkEnvelopeLimits(env), true);

  // The indexer's alternate tag encodings: OP_PUSHNUM_1 for the content-type tag,
  // a literal 1-byte 0x00 push for the body tag.
  const alt = new Uint8Array([32, ...XONLY, 0xac, 0x00, 0x63, 3, 0x6f, 0x72, 0x64, 0x51, 9, ...new TextEncoder().encode("image/png"), 0x01, 0x00, 2, 0xaa, 0xbb, 0x68]);
  const envAlt = parseEnvelopeScript(alt);
  assert.deepEqual({ ct: envAlt.contentType, b: [...envAlt.bytes] }, { ct: "image/png", b: [0xaa, 0xbb] }, "OP_PUSHNUM_1 / literal 0x00 tags accepted");
  // Unknown even tag before the body is skipped with its value.
  const skip = new Uint8Array([0x00, 0x63, 3, 0x6f, 0x72, 0x64, 1, 0x07, 2, 0x11, 0x22, 1, 0x01, 9, ...new TextEncoder().encode("image/gif"), 0x00, 1, 0x99, 0x68]);
  assert.deepEqual([...parseEnvelopeScript(skip).bytes], [0x99]);
  assert.equal(parseEnvelopeScript(skip).contentType, "image/gif");
  // Not an envelope.
  assert.equal(parseEnvelopeScript(new Uint8Array([32, ...XONLY, 0xac])), null);
  assert.equal(parseEnvelopeScript(new Uint8Array([0x00, 0x63, 3, 0x6f, 0x72, 0x64, 0x00, 1, 0x01])), null, "missing OP_ENDIF");

  // Limits.
  assert.throws(() => buildEnvelopeScript(XONLY, "image/svg+xml", BODY), /content type/);
  assert.throws(() => buildEnvelopeScript(XONLY, "image/webp", new Uint8Array(0)), /empty/);
  assert.throws(() => buildEnvelopeScript(XONLY, "image/webp", new Uint8Array(MAX_AVATAR_BYTES + 1)), /16,384/);
  const max = buildEnvelopeScript(XONLY, "image/png", new Uint8Array(MAX_AVATAR_BYTES).fill(1));
  assert.equal(parseEnvelopeScript(max).bytes.length, MAX_AVATAR_BYTES, "16,384-byte body round-trips (32 chunks)");
  assert.equal(checkEnvelopeLimits({ contentType: "image/bmp", bytes: new Uint8Array(1) }), false);
  assert.deepEqual(AVATAR_CONTENT_TYPES, ["image/png", "image/jpeg", "image/webp", "image/gif"]);
}

// ---- ephemeral key + commit address --------------------------------------------------------------
{
  const k = generateEphemeralKey();
  assert.equal(k.length, 32);
  assert.notEqual(hex.encode(k), hex.encode(generateEphemeralKey()), "random");
  ephemeralXonly(k); // valid scalar

  const leaf = buildEnvelopeScript(XONLY, "image/webp", BODY);
  const a1 = commitAddress(PRIV, leaf);
  const a2 = commitAddress(PRIV, buildEnvelopeScript(XONLY, "image/webp", BODY));
  assert.equal(a1, a2, "deterministic for a fixed key + image");
  assert.equal(a1, "bc1pl7rjznslgp8g5w6j7r56c9jmnhu8w0z2wrwypgekucnkccqzs9sqaved6s", "pinned commit address for the fixed vector");
  assert.ok(a1.startsWith("bc1p"));
  assert.notEqual(a1, commitAddress(PRIV, buildEnvelopeScript(XONLY, "image/png", BODY)), "content type changes the leaf → address");
  const pay = commitPayment(PRIV, leaf);
  assert.equal(pay.tapLeafScript.length, 1);
  assert.equal(hex.encode(pay.tapInternalKey), hex.encode(XONLY), "internal key = ephemeral key (§8.5)");
  assert.equal(pay.tapLeafScript[0][1].length, leaf.length + 1, "leaf + version byte");
  assert.throws(() => commitPayment(generateEphemeralKey(), leaf), /does not start with this key/);
}

// ---- fee model ------------------------------------------------------------------------------------
{
  const leaf = buildEnvelopeScript(XONLY, "image/webp", BODY);
  const v0 = revealInput0Vsize(leaf.length);
  assert.equal(v0, 41 + (1 + 65 + 3 + leaf.length + 34) / 4, "input0 vB = base 41 + witness/4");
  assert.equal(commitAmountFor({ leafScriptLen: leaf.length, feeRateSatVb: 8 }), 546 + Math.ceil(v0 * 8), "commit = 546 + input0 share");
  const est = estimateRevealFee({ envelopeBytes: BODY.length, feeRateSatVb: 8, deployerAddress: MOCK_WALLET.address });
  assert.equal(est.leafScriptLen, leaf.length);
  assert.equal(est.input0FeeSats, Math.ceil(v0 * 8));
  assert.equal(est.totalFeeSats, est.input0FeeSats + est.remainderFeeSats);
  assert.ok(est.remainderVsize > 150 && est.remainderVsize < 260, `remainder ≈ a MINE: ${est.remainderVsize}`);
  assert.throws(() => commitAmountFor({ leafScriptLen: 100, feeRateSatVb: 5_000 }), /safety cap/);
}

// ---- payload --------------------------------------------------------------------------------------
assert.equal(payloadToString(buildAvatarPayload("LUCKY")), "LUCKYPROTOCOL|AVATAR|LUCKY");
assert.deepEqual(parsePayload("LUCKYPROTOCOL|AVATAR|LUCKY"), { op: "AVATAR", ticker: "LUCKY" });
assert.equal(parsePayload("LUCKYPROTOCOL|AVATAR|LUCKY|1"), null, "exactly three fields");
assert.throws(() => buildAvatarPayload("lucky"), /A-Z 0-9/);

// ---- commit: buildPayPsbt ---------------------------------------------------------------------------
const walletUtxos = [
  { txid: T(1), vout: 0, sats: 546 },      // dust → never
  { txid: T(2), vout: 1, sats: 9_000 },
  { txid: T(3), vout: 0, sats: 30_000 },   // token-bearing → never
  { txid: T(4), vout: 2, sats: 120_000 },
];
const tokenOutpoints = [{ txid: T(3), vout: 0 }];
const leaf = buildEnvelopeScript(XONLY, "image/webp", BODY);
const commitAddr = commitAddress(PRIV, leaf);
const commitAmount = commitAmountFor({ leafScriptLen: leaf.length, feeRateSatVb: 8 });

let commitTx;
{
  const prev = estimatePayFeeSats({ address: MOCK_WALLET.address, toAddress: commitAddr, feeRateSatVb: 8 });
  assert.ok(prev.vsize > 100 && prev.vsize < 160, `pay preview vsize plausible: ${prev.vsize}`);
  const r = buildPayPsbt({ address: MOCK_WALLET.address, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: walletUtxos, tokenOutpoints, feeRateSatVb: 8, toAddress: commitAddr, amountSats: commitAmount });
  const { ins, outs } = parsePsbt(r.psbtHex);
  assert.equal(outs.length, 2, "pay: payment + change");
  assert.equal(addrOf(outs[0].script), commitAddr, "pay: vout0 → commit address");
  assert.equal(outs[0].amount, BigInt(commitAmount));
  assert.equal(addrOf(outs[1].script), MOCK_WALLET.address, "pay: change → self");
  assert.equal(r.changeVout, 1);
  assert.ok(outs.every((o) => o.script[0] !== 0x6a), "pay: no OP_RETURN");
  for (const inp of ins) {
    assert.ok(inp.witnessUtxo.amount > 546n, "pay: dust input selected");
    assert.notEqual(hex.encode(inp.txid), T(3), "pay: token outpoint selected");
    assert.equal(hex.encode(inp.tapInternalKey), MOCK_WALLET.pubkeyHex.slice(2));
  }
  const inSum = ins.reduce((s, i) => s + i.witnessUtxo.amount, 0n);
  const outSum = outs.reduce((s, o) => s + o.amount, 0n);
  assert.equal(inSum - outSum, BigInt(r.feeSats), "pay: fee == inputs − outputs");
  assert.throws(() => buildPayPsbt({ address: MOCK_WALLET.address, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: walletUtxos, tokenOutpoints, feeRateSatVb: 8, toAddress: commitAddr, amountSats: 100 }), /≥ 546/);
  assert.throws(() => buildPayPsbt({ address: MOCK_WALLET.address, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: walletUtxos, tokenOutpoints, feeRateSatVb: 8, toAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", amountSats: 1000 }), /unsupported address type/);

  // The mock wallet really signs → a broadcastable commit tx.
  const signed = mockSignPsbt(r.psbtHex, { autoFinalized: true, toSignInputs: r.inputIndexes.map((index) => ({ index, address: MOCK_WALLET.address })) });
  commitTx = decodeRawTx(extractRawTxHex(signed));
  assert.equal(commitTx.outputs[0].address, commitAddr);
  assert.equal(commitTx.outputs[0].sats, commitAmount);
  assert.equal(commitTx.payload, null, "commit is a plain payment, not a protocol tx");
}

// ---- reveal: build → wallet signs first → ephemeral → finalize → extract ---------------------------------
{
  assert.equal(REVEAL_SIGNING_ORDER, "wallet-first");
  const commit = { txid: commitTx.txid, vout: 0, sats: commitAmount };
  // The wallet's list may still contain the UTXO the commit just spent — the
  // caller excludes those; here we hand over the remaining ones plus the commit change.
  const spentByCommit = new Set(commitTx.inputs.map((i) => `${i.txid}:${i.vout}`));
  const utxos = walletUtxos.filter((u) => !spentByCommit.has(`${u.txid}:${u.vout}`)).concat([{ txid: commitTx.txid, vout: 1, sats: commitTx.outputs[1].sats }]);
  const r = buildRevealPsbt({ commit, ephemeralPriv: PRIV, leafScript: leaf, deployerAddress: MOCK_WALLET.address, deployerPubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  assert.equal(r.commitAddress, commitAddr);
  assert.ok(r.walletInputIndexes.length >= 1, "at least one deployer input (§8.3 authorization)");
  assert.deepEqual(r.walletInputIndexes, r.walletInputIndexes.map((_, i) => i + 1), "wallet inputs are 1..n");
  const { ins, outs } = parsePsbt(r.psbtHex);
  assert.equal(hex.encode(ins[0].txid), commitTx.txid, "input0 = commit output");
  assert.equal(ins[0].index, 0);
  assert.equal(ins[0].witnessUtxo.amount, BigInt(commitAmount));
  assert.ok(ins[0].tapLeafScript && ins[0].tapMerkleRoot && ins[0].tapInternalKey, "input0 carries the script-path fields");
  for (const inp of ins.slice(1)) {
    assert.ok(inp.witnessUtxo.amount > 546n);
    assert.notEqual(hex.encode(inp.txid), T(3), "token outpoint never a reveal input");
    assert.equal(addrOf(inp.witnessUtxo.script), MOCK_WALLET.address, "deployer-owned input");
  }
  // §8.1 layout
  assert.equal(outs.length, 4);
  assert.equal(addrOf(outs[0].script), MOCK_WALLET.address, "vout0 → deployer");
  assert.equal(outs[0].amount, 546n);
  assert.equal(addrOf(outs[1].script), PROJECT_FEE_ADDRESS, "vout1 → protocol fee");
  assert.equal(outs[1].amount, 546n);
  assert.equal(outs[2].script[0], 0x6a);
  assert.equal(payloadToString(outs[2].script.slice(2)), "LUCKYPROTOCOL|AVATAR|LUCKY");
  assert.equal(addrOf(outs[3].script), MOCK_WALLET.address, "vout3 change → deployer");
  assert.equal(outs[3].amount, BigInt(r.changeSats));
  const inSum = ins.reduce((s, i) => s + i.witnessUtxo.amount, 0n);
  const outSum = outs.reduce((s, o) => s + o.amount, 0n);
  assert.equal(inSum - outSum, BigInt(r.feeSats), "reveal: fee == inputs − outputs");

  // Step 1 — wallet signs ONLY its inputs (autoFinalized) and refuses input0 (foreign address).
  assert.throws(() => mockSignPsbt(r.psbtHex, { autoFinalized: true, toSignInputs: [{ index: 0, address: MOCK_WALLET.address }] }), /No taproot scripts signed|belongs to/);
  const walletSigned = mockSignPsbt(r.psbtHex, { autoFinalized: true, toSignInputs: r.walletInputIndexes.map((index) => ({ index, address: MOCK_WALLET.address })) });
  {
    const p = parsePsbt(walletSigned);
    assert.ok(!p.ins[0].finalScriptWitness, "input0 untouched by the wallet");
    assert.ok(p.ins[0].tapLeafScript, "wallet preserved input0's tapLeafScript");
    assert.ok(p.ins.slice(1).every((i) => i.finalScriptWitness), "wallet inputs finalized");
  }
  // Extracting now must fail: input0 is not signed.
  assert.throws(() => finalizeReveal(walletSigned), /finalize|witness|sign/i);

  // Step 2 — ephemeral script-path signature, key-path sig stripped.
  const appSigned = signRevealEphemeral(walletSigned, PRIV);
  const w0 = parsePsbt(appSigned).ins[0].finalScriptWitness;
  assert.equal(w0.length, 3, "input0 witness = [sig, leaf, control block] — a script-path spend, not key path");
  assert.equal(w0[0].length, 64, "64-byte schnorr sig (SIGHASH_DEFAULT)");
  assert.equal(hex.encode(w0[1]), hex.encode(leaf));
  assert.equal(w0[2].length, 33, "control block: version|parity + internal key, no merkle path (single leaf)");
  assert.throws(() => signRevealEphemeral(appSigned, PRIV), /already finalized/);
  assert.throws(() => signRevealEphemeral(walletSigned, generateEphemeralKey()), /No taproot scripts signed|does not start/);

  // Step 3 — finalize + extract.
  const fin = finalizeReveal(appSigned);
  assert.equal(fin.envelope.contentType, "image/webp");
  assert.equal(hex.encode(fin.envelope.bytes), hex.encode(BODY), "image bytes come back out of the witness");
  assert.ok(Math.abs(fin.vsize - r.estimatedVsize) <= 4, `estimated vsize ${r.estimatedVsize} ≈ real ${fin.vsize}`);
  assert.ok(Math.ceil(fin.vsize * 8) <= r.feeSats + 4 * 8, "fee covers the real vsize at 8 sat/vB");
  const raw = btc.RawTx.decode(hex.decode(fin.rawHex));
  assert.equal(raw.witnesses.length, ins.length);
  assert.equal(hex.encode(parseEnvelopeFromWitness(raw.witnesses[0]).bytes), hex.encode(BODY), "envelope parses from the raw witness");
  const d = decodeRawTx(fin.rawHex);
  assert.deepEqual(d.payload, { op: "AVATAR", ticker: "LUCKY" });
  assert.equal(d.txid, fin.txid);
  assert.equal(d.inputs[0].txid, commitTx.txid);
  // Nothing in the reveal spends the commit's own inputs.
  assert.ok(d.inputs.slice(1).every((i) => !spentByCommit.has(`${i.txid}:${i.vout}`)));

  // Reverse order (ephemeral first) — also valid with btc-signer; documented, not shipped.
  const appFirst = signRevealEphemeral(r.psbtHex, PRIV);
  const thenWallet = mockSignPsbt(appFirst, { autoFinalized: true, toSignInputs: r.walletInputIndexes.map((index) => ({ index, address: MOCK_WALLET.address })) });
  assert.equal(finalizeReveal(thenWallet).txid, fin.txid, "both orders produce the same txid");

  // A commit that covers everything still gets ≥ 1 deployer input.
  const rich = buildRevealPsbt({ commit: { ...commit, sats: 200_000 }, ephemeralPriv: PRIV, leafScript: leaf, deployerAddress: MOCK_WALLET.address, deployerPubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" });
  assert.equal(rich.walletInputIndexes.length, 1, "exactly one (smallest) deployer input when the commit is over-funded");
  assert.equal(BigInt(rich.changeSats + rich.feeSats + 1092), 200_000n + parsePsbt(rich.psbtHex).ins[1].witnessUtxo.amount, "over-funded commit flows back as change");
  assert.throws(() => buildRevealPsbt({ commit, ephemeralPriv: PRIV, leafScript: leaf, deployerAddress: MOCK_WALLET.address, deployerPubkeyHex: MOCK_WALLET.pubkeyHex, utxos: [{ txid: T(1), vout: 0, sats: 546 }], tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" }), /no spendable BTC/);
  assert.throws(() => buildRevealPsbt({ commit, ephemeralPriv: PRIV, leafScript: leaf, deployerAddress: MOCK_WALLET.address, deployerPubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "lucky" }), /A-Z 0-9/);
  assert.throws(() => buildRevealPsbt({ commit: { txid: "zz", vout: 0, sats: 1 }, ephemeralPriv: PRIV, leafScript: leaf, deployerAddress: MOCK_WALLET.address, deployerPubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 8, ticker: "LUCKY" }), /commit outpoint/);
}

// ---- reveal with a P2WPKH deployer, signed directly with btc-signer -------------------------------------
{
  const dPriv = sha256(new TextEncoder().encode("luckyprotocol test wpkh deployer (never fund)"));
  const dPub = pubECDSA(dPriv, true);
  const dAddr = btc.p2wpkh(dPub, btc.NETWORK).address;
  const commit = { txid: T(9), vout: 0, sats: commitAmount };
  const r = buildRevealPsbt({ commit, ephemeralPriv: PRIV, leafScript: leaf, deployerAddress: dAddr, deployerPubkeyHex: hex.encode(dPub), utxos: [{ txid: T(7), vout: 0, sats: 15_000 }], tokenOutpoints: [], feeRateSatVb: 12, ticker: "ORE" });
  const { ins, outs } = parsePsbt(r.psbtHex);
  assert.equal(ins[1].tapInternalKey, undefined, "no tapInternalKey on a P2WPKH deployer input");
  assert.equal(addrOf(outs[0].script), dAddr);
  assert.equal(payloadToString(outs[2].script.slice(2)), "LUCKYPROTOCOL|AVATAR|ORE");
  const tx = btc.Transaction.fromPSBT(hex.decode(r.psbtHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.signIdx(dPriv, 1);
  tx.finalizeIdx(1);
  const fin = finalizeReveal(signRevealEphemeral(hex.encode(tx.toPSBT()), PRIV));
  assert.ok(Math.abs(fin.vsize - r.estimatedVsize) <= 4, `wpkh: estimated vsize ${r.estimatedVsize} ≈ real ${fin.vsize}`);
  assert.equal(hex.encode(fin.envelope.bytes), hex.encode(BODY));
}

// ---- recovery record --------------------------------------------------------------------------------------
{
  assert.equal(avatarRecordKey("lucky"), "lp.avatar.LUCKY");
  const rec = {
    ticker: "LUCKY",
    ephemeralPrivHex: hex.encode(PRIV),
    leafScriptHex: hex.encode(leaf),
    contentType: "image/webp",
    bytesBase64: base64.encode(BODY),
    commitAddress: commitAddr,
    commitAmount,
    commitTxid: null,
    commitVout: null,
    commitChange: null,
    commitInputs: [],
    revealTxid: null,
    feeRateSatVb: 8,
    createdAt: 1_700_000_000_000,
  };
  assert.deepEqual(parseAvatarRecord(serializeAvatarRecord(rec)), rec, "round-trip");
  const withCommit = { ...rec, commitTxid: commitTx.txid, commitVout: 0, commitChange: { vout: 1, sats: 1234 }, commitInputs: [{ txid: T(2), vout: 1 }] };
  assert.deepEqual(parseAvatarRecord(serializeAvatarRecord(withCommit)), withCommit);
  assert.equal(parseAvatarRecord("not json"), null);
  assert.equal(parseAvatarRecord({ ...rec, leafScriptHex: hex.encode(buildEnvelopeScript(XONLY, "image/png", BODY)) }), null, "leaf must match key + image + content type");
  assert.equal(parseAvatarRecord({ ...rec, ephemeralPrivHex: "00".repeat(32) }), null);
  assert.equal(parseAvatarRecord({ ...rec, commitTxid: "nope" }).commitTxid, null, "bad txid → null, record kept");
  assert.equal(bytesToDataUrl(new Uint8Array([1, 2, 3]), "image/png"), "data:image/png;base64,AQID");
}

console.log("inscribe: envelope, commit/reveal build + sign (wallet-first), fee split, record ok");
