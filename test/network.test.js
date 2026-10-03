// Our node against the network: the second source's tip and projected blocks
// (src/lib/network.js), the health fields and pause reasons that follow
// from them (src/lib/sync.js). Plain Node — fetch is a stub, nothing
// leaves the machine.
import assert from "node:assert/strict";
import {
  FEES_REREAD_AFTER_TIP_MS,
  INDEXER_FEES_WAIT_MS,
  NETWORK_FEES_URL,
  NETWORK_LAG_CONFIRM_MS,
  NETWORK_TIP_URL,
  confirmedNetworkLag,
  feeSourceNote,
  feesRereadAfterTip,
  feesStillReading,
  fetchNetworkFees,
  fetchNetworkTip,
  hasFeeEstimate,
  mergeFeeSources,
  needNetworkFees,
  networkFeesFromBlocks,
  networkLag,
} from "../src/lib/network.js";
import { chainTipOf, syncPauseText, syncRetryText, syncStateOf, syncWarningText } from "../src/lib/sync.js";
import { highFeeThreshold, presetRows, resolveFeeRate } from "../src/lib/feechoice.js";
import { _sanitizeFees } from "../src/lib/indexer.js";

// ---- the second source's tip: behind by 2+ blocks on reads 90 s apart ------------------------------------------
{
  let t = networkLag(null, { networkTip: 970_206, tip: 970_206, now: 0 });
  assert.deepEqual(t, { behindSince: null, networkTip: 970_206 });
  t = networkLag(t, { networkTip: 970_208, tip: 970_206, now: 1_000 });
  assert.equal(t.behindSince, 1_000);
  assert.equal(confirmedNetworkLag(t, 970_206, 1_000), 0, "one read can race a new block");
  t = networkLag(t, { networkTip: 970_209, tip: 970_206, now: 1_000 + NETWORK_LAG_CONFIRM_MS });
  assert.equal(t.behindSince, 1_000, "the run keeps its start");
  assert.equal(confirmedNetworkLag(t, 970_206, 1_000 + NETWORK_LAG_CONFIRM_MS), 3, "behind on reads 90 s apart: 3 blocks");
  assert.equal(confirmedNetworkLag(t, 970_209, 1_000 + NETWORK_LAG_CONFIRM_MS), 0, "the node caught up: not behind");
  assert.deepEqual(networkLag(t, { networkTip: 970_207, tip: 970_206, now: 5_000_000 }).behindSince, null, "1 block is normal");
  assert.deepEqual(networkLag(t, { networkTip: null, tip: 970_206, now: 5_000_000 }), { behindSince: null, networkTip: null }, "the second source unreachable: never a pause");
  console.log("network tip: behind only on two reads ≥ 90 s apart, 2+ blocks, against the current tip");
}

