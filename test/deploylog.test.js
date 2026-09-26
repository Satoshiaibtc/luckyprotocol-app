// DEPLOY // LOG line model: every deploy formatter's text against the
// grammar with fixed inputs, deterministic keys, the registry verdict lines,
// the LED derivation for the avatar flow, and a denied-word sweep of every
// produced line. Plain Node, no framework.
import assert from "node:assert/strict";
import {
  AVATAR_BUSY,
  AVATAR_PHASES,
  PLAIN_BUSY,
  PLAIN_PHASES,
  acceptedLine,
  avatarLeds,
  avatarLine,
  blockFoundLine,
  broadcastingLine,
  commitAcceptedLine,
  commitLine,
  deployBuildLine,
  deployConfirmedLine,
  deployHeartbeatLine,
  deployMempoolLine,
  deployUntrackedLine,
  deployedLine,
  errorLine,
  feeQuoteLine,
  pendingLine,
  reclaimLine,
  reclaimedLine,
  registrationLine,
  registrationVerdict,
  resumeLine,
  revealBuildLine,
  savedRecordLine,
  securedLine,
  securingLine,
  signLine,
  tipLine,
  unseenLine,
  walletLine,
} from "../src/lib/deploylog.js";
import { DEPLOY_PROTOCOL_FEE_SATS } from "../src/lib/payloads.js";

// Same gate as test/vocab.test.js — no formatter may emit a denied word.
const DENY =
  /\b(bet|bets|betting|wager|wagers|win|wins|winner|winning|won|lose|loses|losing|loss|lost|jackpot|casino|slots?|dice|roulette|wheel|lottery|raffle|draws?|confetti|odds|payout|spin|spins|roll|rolls|prize|prizes|reward|rewards|chance|chances|gamble|gambling|lucky|luck)\b/i;
const BRAND = /LUCKY\/\/PROTOCOL|LuckyProtocol|LUCKY-20|\bLUCKY\b/g;

const HASH = "000000000000000000009e4d7b21f0a83c5ed19b4407a6e258fd0c93b71a4c3f";
const TXID = "a3f9c2d1e0b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a621e";
const COMMIT_TXID = "1111c2d1e0b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6222";
const RECLAIM_TXID = "3333c2d1e0b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6444";
const ADDR = "bc1pqx7v9c2k4m8n3r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0z1x2c3v4b5n62s";
const COMMIT_ADDR = "bc1pzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzabc";
const T0 = new Date(2026, 8, 27, 9, 30, 15).getTime();
const CREATED_AT = T0 - 5_000;

const outputs = [];
const keep = (l) => {
  assert.ok(l && typeof l.key === "string" && l.key.length > 0, "every line has a key");
  assert.ok(["sys", "act", "ok", "block", "tier", "err"].includes(l.kind), `kind ${l.kind}`);
  assert.equal(l.tier, null, "deploy lines never carry a tier");
  assert.equal(typeof l.ts, "number");
  outputs.push(l);
  return l;
};

// ---- constants -----------------------------------------------------------------------------------
{
  assert.deepEqual(PLAIN_PHASES, ["Build", "Sign", "Broadcast", "Confirm"]);
  assert.deepEqual(AVATAR_PHASES, ["Commit", "Sign", "Broadcast", "Confirm"]);
  assert.ok(PLAIN_BUSY.has("pending") && !PLAIN_BUSY.has("confirmed") && !PLAIN_BUSY.has("error"));
  assert.ok(AVATAR_BUSY.has("securing") && AVATAR_BUSY.has("reclaim-pending") && !AVATAR_BUSY.has("resumable") && !AVATAR_BUSY.has("name-taken"));
  assert.equal(DEPLOY_PROTOCOL_FEE_SATS, 5_460, "the build line prints the protocol fee constant");
  console.log("deploylog: phase labels / busy sets");
}

