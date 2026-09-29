// The Create page's DEPLOY, pure parts (src/lib/createFlow.js): which txids
// are the user's DEPLOY, the registry's verdict on them, a missed block, a
// DEPLOY that left every mempool, the Speed up headroom of a build, the
// LEDs, and the settling notes that follow a result until final. Plain
// Node, no framework.
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
  SETTLING_MAX,
  SETTLING_TTL_MS,
  SPEEDUP_HEADROOM_MULTIPLE,
  claimReview,
  clearUnusedDeployKeys,
  createSettlingStore,
  deployHeadroom,
  deployLeds,
  deployMissedBlock,
  deployReleased,
  deployVerdict,
  deployVersions,
  followSeenVersion,
  headroomText,
  isOwnVerdict,
  normalizeSettlingNote,
  ownDeployText,
  resolveVersions,
  rowConfirmations,
  rowIsFinal,
  settlingKey,
  settlingVerdict,
  takenWhilePending,
  txidOfRaw,
} from "../src/lib/createFlow.js";
import { resumeDeployState } from "../src/lib/deploylog.js";
import { DEPLOY_CHANGE_VOUT, buildDeployPsbt, buildSpeedUpPsbt, extractRawTxHex, speedUpCeilingRate } from "../src/lib/psbt.js";
import { DROP_GRACE_MS, createTxRecordStore } from "../src/lib/txrecords.js";
import { ACTIVATION_HEIGHT } from "../src/lib/payloads.js";
import { FINAL_DEPTH } from "../src/lib/finality.js";

const TX = (c) => c.repeat(64);
const ADDR = "bc1pqx7v9c2k4m8n3r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0z1x2c3v4b5n62s";
const OTHER_ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const H = ACTIVATION_HEIGHT + 100;
const T0 = 1_000_000;

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

// ---- the versions of a DEPLOY ---------------------------------------------------------------------
{
  assert.deepEqual(deployVersions({ txid: TX("A"), replaces: [TX("b"), TX("a"), "junk"] }), [TX("a"), TX("b")], "lower-cased, well-formed, no repeats");
  assert.deepEqual(deployVersions({ txid: TX("c"), versions: [TX("c"), TX("b")] }), [TX("c"), TX("b")], "a flow's versions (newest first) are read too");
  assert.deepEqual(deployVersions(null), []);
  const st = (confirmed, seen, h = null) => ({ confirmed, seen, in_mempool: seen && !confirmed, block_height: h });
  assert.deepEqual(resolveVersions([{ txid: TX("c"), status: st(false, false) }, { txid: TX("a"), status: st(true, true, H) }]), { kind: "confirmed", txid: TX("a"), height: H }, "the ORIGINAL confirmed after a Speed up");
  assert.deepEqual(resolveVersions([{ txid: TX("c"), status: st(false, false) }, { txid: TX("b"), status: st(false, true) }]), { kind: "seen", txid: TX("b") });
  assert.deepEqual(resolveVersions([{ txid: TX("c"), status: st(false, false) }, { txid: TX("b"), status: null }]), { kind: "unknown" }, "one version could not be asked");
  assert.deepEqual(resolveVersions([{ txid: TX("c"), status: st(false, false) }]), { kind: "none" });
  assert.deepEqual(resolveVersions([]), { kind: "unknown" }, "no answer is not an answer");
  // Right after a Speed up to C the node still holds the replaced B: the
  // page keeps following C until C has been unseen for the grace period.
  const v = resolveVersions([{ txid: TX("c"), status: st(false, false) }, { txid: TX("b"), status: st(false, true) }]);
  assert.equal(followSeenVersion(v.txid, TX("c"), false), false, "the new version is not given up while it may still be on its way");
  assert.equal(followSeenVersion(v.txid, TX("c"), true), true, "the new version unseen for the grace period: follow the one the node holds");
  assert.equal(followSeenVersion(TX("c"), TX("c"), false), true, "the tracked version seen");
  console.log("createflow: every version of a DEPLOY, and what /tx-status says about them together");
}