// ---- sync: rebuilding / stalled / no peers / behind the network pause writes ------------------------------------
{
  const ok = { indexed_height: 970_206, tip_height: 970_206, stalled: false, node_peers: 8 };
  assert.equal(syncStateOf(ok).synced, true);
  assert.equal(syncStateOf(ok).trustUnseen, true);
  const rebuilding = syncStateOf({ ...ok, rebuilding: true });
  assert.deepEqual([rebuilding.synced, rebuilding.trustUnseen], [false, false]);
  assert.match(syncPauseText(rebuilding, "mining"), /rebuilding its state from the chain, so mining would rely on incomplete state/);
  assert.match(syncRetryText(rebuilding, "LUCKY's availability", "Publish"), /^Nothing was sent: the indexer is rebuilding its state from the chain/);
  const noPeersStalled = syncStateOf({ ...ok, stalled: true, node_peers: 0 });
  assert.match(syncPauseText(noPeersStalled, "mining"), /Bitcoin node has no peers/);
  assert.match(syncWarningText(noPeersStalled), /no peers, so what you see may be out of date/);
  const noPeers = syncStateOf({ ...ok, node_peers: 0 });
  assert.deepEqual([noPeers.synced, noPeers.noPeers, noPeers.trustUnseen], [true, true, false], "no peers yet not stalled: writes go on, but an unknown tx proves nothing");
  assert.match(syncWarningText(noPeers), /no peers right now/);
  const behind = syncStateOf(ok, { networkLag: 3 });
  assert.deepEqual([behind.synced, behind.networkLag], [false, 3]);
  assert.match(syncPauseText(behind, "token creation"), /^Our Bitcoin node is 3 blocks behind the network, so token creation would rely on stale state/);
  assert.match(syncWarningText(behind), /3 blocks behind the network/);
  assert.equal(syncWarningText(syncStateOf(ok)), null, "all current: no banner");
  assert.equal(syncWarningText(syncStateOf({ ...ok, tip_height: 970_207 })), null, "a one-block lag is normal for a few seconds");
  assert.match(syncWarningText(syncStateOf({ ...ok, tip_height: 970_211 })), /catching up: 5 blocks behind/);
  const now = 2_000_000_000_000;
  assert.match(syncWarningText(syncStateOf(ok), { tipTime: now / 1000 - 2 * 3600, now }), /No new block for about 120 minutes/);
  assert.equal(syncWarningText(syncStateOf(ok), { tipTime: now / 1000 - 30 * 60, now }), null);
  // Right after an indexer restart its node tip reads 0 (below the indexed
  // height) until the first read of the node: not synced, lag unknown.
  const booting = syncStateOf({ ...ok, tip_height: 0 });
  assert.deepEqual([booting.synced, booting.lag, booting.trustUnseen], [false, null, false], "a node tip below the indexed height is not synced");
  assert.match(syncPauseText(booting, "mining"), /has not reported how far it has indexed/);
  assert.equal(chainTipOf({ ...ok, tip_height: 0 }), 970_206, "the shown tip never drops below the indexed height");
  assert.equal(chainTipOf({ ...ok, tip_height: 970_208 }), 970_208);
  assert.equal(chainTipOf({ indexed_height: null, tip_height: 0 }), null, "a tip of 0 is unknown");
  assert.equal(chainTipOf(null), null);
  console.log("sync: rebuilding, stalled, no peers and behind-the-network each pause writes with their own sentence");
}

