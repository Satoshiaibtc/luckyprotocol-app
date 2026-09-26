// MINE // LOG line model: buffer semantics and every formatter's text
// against the grammar, with fixed inputs. Plain Node, no framework.
import assert from "node:assert/strict";
import {
  MAX_LINES,
  appendLine,
  formatTime,
  hashLine,
  weightPct,
  walletLine,
  feeQuoteLine,
  tipLine,
  buildLine,
  signLine,
  broadcastingLine,
  acceptedLine,
  mempoolLine,
  heartbeatLine,
  settlementLine,
  blockFoundLine,
  digitLine,
  yoursLine,
  reconcileLine,
  errorLine,
  untrackedLine,
} from "../src/lib/minerlog.js";
import { BUCKETS, DIGIT_SPACE, bucketOfHash, yieldDigit } from "../src/lib/yield.js";

// Same gate as test/vocab.test.js — no formatter may emit a denied word.
const DENY =
  /\b(bet|bets|betting|wager|wagers|win|wins|winner|winning|won|lose|loses|losing|loss|lost|jackpot|casino|slots?|dice|roulette|wheel|lottery|raffle|draws?|confetti|odds|payout|spin|spins|roll|rolls|prize|prizes|reward|rewards|chance|chances|gamble|gambling|lucky|luck)\b/i;
const BRAND = /LUCKY\/\/PROTOCOL|LuckyProtocol|LUCKY-20|\bLUCKY\b/g;

const HASH_F = "000000000000000000009e4d7b21f0a83c5ed19b4407a6e258fd0c93b71a4c3f";
const HASH_1 = "00000000000000000001b3c2e2a9d0f7a41c9e5bb0d6f3a1c2e4f5a6b7c8d901";
const HASH_C = "00000000000000000001b3c2e2a9d0f7a41c9e5bb0d6f3a1c2e4f5a6b7c8d90c";
const HASH_8 = "00000000000000000001b3c2e2a9d0f7a41c9e5bb0d6f3a1c2e4f5a6b7c8d908";
const TXID = "a3f9c2d1e0b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a621e";
const ADDR = "bc1pqx7v9c2k4m8n3r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0z1x2c3v4b5n62s";
const T0 = new Date(2026, 8, 26, 12, 24, 2).getTime();

const outputs = [];
const keep = (l) => {
  assert.ok(l && typeof l.key === "string" && l.key.length > 0, "every line has a key");
  assert.ok(["sys", "act", "ok", "block", "tier", "err"].includes(l.kind), `kind ${l.kind}`);
  assert.ok([100, 200, 500, 1000, null].includes(l.tier), `tier ${l.tier}`);
  assert.equal(typeof l.ts, "number");
  outputs.push(l);
  return l;
};

// ---- buffer ---------------------------------------------------------------------------------------
{
  const a = appendLine([], { key: "a", kind: "sys", text: "a", ts: 1 });
  const b = appendLine(a, { key: "b", kind: "sys", text: "b", ts: 2 });
  assert.equal(a.length, 1);
  assert.equal(b.length, 2, "immutable append");
  assert.equal(appendLine(b, { key: "a", kind: "sys", text: "again", ts: 3 }), b, "duplicate key is ignored (same array)");
  assert.equal(appendLine(b, null), b, "null is ignored");
  const r = appendLine(b, { key: "a", kind: "block", text: "lit", ts: 3 }, { replace: true });
  assert.equal(r.length, 2);
  assert.equal(r[0].text, "lit", "replace swaps in place");
  assert.equal(r[1].key, "b");
  let big = [];
  for (let i = 0; i < MAX_LINES + 25; i++) big = appendLine(big, { key: `k${i}`, kind: "sys", text: String(i), ts: i });
  assert.equal(big.length, MAX_LINES, "capped at MAX_LINES");
  assert.equal(big[0].key, "k25", "oldest dropped first");
  assert.equal(big[big.length - 1].key, `k${MAX_LINES + 24}`);
  console.log("minerlog: appendLine — immutable, deduped by key, replace, capped at", MAX_LINES);
}