// ---- the registry's verdict --------------------------------------------------------------------------
{
  const versions = [TX("c"), TX("a")];
  assert.equal(deployVerdict({ deploy_txid: TX("a"), deployer: ADDR }, versions, ADDR), "registered", "registered through the second version's txid (the original confirmed)");
  assert.equal(deployVerdict({ deploy_txid: TX("C").toUpperCase(), deployer: "" }, versions, ADDR), "registered", "txids compare case-insensitively; an empty deployer changes nothing");
  assert.equal(deployVerdict({ deploy_txid: TX("9"), deployer: ADDR }, versions, ADDR), "registered-own", "another txid, but this address's (the wallet's own speed-up, another device)");
  assert.equal(deployVerdict({ deploy_txid: TX("9"), deployer: OTHER_ADDR }, versions, ADDR), "taken");
  assert.equal(deployVerdict({ deploy_txid: TX("9"), deployer: "" }, versions, ""), "taken", "an empty address never matches an empty deployer");
  assert.equal(deployVerdict(null, versions, ADDR), "unindexed");
  assert.equal(isOwnVerdict("registered") && isOwnVerdict("registered-own") && !isOwnVerdict("taken") && !isOwnVerdict("unindexed"), true);
  assert.equal(takenWhilePending({ row: { deploy_txid: TX("9"), deployer: OTHER_ADDR }, versions, address: ADDR }), true, "taken while pending");
  assert.equal(takenWhilePending({ row: { deploy_txid: TX("9"), deployer: ADDR }, versions, address: ADDR }), false, "never for the user's own deployer");
  assert.equal(takenWhilePending({ row: { deploy_txid: TX("a") }, versions, address: ADDR }), false, "never for one of the versions");
  assert.equal(takenWhilePending({ row: null, versions, address: ADDR }), false);
  assert.equal(rowConfirmations({ deploy_block: H }, H + 1), 2);
  assert.equal(rowIsFinal({ deploy_block: H }, H + FINAL_DEPTH - 2), false);
  assert.equal(rowIsFinal({ deploy_block: H }, H + FINAL_DEPTH - 1), true);
  assert.equal(rowIsFinal({ deploy_block: null }, H + 100), false, "an unknown depth is not final");
  console.log("createflow: registered (any version) / registered-own / taken / unindexed; taken-while-pending never for the user's own row");
}

// ---- a pending DEPLOY: missed block, released ------------------------------------------------------------
{
  const sent = { sentTip: H, height: null, unseen: false };
  assert.equal(deployMissedBlock(sent, H), false, "no block since it was sent");
  assert.equal(deployMissedBlock(sent, H + 1), true, "a block came without it");
  assert.equal(deployMissedBlock({ ...sent, height: H + 1 }, H + 2), false, "confirmed");
  assert.equal(deployMissedBlock({ ...sent, sentTip: null }, H + 2), false, "unknown send tip");
  assert.equal(deployMissedBlock({ ...sent, unseen: true }, H + 2), false, "unseen is said otherwise");
  assert.equal(deployMissedBlock(sent, null), false);

  const seen = (txid) => ({ txid, status: { confirmed: false, seen: true, in_mempool: true, block_height: null } });
  const none = (txid) => ({ txid, status: { confirmed: false, seen: false, in_mempool: false, block_height: null } });
  const later = T0 + DROP_GRACE_MS + 1;
  // (a) after a Speed up the replaced version always leaves the mempool: that is no release
  assert.equal(deployReleased([seen(TX("c")), none(TX("a"))], { unseenSince: T0, now: later, trustUnseen: true }), false, "the replaced version's drop does not end the flow");
  // (b) every version unknown to the node for longer than DROP_GRACE_MS
  assert.equal(deployReleased([none(TX("c")), none(TX("a"))], { unseenSince: T0, now: later, trustUnseen: true }), true);
  assert.equal(deployReleased([none(TX("c")), none(TX("a"))], { unseenSince: T0, now: later, trustUnseen: false }), false, "not while the node's 'unknown' means nothing");
  assert.equal(deployReleased([none(TX("c")), none(TX("a"))], { unseenSince: T0, now: T0 + DROP_GRACE_MS, trustUnseen: true }), false, "not before the grace period is over");
  assert.equal(deployReleased([none(TX("c")), { txid: TX("a"), status: null }], { unseenSince: T0, now: later, trustUnseen: true }), false, "not while a version could not be asked");
  assert.equal(deployReleased([none(TX("c"))], { unseenSince: null, now: later, trustUnseen: true }), false, "the clock has not started");
  console.log("createflow: missed block; released only when EVERY version has been unknown for the grace period");
}

