// Cross-impl conformance test for the LuckyProtocol yield function. Runs in
// plain Node — no test framework, no deps — against the golden vectors
// shared with the Rust indexer (PROTOCOL-v3.md §3). A mismatch
// throws and exits non-zero, so `npm test` works as a CI gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