// ---- helpers --------------------------------------------------------------------------------------
{
  assert.equal(formatTime(T0), "12:24:02");
  assert.equal(formatTime(new Date(2026, 0, 1, 0, 5, 9).getTime()), "00:05:09");
  assert.equal(formatTime("x"), "--:--:--");
  assert.deepEqual(hashLine(HASH_F), { head: HASH_F.slice(0, 63), last: "f" });
  assert.deepEqual(hashLine(""), { head: "", last: "" });
  assert.equal(weightPct(3_996_000), "99.9");
  assert.equal(weightPct(4_000_000), "100.0");
  assert.equal(weightPct(2_000_000), "50.0");
  assert.equal(weightPct(null), null);
  assert.equal(weightPct(0), null);
  assert.equal(weightPct(4_000_001), null);
  console.log("minerlog: formatTime / hashLine / weightPct");
}

// ---- formatters -----------------------------------------------------------------------------------
{
  const w = keep(walletLine({ status: "connected", address: ADDR, providerName: "UniSat", assetSafe: true }, T0));
  assert.equal(w.kind, "sys");
  assert.equal(w.text, "wallet connected  bc1p…62s (UniSat)");
  const wf = keep(walletLine({ status: "connected", address: ADDR, providerName: "OKX Wallet", assetSafe: false }, T0));
  assert.equal(wf.text, "wallet connected  bc1p…62s (OKX Wallet) · no asset-aware UTXO list: 10,000-sat floor applies");
  assert.equal(walletLine({ status: "connected", address: ADDR }, T0).key, walletLine({ status: "connected", address: ADDR }, T0 + 400).key, "same second → same key");
  const wd = keep(walletLine({ status: "disconnected" }, T0));
  assert.equal(wd.text, "wallet disconnected");

  const f = keep(feeQuoteLine({ fastestFee: 2.38, halfHourFee: 1.5, hourFee: 1.25, economyFee: 1.02, minimumFee: 1 }, T0));
  assert.equal(f.text, "fee quote  fast 2.38 · normal 1.5 · slow 1.25 · economy 1.02 sat/vB");
  assert.equal(f.key, feeQuoteLine({ fastestFee: 2.38, halfHourFee: 1.5, hourFee: 1.25, economyFee: 1.02 }, T0 + 99_999).key, "keyed by value");
  assert.notEqual(f.key, feeQuoteLine({ fastestFee: 3, halfHourFee: 1.5, hourFee: 1.25, economyFee: 1.02 }, T0).key);
  assert.equal(feeQuoteLine({ fastestFee: null, halfHourFee: null, hourFee: null, economyFee: null }, T0), null);
  assert.equal(feeQuoteLine({ fastestFee: 2, halfHourFee: null }, T0).text, "fee quote  fast 2 sat/vB");

  const t = keep(tipLine({ height: 968_661, hash: HASH_1 }, "LUCKY", { minted: 672_000, supply: 21_000_000 }, T0));
  assert.equal(t.text, "tip #968,661  ·  LUCKY minted 3.2%");
  assert.equal(t.key, "tip:LUCKY:968661");
  assert.equal(tipLine({ height: 5 }, "X", null, T0).text, "tip #5");
  assert.equal(tipLine(null, "X", null, T0), null);

  const mine = { phase: "signing", startedAt: T0, inputCount: 2, vsize: 214, feeSats: 321, feeRateSatVb: 1.5 };
  const b = keep(buildLine(mine, "LUCKY", T0));
  assert.equal(b.kind, "act");
  assert.equal(b.text, "build MINE LUCKY  inputs 2  vsize 214 vB  fee 321 sats @ 1.5 sat/vB");
  assert.equal(b.key, `phase:build:${T0}`);
  assert.equal(buildLine({ ...mine, vsize: undefined }, "LUCKY", T0).text, "build MINE LUCKY  inputs 2  fee 321 sats @ 1.5 sat/vB", "vsize omitted when the builder gave none");

  const s = keep(signLine("UniSat", T0, T0));
  assert.equal(s.text, "sign  waiting for UniSat…");
  assert.equal(s.key, `phase:signing:${T0}`);
  assert.equal(signLine(null, T0, T0).text, "sign  waiting for your wallet…");
  const bc = keep(broadcastingLine(T0, T0));
  assert.equal(bc.text, "signed · broadcasting…");
  assert.equal(bc.key, `phase:broadcasting:${T0}`);

  const a = keep(acceptedLine(TXID, T0));
  assert.equal(a.kind, "ok");
  assert.equal(a.text, "broadcast accepted by node  txid a3f9c…21e");
  assert.equal(a.key, `accepted:${TXID}`);

  const m = keep(mempoolLine(968_662, TXID, T0));
  assert.equal(m.kind, "act");
  assert.equal(m.text, "mempool  1 mine awaiting block #968,662");
  assert.equal(m.key, `mempool:${TXID}`);

  const hb = keep(heartbeatLine(968_662, 256_000, T0));
  assert.equal(hb.kind, "sys");
  assert.equal(hb.text, `awaiting block #968,662  ·  4:16 since last block  ·  ${DIGIT_SPACE} possible digits`);
  assert.equal(hb.key, `hb:968662:${Math.floor(T0 / 60_000)}`);
  assert.equal(heartbeatLine(968_662, 256_000, T0 + 30_000).key, hb.key, "one heartbeat key per minute");
  assert.equal(heartbeatLine(968_662, null, T0).text, `awaiting block #968,662  ·  ${DIGIT_SPACE} possible digits`);

  console.log("minerlog: wallet / fee / tip / build / sign / broadcasting / accepted / mempool / heartbeat lines");
}

