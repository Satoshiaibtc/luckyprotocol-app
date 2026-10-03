// A MINE waiting for a block can be sped up, and the console never loses
// the version a miner confirms. Plain Node, no framework:
//
//   1. a real Speed up of a MINE: the same inputs, the same outputs and the
//      same MINE payload, a higher fee taken from the change;
//   2. the pending item keeps what a Speed up rebuilds from, also through
//      the broadcast record (a reload), and says when it cannot;
//   3. after a Speed up every version is asked about: a confirmed earlier
//      version becomes the MINE, one still in a mempool keeps it pending;
//   4. the status line only promises a next MINE the wallet can pay for.
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { buildMinePsbt, buildSpeedUpPsbt, expectPsbtPayload, psbtFeeSats } from "../src/lib/psbt.js";
import { MOCK_WALLET } from "../src/lib/mock.js";
import {
  applyMineStatus,
  mineSpeedUpState,
  mineVersions,
  newPendingMine,
  pendingMineRow,
  pickMineVersion,
  resumeMinePendings,
  switchMineVersion,
} from "../src/lib/minePending.js";
import { createTxRecordStore } from "../src/lib/txrecords.js";
import { waitingMineText } from "../src/lib/statusText.js";
import { spareFeeInputs } from "../src/hooks/useMine.js";

const TX = (c) => c.repeat(64);
const parse = (psbtHex) => btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });
const ADDR = MOCK_WALLET.address;

// ---- 1. a real Speed up of a MINE ------------------------------------------------------------------
const utxos = [{ txid: TX("1"), vout: 0, sats: 80_000 }];
const built = buildMinePsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints: [], feeRateSatVb: 2, ticker: "LUCKY" });
{
  assert.equal(built.changeVout, 3, "a MINE's change is vout3");
  const q = buildSpeedUpPsbt({ psbtHex: built.psbtHex, changeVout: built.changeVout, feeRateSatVb: 12 });
  assert.deepEqual(expectPsbtPayload(q.psbtHex, { op: "MINE", ticker: "LUCKY" }), { op: "MINE", ticker: "LUCKY" }, "the same MINE payload");
  const a = parse(built.psbtHex);
  const b = parse(q.psbtHex);
  assert.equal(b.inputsLength, a.inputsLength);
  for (let i = 0; i < a.inputsLength; i++) {
    assert.equal(hex.encode(b.getInput(i).txid), hex.encode(a.getInput(i).txid), "the same inputs");
    assert.equal(b.getInput(i).sequence, a.getInput(i).sequence);
  }
  for (let i = 0; i < 3; i++) {
    assert.equal(hex.encode(b.getOutput(i).script), hex.encode(a.getOutput(i).script), `vout${i} unchanged`);
    assert.equal(b.getOutput(i).amount, a.getOutput(i).amount);
  }
  assert.equal(b.lockTime, a.lockTime);
  assert.ok(psbtFeeSats(q.psbtHex) > psbtFeeSats(built.psbtHex), "it pays more");
  assert.equal(Number(a.getOutput(3).amount) - Number(b.getOutput(3).amount), q.feeSats - q.oldFeeSats, "the extra fee comes from the change");
  console.log("mine speed up: same inputs, outputs and payload; the extra fee from the change");
}

// ---- 2. the item keeps what a Speed up needs ---------------------------------------------------------
{
  const item = newPendingMine({ txid: TX("a"), ticker: "LUCKY", broadcastAt: 1_000, psbt: built.psbtHex, changeVout: built.changeVout });
  assert.equal(mineSpeedUpState(item), "yes");
  assert.equal(mineSpeedUpState({ ...item, changeVout: null }), "no-change", "no change output: says so");
  assert.equal(mineSpeedUpState({ ...item, psbt: null }), "no", "nothing to rebuild from");
  assert.equal(mineSpeedUpState({ ...item, phase: "confirmed" }), "no");
  // Through the broadcast record: a reload resumes it with its PSBT and the versions it replaced.
  const mem = new Map();
  const store = createTxRecordStore({ storage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) }, now: () => 5_000 });
  store.add(ADDR, { txid: TX("b"), kind: "mine", ticker: "LUCKY", inputs: [{ txid: TX("1"), vout: 0 }], psbt: built.psbtHex, changeVout: 3, replaces: [TX("a")] });
  const [rec] = store.list(ADDR);
  assert.deepEqual([rec.psbt, rec.changeVout, rec.replaces], [built.psbtHex, 3, [TX("a")]]);
  const [resumed] = resumeMinePendings(store.list(ADDR), "LUCKY");
  assert.deepEqual([resumed.txid, resumed.psbt, resumed.changeVout, resumed.replaces], [TX("b"), built.psbtHex, 3, [TX("a")]]);
  assert.equal(mineSpeedUpState(resumed), "yes", "a resumed MINE can still be sped up");
  // A malformed PSBT or change index is not kept.
  store.add(ADDR, { txid: TX("c"), kind: "mine", ticker: "LUCKY", inputs: [], psbt: "zz", changeVout: -1 });
  const bad = store.list(ADDR).find((r) => r.txid === TX("c"));
  assert.deepEqual([bad.psbt, bad.changeVout], [null, null]);
  console.log("mine speed up: the PSBT and change output ride with the item and its record");
}

