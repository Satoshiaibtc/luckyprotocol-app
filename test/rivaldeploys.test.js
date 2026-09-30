// Other DEPLOYs of the same ticker waiting in the mempool: the rate the
// Create page offers against them, its warning texts, the user's own
// versions left out, the comparison while the user's DEPLOY waits, the
// click that stops at a warning it had not shown, the failure path (a read
// that fails never holds a DEPLOY back), Speed up's suggested rate, the
// /pending-deploys reader, the mock's route (src/lib/rivalDeploys.js,
// src/lib/indexer.js, src/lib/mock.js), and the Create page's use of them
// (src/pages/CreatePage.jsx, src/hooks/usePendingDeploys.js, read as
// source). Plain Node, no framework.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLICK_CHECK_TIMEOUT_MS,
  PENDING_CHECK_FAILED_TEXT,
  PENDING_DEPLOYS_POLL_MS,
  clickContext,
  clickPauses,
  deployRowRate,
  fmtRate,
  ownDeployRate,
  pendingCheckLine,
  readPendingDeploys,
  rivalAheadText,
  rivalPause,
  rivalWarningText,
  rivalsAhead,
  speedUpSuggested,
  suggestedRivalRate,
} from "../src/lib/rivalDeploys.js";
import * as indexer from "../src/lib/indexer.js";
import * as mock from "../src/lib/mock.js";
import { buildDeployPsbt, buildSpeedUpPsbt, extractRawTxHex, psbtFeeSats, psbtVsize } from "../src/lib/psbt.js";
import { mockSpendable } from "./mockspend.js";

const TX = (c) => c.repeat(64);
const row = (c, feeRate, extra = {}) => ({ txid: TX(c), fee_rate: feeRate, fee_sats: Math.round(feeRate * 200), vsize: 200, first_seen: 1_700_000_000, package_fee_rate: feeRate, ...extra });
const answer = (pending, extra = {}) => ({ ticker: "NEW", registered: false, pending, as_of: 1_700_000_100, watching: true, ...extra });

// ---- the rate offered against a waiting DEPLOY ---------------------------------------------------------
{
  assert.equal(suggestedRivalRate(10), 12, "+2 sat/vB when 10 % is less");
  assert.equal(suggestedRivalRate(25), 28, "10 % when it is more (27.5), rounded up");
  assert.equal(suggestedRivalRate(20), 22, "exactly 10 % above: 22, never 23 from a float rounding");
  assert.equal(suggestedRivalRate(12.25), 15, "a fractional rate: 14.25 rounded up");
  assert.equal(suggestedRivalRate(31), 35, "34.1 rounded up");
  assert.equal(suggestedRivalRate(0.5), 3, "a sub-1 rate still gets +2");
  assert.equal(suggestedRivalRate(10, 20), 20, "never below the Fast estimate");
  assert.equal(suggestedRivalRate(10, 12.5), 12.5, "a fractional Fast estimate above the margin is used as it is");
  assert.equal(suggestedRivalRate(10, 2.38), 12, "a Fast estimate below the margin changes nothing");
  assert.equal(suggestedRivalRate(10, null), 12, "no Fast estimate: the margin alone");
  assert.equal(suggestedRivalRate(950), 1000, "past the safety cap: the cap, which still pays more");
  assert.equal(suggestedRivalRate(1000), null, "nothing that can be signed pays more than the cap");
  assert.equal(suggestedRivalRate(null), null);
  assert.equal(suggestedRivalRate(Number.NaN), null);
  // Every rate in hundredths up to 300 sat/vB: a whole sat/vB, at least +2 and +10 %, and the smallest such.
  for (let cents = 100; cents <= 30_000; cents += 7) {
    const top = cents / 100;
    const s = suggestedRivalRate(top);
    const need = Math.max(cents + 200, Math.ceil((cents * 11) / 10)) / 100;
    assert.ok(Number.isInteger(s) && s >= need && s - 1 < need, `top ${top}: offered ${s}, needs ${need}`);
  }
  console.log("rivaldeploys: the offered rate is +2 sat/vB and +10 % at least, rounded up, never below Fast, capped");
}

