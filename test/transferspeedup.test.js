// A transfer waiting for a block can be sped up — from the form that made
// it and from the page's list of unconfirmed transfers. Plain Node, no
// framework:
//
//   1. a real Speed up of a SEND: every input, every output and the payload
//      kept, a strictly higher fee that meets the replacement rule (old fee
//      + incremental relay fee × new size), taken from the BTC change; the
//      PSBT a record keeps names the very transaction the wallet signs;
//   2. the form: Speed up while its transfer waits (pending or unseen),
//      never once it confirmed, never without a change output;
//   3. a listed transfer: Speed up when its record holds the PSBT of this
//      very transaction from this address, one plain sentence when it does
//      not, one line when it has no change output, never for another
//      address's; the form's own transfer points at the form;
//   4. after a Speed up: the flow follows the faster version, one row per
//      transfer, the earlier version's record kept until one version
//      confirms, its inputs held and excluded meanwhile; a faster version
//      another tab made that confirmed before this page read it is followed;
//   5. withdrawals and splits: their records and their Speed up unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import {
  buildMinePsbt,
  buildSendPsbt,
  buildSpeedUpPsbt,
  expectPsbtPayload,
  extractRawTxHex,
  psbtFeeSats,
  psbtVsize,
  rawTxSummary,
  RBF_SEQUENCE,
  sendPsbtFacts,
  speedUpFloorRate,
} from "../src/lib/psbt.js";
import { PROTOCOL_LOCKTIME } from "../src/lib/payloads.js";
import { MOCK_WALLET, mockSignPsbt } from "../src/lib/mock.js";
import {
  TRANSFER_NO_CHANGE,
  TRANSFER_SPEEDUP_ELSEWHERE,
  followConfirmedTransfer,
  followTransfer,
  keepsReplacedVersion,
  pendingSendsOf,
  pendingTransferText,
  sendVersions,
  switchSendVersion,
  transferFromRecord,
  transferRecordKeeps,
  transferRootOf,
  transferSpeedUpNote,
  transferSpeedUpState,
} from "../src/lib/send.js";
import { DROP_GRACE_MS, createTxRecordStore, forgetTx, pendingSpentOutpoints, refreshTxRecords, txRecords } from "../src/lib/txrecords.js";
import * as wallet from "../src/lib/wallet.js";

const TX = (c) => c.repeat(64);
const ADDR = MOCK_WALLET.address; // bc1p…
const RCPT = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const parse = (psbtHex) => btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });
const signedTxid = (psbtHex) => rawTxSummary(extractRawTxHex(mockSignPsbt(psbtHex, { autoFinalized: true }))).txid;
const memStore = (clock) => {
  const mem = new Map();
  return createTxRecordStore({ storage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) }, now: () => clock.now });
};

const carrier = { txid: TX("c"), vout: 1, sats: 546 };
const fund = { txid: TX("1"), vout: 0, sats: 60_000 };
const build = (toAddress, rate = 2) =>
  buildSendPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: [fund], tokenOutpoints: [{ txid: carrier.txid, vout: carrier.vout }], tokenUtxos: [carrier], feeRateSatVb: rate, ticker: "LUCKY", amount: 300, toAddress });
const built = build(RCPT);
const firstTxid = sendPsbtFacts(built.psbtHex, ADDR).txid;
const inputKeys = built.inputs.map((u) => `${u.txid}:${u.vout}`);

