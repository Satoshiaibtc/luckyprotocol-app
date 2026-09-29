// Pure-part tests for the write-flow safety nets: the indexer-lag gate
// (src/lib/sync.js), the broadcast records (src/lib/txrecords.js),
// wallet-vs-node error tagging and the "did the failed broadcast land?"
// check (src/lib/wallet.js), the
// mock indexer's §4.1 routing and §7.5 settlement (src/lib/mockRouting.js),
// and the mock's held-DEPLOY knob. Plain Node, no framework.
import assert from "node:assert/strict";
import { syncPauseText, syncStateOf } from "../src/lib/sync.js";
import {
  CONFIRMED_RECHECK_MS,
  DROP_GRACE_MS,
  FINAL_GUARD_MS,
  TXREC_MAX,
  TXREC_TTL_MS,
  classifyTxStatus,
  createTxRecordStore,
  parseTxRecords,
  pendingSpentOutpoints,
  recordIsFinal,
  refreshTxRecords,
  txRecordKey,
} from "../src/lib/txrecords.js";
import { LANDED_CHECK_WAITS_MS, landedOrThrow, nodeRefused, walletError } from "../src/lib/wallet.js";
import { friendlyError } from "../src/hooks/useWallet.js";
import { defaultOutIdx, deployerOf, inputSighash, isFillOf, listedScriptType, listingSignedInputs, routeDecision, settleListingSpend } from "../src/lib/mockRouting.js";
import { ACTIVATION_HEIGHT, PROJECT_FEE_ADDRESS } from "../src/lib/payloads.js";

const TX = (c) => c.repeat(64);
const ADDR = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";