// ---- what a read says; the user's own versions are never another DEPLOY -----------------------------------
{
  assert.deepEqual(readPendingDeploys(undefined), { status: "idle" }, "not read yet");
  assert.deepEqual(readPendingDeploys(null), { status: "unknown" }, "the read failed");
  assert.deepEqual(readPendingDeploys(answer([row("b", 10)], { watching: false })), { status: "unknown" }, "the watch is not running: its old list says nothing");
  assert.deepEqual(readPendingDeploys(answer([], { registered: true })), { status: "registered" });
  assert.deepEqual(readPendingDeploys(answer([])), { status: "ok", rivals: null });
  const own = readPendingDeploys(answer([row("a", 10), row("c", 8)]), [TX("A"), TX("c")]);
  assert.deepEqual(own, { status: "ok", rivals: null }, "the user's own versions (any case) are left out");
  // Rows come sorted by their own fee rate; a child paying for the second one puts it ahead.
  const cpfp = readPendingDeploys(answer([row("a", 10), row("b", 8, { package_fee_rate: 15 })]));
  assert.deepEqual([cpfp.rivals.count, cpfp.rivals.topRate], [2, 15], "the highest competing rate is a maximum over the package rates, not the first row");
  assert.equal(deployRowRate(row("a", 10, { package_fee_rate: 7 })), 7, "a package rate below the own rate (a parent that pays less) is the rate it is mined at");
  const parent = readPendingDeploys(answer([row("a", 60, { package_fee_rate: 3.84 }), row("b", 8)]));
  assert.equal(parent.rivals.topRate, 8, "a high own rate held back by a cheap parent does not count as the highest");
  assert.equal(deployRowRate({ txid: TX("a"), fee_rate: 9 }), 9, "no package rate: the own rate");
  assert.equal(deployRowRate(row("a", 9, { package_fee_rate: null })), 9, "a null package rate: the own rate");
  assert.equal(deployRowRate({ txid: TX("a"), fee_rate: null }), null);
  console.log("rivaldeploys: idle / unknown / registered / ok; own versions left out; the highest package rate");
}

// ---- the texts -----------------------------------------------------------------------------------------------
{
  assert.equal(
    rivalWarningText("NEW", { count: 1, topRate: 12.25 }),
    "Another DEPLOY of NEW is waiting to be confirmed, paying 12.25 sat/vB. The first DEPLOY to confirm takes the name; the fee of the one that confirms second is spent and not refunded.",
  );
  assert.equal(
    rivalWarningText("NEW", { count: 3, topRate: 20 }),
    "3 other DEPLOYs of NEW are waiting to be confirmed; the highest pays 20 sat/vB. The first DEPLOY to confirm takes the name; the fees of the ones that confirm later are spent and not refunded.",
    "several: the highest rate and the count",
  );
  assert.equal(rivalAheadText("NEW", { count: 1, topRate: 14, mine: 12 }), "Another DEPLOY of NEW pays more (14 sat/vB) than yours (12 sat/vB). Speed up to stay ahead.");
  assert.equal(rivalAheadText("NEW", { count: 2, topRate: 30, mine: 12.5 }), "2 other DEPLOYs of NEW pay more (up to 30 sat/vB) than yours (12.5 sat/vB). Speed up to stay ahead.");
  assert.equal(rivalAheadText("NEW", { count: 1, topRate: 14, mine: 12 }, { canSpeedUp: false }), "Another DEPLOY of NEW pays more (14 sat/vB) than yours (12 sat/vB).", "no Speed up on the page: no advice to use it");
  assert.equal(PENDING_CHECK_FAILED_TEXT, "Pending DEPLOYs could not be checked right now.");
  assert.deepEqual([fmtRate(1000), fmtRate(12.5), fmtRate(12.257), fmtRate(3)], ["1,000", "12.5", "12.26", "3"]);
  assert.deepEqual([PENDING_DEPLOYS_POLL_MS, CLICK_CHECK_TIMEOUT_MS], [15_000, 5_000]);
  console.log("rivaldeploys: the warning before signing, the one while pending, the quiet line");
}