// ---- other miners' settlements --------------------------------------------------------------------
{
  const row = { txid: TXID, ticker: "SATS", block_height: 968_661, block_hash: HASH_1, sender: "bc1qabcdefghijklmnopqrstuvwxyz0123456789k2", status: "settled", yield_smallest: 100, cap_exhausted: false };
  const s = keep(settlementLine(row, "LUCKY", T0));
  assert.equal(s.kind, "tier");
  assert.equal(s.tier, 100);
  assert.equal(s.text, "SATS mine settled  digit 1 → yield 100  block 968,661  (bc1q…9k2)");
  assert.equal(s.key, `settle:${TXID}`);
  const f = keep(settlementLine({ ...row, block_hash: HASH_F, yield_smallest: 1000 }, "LUCKY", T0));
  assert.equal(f.tier, 1000);
  assert.equal(f.text, "SATS mine settled  digit f → yield 1,000  block 968,661  (bc1q…9k2)");
  const inv = keep(settlementLine({ ...row, status: "invalid", yield_smallest: 0 }, "LUCKY", T0));
  assert.equal(inv.kind, "err");
  assert.equal(inv.tier, null);
  assert.equal(inv.text, "SATS invalid mine  block 968,661  (bc1q…9k2)");
  const cap = keep(settlementLine({ ...row, block_hash: HASH_C, cap_exhausted: true, yield_smallest: 0 }, "LUCKY", T0));
  assert.equal(cap.text, "SATS mine settled  digit c → yield 0 (supply exhausted)  block 968,661  (bc1q…9k2)");
  assert.equal(cap.tier, 500, "tier follows the block digit");
  assert.equal(settlementLine({ ...row, ticker: undefined }, "LUCKY", T0).text.startsWith("LUCKY mine settled"), true, "falls back to the page ticker");
  assert.equal(settlementLine(null, "LUCKY", T0), null);
  console.log("minerlog: settlementLine — settled / invalid / cap_exhausted");
}

