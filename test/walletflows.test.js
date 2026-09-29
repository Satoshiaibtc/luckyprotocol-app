// Wallet-side guards shared by every write flow, and the plain words
// around them. Plain Node, no framework:
//
//   1. after signing: the wallet's PSBT must carry the very transaction it
//      was given (version, lock time, inputs and their nSequence, outputs);
//   2. inputs in flight: a second signature on the page never spends what
//      another one is signing or broadcasting (nor what a recorded, unfinal
//      broadcast spends) — a Speed up names what it replaces;
//   3. the record of a broadcast goes to the address that built it;
//   4. a page-load restore never errors for a key only a prompt can give;
//   5. coin selection runs until the fee it pays is the fee it selected
//      for — many small outputs never read as "not enough BTC";
//   6. the indexer answering "busy" is not "offline", and no page text
//      carries a request path;
//   7. small texts: the fill's block, the activation gate at tip 0, the
//      site banner's list of paused actions;
//   8. after signing: every asked input carries the signature TYPE the
//      transaction needs — 0x00 / 0x01 for a DEPLOY, MINE, SEND or a
//      fill's own inputs, exactly 0x83 for a listing — or nothing is sent
//      (`code: "sighash-mismatch"`).
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import {
  buildDeployPsbt,
  buildMinePsbt,
  buildSendPsbt,
  convergeSelection,
  estimateVsize,
  extractRawTxHex,
  inputCostSats,
  MAX_FEE_INPUTS,
  psbtFeeSats,
  psbtInputKeys,
  rawTxSummary,
  RBF_SEQUENCE,
  signedTxMismatch,
} from "../src/lib/psbt.js";
import { buildFillPsbt, buildListingPsbt, finalizeFill, LISTING_SIGHASH } from "../src/lib/swap.js";
import { MOCK_WALLET, mockSignPsbt } from "../src/lib/mock.js";
import { PROTOCOL_LOCKTIME } from "../src/lib/payloads.js";
import { fundingMessage } from "../src/lib/funding.js";
import { indexerErrorText, isIndexerBusy } from "../src/lib/errors.js";
import { filledLineText } from "../src/lib/market.js";
import { activationState } from "../src/lib/activation.js";
import { chainTipOf, syncWarningText } from "../src/lib/sync.js";
import { forgetTx, txRecords } from "../src/lib/txrecords.js";
import { mineVersions } from "../src/lib/minePending.js";
import { sendVersions } from "../src/lib/send.js";
import * as wallet from "../src/lib/wallet.js";

const TX = (c) => c.repeat(64);
const T = (i) => "ab".repeat(31) + String(i).padStart(2, "0");
const enc = (s) => new TextEncoder().encode(s);
const parse = (psbtHex) => btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });

function keyFor(seed, type) {
  const priv = sha256(enc(`walletflows:${seed}`));
  const pub = pubECDSA(priv, true);
  if (type === "wpkh") {
    const p = btc.p2wpkh(pub, btc.NETWORK);
    return { priv, pubkeyHex: hex.encode(pub), address: p.address, type };
  }
  const p = btc.p2tr(pubSchnorr(priv), undefined, btc.NETWORK);
  return { priv, pubkeyHex: hex.encode(pub), address: p.address, type: "tr" };
}

/** The same unsigned transaction rebuilt with `change` applied — what a wallet that rewrites a PSBT before signing would sign. */
function rewritten(psbtHex, change = {}) {
  const src = parse(psbtHex);
  const tx = new btc.Transaction({ version: change.version ?? src.version, lockTime: change.lockTime ?? src.lockTime, allowUnknownOutputs: true });
  for (let i = 0; i < src.inputsLength; i++) {
    const inp = src.getInput(i);
    const seq = change.allSequences ?? (change.input0Sequence !== undefined && i === 0 ? change.input0Sequence : inp.sequence);
    tx.addInput({ txid: inp.txid, index: inp.index, sequence: seq, witnessUtxo: inp.witnessUtxo, ...(inp.tapInternalKey ? { tapInternalKey: inp.tapInternalKey } : {}) });
  }
  for (let i = 0; i < src.outputsLength; i++) {
    const o = src.getOutput(i);
    const amount = change.outputDelta && i === src.outputsLength - 1 ? o.amount - BigInt(change.outputDelta) : o.amount;
    tx.addOutput({ script: o.script, amount });
  }
  if (change.extraOutput) tx.addOutput({ script: btc.OutScript.encode(btc.Address(btc.NETWORK).decode(MOCK_WALLET.address)), amount: 600n });
  return hex.encode(tx.toPSBT());
}