// ---- while the user's DEPLOY waits: another one that pays more than its current version --------------------
{
  const own = [TX("c"), TX("a")]; // c = the current version (after a Speed up), a = the one it replaced
  const at = (rows) => answer(rows);
  assert.equal(rivalsAhead(at([row("c", 12), row("b", 10), row("a", 8)]), { own, current: TX("c"), localRate: 12 }), null, "another DEPLOY pays less: nothing");
  assert.deepEqual(rivalsAhead(at([row("b", 14), row("c", 12), row("a", 8)]), { own, current: TX("c"), localRate: 12 }), { count: 1, topRate: 14, mine: 12 });
  assert.equal(rivalsAhead(at([row("c", 12), row("b", 12)]), { own, current: TX("c"), localRate: 12 }), null, "the same rate is not more");
  assert.equal(rivalsAhead(at([row("a", 20), row("c", 12)]), { own, current: TX("c"), localRate: 12 }), null, "the replaced version paying more is the user's own, never another DEPLOY");
  // The current version not listed yet (right after a Speed up): its rate as built.
  assert.equal(rivalsAhead(at([row("b", 10), row("a", 8)]), { own, current: TX("c"), localRate: 12 }), null);
  assert.deepEqual(rivalsAhead(at([row("b", 10), row("a", 8)]), { own, current: TX("c"), localRate: 9 }), { count: 1, topRate: 10, mine: 9 });
  // Once listed, the node's measure of it is used.
  assert.deepEqual(rivalsAhead(at([row("b", 11.8), row("c", 11.5)]), { own, current: TX("c"), localRate: 12 }), { count: 1, topRate: 11.8, mine: 11.5 });
  // A child paying for the other DEPLOY puts it ahead; one paying for the user's keeps it ahead.
  assert.deepEqual(rivalsAhead(at([row("c", 12), row("b", 8, { package_fee_rate: 20 })]), { own, current: TX("c"), localRate: 12 }), { count: 1, topRate: 20, mine: 12 });
  assert.equal(rivalsAhead(at([row("b", 14), row("c", 10, { package_fee_rate: 16 })]), { own, current: TX("c"), localRate: 10 }), null);
  // Several ahead: the count and the highest.
  assert.deepEqual(rivalsAhead(at([row("d", 30), row("b", 14), row("c", 12), row("e", 11)]), { own, current: TX("c"), localRate: 12 }), { count: 2, topRate: 30, mine: 12 });
  // Nothing known → nothing said.
  for (const a of [undefined, null, answer([row("b", 30)], { watching: false }), answer([], { registered: true })]) {
    assert.equal(rivalsAhead(a, { own, current: TX("c"), localRate: 12 }), null);
  }
  assert.equal(rivalsAhead(at([row("b", 30)]), { own, current: TX("c"), localRate: null }), null, "its own rate unknown: no comparison");
  assert.equal(ownDeployRate({ feeRateSatVb: 6.5 }), 6.5);
  assert.equal(ownDeployRate({ resumed: true, psbt: null }), null, "picked up again without its unsigned copy");
  console.log("rivaldeploys: while pending, only another DEPLOY paying more than the current version is shown");
}

// ---- the click on Create: stop only at a warning the page had not shown ------------------------------------
{
  const two = answer([row("b", 10), row("d", 7)]);
  assert.equal(rivalPause(null, { rate: 5 }), false, "a failed read never holds the DEPLOY back");
  assert.equal(rivalPause(answer([row("b", 10)], { watching: false }), { rate: 5 }), false, "nor does a watch that is not running");
  assert.equal(rivalPause(answer([]), { rate: 5 }), false, "no other DEPLOY");
  assert.equal(rivalPause(two, { rate: 5 }), true, "another DEPLOY the page had not shown, paying more");
  assert.equal(rivalPause(two, { rate: 5, shownTopRate: 10 }), false, "already shown: the user chose their rate");
  assert.equal(rivalPause(two, { rate: 5, shownTopRate: 8 }), true, "it pays more than what was shown");
  assert.equal(rivalPause(two, { rate: 10.5 }), false, "the chosen rate already pays more");
  assert.equal(rivalPause(two, { rate: 10 }), true, "the same rate does not");
  assert.equal(rivalPause(two, { rate: 5, own: [TX("b"), TX("d")] }), false, "the user's own DEPLOYs");
  console.log("rivaldeploys: a click stops only for another DEPLOY it had not shown that the chosen rate does not beat");
}

