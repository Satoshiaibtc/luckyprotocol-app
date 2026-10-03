// Grammar tests for src/lib/payloads.js — the JS side of the payload rule
// (PROTOCOL.md §1–§2). The full byte-level agreement with the indexer's
// parser is test/payload.vectors.test.js (the shared vector file); these
// are the constants, the encoders' exact bytes and refusals, and a few
// parser spot checks. A payload one side accepts and the other rejects is
// a permanent state fork: the rejecting side default-routes the input pool
// to the tx's first output.
import assert from "node:assert/strict";
import {
  ACTIVATION_HEIGHT,
  AMT_RE,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_ID,
  PROTOCOL_LOCKTIME,
  REQUIRED_TOKEN_SUPPLY,
  SEND_RESIDUAL_VOUT,
  SEND_TO_VOUT,
  buildDeployPayload,
  buildMinePayload,
  buildSendPayload,
  parsePayload,
  parsePayloadBytes,
  payloadToString,
} from "../src/lib/payloads.js";

assert.equal(PROTOCOL_ID, "lucky-20", "the value of every payload's p key");
assert.equal(ACTIVATION_HEIGHT, 969_696, "activation height (must match the indexer)");
assert.equal(PROTOCOL_LOCKTIME, 969_695, "every DEPLOY / MINE / SEND the app builds has nLockTime ACTIVATION_HEIGHT − 1");
assert.equal(PROTOCOL_LOCKTIME, ACTIVATION_HEIGHT - 1);
assert.equal(SEND_TO_VOUT, 1, "a SEND's AMT goes to vout1");
assert.equal(SEND_RESIDUAL_VOUT, 2, "the rest of a SEND's pool goes to vout2");
assert.equal(MAX_PAYLOAD_BYTES, 80);

// ---- encoders: the exact bytes ---------------------------------------------------------------------------
const text = (b) => payloadToString(b);
assert.equal(text(buildDeployPayload("LUCKY")), '{"p":"lucky-20","op":"deploy","tick":"LUCKY"}');
assert.equal(buildDeployPayload("LUCKY").length, 45, "a DEPLOY of LUCKY is 45 bytes (40 + ticker)");
assert.equal(text(buildMinePayload("LUCKY")), '{"p":"lucky-20","op":"mine","tick":"LUCKY"}');
assert.equal(buildMinePayload("LUCKY").length, 43, "a MINE of LUCKY is 43 bytes (38 + ticker)");
assert.equal(text(buildSendPayload({ ticker: "LUCKY", amount: 1200 })), '{"p":"lucky-20","op":"send","tick":"LUCKY","amt":"1200"}');
assert.equal(text(buildSendPayload({ ticker: "LUCKY", amount: 1200n })), '{"p":"lucky-20","op":"send","tick":"LUCKY","amt":"1200"}', "a bigint amount writes the same bytes");
const longest = buildSendPayload({ ticker: "ABCDEFGH", amount: REQUIRED_TOKEN_SUPPLY });
assert.equal(text(longest), '{"p":"lucky-20","op":"send","tick":"ABCDEFGH","amt":"21000000"}');
assert.equal(longest.length, 63, "the longest payload is 63 bytes");
for (const b of [buildDeployPayload("A"), buildMinePayload("A"), buildSendPayload({ ticker: "A", amount: 1 })]) {
  assert.ok([...b].every((c) => c >= 0x20 && c <= 0x7e), "printable ASCII only");
  assert.ok(!/\s/.test(text(b)), "no whitespace");
}
console.log("payloads: DEPLOY 45 / MINE 43 bytes for LUCKY, the longest SEND 63 bytes, compact ASCII JSON");

// ---- encoders: refusals -----------------------------------------------------------------------------------
assert.throws(() => buildSendPayload({ ticker: "LUCKY", amount: 1, toOutIdx: 1 }), /names no output/, "a SEND takes no output index");
assert.throws(() => buildSendPayload({ ticker: "LUCKY", amount: 1, changeOutIdx: 2 }), /names no output/);
assert.throws(() => buildSendPayload({ ticker: "LUCKY", amount: 0 }), />= 1/, "AMT 0 is refused");
assert.throws(() => buildSendPayload({ ticker: "LUCKY", amount: REQUIRED_TOKEN_SUPPLY + 1 }), /cap/, "21,000,001 is refused");
assert.throws(() => buildSendPayload({ ticker: "LUCKY", amount: 1.5 }), /whole number/, "a fraction is refused");
assert.throws(() => buildSendPayload({ ticker: "LUCKY", amount: "12" }), /number or bigint/, "a string amount is refused");
assert.throws(() => buildSendPayload({ ticker: "lucky", amount: 1 }), /A-Z 0-9/, "a lower-case ticker is refused");
assert.throws(() => buildDeployPayload("lucky"), /A-Z 0-9/);
assert.throws(() => buildDeployPayload("ABCDEFGHI"), /not in \[1, 8\]/);
assert.throws(() => buildMinePayload("ore"), /A-Z 0-9/);
assert.throws(() => buildMinePayload(""), /not in \[1, 8\]/);
console.log("payloads: the encoders refuse index fields, AMT 0 / 21,000,001 / fractions, and lower-case tickers");

