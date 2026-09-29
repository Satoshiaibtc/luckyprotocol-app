// Tests for src/lib/secondSource.js: the mempool.space second
// check of a listing's outpoint — URL shape, the pure comparison with
// agree / unverified / disagree fixtures (value, script, and the §7.2 step 3 OP_RETURN
// re-parse for MINE and SEND carriers, with the creating tx's fee output
// and its input 1), and the transport's unreachable
// paths (timeout, network error, server error, non-JSON, and a 404 beside
// an outage) through an injected fetch. Plain Node, no framework, no network.
import assert from "node:assert/strict";
import { hex } from "@scure/base";
import { SECOND_SOURCE_ORIGIN, SECOND_SOURCE_TIMEOUT_MS, carrierAmountCheck, checkSecondSource, compareSecondSource, originCheckState, originRefused, payloadOfTxVouts, secondSourceAllowsSigning, secondSourceUrls } from "../src/lib/secondSource.js";
import { decodeAddress } from "../src/lib/psbt.js";
import { PROJECT_FEE_ADDRESS } from "../src/lib/payloads.js";

const TXID = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SCRIPT = "5120" + "ab".repeat(32); // a P2TR scriptPubKey
const FEE = hex.encode(decodeAddress(PROJECT_FEE_ADDRESS).script); // the protocol fee address's script
const SELLER = "0014" + "cd".repeat(20);
// `OP_RETURN <one push>` as an explorer serialises it: 6a + PUSHBYTES_n + ascii.
const opret = (text) => ({ scriptpubkey: `6a${text.length > 75 ? "4c" : ""}${text.length.toString(16).padStart(2, "0")}${Buffer.from(text, "ascii").toString("hex")}`, scriptpubkey_type: "op_return", value: 0 });
const send = (tick, amt) => `{"p":"lucky-20","op":"send","tick":"${tick}","amt":"${amt}"}`;
const minePayload = (tick) => `{"p":"lucky-20","op":"mine","tick":"${tick}"}`;
// The reference fill (§7.2): vout0 the seller's price, vout1 the buyer's
// token carrier (AMT), vout2 the buyer's residual carrier, vout3 the fee,
// vout4 the OP_RETURN. The listing is a later resale of vout1.
const listing = { txid: TXID, vout: 1, carrierSats: 546, scriptHex: SCRIPT, ticker: "LUCKY", amount: 1200 };

const agreeOutspend = { spent: false };
const agreeTx = {
  txid: TXID,
  vout: [{ scriptpubkey: SELLER, value: 12_000 }, { scriptpubkey: SCRIPT, value: 546, scriptpubkey_type: "v1_p2tr" }, { scriptpubkey: SCRIPT, value: 546 }, { scriptpubkey: FEE, value: 546 }, opret(send("LUCKY", 1200))],
  status: { confirmed: true, block_height: 970_000, block_hash: "00".repeat(31) + "0f" },
};

// ---- URLs: txid + vout only, path segments, no query string ------------------------------------------
{
  const u = secondSourceUrls(TXID, 1);
  assert.equal(u.outspend, `https://mempool.space/api/tx/${TXID}/outspend/1`);
  assert.equal(u.tx, `https://mempool.space/api/tx/${TXID}`);
  assert.equal(SECOND_SOURCE_ORIGIN, "https://mempool.space");
  assert.equal(SECOND_SOURCE_TIMEOUT_MS, 5_000);
  const up = secondSourceUrls(TXID.toUpperCase(), "1");
  assert.equal(up.tx, u.tx, "txid lower-cased, vout coerced");
  assert.throws(() => secondSourceUrls("not-a-txid", 0), /invalid txid/);
  assert.throws(() => secondSourceUrls(TXID, -1), /invalid vout/);
  assert.throws(() => secondSourceUrls(TXID, 1.5), /invalid vout/);
  assert.throws(() => secondSourceUrls(`${TXID}?x=1`, 0), /invalid txid/, "nothing but the txid can reach the URL");
  for (const url of Object.values(u)) {
    assert.ok(!url.includes("?") && !url.includes("#"), "no query string, no fragment");
    assert.ok(url.startsWith("https://mempool.space/api/tx/"));
  }
  console.log("second source urls: /api/tx/<txid>/outspend/<vout> and /api/tx/<txid>, validated inputs only");
}

