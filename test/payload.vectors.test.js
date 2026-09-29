// Cross-implementation conformance test for the LUCKY-20 payload parser
// (PROTOCOL.md §2). Plain Node, no deps. src/lib/payload_vectors.json is
// the indexer's own vector file, byte for byte: every row is a pushed byte
// string with the parse result the indexer's parser gives it (the
// operation and fields, or null when the bytes are not a payload). The two
// parsers must agree on every row — a string one side accepts and the
// other rejects is a permanent state fork.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDeployPayload, buildMinePayload, buildSendPayload, parsePayloadBytes } from "../src/lib/payloads.js";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "../src/lib/payload_vectors.json");
const { vectors } = JSON.parse(readFileSync(FILE, "utf8"));

const hexToBytes = (h) => {
  assert.match(h, /^(?:[0-9a-f]{2})*$/, `hex "${h.slice(0, 16)}…" is lower-case, whole bytes`);
  return Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
};
const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The JS parse result in the vector file's shape: `{ op, tick, amt? }` with the wire op name, or null. */
function asVector(p) {
  if (!p) return null;
  const op = p.op.toLowerCase();
  return op === "send" ? { op, tick: p.ticker, amt: p.amount } : { op, tick: p.ticker };
}

/** The encoder's bytes for an accepted row's `expect`. */
function rebuild(e) {
  if (e.op === "deploy") return buildDeployPayload(e.tick);
  if (e.op === "mine") return buildMinePayload(e.tick);
  if (e.op === "send") return buildSendPayload({ ticker: e.tick, amount: e.amt });
  throw new Error(`unknown op ${e.op}`);
}

assert.ok(Array.isArray(vectors) && vectors.length >= 80, "the shared vector file holds the full set");
let accepted = 0;
const seen = new Set();
for (const [i, v] of vectors.entries()) {
  const label = `vector ${i} (${v.why})`;
  assert.equal(typeof v.why, "string", `${label}: why`);
  assert.equal(typeof v.hex, "string", `${label}: hex`);
  assert.ok(!seen.has(v.hex), `${label}: no duplicate rows`);
  seen.add(v.hex);
  const b = hexToBytes(v.hex);
  if (v.text !== undefined) assert.equal(bytesToHex(new TextEncoder().encode(v.text)), v.hex, `${label}: text repeats hex`);
  assert.deepEqual(asVector(parsePayloadBytes(b)), v.expect, `${label}: parse result`);
  if (v.expect) {
    accepted += 1;
    assert.equal(bytesToHex(rebuild(v.expect)), v.hex, `${label}: the encoder writes exactly these bytes`);
  }
}
assert.ok(accepted >= 10, "every operation has accepted rows");
for (const op of ["deploy", "mine", "send"]) assert.ok(vectors.some((v) => v.expect?.op === op), `an accepted ${op} row`);
assert.ok(vectors.some((v) => v.expect && v.hex.length / 2 === 63), "the 63-byte maximum is a row");
console.log(`payload vectors: ${vectors.length} rows (${accepted} accepted) parse as the indexer parses them; every accepted row rebuilds byte for byte`);

// The indexer's copy is the canonical one: byte-identical when
// LP_INDEXER_DIR names a local indexer checkout. Skipped only when the
// variable is unset; a set variable whose file is missing fails.
{
  const dir = process.env.LP_INDEXER_DIR;
  if (!dir) {
    console.log("payload vectors: LP_INDEXER_DIR not set — byte-identity check skipped");
  } else {
    const p = join(dir, "tests", "payload_vectors.json");
    let canon;
    try {
      canon = readFileSync(p);
    } catch (e) {
      assert.fail(`LP_INDEXER_DIR is set but ${p} cannot be read: ${e.message}`);
    }
    assert.ok(readFileSync(FILE).equals(canon), "src/lib/payload_vectors.json must be byte-identical to the indexer's copy");
    console.log("payload vectors: byte-identical to the indexer's");
  }
}