// ---- the Speed up headroom of a build ------------------------------------------------------------------------
{
  const XONLY = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
  const pub = `02${XONLY}`;
  const address = btc.p2tr(hex.decode(XONLY), undefined, btc.NETWORK).address;
  const T = (i) => "ab".repeat(31) + String(i).padStart(2, "0");
  const utxos = [
    { txid: T(40), vout: 0, sats: 15_000 },
    { txid: T(41), vout: 0, sats: 300_000 },
  ];
  const rate = 30;
  const big = buildDeployPsbt({ address, pubkeyHex: pub, utxos, tokenOutpoints: [], feeRateSatVb: rate, ticker: "LUCKY", selectionOrder: "largest" });
  assert.equal(big.changeVout, DEPLOY_CHANGE_VOUT);
  assert.equal(deployHeadroom(big, rate), null, "largest-first leaves room for 3× the rate: no warning");
  const small = buildDeployPsbt({ address, pubkeyHex: pub, utxos, tokenOutpoints: [], feeRateSatVb: rate, ticker: "LUCKY", selectionOrder: "smallest" });
  const low = deployHeadroom(small, rate);
  assert.equal(low.kind, "low", "smallest-first leaves a change that cannot pay 3× the rate");
  assert.equal(low.ceiling, speedUpCeilingRate(small.psbtHex, small.changeVout));
  assert.ok(low.ceiling < SPEEDUP_HEADROOM_MULTIPLE * rate && low.ceiling >= rate, `ceiling ${low.ceiling}`);
  assert.equal(low.changeSats, small.changeSats);
  assert.throws(() => buildSpeedUpPsbt({ psbtHex: small.psbtHex, changeVout: small.changeVout, feeRateSatVb: SPEEDUP_HEADROOM_MULTIPLE * rate }), (e) => e.code === "speedup-change-too-small", "…as the Speed up itself would find");
  assert.match(headroomText(low, "LUCKY"), /^This DEPLOY can be sped up to at most [\d.]+ sat\/vB, because its change is only [\d,]+ sats\. If another DEPLOY of LUCKY pays more, you may not be able to outbid it\./);
  assert.deepEqual(deployHeadroom({ ...big, changeOmitted: true, changeVout: null }, rate), { kind: "no-change" });
  assert.match(headroomText({ kind: "no-change" }, "LUCKY"), /^This DEPLOY has no change output, so it cannot be sped up later\./);
  assert.equal(headroomText(null, "LUCKY"), null);
  assert.equal(deployHeadroom(null, rate), null);
  console.log("createflow: the Speed up headroom of a build (largest-first: none needed; smallest-first: warned; no change: warned)");
}