// ---- the reader: sanitizing, fresh reads, and every failure is a throw (the page's quiet line) ----------------
{
  const asked = [];
  let reply = null;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    asked.push({ url, init });
    const [status, body] = reply;
    return { ok: status === 200, status, headers: { get: () => null }, json: async () => JSON.parse(body), text: async () => body };
  };
  try {
    reply = [
      200,
      JSON.stringify(
        answer([
          row("d", 7),
          { ...row("b", 10), package_fee_rate: 4 },
          { txid: "zz", fee_rate: 50 },
          { txid: TX("E"), fee_rate: 9, fee_sats: 1800, vsize: 200, first_seen: 1_700_000_000 },
          { txid: TX("f"), fee_rate: -1 },
        ]),
      ),
    ];
    const a = await indexer.pendingDeploys("NEW");
    assert.match(asked[0].url, /\/pending-deploys\/NEW$/);
    assert.equal(asked[0].init.cache, undefined, "a poll may use the browser's cache");
    assert.deepEqual(a.pending.map((r) => [r.txid, r.fee_rate, r.package_fee_rate]), [[TX("b"), 10, 4], [TX("e"), 9, 9], [TX("d"), 7, 7]], "unreadable rows dropped, txids lower-cased, a lower package rate kept, a missing one reads as the own rate, highest first");
    assert.deepEqual([a.ticker, a.registered, a.as_of, a.watching], ["NEW", false, 1_700_000_100, true]);
    await indexer.pendingDeploys("NEW", undefined, { fresh: true });
    assert.match(asked[1].url, /\/pending-deploys\/NEW\?t=[0-9a-z]+$/, "a fresh read varies the URL (the route ignores the parameter)");
    assert.equal(asked[1].init.cache, "no-store", "and bypasses the browser's cache");
    reply = [200, JSON.stringify(answer([row("b", 10)], { registered: true, as_of: null, watching: false }))];
    const reg = await indexer.pendingDeploys("NEW");
    assert.deepEqual([reg.registered, reg.pending, reg.as_of, reg.watching], [true, [], null, false], "registered: no rows; as_of null before the first pass");
    // Failures: the reader throws; the page reads that as "unknown" and shows only the quiet line.
    for (const [status, body, what] of [
      [503, "server busy; retry shortly", "a 503"],
      [404, "", "an indexer without the route"],
      [200, JSON.stringify({ ticker: "NEW", registered: false, watching: true }), "no pending list"],
      [200, JSON.stringify({ ...answer([]), ticker: "OLD" }), "an answer about another ticker"],
      [200, "null", "an empty body"],
    ]) {
      reply = [status, body];
      await assert.rejects(indexer.pendingDeploys("NEW"), undefined, what);
    }
    const failed = readPendingDeploys(null);
    assert.equal(pendingCheckLine(failed), PENDING_CHECK_FAILED_TEXT, "a failed read: the quiet line");
    assert.equal(pendingCheckLine(readPendingDeploys(answer([], { watching: false }))), PENDING_CHECK_FAILED_TEXT, "a watch that is not running: the same line");
    assert.equal(pendingCheckLine(readPendingDeploys(answer([row("b", 10)]))), null, "a list: no quiet line");
    assert.equal(pendingCheckLine(readPendingDeploys(undefined)), null, "not read yet: nothing");
  } finally {
    globalThis.fetch = savedFetch;
  }
  console.log("rivaldeploys: the reader sanitizes rows, bypasses caches when fresh, and throws on every failure");
}