// ---- block found / digit / banner ---------------------------------------------------------------------
{
  const plain = keep(blockFoundLine({ height: 968_662, hash: HASH_F, tx_count: 3412, weight: 3_996_000 }, { at: T0 }));
  assert.equal(plain.kind, "block");
  assert.equal(plain.key, "block:968662");
  assert.equal(plain.tier, null, "plain block line carries no tier");
  assert.equal(plain.lit, false);
  assert.equal(plain.hash, HASH_F);
  assert.equal(plain.pre, "block 968,662 found  hash ");
  assert.equal(plain.post, "  txs 3,412  weight 99.9%");
  assert.equal(plain.text, `block 968,662 found  hash ${HASH_F}  txs 3,412  weight 99.9%`);
  const lit = keep(blockFoundLine({ height: 968_662, hash: HASH_F }, { lit: true, at: T0 }));
  assert.equal(lit.key, plain.key, "the lit line replaces the plain line for the same height");
  assert.equal(lit.lit, true);
  assert.equal(lit.tier, 1000);
  assert.equal(lit.text, `block 968,662 found  hash ${HASH_F}`, "txs / weight omitted when unknown");
  assert.equal(blockFoundLine({ height: 1, hash: HASH_F.toUpperCase() }, { at: T0 }).hash, HASH_F, "hash lowercased");
  assert.equal(blockFoundLine({ height: 7 }, { at: T0 }).text, "block 7 found");
  assert.equal(blockFoundLine(null), null);

  const d = keep(digitLine(HASH_F, 1000, T0));
  assert.equal(d.kind, "tier");
  assert.equal(d.tier, 1000);
  assert.equal(d.text, `last digit f → tier 1/${DIGIT_SPACE} → yield 1,000`);
  const d1 = keep(digitLine(HASH_1, 100, T0));
  assert.equal(d1.tier, 100);
  assert.equal(d1.text, `last digit 1 → tier ${BUCKETS[3].count}/${DIGIT_SPACE} → yield 100`);
  const d8 = keep(digitLine(HASH_8, 200, T0));
  assert.equal(d8.tier, 200);
  assert.equal(d8.text, `last digit 8 → tier ${BUCKETS[2].count}/${DIGIT_SPACE} → yield 200`);
  const dc = keep(digitLine(HASH_C, 500, T0));
  assert.equal(dc.tier, 500);
  assert.equal(digitLine(HASH_C, null, T0).text, `last digit c → tier ${BUCKETS[1].count}/${DIGIT_SPACE} → yield 500`, "yield falls back to the bucket");
  assert.equal(digitLine("zz", 1, T0), null);
  // the digit/tier of every formatter matches yield.js for every hash used here
  for (const h of [HASH_F, HASH_1, HASH_8, HASH_C]) assert.equal(digitLine(h, null, T0).tier, bucketOfHash(h).yield);
  assert.equal(yieldDigit(HASH_F), "f");

  const y = keep(yoursLine("LUCKY", 968_662, 1000, TXID, T0));
  assert.equal(y.kind, "tier");
  assert.equal(y.yours, true);
  assert.equal(y.tier, 1000);
  assert.equal(y.text, "LUCKY mine settled  block 968,662  ✓ yours");
  assert.equal(y.sum, "+1,000 LUCKY");
  assert.equal(y.key, `yours:${TXID}`);
  assert.equal(yoursLine("X", 1, 200, null, T0).tier, 200);
  console.log("minerlog: blockFoundLine (plain / lit) / digitLine / yoursLine");
}

// ---- reconcile: five outcomes + error ------------------------------------------------------------------
{
  const base = { phase: "confirmed", txid: TXID, yieldLocal: 1000, blockHeight: 968_662 };
  assert.equal(reconcileLine({ ...base, reconcile: "pending" }, T0), null, "nothing while reconcile is pending");
  const ok = keep(reconcileLine({ ...base, reconcile: "done", indexed: { status: "settled", ticker: "LUCKY", yield_smallest: 1000, cap_exhausted: false } }, T0));
  assert.equal(ok.kind, "sys");
  assert.equal(ok.text, "indexer: settled, 1,000 LUCKY credited");
  assert.equal(ok.key, `reconcile:${TXID}:done`);
  const inv = keep(reconcileLine({ ...base, reconcile: "done", indexed: { status: "invalid", ticker: "LUCKY", yield_smallest: 0 } }, T0));
  assert.equal(inv.text, "indexer: invalid mine (0 credited)");
  const cap = keep(reconcileLine({ ...base, reconcile: "done", indexed: { status: "settled", ticker: "LUCKY", yield_smallest: 0, cap_exhausted: true } }, T0));
  assert.equal(cap.text, "indexer: settled, supply exhausted (0 credited)");
  const to = keep(reconcileLine({ ...base, reconcile: "timeout" }, T0));
  assert.equal(to.text, "indexer has not indexed this mine yet");
  assert.equal(to.key, `reconcile:${TXID}:timeout`);
  const diff = keep(reconcileLine({ ...base, reconcile: "done", indexed: { status: "settled", ticker: "LUCKY", yield_smallest: 500, cap_exhausted: false } }, T0));
  assert.equal(diff.text, "indexer: settled, 500 LUCKY credited · local yield differs from indexer — indexer is authoritative");

  const e = keep(errorLine("Signature request was cancelled in the wallet.", T0, T0));
  assert.equal(e.kind, "err");
  assert.equal(e.text, "rejected: Signature request was cancelled in the wallet.");
  assert.equal(e.key, `error:${T0}`);
  assert.equal(errorLine("", null, T0).text, "rejected: failed");
  console.log("minerlog: reconcileLine — settled / invalid / exhausted / timeout / differs; errorLine");
}