// ---- fees: never an ok:false number; the indexer's tiers as they are; the second source stands in -------------------
{
  const down = _sanitizeFees({ ok: false, fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, incrementalrelayfee: 1, nextBlockMedianFee: 0.5, fastSource: "template" });
  assert.deepEqual([down.ok, down.fastestFee, down.halfHourFee, down.minimumFee, down.incrementalrelayfee], [false, null, null, null, 1], "ok:false floors are never used");
  assert.deepEqual([down.fastSource, down.nextBlockMedianFee], [null, null], "…nor the median beside them");
  const own = _sanitizeFees({ ok: true, fastestFee: 4.8, halfHourFee: 3.5, hourFee: 2.25, economyFee: 1.02, minimumFee: 1, incrementalrelayfee: 0.1, nextBlockMedianFee: 4.8, fastSource: "template" });
  assert.deepEqual([own.ok, own.fastSource, own.nextBlockMedianFee], [true, "template", 4.8]);
  assert.equal(_sanitizeFees({ fastestFee: 3 }).ok, true, "an indexer that predates the flag is taken as ok");
  assert.deepEqual([_sanitizeFees({ fastestFee: 3 }).fastSource, _sanitizeFees({ fastestFee: 3 }).nextBlockMedianFee], [null, null], "…and says nothing about the median");
  assert.equal(_sanitizeFees({ ok: true, fastestFee: 3, fastSource: "guess" }).fastSource, null, "an unknown fastSource is null");
  for (const bad of [-1, "x", "0", "", true, NaN, 2e6]) assert.equal(_sanitizeFees({ ok: true, fastestFee: 3, nextBlockMedianFee: bad }).nextBlockMedianFee, null, `nextBlockMedianFee ${JSON.stringify(bad)} → null`);
  assert.equal(_sanitizeFees({ ok: true, fastestFee: 1, nextBlockMedianFee: 0.42, fastSource: "template" }).nextBlockMedianFee, 0.42, "a median below 1 is kept");
  assert.equal(_sanitizeFees({ ok: true, fastestFee: 1, nextBlockMedianFee: 0, fastSource: "template" }).nextBlockMedianFee, 0, "a median of 0 is a real median, kept");
  assert.equal(_sanitizeFees(null).fastSource, null);

  // the indexer answered: its tiers, as they are — a higher second source does not raise Fast
  const ext = networkFeesFromBlocks([{ medianFee: 40 }, { medianFee: 20 }, { medianFee: 12 }, { medianFee: 5 }]);
  const m = mergeFeeSources(own, ext);
  assert.deepEqual([m.fastestFee, m.halfHourFee, m.hourFee, m.economyFee, m.source, m.incrementalrelayfee], [4.8, 3.5, 2.25, 1.02, "indexer", 0.1], "the indexer's tiers are used as they are");
  assert.deepEqual([m.fastFromNextBlock, m.fastIsMedian, m.nextBlockMedianFee], [true, true, 4.8], "Fast is the next block's median (the node's template)");
  assert.equal(feeSourceNote(m), null, "the plain case says nothing");
  assert.ok(!("fastFrom" in m) && !("fastCapped" in m), "Fast is never raised to the second source");
  assert.deepEqual(mergeFeeSources(own, null), m, "the second source unreachable: the same");
  const estimated = mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 2, minimumFee: 1, nextBlockMedianFee: null, fastSource: "estimate" }), ext);
  assert.deepEqual([estimated.fastestFee, estimated.fastFromNextBlock, estimated.fastIsMedian, estimated.nextBlockMedianFee, estimated.source], [12, false, false, null, "indexer"], "no template: the node's estimate, not called a median");
  // a next block that is not full: Fast is a lower rate it has room at, the median stays the median
  const room = mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 3.2, fastSource: "template" }), ext);
  assert.deepEqual([room.fastestFee, room.fastFromNextBlock, room.fastIsMedian, room.nextBlockMedianFee], [1, true, false, 3.2], "Fast below the median: from the next block, not its median");
  const roomAbove1 = mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 2.5, halfHourFee: 2, hourFee: 1.5, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 4.8, fastSource: "template" }), null);
  assert.deepEqual([roomAbove1.fastFromNextBlock, roomAbove1.fastIsMedian], [true, false]);
  const noMedian = mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, fastSource: "template" }), null);
  assert.deepEqual([noMedian.fastFromNextBlock, noMedian.fastIsMedian, noMedian.nextBlockMedianFee], [true, false, null], "no median given: never called one");
  // the median against Fast as both sources derive it: max(1, the median up to hundredths)
  for (const [fast, median, is] of [[1, 0, true], [1, 0.42, true], [1, 1, true], [4.63, 4.63, true], [1.1, 1.1, true], [4.63, 4.62, false], [1, 1.01, false], [2, 1, false]]) {
    const f = mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: fast, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, nextBlockMedianFee: median, fastSource: "template" }), null);
    assert.equal(f.fastIsMedian, is, `Fast ${fast} with median ${median}: ${is ? "" : "not "}the median`);
  }
  const older = mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 2, minimumFee: 1 }), ext);
  assert.deepEqual([older.fastestFee, older.fastIsMedian], [12, false], "an indexer that does not say: not called a median");
  const noFast = mergeFeeSources(_sanitizeFees({ ok: true, halfHourFee: 30, hourFee: 20, fastSource: "template", nextBlockMedianFee: 31 }), ext);
  assert.deepEqual([noFast.fastestFee, noFast.halfHourFee, noFast.fastFromNextBlock, noFast.fastIsMedian, noFast.nextBlockMedianFee], [null, 30, false, false, null], "no fast tier: nothing filled in from elsewhere");

  // the indexer has none: the second source's projected blocks, said so
  const stand = mergeFeeSources(down, ext);
  assert.deepEqual([stand.fastestFee, stand.halfHourFee, stand.hourFee, stand.economyFee, stand.minimumFee, stand.source], [40, 20, 12, 5, 1, "second"], "the indexer has none: the second source's, said so");
  assert.deepEqual([stand.fastFromNextBlock, stand.fastIsMedian, stand.nextBlockMedianFee, stand.ok, stand.incrementalrelayfee], [true, true, 40, false, 1], "its Fast is its next block's median; ok and the increment stay the indexer's");
  const quietExt = mergeFeeSources(down, networkFeesFromBlocks([{ medianFee: 0.413 }]));
  assert.deepEqual([quietExt.fastestFee, quietExt.fastIsMedian, quietExt.nextBlockMedianFee], [1, true, 0.42], "a quiet second source: the minimum, still its median floored");
  assert.equal(feeSourceNote(stand), "The indexer's node has no fee estimate right now — these are mempool.space's.");
  assert.equal(mergeFeeSources(null, ext).source, "second", "the indexer unreachable: the same");
  const none = mergeFeeSources(down, null);
  assert.deepEqual([none.fastestFee, none.source, none.fastFromNextBlock, none.fastIsMedian, none.nextBlockMedianFee], [null, null, false, false, null]);
  assert.equal(feeSourceNote(none), null);
  assert.ok(presetRows(none).every((r) => r.satVb === null && r.reason === "missing"), "neither: every preset off (Custom still works)");
  assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, none), null);
  assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, m), 4.8);
  assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, stand), 40);
  assert.equal(highFeeThreshold(m), 50, "the high custom-rate confirmation still starts at max(50, 2 × Fast)");
  assert.equal(highFeeThreshold(stand), 80);
  assert.equal(hasFeeEstimate(own), true);
  assert.equal(hasFeeEstimate(down), false, "ok:false: no estimate — the second source is read");
  assert.equal(hasFeeEstimate(null), false);
  console.log("fees: ok:false never used; the indexer's tiers as they are (Fast = its next-block median); the second source stands in, else Custom only");
}