// ---- the mock's /pending-deploys: the simulated mempool, the rival knob, replacement and registration ------------
{
  const store = new Map();
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const { MOCK_WALLET, MOCK_RIVAL_RATE, PENDING_DEPLOYS_REFUSAL, mockGet, mockSignPsbt, simulateBroadcast } = mock;
    const address = MOCK_WALLET.address;
    const empty = await mockGet("/pending-deploys/RACE");
    assert.deepEqual([empty.ticker, empty.registered, empty.pending, empty.watching, Number.isInteger(empty.as_of)], ["RACE", false, [], true, true]);
    // The user's DEPLOY of RACE at 3 sat/vB is listed with its own fee and size.
    const utxos = (await mockSpendable(mock, address)).utxos;
    const tokenOutpoints = (await mockGet(`/utxos/${address}`)).utxos.map(({ txid, vout }) => ({ txid, vout }));
    const built = buildDeployPsbt({ address, pubkeyHex: MOCK_WALLET.pubkeyHex, utxos, tokenOutpoints, feeRateSatVb: 3, ticker: "RACE", selectionOrder: "largest" });
    const sign = (psbtHex, idx) => extractRawTxHex(mockSignPsbt(psbtHex, { toSignInputs: idx.map((index) => ({ index, address })) }));
    const first = simulateBroadcast(sign(built.psbtHex, built.inputIndexes));
    const listed = await mockGet("/pending-deploys/race");
    assert.equal(listed.ticker, "RACE", "the ticker is trimmed and upper-cased, as the indexer does");
    assert.equal(listed.pending.length, 1);
    const mine = listed.pending[0];
    assert.equal(mine.txid, first);
    assert.ok(mine.vsize > 0 && mine.fee_sats === psbtFeeSats(built.psbtHex) && Math.abs(mine.fee_rate - 3) < 0.1, "its own fee and size");
    assert.equal(mine.fee_rate, Math.round((mine.fee_sats / mine.vsize) * 100) / 100, "fee_rate = fee_sats / vsize, 2 decimals");
    assert.equal(readPendingDeploys(listed, [first]).rivals, null, "for its sender it is no other DEPLOY");
    // The rival knob: another wallet's DEPLOY of RACE at 9 sat/vB.
    store.set("lp.mock.rivalDeploy", "RACE@9,OTHER@50");
    const race = await mockGet("/pending-deploys/RACE");
    assert.deepEqual(race.pending.map((r) => r.fee_rate), [9, mine.fee_rate], "highest first");
    assert.deepEqual(Object.keys(mine).sort(), Object.keys(race.pending.find((r) => r.txid !== first)).sort(), "a simulated DEPLOY's row has the same keys as the knob's row");
    assert.ok(Number.isInteger(mine.first_seen) && mine.first_seen > 0, "first_seen is a unix time in seconds");
    const ahead = rivalsAhead(race, { own: [first], current: first, localRate: 3 });
    assert.deepEqual([ahead.count, ahead.topRate, ahead.mine], [1, 9, mine.fee_rate], "it pays more than the user's");
    assert.equal(suggestedRivalRate(ahead.topRate, 2.38), 11);
    assert.equal(rivalPause(race, { own: [], rate: 3 }), true, "a newcomer clicking Create at 3 sat/vB stops at the warning");
    store.set("lp.mock.rivalDeploy", "RACE");
    assert.deepEqual((await mockGet("/pending-deploys/RACE")).pending.map((r) => r.fee_rate), [MOCK_RIVAL_RATE, mine.fee_rate], "no rate: the knob's default");
    store.set("lp.mock.rivalDeploy", "RACE@9");
    // Speed up to 12 sat/vB: the replaced version leaves the list, the new one is listed and ahead.
    const q = buildSpeedUpPsbt({ psbtHex: built.psbtHex, changeVout: built.changeVout, feeRateSatVb: 12, incrementalRelayFee: 0.1 });
    const faster = simulateBroadcast(sign(q.psbtHex, q.inputIndexes));
    const after = await mockGet("/pending-deploys/RACE");
    assert.deepEqual(after.pending.map((r) => r.txid).sort(), [faster, race.pending[0].txid].sort(), "the replaced version is gone");
    const fasterRow = after.pending.find((r) => r.txid === faster);
    assert.ok(Math.abs(fasterRow.vsize - psbtVsize(q.psbtHex)) < 2 && fasterRow.fee_sats === q.feeSats, "the new version with its own fee and size");
    assert.equal(rivalsAhead(after, { own: [faster, first], current: faster, localRate: q.feeRateSatVb }), null, "sped up past the other DEPLOY: nothing to say");
    // The watch knob: not running → watching false; down → a 503.
    store.set("lp.mock.deployWatch", "off");
    const off = await mockGet("/pending-deploys/RACE");
    assert.deepEqual([off.watching, readPendingDeploys(off, [first]).status], [false, "unknown"]);
    store.set("lp.mock.deployWatch", "down");
    await assert.rejects(mockGet("/pending-deploys/RACE"), (e) => e.status === 503 && e.detail === "server busy; retry shortly" && e.retryAfter === 1, "the server's busy 503");
    store.delete("lp.mock.deployWatch");
    // Bad tickers: the indexer's 400 and its sentence; an empty one is not the route.
    for (const bad of ["TOOLONGXX", "A-B", "%E2%9C%93"]) {
      await assert.rejects(mockGet(`/pending-deploys/${bad}`), (e) => e.status === 400 && e.detail === PENDING_DEPLOYS_REFUSAL, bad);
    }
    await assert.rejects(mockGet("/pending-deploys/"), (e) => e.status === 404);
    // Confirmed: RACE is registered and nothing is listed any more, the rival knob included.
    now += 20_001;
    const done = await mockGet("/pending-deploys/RACE");
    assert.deepEqual([done.registered, done.pending, readPendingDeploys(done).status], [true, [], "registered"]);
    assert.equal((await mockGet("/tokens/RACE")).deploy_txid, faster);
    const lucky = await mockGet("/pending-deploys/LUCKY");
    assert.deepEqual([lucky.registered, lucky.pending], [true, []], "a registered ticker lists nothing");
  } finally {
    Date.now = realNow;
    if (savedStorage) Object.defineProperty(globalThis, "sessionStorage", savedStorage);
    else delete globalThis.sessionStorage;
  }
  console.log("rivaldeploys mock: the simulated DEPLOY and the knob's rival are listed; a replacement and a registration take rows away");
}