// ---- 1. a real Speed up of a SEND ------------------------------------------------------------------------
{
  assert.equal(built.changeVout, 4, "a SEND's BTC change is vout4");
  const a = parse(built.psbtHex);
  const oldFee = psbtFeeSats(built.psbtHex);
  for (const inc of [1, 0.1, 3]) {
    for (const rate of [1, 2.5, 12, 40]) {
      const q = buildSpeedUpPsbt({ psbtHex: built.psbtHex, changeVout: built.changeVout, feeRateSatVb: rate, incrementalRelayFee: inc });
      const b = parse(q.psbtHex);
      const what = `${rate} sat/vB, increment ${inc}`;
      assert.equal(b.inputsLength, a.inputsLength, `${what}: the same number of inputs`);
      for (let i = 0; i < a.inputsLength; i++) {
        const x = a.getInput(i);
        const y = b.getInput(i);
        assert.equal(hex.encode(y.txid), hex.encode(x.txid), `${what}: input ${i} spends the same output`);
        assert.equal(y.index, x.index);
        assert.equal(y.sequence, x.sequence, "and still signals replace-by-fee");
        assert.equal(y.witnessUtxo.amount, x.witnessUtxo.amount);
        assert.equal(hex.encode(y.witnessUtxo.script), hex.encode(x.witnessUtxo.script));
      }
      assert.equal(b.outputsLength, a.outputsLength, `${what}: the same outputs`);
      for (let i = 0; i < a.outputsLength; i++) {
        assert.equal(hex.encode(b.getOutput(i).script), hex.encode(a.getOutput(i).script), `${what}: vout${i} pays the same script`);
        if (i !== built.changeVout) assert.equal(b.getOutput(i).amount, a.getOutput(i).amount, `${what}: vout${i} the same amount`);
      }
      assert.equal(b.lockTime, a.lockTime);
      assert.equal(b.version, a.version);
      // The payload and the reference layout: what the hook checks before the wallet opens.
      assert.deepEqual(
        expectPsbtPayload(q.psbtHex, { op: "SEND", ticker: "LUCKY", amount: 300, lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self: ADDR, to: RCPT } }),
        { op: "SEND", ticker: "LUCKY", amount: 300 },
        `${what}: the same SEND payload`,
      );
      const newFee = psbtFeeSats(q.psbtHex);
      assert.equal(q.feeSats, newFee);
      assert.equal(q.oldFeeSats, oldFee);
      assert.ok(newFee > oldFee, `${what}: a strictly higher fee`);
      assert.equal(Number(a.getOutput(4).amount) - Number(b.getOutput(4).amount), newFee - oldFee, `${what}: the extra fee comes from the change`);
      // BIP125: the replacement pays for its own relay on top of the old fee —
      // checked against the size the signed transaction really has.
      const realSize = btc.Transaction.fromRaw(hex.decode(extractRawTxHex(mockSignPsbt(q.psbtHex, { autoFinalized: true }))), { allowUnknownOutputs: true }).vsize;
      assert.ok(realSize <= Math.ceil(psbtVsize(q.psbtHex)), "the size the fee was computed for is not below the real one");
      assert.ok(newFee >= oldFee + Math.ceil(inc * realSize), `${what}: ${newFee} ≥ ${oldFee} + ${inc} × ${realSize}`);
      assert.ok(newFee >= Math.ceil(rate * Math.ceil(psbtVsize(q.psbtHex))), `${what}: at least the asked rate`);
    }
  }
  // The lowest rate the control suggests is a valid replacement already.
  const floor = speedUpFloorRate(built.psbtHex, 1);
  const atFloor = buildSpeedUpPsbt({ psbtHex: built.psbtHex, changeVout: built.changeVout, feeRateSatVb: floor, incrementalRelayFee: 1 });
  assert.ok(atFloor.feeSats >= oldFee + Math.ceil(psbtVsize(atFloor.psbtHex)), "the floor rate meets the rule");
  // The PSBT a record keeps names the transaction the wallet signs (a segwit id leaves the witnesses out).
  assert.equal(firstTxid, signedTxid(built.psbtHex), "the unsigned PSBT's id is the broadcast txid");
  const q = buildSpeedUpPsbt({ psbtHex: built.psbtHex, changeVout: built.changeVout, feeRateSatVb: 12 });
  assert.equal(sendPsbtFacts(q.psbtHex, ADDR).txid, signedTxid(q.psbtHex));
  assert.notEqual(sendPsbtFacts(q.psbtHex, ADDR).txid, firstTxid, "a faster version is another transaction");
  const facts = sendPsbtFacts(built.psbtHex, ADDR);
  assert.deepEqual([facts.ticker, facts.amount, facts.toAddress, facts.fromSelf], ["LUCKY", 300, RCPT, true]);
  assert.equal(sendPsbtFacts(built.psbtHex, RCPT).fromSelf, false, "another address did not make it");
  assert.equal(sendPsbtFacts(buildMinePsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: [fund], tokenOutpoints: [], feeRateSatVb: 2, ticker: "LUCKY" }).psbtHex, ADDR), null, "a MINE is not a transfer");
  assert.equal(sendPsbtFacts("zz", ADDR), null, "never throws");
  console.log("transfer speed up: every input, output and the payload kept; a strictly higher fee that meets the replacement rule, from the change");
}