// ---- when the second source is read: the indexer has no estimate to use; sticky across re-reads -----------------
{
  const own = _sanitizeFees({ ok: true, fastestFee: 4.8, halfHourFee: 3.5, hourFee: 2.25, economyFee: 1.02, minimumFee: 1, nextBlockMedianFee: 4.8, fastSource: "template" });
  const down = _sanitizeFees({ ok: false, fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 });
  const failed = new Error("Indexer timeout");
  // page load: no answer yet — not read until INDEXER_FEES_WAIT_MS has passed, then read
  assert.equal(needNetworkFees({ data: null, error: null, loading: true }), false, "the first /fees is still on its way");
  assert.equal(needNetworkFees({ data: null, error: null, loading: true }, true), true, "a hanging first /fees: read after the wait");
  assert.ok(INDEXER_FEES_WAIT_MS > 0 && INDEXER_FEES_WAIT_MS <= 15_000, "well before the indexer request's own 30 s timeout");
  // the indexer answered with an estimate: not read, even while a re-read (new tip) runs
  assert.equal(needNetworkFees({ data: own, error: null, loading: false }), false);
  assert.equal(needNetworkFees({ data: own, error: null, loading: true }), false);
  // it answered without one (ok:false), or its read failed: read — and still read while the next read runs
  assert.equal(needNetworkFees({ data: down, error: null, loading: false }), true);
  assert.equal(needNetworkFees({ data: down, error: null, loading: true }), true, "a re-read does not blank the stand-in out");
  assert.equal(needNetworkFees({ data: null, error: failed, loading: false }), true);
  assert.equal(needNetworkFees({ data: null, error: failed, loading: true }), true, "a failed first read stays failed while it is retried on a new tip");
  assert.equal(needNetworkFees({ data: own, error: failed, loading: false }), true, "a failed read: its older answer is not used either");
  assert.equal(needNetworkFees(null), true);
  console.log("second source read: only while the indexer has no estimate to use (or its first /fees hangs past the wait); sticky across re-reads");
}