// ---- a click that signs: a failed read never stops it; the context of a Retry; the review's Sign -------------------
{
  const rival = answer([row("b", 10)]);
  const throwing = async () => {
    throw new Error("503");
  };
  assert.equal(await clickPauses(throwing, { rate: 5 }), false, "a read that throws never stops the DEPLOY");
  assert.equal(await clickPauses(async () => null, { rate: 5 }), false, "a read that failed (null) neither");
  assert.equal(await clickPauses(async () => answer([row("b", 10)], { watching: false }), { rate: 5 }), false, "nor a watch that is not running");
  assert.equal(await clickPauses(async () => rival, { rate: 5 }), true, "another DEPLOY the page had not shown, paying more");
  assert.equal(await clickPauses(async () => rival, { rate: 5, shownTopRate: 10 }), false, "one the user had seen");

  // The warning shown is about the field's ticker.
  const page = {
    typed: "BBB",
    own: [TX("c")],
    shownTop: 50,
    settling: [
      { ticker: "AAA", verdict: "released", versions: [TX("a")] },
      { ticker: "CCC", verdict: "registered", versions: [TX("d")] },
    ],
  };
  assert.deepEqual(clickContext("BBB", page), { same: true, own: [TX("c")], shownTop: 50 }, "Create of the field's ticker: what the page showed");
  const retry = clickContext("AAA", page);
  assert.deepEqual(retry, { same: false, own: [TX("a")], shownTop: null }, "a Retry of another ticker: no warning shown for it; its released versions are its own");
  assert.equal(rivalPause(answer([row("b", 10)]), { own: retry.own, shownTopRate: retry.shownTop, rate: 5 }), true, "another ticker's shown rate never hides this one's other DEPLOY");
  assert.equal(rivalPause(answer([row("a", 10)]), { own: retry.own, shownTopRate: retry.shownTop, rate: 5 }), false, "its own earlier DEPLOY is not another one");
  assert.deepEqual(clickContext("CCC", page).own, [], "only a released note gives own versions");

  // The review's Sign: what the user had seen at the click stops nothing; a newcomer that the rate does not beat does.
  const accepted = { own: [], shownTop: 10 };
  const at = { own: accepted.own, shownTopRate: accepted.shownTop, rate: 5 };
  assert.equal(await clickPauses(async () => answer([row("b", 9)]), at), false, "the DEPLOY the user accepted at the click");
  assert.equal(await clickPauses(async () => answer([row("b", 9), row("e", 12)]), at), true, "one that arrived during the review");
  assert.equal(await clickPauses(async () => answer([row("e", 12)]), { own: [], shownTopRate: null, rate: 15 }), false, "the reviewed rate already pays more");
  console.log("rivaldeploys: a click stops only for a new DEPLOY its rate does not beat; a Retry of another ticker is checked for that ticker");
}