// ---- 2. the form: Speed up while its transfer waits, never once it confirmed ------------------------------
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
{
  // The control's own gate (SpeedUpSend.jsx): only a waiting tx whose unsigned PSBT the flow holds.
  const control = code(src("components/SpeedUpSend.jsx"));
  assert.match(control, /if \(\(chain\.phase !== "pending" && chain\.phase !== "unseen"\) \|\| !psbt\) return null;/, "SpeedUpSend renders nothing unless the tx waits and its PSBT is held");
  const offered = (chain) => (chain.phase === "pending" || chain.phase === "unseen") && !!chain.psbt;
  // The flow after a transfer is broadcast keeps the PSBT and its change output…
  const hook = code(src("hooks/useSendToSelf.js"));
  assert.match(hook, /setChain\(\(c\) => \(\{ \.\.\.c, phase: "pending", txid, psbt: built\.psbtHex, changeVout: built\.changeVout \?\? null \}\)\);/, "a broadcast transfer keeps its PSBT in the flow");
  assert.match(hook, /setChain\(\(c\) => \(\{ \.\.\.c, phase: "confirmed" \}\)\);/, "a confirmed one leaves the waiting phases");
  const pending = { phase: "pending", kind: "send", ticker: "LUCKY", amount: 300, toAddress: RCPT, txid: firstTxid, psbt: built.psbtHex, changeVout: 4 };
  assert.equal(offered(pending), true, "pending: Speed up");
  assert.equal(offered({ ...pending, phase: "unseen" }), true, "not seen for a while: Speed up");
  assert.equal(offered({ ...pending, phase: "confirmed" }), false, "confirmed: no Speed up");
  assert.equal(offered({ phase: "idle" }), false);
  assert.equal(offered({ ...pending, phase: "signing", psbt: undefined }), false, "nothing broadcast yet");
  // An earlier version confirmed instead: the flow follows it, without a PSBT — nothing left to speed up.
  const after = switchSendVersion({ ...pending, txid: TX("9"), replaces: [firstTxid] }, firstTxid);
  assert.equal(offered({ ...after, phase: "confirmed" }), false);
  assert.equal(after.psbt, null);
  // …and the page renders the control under the transfer's progress, with a note that fits a transfer —
  // when the transfer has a BTC change output to take the higher fee from; without one, one plain line.
  const page = code(src("pages/SendPage.jsx"));
  assert.match(page, /const transferFlow = useSendToSelf\(\{/, "the form's flow is passed whole to the control");
  assert.match(
    page,
    /<TxProgress\s+flow=\{chain\}[\s\S]*?\/>\s*\{Number\.isInteger\(chain\.changeVout\) \? \(\s*<SpeedUpSend send=\{transferFlow\} fees=\{fees\?\.data\} note=\{transferSpeedUpNote\(chain\.toAddress === address\)\} \/>\s*\) : waiting && chain\.psbt \? \(\s*<div className="muted">\{TRANSFER_NO_CHANGE\}<\/div>\s*\) : null\}/,
    "SendPage: Speed up right under the transfer's progress (the no-change line instead when there is no change)",
  );
  // The page's own gate on top of the control's: a change output to take the fee from.
  const formOffers = (chain) => Number.isInteger(chain.changeVout) && offered(chain);
  const formNoChange = (chain) => !Number.isInteger(chain.changeVout) && (chain.phase === "pending" || chain.phase === "unseen") && !!chain.psbt;
  assert.equal(formOffers(pending), true);
  assert.equal(formOffers({ ...pending, phase: "confirmed" }), false, "confirmed: no Speed up");
  assert.equal(formOffers({ ...pending, changeVout: null }), false, "no change output: no Speed up…");
  assert.equal(formNoChange({ ...pending, changeVout: null }), true, "…the line instead");
  assert.equal(formNoChange({ ...pending, changeVout: null, phase: "confirmed" }), false);
  assert.equal(formNoChange(pending), false);
  // The review panel that holds the control stays while the transfer is in flight (not only on the review step).
  assert.match(page, /const inFlight = chain\.phase !== "idle";/);
  assert.match(page, /\{\(step === "review" \|\| inFlight\) && \(/, "the review panel (and its Speed up) stays while the transfer waits");
  assert.equal(transferSpeedUpNote(false), "A transfer waiting for a block confirms sooner with a higher fee. The recipient receives the tokens once it confirms.");
  assert.equal(transferSpeedUpNote(true), "A transfer waiting for a block confirms sooner with a higher fee. The tokens are on your new carrier once it confirms.");
  console.log("transfer form: Speed up while the transfer waits (pending or unseen), not once it confirmed");
}

// ---- 3. a listed transfer -----------------------------------------------------------------------------------
{
  const clock = { now: 1_000_000 };
  const store = memStore(clock);
  const keep = transferRecordKeeps("send", { psbt: built.psbtHex, changeVout: built.changeVout });
  store.add(ADDR, { txid: firstTxid, kind: "send", ticker: "LUCKY", inputs: built.inputs, ...keep });
  const [rec] = store.list(ADDR);
  assert.deepEqual([rec.psbt, rec.changeVout, rec.replaces], [built.psbtHex, 4, []], "a transfer's record keeps its PSBT and change output");
  assert.equal(transferSpeedUpState(rec, { address: ADDR }), "yes", "its record holds what a replacement needs: Speed up");
  const t = transferFromRecord(rec, ADDR);
  assert.deepEqual([t.ticker, t.amount, t.toAddress, t.txid, t.changeVout], ["LUCKY", 300, RCPT, firstTxid, 4]);
  assert.equal(t.feeSats, psbtFeeSats(built.psbtHex));
  // The flow takes it up, pending: the control is offered, and a Speed up rebuilds from it.
  const followed = followTransfer({ phase: "idle" }, t);
  assert.deepEqual([followed.phase, followed.kind, followed.txid, followed.psbt, followed.changeVout], ["pending", "send", firstTxid, built.psbtHex, 4]);
  assert.doesNotThrow(() => buildSpeedUpPsbt({ psbtHex: followed.psbt, changeVout: followed.changeVout, feeRateSatVb: 9 }));
  // A transfer to yourself (a split made on the Transfer page) works the same.
  const self = build(ADDR, 3);
  const selfRec = { ...rec, txid: sendPsbtFacts(self.psbtHex, ADDR).txid, psbt: self.psbtHex };
  assert.equal(transferSpeedUpState(selfRec, { address: ADDR }), "yes");
  assert.equal(transferFromRecord(selfRec, ADDR).toAddress, ADDR);

  // No PSBT in the record (another page or tab made it, or it was too large to keep): one plain sentence.
  const bare = { ...rec, psbt: null, changeVout: null };
  assert.equal(transferSpeedUpState(bare, { address: ADDR }), "page");
  assert.equal(transferFromRecord(bare, ADDR), null);
  assert.equal(TRANSFER_SPEEDUP_ELSEWHERE, "This transfer can only be sped up from the page or tab that sent it.");
  // A PSBT that is not this record's transaction, or names another ticker, is never rebuilt from.
  assert.equal(transferSpeedUpState({ ...rec, txid: TX("7") }, { address: ADDR }), "page", "the PSBT is another transaction");
  assert.equal(transferSpeedUpState({ ...rec, ticker: "ORE" }, { address: ADDR }), "page", "another ticker");
  assert.equal(transferFromRecord({ ...rec, confirmed: true }, ADDR), null, "a confirmed transfer is not followed");
  assert.equal(followTransfer({ phase: "idle" }, null).phase, "idle");

  // Another address's transaction: never offered, whatever its record says.
  const priv = sha256(new TextEncoder().encode("transferspeedup:other"));
  const otherPub = pubECDSA(priv, true);
  const OTHER = btc.p2wpkh(otherPub, btc.NETWORK).address;
  const foreign = buildSendPsbt({ address: OTHER, pubkeyHex: hex.encode(otherPub), utxos: [{ txid: TX("2"), vout: 0, sats: 60_000 }], tokenOutpoints: [], tokenUtxos: [{ txid: TX("d"), vout: 0, sats: 546 }], feeRateSatVb: 2, ticker: "LUCKY", amount: 5, toAddress: RCPT });
  const foreignRec = { ...rec, txid: sendPsbtFacts(foreign.psbtHex, OTHER).txid, psbt: foreign.psbtHex, changeVout: foreign.changeVout };
  assert.equal(transferSpeedUpState(foreignRec, { address: ADDR }), "no", "made by another address: never offered");
  assert.equal(transferFromRecord(foreignRec, ADDR), null, "and never followed");
  assert.equal(transferSpeedUpState(foreignRec, { address: OTHER }), "yes", "(its own address could)");

  // The form's own transfer (any of its versions): its row points at the form.
  assert.equal(transferSpeedUpState(rec, { address: ADDR, followed: [TX("8"), firstTxid] }), "form");
  assert.equal(transferSpeedUpState(bare, { address: ADDR, followed: [firstTxid] }), "form");

  // A transfer without a BTC change output (its fee input left too little for one): no Speed up anywhere,
  // one plain line instead — the form's own too (its row does not point at a control that cannot work).
  const lean = buildSendPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: [{ txid: TX("1"), vout: 0, sats: 1_711 }], tokenOutpoints: [{ txid: carrier.txid, vout: carrier.vout }], tokenUtxos: [carrier], feeRateSatVb: 2, ticker: "LUCKY", amount: 300, toAddress: RCPT, minInputSats: 0 });
  assert.equal(lean.changeVout, null, "no change output");
  const leanRec = { ...rec, txid: sendPsbtFacts(lean.psbtHex, ADDR).txid, ...transferRecordKeeps("send", { psbt: lean.psbtHex, changeVout: lean.changeVout }) };
  assert.equal(leanRec.changeVout, null);
  assert.equal(transferSpeedUpState(leanRec, { address: ADDR }), "no-change", "no change: never offered");
  assert.equal(transferSpeedUpState(leanRec, { address: ADDR, followed: [leanRec.txid] }), "no-change", "the form's own: the line, not a pointer");
  assert.throws(() => buildSpeedUpPsbt({ psbtHex: lean.psbtHex, changeVout: null, feeRateSatVb: 10 }), (e) => e.code === "speedup-no-change", "(a replacement has nothing to take the fee from)");
  assert.equal(TRANSFER_NO_CHANGE, "No change output to take a higher fee from — it confirms when a block includes it.");
  assert.equal(transferSpeedUpState({ ...leanRec, psbt: null }, { address: ADDR }), "page", "without its PSBT nothing is known: the sentence");

  // The page: each row has its own flow, keyed by the transfer's first version.
  const page = code(src("pages/SendPage.jsx"));
  assert.match(page, /<PendingTransferRow key=\{transferRootOf\(r\)\} record=\{r\} address=\{address\} followed=\{followed\} fees=\{fees\?\.data\} onSettled=\{rowSettled\} \/>/);
  assert.match(
    page,
    /const waiting = chain\.phase === "pending" \|\| chain\.phase === "unseen";\s*const followed = useMemo\(\(\) => \(waiting \? sendVersions\(chain\) : \[\]\), \[waiting, chain\]\);/,
    "rows of the form's own transfer point at the form",
  );
  assert.match(page, /function PendingTransferRow\(\{ record, address, followed, fees, onSettled \}\) \{\s*const flow = useSendToSelf\(\{ onSettled \}\);/, "a row follows its transfer with a flow of its own");
  assert.match(page, /useEffect\(\(\) => \{\s*if \(state === "yes"\) follow\(record\);\s*\}, \[state, record, follow\]\);/, "only a row whose record can rebuild it is followed");
  assert.match(page, /\{state === "yes" && mine \? \(\s*<div className="mine-pending-extra">\s*<SpeedUpSend send=\{flow\} fees=\{fees\} note=\{transferSpeedUpNote\(chain\.toAddress === address\)\} \/>/, "yes: the control");
  assert.match(page, /: state === "form" \? \(\s*<div className="mine-pending-extra muted">Its Speed up is in the transfer above\.<\/div>/, "form: points at the form");
  assert.match(page, /: state === "no-change" \? \(\s*<div className="mine-pending-extra muted">\{TRANSFER_NO_CHANGE\}<\/div>/, "no-change: the line");
  assert.match(page, /: state === "page" \? \(\s*<div className="mine-pending-extra muted">\{TRANSFER_SPEEDUP_ELSEWHERE\}<\/div>\s*\) : null\}/, "page: the sentence; anything else (another address): nothing");
  // The form follows a faster version made in another tab — or the one that confirmed, read from every record.
  assert.match(
    page,
    /useEffect\(\(\) => \{\s*if \(!waiting\) return;\s*const settled = records\.find\(\(r\) => followConfirmedTransfer\(chain, r, address\) !== chain\);\s*const newer = settled \?\? pendingSends\.find\(\(r\) => r\.txid !== chain\.txid && \(r\.replaces \|\| \[\]\)\.includes\(chain\.txid\)\);\s*if \(newer\) follow\(newer\);\s*\}, \[waiting, records, pendingSends, chain, address, follow\]\);/,
    "the form moves to a faster version made in another tab",
  );
  // The hook's follow takes the record up (a row's Speed up depends on it), and the hook returns it.
  const hook = code(src("hooks/useSendToSelf.js"));
  assert.match(
    hook,
    /const follow = useCallback\(\s*\(rec\) => \{\s*if \(address && rec\?\.confirmed && rec\.kind === "send"\) \{\s*setChain\(\(c\) => followConfirmedTransfer\(c, rec, address\)\);\s*return true;\s*\}\s*const t = address \? transferFromRecord\(rec, address\) : null;\s*if \(!t\) return false;\s*setChain\(\(c\) => followTransfer\(c, t\)\);\s*return true;/,
    "the hook's follow takes the record up",
  );
  assert.match(hook, /return \{[^}]*\bfollow \};/, "and returns it");
  console.log("transfer list: Speed up when the record holds this transaction's PSBT; one sentence when it does not; never for another address");
}

// ---- 4. after a Speed up -------------------------------------------------------------------------------------
{
  const clock = { now: 2_000_000 };
  const store = memStore(clock);
  const answers = {};
  const status = async (txid) => answers[txid] ?? { confirmed: false, seen: false };
  const refresh = () => refreshTxRecords(ADDR, status, { store, now: () => clock.now, tip: null, trustUnseen: true });
  // What the hook does, step by step, with a store of its own.
  store.add(ADDR, { txid: firstTxid, kind: "send", ticker: "LUCKY", inputs: built.inputs, ...transferRecordKeeps("send", { psbt: built.psbtHex, changeVout: built.changeVout }) });
  let chain = followTransfer({ phase: "idle" }, transferFromRecord(store.list(ADDR)[0], ADDR));
  const speedUp = (c, rate) => {
    const q = buildSpeedUpPsbt({ psbtHex: c.psbt, changeVout: c.changeVout, feeRateSatVb: rate });
    const txid = sendPsbtFacts(q.psbtHex, ADDR).txid;
    store.add(ADDR, { txid, kind: "send", ticker: c.ticker, inputs: built.inputs, ...transferRecordKeeps(c.kind, { psbt: q.psbtHex, changeVout: c.changeVout, replaces: [...(c.replaces || []), c.txid] }) });
    if (!keepsReplacedVersion(c.kind)) store.forget(ADDR, c.txid);
    return { ...c, phase: "pending", txid, psbt: q.psbtHex, feeSats: q.feeSats, feeRateSatVb: q.feeRateSatVb, replaces: [...(c.replaces || []), c.txid] };
  };
  answers[firstTxid] = { confirmed: false, seen: true };
  await refresh();
  clock.now += 60_000;
  chain = speedUp(chain, 12);
  const second = chain.txid;
  assert.notEqual(second, firstTxid, "the flow follows the faster version");
  assert.deepEqual(sendVersions(chain), [second, firstTxid]);
  let recs = store.list(ADDR);
  assert.deepEqual(recs.map((r) => r.txid), [firstTxid, second], "the earlier version's record is kept");
  assert.deepEqual(recs[1].replaces, [firstTxid], "the faster one names it");
  assert.equal(recs[1].psbt, chain.psbt, "and keeps what a further Speed up needs");
  // The page lists one transfer, under the same key, and it can be sped up again (after a reload too).
  let rows = pendingSendsOf(recs, "LUCKY");
  assert.deepEqual(rows.map((r) => r.txid), [second], "one row per transfer");
  assert.equal(transferRootOf(rows[0]), firstTxid, "the row keeps its key");
  assert.equal(transferRootOf(recs[0]), firstTxid);
  assert.match(pendingTransferText(rows[0]), /^sped up · waiting for a block/);
  assert.equal(pendingTransferText(recs[0]), "waiting for a block — its carriers are left out of new transfers until it confirms or drops");
  assert.equal(transferSpeedUpState(rows[0], { address: ADDR }), "yes");
  assert.deepEqual(sendVersions(followTransfer({ phase: "idle" }, transferFromRecord(rows[0], ADDR))), [second, firstTxid], "a reload follows every version");
  // Every input stays excluded from new transfers and fee choices.
  for (const k of inputKeys) assert.ok(pendingSpentOutpoints(recs).has(k), `${k} excluded`);
  // The replaced version drops out of the node's view; its record stays while the faster one waits.
  answers[firstTxid] = { confirmed: false, seen: false };
  answers[second] = { confirmed: false, seen: true };
  clock.now += DROP_GRACE_MS + 60_000;
  await refresh();
  await refresh();
  assert.deepEqual(store.list(ADDR).map((r) => r.txid), [firstTxid, second], "kept until one version confirms");

  // A Speed up made in another tab: the form waiting on the earlier version moves to the faster one.
  const tabA = { phase: "pending", kind: "send", ticker: "LUCKY", amount: 300, toAddress: RCPT, txid: firstTxid, psbt: built.psbtHex, changeVout: 4, replaces: [] };
  const moved = followTransfer(tabA, transferFromRecord(rows[0], ADDR));
  assert.deepEqual([moved.txid, moved.replaces, moved.psbt], [second, [firstTxid], chain.psbt]);
  assert.equal(followTransfer(moved, transferFromRecord(recs[0], ADDR)), moved, "an earlier version never takes over");
  assert.equal(followTransfer({ ...tabA, speeding: "signing" }, transferFromRecord(rows[0], ADDR)).txid, firstTxid, "not while it signs a Speed up of its own");
  assert.equal(followTransfer({ ...tabA, phase: "confirmed" }, transferFromRecord(rows[0], ADDR)).txid, firstTxid);
  assert.equal(followTransfer({ ...tabA, kind: "cancel" }, transferFromRecord(rows[0], ADDR)).txid, firstTxid, "a withdrawal is never taken over");

  // A second Speed up names every version; the row still stands for one transfer.
  chain = speedUp(chain, 30);
  const third = chain.txid;
  answers[second] = { confirmed: false, seen: false };
  answers[third] = { confirmed: false, seen: true };
  recs = store.list(ADDR);
  assert.deepEqual(recs.map((r) => r.txid), [firstTxid, second, third]);
  assert.deepEqual(recs[2].replaces, [firstTxid, second]);
  rows = pendingSendsOf(recs, "LUCKY");
  assert.deepEqual(rows.map((r) => r.txid), [third]);
  assert.equal(transferRootOf(rows[0]), firstTxid);
  clock.now += DROP_GRACE_MS + 60_000;
  await refresh();
  assert.deepEqual(store.list(ADDR).map((r) => r.txid), [firstTxid, second, third], "every earlier version kept while the newest waits");

  // The newest one confirms: the others go — the hook forgets them, and the store's own re-check no longer keeps them.
  answers[third] = { confirmed: true, seen: true, block_height: 970_296 };
  await refresh();
  recs = store.list(ADDR);
  assert.deepEqual(pendingSendsOf(recs, "LUCKY"), [], "nothing left waiting");
  assert.ok(recs.find((r) => r.txid === third)?.confirmed, "the confirmed version guards its inputs until final");
  for (const k of inputKeys) assert.ok(pendingSpentOutpoints(recs).has(k), "still excluded until final");
  await refresh();
  assert.deepEqual(store.list(ADDR).map((r) => r.txid), [third], "the unseen earlier versions are no longer kept");
  const hookCopy = memStore(clock);
  for (const r of recs) hookCopy.add(ADDR, r);
  hookCopy.markConfirmed(ADDR, third, 970_296);
  if (keepsReplacedVersion(chain.kind)) for (const t of sendVersions(chain)) if (t !== third) hookCopy.forget(ADDR, t);
  assert.deepEqual(hookCopy.list(ADDR).map((r) => r.txid), [third], "the hook forgets them as soon as one version confirms");
  // The hook does so in onConfirmed.
  assert.match(
    code(src("hooks/useSendToSelf.js")),
    /markTxConfirmed\(address, chain\.txid, s\.block_height \?\? null\);\s*if \(address && chain\.txid && keepsReplacedVersion\(chain\.kind\)\) for \(const t of sendVersions\(chain\)\) if \(t !== chain\.txid\) forgetTx\(address, t\);/,
  );

  // An earlier version confirms instead: the list clears at once.
  const clock2 = { now: 5_000_000 };
  const store2 = memStore(clock2);
  store2.add(ADDR, { txid: firstTxid, kind: "send", ticker: "LUCKY", inputs: built.inputs, ...transferRecordKeeps("send", { psbt: built.psbtHex, changeVout: 4 }) });
  store2.add(ADDR, { txid: TX("e"), kind: "send", ticker: "LUCKY", inputs: built.inputs, ...transferRecordKeeps("send", { psbt: null, changeVout: 4, replaces: [firstTxid] }) });
  store2.markConfirmed(ADDR, firstTxid, 970_297);
  assert.deepEqual(pendingSendsOf(store2.list(ADDR), "LUCKY"), [], "a faster version whose earlier version confirmed is not listed");
  // Two faster versions of one transfer (two tabs): one row, the newest.
  const store3 = memStore({ now: 6_000_000 });
  store3.add(ADDR, { txid: TX("a"), kind: "send", ticker: "LUCKY", inputs: inputKeys, replaces: [firstTxid] });
  store3.add(ADDR, { txid: TX("b"), kind: "send", ticker: "LUCKY", inputs: inputKeys, replaces: [firstTxid] });
  assert.equal(pendingSendsOf(store3.list(ADDR), "LUCKY").length, 1);
  console.log("transfer after a Speed up: the flow follows the faster version; one row; the earlier record kept until one version confirms");
}

// ---- 4b. holds and exclusions with the wallet module ------------------------------------------------------------
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const provider = {
    requestAccounts: async () => [ADDR],
    getAccounts: async () => [ADDR],
    getPublicKey: async () => MOCK_WALLET.pubkeyHex,
    getNetwork: async () => "livenet",
    signPsbt: async (psbtHex, opts) => mockSignPsbt(psbtHex, opts),
    pushPsbt: async (signed) => rawTxSummary(extractRawTxHex(signed)).txid,
    pushTx: async (arg) => rawTxSummary(typeof arg === "string" ? arg : arg.rawtx).txid,
  };
  globalThis.window = { unisat: provider };
  await wallet.connect("unisat");
  // The transfer is signed and broadcast: its record keeps its PSBT.
  const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address: ADDR });
  const sent = await wallet.broadcastSignedPsbt(signed, { kind: "send", ticker: "LUCKY", address: ADDR, ...transferRecordKeeps("send", { psbt: built.psbtHex, changeVout: built.changeVout }) });
  assert.equal(sent, firstTxid);
  const rec = txRecords(ADDR).find((r) => r.txid === sent);
  assert.equal(rec.psbt, built.psbtHex);
  assert.equal(transferSpeedUpState(rec, { address: ADDR }), "yes");
  // Nothing else may spend its inputs: another transfer of the same carrier is refused before the wallet opens.
  const other = build(RCPT, 5);
  await assert.rejects(wallet.signPsbt(other.psbtHex, { inputIndexes: other.inputIndexes, address: ADDR }), (e) => e.code === "busy");
  // The Speed up names the version it replaces, and may.
  const q = buildSpeedUpPsbt({ psbtHex: built.psbtHex, changeVout: built.changeVout, feeRateSatVb: 15 });
  const signedQ = await wallet.signPsbt(q.psbtHex, { inputIndexes: q.inputIndexes, address: ADDR, replaces: sendVersions({ txid: sent }) });
  const faster = await wallet.broadcastSignedPsbt(signedQ, { kind: "send", ticker: "LUCKY", address: ADDR, ...transferRecordKeeps("send", { psbt: q.psbtHex, changeVout: built.changeVout, replaces: [sent] }) });
  assert.ok(keepsReplacedVersion("send"));
  assert.deepEqual(
    txRecords(ADDR).map((r) => [r.txid, r.replaces]),
    [
      [sent, []],
      [faster, [sent]],
    ],
    "both versions keep a record",
  );
  // Still nothing else may spend the inputs…
  await assert.rejects(wallet.signPsbt(other.psbtHex, { inputIndexes: other.inputIndexes, address: ADDR }), (e) => e.code === "busy", "the inputs stay held");
  for (const k of inputKeys) assert.ok(pendingSpentOutpoints(txRecords(ADDR)).has(k));
  // …and a further Speed up must name every version (the hook names sendVersions of its flow).
  const q2 = buildSpeedUpPsbt({ psbtHex: q.psbtHex, changeVout: built.changeVout, feeRateSatVb: 25 });
  await assert.rejects(wallet.signPsbt(q2.psbtHex, { inputIndexes: q2.inputIndexes, address: ADDR, replaces: [faster] }), (e) => e.code === "busy", "the earlier version's record still guards");
  const both = await wallet.signPsbt(q2.psbtHex, { inputIndexes: q2.inputIndexes, address: ADDR, replaces: sendVersions({ txid: faster, replaces: [sent] }) });
  assert.ok(both.length > 0);
  wallet.releaseInputs(q2.psbtHex);
  forgetTx(ADDR, faster);
  forgetTx(ADDR, sent);
  console.log("transfer speed up: the inputs stay held and excluded from every other flow while any version waits");
}

// ---- 4c. another tab's faster version confirmed before this page read it ----------------------------------------
{
  // The form waits on A (not seen for a while); another tab sped A up to B; B confirmed while this tab slept.
  const clock = { now: 8_000_000 };
  const store = memStore(clock);
  const q = buildSpeedUpPsbt({ psbtHex: built.psbtHex, changeVout: built.changeVout, feeRateSatVb: 12 });
  const B = sendPsbtFacts(q.psbtHex, ADDR).txid;
  store.add(ADDR, { txid: firstTxid, kind: "send", ticker: "LUCKY", inputs: built.inputs, ...transferRecordKeeps("send", { psbt: built.psbtHex, changeVout: 4 }) });
  store.add(ADDR, { txid: B, kind: "send", ticker: "LUCKY", inputs: built.inputs, ...transferRecordKeeps("send", { psbt: q.psbtHex, changeVout: 4, replaces: [firstTxid] }) });
  clock.now += 5 * 60_000;
  await refreshTxRecords(ADDR, async (t) => (t === B ? { confirmed: true, seen: true, block_height: 970_096 } : { confirmed: false, seen: false }), { store, now: () => clock.now, tip: 970_095, trustUnseen: true });
  const records = store.list(ADDR);
  assert.deepEqual(pendingSendsOf(records, "LUCKY"), [], "no row waits: the faster version confirmed");
  assert.equal(transferFromRecord(records.find((r) => r.txid === B), ADDR), null, "and it is not followed as a waiting transfer");
  const form = { phase: "unseen", kind: "send", ticker: "LUCKY", amount: 300, toAddress: RCPT, txid: firstTxid, psbt: built.psbtHex, changeVout: 4, replaces: [], feeSats: built.feeSats, feeRateSatVb: 2, note: "not seen" };
  // What the page's effect does: the record that moves the form, read from every record (confirmed ones too).
  const settled = records.find((r) => followConfirmedTransfer(form, r, ADDR) !== form);
  assert.equal(settled?.txid, B, "the page finds the version that confirmed");
  const moved = followConfirmedTransfer(form, settled, ADDR);
  assert.deepEqual([moved.txid, moved.replaces, moved.psbt, moved.phase, moved.note], [B, [firstTxid], null, "pending", null], "the form moves to it: pending until its status check settles it, nothing left to speed up");
  assert.deepEqual([moved.feeSats, moved.ticker, moved.amount, moved.toAddress], [q.feeSats, "LUCKY", 300, RCPT], "the fee shown is the one that confirmed; the transfer is the same");
  assert.equal(records.find((r) => followConfirmedTransfer(moved, r, ADDR) !== moved), undefined, "once there, nothing moves it again");
  // Its status check confirms B: the hook forgets every other version (as in onConfirmed).
  const hookCopy = memStore(clock);
  for (const r of records) hookCopy.add(ADDR, r);
  hookCopy.markConfirmed(ADDR, B, 970_096);
  if (keepsReplacedVersion(moved.kind)) for (const t of sendVersions(moved)) if (t !== moved.txid) hookCopy.forget(ADDR, t);
  assert.deepEqual(hookCopy.list(ADDR).map((r) => r.txid), [B]);
  // A form that sped A up here too (A2), while the other tab's B confirmed: it moves to B, and names A2 among the others.
  const q2 = buildSpeedUpPsbt({ psbtHex: built.psbtHex, changeVout: 4, feeRateSatVb: 20 });
  const A2 = sendPsbtFacts(q2.psbtHex, ADDR).txid;
  const own = { ...form, phase: "pending", txid: A2, psbt: q2.psbtHex, replaces: [firstTxid] };
  const sibling = followConfirmedTransfer(own, settled, ADDR);
  assert.equal(sibling.txid, B);
  assert.deepEqual([...sendVersions(sibling)].sort(), [A2, B, firstTxid].sort(), "every version is known: the others are forgotten once B confirms here");
  // Never moved: another transfer's record, a waiting record, a flow that is not a waiting transfer.
  assert.equal(followConfirmedTransfer(form, { ...settled, txid: TX("f"), replaces: [TX("e")] }, ADDR), form, "another transfer");
  assert.equal(followConfirmedTransfer(form, { ...settled, confirmed: false }, ADDR), form, "not confirmed: followTransfer's case");
  assert.equal(followConfirmedTransfer({ ...form, kind: "cancel" }, settled, ADDR).txid, firstTxid, "a withdrawal");
  assert.equal(followConfirmedTransfer({ ...form, speeding: "signing" }, settled, ADDR).txid, firstTxid, "not while it signs a Speed up of its own");
  assert.equal(followConfirmedTransfer({ ...form, phase: "confirmed" }, settled, ADDR).txid, firstTxid);
  assert.equal(followConfirmedTransfer({ phase: "idle" }, settled, ADDR).phase, "idle", "an idle flow (a row) never takes a confirmed one up");
  console.log("transfer sped up in another tab and confirmed there: the form moves to the version that confirmed");
}

// ---- 5. withdrawals and splits: unchanged --------------------------------------------------------------------
{
  for (const kind of ["cancel", "split"]) {
    assert.deepEqual(transferRecordKeeps(kind, { psbt: built.psbtHex, changeVout: 4, replaces: [TX("1")] }), {}, `${kind}: the record keeps no PSBT`);
    assert.equal(keepsReplacedVersion(kind), false, `${kind}: a Speed up drops the earlier record once the faster one is out`);
    const clock = { now: 7_000_000 };
    const store = memStore(clock);
    store.add(ADDR, { txid: TX("3"), kind: "send", ticker: "LUCKY", inputs: inputKeys, ...transferRecordKeeps(kind, { psbt: built.psbtHex, changeVout: 4 }) });
    store.add(ADDR, { txid: TX("4"), kind: "send", ticker: "LUCKY", inputs: inputKeys, ...transferRecordKeeps(kind, { psbt: built.psbtHex, changeVout: 4, replaces: [TX("3")] }) });
    if (!keepsReplacedVersion(kind)) store.forget(ADDR, TX("3"));
    const recs = store.list(ADDR);
    assert.deepEqual(recs.map((r) => [r.txid, r.psbt, r.replaces]), [[TX("4"), null, []]], `${kind}: one record, as before`);
    assert.equal(transferSpeedUpState(recs[0], { address: ADDR }), "page", `${kind}: listed on the Transfer page, sped up where it was made`);
    // The store's re-check drops an unseen withdrawal or split as before (no version keeps it).
    const kept = memStore(clock);
    kept.add(ADDR, { txid: TX("5"), kind: "send", ticker: "LUCKY", inputs: inputKeys });
    kept.add(ADDR, { txid: TX("6"), kind: "send", ticker: "LUCKY", inputs: inputKeys });
    clock.now += DROP_GRACE_MS + 1;
    await refreshTxRecords(ADDR, async (t) => (t === TX("6") ? { confirmed: false, seen: true } : { confirmed: false, seen: false }), { store: kept, now: () => clock.now, tip: null, trustUnseen: true });
    assert.deepEqual(kept.list(ADDR).map((r) => r.txid), [TX("6")], `${kind}: an unseen record is dropped after the grace`);
  }
  // Their Speed up is the same code: the same control and notes, the same guard, the same replacement.
  const hook = code(src("hooks/useSendToSelf.js"));
  assert.match(hook, /const keep = transferRecordKeeps\(kind, \{ psbt: built\.psbtHex, changeVout: built\.changeVout \}\);\s*txid = await wallet\.broadcastSignedPsbt\(signed, \{ kind: "send", ticker, address, \.\.\.keep \}\);/);
  assert.match(hook, /const keep = transferRecordKeeps\(c\.kind, \{ psbt: q\.psbtHex, changeVout: c\.changeVout, replaces: \[\.\.\.\(c\.replaces \|\| \[\]\), c\.txid\] \}\);/);
  assert.match(hook, /txid = await wallet\.broadcastSignedPsbt\(signed, \{ kind: "send", ticker: c\.ticker, address, \.\.\.keep \}\);/);
  assert.match(hook, /if \(!unsure && !keepsReplacedVersion\(c\.kind\)\) forgetTx\(address, c\.txid\);/);
  assert.match(hook, /const signed = await wallet\.signPsbt\(q\.psbtHex, \{ inputIndexes: q\.inputIndexes, address, replaces: sendVersions\(c\) \}\);/, "a Speed up names every version");
  assert.match(hook, /expectPsbtPayload\(q\.psbtHex, \{ op: "SEND", ticker: c\.ticker, amount: c\.amount, lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: \{ self: address, to: c\.toAddress \|\| address \} \}\);/);
  assert.match(code(src("components/SellPanel.jsx")), /<SpeedUpSend send=\{sendFlow\} fees=\{fees\.data\} note=\{chain\.kind === "cancel" \? "Until it confirms, anyone who saved the listing can still fill it with a higher-fee transaction\." : null\} \/>/);
  assert.match(code(src("pages/PortfolioPage.jsx")), /<SpeedUpSend send=\{sendFlow\} fees=\{fees\?\.data\} note="Until it confirms, anyone who saved the listing can still fill it with a higher-fee transaction\." \/>/);
  // A withdrawal's replacement: the same builder, the same rule.
  const withdraw = build(ADDR, 2);
  const wq = buildSpeedUpPsbt({ psbtHex: withdraw.psbtHex, changeVout: withdraw.changeVout, feeRateSatVb: 10, incrementalRelayFee: 1 });
  assert.ok(wq.feeSats >= psbtFeeSats(withdraw.psbtHex) + Math.ceil(psbtVsize(wq.psbtHex)));
  assert.deepEqual(expectPsbtPayload(wq.psbtHex, { op: "SEND", ticker: "LUCKY", amount: 300, layout: { self: ADDR, to: ADDR } }), { op: "SEND", ticker: "LUCKY", amount: 300 });
  console.log("withdrawals and splits: no PSBT in their records, the earlier record dropped after a Speed up, the same control");
}
console.log("transferspeedup: all checks passed");