// ---- shared formatters are the minerlog ones, re-exported --------------------------------------------
{
  const w = keep(walletLine({ status: "connected", address: ADDR, providerName: "UniSat", assetSafe: true }, T0));
  assert.equal(w.text, "wallet connected  bc1p…62s (UniSat)");
  const f = keep(feeQuoteLine({ fastestFee: 2.38, halfHourFee: 1.5, hourFee: 1.25, economyFee: 1.02 }, T0));
  assert.equal(f.text, "fee quote  fast 2.38 · normal 1.5 · slow 1.25 · economy 1.02 sat/vB");
  const t = keep(tipLine({ height: 969_801, hash: HASH }, "deploy", null, T0));
  assert.equal(t.text, "tip #969,801", "no token info on the create page → no minted %");
  assert.equal(t.key, "tip:deploy:969801");
  const s = keep(signLine("OKX Wallet", `commit:${CREATED_AT}`, T0));
  assert.equal(s.text, "sign  waiting for OKX Wallet…");
  assert.equal(s.key, `phase:signing:commit:${CREATED_AT}`, "the commit / reveal sign lines are keyed apart");
  assert.notEqual(signLine("x", `reveal:${CREATED_AT}`, T0).key, s.key);
  const b = keep(broadcastingLine(`reveal:${CREATED_AT}`, T0));
  assert.equal(b.text, "signed · broadcasting…");
  const a = keep(acceptedLine(TXID, T0));
  assert.equal(a.text, "broadcast accepted by node  txid a3f9c…21e");
  const bl = keep(blockFoundLine({ height: 969_802, hash: HASH, tx_count: 3412, weight: 3_996_000 }, { at: T0 }));
  assert.equal(bl.text, `block 969,802 found  hash ${HASH}  txs 3,412  weight 99.9%`);
  assert.equal(bl.lit, false, "a deploy never lights a digit");
  assert.equal(bl.tier, null);
  const e = keep(errorLine("Signature request was cancelled in the wallet.", T0, T0));
  assert.equal(e.text, "rejected: Signature request was cancelled in the wallet.");
  console.log("deploylog: shared wallet / fee / tip / sign / broadcasting / accepted / block / error lines");
}