// ---- Speed up's suggested rate --------------------------------------------------------------------------------
{
  assert.equal(speedUpSuggested(2, 3, 22), 22, "never below the rate offered against another DEPLOY");
  assert.equal(speedUpSuggested(2, 3, null), 3, "no other DEPLOY: the replacement floor");
  assert.equal(speedUpSuggested(8, 3, null), 8, "or the Fast estimate");
  assert.equal(speedUpSuggested(5, null, 22), null, "no floor: nothing to suggest");
  assert.equal(speedUpSuggested(2, 3, null, 30), 30, "a read that failed while the panel is open keeps the rate it offered");
  assert.equal(speedUpSuggested(2, 3, 35, 30), 35, "a higher offer replaces it");
  console.log("rivaldeploys: Speed up suggests the highest of Fast, the floor and the rate offered against another DEPLOY");
}

// ---- the Create page and its hook use these rules -------------------------------------------------------------------
{
  const page = readFileSync(new URL("../src/pages/CreatePage.jsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/hooks/usePendingDeploys.js", import.meta.url), "utf8");
  const need = [
    [/readPendingDeploys\(pd\.answer, typedOwn\)/, "the typed ticker's list leaves out the user's released versions"],
    [/own: typedOwn,/, "and so does the click"],
    [/rivalsAhead\(pd\.answer, \{ own: flowVersions, current: flow\.txid/, "while pending, every version of the user's DEPLOY is left out"],
    [/suggestedRivalRate\(typedView\.rivals\.topRate, fastRate\)/, "the offer before signing is made against the highest rate"],
    [/suggestedRivalRate\(ahead\.topRate, fastRate\)/, "and while pending"],
    [/const ctx = clickContext\(t, at\);/, "the click's context is built for the ticker it creates"],
    [/stop = await clickPauses\(\(\) => pd\.checkNow\(t\), \{ own: ctx\.own, shownTopRate: ctx\.shownTop, rate: r \}\)/, "Create and Retry read the list once more"],
    [/stop = await clickPauses\(\(\) => pd\.checkNow\(t\), \{ own: accepted\.own, shownTopRate: accepted\.shownTop, rate: flow\.feeRateSatVb \}\)/, "so does the review's Sign"],
    [/onSign=\{signReviewed\}/, "the review signs through that check"],
    [/onClick=\{onSign\}/, "its Sign button"],
    [/if \(!mountedRef\.current \|\| clickRef\.current\.address !== at\.address\) return;[\s\S]*if \(!mountedRef\.current \|\| clickRef\.current\.address !== at\.address\) return;/, "a page left during the read signs nothing"],
    [/speedUpSuggested\(fast, floor, rivalRate, open \? heldRival : null\)/, "Speed up suggests at least the rate offered against another DEPLOY, kept while the panel is open"],
    [/const high = custom !== null && /, "only a rate the user typed asks for the high-fee confirmation"],
    [/rivalRate=\{rival\?\.ahead \? rival\.suggest : null\}/, "Speed up gets the offered rate"],
  ];
  for (const [re, what] of need) assert.match(page, re, `CreatePage.jsx: ${what}`);
  assert.doesNotMatch(page, /rivalPause\(/, "the page stops a click only through clickPauses");
  assert.match(hook, /try \{\s*answer = await indexer\.pendingDeploys\([^)]*\);\s*\} catch \{\s*answer = null;/, "usePendingDeploys: a failed read is null, never a throw");
  console.log("rivaldeploys: the Create page reads the list through these rules");
}

console.log("rivaldeploys: all checks passed");