// ---- LEDs: Sign · Broadcast · Confirm · Registered ----------------------------------------------------------------
{
  assert.deepEqual(deployLeds({ phase: "idle" }), ["idle", "idle", "idle", "idle"]);
  assert.deepEqual(deployLeds({ phase: "review" }), ["busy", "idle", "idle", "idle"]);
  assert.deepEqual(deployLeds({ phase: "signing" }), ["busy", "idle", "idle", "idle"]);
  assert.deepEqual(deployLeds({ phase: "broadcasting" }), ["ok", "busy", "idle", "idle"]);
  assert.deepEqual(deployLeds({ phase: "pending" }), ["ok", "ok", "busy", "idle"]);
  assert.deepEqual(deployLeds({ phase: "pending", unsent: true }), ["ok", "busy", "busy", "idle"]);
  assert.deepEqual(deployLeds({ phase: "pending", takenRow: { deploy_txid: TX("9") } }), ["ok", "ok", "busy", "err"], "taken while pending");
  assert.deepEqual(deployLeds({ phase: "confirmed" }), ["ok", "ok", "ok", "busy"]);
  assert.deepEqual(deployLeds({ phase: "done", verdict: "registered" }), ["ok", "ok", "ok", "ok"]);
  assert.deepEqual(deployLeds({ phase: "done", verdict: "registered-own" }), ["ok", "ok", "ok", "ok"]);
  assert.deepEqual(deployLeds({ phase: "done", verdict: "taken" }), ["ok", "ok", "ok", "err"]);
  assert.deepEqual(deployLeds({ phase: "done", verdict: "unindexed" }), ["ok", "ok", "ok", "busy"]);
  assert.deepEqual(deployLeds({ phase: "released" }), ["ok", "ok", "err", "idle"]);
  assert.deepEqual(deployLeds({ phase: "error", errorAt: "signing" }), ["err", "idle", "idle", "idle"]);
  assert.deepEqual(deployLeds({ phase: "error", errorAt: "broadcasting" }), ["ok", "err", "idle", "idle"]);
  console.log("createflow: the four LEDs follow the DEPLOY");
}

