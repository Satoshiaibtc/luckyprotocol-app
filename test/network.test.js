// Our node against the network: the second source's tip and fee rates
// (src/lib/network.js), the health fields and pause reasons that follow
// from them (src/lib/sync.js). Plain Node — fetch is a stub, nothing
// leaves the machine.
import assert from "node:assert/strict";
import {
  NETWORK_FEES_URL,
  NETWORK_LAG_CONFIRM_MS,
  NETWORK_TIP_URL,
  confirmedNetworkLag,
  feeSourceNote,
  fetchNetworkFees,
  fetchNetworkTip,
  mergeFeeSources,
  networkLag,
  sanitizeNetworkFees,
} from "../src/lib/network.js";
import { chainTipOf, syncPauseText, syncRetryText, syncStateOf, syncWarningText } from "../src/lib/sync.js";
import { highFeeThreshold, presetRows, resolveFeeRate } from "../src/lib/feechoice.js";
import { _sanitizeFees } from "../src/lib/indexer.js";

// ---- the second source's tip: behind by 2+ blocks on reads 90 s apart ------------------------------------------
{
  let t = networkLag(null, { networkTip: 969_810, tip: 969_810, now: 0 });
  assert.deepEqual(t, { behindSince: null, networkTip: 969_810 });
  t = networkLag(t, { networkTip: 969_812, tip: 969_810, now: 1_000 });
  assert.equal(t.behindSince, 1_000);
  assert.equal(confirmedNetworkLag(t, 969_810, 1_000), 0, "one read can race a new block");
  t = networkLag(t, { networkTip: 969_813, tip: 969_810, now: 1_000 + NETWORK_LAG_CONFIRM_MS });
  assert.equal(t.behindSince, 1_000, "the run keeps its start");
  assert.equal(confirmedNetworkLag(t, 969_810, 1_000 + NETWORK_LAG_CONFIRM_MS), 3, "behind on reads 90 s apart: 3 blocks");
  assert.equal(confirmedNetworkLag(t, 969_813, 1_000 + NETWORK_LAG_CONFIRM_MS), 0, "the node caught up: not behind");
  assert.deepEqual(networkLag(t, { networkTip: 969_811, tip: 969_810, now: 5_000_000 }).behindSince, null, "1 block is normal");
  assert.deepEqual(networkLag(t, { networkTip: null, tip: 969_810, now: 5_000_000 }), { behindSince: null, networkTip: null }, "the second source unreachable: never a pause");
  console.log("network tip: behind only on two reads ≥ 90 s apart, 2+ blocks, against the current tip");
}

// ---- sync: rebuilding / stalled / no peers / behind the network pause writes ------------------------------------
{
  const ok = { indexed_height: 969_810, tip_height: 969_810, stalled: false, node_peers: 8 };
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
  assert.equal(syncWarningText(syncStateOf({ ...ok, tip_height: 969_811 })), null, "a one-block lag is normal for a few seconds");
  assert.match(syncWarningText(syncStateOf({ ...ok, tip_height: 969_815 })), /catching up: 5 blocks behind/);
  const now = 2_000_000_000_000;
  assert.match(syncWarningText(syncStateOf(ok), { tipTime: now / 1000 - 2 * 3600, now }), /No new block for about 120 minutes/);
  assert.equal(syncWarningText(syncStateOf(ok), { tipTime: now / 1000 - 30 * 60, now }), null);
  // Right after an indexer restart its node tip reads 0 (below the indexed
  // height) until the first read of the node: not synced, lag unknown.
  const booting = syncStateOf({ ...ok, tip_height: 0 });
  assert.deepEqual([booting.synced, booting.lag, booting.trustUnseen], [false, null, false], "a node tip below the indexed height is not synced");
  assert.match(syncPauseText(booting, "mining"), /has not reported how far it has indexed/);
  assert.equal(chainTipOf({ ...ok, tip_height: 0 }), 969_810, "the shown tip never drops below the indexed height");
  assert.equal(chainTipOf({ ...ok, tip_height: 969_812 }), 969_812);
  assert.equal(chainTipOf({ indexed_height: null, tip_height: 0 }), null, "a tip of 0 is unknown");
  assert.equal(chainTipOf(null), null);
  console.log("sync: rebuilding, stalled, no peers and behind-the-network each pause writes with their own sentence");
}

