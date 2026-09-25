// Pure-part tests for src/lib/pending.js — the persisted registry of
// outpoints that will carry tokens once a just-broadcast tx confirms.
// Plain Node, no framework, no window: a fake { getItem, setItem,
// removeItem } storage and an injectable clock drive the store.
import assert from "node:assert/strict";
import {
  PENDING_KEY_PREFIX,
  PENDING_TTL_MS,
  addToPendingRecord,
  createPendingStore,
  mergeOutpoints,
  outpointId,
  parsePendingRecord,
  pendingRecordOutpoints,
  pendingStorageKey,
  prunePendingRecord,
  serializePendingRecord,
} from "../src/lib/pending.js";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);
const ADDR = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const H = 60 * 60 * 1000;

function fakeStorage() {
  const m = new Map();
  const calls = { get: 0, set: 0, remove: 0 };
  return {
    m,
    calls,
    getItem: (k) => {
      calls.get += 1;
      return m.has(k) ? m.get(k) : null;
    },
    setItem: (k, v) => {
      calls.set += 1;
      m.set(k, String(v));
    },
    removeItem: (k) => {
      calls.remove += 1;
      m.delete(k);
    },
  };
}

// ---- constants + keys ---------------------------------------------------------------------------
assert.equal(PENDING_TTL_MS, 2 * H, "2-hour TTL");
assert.equal(PENDING_KEY_PREFIX, "lp.pending.");
assert.equal(pendingStorageKey(ADDR), `lp.pending.${ADDR}`);
assert.equal(pendingStorageKey(ADDR.toUpperCase()), `lp.pending.${ADDR}`, "keyed case-insensitively");
assert.equal(pendingStorageKey(null), "lp.pending.*", "no address → shared bucket");
assert.equal(pendingStorageKey(""), "lp.pending.*");

// ---- outpointId --------------------------------------------------------------------------------
assert.equal(outpointId({ txid: A.toUpperCase(), vout: 3 }), `${A}:3`);
assert.equal(outpointId({ txid: A, vout: "0" }), `${A}:0`, "numeric strings accepted");
assert.equal(outpointId({ txid: "xx", vout: 0 }), null);
assert.equal(outpointId({ txid: A, vout: -1 }), null);
assert.equal(outpointId({ txid: A, vout: 1.5 }), null);
assert.equal(outpointId(null), null);

// ---- prune: TTL / eviction ----------------------------------------------------------------------
{
  const now = 10 * H;
  const rec = {
    [`${A}:0`]: now - 1,                 // fresh
    [`${B}:1`]: now - 2 * H,             // exactly at the TTL → kept
    [`${C}:2`]: now - 2 * H - 1,         // one ms past → evicted
    [`${A}:9`]: now + 5 * H,             // future stamp → re-stamped to now
    "garbage": now,                      // malformed key → dropped
    [`${B}:x`]: now,                     // malformed vout → dropped
    [`${C}:3`]: "not a number",          // malformed stamp → dropped
  };
  const pruned = prunePendingRecord(rec, now);
  assert.deepEqual(Object.keys(pruned).sort(), [`${A}:0`, `${A}:9`, `${B}:1`].sort());
  assert.equal(pruned[`${A}:9`], now, "future stamps are clamped to now");
  assert.notEqual(pruned, rec, "returns a new object");
  assert.deepEqual(prunePendingRecord(null, now), {});
  assert.deepEqual(prunePendingRecord("nope", now), {});
  // custom ttl
  assert.deepEqual(Object.keys(prunePendingRecord({ [`${A}:0`]: now - 5_000 }, now, 1_000)), []);
}

// ---- parse / serialize -------------------------------------------------------------------------
{
  const now = 5 * H;
  assert.deepEqual(parsePendingRecord(null, now), {});
  assert.deepEqual(parsePendingRecord("", now), {});
  assert.deepEqual(parsePendingRecord("{not json", now), {});
  assert.deepEqual(parsePendingRecord("[1,2]", now), {});
  const raw = serializePendingRecord({ [`${A}:0`]: now - 1, [`${B}:0`]: now - 3 * H });
  assert.deepEqual(parsePendingRecord(raw, now), { [`${A}:0`]: now - 1 }, "expired entry pruned on parse");
  assert.equal(serializePendingRecord(null), "{}");
}