const SIGN_ALL = (psbtHex) => mockSignPsbt(psbtHex, { autoFinalized: true });

// ---- 1. the signed PSBT carries the transaction it was given --------------------------------------
{
  const utxos = [{ txid: T(1), vout: 0, sats: 90_000 }, { txid: T(2), vout: 1, sats: 40_000 }];
  const mine = buildMinePsbt({ address: MOCK_WALLET.address, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints: [], feeRateSatVb: 3, ticker: "LUCKY" });
  assert.equal(signedTxMismatch(mine.psbtHex, SIGN_ALL(mine.psbtHex)), null, "signed as given: no difference");
  // A listing (0x83, left unfinalized) is the same transaction too.
  const listing = buildListingPsbt({ address: MOCK_WALLET.address, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: { txid: T(3), vout: 0, sats: 546 }, priceSats: 10_000, amount: 100 });
  const signedListing = mockSignPsbt(listing.psbtHex, { autoFinalized: false, toSignInputs: [{ index: 0, address: MOCK_WALLET.address, sighashTypes: [LISTING_SIGHASH] }] });
  assert.equal(signedTxMismatch(listing.psbtHex, signedListing), null, "a 0x83 listing signature changes nothing");
  // Every rewrite a wallet could make before signing is caught.
  const cases = [
    [{ input0Sequence: 0xffffffff }, /input 0's sequence changed/],
    [{ allSequences: 0xffffffff }, /sequence changed/],
    [{ lockTime: 0 }, /lock time changed/],
    [{ outputDelta: 1_000 }, /amount changed/],
    [{ extraOutput: true }, /output count changed/],
    [{ version: 1 }, /version changed/],
  ];
  for (const [change, re] of cases) {
    const signed = SIGN_ALL(rewritten(mine.psbtHex, change));
    assert.match(String(signedTxMismatch(mine.psbtHex, signed)), re, JSON.stringify(change));
  }
  // A DEPLOY's lock time and its RBF sequences are covered the same way.
  const deploy = buildDeployPsbt({ address: MOCK_WALLET.address, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints: [], feeRateSatVb: 3, ticker: "NEWTKN" });
  assert.equal(parse(deploy.psbtHex).lockTime, PROTOCOL_LOCKTIME);
  assert.equal(parse(deploy.psbtHex).getInput(0).sequence, RBF_SEQUENCE);
  assert.equal(signedTxMismatch(deploy.psbtHex, SIGN_ALL(deploy.psbtHex)), null);
  assert.match(String(signedTxMismatch(deploy.psbtHex, SIGN_ALL(rewritten(deploy.psbtHex, { lockTime: 0 })))), /lock time changed/, "a DEPLOY whose lock time was dropped");
  assert.match(String(signedTxMismatch(deploy.psbtHex, SIGN_ALL(rewritten(deploy.psbtHex, { input0Sequence: 0xffffffff })))), /input 0's sequence changed/, "a DEPLOY that no longer signals RBF on one input");
  assert.match(String(signedTxMismatch(mine.psbtHex, "00")), /not a readable PSBT/);
  console.log("signed check: version, lock time, every input's sequence and every output are compared; a listing passes");
}

// ---- a fake injected wallet (window.unisat) for the wallet module ---------------------------------
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
let signGate = null; // a promise the next signature waits on
let signCalls = 0;
let tamper = null;
let forceSighash = null; // { index, type }: the wallet signs input `index` with sighash `type` whatever it was asked
const pushed = [];
const provider = {
  async requestAccounts() {
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
  async signPsbt(psbtHex, opts) {
    signCalls++;
    if (signGate) await signGate;
    let given = tamper ? rewritten(psbtHex, tamper) : psbtHex;
    let o = opts;
    if (forceSighash) {
      const { index, type } = forceSighash;
      const tx = parse(given);
      tx.updateInput(index, { sighashType: type }, true);
      given = hex.encode(tx.toPSBT());
      o = { ...opts, toSignInputs: opts.toSignInputs.map((r) => (r.index === index ? { ...r, sighashTypes: [type] } : r)) };
    }
    return mockSignPsbt(given, o);
  },
  async pushPsbt(signed) {
    const txid = rawTxSummary(extractRawTxHex(signed)).txid;
    pushed.push(txid);
    return txid;
  },
  async pushTx(arg) {
    const raw = typeof arg === "string" ? arg : arg.rawtx;
    const txid = rawTxSummary(raw).txid;
    pushed.push(txid);
    return txid;
  },
};
globalThis.window = { unisat: provider };

// ---- 2. inputs in flight ---------------------------------------------------------------------------
{
  const session = await wallet.connect("unisat");
  assert.equal(session.address, MOCK_WALLET.address);
  const ADDR = MOCK_WALLET.address;
  const utxos = [{ txid: T(11), vout: 0, sats: 200_000 }];
  const a = buildMinePsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints: [], feeRateSatVb: 3, ticker: "LUCKY", selectionOrder: "largest" });
  const b = buildMinePsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints: [], feeRateSatVb: 5, ticker: "ORE", selectionOrder: "largest" });
  const key = `${T(11)}:0`;
  assert.deepEqual(psbtInputKeys(a.psbtHex, a.inputIndexes), [key]);

  // A's wallet window is open…
  let open;
  signGate = new Promise((r) => (open = r));
  const signingA = wallet.signPsbt(a.psbtHex, { inputIndexes: a.inputIndexes, address: ADDR });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(wallet.inFlightOutpoints().has(key), "A's input is held while its wallet window is open");
  // …so B, built from the same UTXO list, is refused before any wallet opens.
  const callsBefore = signCalls;
  await assert.rejects(wallet.signPsbt(b.psbtHex, { inputIndexes: b.inputIndexes, address: ADDR }), (e) => e.code === "busy" && /waiting for the wallet or its broadcast/.test(e.message));
  assert.equal(signCalls, callsBefore, "the wallet was not asked for B");
  open();
  signGate = null;
  const signedA = await signingA;
  assert.ok(wallet.inFlightOutpoints().has(key), "held until the broadcast settles");
  const txidA = await wallet.broadcastSignedPsbt(signedA, { kind: "mine", ticker: "LUCKY", address: ADDR, psbt: a.psbtHex, changeVout: a.changeVout });
  assert.equal(wallet.inFlightOutpoints().has(key), false, "released once broadcast");
  const rec = txRecords(ADDR).find((r) => r.txid === txidA);
  assert.ok(rec && rec.inputs.includes(key), "its record guards the input now");
  assert.equal(rec.psbt, a.psbtHex, "a MINE's record keeps its unsigned PSBT (Speed up after a reload)");
  assert.equal(rec.changeVout, a.changeVout);
  // B still may not spend it: A is broadcast and not final.
  await assert.rejects(wallet.signPsbt(b.psbtHex, { inputIndexes: b.inputIndexes, address: ADDR }), (e) => e.code === "busy");
  // A Speed up of A names what it replaces, and may.
  const signedB = await wallet.signPsbt(b.psbtHex, { inputIndexes: b.inputIndexes, address: ADDR, replaces: [txidA] });
  assert.ok(signedB.length > 0);
  wallet.releaseInputs(b.psbtHex);
  assert.equal(wallet.inFlightOutpoints().has(key), false, "a flow that stops before its broadcast releases what it held");

  // B's broadcast ends unknown (both relays failed, the node has not seen
  // it): B is recorded and A keeps its record. The next Speed up names
  // every version — naming only B would be refused as "in flight".
  const summaryB = rawTxSummary(extractRawTxHex(signedB));
  const txidB = summaryB.txid;
  await assert.rejects(
    wallet.landedOrThrow(summaryB, { kind: "mine", ticker: "LUCKY", address: ADDR }, new Error("both relays failed"), { txStatus: async () => ({ confirmed: false, seen: false }), sleep: async () => {} }),
    (e) => e.recorded === true && e.txid === txidB,
  );
  assert.ok(txRecords(ADDR).some((r) => r.txid === txidA) && txRecords(ADDR).some((r) => r.txid === txidB), "both versions keep a record");
  const c3 = buildMinePsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints: [], feeRateSatVb: 8, ticker: "LUCKY", selectionOrder: "largest" });
  await assert.rejects(wallet.signPsbt(c3.psbtHex, { inputIndexes: c3.inputIndexes, address: ADDR, replaces: [txidB] }), (e) => e.code === "busy", "the earlier version's record still guards the input");
  const versions = [txidB, txidA];
  assert.deepEqual(mineVersions({ txid: txidB, replaces: [txidA] }), versions);
  assert.deepEqual(sendVersions({ txid: txidB, replaces: [txidA] }), versions);
  const signedC3 = await wallet.signPsbt(c3.psbtHex, { inputIndexes: c3.inputIndexes, address: ADDR, replaces: versions });
  assert.ok(signedC3.length > 0, "a Speed up naming every version it replaces may sign");
  wallet.releaseInputs(c3.psbtHex);
  forgetTx(ADDR, txidB);

  // A declined signature releases at once.
  const c = buildMinePsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: [{ txid: T(12), vout: 0, sats: 100_000 }], tokenOutpoints: [], feeRateSatVb: 3, ticker: "LUCKY" });
  const realSign = provider.signPsbt;
  provider.signPsbt = async () => {
    throw new Error("User rejected the request.");
  };
  await assert.rejects(wallet.signPsbt(c.psbtHex, { inputIndexes: c.inputIndexes, address: ADDR }), (e) => e.declined === "sign");
  assert.equal(wallet.inFlightOutpoints().has(`${T(12)}:0`), false);
  provider.signPsbt = realSign;

  // A wallet that rewrites the transaction: refused after signing, nothing broadcast, nothing held.
  tamper = { allSequences: 0xffffffff };
  await assert.rejects(wallet.signPsbt(c.psbtHex, { inputIndexes: c.inputIndexes, address: ADDR }), /changed the transaction while signing \(input 0's sequence changed.*nothing was sent/);
  tamper = null;
  assert.equal(wallet.inFlightOutpoints().has(`${T(12)}:0`), false);

  // A listing (never broadcast) holds nothing.
  const listing = buildListingPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: { txid: T(13), vout: 0, sats: 546 }, priceSats: 10_000, amount: 100 });
  await wallet.signPsbt(listing.psbtHex, { inputIndexes: [0], address: ADDR, autoFinalized: false, sighashTypes: [LISTING_SIGHASH] });
  assert.equal(wallet.inFlightOutpoints().has(`${T(13)}:0`), false);
  console.log("in flight: a second signature on the page never spends what another holds or a pending broadcast spends; Speed up may");
}