// ---- settling notes ---------------------------------------------------------------------------------------------
{
  const storage = memStorage();
  let now = T0;
  const st = createSettlingStore({ storage, now: () => now });
  assert.equal(settlingKey(" BC1QX "), "lp.create.settling.bc1qx", "keyed per address, lower-cased");
  assert.equal(settlingKey(""), "lp.create.settling.*");
  const [note] = st.add(ADDR, { ticker: "NEW", txid: TX("c"), versions: [TX("c"), TX("a")], height: H, origin: "registered" });
  assert.deepEqual([note.ticker, note.txid, note.versions, note.height, note.verdict, note.changes, note.origin], ["NEW", TX("c"), [TX("c"), TX("a")], H, "provisional", 0, "registered"]);
  assert.ok(storage.m.has(settlingKey(ADDR)));
  assert.equal(settlingVerdict(note, undefined, H + 2), "unknown");
  assert.equal(settlingVerdict(note, { deploy_txid: TX("c"), deploy_block: H }, H + 2), "provisional");
  assert.equal(settlingVerdict(note, { deploy_txid: TX("a"), deploy_block: H }, H + 2), "provisional", "any version of the DEPLOY is ours");
  assert.equal(settlingVerdict(note, { deploy_txid: TX("c"), deploy_block: H }, H + FINAL_DEPTH - 1), "final");
  assert.equal(settlingVerdict(note, { deploy_txid: TX("8"), deploy_block: H + 1, deployer: OTHER_ADDR }, H + 2, { address: ADDR }), "changed-taken", "a reorganization put another DEPLOY first");
  assert.equal(settlingVerdict(note, { deploy_txid: TX("8"), deploy_block: H + 1, deployer: ADDR }, H + 2, { address: ADDR }), "provisional", "a row of the user's deployer is ours");
  assert.equal(settlingVerdict(note, { deploy_txid: TX("8"), deploy_block: H + 1, deployer: OTHER_ADDR }, H + FINAL_DEPTH + 1, { address: ADDR }), "final-taken", "…and another DEPLOY's row, once final, ends the note");
  assert.equal(settlingVerdict(note, null, H + 2), "changed-missing", "the DEPLOY left its block");
  assert.equal(settlingVerdict(note, null, H + 2, { applied: H - 1 }), "unknown", "the indexer has not applied the note's block (a restart, a cold scan)");
  assert.equal(settlingVerdict(note, null, H + 2, { applied: H + 2, rebuilding: true }), "unknown", "a rebuild is not a reorganization");
  // a result of another DEPLOY holding the name (a taken result)
  const taken = normalizeSettlingNote({ ticker: "NEW", txid: TX("d"), versions: [TX("d")], height: H, origin: "taken", otherTxid: TX("8") });
  assert.equal(taken.verdict, "changed-taken");
  assert.equal(settlingVerdict(taken, { deploy_txid: TX("8"), deploy_block: H, deployer: OTHER_ADDR }, H + 2, { address: ADDR }), "changed-taken");
  assert.equal(settlingVerdict(taken, { deploy_txid: TX("d"), deploy_block: H + 1 }, H + 3, { address: ADDR }), "provisional", "a reorganization made ours the first");
  assert.equal(settlingVerdict(taken, null, H + 3), "unknown", "a taken note never reads as 'our DEPLOY left its block'");
  // (c) a released DEPLOY: no row stays unknown (until the TTL); one of its versions registered reads as ours
  const released = normalizeSettlingNote({ ticker: "NEW", txid: TX("e"), versions: [TX("e"), TX("f")], height: null, origin: "released" });
  assert.deepEqual([released.verdict, released.height], ["released", null]);
  assert.equal(settlingVerdict(released, null, H + 2), "unknown");
  assert.equal(settlingVerdict(released, { deploy_txid: TX("f"), deploy_block: H + 1 }, H + 2), "provisional", "a released DEPLOY that confirmed after all is registered to the user");
  assert.equal(settlingVerdict(released, { deploy_txid: TX("8"), deploy_block: H + 1, deployer: OTHER_ADDR }, H + 2, { address: ADDR }), "changed-taken");
  // store rules
  assert.equal(st.update(ADDR, TX("c"), (n) => ({ ...n, verdict: "changed-missing", changes: 1 }))[0].verdict, "changed-missing");
  assert.equal(st.list(ADDR)[0].changes, 1);
  assert.equal(st.add(ADDR, { ticker: "NEW", txid: TX("a"), versions: [TX("a")], height: H, origin: "registered" }).length, 1, "a note of the same DEPLOY (a shared version) is replaced");
  for (let i = 0; i < SETTLING_MAX + 2; i++) st.add(ADDR, { ticker: `T${i}`, txid: String(i).repeat(64), height: H, origin: "registered" });
  assert.equal(st.list(ADDR).length, SETTLING_MAX, "at most SETTLING_MAX notes, the oldest go first");
  assert.equal(st.list(ADDR)[0].ticker, "T2");
  now += SETTLING_TTL_MS + 1;
  assert.equal(st.list(ADDR).length, 0, "dropped after a day whatever it says");
  now = T0;
  assert.equal(st.add(OTHER_ADDR, { ticker: "NEW", txid: TX("c"), height: H, origin: "registered" }).length, 1, "per address");
  assert.equal(st.remove(OTHER_ADDR, TX("c")).length, 0);
  assert.equal(normalizeSettlingNote({ ticker: "bad", txid: TX("c") }), null);
  assert.equal(normalizeSettlingNote({ ticker: "NEW", txid: "zz" }), null);
  storage.setItem(settlingKey(ADDR), "{not json");
  assert.deepEqual(st.list(ADDR), [], "garbage reads as no notes");
  // Notes under another key are never read.
  const other = memStorage();
  other.setItem("lp.deploy.settling." + ADDR, JSON.stringify([{ ticker: "NEW", txid: TX("c"), height: H }]));
  assert.deepEqual(createSettlingStore({ storage: other }).list(ADDR), []);
  // A storage that throws falls back to memory.
  const broken = createSettlingStore({
    storage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    },
  });
  assert.equal(broken.add(ADDR, { ticker: "NEW", txid: TX("c"), height: H }).length, 1);
  assert.equal(broken.list(ADDR).length, 1);
  console.log("createflow: settling notes (key, TTL, max 5, changed-taken / changed-missing / final, released, the user's deployer is ours)");
}