// ---- pure comparison ---------------------------------------------------------------------------------
{
  assert.deepEqual(compareSecondSource(listing, { outspend: agreeOutspend, tx: agreeTx }), { verdict: "agree", reasons: [], notes: [] }, "unspent + same value + same script → agree");
  assert.equal(compareSecondSource({ ...listing, scriptHex: SCRIPT.toUpperCase() }, { outspend: agreeOutspend, tx: agreeTx }).verdict, "agree", "script comparison is case-insensitive");

  const spent = compareSecondSource(listing, { outspend: { spent: true, txid: "f".repeat(64), vin: 0 }, tx: agreeTx });
  assert.equal(spent.verdict, "disagree");
  assert.match(spent.reasons[0], /already spent by ffffffff/);

  const value = compareSecondSource(listing, { outspend: agreeOutspend, tx: { ...agreeTx, vout: [agreeTx.vout[0], { ...agreeTx.vout[1], value: 10_000 }] } });
  assert.equal(value.verdict, "disagree");
  assert.match(value.reasons[0], /shows 10,000 sats on vout 1, the listing says 546/);

  const script = compareSecondSource(listing, { outspend: agreeOutspend, tx: { ...agreeTx, vout: [agreeTx.vout[0], { ...agreeTx.vout[1], scriptpubkey: "5120" + "ee".repeat(32) }] } });
  assert.equal(script.verdict, "disagree");
  assert.match(script.reasons[0], /different scriptPubKey/);

  const missing = compareSecondSource(listing, { outspend: agreeOutspend, tx: { txid: TXID, vout: [agreeTx.vout[0]] } });
  assert.equal(missing.verdict, "disagree");
  assert.match(missing.reasons[0], /only 1 output\(s\) — vout 1 does not exist/);

  const other = compareSecondSource(listing, { outspend: agreeOutspend, tx: { ...agreeTx, txid: "0".repeat(64) } });
  assert.equal(other.verdict, "disagree");
  assert.match(other.reasons[0], /different txid/);

  const unknown = compareSecondSource(listing, { outspend: { }, tx: agreeTx });
  assert.equal(unknown.verdict, "disagree", "an outspend record without `spent:false` never counts as unspent");
  assert.match(unknown.reasons[0], /did not answer whether/);

  const both = compareSecondSource(listing, { outspend: { spent: true }, tx: null });
  assert.equal(both.verdict, "disagree");
  assert.equal(both.reasons.length, 2, "every disagreement is listed");

  const noScript = compareSecondSource({ ...listing, scriptHex: "" }, { outspend: agreeOutspend, tx: agreeTx });
  assert.equal(noScript.verdict, "disagree", "a listing without a witnessUtxo script cannot be vouched for");
  console.log("second source compare: agree fixture passes; spent / value / script / missing vout / other txid / shapeless all disagree");
}