// ---- fees: never an ok:false number; Fast follows the higher estimate; the second source stands in -------------------
{
  const down = _sanitizeFees({ ok: false, fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1, incrementalrelayfee: 1 });
  assert.deepEqual([down.ok, down.fastestFee, down.halfHourFee, down.minimumFee, down.incrementalrelayfee], [false, null, null, null, 1], "ok:false floors are never used");
  const own = _sanitizeFees({ ok: true, fastestFee: 2.38, halfHourFee: 1.5, hourFee: 1.25, economyFee: 1.02, minimumFee: 1, incrementalrelayfee: 0.1 });
  assert.equal(own.ok, true);
  assert.equal(_sanitizeFees({ fastestFee: 3 }).ok, true, "an indexer that predates the flag is taken as ok");
  const ext = sanitizeNetworkFees({ fastestFee: 40, halfHourFee: 20, hourFee: 12, economyFee: 5, minimumFee: 2 });
  const m = mergeFeeSources(own, ext);
  assert.deepEqual([m.fastestFee, m.halfHourFee, m.source, m.fastFrom, m.incrementalrelayfee], [40, 1.5, "indexer", "second", 0.1], "a rush shows on the second source first: Fast follows it");
  assert.match(feeSourceNote(m), /Fast follows mempool\.space/);
  assert.deepEqual([mergeFeeSources(own, { ...ext, fastestFee: 2 }).fastestFee, mergeFeeSources(own, { ...ext, fastestFee: 2 }).fastFrom], [2.38, "indexer"]);
  assert.equal(mergeFeeSources(own, null).fastestFee, 2.38, "the second source unreachable: the indexer's");
  // a faulty second source cannot make Fast overpay silently: the raise stops where a custom rate asks for a confirmation
  const low = _sanitizeFees({ ok: true, fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 2, minimumFee: 1 });
  const wild = mergeFeeSources(low, sanitizeNetworkFees({ fastestFee: 800, halfHourFee: 600, hourFee: 400, economyFee: 200, minimumFee: 100 }));
  assert.deepEqual([wild.fastestFee, wild.fastFrom, wild.fastCapped, wild.halfHourFee], [50, "second", true, 8], "12 vs 800: Fast is max(50, 2 × 12) = 50; the other tiers stay the indexer's");
  assert.match(feeSourceNote(wild), /up to 50 sat\/vB; pick Custom for more/);
  assert.equal(highFeeThreshold(wild), 100, "a custom 800 still asks for a confirmation");
  const busy = mergeFeeSources(_sanitizeFees({ ok: true, fastestFee: 40, halfHourFee: 30, hourFee: 20, economyFee: 10, minimumFee: 1 }), sanitizeNetworkFees({ fastestFee: 800 }));
  assert.deepEqual([busy.fastestFee, busy.fastCapped], [80, true], "own fastest 40: at most 2 × 40");
  assert.equal(m.fastCapped, false, "40 against 2.38 is inside the bound (50): followed as it is");
  const noFast = mergeFeeSources(_sanitizeFees({ ok: true, halfHourFee: 30, hourFee: 20 }), sanitizeNetworkFees({ fastestFee: 800 }));
  assert.equal(noFast.fastestFee, 60, "no own fast estimate: bounded by 2 × its half-hour one");
  const stand = mergeFeeSources(down, ext);
  assert.deepEqual([stand.fastestFee, stand.hourFee, stand.source], [40, 12, "second"], "the indexer has none: the second source's, said so");
  assert.match(feeSourceNote(stand), /has no fee estimate right now — these are mempool\.space's/);
  const none = mergeFeeSources(down, null);
  assert.deepEqual([none.fastestFee, none.source], [null, null]);
  assert.ok(presetRows(none).every((r) => r.satVb === null && r.reason === "missing"), "neither: every preset off (Custom still works)");
  assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, none), null);
  assert.equal(resolveFeeRate({ kind: "preset", id: "fast" }, m), 40);
  assert.equal(sanitizeNetworkFees({ fastestFee: "x", halfHourFee: -1 }), null);
  assert.equal(sanitizeNetworkFees(null), null);
  console.log("fees: ok:false never used; Fast = the higher of the two estimates, the raise bounded at max(50, 2 × our own); the second source stands in, else Custom only");
}

// ---- the fetchers: fixed URLs, no user data, never throw -------------------------------------------------------
{
  const seen = [];
  const reply = (body, ok = true) => async (url, init) => {
    seen.push({ url, init });
    return { ok, json: async () => body };
  };
  assert.equal(await fetchNetworkTip({ fetchImpl: reply(969_812) }), 969_812);
  assert.equal(seen[0].url, NETWORK_TIP_URL);
  assert.equal(seen[0].init.credentials, "omit");
  assert.equal(await fetchNetworkTip({ fetchImpl: reply("oops") }), null);
  assert.equal(await fetchNetworkTip({ fetchImpl: reply(5, false) }), null, "an HTTP error is 'unknown'");
  assert.equal(await fetchNetworkTip({ fetchImpl: async () => { throw new Error("offline"); } }), null, "a network error is 'unknown'");
  assert.deepEqual(await fetchNetworkFees({ fetchImpl: reply({ fastestFee: 9, halfHourFee: 6, hourFee: 4, economyFee: 2, minimumFee: 1 }) }), { fastestFee: 9, halfHourFee: 6, hourFee: 4, economyFee: 2, minimumFee: 1 });
  assert.equal(seen[seen.length - 1].url, NETWORK_FEES_URL);
  assert.ok(seen.every((s) => !/[?&]/.test(s.url)), "no query string — nothing about the user");
  console.log("network fetchers: two fixed URLs, credentials omitted, failures are unknown");
}

console.log("network: all checks passed");
