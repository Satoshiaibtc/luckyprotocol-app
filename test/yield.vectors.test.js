// Cross-impl conformance test for the LuckyProtocol yield function. Runs in
// plain Node — no test framework, no deps — against the golden vectors
// shared with the indexer (PROTOCOL.md §3). A mismatch
// throws and exits non-zero, so `npm test` works as a CI gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { mineYield, yieldDigit, yieldTierLabel, EXPECTED_YIELD } from "../src/lib/yield.js";

const here = dirname(fileURLToPath(import.meta.url));
const { vectors } = JSON.parse(
  readFileSync(join(here, "../src/lib/yield_vectors.json"), "utf8"),
);

// The spec table has exactly these last-digit rows; guard against the
// vectors file drifting away from it.
const EXPECTED_ROWS = [
  ["0", 100], ["6", 100],
  ["7", 200], ["b", 200],
  ["c", 500], ["e", 500],
  ["f", 1000],
  ["F", 1000],
];
assert.equal(vectors.length, EXPECTED_ROWS.length, "vector count must match spec §3 table");
vectors.forEach((v, i) => {
  assert.match(v.hash, /^[0-9a-fA-F]{64}$/, `vector ${i}: hash must be 64 hex chars`);
  assert.equal(v.hash.at(-1), EXPECTED_ROWS[i][0], `vector ${i}: last char`);
  assert.equal(v.yield, EXPECTED_ROWS[i][1], `vector ${i}: expected yield in table`);
});

let passed = 0;
for (const v of vectors) {
  const got = mineYield(v.hash);
  assert.strictEqual(
    got,
    v.yield,
    `yield mismatch: hash …${v.hash.slice(-4)} — expected ${v.yield}, got ${got}`,
  );
  passed++;
}

// Spec §3: `block_hash` is the DISPLAY form — the
// double-SHA256 of the 80-byte header, byte-reversed, as getblockhash and
// explorers print it. Real mainnet headers pin that: the display hash is
// recomputed from the header, and the internal (un-reversed) order ends in
// the proof-of-work zeros — every block would yield 100.
{
  const { headers } = JSON.parse(readFileSync(join(here, "../src/lib/yield_vectors.json"), "utf8"));
  assert.ok(headers.length >= 4, "one real header per tier");
  const tiers = new Set();
  for (const v of headers) {
    const bytes = hexToBytes(v.header);
    assert.equal(bytes.length, 80, `height ${v.height}: 80-byte header`);
    const internal = sha256(sha256(bytes));
    const display = bytesToHex(internal.slice().reverse());
    assert.equal(display, v.hash, `height ${v.height}: display hash`);
    assert.equal(mineYield(display), v.yield, `height ${v.height}: yield of the display hash`);
    assert.ok(bytesToHex(internal).endsWith("00"), `height ${v.height}: internal order ends in the PoW zeros`);
    assert.equal(mineYield(bytesToHex(internal)), 100, `height ${v.height}: the wrong byte order always yields 100`);
    tiers.add(v.yield);
  }
  assert.deepEqual([...tiers].sort((a, b) => a - b), [100, 200, 500, 1000], "every tier covered by a real block");
  console.log(`yield vectors: ${headers.length} real mainnet headers — display-order hash recomputed and asserted`);
}

// The indexer's copy of the vectors is the canonical one: byte-identical
// when LP_INDEXER_DIR names a local indexer checkout. Skipped only when the
// variable is unset; a set variable whose file is missing fails.
{
  const dir = process.env.LP_INDEXER_DIR;
  if (!dir) {
    console.log("yield vectors: LP_INDEXER_DIR not set — byte-identity check skipped");
  } else {
    const p = join(dir, "tests", "yield_vectors.json");
    let canon;
    try {
      canon = readFileSync(p);
    } catch (e) {
      assert.fail(`LP_INDEXER_DIR is set but ${p} cannot be read: ${e.message}`);
    }
    assert.ok(readFileSync(join(here, "../src/lib/yield_vectors.json")).equals(canon), "src/lib/yield_vectors.json must be byte-identical to the indexer's copy");
    console.log("yield vectors: byte-identical to the indexer's");
  }
}

// Degenerate inputs must be null, never a yield.
for (const bad of ["", "   ", "xyz", "00g", null, undefined, 42, {}]) {
  assert.strictEqual(mineYield(bad), null, `mineYield(${JSON.stringify(bad)}) must be null`);
  assert.strictEqual(yieldDigit(bad), null, `yieldDigit(${JSON.stringify(bad)}) must be null`);
}

// Every hex digit maps into exactly one bucket: f → 1000, c–e → 500, 7–b → 200, 0–6 → 100.
for (const d of "0123456789abcdef") {
  const y = mineYield(`${"0".repeat(63)}${d}`);
  const want = d === "f" ? 1000 : d >= "c" ? 500 : d >= "7" ? 200 : 100;
  assert.strictEqual(y, want, `digit ${d}`);
  assert.strictEqual(mineYield(`${"0".repeat(63)}${d.toUpperCase()}`), want, `digit ${d} upper`);
}

assert.deepEqual([1000, 500, 200, 100, 0, 250].map(yieldTierLabel), ["high", "mid", "low", "base", "unknown", "unknown"]);

assert.strictEqual(EXPECTED_YIELD, 262.5, "expected yield per MINE (spec §3)");
assert.strictEqual(21_000_000 / EXPECTED_YIELD, 80_000, "mines that exhaust a ticker exactly");

console.log(`yield vectors: ${passed}/${vectors.length} passed; degenerate + full-digit sweeps ok`);