// ---- still reading: no estimate yet, but a read that may bring one has not answered ------------------------------
{
  const own = _sanitizeFees({ ok: true, fastestFee: 4.8, halfHourFee: 3.5, hourFee: 2.25, economyFee: 1.02, minimumFee: 1, nextBlockMedianFee: 4.8, fastSource: "template" });
  const down = _sanitizeFees({ ok: false, fastestFee: 1 });
  const failed = new Error("Indexer timeout");
  const waiting = { data: null, error: null, loading: true, updatedAt: null };
  const idle = { data: null, error: null, loading: false, updatedAt: null }; // a poll that was off, the render before it starts
  const reading = (feesPoll, netPoll) => {
    const needNet = needNetworkFees(feesPoll, false);
    const merged = mergeFeeSources(feesPoll.error ? null : feesPoll.data, netPoll.error ? null : netPoll.data);
    return feesStillReading({ hasFees: merged.source !== null, feesPoll, needNet, netPoll });
  };
  // page load: the indexer's first /fees has not answered
  assert.equal(reading(waiting, idle), true, "the first /fees is on its way");
  // the indexer answered with an estimate: nothing is being waited for
  assert.equal(reading({ data: own, error: null, loading: false, updatedAt: 1 }, idle), false);
  // the indexer failed or had none: the second source is read — reading until it answers
  for (const ind of [{ data: null, error: failed, loading: false, updatedAt: 1 }, { data: down, error: null, loading: false, updatedAt: 1 }]) {
    assert.equal(reading(ind, idle), true, "the stand-in's poll has not started yet: still reading, never 'none'");
    assert.equal(reading(ind, waiting), true, "the stand-in is loading: still reading");
    assert.equal(reading(ind, { data: networkFeesFromBlocks([{ medianFee: 6 }]), error: null, loading: false, updatedAt: 2 }), false, "it answered with rates");
    assert.equal(reading(ind, { data: null, error: null, loading: false, updatedAt: 2 }), false, "it answered with nothing usable: none");
    assert.equal(reading(ind, { data: null, error: failed, loading: false, updatedAt: 2 }), false, "it failed: none");
  }
  assert.equal(feesStillReading({ hasFees: true, feesPoll: waiting, needNet: true, netPoll: waiting }), false, "an estimate in hand is never 'reading'");
  assert.equal(feesStillReading({ hasFees: false, feesPoll: null, needNet: false, netPoll: null }), false, "nothing to wait for: not reading");
  console.log("still reading: while the first /fees or the needed stand-in has not answered; 'none' only after");
}

// ---- one more /fees read after each tip change ------------------------------------------------------------------
{
  assert.ok(FEES_REREAD_AFTER_TIP_MS > 12_000 && FEES_REREAD_AFTER_TIP_MS <= 20_000, "after the indexer's ~12 s template read, well before the 30 s poll");
  assert.equal(feesRereadAfterTip(970_206, 970_207), FEES_REREAD_AFTER_TIP_MS, "a new block");
  assert.equal(feesRereadAfterTip(970_207, 970_206), FEES_REREAD_AFTER_TIP_MS, "a reorg to a lower tip is a change too");
  assert.equal(feesRereadAfterTip(970_206, 970_206), null, "the same tip: no extra read");
  assert.equal(feesRereadAfterTip(null, 970_206), null, "the first tip the page learns: read with the page");
  assert.equal(feesRereadAfterTip(0, 970_206), null);
  assert.equal(feesRereadAfterTip(970_206, null), null, "an unknown tip: nothing");
  assert.equal(feesRereadAfterTip(970_206, 0), null);
  assert.equal(feesRereadAfterTip(970_206.5, 970_207), null);
  console.log("tip change: /fees is read once more FEES_REREAD_AFTER_TIP_MS later");
}