// ---- 3. the record goes to the address that built the transaction ---------------------------------
{
  const ADDR = MOCK_WALLET.address;
  const OTHER = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  const d = buildMinePsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: [{ txid: T(14), vout: 0, sats: 100_000 }], tokenOutpoints: [], feeRateSatVb: 3, ticker: "LUCKY" });
  const signed = await wallet.signPsbt(d.psbtHex, { inputIndexes: d.inputIndexes, address: ADDR });
  const raw = extractRawTxHex(signed);
  // Built for OTHER (the connected wallet changed while its window was open): the connected
  // wallet's relay is skipped, the indexer's relay is used, and the record lands under OTHER.
  const savedFetch = globalThis.fetch;
  const relayed = [];
  globalThis.fetch = async (url, init) => {
    relayed.push([String(url), init?.method]);
    const txid = rawTxSummary(String(init.body)).txid;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => txid };
  };
  const before = pushed.length;
  try {
    const txid = await wallet.broadcastRawTx(raw, { kind: "mine", ticker: "LUCKY", address: OTHER });
    assert.equal(pushed.length, before, "not relayed by a wallet that did not sign it");
    assert.ok(relayed.some(([u, m]) => /\/broadcast$/.test(u) && m === "POST"), "relayed by the indexer");
    assert.ok(txRecords(OTHER).some((r) => r.txid === txid), "recorded under the building address");
    assert.ok(!txRecords(ADDR).some((r) => r.txid === txid), "never under the wallet connected now");
  } finally {
    globalThis.fetch = savedFetch;
  }
  console.log("records: a broadcast is recorded under the address that built it");
}

