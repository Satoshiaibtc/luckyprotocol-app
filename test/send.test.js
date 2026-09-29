// The Send page: carrier
// rows, automatic carrier choice, amount and recipient checks, the §2.3
// layout the confirm screen shows, the pending outpoints, the route — and
// one real build through the SEND builder (two carriers, one of them
// multi-ticker, to a legacy recipient) to prove the page's inputs produce
// the reference layout. Plain Node.
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { autoPickCarriers, carrierNote, parseSendAmount, pendingSendsOf, pickedAmount, recipientState, sendAmountError, sendCarrierRows, sendFormHint, sendLayout, sendPendingOutpoints, sendReviewModel, sendVersions, spendableAmount, switchSendVersion } from "../src/lib/send.js";
import { createTxRecordStore, refreshTxRecords } from "../src/lib/txrecords.js";
import { buildSendPsbt, SEND_CHANGE_OUT, SEND_TO_OUT } from "../src/lib/psbt.js";
import { PROJECT_FEE_ADDRESS, parsePayload, payloadToString } from "../src/lib/payloads.js";
import { MOCK_WALLET } from "../src/lib/mock.js";
import { parseHash, sendHref } from "../src/hooks/useHashRoute.js";

const TX = (c) => c.repeat(64);
const SELF = MOCK_WALLET.address; // bc1p…
const BC1Q = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"; // BIP173 vector
const LEGACY = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const P2SH = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";

// ---- carrier rows --------------------------------------------------------------------------------------------
const tokenUtxos = [
  { txid: TX("a"), vout: 0, balances: { LUCKY: 1200 } },
  { txid: TX("b"), vout: 1, balances: { LUCKY: 300, ORE: 8 } },
  { txid: TX("c"), vout: 0, balances: { LUCKY: 50 } },
  { txid: TX("d"), vout: 0, balances: { LUCKY: 500 } },
  { txid: TX("e"), vout: 3, balances: { LUCKY: 70 } },
  { txid: TX("f"), vout: 0, balances: { ORE: 42 } },
];
const btcUtxos = [
  { txid: TX("a"), vout: 0, sats: 546 },
  { txid: TX("b"), vout: 1, sats: 546 },
  { txid: TX("c"), vout: 0, sats: 546 },
  { txid: TX("d"), vout: 0, sats: 546 },
  { txid: TX("e"), vout: 3, sats: 12_000 },
];
const orders = [
  { id: `${TX("d")}:0`, status: "open", ticker: "LUCKY", amount: 500 },
  { id: `${TX("e")}:3`, status: "filling", ticker: "LUCKY", amount: 70 },
  { id: `${TX("a")}:0`, status: "filled", ticker: "LUCKY", amount: 1200 },
];
const rows = sendCarrierRows({ tokenUtxos, btcUtxos, orders, pendingSpent: new Set([`${TX("c")}:0`]), ticker: "LUCKY" });
{
  assert.deepEqual(rows.map((r) => [r.txid[0], r.amount, r.blocked]), [
    ["a", 1200, null],
    ["d", 500, "listed"],
    ["b", 300, null],
    ["e", 70, "filling"],
    ["c", 50, "pending"],
  ], "largest first; listed / filling / spent-by-own-pending-tx flagged; a closed order is not a listing");
  assert.deepEqual(rows.find((r) => r.txid === TX("b")).others, [["ORE", 8]]);
  assert.equal(rows.find((r) => r.txid === TX("e")).sats, 12_000);
  assert.equal(rows.some((r) => r.txid === TX("f")), false, "ORE-only carrier is not a LUCKY row");
  assert.match(carrierNote(rows.find((r) => r.txid === TX("b")), "LUCKY"), /also carries 8 ORE — those go to your residual carrier \(vout3\), not to the recipient/);
  assert.match(carrierNote(rows.find((r) => r.txid === TX("d")), "LUCKY"), /sending it withdraws that listing/);
  assert.match(carrierNote(rows.find((r) => r.txid === TX("c")), "LUCKY"), /already spent by one of your transactions/);
  assert.equal(carrierNote(rows.find((r) => r.txid === TX("a")), "LUCKY"), "LUCKY only");
  assert.equal(spendableAmount(rows), 1200 + 500 + 300, "pending / filling rows can never be spent now");
  console.log("send rows: largest first, listed / fill pending / own pending spend flagged, other tickers named");
}