// ---- §7.2 step 3: the OP_RETURN re-parsed ----------------------------------------------------------
{
  const withPayload = (text) => ({ ...agreeTx, vout: agreeTx.vout.map((v, i) => (i === 4 ? opret(text) : v)) });
  assert.deepEqual(payloadOfTxVouts(agreeTx.vout), { op: "SEND", ticker: "LUCKY", amount: 1200 }, "the payload as the indexer reads it");
  assert.equal(payloadOfTxVouts([{ scriptpubkey: SCRIPT }]), null);
  assert.equal(payloadOfTxVouts([{ scriptpubkey: "zz" }]), null, "junk hex is not a payload");

  const noTicker = compareSecondSource({ txid: TXID, vout: 1, carrierSats: 546, scriptHex: SCRIPT }, { outspend: agreeOutspend, tx: agreeTx });
  assert.equal(noTicker.verdict, "disagree", "without ticker / amount the OP_RETURN cannot be checked — fail closed");
  assert.match(noTicker.reasons[0], /no ticker \/ amount/);

  // SEND carrier: vout1 with the same AMT agrees; another AMT, another vout, another ticker do not.
  assert.equal(compareSecondSource(listing, { outspend: agreeOutspend, tx: agreeTx }).verdict, "agree", "vout 1 and AMT == amount");
  const amt = compareSecondSource(listing, { outspend: agreeOutspend, tx: withPayload(send("LUCKY", 1300)) });
  assert.equal(amt.verdict, "disagree");
  assert.match(amt.reasons[0], /moves 1300 LUCKY to vout 1, the listing says 1200/);
  const otherTicker = compareSecondSource(listing, { outspend: agreeOutspend, tx: withPayload(send("ORE", 1200)) });
  assert.equal(otherTicker.verdict, "disagree", "vout1 of a SEND of another ticker holds only that ticker");
  assert.match(otherTicker.reasons[0], /SEND of ORE whose LUCKY residual goes to vout 2, the listing is vout 1/);
  // §4.1: every ticker's residual lands on the residual output — a carrier
  // left there by a SEND of another ticker (a "move ORE to its own carrier"
  // send of a UTXO that also held LUCKY) is a real LUCKY carrier:
  // unverified, never a dead listing.
  const otherResidual = compareSecondSource({ ...listing, vout: 2, amount: 300 }, { outspend: agreeOutspend, tx: withPayload(send("ORE", 1200)) });
  assert.equal(otherResidual.verdict, "unverified", "the residual output of a SEND of another ticker");
  assert.equal(otherResidual.reasons.length, 0);
  assert.match(otherResidual.notes[0], /residual output of a SEND of ORE: it holds whatever LUCKY/);
  assert.equal(secondSourceAllowsSigning(otherResidual.verdict, { unverifiedAck: true }), true, "a buyer can confirm and sign it");
  // vout2 unusable → the default output (the lowest non-OP_RETURN) is the residual output.
  const noVout2 = { txid: TXID, vout: [{ scriptpubkey: SELLER, value: 12_000 }, { scriptpubkey: SCRIPT, value: 546 }, opret(send("ORE", 1200)), { scriptpubkey: FEE, value: 546 }], status: agreeTx.status };
  const otherResidualFallback = carrierAmountCheck({ vout: 0, ticker: "LUCKY", amount: 300 }, noVout2);
  assert.deepEqual([otherResidualFallback.reasons.length, otherResidualFallback.notes.length], [0, 1], "vout2 an OP_RETURN → the default output (vout0) is the residual output");
  // In the plain-SEND reference layout that default output is the fee output at vout0.
  const plainNoVout2 = { txid: TXID, vout: [{ scriptpubkey: FEE, value: 546 }, { scriptpubkey: SCRIPT, value: 546 }, opret(send("LUCKY", 10))], status: agreeTx.status };
  const onFee = carrierAmountCheck({ vout: 0, ticker: "LUCKY", amount: 90 }, plainNoVout2);
  assert.deepEqual([onFee.reasons.length, onFee.notes.length], [0, 1], "without vout2 the rest lands on vout0, the fee output");
  // A vout0 of a SEND with a usable vout2 carries nothing.
  const v0 = carrierAmountCheck({ vout: 0, ticker: "LUCKY", amount: 1200 }, agreeTx);
  assert.match(v0.reasons[0], /routes LUCKY to vout 1 and the residual to vout 2 — vout 0 carries no tokens/, "vout0 of a SEND (the fee, or a fill's price) is never a token output");
  // …including the seller's payment output of a fill that did not pay the SEND fee (§4 rule 6): the listed tokens sit there, but it is no MINE or SEND token output.
  const feeLessFill = { ...agreeTx, vout: agreeTx.vout.filter((_, i) => i !== 3) };
  const onPayment = compareSecondSource({ ...listing, vout: 0, carrierSats: 12_000, scriptHex: SELLER }, { outspend: agreeOutspend, tx: feeLessFill });
  assert.equal(onPayment.verdict, "disagree", "a listing's payment output after a fee-less spend");
  assert.equal(originRefused(onPayment), true, "…refused for its origin");

  const deployOrigin = compareSecondSource(listing, { outspend: agreeOutspend, tx: withPayload('{"p":"lucky-20","op":"deploy","tick":"LUCKY"}') });
  assert.equal(deployOrigin.verdict, "disagree");
  assert.match(deployOrigin.reasons[0], /the creating tx is a DEPLOY, which credits no token output/);
  assert.equal(originRefused({ verdict: "disagree", reasons: deployOrigin.reasons }), true, "a DEPLOY output is refused for its origin");
  const pipe = compareSecondSource(listing, { outspend: agreeOutspend, tx: withPayload("LUCKY-20|SEND|LUCKY|1200|1|2") });
  assert.equal(pipe.verdict, "disagree", "a `|`-separated push is not a payload");
  assert.match(pipe.reasons[0], /no LUCKY-20 OP_RETURN/);
  assert.equal(originRefused({ verdict: "disagree", reasons: ["mempool.space shows no LUCKY-20 OP_RETURN on the creating tx — vout 1 is not a MINE or SEND token output"] }), true, "a plain transfer is refused for its origin");
  assert.equal(originRefused({ verdict: "disagree", reasons: ["mempool.space says the outpoint is already spent"] }), false, "spent says nothing about the origin");
  assert.equal(originRefused({ verdict: "unreachable", reasons: [] }), false);
  assert.equal(originRefused({ verdict: "unverified", reasons: [] }), false);
  // The sell form: signing waits until the check has answered for the selected carrier.
  const row = { key: `${TXID}:1` };
  assert.deepEqual(originCheckState({ key: row.key, refused: false, checking: true }, row), { blocked: false, pending: true }, "still asking: not listable yet");
  assert.deepEqual(originCheckState({ key: `${TXID}:0`, refused: false }, row), { blocked: false, pending: true }, "the answer is for the carrier selected before");
  assert.deepEqual(originCheckState({ key: null, refused: false }, row), { blocked: false, pending: true }, "never asked");
  assert.deepEqual(originCheckState({ key: row.key, refused: true }, row), { blocked: true, pending: false }, "answered: a buyer would refuse it");
  assert.deepEqual(originCheckState({ key: row.key, refused: false }, row), { blocked: false, pending: false }, "answered (an unreachable source included): listable");
  assert.deepEqual(originCheckState({ key: null, refused: false, checking: true }, { ...row, multi: true }), { blocked: false, pending: false }, "a multi-ticker carrier is not checked");
  assert.deepEqual(originCheckState({ key: null, refused: false }, null), { blocked: false, pending: false }, "nothing selected");
  const residual = compareSecondSource({ ...listing, vout: 2, amount: 7 }, { outspend: agreeOutspend, tx: agreeTx });
  assert.equal(residual.verdict, "unverified", "the vout2 residual output is a token output too (§2.3 / §4.1) — but its balance depends on the inputs: amount not independently verified");
  assert.equal(residual.reasons.length, 0);
  assert.match(residual.notes[0], /vout 2 is the SEND's residual output \(vout2\).*cannot see token balances/);
  const notASlot = compareSecondSource({ ...listing, vout: 3, scriptHex: FEE }, { outspend: agreeOutspend, tx: agreeTx });
  assert.equal(notASlot.verdict, "disagree");
  assert.match(notASlot.reasons[0], /routes LUCKY to vout 1 and the residual to vout 2 — vout 3 carries no tokens/);
  const none = compareSecondSource(listing, { outspend: agreeOutspend, tx: { ...agreeTx, vout: agreeTx.vout.filter((_, i) => i !== 4) } });
  assert.equal(none.verdict, "disagree");
  assert.match(none.reasons[0], /no LUCKY-20 OP_RETURN/);

  // The creating SEND's fee output: without it the SEND moved nothing to vout1.
  const noFee = { ...agreeTx, vout: agreeTx.vout.map((v, i) => (i === 3 ? { scriptpubkey: SELLER, value: 546 } : v)) };
  const noFeeTo = compareSecondSource(listing, { outspend: agreeOutspend, tx: noFee });
  assert.equal(noFeeTo.verdict, "disagree", "vout1 of a SEND without its fee output holds nothing");
  assert.match(noFeeTo.reasons[0], /the creating SEND has no 546-sat fee output, so it credited nothing to vout 1/);
  assert.equal(originRefused(noFeeTo), true, "…refused for its origin");
  const wrongFee = { ...agreeTx, vout: agreeTx.vout.map((v, i) => (i === 3 ? { scriptpubkey: FEE, value: 547 } : v)) };
  assert.equal(compareSecondSource(listing, { outspend: agreeOutspend, tx: wrongFee }).verdict, "disagree", "the fee must be exactly 546 sats");
  assert.equal(compareSecondSource({ ...listing, vout: 2, amount: 7 }, { outspend: agreeOutspend, tx: noFee }).verdict, "unverified", "an unapplied SEND still routes its pool to vout2");

  // Input 1 of the creating SEND signed as a listing (0x83): vout1 may hold that listing's tokens instead of AMT.
  const withVin = (vin1) => ({ ...agreeTx, vin: [{ witness: ["11".repeat(64)], prevout: { scriptpubkey: SCRIPT } }, vin1] });
  const listed1 = compareSecondSource(listing, { outspend: agreeOutspend, tx: withVin({ witness: ["22".repeat(64) + "83"], prevout: { scriptpubkey: "5120" + "33".repeat(32) } }) });
  assert.equal(listed1.verdict, "unverified", "a P2TR key-path 0x83 signature on input 1");
  assert.match(listed1.notes[0], /input 1 of the creating tx is signed as a listing, so vout 1 may hold that listing's tokens/);
  const listed1w = compareSecondSource(listing, { outspend: agreeOutspend, tx: withVin({ witness: ["30" + "44".repeat(70) + "83", "02" + "55".repeat(32)], prevout: { scriptpubkey: "0014" + "66".repeat(20) } }) });
  assert.equal(listed1w.verdict, "unverified", "a P2WPKH 0x83 signature on input 1");
  assert.equal(compareSecondSource(listing, { outspend: agreeOutspend, tx: withVin({ witness: ["22".repeat(64)], prevout: { scriptpubkey: "5120" + "33".repeat(32) } }) }).verdict, "agree", "a whole-tx signature on input 1 changes nothing");
  assert.equal(compareSecondSource(listing, { outspend: agreeOutspend, tx: withVin({ witness: ["22".repeat(64) + "83"], prevout: { scriptpubkey: "0020" + "33".repeat(32) } }) }).verdict, "agree", "a spent output with no signature type has no listing signature");

  // MINE carrier: vout 0, yield from the confirming block hash (…f → 1000), with its 546-sat fee output.
  const mineTx = { txid: TXID, vout: [{ scriptpubkey: SCRIPT, value: 546 }, { scriptpubkey: FEE, value: 546 }, opret(minePayload("LUCKY"))], status: { confirmed: true, block_hash: "00".repeat(31) + "0f" } };
  const mine = { txid: TXID, vout: 0, carrierSats: 546, scriptHex: SCRIPT, ticker: "LUCKY", amount: 1000 };
  assert.equal(compareSecondSource(mine, { outspend: agreeOutspend, tx: mineTx }).verdict, "agree", "yield 1000 == amount");
  const wrongYield = compareSecondSource({ ...mine, amount: 550 }, { outspend: agreeOutspend, tx: mineTx });
  assert.equal(wrongYield.verdict, "disagree", "550 is no credit §3 can give (not the tier, not a multiple of 100)");
  assert.match(wrongYield.reasons[0], /block hash …f yields 1000 LUCKY \(§3\), the listing says 550/);
  const over = compareSecondSource({ ...mine, amount: 1100 }, { outspend: agreeOutspend, tx: mineTx });
  assert.equal(over.verdict, "disagree", "more than the tier is never credited");
  const mid = compareSecondSource({ ...mine, amount: 500 }, { outspend: agreeOutspend, tx: { ...mineTx, status: { confirmed: true, block_hash: "00".repeat(31) + "0c" } } });
  assert.equal(mid.verdict, "agree", "…c → 500 (§3 mid bucket)");
  const unconfirmed = compareSecondSource(mine, { outspend: agreeOutspend, tx: { ...mineTx, status: { confirmed: false } } });
  assert.match(unconfirmed.reasons[0], /not show the MINE as confirmed/);
  const wrongVout = compareSecondSource({ ...mine, vout: 1, scriptHex: FEE }, { outspend: agreeOutspend, tx: mineTx });
  assert.match(wrongVout.reasons[0], /a MINE credits vout 0, the listing is vout 1/);
  const feeLessMine = compareSecondSource(mine, { outspend: agreeOutspend, tx: { ...mineTx, vout: [mineTx.vout[0], { scriptpubkey: SELLER, value: 546 }, mineTx.vout[2]] } });
  assert.equal(feeLessMine.verdict, "disagree", "a MINE without its fee output credited nothing");
  assert.match(feeLessMine.reasons[0], /the creating MINE has no 546-sat fee output, so it credited nothing to vout 0/);
  assert.equal(originRefused(feeLessMine), true);
  console.log("second source OP_RETURN: SEND vout1 (AMT) agrees, vout2 is unverified, vout0 / other vouts / tickers / opcodes / pipe pushes disagree; no fee output → nothing credited; input 1 signed 0x83 → unverified; MINE vout 0 + recomputed yield");
}

// ---- partial credits and amounts the second source cannot confirm -----------
{
  const CAP = 970_200;
  const mineTx = (height, last = "f") => ({
    txid: TXID,
    vout: [{ scriptpubkey: SCRIPT, value: 546 }, { scriptpubkey: FEE, value: 546 }, opret(minePayload("LUCKY"))],
    status: { confirmed: true, block_height: height, block_hash: "00".repeat(31) + "0" + last },
  });
  const mine = { txid: TXID, vout: 0, carrierSats: 546, scriptHex: SCRIPT, ticker: "LUCKY", amount: 300, capHeight: CAP };

  // §3: the MINE that completed the supply is credited min(tier, remaining) — only in the cap block.
  const partial = compareSecondSource(mine, { outspend: agreeOutspend, tx: mineTx(CAP) });
  assert.equal(partial.verdict, "unverified", "300 of a 1,000 tier in the cap block: a real §3 credit, amount not independently verified");
  assert.deepEqual(partial.reasons, []);
  assert.match(partial.notes[0], /yields a 1000 tier and the listing says 300: the MINE that completed the LUCKY supply is credited only what was left/);
  const partialNoCap = compareSecondSource({ ...mine, capHeight: null }, { outspend: agreeOutspend, tx: mineTx(CAP) });
  assert.equal(partialNoCap.verdict, "unverified", "cap block unknown → cannot refuse, cannot confirm");
  const partialElsewhere = compareSecondSource(mine, { outspend: agreeOutspend, tx: mineTx(CAP - 5) });
  assert.equal(partialElsewhere.verdict, "disagree", "a partial credit outside the cap block is impossible");
  assert.match(partialElsewhere.reasons[0], /only in the block that completed the LUCKY supply \(#970,200\); this one confirmed in block #970,195/);
  const fullAfterCap = compareSecondSource({ ...mine, amount: 1000 }, { outspend: agreeOutspend, tx: mineTx(CAP + 1) });
  assert.equal(fullAfterCap.verdict, "disagree", "after the cap block §3 credits 0 — a full tier there cannot be a credit");
  assert.match(fullAfterCap.reasons[0], /after block #970,200 completed the LUCKY supply — §3 credits 0 there/);
  assert.equal(compareSecondSource({ ...mine, amount: 1000 }, { outspend: agreeOutspend, tx: mineTx(CAP) }).verdict, "agree", "a full tier IN the cap block is fine (mines before the crossing one)");
  assert.equal(compareSecondSource({ ...mine, amount: 1000 }, { outspend: agreeOutspend, tx: mineTx(CAP - 100) }).verdict, "agree", "a full tier before the cap block is verified");
  assert.equal(compareSecondSource({ ...mine, amount: 250 }, { outspend: agreeOutspend, tx: mineTx(CAP) }).verdict, "disagree", "credits are multiples of 100");
  assert.equal(compareSecondSource({ ...mine, amount: 100 }, { outspend: agreeOutspend, tx: mineTx(CAP, "0") }).verdict, "agree", "tier 100: the only positive credit is the tier itself");
  assert.equal(compareSecondSource({ ...mine, amount: 200 }, { outspend: agreeOutspend, tx: mineTx(CAP, "7") }).verdict, "agree");
  assert.equal(compareSecondSource({ ...mine, amount: 100 }, { outspend: agreeOutspend, tx: mineTx(CAP, "7") }).verdict, "unverified", "100 of a 200 tier in the cap block");

  // zero-token carriers are never buyable
  const zero = compareSecondSource({ ...mine, amount: 0 }, { outspend: agreeOutspend, tx: mineTx(CAP) });
  assert.equal(zero.verdict, "disagree");
  assert.match(zero.reasons[0], /0 tokens — a zero-token carrier is never buyable/);
  assert.match(carrierAmountCheck({ vout: 0, ticker: "LUCKY", amount: 0 }, mineTx(CAP)).reasons[0], /zero-token carrier/);

  // SEND in the plain reference layout: vout1 with AMT is verified; the residual output is not.
  const sendTx = { txid: TXID, vout: [{ scriptpubkey: FEE, value: 546 }, { scriptpubkey: SCRIPT, value: 546 }, { scriptpubkey: SCRIPT, value: 546 }, opret(send("LUCKY", 40))], status: { confirmed: true, block_height: 970_250, block_hash: "00".repeat(32) } };
  const to = { txid: TXID, vout: 1, carrierSats: 546, scriptHex: SCRIPT, ticker: "LUCKY", amount: 40 };
  assert.equal(compareSecondSource(to, { outspend: agreeOutspend, tx: sendTx }).verdict, "agree");
  assert.equal(compareSecondSource({ ...to, vout: 2, amount: 9 }, { outspend: agreeOutspend, tx: sendTx }).verdict, "unverified", "residual output");
  // vout0 an OP_RETURN and vout2 unusable: the default output is vout1, which then holds AMT + the residual.
  const merged = { txid: TXID, vout: [opret(send("LUCKY", 40)), { scriptpubkey: SCRIPT, value: 546 }, opret("memo"), { scriptpubkey: FEE, value: 546 }], status: sendTx.status };
  const fallback = compareSecondSource({ ...to, amount: 49 }, { outspend: agreeOutspend, tx: merged });
  assert.equal(fallback.verdict, "unverified", "vout2 is an OP_RETURN → the residual lands on the default output vout1 = AMT + residual");
  assert.match(fallback.notes[0], /residual lands on vout 1 too/);
  assert.equal(compareSecondSource({ ...to, amount: 39 }, { outspend: agreeOutspend, tx: merged }).verdict, "disagree", "less than AMT on vout1 is never right");

  // the buy sheet's gate: agree as is; unverified and unreachable each need their own tick; disagree never
  assert.equal(secondSourceAllowsSigning("agree"), true);
  assert.equal(secondSourceAllowsSigning("unverified"), false);
  assert.equal(secondSourceAllowsSigning("unverified", { unreachableAck: true }), false, "the outage tick does not confirm an amount");
  assert.equal(secondSourceAllowsSigning("unverified", { unverifiedAck: true }), true);
  assert.equal(secondSourceAllowsSigning("unreachable", { unverifiedAck: true }), false);
  assert.equal(secondSourceAllowsSigning("unreachable", { unreachableAck: true }), true);
  assert.equal(secondSourceAllowsSigning("disagree", { unreachableAck: true, unverifiedAck: true }), false);
  assert.equal(secondSourceAllowsSigning("checking"), false);
  console.log("second source amounts: §3 partial credit only in the cap block (unverified), full tier after it refused, zero-token carriers refused, residual outputs unverified; separate ticks");
}

// ---- transport ---------------------------------------------------------------------------------------
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const fetchWith = (map, log) => async (url, init) => {
  log?.push({ url, init });
  const r = map[url];
  if (r instanceof Error) throw r;
  if (typeof r === "function") return r(init);
  return r;
};

{
  const urls = secondSourceUrls(TXID, 1);
  const log = [];
  const ok = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json(agreeOutspend), [urls.tx]: json(agreeTx) }, log) });
  assert.equal(ok.verdict, "agree");
  assert.match(ok.detail, /agrees: unspent, 546 sats, same script/);
  assert.deepEqual(log.map((l) => l.url).sort(), [urls.tx, urls.outspend].sort(), "exactly the two URLs, nothing else");
  for (const l of log) {
    assert.equal(l.init.method, "GET");
    assert.equal(l.init.credentials, "omit", "no cookies");
    assert.equal(l.init.body, undefined, "no body");
    assert.equal(l.init.headers, undefined, "no custom headers (no preflight, nothing extra sent)");
    assert.ok(l.init.signal instanceof AbortSignal, "abortable (the timeout)");
  }

  const residualUrls = secondSourceUrls(TXID, 2);
  const unv = await checkSecondSource({ ...listing, vout: 2, amount: 7 }, { fetchImpl: fetchWith({ [residualUrls.outspend]: json(agreeOutspend), [residualUrls.tx]: json(agreeTx) }) });
  assert.equal(unv.verdict, "unverified");
  assert.match(unv.detail, /agrees on the outpoint .* but cannot confirm the amount/);
  assert.equal(unv.notes.length, 1);

  const bad = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json({ spent: true }), [urls.tx]: json(agreeTx) }) });
  assert.equal(bad.verdict, "disagree", "disagreement is a hard stop, not an outage");
  assert.match(bad.detail, /already spent/);

  const gone = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json({}, 404), [urls.tx]: json({}, 404) }) });
  assert.equal(gone.verdict, "disagree", "404 = the second source has no record of what the indexer vouches for");
  assert.equal(gone.reasons.length, 2);
  assert.match(gone.reasons[1], /no record of transaction/);

  // A 404 beside an outage is still a verdict — never an "unreachable" the buyer could tick past.
  const mixed = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json({}, 404), [urls.tx]: new TypeError("Failed to fetch") }) });
  assert.equal(mixed.verdict, "disagree", "404 on one request + network error on the other → disagree");
  assert.match(mixed.reasons[0], /no record of outpoint/);
  const mixed2 = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json("busy", 503), [urls.tx]: json({}, 404) }) });
  assert.equal(mixed2.verdict, "disagree", "5xx on one + 404 on the other → disagree");

  const down = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json("busy", 503), [urls.tx]: json(agreeTx) }) });
  assert.equal(down.verdict, "unreachable", "a server error is an outage, not a verdict");
  assert.match(down.detail, /HTTP 503/);

  const net = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: new TypeError("Failed to fetch"), [urls.tx]: json(agreeTx) }) });
  assert.equal(net.verdict, "unreachable");
  assert.match(net.detail, /Failed to fetch/);

  const html = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }, [urls.tx]: json(agreeTx) }) });
  assert.equal(html.verdict, "unreachable", "an HTML error page is not an answer");
  assert.match(html.detail, /not JSON/);

  // Timeout: a fetch that only resolves when its signal aborts.
  const hang = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const t0 = Date.now();
  const slow = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: hang, [urls.tx]: hang }), timeoutMs: 30 });
  assert.equal(slow.verdict, "unreachable");
  assert.match(slow.detail, /did not answer within/);
  assert.ok(Date.now() - t0 < 2_000, "the timeout, not the hang, ended the check");

  const malformed = await checkSecondSource({ txid: "zz", vout: 0, carrierSats: 546, scriptHex: SCRIPT }, { fetchImpl: fetchWith({}) });
  assert.equal(malformed.verdict, "disagree", "a malformed outpoint never reaches the network");
  assert.equal(malformed.urls, null);
  console.log("second source transport: agree / disagree / 404→disagree (even beside an outage) / 5xx, network error, non-JSON, timeout → unreachable; GET, no credentials, no headers");
}

console.log("second source: all checks passed");