// ---- 4. a silent restore never errors for a key only a prompt can give -----------------------------
{
  const okxLike = {
    async getAccounts() {
      return [MOCK_WALLET.address];
    },
    async requestAccounts() {
      return [MOCK_WALLET.address];
    },
    async getNetwork() {
      return "livenet";
    },
  };
  globalThis.window = { okxwallet: { bitcoin: okxLike } };
  assert.equal(await wallet.connect("okx", { silent: true }), null, "no getPublicKey: stays disconnected, no error");
  await assert.rejects(wallet.connect("okx"), /did not share this account's public key/, "a Connect click still says why");
  globalThis.window = { unisat: provider };
  await wallet.connect("unisat");
  console.log("restore: a provider without getPublicKey restores to nothing, silently");
}

// ---- 5. coin selection converges ----------------------------------------------------------------
{
  const small = (n, sats, tag) => Array.from({ length: n }, (_, i) => ({ txid: `${tag}${String(i).padStart(4, "0")}`.padEnd(64, "0"), vout: 0, sats }));
  const big = (sats, tag = "f1") => ({ txid: tag.repeat(32), vout: 0, sats });
  const checkBuilt = (label, built, rate) => {
    const tx = parse(built.psbtHex);
    let inSum = 0n;
    for (let i = 0; i < tx.inputsLength; i++) inSum += tx.getInput(i).witnessUtxo.amount;
    let outSum = 0n;
    for (let i = 0; i < tx.outputsLength; i++) outSum += tx.getOutput(i).amount;
    assert.equal(Number(inSum - outSum), built.feeSats, `${label}: inputs − outputs = the fee`);
    assert.ok(built.feeSats >= built.estimatedVsize * rate, `${label}: the fee pays the rate (${built.feeSats} for ${built.estimatedVsize} vB @ ${rate})`);
    if (!built.changeOmitted) assert.ok(built.changeSats >= 546, `${label}: change ≥ 546`);
  };
  for (const type of ["tr", "wpkh"]) {
    const k = keyFor(`sel-${type}`, type);
    const base = { address: k.address, pubkeyHex: k.pubkeyHex, tokenOutpoints: [] };
    const wallets = [
      ["60 × 1,200 + 1,000,000 @ 20", [...small(60, 1_200, "a1"), big(1_000_000)], 20],
      ["10 × 5,000 + 1,000,000 @ 50", [...small(10, 5_000, "a2"), big(1_000_000)], 50],
      ["8 × 3,000 + 1,000,000 @ 30", [...small(8, 3_000, "a3"), big(1_000_000)], 30],
      ["30 × 800 + 100,000 @ 10", [...small(30, 800, "a4"), big(100_000)], 10],
      ["20 × 2,000 @ 20 (small outputs only)", small(20, 2_000, "a5"), 20],
    ];
    for (const [label, utxos, rate] of wallets) {
      const opts = { ...base, utxos, feeRateSatVb: rate, minInputSats: 0 }; // an asset-safe list: smallest-first
      checkBuilt(`${type} MINE ${label}`, buildMinePsbt({ ...opts, ticker: "LUCKY" }), rate);
      checkBuilt(`${type} DEPLOY ${label}`, buildDeployPsbt({ ...opts, ticker: "NEWTKN" }), rate);
      checkBuilt(`${type} DEPLOY largest-first ${label}`, buildDeployPsbt({ ...opts, ticker: "NEWTKN", selectionOrder: "largest" }), rate);
      checkBuilt(`${type} SEND ${label}`, buildSendPsbt({ ...opts, tokenUtxos: [{ txid: TX("d"), vout: 0, sats: 546 }], ticker: "LUCKY", amount: 5, toAddress: k.address }), rate);
    }
    // Next to a large output, outputs worth less than twice their own input fee are not consolidated at a high rate.
    const m = buildMinePsbt({ ...base, utxos: [...small(60, 1_200, "b1"), big(1_000_000)], feeRateSatVb: 20, ticker: "LUCKY", minInputSats: 0 });
    assert.deepEqual(m.inputs.map((u) => u.sats), [1_000_000], `${type}: one input, not sixty that cost more than half their value`);
    // At a low rate they still consolidate.
    const low = buildMinePsbt({ ...base, utxos: [...small(4, 5_000, "b2"), big(1_000_000)], feeRateSatVb: 2, ticker: "LUCKY", minInputSats: 0 });
    assert.ok(low.inputs.every((u) => u.sats === 5_000), `${type}: economic small outputs still consolidate on an asset-safe list`);
  }
  // A fill from a wallet of small outputs only (largest-first, as many as it takes).
  {
    const seller = keyFor("sel-seller", "tr");
    const buyer = keyFor("sel-buyer", "wpkh");
    const listing = buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo: { txid: TX("e"), vout: 0, sats: 546 }, priceSats: 5_000, amount: 100 });
    const tx = parse(listing.psbtHex);
    tx.signIdx(seller.priv, 0, [btc.SigHash.SINGLE_ANYONECANPAY]);
    const order = { id: `${TX("e")}:0`, ticker: "LUCKY", amount: 100, price_sats: 5_000, unit_price: 50, seller: seller.address, carrier_sats: 546, status: "open" };
    const fill = buildFillPsbt({ listingPsbtHex: hex.encode(tx.toPSBT()), order, sendAmount: 100, address: buyer.address, pubkeyHex: buyer.pubkeyHex, utxos: small(60, 1_800, "c1"), tokenOutpoints: [], feeRateSatVb: 20 });
    assert.ok(fill.inputs.length > 3, `several small inputs (${fill.inputs.length})`);
    assert.equal(psbtFeeSats(fill.psbtHex), fill.feeSats, "the fill pays the fee it quotes");
    const signed = mockSignPsbtAs(buyer, fill.psbtHex, fill.inputIndexes);
    assert.ok(finalizeFill(signed, { op: "SEND", ticker: "LUCKY", amount: 100 }).length > 0);
  }
  // The loop: the fee is always the one the selection was made for.
  {
    const rows = small(40, 1_000, "d1");
    const feeFor = (n) => 100 + 300 * n;
    const sel = convergeSelection({ spendable: rows, targetFor: (fee) => 5_000 + fee, feeFor, order: "smallest" });
    assert.equal(sel.fee, feeFor(sel.selected.length), "converged: the fee matches the count");
    assert.ok(sel.total >= 5_000 + sel.fee);
    assert.throws(() => convergeSelection({ spendable: small(300, 1_000, "d2"), targetFor: (fee) => 150_000 + fee, feeFor: (n) => 10 * n, order: "smallest", maxInputs: 100 }), (e) => e.code === "too-many-inputs");
    assert.throws(() => convergeSelection({ spendable: rows, targetFor: (fee) => 60_000 + fee, feeFor, order: "smallest" }), (e) => e.code === "insufficient");
    assert.equal(MAX_FEE_INPUTS, 200);
  }
  // What the page says.
  const many = Object.assign(new Error("x"), { code: "too-many-inputs", maxInputs: 200 });
  assert.match(fundingMessage(many, { assetSafe: true, waitingSats: 0 }, { action: "this MINE" }), /spread over many small outputs: this MINE would need more than 200 of them/);
  assert.ok(!/add BTC/.test(fundingMessage(many, null, { action: "this MINE" })), "more BTC would not help");
  assert.ok(inputCostSats("tr", 20) === 1_150 && estimateVsize({ inputCount: 1, inputType: "tr", outputAddresses: [], opReturnScriptLen: 0 }) === 68);
  console.log("coin selection: runs until the fee is the one it selected for; small outputs never read as not enough BTC");
}