// ---- AMT grammar -------------------------------------------------------------------------------------------
for (const ok of ["1", "10", "1200", "21000000", "99999999"]) assert.ok(AMT_RE.test(ok), ok);
for (const bad of ["0", "01", "+1", "-1", "1.0", "1e3", "", " 1", "1,200", "100000000", "0x4b0"]) assert.ok(!AMT_RE.test(bad), bad);

// ---- parser spot checks (the full set is the shared vector file) -------------------------------------------
assert.deepEqual(parsePayload('{"p":"lucky-20","op":"deploy","tick":"LUCKY"}'), { op: "DEPLOY", ticker: "LUCKY" });
assert.deepEqual(parsePayload('{"p":"lucky-20","op":"mine","tick":"LUCKY"}'), { op: "MINE", ticker: "LUCKY" });
assert.deepEqual(parsePayload('{"p":"lucky-20","op":"send","tick":"LUCKY","amt":"1200"}'), { op: "SEND", ticker: "LUCKY", amount: 1200 });
assert.equal(parsePayload('{"p":"lucky-20","op":"send","tick":"LUCKY","amt":"21000001"}'), null, "above the supply");
assert.equal(parsePayload('{"p": "lucky-20","op":"mine","tick":"LUCKY"}'), null, "a space");
assert.equal(parsePayload('{"p":"lucky-20","op":"mine","tick":"LUCKY"}\n'), null, "a trailing line break (`$` without the m flag)");
assert.equal(parsePayload('{"op":"mine","p":"lucky-20","tick":"LUCKY"}'), null, "another key order");
assert.equal(parsePayload('{"p":"lucky-20","op":"send","tick":"LUCKY","amt":1200}'), null, "a number for amt");
assert.equal(parsePayload('{"p":"lucky-20","op":"MINE","tick":"LUCKY"}'), null, "an upper-case op");
assert.equal(parsePayload('{"p":"LUCKY-20","op":"mine","tick":"LUCKY"}'), null, "an upper-case p");
assert.equal(parsePayload('{"p":"lucky-20","op":"avatar","tick":"LUCKY"}'), null, "an avatar op is not a payload (§8)");
// `|`-separated pushes are not payloads.
for (const pipe of ["LUCKY-20|MINE|LUCKY", "LUCKY-20|DEPLOY|LUCKY", "LUCKY-20|SEND|LUCKY|1200|0|3", "LUCKYPROTOCOL|MINE|LUCKY"]) {
  assert.equal(parsePayload(pipe), null, pipe);
}
for (const junk of ["", null, undefined, 42, {}]) assert.equal(parsePayload(junk), null);

// parsePayloadBytes: printable ASCII only, then the same template.
const bytes = (s) => new TextEncoder().encode(s);
assert.deepEqual(parsePayloadBytes(bytes('{"p":"lucky-20","op":"mine","tick":"LUCKY"}')), { op: "MINE", ticker: "LUCKY" });
assert.equal(parsePayloadBytes(new Uint8Array([...bytes('{"p":"lucky-20","op":"mine","tick":"LUCKY"}'), 0])), null, "a NUL byte");
assert.equal(parsePayloadBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('{"p":"lucky-20","op":"mine","tick":"LUCKY"}')])), null, "a byte-order mark");
assert.equal(parsePayloadBytes(new Uint8Array(0)), null, "an empty push");
assert.equal(parsePayloadBytes(new Uint8Array(81).fill(0x41)), null, "longer than any OP_RETURN payload");
assert.equal(parsePayloadBytes("not bytes"), null);
console.log("payloads: parser spot checks — spaces, key order, number types, case, avatar and `|`-separated pushes are not payloads");

// ---- encoders round-trip through the parser ----------------------------------------------------------------
for (const [b, expected] of [
  [buildDeployPayload("ORE"), { op: "DEPLOY", ticker: "ORE" }],
  [buildMinePayload("ORE"), { op: "MINE", ticker: "ORE" }],
  [buildSendPayload({ ticker: "ORE", amount: 42 }), { op: "SEND", ticker: "ORE", amount: 42 }],
  [buildSendPayload({ ticker: "ORE", amount: 1n }), { op: "SEND", ticker: "ORE", amount: 1 }],
  [buildSendPayload({ ticker: "Z9", amount: REQUIRED_TOKEN_SUPPLY }), { op: "SEND", ticker: "Z9", amount: REQUIRED_TOKEN_SUPPLY }],
]) {
  assert.deepEqual(parsePayloadBytes(b), expected);
  assert.deepEqual(parsePayload(payloadToString(b)), expected);
}
console.log("payloads: every encoder round-trips through the parser");