// ---- automatic carrier choice ---------------------------------------------------------------------------------
{
  const key = (c, v = 0) => `${TX(c)}:${v}`;
  assert.deepEqual(autoPickCarriers(rows, 1200), [key("a")], "an exact single-ticker carrier");
  assert.deepEqual(autoPickCarriers(rows, 100), [key("a")], "the smallest single-ticker carrier that covers it");
  assert.deepEqual(autoPickCarriers(rows, 1400), [key("a"), key("b", 1)], "single-ticker first, then a multi-ticker one — never the listed one");
  assert.equal(autoPickCarriers(rows, 1600), null, "free carriers hold 1,500 — a listed carrier is never picked automatically");
  assert.deepEqual(autoPickCarriers(rows, 0), []);
  assert.equal(pickedAmount(rows, [key("a"), key("d")]), 1700);
  console.log("send auto-pick: exact → smallest cover → largest-first; listed / pending / filling never auto-picked");
}

// ---- amount + recipient -----------------------------------------------------------------------------------------
{
  assert.equal(sendAmountError("", 1500, "LUCKY"), null);
  assert.equal(sendAmountError("1500", 1500, "LUCKY"), null);
  assert.match(sendAmountError("1501", 1500, "LUCKY"), /from 1 to 1,500 — you have 1,500 available here/);
  assert.match(sendAmountError("0", 1500, "LUCKY"), /\(not zero\)/);
  for (const bad of ["1.5", "-3", "1e3", "abc"]) assert.match(sendAmountError(bad, 1500, "LUCKY"), /whole tokens only/, bad);
  assert.match(sendAmountError("5", 0, "LUCKY"), /No LUCKY available/);

  assert.deepEqual(recipientState("", SELF), { state: "empty", address: "", label: null, error: null, self: false, feeAddress: false });
  const q = recipientState(` ${BC1Q.toUpperCase()} `, SELF);
  assert.deepEqual([q.state, q.address, q.self], ["ok", BC1Q, false], "bech32 is trimmed and lower-cased");
  assert.equal(recipientState(SELF, SELF).self, true, "sending to yourself is flagged (the page explains it is a split)");
  assert.equal(recipientState(LEGACY, SELF).state, "ok", "legacy 1… as the builder supports");
  assert.equal(recipientState(P2SH, SELF).state, "ok", "P2SH 3… as the builder supports");
  assert.equal(recipientState(PROJECT_FEE_ADDRESS, SELF).feeAddress, true);
  const typo = recipientState(BC1Q.slice(0, -1) + "5", SELF);
  assert.equal(typo.state, "invalid", "a checksum typo is refused");
  assert.match(typo.error, /not a valid Bitcoin mainnet address/);
  assert.equal(recipientState("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", SELF).state, "invalid", "testnet");
  console.log("send amount + recipient: whole tokens within the chosen carriers; bc1q / bc1p / 1… / 3… as the builder supports; self + fee address flagged");
}

// ---- the confirm screen's layout + pending outpoints ---------------------------------------------------------------
{
  const keys = [`${TX("a")}:0`, `${TX("b")}:1`];
  const L = sendLayout({ rows, keys, ticker: "LUCKY", amount: 1400, toAddress: BC1Q, self: SELF, payloadText: "LUCKY-20|SEND|LUCKY|1400|0|3" });
  assert.deepEqual(L.map((o) => o.vout), [0, 1, 2, 3, 4]);
  assert.equal(L[0].to, BC1Q);
  assert.equal(L[0].carries, "1,400 LUCKY");
  assert.equal(L[1].sats, 546);
  assert.equal(L[3].carries, "100 LUCKY + 8 ORE", "the rest of the ticker and every other ticker → vout3");
  const split = sendLayout({ rows, keys: [`${TX("b")}:1`], ticker: "LUCKY", amount: 300, toAddress: SELF, self: SELF, payloadText: "" });
  assert.equal(split[0].to, "you (new carrier)");
  assert.equal(split[3].carries, "8 ORE", "a split of a multi-ticker carrier: LUCKY alone on vout0, ORE alone on vout3");
  assert.deepEqual(sendPendingOutpoints(TX("9"), { toSelf: false }), [{ txid: TX("9"), vout: 3 }]);
  assert.deepEqual(sendPendingOutpoints(TX("9"), { toSelf: true }), [{ txid: TX("9"), vout: 0 }, { txid: TX("9"), vout: 3 }]);
  console.log("send layout: vout0 amount → recipient, vout3 residual + other tickers → you; pending carriers registered");
}

