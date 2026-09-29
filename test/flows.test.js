// Pure-part tests for the write-flow safety nets: the indexer-lag gate
// (src/lib/sync.js), the broadcast records (src/lib/txrecords.js), the
// /btc-utxos seeding retry (src/lib/retry.js), wallet-vs-node error tagging
// and the "did the failed broadcast land?" check (src/lib/wallet.js), and
// the mock indexer's §4.1 routing (src/lib/mockRouting.js). Plain Node, no
// framework.
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
import {
  isAbortError,
  isSeedBusyError,
  isSeedingError,
  isSeedLimitError,
  fmtWaited,
  retryDelayMs,
  retryOn503,
  retryWhileSeeding,
  seedFailureText,
  seedWaitNote,
  SEED_WAIT_BUDGET_MS,
} from "../src/lib/retry.js";
import { seedWaitFields } from "../src/lib/httpError.js";
import { LANDED_CHECK_WAITS_MS, landedOrThrow, nodeRefused, walletError } from "../src/lib/wallet.js";
import { friendlyError } from "../src/hooks/useWallet.js";
import { REVEAL_REASONS, defaultOutIdx, inputSighash, isFillOf, listedScriptType, revealRejection, routeDecision, settleListingSpend } from "../src/lib/mockRouting.js";
import { commitHashFor } from "../src/lib/payloads.js";
import { PROJECT_FEE_ADDRESS } from "../src/lib/payloads.js";

const TX = (c) => c.repeat(64);
const ADDR = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";

