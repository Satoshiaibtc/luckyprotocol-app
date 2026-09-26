// Tests for src/lib/secondSource.js (audit M-12): the mempool.space second
// check of a listing's outpoint — URL shape, the pure comparison with
// agree / disagree fixtures (value, script, and the §7.2 step 3 OP_RETURN
// re-parse for MINE and SEND carriers), and the transport's unreachable
// paths (timeout, network error, server error, non-JSON, and a 404 beside
// an outage) through an injected fetch. Plain Node, no framework, no network.
import assert from "node:assert/strict";
import { SECOND_SOURCE_ORIGIN, SECOND_SOURCE_TIMEOUT_MS, checkSecondSource, compareSecondSource, payloadOfTxVouts, secondSourceUrls } from "../src/lib/secondSource.js";

const TXID = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SCRIPT = "5120" + "ab".repeat(32); // a P2TR scriptPubKey
const FEE = "0014" + "ee".repeat(20);
// `OP_RETURN <one push>` as an explorer serialises it: 6a + PUSHBYTES_n + ascii.
const opret = (text) => ({ scriptpubkey: `6a${text.length.toString(16).padStart(2, "0")}${Buffer.from(text, "ascii").toString("hex")}`, scriptpubkey_type: "op_return", value: 0 });
// The reference SEND layout (§2.3 / a fill's §7.2): vout1 is TO_OUT here.
const listing = { txid: TXID, vout: 1, carrierSats: 546, scriptHex: SCRIPT, ticker: "LUCKY", amount: 1200 };

const agreeOutspend = { spent: false };
const agreeTx = {
  txid: TXID,
  vout: [{ scriptpubkey: "0014" + "cd".repeat(20), value: 12_000 }, { scriptpubkey: SCRIPT, value: 546, scriptpubkey_type: "v1_p2tr" }, { scriptpubkey: FEE, value: 546 }, opret("LUCKY-20|SEND|LUCKY|1200|1|4"), { scriptpubkey: SCRIPT, value: 546 }],
  status: { confirmed: true, block_height: 969_700, block_hash: "00".repeat(31) + "0f" },
};

// ---- URLs: txid + vout only, path segments, no query string ------------------------------------------
{
  const u = secondSourceUrls(TXID, 1);
  assert.equal(u.outspend, `https://mempool.space/api/tx/${TXID}/outspend/1`);
  assert.equal(u.tx, `https://mempool.space/api/tx/${TXID}`);
  assert.equal(SECOND_SOURCE_ORIGIN, "https://mempool.space");
  assert.equal(SECOND_SOURCE_TIMEOUT_MS, 5_000);
  const up = secondSourceUrls(TXID.toUpperCase(), "1");
  assert.equal(up.tx, u.tx, "txid lower-cased, vout coerced");
  assert.throws(() => secondSourceUrls("not-a-txid", 0), /invalid txid/);
  assert.throws(() => secondSourceUrls(TXID, -1), /invalid vout/);
  assert.throws(() => secondSourceUrls(TXID, 1.5), /invalid vout/);
  assert.throws(() => secondSourceUrls(`${TXID}?x=1`, 0), /invalid txid/, "nothing but the txid can reach the URL");
  for (const url of Object.values(u)) {
    assert.ok(!url.includes("?") && !url.includes("#"), "no query string, no fragment");
    assert.ok(url.startsWith("https://mempool.space/api/tx/"));
  }
  console.log("second source urls: /api/tx/<txid>/outspend/<vout> and /api/tx/<txid>, validated inputs only");
}

// ---- pure comparison ---------------------------------------------------------------------------------
{
  assert.deepEqual(compareSecondSource(listing, { outspend: agreeOutspend, tx: agreeTx }), { verdict: "agree", reasons: [] }, "unspent + same value + same script → agree");
  assert.equal(compareSecondSource({ ...listing, scriptHex: SCRIPT.toUpperCase() }, { outspend: agreeOutspend, tx: agreeTx }).verdict, "agree", "script comparison is case-insensitive");

  const spent = compareSecondSource(listing, { outspend: { spent: true, txid: "f".repeat(64), vin: 0 }, tx: agreeTx });
  assert.equal(spent.verdict, "disagree");
  assert.match(spent.reasons[0], /already spent by ffffffff/);

  const value = compareSecondSource(listing, { outspend: agreeOutspend, tx: { ...agreeTx, vout: [agreeTx.vout[0], { ...agreeTx.vout[1], value: 10_000 }] } });
  assert.equal(value.verdict, "disagree");
  assert.match(value.reasons[0], /shows 10,000 sats on vout 1, the listing says 546/);

  const script = compareSecondSource(listing, { outspend: agreeOutspend, tx: { ...agreeTx, vout: [agreeTx.vout[0], { ...agreeTx.vout[1], scriptpubkey: "5120" + "ee".repeat(32) }] } });
  assert.equal(script.verdict, "disagree");
  assert.match(script.reasons[0], /different scriptPubKey/);

  const missing = compareSecondSource(listing, { outspend: agreeOutspend, tx: { txid: TXID, vout: [agreeTx.vout[0]] } });
  assert.equal(missing.verdict, "disagree");
  assert.match(missing.reasons[0], /only 1 output\(s\) — vout 1 does not exist/);

  const other = compareSecondSource(listing, { outspend: agreeOutspend, tx: { ...agreeTx, txid: "0".repeat(64) } });
  assert.equal(other.verdict, "disagree");
  assert.match(other.reasons[0], /different txid/);

  const unknown = compareSecondSource(listing, { outspend: { }, tx: agreeTx });
  assert.equal(unknown.verdict, "disagree", "an outspend record without `spent:false` never counts as unspent");
  assert.match(unknown.reasons[0], /did not answer whether/);

  const both = compareSecondSource(listing, { outspend: { spent: true }, tx: null });
  assert.equal(both.verdict, "disagree");
  assert.equal(both.reasons.length, 2, "every disagreement is listed");

  const noScript = compareSecondSource({ ...listing, scriptHex: "" }, { outspend: agreeOutspend, tx: agreeTx });
  assert.equal(noScript.verdict, "disagree", "a listing without a witnessUtxo script cannot be vouched for");
  console.log("second source compare: agree fixture passes; spent / value / script / missing vout / other txid / shapeless all disagree");
}