// ---- the second source's projected blocks → tiers ---------------------------------------------------------------
{
  // a real-looking answer: medians are long decimals, the last block holds the rest of the mempool
  const real = [
    { blockSize: 1_812_000, blockVSize: 997_986.5, nTx: 4_021, totalFees: 5_123_456, medianFee: 4.623157894736842, feeRange: [4.01, 4.2, 4.5, 4.62, 5, 8, 302.5] },
    { blockSize: 1_640_000, blockVSize: 997_990, nTx: 3_870, totalFees: 3_401_200, medianFee: 3.0012, feeRange: [2.5, 3, 3.5] },
    { blockSize: 1_701_000, blockVSize: 998_000, nTx: 4_100, totalFees: 2_200_000, medianFee: 2.1, feeRange: [2, 2.1, 2.3] },
    { blockSize: 1_650_000, blockVSize: 997_000, nTx: 3_990, totalFees: 1_500_000, medianFee: 1.5, feeRange: [1.2, 1.5, 1.9] },
    { blockSize: 9_100_000, blockVSize: 6_210_000, nTx: 31_000, totalFees: 900_000, medianFee: 0.31, feeRange: [0.1, 0.3, 1] },
  ];
  assert.deepEqual(networkFeesFromBlocks(real), { fastestFee: 4.63, halfHourFee: 3.01, hourFee: 2.1, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 4.63 }, "next / second / third block medians up to hundredths; the last block's below 1 floors at 1");
  // fewer blocks: a missing tier is the one before it; the last block may be the next one
  assert.deepEqual(networkFeesFromBlocks([{ medianFee: 7.2 }]), { fastestFee: 7.2, halfHourFee: 7.2, hourFee: 7.2, economyFee: 7.2, minimumFee: 1, nextBlockMedianFee: 7.2 });
  assert.deepEqual(networkFeesFromBlocks([{ medianFee: 7.2 }, { medianFee: 3 }]), { fastestFee: 7.2, halfHourFee: 3, hourFee: 3, economyFee: 3, minimumFee: 1, nextBlockMedianFee: 7.2 });
  // monotonic: a later block's median above an earlier one is clamped down
  assert.deepEqual(networkFeesFromBlocks([{ medianFee: 5 }, { medianFee: 6 }, { medianFee: 9 }, { medianFee: 8 }]), { fastestFee: 5, halfHourFee: 5, hourFee: 5, economyFee: 5, minimumFee: 1, nextBlockMedianFee: 5 });
  // a quiet mempool: every median below 1 → 1 sat/vB tiers, the raw median kept (rounded up to hundredths)
  assert.deepEqual(networkFeesFromBlocks([{ medianFee: 0.413 }, { medianFee: 0.2 }]), { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 0.42 });
  // a median of 0 is a real median: the tiers still floor at 1
  assert.deepEqual(networkFeesFromBlocks([{ medianFee: 0 }]), { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 0 });
  assert.deepEqual(networkFeesFromBlocks([{ medianFee: 3 }, { medianFee: 0 }, { medianFee: 0 }]), { fastestFee: 3, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 3 });
  const zeroNext = mergeFeeSources(null, networkFeesFromBlocks([{ medianFee: 0 }]));
  assert.deepEqual([zeroNext.fastestFee, zeroNext.fastFromNextBlock, zeroNext.fastIsMedian, zeroNext.nextBlockMedianFee], [1, true, true, 0]);
  assert.equal(presetRows(zeroNext)[0].title, "Fast — 1 sat/vB, the minimum: the next block's median fee rate is 0 sat/vB right now");
  // binary noise at an exact hundredth is not rounded up
  assert.equal(networkFeesFromBlocks([{ medianFee: 4.6 }]).fastestFee, 4.6);
  assert.equal(networkFeesFromBlocks([{ medianFee: 1.1 }]).fastestFee, 1.1);
  assert.equal(networkFeesFromBlocks([{ medianFee: 2.375 }]).fastestFee, 2.38);
  // a malformed later block is skipped (the tier before it); a malformed last block makes Economy 1
  assert.deepEqual(networkFeesFromBlocks([{ medianFee: 9 }, { medianFee: "x" }, { medianFee: 4 }, null]), { fastestFee: 9, halfHourFee: 9, hourFee: 4, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 9 });
  // no usable next block: nothing
  for (const bad of [null, undefined, [], {}, "x", [{}], [{ medianFee: null }], [{ medianFee: "" }], [{ medianFee: "4" }], [{ medianFee: true }], [{ medianFee: -2 }], [{ medianFee: -0.01 }], [{ medianFee: 2e6 }], [{ medianFee: NaN }], [null, { medianFee: 3 }], { fastestFee: 9 }]) {
    assert.equal(networkFeesFromBlocks(bad), null, `${JSON.stringify(bad)} → null`);
  }
  // above the 1,000 sat/vB safety cap: kept, so the selector rejects it visibly
  const wild = networkFeesFromBlocks([{ medianFee: 5_000 }]);
  assert.equal(wild.fastestFee, 5_000);
  assert.equal(presetRows(mergeFeeSources(null, wild))[0].reason, "over-cap");
  console.log("second source: next / second / third / last projected block medians → Fast / Normal / Slow / Economy, up to hundredths, floor 1, monotonic");
}