// ---- one message per amount problem; thousands separators accepted -------------------------------------------
{
  assert.equal(parseSendAmount("1500"), 1500);
  assert.equal(parseSendAmount(" 1,000 "), 1000, "the page prints 1,000 — pasting it works");
  assert.equal(parseSendAmount("1,234,567"), 1_234_567);
  for (const bad of ["1,00", "10,0000", "1.5", "", "abc", "1e3", "-3", ",100"]) assert.equal(parseSendAmount(bad), null, bad);
  assert.equal(sendAmountError("1,000", 1500, "LUCKY"), null, "1,000 is a whole number");
  assert.match(sendAmountError("1,00", 1500, "LUCKY"), /digits only, for example 1500 \(commas only between groups of three digits\)/);
  assert.match(sendAmountError("1.5", 1500, "LUCKY"), /whole tokens only/);
  const base = { connected: true, indexerOk: true, lagText: null, rcptState: "ok", keysCount: 1, pickedTotal: 1800, mode: "auto", freeTotal: 1800, ticker: "LUCKY", feeHint: null };
  // The field shows the specific error; the hint under the form adds nothing that contradicts it.
  for (const text of ["1.5", "0", "1,00", "9999"]) {
    const amountErr = sendAmountError(text, 1800, "LUCKY");
    assert.ok(amountErr, text);
    assert.equal(sendFormHint({ ...base, amount: parseSendAmount(text), amountErr }), null, `no second line for ${text}`);
  }
  assert.equal(sendFormHint({ ...base, amount: null, amountErr: null }), "Enter how many LUCKY to send.", "an EMPTY field asks for an amount");
  assert.equal(sendFormHint({ ...base, amount: 1000, amountErr: null }), null);
  assert.match(sendFormHint({ ...base, amount: 1000, amountErr: null, pickedTotal: 10 }), /hold 1,800 — not enough for 1,000/);
  assert.equal(sendFormHint({ ...base, rcptState: "empty", amount: 5, amountErr: null }), "Enter the recipient's address.");
  console.log("send amount: 1,000 accepted; a bad amount shows one message, never a contradicting second line");
}

// ---- the review shows what was signed, not the live rows ----------------------------------------------------------
{
  const keys = [`${TX("a")}:0`];
  const signed = sendReviewModel({ rows, keys, ticker: "LUCKY", amount: 500, toAddress: BC1Q, self: SELF, payloadText: "LUCKY-20|SEND|LUCKY|500|0|3", feeRateSatVb: 2 });
  const before = JSON.stringify(signed);
  assert.equal(signed.layout[3].carries, "700 LUCKY", "the signed tx: 1,200 − 500 back to vout3");
  assert.equal(signed.feeRateSatVb, 2);
  // After the broadcast the spent carrier leaves the live rows (and the form's auto-pick moves on);
  // a model rebuilt from them would describe another transaction…
  const liveRows = rows.filter((r) => r.key !== keys[0]);
  const rebuilt = sendReviewModel({ rows: liveRows, keys: autoPickCarriers(liveRows, 500) || [], ticker: "LUCKY", amount: 500, toAddress: BC1Q, self: SELF, payloadText: "", feeRateSatVb: 9 });
  assert.notEqual(rebuilt.layout[3].carries, signed.layout[3].carries);
  // …while the frozen one is a copy that nothing later can change.
  rows[0].balances.LUCKY = 1;
  assert.equal(JSON.stringify(signed), before);
  rows[0].balances.LUCKY = 1200;
  const withOthers = sendReviewModel({ rows, keys: [`${TX("b")}:1`], ticker: "LUCKY", amount: 300, toAddress: SELF, self: SELF, payloadText: "" });
  assert.equal(withOthers.toSelf, true);
  assert.deepEqual(withOthers.others.map((r) => r.others), [[["ORE", 8]]]);
  console.log("send review: frozen at signing — the table, the other tickers and the fee rate are the signed ones");
}

// ---- the unconfirmed-sends list clears when a send confirms --------------------------------------------------
{
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  let now = 1_790_000_000_000;
  const store = createTxRecordStore({ storage, now: () => now });
  store.add(SELF, { txid: TX("5"), kind: "send", ticker: "LUCKY", inputs: [`${TX("a")}:0`] });
  store.add(SELF, { txid: TX("6"), kind: "send", ticker: "ORE", inputs: [] });
  assert.deepEqual(pendingSendsOf(store.list(SELF), "LUCKY").map((r) => r.txid), [TX("5")]);
  now += 60_000;
  const answers = { [TX("5")]: { confirmed: true, seen: true, block_height: 969_815 }, [TX("6")]: { confirmed: false, seen: true } };
  await refreshTxRecords(SELF, async (t) => answers[t], { store, now: () => now });
  assert.deepEqual(pendingSendsOf(store.list(SELF), "LUCKY"), [], "the confirmed send left the list");
  assert.equal(pendingSendsOf(store.list(SELF), "ORE").length, 1, "a pending one stays");
  console.log("send pending: the page's poll re-checks its sends; a confirmed one leaves the unconfirmed list");
}