// ---- clearUnusedDeployKeys removes unread keys; a deploy record without psbt resumes without Speed up ----------------
{
  const storage = memStorage();
  const lower = ADDR.toLowerCase();
  for (const k of [`lp.deploy.${lower}`, `lp.deploy.settling.${lower}`, "lp.deploy.*", "lp.deploy.settling.*", `lp.txrec.${lower}`, `lp.create.settling.${lower}`]) storage.setItem(k, "x");
  clearUnusedDeployKeys(storage, ADDR.toUpperCase());
  assert.deepEqual([...storage.m.keys()].sort(), [`lp.create.settling.${lower}`, `lp.txrec.${lower}`], "only the unread keys go");
  clearUnusedDeployKeys(
    {
      removeItem: () => {
        throw new Error("blocked");
      },
    },
    ADDR,
  );
  clearUnusedDeployKeys(null, ADDR);
  clearUnusedDeployKeys(undefined, null);
  // A DEPLOY record without its PSBT resumes, with no Speed up.
  const recs = createTxRecordStore({ storage: memStorage(), now: () => T0 });
  recs.add(ADDR, { txid: TX("c"), kind: "deploy", ticker: "NEW", inputs: [] });
  const r = resumeDeployState(recs.list(ADDR));
  assert.deepEqual([r.phase, r.ticker, r.txid, r.psbt, r.changeVout, r.versions], ["pending", "NEW", TX("c"), null, null, [TX("c")]]);
  const withPsbt = createTxRecordStore({ storage: memStorage(), now: () => T0 });
  withPsbt.add(ADDR, { txid: TX("c"), kind: "deploy", ticker: "NEW", inputs: [], psbt: "70736274ff", changeVout: DEPLOY_CHANGE_VOUT, replaces: [TX("a")] });
  const r2 = resumeDeployState(withPsbt.list(ADDR));
  assert.deepEqual([r2.psbt, r2.changeVout, r2.versions], ["70736274ff", DEPLOY_CHANGE_VOUT, [TX("c"), TX("a")]], "…and with its PSBT, with Speed up and every version");
  console.log("createflow: clearUnusedDeployKeys removes unread keys; a deploy record without psbt resumes without Speed up");
}

// ---- texts and helpers -------------------------------------------------------------------------------------------
{
  assert.match(ownDeployText("NEW", { txid: TX("c"), state: "pending" }), /^You already have a pending DEPLOY of NEW \(tx cccccccccccc…\)\. It claims the name if it confirms first — creating again would pay the fees twice\.$/);
  assert.match(ownDeployText("NEW", { txid: TX("c"), state: "confirmed" }), /has confirmed — waiting for the indexer to list it\.$/);
  assert.match(ownDeployText("NEW", { txid: TX("c"), state: "unknown" }), /stays paused until it can be checked\.$/);
  // txidOfRaw: the txid of a signed raw transaction.
  const XONLY = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: TX("1"), index: 0, witnessUtxo: { script: btc.p2tr(hex.decode(XONLY), undefined, btc.NETWORK).script, amount: 10_000n } });
  tx.addOutputAddress(OTHER_ADDR, 9_000n, btc.NETWORK);
  tx.updateInput(0, { finalScriptWitness: [new Uint8Array(64)] });
  const raw = extractRawTxHex(hex.encode(tx.toPSBT()));
  assert.equal(txidOfRaw(raw), tx.id);
  console.log("createflow: own-DEPLOY texts; the txid of a signed transaction");
}

// ---- signing the reviewed DEPLOY: claimed once -------------------------------------------------------------------
{
  const ctx = { ticker: "NEW", startedAt: T0 };
  const ref = { current: ctx };
  const review = { phase: "review", ticker: "NEW", startedAt: T0 };
  assert.equal(claimReview(ref, review), ctx, "the first click takes the reviewed DEPLOY");
  assert.equal(ref.current, null, "…and empties the ref before anything is awaited");
  assert.equal(claimReview(ref, review), null, "a second click (a double click) finds nothing to sign");
  assert.equal(claimReview({ current: ctx }, { ...review, startedAt: T0 + 1 }), null, "another review's context is not signed");
  assert.equal(claimReview({ current: ctx }, { phase: "idle" }), null, "a cancelled review is not signed");
  const kept = { current: ctx };
  claimReview(kept, { phase: "idle" });
  assert.equal(kept.current, ctx, "a refused claim leaves the ref as it was");
  console.log("createflow: the reviewed DEPLOY is claimed once, before the name check is awaited");
}

console.log("createflow: all checks passed");