// ---- the selector: Fast says it is the next block's median -----------------------------------------------------
{
  const own = _sanitizeFees({ ok: true, fastestFee: 4.8, halfHourFee: 3.5, hourFee: 2.25, economyFee: 1.02, minimumFee: 1, nextBlockMedianFee: 4.8, fastSource: "template" });
  const rows = presetRows(mergeFeeSources(own, null));
  assert.deepEqual(rows.map((r) => [r.id, r.satVb, r.eta]), [["fast", 4.8, "next block"], ["normal", 3.5, "~30 min"], ["slow", 2.25, "~1 h"], ["economy", 1.02, "> 1 h"]]);
  assert.equal(rows[0].title, "Fast — 4.8 sat/vB, the next block's median fee rate right now");
  assert.equal(rows[1].title, "Normal — 3.5 sat/vB, ~30 min");
  const quiet = presetRows(mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 0.42, fastSource: "template" }), null));
  assert.equal(quiet[0].title, "Fast — 1 sat/vB, the minimum: the next block's median fee rate is 0.42 sat/vB right now", "a median below the minimum is said");
  const zero = presetRows(mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 0, fastSource: "template" }), null));
  assert.equal(zero[0].title, "Fast — 1 sat/vB, the minimum: the next block's median fee rate is 0 sat/vB right now", "a median of 0 is below the minimum too");
  // a next block that is not full: Fast is a rate it has room at — never called its median
  const room = presetRows(mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 3.2, fastSource: "template" }), null));
  assert.deepEqual([room[0].eta, room[0].title], ["next block", "Fast — 1 sat/vB, the next block has room at this rate"]);
  const roomAbove1 = presetRows(mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 2.5, halfHourFee: 2, hourFee: 1.5, economyFee: 1, minimumFee: 1, nextBlockMedianFee: 4.8, fastSource: "template" }), null));
  assert.equal(roomAbove1[0].title, "Fast — 2.5 sat/vB, the next block has room at this rate");
  const est = presetRows(mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 2, minimumFee: 1, fastSource: "estimate" }), null));
  assert.deepEqual([est[0].eta, est[0].title], ["~10–20 min", "Fast — 12 sat/vB, ~10–20 min"], "the node's estimate: the plain ETA, no median claim");
  const second = presetRows(mergeFeeSources(null, networkFeesFromBlocks([{ medianFee: 6.2 }, { medianFee: 4 }])));
  assert.deepEqual([second[0].eta, second[0].title], ["next block", "Fast — 6.2 sat/vB, the next block's median fee rate right now"], "the second source's next block: also its median");
  const off = presetRows(null);
  assert.deepEqual([off[0].eta, off[0].title], ["~10–20 min", "Fast — estimate unavailable"]);
  const overCap = presetRows({ fastestFee: 50_000, fastFromNextBlock: true, fastIsMedian: true })[0];
  assert.match(overCap.title, /^Fast — estimate unavailable — the fee estimate is above the 1,000 sat\/vB safety cap/);
  assert.doesNotMatch(overCap.title, /indexer/, "whichever source it came from");
  console.log("selector: Fast reads 'next block' and is called the next block's median only when it is; the node's estimate keeps the plain ETA");
}

// ---- the fetchers: fixed URLs, no user data, never throw -------------------------------------------------------
{
  const seen = [];
  const reply = (body, ok = true) => async (url, init) => {
    seen.push({ url, init });
    return { ok, json: async () => body };
  };
  assert.equal(await fetchNetworkTip({ fetchImpl: reply(970_208) }), 970_208);
  assert.equal(seen[0].url, NETWORK_TIP_URL);
  assert.equal(seen[0].init.credentials, "omit");
  assert.equal(await fetchNetworkTip({ fetchImpl: reply("oops") }), null);
  assert.equal(await fetchNetworkTip({ fetchImpl: reply(5, false) }), null, "an HTTP error is 'unknown'");
  assert.equal(await fetchNetworkTip({ fetchImpl: async () => { throw new Error("offline"); } }), null, "a network error is 'unknown'");
  assert.deepEqual(await fetchNetworkFees({ fetchImpl: reply([{ medianFee: 9 }, { medianFee: 6 }, { medianFee: 4 }, { medianFee: 2 }]) }), { fastestFee: 9, halfHourFee: 6, hourFee: 4, economyFee: 2, minimumFee: 1, nextBlockMedianFee: 9 });
  assert.equal(seen[seen.length - 1].url, NETWORK_FEES_URL);
  assert.equal(NETWORK_FEES_URL, "https://mempool.space/api/v1/fees/mempool-blocks", "the projected blocks, not the recommended rates");
  assert.equal(await fetchNetworkFees({ fetchImpl: reply({ fastestFee: 9 }) }), null, "the recommended-rates shape is not read as blocks");
  assert.equal(await fetchNetworkFees({ fetchImpl: reply([{ medianFee: 9 }], false) }), null, "an HTTP error is 'unknown'");
  assert.ok(seen.every((s) => !/[?&]/.test(s.url)), "no query string — nothing about the user");
  console.log("network fetchers: two fixed URLs, credentials omitted, failures are unknown");
}

console.log("network: all checks passed");