// ---- add / list / merge --------------------------------------------------------------------------
{
  const now = 7 * H;
  const rec = addToPendingRecord({}, [{ txid: A, vout: 0 }, { txid: A, vout: 3 }, { txid: "bad", vout: 0 }, null], now);
  assert.deepEqual(rec, { [`${A}:0`]: now, [`${A}:3`]: now });
  const rec2 = addToPendingRecord(rec, [{ txid: A.toUpperCase(), vout: 0 }], now + 10);
  assert.equal(rec2[`${A}:0`], now + 10, "re-adding refreshes the stamp");
  assert.equal(Object.keys(rec2).length, 2);
  assert.deepEqual(pendingRecordOutpoints(rec2).sort((x, y) => x.vout - y.vout), [{ txid: A, vout: 0 }, { txid: A, vout: 3 }]);
  assert.deepEqual(pendingRecordOutpoints(null), []);
  assert.deepEqual(
    mergeOutpoints([{ txid: A, vout: 0 }, { txid: B, vout: 1 }], [{ txid: A.toUpperCase(), vout: 0 }, { txid: C, vout: 2 }, { txid: "bad", vout: 0 }]),
    [{ txid: A, vout: 0 }, { txid: B, vout: 1 }, { txid: C, vout: 2 }],
    "indexer ∪ pending, deduplicated, malformed dropped",
  );
}

// ---- store: persistence keyed by address, TTL eviction on read ---------------------------------------
{
  let t = 100 * H;
  const storage = fakeStorage();
  const store = createPendingStore({ storage, now: () => t });
  assert.equal(store.backend(), "storage");
  assert.deepEqual(store.list(ADDR), []);
  store.add([{ txid: A, vout: 0 }, { txid: A, vout: 3 }], ADDR);
  assert.deepEqual(store.list(ADDR).map((o) => `${o.txid}:${o.vout}`).sort(), [`${A}:0`, `${A}:3`]);
  assert.ok(storage.m.has(`lp.pending.${ADDR}`), "persisted under the address key");
  assert.deepEqual(JSON.parse(storage.m.get(`lp.pending.${ADDR}`)), { [`${A}:0`]: t, [`${A}:3`]: t }, "stored shape: outpoint → addedAt");
  // another address sees nothing; a second store over the same storage (a reload) sees everything
  assert.deepEqual(store.list("bc1qother"), []);
  const reloaded = createPendingStore({ storage, now: () => t });
  assert.equal(reloaded.list(ADDR).length, 2, "survives a reload");
  // TTL: one entry ages out, the other (re-added later) stays; the pruned record is written back
  t += H;
  store.add([{ txid: B, vout: 1 }], ADDR);
  t += H + 1; // A:* are now 2h+1ms old, B:1 is 1h+1ms old
  assert.deepEqual(store.list(ADDR), [{ txid: B, vout: 1 }], "expired outpoints evicted on read");
  assert.deepEqual(JSON.parse(storage.m.get(`lp.pending.${ADDR}`)), { [`${B}:1`]: t - H - 1 }, "pruned record written back");
  t += 2 * H;
  assert.deepEqual(store.list(ADDR), [], "everything expired");
  assert.equal(storage.m.has(`lp.pending.${ADDR}`), false, "empty record removed from storage");
  // withPending merges
  store.add([{ txid: C, vout: 4 }], ADDR);
  assert.deepEqual(store.withPending([{ txid: A, vout: 0 }, { txid: C, vout: 4 }], ADDR), [{ txid: A, vout: 0 }, { txid: C, vout: 4 }]);
  assert.deepEqual(store.withPending([{ txid: A, vout: 0 }], ADDR), [{ txid: A, vout: 0 }, { txid: C, vout: 4 }]);
  store.clear(ADDR);
  assert.deepEqual(store.list(ADDR), []);
  // garbage in storage is tolerated and replaced
  storage.m.set(`lp.pending.${ADDR}`, "{{{");
  assert.deepEqual(store.list(ADDR), []);
  assert.equal(storage.m.has(`lp.pending.${ADDR}`), false, "garbage record removed");
}

// ---- store: storage that throws mid-session falls back to memory ------------------------------------------
{
  let t = 0;
  const storage = fakeStorage();
  const store = createPendingStore({ storage, now: () => t });
  store.add([{ txid: A, vout: 0 }], ADDR);
  storage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  store.add([{ txid: B, vout: 0 }], ADDR); // must not throw
  assert.equal(store.backend(), "memory");
  assert.deepEqual(store.list(ADDR).map((o) => o.txid).sort(), [A, B], "both entries visible from the memory copy");
  // no storage at all (null) → memory from the start, still works with the TTL
  const mem = createPendingStore({ storage: null, now: () => t });
  assert.equal(mem.backend(), "memory");
  mem.add([{ txid: C, vout: 1 }], ADDR);
  assert.deepEqual(mem.list(ADDR), [{ txid: C, vout: 1 }]);
  t = 3 * H;
  assert.deepEqual(mem.list(ADDR), []);
}

console.log("pending: address-keyed persistence, 2 h TTL eviction, merge, storage fallback ok");