// ---- plain DEPLOY --------------------------------------------------------------------------------
{
  const flow = { phase: "signing", ticker: "NEW", startedAt: T0, inputCount: 2, vsize: 214, feeSats: 321, feeRateSatVb: 1.5 };
  const b = keep(deployBuildLine(flow, "NEW", T0));
  assert.equal(b.kind, "act");
  assert.equal(b.text, "build DEPLOY NEW  protocol fee 5,460 sats  inputs 2  vsize 214 vB  fee 321 sats @ 1.5 sat/vB");
  assert.equal(b.key, `dphase:build:${T0}`);
  assert.equal(deployBuildLine({ ...flow, vsize: undefined }, "NEW", T0).text, "build DEPLOY NEW  protocol fee 5,460 sats  inputs 2  fee 321 sats @ 1.5 sat/vB", "vsize omitted when unknown");
  assert.equal(deployBuildLine({ phase: "signing" }, "NEW", T0).text, "build DEPLOY NEW  protocol fee 5,460 sats");
  assert.equal(deployBuildLine({ txid: TXID }, "NEW", T0).key, `dphase:build:${TXID}`, "falls back to the txid, then the second");
  assert.equal(deployBuildLine({}, "NEW", T0).key, `dphase:build:${Math.floor(T0 / 1000)}`);

  const m = keep(deployMempoolLine("NEW", 969_802, TXID, T0));
  assert.equal(m.kind, "act");
  assert.equal(m.text, "mempool  DEPLOY NEW awaiting block #969,802");
  assert.equal(m.key, `dmempool:${TXID}`);
  assert.equal(deployMempoolLine("NEW", null, TXID, T0).text, "mempool  DEPLOY NEW awaiting block", "null next height → no '#—'");

  const hb = keep(deployHeartbeatLine(969_802, 256_000, T0));
  assert.equal(hb.kind, "sys");
  assert.equal(hb.text, "awaiting block #969,802  ·  4:16 since last block", "no digit count on a deploy heartbeat");
  assert.equal(hb.key, `hb:969802:${Math.floor(T0 / 60_000)}`);
  assert.equal(deployHeartbeatLine(969_802, 256_000, T0 + 30_000).key, hb.key, "one heartbeat key per minute");
  assert.equal(deployHeartbeatLine(null, null, T0).text, "awaiting block");

  const c = keep(deployConfirmedLine("NEW", 969_802, TXID, T0));
  assert.equal(c.kind, "ok");
  assert.equal(c.text, "DEPLOY NEW confirmed  block 969,802  ·  awaiting the indexer's verdict");
  assert.equal(c.key, `dconfirmed:${TXID}`);

  const y = keep(deployedLine("NEW", 969_802, TXID, T0));
  assert.equal(y.kind, "ok");
  assert.equal(y.yours, true);
  assert.equal(y.tier, null, "the banner takes the accent, not a tier");
  assert.equal(y.sum, undefined, "no yield sum on a deploy");
  assert.equal(y.text, "NEW deployed  block 969,802  ✓ yours");
  assert.equal(y.key, `deployed:${TXID}`);
  assert.equal(deployedLine("NEW", 5, null, T0).key, "deployed:5");

  const u = keep(deployUntrackedLine(TXID, { at: T0 }));
  assert.equal(u.kind, "sys");
  assert.equal(u.text, "deploy no longer tracked on this page  tx a3f9c…21e  ·  see Portfolio");
  assert.equal(u.key, `untracked:${TXID}`);
  assert.equal(keep(deployUntrackedLine(TXID, { saved: true, at: T0 })).text, "deploy no longer tracked on this page  tx a3f9c…21e  ·  saved — resume it from this page");
  console.log("deploylog: build / mempool / heartbeat / confirmed / deployed banner / untracked");
}

// ---- the registry's verdict ------------------------------------------------------------------------
{
  assert.equal(registrationVerdict(null, TXID), "unindexed");
  assert.equal(registrationVerdict(undefined, TXID), "unindexed");
  assert.equal(registrationVerdict({ ticker: "NEW", deploy_txid: TXID }, TXID), "registered");
  assert.equal(registrationVerdict({ ticker: "NEW", deploy_txid: TXID.toUpperCase() }, TXID), "registered", "case-insensitive txid match");
  assert.equal(registrationVerdict({ ticker: "NEW", deploy_txid: COMMIT_TXID }, TXID), "taken");
  assert.equal(registrationVerdict({ ticker: "NEW" }, TXID), "taken", "a row without a txid is still another deploy's");

  const ok = keep(registrationLine("NEW", "registered", TXID, { at: T0 }));
  assert.equal(ok.kind, "sys");
  assert.equal(ok.text, "indexer: NEW registered · first deploy claims the name");
  assert.equal(ok.key, `registered:${TXID}:registered`);
  const okAvatar = keep(registrationLine("NEW", "registered", TXID, { avatarApplied: true, at: T0 }));
  assert.equal(okAvatar.text, "indexer: NEW registered · first deploy claims the name  ·  avatar applied");
  const noAvatar = keep(registrationLine("NEW", "registered", TXID, { avatarApplied: false, at: T0 }));
  assert.equal(noAvatar.text, "indexer: NEW registered · first deploy claims the name  ·  avatar not applied (replace it from Portfolio)");
  const taken = keep(registrationLine("NEW", "taken", TXID, { at: T0 }));
  assert.equal(taken.kind, "err");
  assert.equal(taken.text, "indexer: NEW was already taken (this deploy is ignored)");
  assert.equal(taken.key, `registered:${TXID}:taken`);
  const un = keep(registrationLine("NEW", "unindexed", TXID, { at: T0 }));
  assert.equal(un.kind, "sys");
  assert.equal(un.text, "indexer has not indexed this deploy yet");
  assert.equal(un.key, `registered:${TXID}:unindexed`);
  assert.equal(registrationLine("NEW", "unindexed", null, { at: T0 }).key, "registered:NEW:unindexed", "keyed by ticker when no txid is known");
  console.log("deploylog: registrationVerdict + registered / taken / unindexed lines");
}

