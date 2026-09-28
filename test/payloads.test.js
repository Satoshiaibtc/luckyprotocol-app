// Grammar tests for src/lib/payloads.js — the JS mirror of the indexer's
// parser (protocol.rs). The SEND vectors below are the same four cases the
// Rust parser tests carry (audit M-2): the two grammars MUST agree byte for
// byte, because a payload one side accepts and the other rejects is a
// permanent state fork (the rejecting side default-routes the input pool to
// the tx's first output instead of settling the SEND).
import assert from "node:assert/strict";
import {
  ACTIVATION_HEIGHT,
  MAX_COMMIT_AGE,
  MAX_OUT_IDX,
  MIN_COMMIT_AGE,
  PROTOCOL_LOCKTIME,
  PROTOCOL_PREFIX,
  REQUIRED_TOKEN_SUPPLY,
  SNAPSHOT_VERSION,
  buildCommitPayload,
  buildMinePayload,
  buildRevealPayload,
  buildSendPayload,
  carrierScriptBytes,
  commitHashFor,
  commitHashOf,
  isValidSalt,
  newSalt,
  parsePayload,
  payloadToString,
  revealPayloadString,
} from "../src/lib/payloads.js";

assert.equal(PROTOCOL_PREFIX, "LUCKY-20");
assert.equal(ACTIVATION_HEIGHT, 969_300, "activation height per the 2026-09-26 owner decision (must match the indexer)");
assert.equal(SNAPSHOT_VERSION, 17, "commit-reveal deploy (owner decision A, 2026-09-27) is SNAPSHOT_VERSION 17");
assert.equal(MIN_COMMIT_AGE, 1, "a REVEAL needs its COMMIT in an EARLIER block");
assert.equal(MAX_COMMIT_AGE, 2_016, "a REVEAL must confirm within 2,016 blocks of its COMMIT");
assert.equal(PROTOCOL_LOCKTIME, 969_299, "every COMMIT / REVEAL / MINE / SEND the app builds has nLockTime ACTIVATION_HEIGHT − 1 (decision B)");