// ---- the route -----------------------------------------------------------------------------------------------------
{
  assert.deepEqual([parseHash("#/send/lucky").name, parseHash("#/send/lucky").ticker], ["send", "LUCKY"]);
  assert.equal(parseHash("#/send/bad-ticker!").name, "notfound");
  assert.equal(parseHash("#/send").name, "notfound");
  const h = sendHref("ore", { utxo: `${TX("b")}:1`, toSelf: true });
  assert.equal(h, `#/send/ORE?utxo=${TX("b")}%3A1&to=self`);
  const r = parseHash(h);
  assert.deepEqual([r.name, r.ticker, r.params.utxo, r.params.to], ["send", "ORE", `${TX("b")}:1`, "self"]);
  assert.equal(sendHref("LUCKY"), "#/send/LUCKY");
  console.log("send route: #/send/<TICKER>[?utxo=…&to=self]");
}

// ---- one real build: two carriers (one multi-ticker) → a legacy recipient ------------------------------------------------
{
  const fee = { txid: TX("7"), vout: 0, sats: 60_000 };
  const built = buildSendPsbt({
    address: SELF,
    pubkeyHex: MOCK_WALLET.pubkeyHex,
    utxos: [fee],
    tokenOutpoints: tokenUtxos.map(({ txid, vout }) => ({ txid, vout })),
    tokenUtxos: [{ txid: TX("a"), vout: 0, sats: 546 }, { txid: TX("b"), vout: 1, sats: 546 }],
    feeRateSatVb: 2,
    ticker: "LUCKY",
    amount: 1400,
    toAddress: LEGACY,
  });
  const tx = btc.Transaction.fromPSBT(hex.decode(built.psbtHex), { allowUnknownOutputs: true });
  const addr = (i) => btc.Address(btc.NETWORK).encode(btc.OutScript.decode(tx.getOutput(i).script));
  assert.equal(tx.inputsLength, 3, "both carriers + one fee input");
  assert.equal(addr(SEND_TO_OUT), LEGACY, "vout0 → the recipient");
  assert.equal(Number(tx.getOutput(0).amount), 546);
  assert.equal(addr(1), PROJECT_FEE_ADDRESS);
  const p = parsePayload(payloadToString(tx.getOutput(2).script.slice(2)));
  assert.deepEqual([p.op, p.ticker, p.amount, p.toOutIdx, p.changeOutIdx], ["SEND", "LUCKY", 1400, SEND_TO_OUT, SEND_CHANGE_OUT]);
  assert.equal(addr(SEND_CHANGE_OUT), SELF, "vout3 (residual: 100 LUCKY + 8 ORE) → you");
  console.log("send build: 2 carriers → legacy recipient in the §2.3 layout");
}

// ---- a sped-up send: every version is followed -------------------------------------------------------
{
  assert.deepEqual(sendVersions({ txid: TX("3") }), [TX("3")], "never sped up: one version");
  const chain = { phase: "unseen", note: "not seen", txid: TX("3"), replaces: [TX("1"), TX("2")], psbt: "70736274ff", ticker: "LUCKY" };
  assert.deepEqual(sendVersions(chain), [TX("3"), TX("2"), TX("1")], "the current version first, then the replaced ones, newest first");
  assert.deepEqual(sendVersions(null), []);
  // A block confirmed the first version instead of the faster copies: the flow follows it.
  const next = switchSendVersion(chain, TX("1"));
  assert.equal(next.txid, TX("1"));
  assert.deepEqual(next.replaces, [TX("2"), TX("3")], "the others stay known as replaced versions");
  assert.deepEqual(sendVersions(next).slice().sort(), sendVersions(chain).slice().sort(), "no version is lost");
  assert.equal(next.psbt, null, "nothing left to speed up");
  assert.deepEqual([next.phase, next.note], ["pending", null], "pending until its own check says confirmed — never \"not seen\"");
  assert.equal(next.ticker, "LUCKY");
  assert.equal(switchSendVersion(chain, TX("3")), chain, "the version it already follows: unchanged");
  console.log("send speed up: every version is known, a confirmed earlier one becomes the send");
}

console.log("send: all checks passed");
