// Grammar tests for src/lib/payloads.js — the JS mirror of the indexer's
// parser (protocol.rs). The SEND vectors below are the same four cases the
// Rust parser tests carry (audit M-2): the two grammars MUST agree byte for
// byte, because a payload one side accepts and the other rejects is a
// permanent state fork (the rejecting side strict-burns the input pool).
import assert from "node:assert/strict";
import {
  ACTIVATION_HEIGHT,
  MAX_OUT_IDX,
  PROTOCOL_PREFIX,
  REQUIRED_TOKEN_SUPPLY,
  buildAvatarPayload,
  buildDeployPayload,
  buildMinePayload,
  buildSendPayload,
  parsePayload,
  payloadToString,
} from "../src/lib/payloads.js";

assert.equal(PROTOCOL_PREFIX, "LUCKY-20");
assert.equal(ACTIVATION_HEIGHT, 969_300, "activation height per the 2026-09-26 owner decision (must match the indexer)");

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
assert.deepEqual(parsePayload("LUCKY-20|DEPLOY|LUCKY"), { op: "DEPLOY", ticker: "LUCKY" });
assert.deepEqual(parsePayload("LUCKY-20|MINE|LUCKY"), { op: "MINE", ticker: "LUCKY" });
assert.deepEqual(parsePayload("LUCKY-20|AVATAR|LUCKY"), { op: "AVATAR", ticker: "LUCKY" });
assert.equal(parsePayload("LUCKY-20|MINE|LUCKY|1"), null, "MINE with a 4th field is invalid");
assert.equal(parsePayload("LUCKY-20|MINE"), null, "MINE without a ticker is invalid");
assert.equal(parsePayload("LUCKY-20|BURN|LUCKY"), null, "unknown op is invalid");
assert.equal(parsePayload("LUCKYPROTOCOL|MINE|LUCKY"), null, "retired v2 prefix is not a protocol payload");
assert.equal(parsePayload("lucky-20|MINE|LUCKY"), null, "prefix is case-sensitive");
assert.equal(parsePayload(""), null);
assert.equal(parsePayload(null), null);
assert.equal(parsePayload(undefined), null);

// ---- encoders round-trip through the parser ----------------------------------------------------------------
for (const [bytes, expected] of [
  [buildDeployPayload("ORE"), { op: "DEPLOY", ticker: "ORE" }],
  [buildMinePayload("ORE"), { op: "MINE", ticker: "ORE" }],
  [buildAvatarPayload("ORE"), { op: "AVATAR", ticker: "ORE" }],
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