// ---- §7.2 step 3: the OP_RETURN re-parsed ----------------------------------------------------------
{
  const withPayload = (text) => ({ ...agreeTx, vout: agreeTx.vout.map((v, i) => (i === 3 ? opret(text) : v)) });
  assert.deepEqual(payloadOfTxVouts(agreeTx.vout), { op: "SEND", ticker: "LUCKY", amount: 1200, toOutIdx: 1, changeOutIdx: 4 }, "the payload as the indexer reads it");
  assert.equal(payloadOfTxVouts([{ scriptpubkey: SCRIPT }]), null);
  assert.equal(payloadOfTxVouts([{ scriptpubkey: "zz" }]), null, "junk hex is not a payload");

  const noTicker = compareSecondSource({ txid: TXID, vout: 1, carrierSats: 546, scriptHex: SCRIPT }, { outspend: agreeOutspend, tx: agreeTx });
  assert.equal(noTicker.verdict, "disagree", "without ticker / amount the OP_RETURN cannot be checked — fail closed");
  assert.match(noTicker.reasons[0], /no ticker \/ amount/);

  // SEND carrier: TO_OUT with the same AMT agrees; another AMT, another vout, another ticker do not.
  assert.equal(compareSecondSource(listing, { outspend: agreeOutspend, tx: agreeTx }).verdict, "agree", "vout 1 is TO_OUT and AMT == amount");
  const amt = compareSecondSource(listing, { outspend: agreeOutspend, tx: withPayload("LUCKY-20|SEND|LUCKY|1300|1|4") });
  assert.equal(amt.verdict, "disagree");
  assert.match(amt.reasons[0], /moves 1300 LUCKY to vout 1, the listing says 1200/);
  const otherTicker = compareSecondSource(listing, { outspend: agreeOutspend, tx: withPayload("LUCKY-20|SEND|ORE|1200|1|4") });
  assert.match(otherTicker.reasons[0], /OP_RETURN for ORE, the listing says LUCKY/);
  const residual = compareSecondSource({ ...listing, vout: 4, amount: 7 }, { outspend: agreeOutspend, tx: agreeTx });
  assert.equal(residual.verdict, "agree", "the CHANGE_OUT residual slot is a token slot too (§2.3 / §4.1) — its balance depends on the inputs");
  const notASlot = compareSecondSource({ ...listing, vout: 2, scriptHex: FEE }, { outspend: agreeOutspend, tx: agreeTx });
  assert.equal(notASlot.verdict, "disagree");
  assert.match(notASlot.reasons[0], /routes LUCKY to vout 1 and the residual to vout 4 — vout 2 carries no tokens/);
  const none = compareSecondSource(listing, { outspend: agreeOutspend, tx: { ...agreeTx, vout: agreeTx.vout.filter((_, i) => i !== 3) } });
  assert.equal(none.verdict, "disagree");
  assert.match(none.reasons[0], /no LUCKY-20 OP_RETURN/);
  const deploy = compareSecondSource(listing, { outspend: agreeOutspend, tx: withPayload("LUCKY-20|DEPLOY|LUCKY") });
  assert.match(deploy.reasons[0], /is a DEPLOY, which credits no token output/);

  // MINE carrier: vout 0, yield from the confirming block hash (…f → 1000).
  const mineTx = { txid: TXID, vout: [{ scriptpubkey: SCRIPT, value: 546 }, { scriptpubkey: FEE, value: 546 }, opret("LUCKY-20|MINE|LUCKY")], status: { confirmed: true, block_hash: "00".repeat(31) + "0f" } };
  const mine = { txid: TXID, vout: 0, carrierSats: 546, scriptHex: SCRIPT, ticker: "LUCKY", amount: 1000 };
  assert.equal(compareSecondSource(mine, { outspend: agreeOutspend, tx: mineTx }).verdict, "agree", "yield 1000 == amount");
  const wrongYield = compareSecondSource({ ...mine, amount: 500 }, { outspend: agreeOutspend, tx: mineTx });
  assert.equal(wrongYield.verdict, "disagree");
  assert.match(wrongYield.reasons[0], /block hash …f yields 1000 LUCKY \(§3\), the listing says 500/);
  const mid = compareSecondSource({ ...mine, amount: 500 }, { outspend: agreeOutspend, tx: { ...mineTx, status: { confirmed: true, block_hash: "00".repeat(31) + "0c" } } });
  assert.equal(mid.verdict, "agree", "…c → 500 (§3 mid bucket)");
  const unconfirmed = compareSecondSource(mine, { outspend: agreeOutspend, tx: { ...mineTx, status: { confirmed: false } } });
  assert.match(unconfirmed.reasons[0], /not show the MINE as confirmed/);
  const wrongVout = compareSecondSource({ ...mine, vout: 1, scriptHex: FEE }, { outspend: agreeOutspend, tx: mineTx });
  assert.match(wrongVout.reasons[0], /a MINE credits vout 0, the listing is vout 1/);
  console.log("second source OP_RETURN: SEND TO_OUT (AMT) / CHANGE_OUT agree, other vouts / tickers / opcodes disagree; MINE vout 0 + recomputed yield");
}