// ---- avatar path ---------------------------------------------------------------------------------
{
  const preview = { contentType: "image/webp", width: 128, height: 128, sizeBytes: 3412, bytes: new Uint8Array(3412) };
  const av = keep(avatarLine(preview, T0));
  assert.equal(av.kind, "act");
  assert.equal(av.text, "avatar  128×128 webp  3,412 bytes");
  assert.equal(av.key, "avatar:image:webp:128x128:3412");
  assert.equal(avatarLine({ contentType: "image/png", bytes: new Uint8Array(10) }, T0).text, "avatar  png  10 bytes", "no dims → omitted; bytes from the array");
  assert.equal(avatarLine(null, T0), null);

  const sg = keep(securingLine("UniSat", null, { at: T0 }));
  assert.equal(sg.kind, "act");
  assert.equal(sg.text, "securing  recovery record · approve the message in UniSat…");
  assert.equal(sg.key, `avatar:securing:${Math.floor(T0 / 1000)}`);
  assert.equal(securingLine(null, T0, { at: T0 }).text, "securing  recovery record · approve the message in your wallet…");
  assert.equal(securingLine(null, T0, { at: T0 }).key, `avatar:securing:${T0}`);
  assert.equal(keep(securingLine("Simulated", null, { signed: false, at: T0 })).text, "securing  recovery record · simulated wallet, stored unencrypted");

  const sd = keep(securedLine(CREATED_AT, { at: T0 }));
  assert.equal(sd.text, "recovery record secured (wallet signature)");
  assert.equal(sd.key, `avatar:secured:${CREATED_AT}`);
  assert.equal(keep(securedLine(CREATED_AT, { signed: false, at: T0 })).text, "recovery record saved (simulated wallet: unencrypted)");

  const record = { kind: "deploy", address: ADDR, ticker: "NEW", commitAddress: COMMIT_ADDR, commitAmount: 12_345, createdAt: CREATED_AT };
  const cm = keep(commitLine(record, { inputCount: 2, vsize: 154, feeSats: 231, feeRateSatVb: 1.5 }, T0));
  assert.equal(cm.kind, "act");
  assert.equal(cm.text, "commit  paying 12,345 sats to bc1p…abc (commit output)  inputs 2  vsize 154 vB  fee 231 sats @ 1.5 sat/vB");
  assert.equal(cm.key, `avatar:commit:${CREATED_AT}`);
  assert.equal(commitLine(record, {}, T0).text, "commit  paying 12,345 sats to bc1p…abc (commit output)", "no build detail → just the payment");
  assert.equal(commitLine(null, {}, T0), null);

  const ca = keep(commitAcceptedLine(COMMIT_TXID, T0));
  assert.equal(ca.kind, "ok");
  assert.equal(ca.text, "commit accepted by node  txid 1111c…222");
  assert.equal(ca.key, `avatar:commit-accepted:${COMMIT_TXID}`);

  const rv = keep(revealBuildLine("NEW", record, { inputCount: 1, vsize: 412, feeSats: 618, feeRateSatVb: 1.5 }, T0));
  assert.equal(rv.kind, "act");
  assert.equal(rv.text, "reveal  building DEPLOY NEW + avatar  input0 script path  inputs 1  vsize 412 vB  fee 618 sats @ 1.5 sat/vB");
  assert.equal(rv.key, `avatar:reveal:${CREATED_AT}`);
  assert.equal(revealBuildLine("NEW", null, {}, T0).text, "reveal  building DEPLOY NEW + avatar  input0 script path");

  const withTxids = { ...record, commitTxid: COMMIT_TXID, revealTxid: TXID };
  const rs = keep(resumeLine(withTxids, T0));
  assert.equal(rs.kind, "sys");
  assert.equal(rs.text, "resume  saved creation found  commit txid 1111c…222  reveal txid a3f9c…21e");
  assert.equal(rs.key, `avatar:resume:${CREATED_AT}`);
  assert.equal(resumeLine(record, T0).text, "resume  saved creation found", "an unpaid record has no txids");
  assert.equal(resumeLine({ ...withTxids, reclaimTxid: RECLAIM_TXID }, T0).text, "resume  saved creation found  commit txid 1111c…222  reveal txid a3f9c…21e  refund txid 3333c…444");
  assert.equal(resumeLine(null, T0), null);

  const pd = keep(pendingLine("NEW", TXID, T0));
  assert.equal(pd.kind, "act");
  assert.equal(pd.text, "pending  checking DEPLOY NEW  tx a3f9c…21e every 15 s");
  assert.equal(pd.key, `dpending:${TXID}`);
  assert.equal(pendingLine("NEW", null, T0), null);

  const us = keep(unseenLine(TXID, T0));
  assert.equal(us.kind, "err");
  assert.equal(us.text, 'node has not seen tx a3f9c…21e  ·  use "Retry saved transaction"');
  assert.equal(us.key, `unseen:${TXID}`);
  assert.equal(unseenLine(null, T0), null);

  const lk = keep(savedRecordLine("NEW", "locked", T0));
  assert.equal(lk.kind, "sys");
  assert.equal(lk.text, "saved creation found for NEW  ·  locked: unlock it with the wallet that started it");
  assert.equal(lk.key, "avatar:locked:NEW");
  const iv = keep(savedRecordLine("NEW", "invalid-record", T0));
  assert.equal(iv.kind, "err");
  assert.equal(iv.text, "recovery record for NEW cannot be read  ·  keep this browser's data, a paid avatar may depend on it");
  assert.equal(iv.key, "avatar:invalid-record:NEW");
  assert.equal(savedRecordLine("NEW", "resumable", T0), null);

  const rc = keep(reclaimLine({ ...withTxids, reclaimTxid: RECLAIM_TXID }, ADDR, T0));
  assert.equal(rc.kind, "act");
  assert.equal(rc.text, "reclaim  sweeping the commit output back to bc1p…62s");
  assert.equal(rc.key, `avatar:reclaim:${RECLAIM_TXID}`);
  assert.equal(reclaimLine(withTxids, null, T0).key, `avatar:reclaim:${CREATED_AT}`, "no sweep txid yet → keyed by the record");
  assert.equal(reclaimLine(withTxids, null, T0).text, "reclaim  sweeping the commit output back to bc1p…62s", "address falls back to the record's");
  assert.equal(reclaimLine(null, ADDR, T0), null);

  const rd = keep(reclaimedLine({ ...withTxids, reclaimTxid: RECLAIM_TXID }, ADDR, 969_803, T0));
  assert.equal(rd.kind, "ok");
  assert.equal(rd.text, "refund confirmed  block 969,803  ·  commit output back at bc1p…62s");
  assert.equal(rd.key, `avatar:reclaimed:${RECLAIM_TXID}`);
  assert.equal(reclaimedLine({ ...withTxids, reclaimTxid: RECLAIM_TXID }, ADDR, null, T0).text, "refund confirmed  ·  commit output back at bc1p…62s");
  assert.equal(reclaimedLine(null, ADDR, 1, T0), null);
  console.log("deploylog: avatar / securing / secured / commit / commit accepted / reveal / resume / pending / unseen / saved record / reclaim / reclaimed");
}