// ---- the lag gate ------------------------------------------------------------------------------
{
  assert.deepEqual(syncStateOf({ indexed_height: 969_310, tip_height: 969_310, stalled: false }), {
    indexed: 969_310,
    tip: 969_310,
    lag: 0,
    stalled: false,
    rebuilding: false,
    noPeers: false,
    networkLag: 0,
    synced: true,
    trustUnseen: true,
  });
  const cold = syncStateOf({ indexed_height: 969_300, tip_height: 969_812, stalled: false });
  assert.equal(cold.synced, false, "a cold scan is not synced even while it makes progress");
  assert.equal(cold.lag, 512);
  assert.match(syncPauseText(cold, "creating PEPE"), /512 blocks behind the chain tip \(#969,300 of #969,812\), so creating PEPE would rely on stale state/);
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
  const answers = { [TX("a")]: { confirmed: true, seen: true, block_height: 969_400 }, [TX("b")]: { confirmed: true, seen: true, block_height: 969_400 } };
  const after = await refreshTxRecords(ADDR, async (t) => answers[t], { store, now: () => now, tip: 969_400 });
  assert.deepEqual(after.map((r) => [r.kind, r.state]), [["deploy", "confirmed"], ["mine", "confirmed"]]);
  assert.ok(store.list(ADDR).every((r) => r.confirmed && r.blockHeight === 969_400), "both marked confirmed in the store, with their block");
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
  let answer = { confirmed: true, seen: true, block_height: 969_500 };
  const refresh = (tip) => refreshTxRecords(ADDR, async () => answer, { store, now: () => now, tip, trustUnseen: true });
  await refresh(969_500);
  let r = store.list(ADDR)[0];
  assert.deepEqual([r.confirmed, r.blockHeight, r.confirmedAt], [true, 969_500, now]);
  assert.ok(pendingSpentOutpoints(store.list(ADDR)).has(IN), "1 confirmation: the input stays excluded (a withdrawal cannot be undone by the next MINE)");
  // a chain reorganization puts it back in the mempool (seen at the next re-check)
  answer = { confirmed: false, seen: true, in_mempool: true };
  now += CONFIRMED_RECHECK_MS;
  const back = await refresh(969_501);
  assert.equal(back[0].state, "pending");
  r = store.list(ADDR)[0];
  assert.deepEqual([r.confirmed, r.blockHeight], [false, null], "unconfirmed again");
  assert.ok(pendingSpentOutpoints(store.list(ADDR)).has(IN));
  // confirms again in another block; kept until that block is 6 deep, then forgotten (a send has no result page)
  answer = { confirmed: true, seen: true, block_height: 969_502 };
  await refresh(969_502);
  await refresh(969_506);
  assert.equal(store.list(ADDR).length, 1, "5 confirmations: still guarding");
  await refresh(969_507);
  assert.equal(store.list(ADDR).length, 0, "6 confirmations: final, forgotten");
  // unknown to the indexer while confirmed (it may be mid-reorganization): kept as it is
  store.add(ADDR, { txid: TX("2"), kind: "fill", inputs: [IN] });
  answer = { confirmed: true, seen: true, block_height: 969_600 };
  await refresh(969_600);
  answer = { confirmed: false, seen: false };
  now += CONFIRMED_RECHECK_MS;
  await refresh(969_601);
  assert.equal(store.list(ADDR)[0].confirmed, true, "an unknown answer does not unconfirm");
  // forget: a confirmed record is only marked done — it keeps guarding until final
  store.forget(ADDR, TX("2"));
  assert.deepEqual([store.list(ADDR)[0].done, pendingSpentOutpoints(store.list(ADDR)).has(IN)], [true, true]);
  // no tip: the time guard, from when it was first seen confirmed
  const since = store.list(ADDR)[0].confirmedAt;
  assert.equal(recordIsFinal(store.list(ADDR)[0], null, since + FINAL_GUARD_MS - 1), false);
  assert.equal(recordIsFinal(store.list(ADDR)[0], null, since + FINAL_GUARD_MS), true);
  assert.equal(recordIsFinal(store.list(ADDR)[0], 969_605, now), true, "the depth, when known, decides");
  // an unconfirmed record is deleted by forget
  store.add(ADDR, { txid: TX("3"), kind: "send", inputs: [`${TX("b")}:1`] });
  store.forget(ADDR, TX("3"));
  assert.ok(!store.list(ADDR).some((x) => x.txid === TX("3")));
  // a done MINE is forgotten once final; one not shown yet stays for its result page
  store.add(ADDR, { txid: TX("4"), kind: "mine", ticker: "MOON", inputs: [] });
  store.markConfirmed(ADDR, TX("4"), 969_600);
  await refreshTxRecords(ADDR, async () => ({ confirmed: true, seen: true, block_height: 969_600 }), { store, now: () => now, tip: 969_610 });
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
  let answer = { confirmed: true, seen: true, block_height: 969_700 };
  const refresh = () =>
    refreshTxRecords(ADDR, async () => {
      calls += 1;
      return answer;
    }, { store, now: () => now, tip: 969_701, trustUnseen: true });
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
    }, { store, now: () => now, tip: 969_701 });
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

// ---- client side: 503 and 429 both mean "not yet", with the server's Retry-After -----------------
{
  const e503 = Object.assign(new Error("Indexer /btc-utxos/x -> HTTP 503"), { status: 503, retryAfter: 15 });
  const e429 = Object.assign(new Error("Indexer /btc-utxos/x -> HTTP 429"), { status: 429, retryAfter: 60 });
  assert.equal(isSeedingError(e503), true);
  assert.equal(isSeedBusyError(e429), true);
  assert.equal(isSeedBusyError(new Error("HTTP 429")), true);
  assert.equal(retryDelayMs(e503), 15_000);
  assert.equal(retryDelayMs(e429), 60_000, "the server's Retry-After, up to a minute");
  assert.equal(retryDelayMs({ retryAfter: 600 }), 60_000, "clamped to the max wait");
  assert.equal(retryDelayMs(new Error("x")), 2_000);
  let clock = 0;
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
    clock += ms;
  };
  let calls = 0;
  const rows = await retryWhileSeeding(async () => {
    calls += 1;
    if (calls === 1) throw e429;
    if (calls < 4) throw e503;
    return ["row"];
  }, { sleep, now: () => clock });
  assert.deepEqual([rows, calls, waits], [["row"], 4, [60_000, 15_000, 15_000]], "a 429 is retried like a 503, honoring Retry-After");
  // the budget ends the wait with the last error
  clock = 0;
  await assert.rejects(retryWhileSeeding(async () => {
    throw e503;
  }, { sleep, now: () => clock }), /HTTP 503/);
  assert.ok(clock <= SEED_WAIT_BUDGET_MS, "never waits past the budget");
  // older callers: fixed delay
  const fixed = [];
  await assert.rejects(retryOn503(async () => {
    throw e429;
  }, { attempts: 2, delayMs: 7, sleep: async (ms) => fixed.push(ms) }), /HTTP 429/);
  assert.deepEqual(fixed, [7]);
  console.log("retry: 503 and 429 retried within a budget, honoring Retry-After");
}