// ---- 3. every version is asked about ---------------------------------------------------------------
{
  const sped = { ...newPendingMine({ txid: TX("b"), ticker: "LUCKY", broadcastAt: 1_000, psbt: built.psbtHex, changeVout: 3, replaces: [TX("a")] }) };
  assert.deepEqual(mineVersions(sped), [TX("b"), TX("a")], "the current version first");
  assert.match(pendingMineRow(sped, "LUCKY").text, /sped up \(an earlier version may still confirm instead\)/);
  const unknown = { confirmed: false, seen: false };
  const inMempool = { confirmed: false, seen: true };
  const confirmed = { confirmed: true, seen: true, block_height: 969_896, block_hash: `${"0".repeat(63)}f`, block_time: 1 };
  // The earlier version confirmed: it is the MINE now.
  const pick = pickMineVersion(sped, [
    { txid: TX("b"), status: unknown },
    { txid: TX("a"), status: confirmed },
  ]);
  assert.equal(pick.txid, TX("a"));
  const switched = switchMineVersion(sped, pick.txid);
  assert.deepEqual([switched.txid, switched.replaces, switched.psbt], [TX("a"), [TX("b")], null]);
  const done = applyMineStatus(switched, pick.status, 2_000, 600_000);
  assert.deepEqual([done.phase, done.txid, done.blockHeight], ["confirmed", TX("a"), 969_896], "confirmed in the earlier version's block");
  // Only the earlier version is in a mempool: still pending, the drop clock restarts.
  const seen = pickMineVersion(sped, [
    { txid: TX("b"), status: unknown },
    { txid: TX("a"), status: inMempool },
  ]);
  assert.equal(seen.txid, TX("b"), "the item keeps following the faster version");
  const still = applyMineStatus({ ...sped, unseenSince: 0 }, seen.status, 10_000_000, 600_000);
  assert.equal(still.phase, "pending", "not given up while any version may confirm");
  // No version known anywhere, for longer than the grace: dropped.
  const gone = pickMineVersion(sped, [
    { txid: TX("b"), status: unknown },
    { txid: TX("a"), status: unknown },
  ]);
  assert.equal(applyMineStatus({ ...sped, unseenSince: 0 }, gone.status, 10_000_000, 600_000).phase, "dropped");
  assert.equal(switchMineVersion(sped, TX("b")), sped, "the same version: unchanged");
  console.log("mine speed up: every version is asked about; the one a block confirms is the MINE");
}

// ---- 4. the status line promises only what the wallet can pay ------------------------------------------
{
  assert.match(waitingMineText(1, 0), /The next one can start once it confirms — its change is this wallet's only BTC left to spend/);
  assert.match(waitingMineText(2, 0), /once one of them confirms/);
  assert.match(waitingMineText(1, 3), /You can start another one now/);
  assert.match(waitingMineText(1, null), /if this wallet has other confirmed BTC/);
  assert.ok(!/it uses different inputs/.test(waitingMineText(1, null)), "no promise without knowing the inputs");
  // Spare inputs: not the ones just spent, not token carriers, not below the floor, not uneconomic.
  const rows = [
    { txid: TX("1"), vout: 0, sats: 80_000 },
    { txid: TX("2"), vout: 0, sats: 50_000 },
    { txid: TX("3"), vout: 0, sats: 546 },
    { txid: TX("4"), vout: 0, sats: 9_000 },
    { txid: TX("5"), vout: 0, sats: 700 },
  ];
  assert.equal(spareFeeInputs({ utxos: rows, tokenOutpoints: [], used: [{ txid: TX("1"), vout: 0 }], assetSafe: false, address: ADDR, feeRate: 20 }), 1, "unsafe list: only above 10,000 sats");
  assert.equal(spareFeeInputs({ utxos: rows, tokenOutpoints: [], used: [{ txid: TX("1"), vout: 0 }], assetSafe: true, address: ADDR, feeRate: 20 }), 2, "asset-safe: 50,000 and 9,000 (700 costs more than it brings)");
  assert.equal(spareFeeInputs({ utxos: rows.slice(0, 1), tokenOutpoints: [], used: [{ txid: TX("1"), vout: 0 }], assetSafe: true, address: ADDR, feeRate: 5 }), 0, "the one input is spent");
  console.log("mine status: the next MINE is promised only when the wallet has other BTC for it");
}



// ---- a reload after a Speed up whose broadcast was not confirmed: one item, not two ----------------
{
  const recs = [
    { txid: TX("a"), kind: "mine", ticker: "LUCKY", inputs: [], at: 1_000, confirmed: false },
    { txid: TX("b"), kind: "mine", ticker: "LUCKY", inputs: [], at: 2_000, confirmed: false, replaces: [TX("a")], psbt: null, changeVout: null },
  ];
  const r = resumeMinePendings(recs, "LUCKY");
  assert.deepEqual(r.map((x) => [x.txid, x.replaces]), [[TX("b"), [TX("a")]]], "the faster version's item follows both");
  console.log("mine speed up: a reload resumes one item for a MINE and its faster version");
}
console.log("minespeedup: all checks passed");