// ---- LEDs for the avatar flow (Commit / Sign / Broadcast / Confirm) -------------------------------------
{
  const idle4 = ["idle", "idle", "idle", "idle"];
  assert.deepEqual(avatarLeds({ phase: "idle" }), { lit: 0, states: idle4, busy: false });
  assert.deepEqual(avatarLeds(null), { lit: 0, states: idle4, busy: false });
  assert.deepEqual(avatarLeds({ phase: "compressing" }), { lit: 0, states: idle4, busy: true });
  assert.deepEqual(avatarLeds({ phase: "securing" }), { lit: 0, states: idle4, busy: true });
  for (const p of ["commit-building", "commit-signing", "commit-broadcast"]) assert.deepEqual(avatarLeds({ phase: p }), { lit: 1, states: ["busy", "idle", "idle", "idle"], busy: true }, p);
  for (const p of ["reveal-building", "reveal-signing"]) assert.deepEqual(avatarLeds({ phase: p }), { lit: 2, states: ["ok", "busy", "idle", "idle"], busy: true }, p);
  assert.deepEqual(avatarLeds({ phase: "reveal-broadcast" }), { lit: 3, states: ["ok", "ok", "busy", "idle"], busy: true });
  assert.deepEqual(avatarLeds({ phase: "pending" }), { lit: 4, states: ["ok", "ok", "ok", "busy"], busy: true });
  assert.deepEqual(avatarLeds({ phase: "confirmed" }), { lit: 4, states: ["ok", "ok", "ok", "ok"], busy: false });
  assert.deepEqual(avatarLeds({ phase: "name-taken" }), { lit: 4, states: ["ok", "ok", "ok", "err"], busy: false });
  assert.deepEqual(avatarLeds({ phase: "reclaim-pending" }), { lit: 1, states: ["ok", "idle", "idle", "busy"], busy: true });
  assert.deepEqual(avatarLeds({ phase: "reclaimed" }), { lit: 1, states: ["ok", "idle", "idle", "ok"], busy: false });
  assert.deepEqual(avatarLeds({ phase: "resumable", record: {} }), { lit: 0, states: idle4, busy: false }, "unpaid record → nothing done");
  assert.deepEqual(avatarLeds({ phase: "resumable", record: { commitRawHex: "00" } }), { lit: 1, states: ["ok", "idle", "idle", "idle"], busy: false });
  assert.deepEqual(avatarLeds({ phase: "resumable", record: { commitRawHex: "00", revealRawHex: "00" } }), { lit: 2, states: ["ok", "ok", "idle", "idle"], busy: false }, "a signed reveal: relayed or not is for the poll to say");
  assert.deepEqual(avatarLeds({ phase: "error" }), { lit: 1, states: ["err", "idle", "idle", "idle"], busy: false }, "an error before anything was paid still shows where it stopped");
  assert.deepEqual(avatarLeds({ phase: "error", record: { commitRawHex: "00", revealRawHex: "00" } }), { lit: 2, states: ["err", "err", "idle", "idle"], busy: false });
  for (const p of AVATAR_BUSY) assert.equal(avatarLeds({ phase: p }).busy, true, `${p} is busy`);
  console.log("deploylog: avatarLeds for every phase");
}

// ---- vocabulary gate on every produced line ------------------------------------------------------------
{
  assert.ok(outputs.length >= 35, `collected ${outputs.length} lines`);
  for (const l of outputs) {
    const all = [l.text, l.sum, l.pre, l.post].filter(Boolean).join(" ").replace(BRAND, "");
    const m = all.match(DENY);
    assert.equal(m, null, `denied word "${m && m[0]}" in: ${l.text}`);
  }
  // Keys are deterministic per event: the same inputs always yield the same key (variants of one event share it on purpose).
  assert.equal(deployedLine("NEW", 969_802, TXID, T0).key, deployedLine("NEW", 969_802, TXID, T0 + 999).key);
  assert.equal(commitAcceptedLine(COMMIT_TXID, T0).key, commitAcceptedLine(COMMIT_TXID, T0 + 999).key);
  console.log(`deploylog: ${outputs.length} formatter outputs free of denied vocabulary, keys deterministic`);
}