// ---- capacity: the first-use wait is ~10 minutes, says where the wallet stands, and can be stopped ------------
{
  assert.equal(SEED_WAIT_BUDGET_MS, 600_000, "a first use may wait about ten minutes");
  // The indexer's 503 / 429 bodies -> fields (JSON; an older plain-text 429 still names its reason).
  assert.deepEqual(seedWaitFields('{"error":"scanning","queue_position":3,"eta_secs":240}'), { queuePosition: 3, etaSecs: 240, reason: null });
  assert.deepEqual(seedWaitFields('{"queue_position":0,"eta_secs":null}'), { queuePosition: 0, etaSecs: null, reason: null });
  assert.deepEqual(seedWaitFields('{"error":"busy","reason":"client_limit"}'), { queuePosition: null, etaSecs: null, reason: "client_limit" });
  assert.equal(seedWaitFields('{"reason":"queue_full"}').reason, "queue_full");
  assert.deepEqual(seedWaitFields('{"queue_position":-1,"eta_secs":"soon","reason":"other"}'), { queuePosition: null, etaSecs: null, reason: null }, "malformed fields are unknown");
  assert.deepEqual(seedWaitFields('{"queue_position":1.5,"eta_secs":1e9}'), { queuePosition: null, etaSecs: null, reason: null });
  assert.equal(seedWaitFields("too many new wallet scans from this client; retry later").reason, "client_limit");
  assert.equal(seedWaitFields("the UTXO-scan queue is full; retry later").reason, "queue_full");
  assert.deepEqual(seedWaitFields(""), { queuePosition: null, etaSecs: null, reason: null });
  assert.deepEqual(seedWaitFields("{not json"), { queuePosition: null, etaSecs: null, reason: null });

  const queued = Object.assign(new Error("Indexer /btc-utxos/x -> HTTP 503"), { status: 503, retryAfter: 15, queuePosition: 40, etaSecs: 250, reason: null });
  const running = Object.assign(new Error("Indexer /btc-utxos/x -> HTTP 503"), { status: 503, retryAfter: 15, queuePosition: 0, etaSecs: 70, reason: null });
  const full = Object.assign(new Error("Indexer /btc-utxos/x -> HTTP 429"), { status: 429, retryAfter: 30, reason: "queue_full" });
  const limit = Object.assign(new Error("Indexer /btc-utxos/x -> HTTP 429"), { status: 429, retryAfter: 420, reason: "client_limit" });
  assert.equal(isSeedLimitError(limit), true);
  assert.equal(isSeedLimitError(full), false);
  assert.equal(isSeedLimitError(queued), false);

  // The wait hands the indexer's own queue position and estimate to the flow.
  const seen = [];
  let clock = 0;
  let calls = 0;
  const rows = await retryWhileSeeding(
    async () => {
      calls += 1;
      if (calls === 1) throw full;
      if (calls === 2) throw queued;
      if (calls === 3) throw running;
      return ["row"];
    },
    {
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      onRetry: (_n, info) => seen.push(info),
    },
  );
  assert.deepEqual(rows, ["row"]);
  assert.deepEqual(
    seen.map((i) => [i.busy, i.queuePosition, i.etaSecs, i.reason, i.waitMs]),
    [
      [true, null, null, "queue_full", 30_000],
      [false, 40, 250, null, 15_000],
      [false, 0, 70, null, 15_000],
    ],
  );

  // The per-network limit is not waited out: one call, then a sentence with the minutes to wait.
  calls = 0;
  const limited = await retryWhileSeeding(
    async () => {
      calls += 1;
      throw limit;
    },
    {
      sleep: async () => {
        throw new Error("must not wait");
      },
    },
  ).catch((e) => e);
  assert.equal(calls, 1, "a client_limit 429 is not retried");
  assert.equal(seedFailureText(limited), "Too many new wallets from your network are being set up right now — try again in 7 min.");
  assert.match(seedFailureText({ status: 429, reason: "client_limit" }), /try again in a few minutes\.$/, "no Retry-After, no number");
  assert.match(seedFailureText(full), /scan queue stayed full for 10 min/, "the queue that stayed full is not the per-network limit");
  assert.match(seedFailureText(running), /still being set up .* did not finish within 10 min/);
  assert.equal(seedFailureText(new Error("Indexer unreachable")), null);

  // Stop waiting: the pending sleep ends at once and the wait ends with an AbortError, no further call.
  const ctrl = new AbortController();
  calls = 0;
  const started = Date.now();
  const err = await retryWhileSeeding(
    async () => {
      calls += 1;
      throw running;
    },
    { signal: ctrl.signal, onRetry: () => setTimeout(() => ctrl.abort(), 5) },
  ).catch((e) => e);
  assert.equal(isAbortError(err), true, String(err));
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 5_000, "the 15 s Retry-After sleep was cut short");
  // Already stopped: no call at all.
  calls = 0;
  const pre = new AbortController();
  pre.abort();
  const none = await retryWhileSeeding(
    async () => {
      calls += 1;
      return [];
    },
    { signal: pre.signal },
  ).catch((e) => e);
  assert.equal(isAbortError(none), true);
  assert.equal(calls, 0);

  // What the flow says: calm, with the queue position and the estimate when known.
  assert.equal(seedWaitNote({ elapsedMs: 20_000, queuePosition: 0, etaSecs: 70 }), "Setting up this wallet: scanning the Bitcoin UTXO set, about 2 min (waiting 20 s).");
  assert.equal(
    seedWaitNote({ elapsedMs: 65_000, queuePosition: 40, etaSecs: 250 }),
    "Setting up this wallet: queued to scan the Bitcoin UTXO set, 40 addresses ahead, about 5 min (waiting 1 min 05 s).",
  );
  assert.match(seedWaitNote({ elapsedMs: 0, queuePosition: 1, etaSecs: 10 }), /1 address ahead, about 1 min/);
  assert.equal(seedWaitNote({ elapsedMs: 0 }), "Setting up this wallet: scanning the Bitcoin UTXO set, usually a few minutes (waiting 0 s).", "an indexer that names neither");
  assert.match(seedWaitNote({ elapsedMs: 30_000, busy: true, reason: "queue_full" }), /^The indexer's scan queue is full right now/);
  assert.match(seedWaitNote({ elapsedMs: 30_000, busy: true }), /^The indexer is busy right now/, "a 429 that names no reason is not called a full queue");
  assert.match(seedFailureText({ status: 429 }), /^The indexer stayed busy for 10 min/);
  // An estimate past the ten minutes the flow waits says so up front; the
  // failure then names the indexer's last estimate, not "a few minutes".
  assert.equal(
    seedWaitNote({ elapsedMs: 30_000, queuePosition: 2_500, etaSecs: 1_000 }),
    "Setting up this wallet: queued to scan the Bitcoin UTXO set, 2500 addresses ahead, about 17 min (waiting 30 s). This page waits up to 10 min; the scan keeps running after that.",
  );
  assert.match(seedWaitNote({ elapsedMs: 480_000, queuePosition: 0, etaSecs: 150 }), /about 3 min .*waits up to 10 min/, "past what is left of the wait");
  assert.doesNotMatch(seedWaitNote({ elapsedMs: 65_000, queuePosition: 40, etaSecs: 250 }), /waits up to/);
  assert.doesNotMatch(seedWaitNote({ elapsedMs: 590_000 }), /waits up to/, "no estimate, no promise either way");
  assert.match(seedFailureText({ status: 503, etaSecs: 400 }), /did not finish within 10 min\. It keeps running; try again in about 7 min\.$/);
  assert.match(seedFailureText({ status: 503, etaSecs: null }), /try again in a few minutes\.$/, "no estimate, no number");
  assert.equal(fmtWaited(599_000), "9 min 59 s");
  console.log("retry: ten-minute first-use wait with queue position and estimate, per-network limit said at once, Stop waiting");
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
  // MINE: valid needs the fee; the residual goes to vout0 either way; no vout0 → burn
  const mine = { payload: { op: "MINE", ticker: "LUCKY" }, outputs: [out(0, { address: ADDR }), FEE(1, 546), out(2, { opReturn: true })] };
  assert.deepEqual(routeDecision(mine, { isDeployed: deployed }), { op: "MINE", valid: true, applied: true, reason: null, yieldVout: 0, send: null, residualVout: 0 });
  // a MINE in its ticker's DEPLOY block is invalid (deploy_same_block); its residual still goes to vout0
  const sameBlock = routeDecision(mine, { isDeployed: deployed, deployBlockOf: () => 969_400, height: 969_400 });
  assert.deepEqual([sameBlock.valid, sameBlock.reason, sameBlock.yieldVout, sameBlock.residualVout], [false, "deploy_same_block", null, 0]);
  assert.equal(routeDecision(mine, { isDeployed: deployed, deployBlockOf: () => 969_400, height: 969_401 }).valid, true, "the block after the DEPLOY: valid");
  assert.equal(routeDecision(mine, { isDeployed: () => false }).reason, "not_deployed");
  const feeless = { ...mine, outputs: [out(0, { address: ADDR }), out(1, { opReturn: true })] };
  assert.equal(routeDecision(feeless, { isDeployed: deployed }).valid, false, "no exact 546-sat fee output → invalid");
  assert.equal(routeDecision(feeless, { isDeployed: deployed }).residualVout, 0, "…but its residual still goes to vout0");
  const noV0 = { ...mine, outputs: [out(0, { opReturn: true }), FEE(1, 546)] };
  assert.equal(routeDecision(noV0, { isDeployed: deployed }).residualVout, null, "vout0 an OP_RETURN → burn, no fall-back");
  const addrless0 = { ...mine, outputs: [out(0), FEE(1, 546), out(2, { opReturn: true })] };
  assert.equal(routeDecision(addrless0, { isDeployed: deployed }).valid, true, "an address-less vout0 is still credited (named index)");
  // SEND: applied needs pool ≥ AMT, a real TO_OUT and the fee
  const send = { payload: { op: "SEND", ticker: "LUCKY", amount: 100, toOutIdx: 0, changeOutIdx: 3 }, outputs: [out(0, { address: ADDR }), FEE(1, 546), out(2, { opReturn: true }), out(3, { address: ADDR })] };
  assert.deepEqual(routeDecision(send, { pool: { LUCKY: 150 } }).send, { vout: 0, ticker: "LUCKY", amount: 100 });
  assert.equal(routeDecision(send, { pool: { LUCKY: 50 } }).applied, false);
  const sendNoFee = { ...send, outputs: [out(0, { address: ADDR }), out(1, { address: ADDR }), out(2, { opReturn: true }), out(3, { address: ADDR })] };
  assert.equal(routeDecision(sendNoFee, { pool: { LUCKY: 150 } }).applied, false, "no fee output → not applied");
  const badChange = { ...send, payload: { ...send.payload, changeOutIdx: 9 } };
  assert.equal(routeDecision(badChange, { pool: { LUCKY: 150 } }).residualVout, 0, "CHANGE_OUT missing → the default output");
  // default output: first non-OP_RETURN; address-less → burn (no skipping)
  assert.equal(defaultOutIdx([out(0, { opReturn: true }), out(1, { address: ADDR })]), 1);
  assert.equal(defaultOutIdx([out(0), out(1, { address: ADDR })]), null, "address-less first output → burn");
  assert.equal(routeDecision({ payload: null, outputs: [out(0), out(1, { address: ADDR })] }).residualVout, null);
  // COMMIT (§2.1): recorded open iff vout0 is a real addressed output; no fee; routes to the default output.
  // H binds vout0's script — SPK_A / SPK_M are the carrier scripts of spec vectors 1 and 4.
  const SPK_A = "51200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
  const SPK_M = "0014bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const MALLORY = "bc1qmallory";
  const H = commitHashFor("NEW", "ab".repeat(16), SPK_A);
  const commitTx = { txid: TX("c"), payload: { op: "COMMIT", hash: H }, inputs: [{ txid: TX("1"), vout: 0 }], outputs: [out(0, { address: ADDR, script: SPK_A }), out(1, { opReturn: true }), out(2, { address: ADDR, sats: 9_000 })] };
  assert.deepEqual(routeDecision(commitTx).commit, { hash: H, carrier: `${TX("c")}:0`, carrier_script: SPK_A, committer: ADDR, status: "open", invalid_reason: null });
  assert.equal(routeDecision(commitTx).residualVout, 0, "token inputs of a COMMIT route to the default output");
  assert.equal(routeDecision({ ...commitTx, outputs: [out(0, { opReturn: true }), out(1, { address: ADDR })] }).commit.invalid_reason, "carrier_op_return", "vout0 an OP_RETURN → recorded invalid");
  assert.equal(routeDecision({ ...commitTx, outputs: [out(0), out(1, { opReturn: true })] }).commit.invalid_reason, "carrier_no_address", "address-less vout0 → recorded invalid");
  assert.equal(routeDecision({ ...commitTx, outputs: [] }).commit.status, "invalid", "no vout0 → recorded invalid (carrier_missing)");
  // several COMMITs may carry one H — a copy in Mallory's COMMIT is recorded open, with HIS carrier script.
  const copyTx = { ...commitTx, txid: TX("e"), outputs: [out(0, { address: MALLORY, script: SPK_M }), out(1, { opReturn: true })] };
  assert.deepEqual(routeDecision(copyTx).commit, { hash: H, carrier: `${TX("e")}:0`, carrier_script: SPK_M, committer: MALLORY, status: "open", invalid_reason: null });
  // the carrier's value is never read — a 0-sat vout0 is a carrier.
  assert.equal(routeDecision({ ...commitTx, outputs: [out(0, { address: ADDR, sats: 0 }), out(1, { opReturn: true })] }).commit.status, "open");
  // REVEAL = DEPLOY|T|SALT: input 0 spends an open commit whose H matches, 1 ≤ age ≤ 2016, exact 5,460 fee, name free
  const payloadText = `LUCKY-20|DEPLOY|NEW|${"ab".repeat(16)}`;
  const reveal = {
    txid: TX("d"),
    payload: { op: "DEPLOY", ticker: "NEW", salt: "ab".repeat(16) },
    payloadText,
    inputs: [{ txid: TX("c"), vout: 0 }, { txid: TX("2"), vout: 1 }],
    outputs: [out(0, { address: "bc1qother" }), FEE(1, 5_460), out(2, { opReturn: true })],
  };
  const open = { hash: H, carrier_script: SPK_A, height: 969_400, committer: ADDR };
  const at = (k) => (k === `${TX("c")}:0` ? open : null);
  const ok = routeDecision(reveal, { isDeployed: deployed, commitAt: at, height: 969_401 });
  assert.equal(ok.applied, true, "a reveal one block after its commit applies");
  assert.equal(ok.deployer, ADDR, "deployer = the committer (the carrier's address), not vout0's or a signer's");
  const why = (over = {}, ctx = {}) => revealRejection({ ...reveal, ...over }, { isDeployed: deployed, commit: open, height: 969_401, ...ctx });
  assert.equal(why(), null);
  assert.equal(why({ payload: { op: "DEPLOY", ticker: "NEW", salt: null } }), "commit_required", "the old 3-field DEPLOY never applies");
  assert.equal(why({}, { commit: null }), "no_commit");
  assert.equal(why({}, { commit: { ...open, status: "invalid" } }), "commit_invalid");
  assert.equal(routeDecision({ ...reveal, inputs: [{ txid: TX("2"), vout: 1 }, { txid: TX("c"), vout: 0 }] }, { isDeployed: deployed, commitAt: at, height: 969_401 }).reason, "no_commit", "the carrier must be input 0");
  assert.equal(why({ payloadText: `LUCKY-20|DEPLOY|NEW|${"cd".repeat(16)}` }), "hash_mismatch");
  assert.equal(why({}, { commit: { ...open, height: 969_299 }, height: 969_300 }), "commit_before_activation");
  assert.equal(why({}, { height: 969_400 }), "commit_too_recent", "same block as the commit");
  assert.equal(why({}, { height: 969_400 + 2_016 }), null, "the last block of the window");
  assert.equal(why({}, { height: 969_400 + 2_017 }), "commit_expired");
  assert.equal(why({ outputs: [out(0, { address: ADDR }), FEE(1, 546), out(2, { opReturn: true })] }), "fee_missing");
  assert.equal(why({ payload: { op: "DEPLOY", ticker: "LUCKY", salt: "ab".repeat(16) }, payloadText: `LUCKY-20|DEPLOY|LUCKY|${"ab".repeat(16)}` }, { commit: { ...open, hash: commitHashFor("LUCKY", "ab".repeat(16), SPK_A) } }), "ticker_taken");
  // The copy: Mallory's COMMIT of the owner's H, revealed with the owner's payload through HIS carrier → hash_mismatch,
  // even when his reveal is the only one (rule 2 comes before rule 7).
  const copied = { ...open, carrier_script: SPK_M, committer: MALLORY };
  const front = routeDecision({ ...reveal, inputs: [{ txid: TX("e"), vout: 0 }, { txid: TX("3"), vout: 1 }] }, { isDeployed: deployed, commitAt: (k) => (k === `${TX("e")}:0` ? copied : null), height: 969_401 });
  assert.equal(front.applied, false);
  assert.equal(front.reason, "hash_mismatch", "a copied H never reveals through the copier's carrier");
  assert.equal(front.deployer, null);
  assert.equal(front.committer, MALLORY, "the row names the carrier it spent");
  assert.equal(why({}, { commit: { ...open, carrier_script: "" } }), "hash_mismatch", "a record without its script never matches");
  // Spec vectors 1 and 4 through the mock's rule 2: one payload, two scripts, two hashes.
  const V = { ...reveal, payload: { op: "DEPLOY", ticker: "LUCKY", salt: "000102030405060708090a0b0c0d0e0f" }, payloadText: "LUCKY-20|DEPLOY|LUCKY|000102030405060708090a0b0c0d0e0f" };
  const V1 = "1ac55b4c608ed7c39eb3dbcecaf04c41222d5b3c37b6343477c9a91d4a6f33fc";
  const V4 = "740566381d71cf04e3ce2d5ffe62c03e65b13becf27bf963cd40e385d2e2bdf4";
  const vc = (hash, script) => ({ hash, carrier_script: script, height: 969_400, committer: ADDR });
  assert.equal(revealRejection(V, { commit: vc(V1, SPK_A), height: 969_401 }), null, "vector 1");
  assert.equal(revealRejection(V, { commit: vc(V4, SPK_M), height: 969_401 }), null, "vector 4");
  assert.equal(revealRejection(V, { commit: vc(V1, SPK_M), height: 969_401 }), "hash_mismatch", "vector 1's H through vector 4's script");
  assert.equal(REVEAL_REASONS.length, 9);
  // §7.5: the payment is judged at the listed input's index, and only a
  // spend signed SIGHASH_SINGLE|ANYONECANPAY (the listing's own signature) fills.
  const SIG64 = "11".repeat(64); // P2TR key path, SIGHASH_DEFAULT
  const SIG65 = "11".repeat(64) + "83"; // P2TR key path, 0x83
  const DER = (b) => "30" + "44".repeat(69) + b; // a DER signature ending with its sighash byte
  const PUB = "02" + "22".repeat(32);
  assert.equal(inputSighash([SIG64]), 0x00, "64-byte Schnorr: default sighash");
  assert.equal(inputSighash([SIG65]), 0x83);
  assert.equal(inputSighash([SIG65, "50aa"]), 0x83, "an annex does not hide the key-path signature");
  assert.equal(inputSighash([DER("83"), PUB]), 0x83, "P2WPKH: the DER signature's last byte");
  assert.equal(inputSighash([DER("01"), PUB]), 0x01);
  assert.equal(inputSighash([]), null);
  assert.equal(inputSighash(["00", "11", "22"]), null, "a script-path spend is no listing signature");
  // With the spent output's script type — as the indexer reads a block — the type decides the rule:
  const CONTROL33 = "c0" + "33".repeat(32); // a one-leaf taproot control block, 33 bytes like a key
  assert.equal(inputSighash([DER("83"), CONTROL33], "tr"), null, "P2TR [script, control block]: a script-path spend, never read as a P2WPKH signature");
  assert.equal(inputSighash([DER("83"), CONTROL33]), 0x83, "…which only the shape guess would misread");
  assert.equal(inputSighash([SIG65], "tr"), 0x83);
  assert.equal(inputSighash([SIG64, "50aa"], "tr"), 0x00, "annex set aside: the 64-byte default signature");
  assert.equal(inputSighash([SIG65], "wpkh"), null, "P2WPKH needs a signature and a key");
  assert.equal(inputSighash([DER("83"), "04" + "22".repeat(64)], "wpkh"), 0x83, "P2WPKH: any key element, the DER signature's last byte");
  assert.equal(inputSighash(["30" + "44".repeat(73) + "83", PUB], "wpkh"), null, "a 75-byte element is no DER signature");
  assert.equal(inputSighash([SIG65], null), null, "another script type: no listing signature");
  assert.equal(listedScriptType("bc1p" + "q".repeat(58)), "tr");
  assert.equal(listedScriptType("bc1q" + "q".repeat(38)), "wpkh");
  assert.equal(listedScriptType("bc1q" + "q".repeat(58)), null, "a 32-byte v0 program (P2WSH) is neither");
  assert.equal(listedScriptType("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"), null);
  const order = { ticker: "LUCKY", seller: "bc1qseller", price_sats: 60_000 };
  const fillAt1 = {
    payload: { op: "SEND", ticker: "LUCKY", amount: 1, toOutIdx: 2, changeOutIdx: 4 },
    outputs: [out(0, { address: ADDR, sats: 5_000 }), out(1, { address: "bc1qseller", sats: 60_000 }), out(2, { address: ADDR }), FEE(3, 546), out(4, { address: ADDR }), out(5, { opReturn: true })],
    witnesses: [[SIG64], [SIG65]],
  };
  const d1 = routeDecision(fillAt1, { pool: { LUCKY: 1 } });
  assert.equal(isFillOf(fillAt1, d1, order, 1), true, "listing at input 1 (0x83) paid at vout1 → filled");
  assert.equal(isFillOf(fillAt1, d1, order, 0), false, "judged at vout0 it would not be");
  assert.deepEqual(settleListingSpend(fillAt1, d1, order, 1), { filled: true, buyer: ADDR, selfTrade: false, priceSats: 60_000 }, "buyer = TO_OUT of the applied SEND");
  // The same layout signed with the default sighash (a withdrawal, a split, a send): never a trade.
  const withdrawn = { ...fillAt1, witnesses: [[SIG64], [SIG64]] };
  assert.equal(isFillOf(withdrawn, d1, order, 1), false, "a 64-byte signature is the seller's own spend → cancelled");
  assert.equal(isFillOf({ ...fillAt1, witnesses: [[SIG64], [DER("01"), PUB]] }, d1, order, 1), false, "SIGHASH_ALL → cancelled");
  // A withdrawal priced exactly at the listing's 546-sat minimum: the self-payment is no fill.
  const cheap = { ticker: "LUCKY", seller: ADDR, price_sats: 546 };
  const toSelf = {
    payload: { op: "SEND", ticker: "LUCKY", amount: 1, toOutIdx: 0, changeOutIdx: 3 },
    outputs: [out(0, { address: ADDR }), FEE(1, 546), out(2, { opReturn: true }), out(3, { address: ADDR }), out(4, { address: ADDR, sats: 90_000 })],
    witnesses: [[SIG64], [SIG64]],
  };
  const dSelf = routeDecision(toSelf, { pool: { LUCKY: 1 } });
  assert.equal(isFillOf(toSelf, dSelf, cheap, 0), false, "a withdrawal at the 546-sat price is cancelled, not a self-trade");
  assert.equal(isFillOf(toSelf, dSelf, { ...cheap, price_sats: 50_000 }, 4), false, "a listed carrier landing at input 4 against the change output: cancelled");
  // A 0x83 spend without the protocol fee (no SEND applies) is still a trade: the buyer is where the residual lands.
  const noFeeFill = { ...fillAt1, outputs: fillAt1.outputs.filter((o) => o.vout !== 3).map((o, i) => ({ ...o, vout: i })) };
  noFeeFill.payload = { op: "SEND", ticker: "LUCKY", amount: 1, toOutIdx: 2, changeOutIdx: 3 };
  const dNoFee = routeDecision(noFeeFill, { pool: { LUCKY: 1 } });
  assert.equal(dNoFee.applied, false, "no fee output → the SEND does not apply");
  assert.deepEqual(settleListingSpend(noFeeFill, dNoFee, order, 1), { filled: true, buyer: ADDR, selfTrade: false, priceSats: 60_000 }, "…the tokens still land on the residual output: a trade");
  // No payload at all: default routing → the lowest non-OP_RETURN output.
  const plain = { payload: null, outputs: [out(0, { address: "bc1qseller", sats: 60_000 }), out(1, { address: ADDR })], witnesses: [[SIG65], [SIG64]] };
  assert.deepEqual(settleListingSpend(plain, routeDecision(plain), order, 0), { filled: true, buyer: "bc1qseller", selfTrade: true, priceSats: 60_000 }, "tokens back on the seller's own output: a self-trade");
  const plain2 = { payload: null, outputs: [out(0, { address: ADDR }), out(1, { address: "bc1qseller", sats: 60_000 })], witnesses: [[SIG64], [SIG65]] };
  assert.deepEqual(settleListingSpend(plain2, routeDecision(plain2), order, 1), { filled: true, buyer: ADDR, selfTrade: false, priceSats: 60_000 }, "listing at input 1, tokens to vout0");
  const burn = { payload: null, outputs: [out(0, { address: null, sats: 1_000 }), out(1, { address: "bc1qseller", sats: 60_000 })], witnesses: [[SIG64], [SIG65]] };
  assert.deepEqual(settleListingSpend(burn, routeDecision(burn), order, 1), { filled: true, buyer: null, selfTrade: false, priceSats: 60_000 }, "burned tokens: a fill with no buyer");
  const short = { ...fillAt1, outputs: fillAt1.outputs.map((o) => (o.vout === 1 ? { ...o, sats: 59_999 } : o)) };
  assert.equal(isFillOf(short, d1, order, 1), false, "paying less than the price is no fill");
  console.log("mock routing: fee checks, MINE vout0 rule, default-output burn, §2.1 commit-reveal rules + carrier-bound H + committer attribution, §7.5 index all as the spec says");
}

console.log("flows: all checks passed");