// ---- transport ---------------------------------------------------------------------------------------
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const fetchWith = (map, log) => async (url, init) => {
  log?.push({ url, init });
  const r = map[url];
  if (r instanceof Error) throw r;
  if (typeof r === "function") return r(init);
  return r;
};

{
  const urls = secondSourceUrls(TXID, 1);
  const log = [];
  const ok = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json(agreeOutspend), [urls.tx]: json(agreeTx) }, log) });
  assert.equal(ok.verdict, "agree");
  assert.match(ok.detail, /agrees: unspent, 546 sats, same script/);
  assert.deepEqual(log.map((l) => l.url).sort(), [urls.tx, urls.outspend].sort(), "exactly the two URLs, nothing else");
  for (const l of log) {
    assert.equal(l.init.method, "GET");
    assert.equal(l.init.credentials, "omit", "no cookies");
    assert.equal(l.init.body, undefined, "no body");
    assert.equal(l.init.headers, undefined, "no custom headers (no preflight, nothing extra sent)");
    assert.ok(l.init.signal instanceof AbortSignal, "abortable (the timeout)");
  }

  const bad = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json({ spent: true }), [urls.tx]: json(agreeTx) }) });
  assert.equal(bad.verdict, "disagree", "disagreement is a hard stop, not an outage");
  assert.match(bad.detail, /already spent/);

  const gone = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json({}, 404), [urls.tx]: json({}, 404) }) });
  assert.equal(gone.verdict, "disagree", "404 = the second source has no record of what the indexer vouches for");
  assert.equal(gone.reasons.length, 2);
  assert.match(gone.reasons[1], /no record of transaction/);

  // A 404 beside an outage is still a verdict — never an "unreachable" the buyer could tick past.
  const mixed = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json({}, 404), [urls.tx]: new TypeError("Failed to fetch") }) });
  assert.equal(mixed.verdict, "disagree", "404 on one request + network error on the other → disagree");
  assert.match(mixed.reasons[0], /no record of outpoint/);
  const mixed2 = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json("busy", 503), [urls.tx]: json({}, 404) }) });
  assert.equal(mixed2.verdict, "disagree", "5xx on one + 404 on the other → disagree");

  const down = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: json("busy", 503), [urls.tx]: json(agreeTx) }) });
  assert.equal(down.verdict, "unreachable", "a server error is an outage, not a verdict");
  assert.match(down.detail, /HTTP 503/);

  const net = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: new TypeError("Failed to fetch"), [urls.tx]: json(agreeTx) }) });
  assert.equal(net.verdict, "unreachable");
  assert.match(net.detail, /Failed to fetch/);

  const html = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }, [urls.tx]: json(agreeTx) }) });
  assert.equal(html.verdict, "unreachable", "an HTML error page is not an answer");
  assert.match(html.detail, /not JSON/);

  // Timeout: a fetch that only resolves when its signal aborts.
  const hang = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const t0 = Date.now();
  const slow = await checkSecondSource(listing, { fetchImpl: fetchWith({ [urls.outspend]: hang, [urls.tx]: hang }), timeoutMs: 30 });
  assert.equal(slow.verdict, "unreachable");
  assert.match(slow.detail, /did not answer within/);
  assert.ok(Date.now() - t0 < 2_000, "the timeout, not the hang, ended the check");

  const malformed = await checkSecondSource({ txid: "zz", vout: 0, carrierSats: 546, scriptHex: SCRIPT }, { fetchImpl: fetchWith({}) });
  assert.equal(malformed.verdict, "disagree", "a malformed outpoint never reaches the network");
  assert.equal(malformed.urls, null);
  console.log("second source transport: agree / disagree / 404→disagree (even beside an outage) / 5xx, network error, non-JSON, timeout → unreachable; GET, no credentials, no headers");
}

console.log("second source: all checks passed");