// ---- the lag gate ------------------------------------------------------------------------------
{
  assert.deepEqual(syncStateOf({ indexed_height: 969_610, tip_height: 969_610, stalled: false }), {
    indexed: 969_610,
    tip: 969_610,
    lag: 0,
    stalled: false,
    rebuilding: false,
    noPeers: false,
    networkLag: 0,
    synced: true,
    trustUnseen: true,
  });
  const cold = syncStateOf({ indexed_height: 969_600, tip_height: 970_112, stalled: false });
  assert.equal(cold.synced, false, "a cold scan is not synced even while it makes progress");
  assert.equal(cold.lag, 512);
  assert.match(syncPauseText(cold, "creating PEPE"), /512 blocks behind the chain tip \(#969,600 of #970,112\), so creating PEPE would rely on stale state/);
  assert.equal(syncStateOf({ indexed_height: 5, tip_height: 5, stalled: true }).synced, false, "stalled is never synced");
  assert.equal(syncStateOf(null).synced, false, "unknown heights fail closed");
  assert.equal(syncStateOf({ indexed_height: null, tip_height: 7 }).lag, null);
  assert.match(syncPauseText(syncStateOf(null), "mining"), /not reported/);
  assert.equal(syncPauseText(syncStateOf({ indexed_height: 1, tip_height: 1 }), "x"), null);
  assert.match(syncPauseText(syncStateOf({ indexed_height: 9, tip_height: 10 }), "mining"), /1 block behind/);
  console.log("sync: synced only when indexed == tip and not stalled; a lag pauses Create and Mine");
}

// ---- broadcast records -------------------------------------------------------------
{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  let now = 1_000_000;
  const store = createTxRecordStore({ storage, now: () => now });
  assert.equal(txRecordKey(" BC1QABC "), "lp.txrec.bc1qabc");
  store.add(ADDR, { txid: TX("a"), kind: "deploy", ticker: "MOON", inputs: [{ txid: TX("1"), vout: 0 }, `${TX("2")}:3`] });
  store.add(ADDR, { txid: TX("b"), kind: "mine", ticker: "MOON", inputs: [{ txid: TX("4"), vout: 1 }] });
  store.add(ADDR, { txid: "nothex", kind: "mine" }); // malformed → ignored
  assert.equal(store.list(ADDR).length, 2);
  assert.deepEqual([...pendingSpentOutpoints(store.list(ADDR))].sort(), [`${TX("1")}:0`, `${TX("2")}:3`, `${TX("4")}:1`]);
  assert.equal(store.list("bc1qother").length, 0, "per address");
  // classify: seen → pending; unseen inside the grace → pending; after → dropped; no answer → unknown
  const rec = store.list(ADDR)[0];
  assert.equal(classifyTxStatus(rec, { confirmed: false, seen: true }, now), "pending");
  assert.equal(classifyTxStatus(rec, { confirmed: false, seen: false }, now + 1_000), "pending", "a just-broadcast tx may not have reached the indexer's node yet");
  assert.equal(classifyTxStatus(rec, { confirmed: false, seen: false }, now + DROP_GRACE_MS + 1), "dropped");
  assert.equal(classifyTxStatus(rec, { confirmed: true, seen: true }, now), "confirmed");
  assert.equal(classifyTxStatus(rec, null, now), "unknown");
  // refresh: the DEPLOY and the MINE confirmed — both kept (marked confirmed, their
  // inputs still guarded until final) until the page that shows their result
  // forgets them ("tracking resumes when you return")
  now += 10_000;
  const answers = { [TX("a")]: { confirmed: true, seen: true, block_height: 969_700 }, [TX("b")]: { confirmed: true, seen: true, block_height: 969_700 } };
  const after = await refreshTxRecords(ADDR, async (t) => answers[t], { store, now: () => now, tip: 969_700 });
  assert.deepEqual(after.map((r) => [r.kind, r.state]), [["deploy", "confirmed"], ["mine", "confirmed"]]);
  assert.ok(store.list(ADDR).every((r) => r.confirmed && r.blockHeight === 969_700), "both marked confirmed in the store, with their block");
  assert.equal(pendingSpentOutpoints(store.list(ADDR)).size, 3, "a confirmed tx keeps its inputs excluded until its block is final");
  // a pending tx whose status cannot be read keeps its inputs excluded (fail closed)
  store.add(ADDR, { txid: TX("c"), kind: "send", ticker: "MOON", inputs: [`${TX("5")}:0`] });
  const unknown = await refreshTxRecords(ADDR, async () => {
    throw new Error("HTTP 502");
  }, { store, now: () => now });
  assert.equal(unknown.find((r) => r.txid === TX("c")).state, "unknown");
  assert.ok(pendingSpentOutpoints(store.list(ADDR)).has(`${TX("5")}:0`));
  // dropped after the grace → forgotten, its inputs spendable again
  now += DROP_GRACE_MS + 1;
  await refreshTxRecords(ADDR, async (t) => (t === TX("c") ? { confirmed: false, seen: false } : answers[t]), { store, now: () => now, trustUnseen: true });
  assert.ok(!store.list(ADDR).some((r) => r.txid === TX("c")), "a dropped tx is forgotten");
  // TTL + cap
  assert.equal(parseTxRecords(JSON.stringify([{ txid: TX("d"), kind: "mine", inputs: [], at: 0 }]), TXREC_TTL_MS + 1).length, 0, "expired after the TTL");
  const many = Array.from({ length: TXREC_MAX + 5 }, (_, i) => ({ txid: i.toString(16).padStart(64, "0"), kind: "other", inputs: [], at: 10 + i }));
  assert.equal(parseTxRecords(JSON.stringify(many), 1_000).length, TXREC_MAX, "newest TXREC_MAX kept");
  assert.deepEqual(parseTxRecords("{not json", 1), []);
  console.log("txrecords: inputs of pending broadcasts are excluded until they are final or drop; DEPLOYs stay remembered by ticker");
}

// ---- finality: a confirmed tx guards its inputs until final; back in the mempool it is pending again ---------------
{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  let now = 5_000_000;
  const store = createTxRecordStore({ storage, now: () => now });
  const IN = `${TX("a")}:0`;
  store.add(ADDR, { txid: TX("1"), kind: "send", ticker: "MOON", inputs: [IN] });
  let answer = { confirmed: true, seen: true, block_height: 969_800 };
  const refresh = (tip) => refreshTxRecords(ADDR, async () => answer, { store, now: () => now, tip, trustUnseen: true });
  await refresh(969_800);
  let r = store.list(ADDR)[0];
  assert.deepEqual([r.confirmed, r.blockHeight, r.confirmedAt], [true, 969_800, now]);
  assert.ok(pendingSpentOutpoints(store.list(ADDR)).has(IN), "1 confirmation: the input stays excluded (a withdrawal cannot be undone by the next MINE)");
  // a chain reorganization puts it back in the mempool (seen at the next re-check)
  answer = { confirmed: false, seen: true, in_mempool: true };
  now += CONFIRMED_RECHECK_MS;
  const back = await refresh(969_801);
  assert.equal(back[0].state, "pending");
  r = store.list(ADDR)[0];
  assert.deepEqual([r.confirmed, r.blockHeight], [false, null], "unconfirmed again");
  assert.ok(pendingSpentOutpoints(store.list(ADDR)).has(IN));
  // confirms again in another block; kept until that block is 6 deep, then forgotten (a send has no result page)
  answer = { confirmed: true, seen: true, block_height: 969_802 };
  await refresh(969_802);
  await refresh(969_806);
  assert.equal(store.list(ADDR).length, 1, "5 confirmations: still guarding");
  await refresh(969_807);
  assert.equal(store.list(ADDR).length, 0, "6 confirmations: final, forgotten");
  // unknown to the indexer while confirmed (it may be mid-reorganization): kept as it is
  store.add(ADDR, { txid: TX("2"), kind: "fill", inputs: [IN] });
  answer = { confirmed: true, seen: true, block_height: 969_900 };
  await refresh(969_900);
  answer = { confirmed: false, seen: false };
  now += CONFIRMED_RECHECK_MS;
  await refresh(969_901);
  assert.equal(store.list(ADDR)[0].confirmed, true, "an unknown answer does not unconfirm");
  // forget: a confirmed record is only marked done — it keeps guarding until final
  store.forget(ADDR, TX("2"));
  assert.deepEqual([store.list(ADDR)[0].done, pendingSpentOutpoints(store.list(ADDR)).has(IN)], [true, true]);
  // no tip: the time guard, from when it was first seen confirmed
  const since = store.list(ADDR)[0].confirmedAt;
  assert.equal(recordIsFinal(store.list(ADDR)[0], null, since + FINAL_GUARD_MS - 1), false);
  assert.equal(recordIsFinal(store.list(ADDR)[0], null, since + FINAL_GUARD_MS), true);
  assert.equal(recordIsFinal(store.list(ADDR)[0], 969_905, now), true, "the depth, when known, decides");
  // an unconfirmed record is deleted by forget
  store.add(ADDR, { txid: TX("3"), kind: "send", inputs: [`${TX("b")}:1`] });
  store.forget(ADDR, TX("3"));
  assert.ok(!store.list(ADDR).some((x) => x.txid === TX("3")));
  // a done MINE is forgotten once final; one not shown yet stays for its result page
  store.add(ADDR, { txid: TX("4"), kind: "mine", ticker: "MOON", inputs: [] });
  store.markConfirmed(ADDR, TX("4"), 969_900);
  await refreshTxRecords(ADDR, async () => ({ confirmed: true, seen: true, block_height: 969_900 }), { store, now: () => now, tip: 969_910 });
  assert.deepEqual(store.list(ADDR).map((x) => x.txid), [TX("4")], "the final done fill is forgotten; the unshown MINE stays");
  console.log("txrecords: confirmed txs guard their inputs until final; a reorganization back to the mempool unconfirms; forget keeps a confirmed guard");
}

// ---- finality: a confirmed record is re-checked at most every CONFIRMED_RECHECK_MS, not on every build ---------------
{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  let now = 7_000_000;
  const store = createTxRecordStore({ storage, now: () => now });
  for (const c of ["1", "2", "3"]) store.add(ADDR, { txid: TX(c), kind: "mine", ticker: "MOON", inputs: [`${TX(c)}:0`] });
  let calls = 0;
  let answer = { confirmed: true, seen: true, block_height: 970_000 };
  const refresh = () =>
    refreshTxRecords(ADDR, async () => {
      calls += 1;
      return answer;
    }, { store, now: () => now, tip: 970_001, trustUnseen: true });
  await refresh();
  assert.equal(calls, 3, "pending records are asked every time");
  calls = 0;
  now += CONFIRMED_RECHECK_MS - 1;
  const quick = await refresh();
  assert.equal(calls, 0, "a build within the window does not ask about confirmed records again");
  assert.ok(quick.every((r) => r.state === "confirmed"));
  assert.equal(pendingSpentOutpoints(store.list(ADDR)).size, 3, "their inputs stay excluded in between");
  now += 1;
  await refresh();
  assert.equal(calls, 3, "after the window each is asked again");
  calls = 0;
  await refresh();
  assert.equal(calls, 0, "a still-confirmed answer is stamped: the next window starts");
  // an answer that could not be read is not stamped — asked again at the next build
  now += CONFIRMED_RECHECK_MS;
  const failing = () =>
    refreshTxRecords(ADDR, async () => {
      calls += 1;
      throw new Error("HTTP 502");
    }, { store, now: () => now, tip: 970_001 });
  await failing();
  calls = 0;
  await failing();
  assert.equal(calls, 3, "no answer: asked again next time");
  // a reorganization is still caught at the next re-check
  answer = { confirmed: false, seen: true };
  now += 1;
  await refresh();
  assert.ok(store.list(ADDR).every((r) => !r.confirmed), "back in the mempool: unconfirmed again");
  console.log("txrecords: confirmed records are re-checked at most once a minute; a build does not wait on dozens of serial reads");
}

// ---- finality: a tx is dropped only after DROP_GRACE_MS since it was LAST seen, and only while that answer means something ----
{
  const rec = { txid: TX("5"), kind: "send", inputs: [], at: 0, confirmed: false, seenAt: 60 * 60 * 1000 };
  const unseen = { confirmed: false, seen: false };
  assert.equal(classifyTxStatus(rec, unseen, rec.seenAt + DROP_GRACE_MS - 1), "pending", "seen an hour after broadcast: the grace runs from then");
  assert.equal(classifyTxStatus(rec, unseen, rec.seenAt + DROP_GRACE_MS + 1), "dropped");
  assert.equal(classifyTxStatus(rec, unseen, rec.seenAt + 10 * DROP_GRACE_MS, DROP_GRACE_MS, { trustUnseen: false }), "pending", "the indexer lags / its node has no peers: never dropped");
  assert.ok(DROP_GRACE_MS >= 10 * 60 * 1000, "a generous grace: a node can miss a tx the network holds");
  // the store remembers the last sighting
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  let now = 1_000;
  const store = createTxRecordStore({ storage, now: () => now });
  store.add(ADDR, { txid: TX("6"), kind: "send", inputs: [] });
  now += DROP_GRACE_MS;
  await refreshTxRecords(ADDR, async () => ({ confirmed: false, seen: true }), { store, now: () => now, trustUnseen: true });
  assert.equal(store.list(ADDR)[0].seenAt, now);
  now += DROP_GRACE_MS - 1;
  await refreshTxRecords(ADDR, async () => unseen, { store, now: () => now, trustUnseen: true });
  assert.equal(store.list(ADDR).length, 1, "still inside the grace since it was last seen");
  now += 2;
  await refreshTxRecords(ADDR, async () => unseen, { store, now: () => now, trustUnseen: false });
  assert.equal(store.list(ADDR).length, 1, "not dropped while untrusted");
  await refreshTxRecords(ADDR, async () => unseen, { store, now: () => now, trustUnseen: true });
  assert.equal(store.list(ADDR).length, 0, "dropped once trusted and past the grace");
  console.log("txrecords: drops count from the last sighting, never while the node's answer cannot be trusted");
}

// ---- only a WALLET refusal reads as "declined" ------------------------------------------------
{
  const refused = walletError(new Error("User rejected the request."), "sign");
  assert.equal(refused.declined, "sign");
  assert.equal(walletError(Object.assign(new Error("nope"), { code: 4001 }), "connect").declined, "connect");
  assert.equal(walletError(new Error("Unsupported sighash"), "sign").declined, undefined, "a wallet failure that is not a refusal");
  assert.equal(friendlyError(refused), "Signature declined in the wallet.");
  assert.equal(friendlyError(walletError(new Error("User rejected"), "connect")), "Connection declined in the wallet.");
  // The node's answer after a SUCCESSFUL signature is never "declined".
  const node = Object.assign(new Error("push failed · indexer relay: /broadcast HTTP 400: insufficient fee, rejecting replacement abc"), { conflict: true });
  assert.match(friendlyError(node), /^The node rejected the transaction: it spends an input that another pending transaction already spends/);
  assert.match(friendlyError(node), /rejecting replacement/, "the node's own words are kept");
  assert.equal(friendlyError(new Error("Indexer /x -> HTTP 500: cancelled job")), "Indexer /x -> HTTP 500: cancelled job", "an untagged message is shown verbatim");
  console.log("wallet: declined is tagged at the wallet boundary only");
}

// ---- a "failed" broadcast is looked up before the user is told to retry ----------------------
{
  const summary = { txid: TX("e"), inputs: [{ txid: TX("6"), vout: 0 }] };
  const recorded = [];
  const record = (s, m) => recorded.push([s.txid, m.kind]);
  const noSleep = async () => {};
  // it landed after all → success with its txid, and it is recorded
  const ok = await landedOrThrow(summary, { kind: "deploy" }, new Error("push failed · indexer relay: timeout"), { txStatus: async () => ({ confirmed: false, seen: true }), sleep: noSleep, record });
  assert.equal(ok, TX("e"));
  assert.deepEqual(recorded, [[TX("e"), "deploy"]]);
  // it reaches the node only at the third look (15 s): still a success — three looks, at the documented waits
  recorded.length = 0;
  const waits = [];
  let looks = 0;
  const late = await landedOrThrow(summary, { kind: "mine" }, new Error("push failed"), {
    txStatus: async () => ({ confirmed: false, seen: ++looks >= 3 }),
    sleep: async (ms) => waits.push(ms),
    record,
  });
  assert.equal(late, TX("e"));
  assert.deepEqual(waits, LANDED_CHECK_WAITS_MS, "2 s, then 6 s, then 15 s after the broadcast");
  assert.deepEqual(recorded, [[TX("e"), "mine"]]);
  // never seen in ~15 s → it may still arrive: recorded (its inputs stay out of the next build), never "nothing was spent"
  recorded.length = 0;
  await assert.rejects(
    landedOrThrow(summary, { kind: "deploy" }, new Error("push failed"), { txStatus: async () => ({ confirmed: false, seen: false }), sleep: noSleep, record }),
    (e) => e.landed === null && e.recorded === true && /has not seen tx .* yet/.test(e.message) && !/nothing was spent/.test(e.message),
  );
  assert.deepEqual(recorded, [[TX("e"), "deploy"]]);
  // the node REFUSED it (the relay said so): a retry is safe, nothing recorded, one look is enough
  recorded.length = 0;
  let asked = 0;
  await assert.rejects(
    landedOrThrow(summary, { kind: "deploy" }, new Error("push failed"), { txStatus: async () => (asked++, { confirmed: false, seen: false }), sleep: noSleep, record, refused: true }),
    (e) => e.landed === false && /refused tx .*nothing was spent — you can try again/.test(e.message),
  );
  assert.equal(asked, 1);
  assert.deepEqual(recorded, []);
  // which relay answers count as the node's refusal
  assert.equal(nodeRefused(Object.assign(new Error("/broadcast HTTP 400: bad-txns-inputs-missingorspent"), { status: 400 })), true);
  assert.equal(nodeRefused(Object.assign(new Error("/broadcast HTTP 400: min relay fee not met, 100 < 141"), { status: 400 })), true);
  assert.equal(nodeRefused(Object.assign(new Error("/broadcast HTTP 400: mempool min fee not met"), { status: 400 })), false, "a full mempool elsewhere may still take it");
  assert.equal(nodeRefused(Object.assign(new Error("/broadcast HTTP 503: server busy"), { status: 503 })), false);
  assert.equal(nodeRefused(new Error("Indexer unreachable: … — Failed to fetch")), false);
  recorded.length = 0;
  // unknown → recorded (so the Create page keeps the ticker blocked) and told to check first
  await assert.rejects(
    landedOrThrow(summary, { kind: "deploy" }, new Error("push failed"), {
      txStatus: async () => {
        throw new Error("HTTP 502");
      },
      sleep: noSleep,
      record,
    }),
    (e) => e.landed === null && /check it before trying again/.test(e.message) && e.txid === TX("e"),
  );
  assert.deepEqual(recorded, [[TX("e"), "deploy"]]);
  console.log("wallet: a failed broadcast is checked against /tx-status before a retry is offered");
}

// ---- the mock settles by §4.1 and §7.5 ----------------------------------------
{
  const out = (vout, { address = null, sats = 546, opReturn = false, script = null } = {}) => ({ vout, sats, address: opReturn ? null : address, script: opReturn ? "6a0a" : script ?? (address ? "5120aa" : "51") });
  const FEE = (vout, sats) => out(vout, { address: PROJECT_FEE_ADDRESS, sats });
  const deployed = (t) => t === "LUCKY";
  const H = ACTIVATION_HEIGHT + 100;
  // MINE: valid needs the fee; the residual goes to vout0 either way; no vout0 → burn
  const mine = { payload: { op: "MINE", ticker: "LUCKY" }, outputs: [out(0, { address: ADDR }), FEE(1, 546), out(2, { opReturn: true })] };
  assert.deepEqual(routeDecision(mine, { isDeployed: deployed }), { op: "MINE", valid: true, applied: true, reason: null, yieldVout: 0, send: null, residualVout: 0, listedTo: [] });
  // a MINE in its ticker's DEPLOY block is invalid (deploy_same_block); its residual still goes to vout0
  const sameBlock = routeDecision(mine, { isDeployed: deployed, deployBlockOf: () => H, height: H });
  assert.deepEqual([sameBlock.valid, sameBlock.reason, sameBlock.yieldVout, sameBlock.residualVout], [false, "deploy_same_block", null, 0]);
  assert.equal(routeDecision(mine, { isDeployed: deployed, deployBlockOf: () => H, height: H + 1 }).valid, true, "the block after the DEPLOY: valid");
  assert.equal(routeDecision(mine, { isDeployed: () => false }).reason, "not_deployed");
  const feeless = { ...mine, outputs: [out(0, { address: ADDR }), out(1, { opReturn: true })] };
  assert.equal(routeDecision(feeless, { isDeployed: deployed }).reason, "fee_missing", "no exact 546-sat fee output → invalid");
  assert.equal(routeDecision(feeless, { isDeployed: deployed }).residualVout, 0, "…but its residual still goes to vout0");
  const noV0 = { ...mine, outputs: [out(0, { opReturn: true }), FEE(1, 546)] };
  assert.equal(routeDecision(noV0, { isDeployed: deployed }).residualVout, null, "vout0 an OP_RETURN → burn, no fall-back");
  assert.equal(routeDecision(noV0, { isDeployed: deployed }).reason, "vout0_unusable");
  const addrless0 = { ...mine, outputs: [out(0), FEE(1, 546), out(2, { opReturn: true })] };
  assert.equal(routeDecision(addrless0, { isDeployed: deployed }).valid, true, "an address-less vout0 is still credited (named index)");

  // SEND: fixed outputs — AMT → vout1, the rest → vout2; applied needs pool ≥ AMT, a real vout1 and the fee
  const BOB = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  const sendPayload = { op: "SEND", ticker: "LUCKY", amount: 100 };
  const send = { payload: sendPayload, outputs: [FEE(0, 546), out(1, { address: BOB }), out(2, { address: ADDR }), out(3, { opReturn: true })] };
  const applied = routeDecision(send, { pool: { LUCKY: 150 } });
  assert.deepEqual([applied.applied, applied.send, applied.residualVout], [true, { vout: 1, ticker: "LUCKY", amount: 100 }, 2]);
  const short = routeDecision(send, { pool: { LUCKY: 50 } });
  assert.deepEqual([short.applied, short.send, short.residualVout], [false, null, 2], "pool < AMT: nothing to vout1, the whole pool → vout2");
  assert.equal(routeDecision({ ...send, outputs: [out(0, { address: ADDR }), out(1, { address: BOB }), out(2, { address: ADDR }), out(3, { opReturn: true })] }, { pool: { LUCKY: 150 } }).applied, false, "no fee output → not applied");
  assert.equal(routeDecision({ ...send, outputs: [FEE(0, 547), out(1, { address: BOB }), out(2, { address: ADDR }), out(3, { opReturn: true })] }, { pool: { LUCKY: 150 } }).applied, false, "the fee must be exact");
  const feeAnywhere = { ...send, outputs: [out(0, { address: ADDR }), out(1, { address: BOB }), out(2, { address: ADDR }), out(3, { opReturn: true }), FEE(4, 546)] };
  assert.equal(routeDecision(feeAnywhere, { pool: { LUCKY: 150 } }).applied, true, "the fee output may sit anywhere");
  const v1OpRet = { ...send, outputs: [FEE(0, 546), out(1, { opReturn: true }), out(2, { address: ADDR })] };
  assert.deepEqual([routeDecision(v1OpRet, { pool: { LUCKY: 150 } }).applied, routeDecision(v1OpRet, { pool: { LUCKY: 150 } }).residualVout], [false, 2], "vout1 an OP_RETURN → not applied");
  const v2OpRet = { ...send, outputs: [FEE(0, 546), out(1, { address: BOB }), out(2, { opReturn: true })] };
  const dv2 = routeDecision(v2OpRet, { pool: { LUCKY: 150 } });
  assert.deepEqual([dv2.applied, dv2.send?.vout, dv2.residualVout], [true, 1, 0], "vout2 an OP_RETURN: AMT still → vout1, the rest → the default output — vout0, the fee output");
  const onlyTwo = { ...send, outputs: [FEE(0, 546), out(1, { address: BOB }), out(2, { opReturn: true })].slice(0, 2) };
  assert.equal(routeDecision(onlyTwo, { pool: { LUCKY: 150 } }).residualVout, 0, "vout2 missing → the default output");
  // default output: first non-OP_RETURN; address-less → burn (no skipping)
  assert.equal(defaultOutIdx([out(0, { opReturn: true }), out(1, { address: ADDR })]), 1);
  assert.equal(defaultOutIdx([out(0), out(1, { address: ADDR })]), null, "address-less first output → burn");
  assert.equal(routeDecision({ payload: null, outputs: [out(0), out(1, { address: ADDR })] }).residualVout, null);

  // Signature types, read as the indexer reads a block (the spent output's type decides).
  const SIG64 = "11".repeat(64); // P2TR key path, SIGHASH_DEFAULT
  const SIG65 = (b) => "11".repeat(64) + b; // P2TR key path with a sighash byte
  const DER = (b) => "30" + "44".repeat(69) + b; // a DER signature ending with its sighash byte
  const PUB = "02" + "22".repeat(32);
  assert.equal(inputSighash([SIG64], "tr"), 0x00, "64-byte Schnorr: default sighash");
  assert.equal(inputSighash([SIG65("83")], "tr"), 0x83);
  assert.equal(inputSighash([SIG65("83"), "50aa"], "tr"), 0x83, "an annex does not hide the key-path signature");
  assert.equal(inputSighash([DER("83"), PUB], "wpkh"), 0x83, "P2WPKH: the DER signature's last byte");
  assert.equal(inputSighash([DER("01"), PUB], "wpkh"), 0x01);
  assert.equal(inputSighash([], "tr"), null);
  const CONTROL33 = "c0" + "33".repeat(32); // a one-leaf taproot control block, 33 bytes like a key
  assert.equal(inputSighash([DER("83"), CONTROL33], "tr"), null, "P2TR [script, control block]: a script-path spend, never read as a P2WPKH signature");
  assert.equal(inputSighash([DER("83"), CONTROL33]), 0x83, "…which only the shape guess would misread");
  assert.equal(inputSighash([SIG65("83")], null), null, "another script type: no signature type");
  assert.equal(listedScriptType("bc1p" + "q".repeat(58)), "tr");
  assert.equal(listedScriptType("bc1q" + "q".repeat(38)), "wpkh");
  assert.equal(listedScriptType("bc1q" + "q".repeat(58)), null, "a 32-byte v0 program (P2WSH) is neither");
  assert.equal(listedScriptType("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"), null);

  // DEPLOY (§2.1): fee_missing before ticker_taken; token inputs → the default output.
  const A = ADDR; // P2TR
  const B = BOB; // P2WPKH
  const C = "bc1p" + "c".repeat(58); // P2TR
  const WSH = "bc1q" + "w".repeat(58); // P2WSH-shaped: no signature type
  const pvs = new Map();
  const input = (n, address, sats) => {
    const i = { txid: TX(String(n)), vout: 0 };
    pvs.set(`${i.txid}:0`, { address, sats });
    return i;
  };
  const prevoutOf = (k) => pvs.get(k) || null;
  const dep = (inputs, witnesses, outputs, ticker = "NEW") => ({ payload: { op: "DEPLOY", ticker }, inputs, witnesses, outputs });
  const depOuts = [out(0, { address: A }), FEE(1, 5_460), out(2, { opReturn: true }), out(3, { address: A, sats: 9_000 })];
  const d0 = routeDecision(dep([input(1, A, 50_000)], [[SIG64]], depOuts), { isDeployed: deployed, prevoutOf });
  assert.deepEqual([d0.op, d0.applied, d0.reason, d0.deployer, d0.residualVout], ["DEPLOY", true, null, A, 0]);
  const off = (sats) => [out(0, { address: A }), FEE(1, sats), out(2, { opReturn: true })];
  assert.equal(routeDecision(dep([input(1, A, 50_000)], [[SIG64]], off(5_459)), { isDeployed: deployed, prevoutOf }).reason, "fee_missing");
  assert.equal(routeDecision(dep([input(1, A, 50_000)], [[SIG64]], off(5_461)), { isDeployed: deployed, prevoutOf }).reason, "fee_missing");
  assert.equal(routeDecision(dep([input(1, A, 50_000)], [[SIG64]], off(5_459), "LUCKY"), { isDeployed: deployed, prevoutOf }).reason, "fee_missing", "fee_missing is reported before ticker_taken");
  const taken = routeDecision(dep([input(1, A, 50_000)], [[SIG64]], depOuts, "LUCKY"), { isDeployed: deployed, prevoutOf });
  assert.deepEqual([taken.applied, taken.reason, taken.deployer], [false, "ticker_taken", A], "an unapplied row still names its attributed deployer");
  assert.equal(routeDecision(dep([input(1, A, 50_000)], [[SIG64]], [out(0, { opReturn: true }), out(1, { address: C }), FEE(2, 5_460)]), { isDeployed: deployed, prevoutOf }).residualVout, 1, "a DEPLOY's token inputs go to the default output");

  // deployerOf: only inputs signed over the whole tx (0x00 / 0x01) count, summed per address.
  const who = (rows) => deployerOf({ inputs: rows.map(([n, address, sats]) => input(n, address, sats)), witnesses: rows.map((r) => r[3]) }, prevoutOf);
  assert.equal(who([[10, A, 5_000_000, [SIG65("83")]], [11, B, 20_000, [DER("01"), PUB]]]), B, "a 5,000,000-sat 0x83 input loses to a 20,000-sat 0x01 input");
  assert.equal(who([[12, A, 10_000, [SIG64]], [13, B, 20_000, [DER("01"), PUB]], [14, A, 15_000, [SIG65("01")]]]), A, "values sum per address (A 25,000 > B 20,000)");
  assert.equal(who([[15, C, 9_000_000, [SIG65("81")]], [16, B, 1_000, [DER("01"), PUB]]]), B, "a 9,000,000-sat 0x81 input is ignored");
  assert.equal(who([[17, C, 9_000_000, [SIG65("02")]], [18, A, 9_000_000, [SIG65("03")]], [19, B, 700, [DER("01"), PUB]]]), B, "0x02 / 0x03 are ignored, 0x01 counts");
  assert.equal(who([[20, C, 5_000, [SIG64]], [21, A, 5_000, [SIG64]]]), C, "a tie: the address whose first input has the lower index");
  assert.equal(who([[22, A, 5_000, [SIG64]], [23, C, 5_000, [SIG64]]]), A);
  assert.equal(who([[24, A, 5_000_000, [SIG65("83")]], [25, C, 5_000, ["00", "11", "22"]]]), "", "only a 0x83 input and a script-path spend: no deployer");
  assert.equal(who([[26, WSH, 9_000_000, [DER("01"), PUB]], [27, A, 1, [SIG64]]]), A, "a P2WSH-shaped input never counts");
  assert.equal(who([[28, A, 9_000_000, [SIG64, "aa"]]]), "", "a two-element P2TR witness without an annex is a script-path spend");
  assert.equal(deployerOf({ inputs: [{ txid: TX("99"), vout: 0 }], witnesses: [[SIG64]] }, prevoutOf), "", "an unknown prevout never counts");
  const noSigner = routeDecision(dep([input(29, A, 5_000_000)], [[SIG65("83")]], depOuts), { isDeployed: deployed, prevoutOf });
  assert.deepEqual([noSigner.applied, noSigner.deployer], [true, ""], "the ticker registers with an empty deployer");

  // §4 rule 6 + §7.5: inputs signed as a listing, in the reference fill layout.
  const SELLER = "bc1p" + "s".repeat(58);
  const order = { ticker: "LUCKY", seller: SELLER, price_sats: 60_000 };
  const listed = input(40, SELLER, 546);
  const buyerIn = input(41, ADDR, 100_000);
  const fillOuts = (amt, { fee = true } = {}) =>
    [out(0, { address: SELLER, sats: 60_000 }), out(1, { address: ADDR }), out(2, { address: ADDR }), ...(fee ? [FEE(3, 546)] : []), out(fee ? 4 : 3, { opReturn: true }), out(fee ? 5 : 4, { address: ADDR, sats: 30_000 })].map((o, i) => ({ ...o, vout: i }));
  const fill = (amt, opts) => ({ payload: { op: "SEND", ticker: "LUCKY", amount: amt }, inputs: [listed, buyerIn], witnesses: [[SIG65("83")], [SIG64]], outputs: fillOuts(amt, opts) });
  const L = [{ idx: 0, balances: { LUCKY: 1200 } }];
  assert.deepEqual(listingSignedInputs(fill(1200), prevoutOf), [0], "the listing (0x83, vout0 usable) is listing-signed; the buyer's 0x00 input is not");
  const df = routeDecision(fill(1200), { pool: {}, listed: L, prevoutOf });
  assert.deepEqual([df.applied, df.send, df.listedTo], [true, { vout: 1, ticker: "LUCKY", amount: 1200 }, []], "an applied SEND of the ticker moves the listed tokens (to vout1)");
  assert.deepEqual(settleListingSpend(fill(1200), df, order, 0), { filled: true, buyer: ADDR, selfTrade: false, priceSats: 60_000 }, "buyer = vout1 of the applied SEND");
  // Without the fee output the SEND does not apply: the tokens go to vout0, the seller — a self-trade.
  const noFee = fill(1200, { fee: false });
  const dNoFee = routeDecision(noFee, { pool: {}, listed: L, prevoutOf });
  assert.deepEqual([dNoFee.applied, dNoFee.listedTo], [false, [{ vout: 0, balances: { LUCKY: 1200 } }]], "fee-less fill: the listed tokens → vout[i]");
  assert.deepEqual(settleListingSpend(noFee, dNoFee, order, 0), { filled: true, buyer: SELLER, selfTrade: true, priceSats: 60_000 }, "…recorded as the seller's own trade");
  // No payload at all: the same.
  const plain = { ...fill(1200), payload: null };
  const dPlain = routeDecision(plain, { pool: {}, listed: L, prevoutOf });
  assert.deepEqual(dPlain.listedTo, [{ vout: 0, balances: { LUCKY: 1200 } }]);
  assert.deepEqual(settleListingSpend(plain, dPlain, order, 0), { filled: true, buyer: SELLER, selfTrade: true, priceSats: 60_000 }, "a payload-less spend of a listing: self-trade");
  // An AMT above the listed balance does not apply: the tokens stay with the seller.
  const dOver = routeDecision(fill(1500), { pool: {}, listed: L, prevoutOf });
  assert.deepEqual([dOver.applied, dOver.listedTo], [false, [{ vout: 0, balances: { LUCKY: 1200 } }]], "AMT 1,500 on a 1,200 listing: tokens at vout[i]");
  assert.equal(settleListingSpend(fill(1500), dOver, order, 0).selfTrade, true);
  // AMT 1 applies whenever the listed output holds any of the ticker.
  const dOne = routeDecision(fill(1), { pool: {}, listed: L, prevoutOf });
  assert.deepEqual([dOne.applied, dOne.send, dOne.listedTo], [true, { vout: 1, ticker: "LUCKY", amount: 1 }, []], "AMT 1: applied, the rest of the listed tokens join the pool (→ vout2)");
  assert.equal(settleListingSpend(fill(1), dOne, order, 0).buyer, ADDR);
  // A SEND of another ticker leaves the listed tokens on vout[i]; a mixed listed input moves only the SEND's ticker.
  const alt = { ...fill(5), payload: { op: "SEND", ticker: "ALT", amount: 5 } };
  const dAlt = routeDecision(alt, { pool: { ALT: 10 }, listed: L, prevoutOf });
  assert.deepEqual([dAlt.applied, dAlt.send.ticker, dAlt.listedTo], [true, "ALT", [{ vout: 0, balances: { LUCKY: 1200 } }]]);
  assert.equal(settleListingSpend(alt, dAlt, order, 0).selfTrade, true, "a fill completed by another ticker's SEND is the seller's own trade");
  const dMixed = routeDecision(fill(1200), { pool: {}, listed: [{ idx: 0, balances: { LUCKY: 1200, ALT: 7 } }], prevoutOf });
  assert.deepEqual(dMixed.listedTo, [{ vout: 0, balances: { ALT: 7 } }], "the ALT balance of a mixed listed input → vout[i]");
  // A 0x83 input without a usable paired output is an ordinary input.
  const unpaired = { payload: null, inputs: [buyerIn, input(42, SELLER, 546)], witnesses: [[SIG64], [SIG65("83")]], outputs: [out(0, { address: ADDR }), out(1, { opReturn: true })] };
  assert.deepEqual(listingSignedInputs(unpaired, prevoutOf), [], "vout1 is an OP_RETURN: not listing-signed");
  assert.deepEqual(listingSignedInputs({ ...unpaired, outputs: [out(0, { address: ADDR })] }, prevoutOf), [], "no vout1 at all: not listing-signed");
  // Other signature types are unaffected.
  for (const w of [[SIG64], [SIG65("01")], [SIG65("81")], [SIG65("82")], [SIG65("02")], [SIG65("03")], ["00", "11", "22"]]) {
    assert.deepEqual(listingSignedInputs({ ...fill(1200), witnesses: [w, [SIG64]] }, prevoutOf), [], `witness ${w.map((x) => x.slice(-2)).join(",")}: ordinary`);
  }
  // A listing at input 1 of an applied SEND: its paired output IS vout1 — recorded as the seller's own trade.
  const at1 = {
    payload: { op: "SEND", ticker: "LUCKY", amount: 1200 },
    inputs: [buyerIn, listed],
    witnesses: [[SIG64], [SIG65("83")]],
    outputs: [FEE(0, 546), out(1, { address: SELLER, sats: 60_000 }), out(2, { address: ADDR }), out(3, { opReturn: true })],
  };
  assert.deepEqual(listingSignedInputs(at1, prevoutOf), [1]);
  const d1 = routeDecision(at1, { pool: {}, listed: [{ idx: 1, balances: { LUCKY: 1200 } }], prevoutOf });
  assert.deepEqual(d1.send, { vout: 1, ticker: "LUCKY", amount: 1200 });
  assert.equal(isFillOf(at1, d1, order, 1), true, "listing at input 1 (0x83) paid at vout1 → filled");
  assert.equal(isFillOf(at1, d1, order, 0), false, "judged at vout0 it would not be");
  assert.deepEqual(settleListingSpend(at1, d1, order, 1), { filled: true, buyer: SELLER, selfTrade: true, priceSats: 60_000 }, "the recorded buyer is vout1 — the seller");
  // The same layout signed with the default sighash (a withdrawal, a split, a send): never a trade.
  assert.equal(isFillOf({ ...fill(1200), witnesses: [[SIG64], [SIG64]] }, df, order, 0), false, "a 64-byte signature is the seller's own spend → cancelled");
  assert.equal(isFillOf({ ...fill(1200), witnesses: [[SIG65("01")], [SIG64]] }, df, order, 0), false, "SIGHASH_ALL → cancelled");
  // A withdrawal priced exactly at the listing's 546-sat minimum: the self-payment is no fill.
  const cheap = { ticker: "LUCKY", seller: ADDR, price_sats: 546 };
  const toSelf = {
    payload: { op: "SEND", ticker: "LUCKY", amount: 1 },
    inputs: [input(43, ADDR, 546), buyerIn],
    witnesses: [[SIG64], [SIG64]],
    outputs: [FEE(0, 546), out(1, { address: ADDR }), out(2, { address: ADDR }), out(3, { opReturn: true }), out(4, { address: ADDR, sats: 90_000 })],
  };
  const dSelf = routeDecision(toSelf, { pool: { LUCKY: 1 }, prevoutOf });
  assert.equal(isFillOf(toSelf, dSelf, cheap, 0), false, "a withdrawal at the 546-sat price is cancelled, not a self-trade");
  const shortPay = { ...fill(1200), outputs: fill(1200).outputs.map((o) => (o.vout === 0 ? { ...o, sats: 59_999 } : o)) };
  assert.equal(isFillOf(shortPay, df, order, 0), false, "paying less than the price is no fill");
  console.log("mock routing: MINE vout0 rule, SEND vout1 / vout2 with the default-output fall-back, DEPLOY fee_missing → ticker_taken, whole-tx deployer attribution, §4 rule 6 listing-signed inputs and §7.5 buyers");
}

// ---- the mock's holdDeploy knob: a DEPLOY that misses blocks while the chain goes on ----------------
{
  const store = new Map();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  });
  const mock = await import("../src/lib/mock.js");
  const { MOCK_WALLET, mockGet, mockSignPsbt, simulateBroadcast } = mock;
  const { mockSpendable } = await import("./mockspend.js");
  const { buildDeployPsbt, extractRawTxHex } = await import("../src/lib/psbt.js");
  const CONFIRM_AFTER_MS = 20_000;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const address = MOCK_WALLET.address;
    const btcRows = (await mockSpendable(mock, address)).utxos;
    const tokenOutpoints = (await mockGet(`/utxos/${address}`)).utxos.map(({ txid, vout }) => ({ txid, vout }));
    const built = buildDeployPsbt({ address, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos: btcRows, tokenOutpoints, feeRateSatVb: 2, ticker: "HELD", selectionOrder: "largest" });
    const raw = extractRawTxHex(mockSignPsbt(built.psbtHex, { toSignInputs: built.inputIndexes.map((index) => ({ index, address })) }));
    store.set("lp.mock.holdDeploy", "2");
    const sentTip = (await mockGet("/health")).tip_height;
    const txid = simulateBroadcast(raw);
    assert.equal(store.has("lp.mock.holdDeploy"), false, "the knob is used up by one DEPLOY");
    assert.equal((await mockGet(`/tx-status/${txid}`)).confirmed, false);
    now += CONFIRM_AFTER_MS;
    assert.ok((await mockGet("/health")).tip_height > sentTip, "one block later the tip has passed the DEPLOY's broadcast tip");
    assert.equal((await mockGet(`/tx-status/${txid}`)).confirmed, false, "…while the DEPLOY still waits");
    now += 2 * CONFIRM_AFTER_MS;
    const st = await mockGet(`/tx-status/${txid}`);
    assert.equal(st.confirmed, true, "three blocks later it has confirmed");
    assert.equal(st.block_height, sentTip + 3, "at the held height");
    const row = await mockGet("/tokens/HELD");
    assert.deepEqual([row.deploy_txid, row.deployer, row.deploy_block], [txid, address, sentTip + 3], "registered to the wallet (whole-tx-signed deployer)");
  } finally {
    Date.now = realNow;
  }
  console.log("mock holdDeploy: the chain goes on while a held DEPLOY waits N blocks, then it confirms at the held height");
}

console.log("flows: all checks passed");