function mockSignPsbtAs(key, psbtHex, indexes) {
  const tx = parse(psbtHex);
  for (const i of indexes) tx.signIdx(key.priv, i);
  return hex.encode(tx.toPSBT());
}

// ---- 6. busy is not offline; no request path on a page -------------------------------------------
{
  const e429 = Object.assign(new Error("Indexer /health -> HTTP 429: too many requests; retry shortly"), { status: 429, retryAfter: 5 });
  assert.equal(isIndexerBusy(e429), true);
  assert.equal(indexerErrorText(e429), "The indexer is busy — retrying in 5 s.");
  const e503 = Object.assign(new Error("Indexer /tokens?limit=500&offset=0 -> HTTP 503: server busy; retry shortly"), { status: 503 });
  assert.equal(indexerErrorText(e503, { retrySec: 15 }), "The indexer is busy — retrying in 15 s.");
  const e408 = Object.assign(new Error("Indexer /health -> HTTP 408"), { status: 408 });
  assert.match(indexerErrorText(e408), /busy/);
  const e400 = Object.assign(new Error("Indexer /tokens/x -> HTTP 400: invalid ticker"), { status: 400 });
  assert.equal(indexerErrorText(e400), "Invalid ticker.");
  const bare = Object.assign(new Error("Indexer /x -> HTTP 404"), { status: 404 });
  assert.equal(indexerErrorText(bare), "The indexer refused the request (HTTP 404).");
  for (const e of [e429, e503, e408, e400, bare]) assert.ok(!/Indexer \//.test(indexerErrorText(e)), "no path on a page");
  assert.equal(isIndexerBusy(Object.assign(new Error("Indexer /x -> HTTP 502"), { status: 502 })), false);
  assert.equal(indexerErrorText(Object.assign(new Error("Indexer /x -> HTTP 502: bad gateway"), { status: 502 })), "The indexer answered with an error (HTTP 502).");
  console.log("errors: rate-limited or overloaded reads as busy, never offline; no request path on a page");
}

// ---- 7. small texts ------------------------------------------------------------------------------
{
  assert.equal(filledLineText({ final: false, block_height: 969_712 }), "Filled in block #969,712 — final after 6 confirmations.");
  assert.equal(filledLineText({ final: false, block_height: null }), "Filled — final after 6 confirmations.", "never block #0");
  assert.ok(!/#0/.test(filledLineText({ final: false })));
  assert.equal(filledLineText({ final: true, block_height: 5 }), "Filled.");
  // Tip 0 (an indexer that has not read its node yet) is unknown, never "969,599 blocks from now".
  assert.equal(activationState(0).unknown, true);
  assert.equal(activationState(chainTipOf({ tip_height: 0, indexed_height: 969_712 })).locked, false);
  // The site banner names every paused action.
  const sync = (x) => ({ indexed: 969_700, tip: 969_705, lag: 5, stalled: false, rebuilding: false, noPeers: false, networkLag: 0, synced: false, trustUnseen: false, ...x });
  for (const s of [sync({ rebuilding: true }), sync({ stalled: true, noPeers: true }), sync({ stalled: true }), sync({ networkLag: 3 }), sync({})]) {
    assert.match(syncWarningText(s), /Creating, mining, sending, listing and buying (are paused|resume)/);
  }
  console.log("texts: a fill without a known block, tip 0, the paused-actions banner");
}

// ---- 8. the signature TYPE the transaction needs --------------------------------------------------
{
  const ADDR = MOCK_WALLET.address;
  const refused = (e) => e.code === "sighash-mismatch" && /input \d+ was signed with type 0x[0-9a-f]{2}, not the type this transaction needs, so nothing was sent/.test(e.message);
  const before = pushed.length;
  // The app's own transactions: a wallet that signs one asked input 0x83 is refused, and nothing is held or sent.
  const dep = buildDeployPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: [{ txid: T(30), vout: 0, sats: 200_000 }, { txid: T(31), vout: 0, sats: 150_000 }], tokenOutpoints: [], feeRateSatVb: 3, ticker: "NEWTKN", selectionOrder: "largest" });
  const send = buildSendPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: [{ txid: T(32), vout: 0, sats: 200_000 }], tokenOutpoints: [], tokenUtxos: [{ txid: T(33), vout: 0, sats: 546 }], feeRateSatVb: 3, ticker: "LUCKY", amount: 5, toAddress: ADDR });
  for (const [label, built, index] of [["DEPLOY", dep, 0], ["SEND", send, 0], ["SEND (fee input)", send, 1]]) {
    forceSighash = { index, type: LISTING_SIGHASH };
    await assert.rejects(wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address: ADDR }), refused, `${label}: input ${index} signed 0x83`);
    forceSighash = null;
    for (const k of psbtInputKeys(built.psbtHex)) assert.equal(wallet.inFlightOutpoints().has(k), false, `${label}: nothing held after the refusal`);
    const ok = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address: ADDR });
    assert.ok(ok.length > 0, `${label}: the wallet's own default signatures pass (64-byte P2TR = 0x00)`);
    wallet.releaseInputs(built.psbtHex);
  }
  forceSighash = { index: 0, type: 0x81 };
  await assert.rejects(wallet.signPsbt(dep.psbtHex, { inputIndexes: dep.inputIndexes, address: ADDR }), (e) => e.code === "sighash-mismatch" && /type 0x81/.test(e.message), "ANYONECANPAY|ALL on a DEPLOY");
  forceSighash = { index: 0, type: 0x01 };
  assert.ok((await wallet.signPsbt(dep.psbtHex, { inputIndexes: dep.inputIndexes, address: ADDR })).length > 0, "SIGHASH_ALL (0x01) signs the whole tx too");
  wallet.releaseInputs(dep.psbtHex);
  forceSighash = null;
  // A fill: the buyer's own inputs are checked (the seller's 0x83 input 0 is not the wallet's to sign).
  {
    const seller = keyFor("sighash-seller", "tr");
    const listing = buildListingPsbt({ address: seller.address, pubkeyHex: seller.pubkeyHex, tokenUtxo: { txid: T(34), vout: 0, sats: 546 }, priceSats: 5_000, amount: 100 });
    const ltx = parse(listing.psbtHex);
    ltx.signIdx(seller.priv, 0, [btc.SigHash.SINGLE_ANYONECANPAY]);
    const order = { id: `${T(34)}:0`, ticker: "LUCKY", amount: 100, price_sats: 5_000, unit_price: 50, seller: seller.address, carrier_sats: 546, status: "open" };
    const fill = buildFillPsbt({ listingPsbtHex: hex.encode(ltx.toPSBT()), order, sendAmount: 100, address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: [{ txid: T(35), vout: 0, sats: 200_000 }], tokenOutpoints: [], feeRateSatVb: 3 });
    forceSighash = { index: fill.inputIndexes[0], type: LISTING_SIGHASH };
    await assert.rejects(wallet.signPsbt(fill.psbtHex, { inputIndexes: fill.inputIndexes, address: ADDR }), refused, "a fill whose buyer input came back signed 0x83");
    forceSighash = null;
    const signedFill = await wallet.signPsbt(fill.psbtHex, { inputIndexes: fill.inputIndexes, address: ADDR });
    assert.ok(finalizeFill(signedFill, { op: "SEND", ticker: "LUCKY", amount: 100 }).length > 0, "the same fill signed as asked goes through");
    wallet.releaseInputs(fill.psbtHex);
  }
  // A listing is signed exactly 0x83: 0x01 is refused, the listing's own signature passes.
  {
    const listing = buildListingPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: { txid: T(36), vout: 0, sats: 546 }, priceSats: 10_000, amount: 100 });
    forceSighash = { index: 0, type: 0x01 };
    await assert.rejects(wallet.signPsbt(listing.psbtHex, { inputIndexes: [0], address: ADDR, autoFinalized: false, sighashTypes: [LISTING_SIGHASH] }), (e) => e.code === "sighash-mismatch" && /input 0 was signed with type 0x01/.test(e.message), "a listing signed 0x01");
    forceSighash = null;
    const signed = await wallet.signPsbt(listing.psbtHex, { inputIndexes: [0], address: ADDR, autoFinalized: false, sighashTypes: [LISTING_SIGHASH] });
    assert.ok(signed.length > 0, "the listing's own 0x83 signature passes");
  }
  assert.equal(pushed.length, before, "nothing was broadcast");
  console.log("sighash: a DEPLOY, SEND or fill input signed 0x83 / 0x81 is refused (sighash-mismatch) and nothing is sent; a listing must be exactly 0x83");
}

console.log("walletflows: all checks passed");