// ---- vocabulary gate on every produced line ------------------------------------------------------------
{
  assert.ok(outputs.length >= 25, `collected ${outputs.length} lines`);
  for (const l of outputs) {
    const all = [l.text, l.sum, l.pre, l.post].filter(Boolean).join(" ").replace(BRAND, "");
    const m = all.match(DENY);
    assert.equal(m, null, `denied word "${m && m[0]}" in: ${l.text}`);
  }
  console.log(`minerlog: ${outputs.length} formatter outputs free of denied vocabulary`);
}

// ---- review round: move, null heights, untracked, edge rows ----------------------------------------
{
  const a = appendLine([], { key: "block:1", kind: "block", text: "plain", ts: 1 });
  const b = appendLine(a, { key: "other", kind: "tier", text: "someone", ts: 2 });
  const moved = appendLine(b, { key: "block:1", kind: "block", text: "lit", ts: 3 }, { move: true });
  assert.deepEqual(moved.map((l) => l.key), ["other", "block:1"], "move re-appends the line at the tail");
  assert.equal(moved[1].text, "lit");
  const appended = appendLine(b, { key: "new", kind: "sys", text: "x", ts: 4 }, { replace: true });
  assert.equal(appended.length, 3, "replace on a missing key is a plain append");
  let full = [];
  for (let i = 0; i < MAX_LINES; i++) full = appendLine(full, { key: `f${i}`, kind: "sys", text: String(i), ts: i });
  const replacedAtCap = appendLine(full, { key: "f10", kind: "sys", text: "swapped", ts: 999 }, { replace: true });
  assert.equal(replacedAtCap.length, MAX_LINES, "replace at cap keeps the length");
  assert.equal(replacedAtCap[10].text, "swapped");
  const movedAtCap = appendLine(full, { key: "f10", kind: "sys", text: "tail", ts: 999 }, { move: true });
  assert.equal(movedAtCap.length, MAX_LINES);
  assert.equal(movedAtCap[MAX_LINES - 1].key, "f10", "move at cap lands at the tail");

  assert.equal(tipLine({ height: null }, "LUCKY", null), null, "null tip height → no line");
  assert.equal(tipLine(null, "LUCKY", null), null);
  assert.equal(mempoolLine(null, "ab".repeat(32)).text, "mempool  1 mine awaiting block", "null next height → no '#—'");
  assert.equal(mempoolLine(969_801, "ab".repeat(32)).text, "mempool  1 mine awaiting block #969,801");
  assert.equal(heartbeatLine(null, null).text, "awaiting block  ·  16 possible digits");
  assert.equal(heartbeatLine(969_801, 256_000).text, "awaiting block #969,801  ·  4:16 since last block  ·  16 possible digits");
  assert.equal(blockFoundLine({ height: null, hash: "ff".repeat(32) }), null, "null block height → no line");
  const withStats = blockFoundLine({ height: 969_801, hash: "ab".repeat(32), tx_count: 3412, weight: 3_996_000 });
  assert.equal(withStats.tx_count, 3412);
  assert.equal(withStats.weight, 3_996_000, "raw capacity rides on the line for a later lit re-print");
  assert.equal(blockFoundLine({ height: 969_801, hash: "ab".repeat(32) }).post, "", "no capacity → empty post");

  const u = untrackedLine("ab".repeat(32));
  assert.equal(u.kind, "sys");
  assert.ok(u.text.startsWith("mine no longer tracked on this page  tx "), u.text);
  assert.ok(!DENY.test(u.text.replace(BRAND, "")));

  const noHash = settlementLine({ txid: "cd".repeat(32), ticker: "SATS", block_height: 969_700, sender: "bc1q" + "x".repeat(38), status: "settled", yield_smallest: 500 }, "SATS");
  assert.equal(noHash.tier, 500, "no block hash → tier from the yield");
  assert.ok(noHash.text.includes("SATS mine settled  yield 500  block 969,700"), noHash.text);
  const doneNoRow = reconcileLine({ reconcile: "done", indexed: null, txid: "ef".repeat(32) });
  assert.equal(doneNoRow.text, "indexer has not indexed this mine yet");
  console.log("minerlog: move / null heights / untracked / edge rows ok");
}