// ---- commit-reveal: the four spec vectors (§2.1) — identical in protocol.rs ----------------------
// H = SHA-256( UTF-8 bytes of the exact REVEAL payload ‖ raw scriptPubKey of the COMMIT's vout0 ).
const VECTORS = [
  ["LUCKY-20|DEPLOY|LUCKY|000102030405060708090a0b0c0d0e0f", "51200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "1ac55b4c608ed7c39eb3dbcecaf04c41222d5b3c37b6343477c9a91d4a6f33fc"],
  ["LUCKY-20|DEPLOY|A|ffffffffffffffffffffffffffffffff", "0014aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "23a7e7701311711134d6030a759630a39356203ad6306a246affe3a2fc4341b3"],
  ["LUCKY-20|DEPLOY|ZZZZ9999|0123456789abcdef0123456789abcdef", "5120bd9510c3a0d82a3fc259cafc53057aa4cac55d83617d916358a8c3f6d60a85dc", "b96eda80c8d519579fa3c882e590f8cbbc3d7d0fb6a6deeb8aa4abed78781a64"],
  // the anti-copy vector: the first payload under another script → another H
  ["LUCKY-20|DEPLOY|LUCKY|000102030405060708090a0b0c0d0e0f", "0014bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "740566381d71cf04e3ce2d5ffe62c03e65b13becf27bf963cd40e385d2e2bdf4"],
];
for (const [reveal, spk, h] of VECTORS) {
  assert.equal(commitHashOf(reveal, spk), h, `vector: ${reveal} / ${spk}`);
  assert.equal(commitHashOf(reveal, spk.toUpperCase()), h, "hex case does not matter for the script");
  assert.equal(commitHashOf(reveal, carrierScriptBytes(spk)), h, "the script as bytes gives the same hash");
  const p = parsePayload(reveal);
  assert.equal(p.op, "DEPLOY");
  assert.equal(commitHashFor(p.ticker, p.salt, spk), h, "commitHashFor(ticker, salt, script) is the same hash");
  assert.equal(revealPayloadString(p.ticker, p.salt), reveal, "the builder writes exactly the vector string");
  assert.equal(payloadToString(buildRevealPayload(p.ticker, p.salt)), reveal);
  const commit = buildCommitPayload(h);
  assert.equal(commit.length, 80, "a COMMIT payload is exactly 80 bytes");
  assert.equal(payloadToString(commit), `LUCKY-20|COMMIT|${h}`);
  assert.deepEqual(parsePayload(payloadToString(commit)), { op: "COMMIT", hash: h });
  console.log(`payloads: vector ${reveal} + ${spk.slice(0, 8)}… -> ${h} ok`);
}
// The binding: the same payload under two scripts gives two hashes (vectors 1 and 4); the script is required.
assert.equal(VECTORS[0][0], VECTORS[3][0]);
assert.notEqual(VECTORS[0][2], VECTORS[3][2], "a copied H names the owner's script, not the copier's");
assert.throws(() => commitHashOf(VECTORS[0][0]), /carrier script/, "no script, no H");
assert.throws(() => commitHashOf(VECTORS[0][0], ""), /carrier script/);
assert.throws(() => commitHashOf(VECTORS[0][0], "0014a"), /whole bytes/, "an odd number of hex digits is refused");
assert.throws(() => commitHashOf(VECTORS[0][0], "zz"), /hex/);
assert.throws(() => commitHashOf(VECTORS[0][0], new Uint8Array(0)), /empty/);
console.log("payloads: H binds the carrier script (same payload, other script, other H); a missing script is refused");

// ---- COMMIT / REVEAL grammar ------------------------------------------------------------------------
const H = VECTORS[0][2];
assert.equal(parsePayload(`LUCKY-20|COMMIT|${H.toUpperCase()}`), null, "uppercase hash does not parse");
assert.equal(parsePayload(`LUCKY-20|COMMIT|${H.slice(1)}`), null, "63-char hash does not parse");
assert.equal(parsePayload(`LUCKY-20|COMMIT|${H}|x`), null, "a 4th COMMIT field does not parse");
assert.equal(parsePayload("LUCKY-20|COMMIT"), null, "COMMIT without a hash does not parse");
assert.deepEqual(parsePayload("LUCKY-20|DEPLOY|LUCKY"), { op: "DEPLOY", ticker: "LUCKY", salt: null }, "the old 3-field DEPLOY still parses (never applied: commit_required)");
assert.equal(parsePayload("LUCKY-20|DEPLOY|LUCKY|000102030405060708090A0B0C0D0E0F"), null, "uppercase salt does not parse");
assert.equal(parsePayload("LUCKY-20|DEPLOY|LUCKY|0001020304050607"), null, "a 16-char salt does not parse");
assert.equal(parsePayload("LUCKY-20|DEPLOY|LUCKY|000102030405060708090a0b0c0d0e0f|x"), null, "a 5-field DEPLOY does not parse");
assert.equal(parsePayload("LUCKY-20|DEPLOY|lucky|000102030405060708090a0b0c0d0e0f"), null, "lowercase ticker does not parse");
assert.throws(() => buildCommitPayload(H.toUpperCase()), /64 lowercase hex/);
assert.throws(() => buildRevealPayload("ORE", "00"), /32 lowercase hex/);
assert.throws(() => buildRevealPayload("ore", "0".repeat(32)), /A-Z 0-9/);
const salts = new Set(Array.from({ length: 8 }, () => newSalt()));
assert.equal(salts.size, 8, "fresh salts differ");
for (const s of salts) assert.ok(isValidSalt(s), `salt ${s} is 32 lowercase hex`);
console.log("payloads: COMMIT is 80 bytes, REVEAL = DEPLOY|T|SALT, the 3-field DEPLOY parses with salt null, salts are fresh 16-byte hex");

// ---- SEND: exactly six fields (§2.3) — mirrors protocol.rs parse tests ----------------------------
// 5 fields (no CHANGE_OUT) → invalid. This is the case the Rust parser used
// to accept with a "default rule"; both sides now reject it.
assert.equal(parsePayload("LUCKY-20|SEND|T|100|0"), null, "5-field SEND (no CHANGE_OUT) is invalid");
// 6 fields → valid
assert.deepEqual(parsePayload("LUCKY-20|SEND|T|100|0|3"), { op: "SEND", ticker: "T", amount: 100, toOutIdx: 0, changeOutIdx: 3 }, "6-field SEND parses");
// TO_OUT == CHANGE_OUT → invalid
assert.equal(parsePayload("LUCKY-20|SEND|T|100|0|0"), null, "to == change is invalid");
assert.equal(parsePayload("LUCKY-20|SEND|T|100|3|3"), null, "to == change (non-zero) is invalid");
// 7 fields → invalid
assert.equal(parsePayload("LUCKY-20|SEND|T|100|0|3|x"), null, "7-field SEND is invalid");
assert.equal(parsePayload("LUCKY-20|SEND|T|100|0|3|"), null, "trailing separator (empty 7th field) is invalid");

// ---- SEND field validation ----------------------------------------------------------------------------
assert.equal(parsePayload("LUCKY-20|SEND|T|0|0|3"), null, "amount 0 is invalid");
assert.equal(parsePayload(`LUCKY-20|SEND|T|${REQUIRED_TOKEN_SUPPLY}|0|3`).amount, REQUIRED_TOKEN_SUPPLY, "amount == supply is valid");
assert.equal(parsePayload(`LUCKY-20|SEND|T|${REQUIRED_TOKEN_SUPPLY + 1}|0|3`), null, "amount > supply is invalid");
assert.equal(parsePayload("LUCKY-20|SEND|T|010|0|3"), null, "leading zero is not canonical");
assert.equal(parsePayload("LUCKY-20|SEND|T|+10|0|3"), null, "sign is not canonical");
assert.equal(parsePayload("LUCKY-20|SEND|T|10|00|3"), null, "leading zero on TO_OUT is not canonical");
assert.equal(parsePayload(`LUCKY-20|SEND|T|10|0|${MAX_OUT_IDX}`).changeOutIdx, MAX_OUT_IDX, "CHANGE_OUT == 255 is valid");
assert.equal(parsePayload(`LUCKY-20|SEND|T|10|0|${MAX_OUT_IDX + 1}`), null, "CHANGE_OUT > 255 is invalid");
assert.equal(parsePayload("LUCKY-20|SEND|T|10|256|3"), null, "TO_OUT > 255 is invalid");
assert.equal(parsePayload("LUCKY-20|SEND|t|10|0|3"), null, "lowercase ticker is invalid");
assert.equal(parsePayload("LUCKY-20|SEND|TOOLONGTKN|10|0|3"), null, "9-char ticker is invalid");
assert.equal(parsePayload("LUCKY-20|SEND||10|0|3"), null, "empty ticker is invalid");
assert.equal(parsePayload("LUCKY-20|SEND|T|1e3|0|3"), null, "exponent is not a canonical uint");
assert.equal(parsePayload("LUCKY-20|SEND|T| 10|0|3"), null, "whitespace is not allowed");

// ---- other ops: exactly three fields ---------------------------------------------------------------------
assert.deepEqual(parsePayload("LUCKY-20|MINE|LUCKY"), { op: "MINE", ticker: "LUCKY" });
// AVATAR was withdrawn before activation (§8): it is an unknown op like any other.
assert.equal(parsePayload("LUCKY-20|AVATAR|LUCKY"), null, "the withdrawn AVATAR op does not parse");
assert.equal(parsePayload("LUCKY-20|MINE|LUCKY|1"), null, "MINE with a 4th field is invalid");
assert.equal(parsePayload("LUCKY-20|MINE"), null, "MINE without a ticker is invalid");
assert.equal(parsePayload("LUCKY-20|BURN|LUCKY"), null, "unknown op is invalid");
assert.equal(parsePayload("LUCKYPROTOCOL|MINE|LUCKY"), null, "a push whose field 0 is not LUCKY-20 is not a protocol payload");
assert.equal(parsePayload("lucky-20|MINE|LUCKY"), null, "prefix is case-sensitive");
assert.equal(parsePayload(""), null);
assert.equal(parsePayload(null), null);
assert.equal(parsePayload(undefined), null);

// ---- encoders round-trip through the parser ----------------------------------------------------------------
for (const [bytes, expected] of [
  [buildRevealPayload("ORE", "ab".repeat(16)), { op: "DEPLOY", ticker: "ORE", salt: "ab".repeat(16) }],
  [buildMinePayload("ORE"), { op: "MINE", ticker: "ORE" }],
  [buildSendPayload({ ticker: "ORE", amount: 42, toOutIdx: 0, changeOutIdx: 3 }), { op: "SEND", ticker: "ORE", amount: 42, toOutIdx: 0, changeOutIdx: 3 }],
  [buildSendPayload({ ticker: "ORE", amount: 42n, toOutIdx: 1, changeOutIdx: 4 }), { op: "SEND", ticker: "ORE", amount: 42, toOutIdx: 1, changeOutIdx: 4 }],
]) {
  assert.deepEqual(parsePayload(payloadToString(bytes)), expected);
}
assert.equal(payloadToString(buildSendPayload({ ticker: "ORE", amount: 42, toOutIdx: 0, changeOutIdx: 3 })), "LUCKY-20|SEND|ORE|42|0|3");
// The encoder refuses what the parser would refuse.
assert.throws(() => buildSendPayload({ ticker: "ORE", amount: 42, toOutIdx: 3, changeOutIdx: 3 }), /does not parse/);
assert.throws(() => buildSendPayload({ ticker: "ORE", amount: 0, toOutIdx: 0, changeOutIdx: 3 }), />= 1/);
assert.throws(() => buildSendPayload({ ticker: "ORE", amount: REQUIRED_TOKEN_SUPPLY + 1, toOutIdx: 0, changeOutIdx: 3 }), /cap/);
assert.throws(() => buildSendPayload({ ticker: "ORE", amount: 1, toOutIdx: 0, changeOutIdx: 256 }), /out of range/);
assert.throws(() => buildMinePayload("ore"), /A-Z 0-9/);

console.log("payloads: SEND six-field grammar (5 → invalid, 6 → valid, to == change → invalid, 7 → invalid) mirrors the indexer");
