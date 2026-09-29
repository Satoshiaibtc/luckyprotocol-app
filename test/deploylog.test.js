// DEPLOY // LOG line model: every deploy formatter's text against the
// grammar with fixed inputs, deterministic keys, the registry verdict lines
// and a denied-word sweep of every produced line. Plain Node, no framework.
import assert from "node:assert/strict";
import * as deploylog from "../src/lib/deploylog.js";
import {
  DEPLOY_PHASES,
  PLAIN_BUSY,
  PLAIN_PHASES,
  abandonedLine,
  createdFinalLine,
  createdReorgLine,
  publishBuildLine,
  reservationExpiredLine,
  reservationResumedLine,
  reserveBuildLine,
  reserveConfirmedLine,
  reserveMempoolLine,
  reserveRecordedLine,
  speedUpLine,
  stepDroppedLine,
  stepFoundLine,
  stepLeftBlockLine,
  stepUnseenLine,
  takenBeforePublishLine,
  acceptedLine,
  blockFoundLine,
  broadcastingLine,
  deployBuildLine,
  deployConfirmedLine,
  deployHeartbeatLine,
  deployMempoolLine,
  deployUntrackedLine,
  deployedLine,
  errorLine,
  feeQuoteLine,
  registrationLine,
  registrationVerdict,
  signLine,
  tipLine,
  walletLine,
} from "../src/lib/deploylog.js";
import { ACTIVATION_HEIGHT, DEPLOY_PROTOCOL_FEE_SATS, commitHashFor } from "../src/lib/payloads.js";
import {
  DEAD_END_PHASES,
  DRAFT_STALE_MS,
  PUBLISH_CUTOFF_BLOCKS,
  PUBLISH_MIN_CONFIRMATIONS,
  commitAfterRecheck,
  commitRecheckNeeded,
  createSettlingStore,
  publishMissedBlock,
  normalizeSettlingNote,
  revealLeftBlock,
  settlingKey,
  settlingVerdict,
  commitMismatch,
  commitStatusText,
  createDeployRecordStore,
  deployPhase,
  deployRecordKey,
  deployStage,
  expiryText,
  invalidReasonText,
  isStaleDraft,
  normalizeDeployRecord,
  resolveVersions,
  revealTiming,
  revealVerdict,
  revealReasonText,
  revealWindow,
  sameAddress,
  stepVersions,
  switchStepTo,
} from "../src/lib/commitReveal.js";
import { _sanitizeCommit } from "../src/lib/indexer.js";
import { appendLine } from "../src/lib/minerlog.js";

// Same gate as test/vocab.test.js — no formatter may emit a denied word.
const DENY =
  /\b(bet|bets|betting|wager|wagers|win|wins|winner|winning|won|lose|loses|losing|loss|lost|jackpot|casino|slots?|dice|roulette|wheel|lottery|raffle|draws?|confetti|odds|payout|spin|spins|roll|rolls|prize|prizes|reward|rewards|chance|chances|gamble|gambling|lucky|luck)\b/i;
const BRAND = /LUCKY\/\/PROTOCOL|LuckyProtocol|LUCKY-20|\bLUCKY\b/g;

const HASH = "000000000000000000009e4d7b21f0a83c5ed19b4407a6e258fd0c93b71a4c3f";
const TXID = "a3f9c2d1e0b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a621e";
const OTHER_TXID = "1111c2d1e0b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6222";
const ADDR = "bc1pqx7v9c2k4m8n3r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0z1x2c3v4b5n62s";
// The carrier scripts of spec §2.1 vectors 1 and 4 (a P2TR and a P2WPKH script).
const SPK = "51200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const SPK_OTHER = "0014bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T0 = new Date(2026, 8, 27, 9, 30, 15).getTime();

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
  assert.ok(PLAIN_BUSY.has("pending") && !PLAIN_BUSY.has("confirmed") && !PLAIN_BUSY.has("error"));
  assert.equal(DEPLOY_PROTOCOL_FEE_SATS, 5_460, "the build line prints the protocol fee constant");
  assert.deepEqual(DEPLOY_PHASES, ["Reserve", "Confirm", "Publish", "Registered"], "the two-step deploy's LEDs");
  // The avatar path was withdrawn (spec §8): none of its grammar is left.
  for (const gone of ["AVATAR_PHASES", "AVATAR_BUSY", "avatarLeds", "avatarLine", "reclaimLine"]) {
    assert.equal(deploylog[gone], undefined, `${gone} is gone`);
  }
  console.log("deploylog: phase labels / busy set, no avatar path");
}

// ---- shared formatters are the minerlog ones, re-exported --------------------------------------------
{
  const w = keep(walletLine({ status: "connected", address: ADDR, providerName: "UniSat", assetSafe: true }, T0));
  assert.equal(w.text, "wallet connected  bc1p…62s (UniSat)");
  const f = keep(feeQuoteLine({ fastestFee: 2.38, halfHourFee: 1.5, hourFee: 1.25, economyFee: 1.02 }, T0));
  assert.equal(f.text, "fee quote  fast 2.38 · normal 1.5 · slow 1.25 · economy 1.02 sat/vB");
  const t = keep(tipLine({ height: 970_101, hash: HASH }, "deploy", null, T0));
  assert.equal(t.text, "tip #970,101", "no token info on the create page → no minted %");
  assert.equal(t.key, "tip:deploy:970101");
  const s = keep(signLine("OKX Wallet", T0, T0));
  assert.equal(s.text, "sign  waiting for OKX Wallet…");
  assert.equal(s.key, `phase:signing:${T0}`, "keyed by the attempt");
  assert.notEqual(signLine("x", T0 + 1, T0).key, s.key);
  const b = keep(broadcastingLine(T0, T0));
  assert.equal(b.text, "signed · broadcasting…");
  const a = keep(acceptedLine(TXID, T0));
  assert.equal(a.text, "broadcast accepted by node  txid a3f9c…21e");
  const bl = keep(blockFoundLine({ height: 970_102, hash: HASH, tx_count: 3412, weight: 3_996_000 }, { at: T0 }));
  assert.equal(bl.text, `block 970,102 found  hash ${HASH}  txs 3,412  weight 99.9%`);
  assert.equal(bl.lit, false, "a deploy never lights a digit");
  assert.equal(bl.tier, null);
  const e = keep(errorLine("Signature request was cancelled in the wallet.", T0, T0));
  assert.equal(e.text, "stopped: Signature request was cancelled in the wallet.", "a neutral prefix — nothing claims someone rejected it");
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

  const m = keep(deployMempoolLine("NEW", 970_102, TXID, T0));
  assert.equal(m.kind, "act");
  assert.equal(m.text, "mempool  DEPLOY NEW awaiting block #970,102");
  assert.equal(m.key, `dmempool:${TXID}`);
  assert.equal(deployMempoolLine("NEW", null, TXID, T0).text, "mempool  DEPLOY NEW awaiting block", "null next height → no '#—'");

  const hb = keep(deployHeartbeatLine(970_102, 256_000, T0));
  assert.equal(hb.kind, "sys");
  assert.equal(hb.text, "awaiting block #970,102  ·  4:16 since last block", "no digit count on a deploy heartbeat");
  assert.equal(hb.key, `hb:970102:${Math.floor(T0 / 60_000)}`);
  assert.equal(deployHeartbeatLine(970_102, 256_000, T0 + 30_000).key, hb.key, "one heartbeat key per minute");
  assert.equal(deployHeartbeatLine(null, null, T0).text, "awaiting block");

  const c = keep(deployConfirmedLine("NEW", 970_102, TXID, T0));
  assert.equal(c.kind, "ok");
  assert.equal(c.text, "DEPLOY NEW confirmed  block 970,102  ·  awaiting the indexer's verdict");
  assert.equal(c.key, `dconfirmed:${TXID}:970102`);
  assert.notEqual(deployConfirmedLine("NEW", 970_103, TXID, T0).key, c.key, "confirmed again in a new block after a reorganization: logged again");

  const y = keep(deployedLine("NEW", 970_102, TXID, T0));
  assert.equal(y.kind, "ok");
  assert.equal(y.yours, true);
  assert.equal(y.tier, null, "the banner takes the accent, not a tier");
  assert.equal(y.sum, undefined, "no yield sum on a deploy");
  assert.equal(y.text, "NEW deployed  block 970,102  ✓ yours");
  assert.equal(y.key, `deployed:${TXID}`);
  assert.equal(deployedLine("NEW", 5, null, T0).key, "deployed:5");

  const u = keep(deployUntrackedLine(TXID, { at: T0 }));
  assert.equal(u.kind, "sys");
  assert.equal(u.text, "deploy no longer tracked on this page  tx a3f9c…21e  ·  tracking resumes when you return");
  assert.equal(u.key, `untracked:${TXID}`);
  console.log("deploylog: build / mempool / heartbeat / confirmed / deployed banner / untracked");
}

// ---- the registry's verdict ------------------------------------------------------------------------
{
  assert.equal(registrationVerdict(null, TXID), "unindexed");
  assert.equal(registrationVerdict(undefined, TXID), "unindexed");
  assert.equal(registrationVerdict({ ticker: "NEW", deploy_txid: TXID }, TXID), "registered");
  assert.equal(registrationVerdict({ ticker: "NEW", deploy_txid: TXID.toUpperCase() }, TXID), "registered", "case-insensitive txid match");
  assert.equal(registrationVerdict({ ticker: "NEW", deploy_txid: OTHER_TXID }, TXID), "taken");
  assert.equal(registrationVerdict({ ticker: "NEW" }, TXID), "taken", "a row without a txid is still another deploy's");

  const ok = keep(registrationLine("NEW", "registered", TXID, { at: T0 }));
  assert.equal(ok.kind, "sys");
  assert.equal(ok.text, "indexer: NEW registered · first deploy claims the name");
  assert.equal(ok.key, `registered:${TXID}:registered`);
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

// ---- two-step deploy lines (reserve → publish, §2.1) ------------------------------------------------------
{
  const info = { startedAt: T0, inputCount: 1, vsize: 246, feeSats: 738, feeRateSatVb: 3 };
  const b = keep(reserveBuildLine(info, T0));
  assert.equal(b.text, "step 1/2 reserve  COMMIT (ticker hidden)  inputs 1  vsize 246 vB  fee 738 sats @ 3 sat/vB");
  assert.ok(!/NEW/.test(b.text), "the reserve line never names the ticker");
  assert.equal(b.key, `cr:build:commit:${T0}`);
  const m = keep(reserveMempoolLine(970_102, TXID, T0));
  assert.equal(m.text, "mempool  COMMIT awaiting block #970,102  tx a3f9c…21e");
  const c = keep(reserveConfirmedLine(970_102, revealWindow(970_102), TXID, T0));
  assert.equal(c.text, "COMMIT confirmed  block 970,102  ·  publish from block #970,103, by block #972,118");
  assert.equal(c.kind, "ok");
  const r = keep(reserveRecordedLine(TXID, T0));
  assert.equal(r.text, "indexer: reservation recorded · step 2 (publish) is open");
  const pb = keep(publishBuildLine({ ...info, inputCount: 2, vsize: 318, feeSats: 757, feeRateSatVb: 2.38 }, "NEW", T0));
  assert.equal(pb.text, "step 2/2 publish  DEPLOY NEW  protocol fee 5,460 sats  inputs 2  vsize 318 vB  fee 757 sats @ 2.38 sat/vB");
  assert.notEqual(pb.key, b.key, "the two steps of one attempt never share a key");
  const su = keep(speedUpLine("COMMIT", { oldFeeSats: 738, feeSats: 1_476, feeRateSatVb: 6, txid: OTHER_TXID }, T0));
  assert.equal(su.text, "speed up COMMIT  fee 738 → 1,476 sats @ 6 sat/vB  new tx 1111c…222");
  const t = keep(takenBeforePublishLine("NEW", "k", T0));
  assert.equal(t.kind, "err");
  assert.equal(t.text, "indexer: NEW was registered by another deploy first");
  const ex = keep(reservationExpiredLine(972_118, TXID, T0));
  assert.equal(ex.text, "reservation expired  block #972,118 passed without a publish");
  const ab = keep(abandonedLine("NEW", TXID, T0));
  assert.equal(ab.text, "reservation for NEW abandoned · the 546-sat output stays in your wallet");
  const rs = keep(reservationResumedLine("NEW", 1, TXID, T0));
  assert.equal(rs.text, "resumed reservation NEW  step 1 tx a3f9c…21e");
  const dr = keep(stepDroppedLine("COMMIT", TXID, T0));
  assert.equal(dr.text, "COMMIT a3f9c…21e left the mempool without confirming");
  const un = keep(stepUnseenLine("COMMIT", TXID, T0));
  assert.equal(un.text, "COMMIT a3f9c…21e not seen by the indexer's node for a few minutes · still checking (it may confirm)");
  assert.equal(keep(stepFoundLine("COMMIT", TXID, 970_110, T0)).text, "COMMIT a3f9c…21e found  confirmed in block #970,110");
  assert.equal(keep(stepFoundLine("DEPLOY", TXID, null, T0)).text, "DEPLOY a3f9c…21e found  in the mempool");
  console.log("deploylog: reserve / publish / speed up / taken / expired / abandoned / resumed / dropped lines");
}

// ---- the reservation record (src/lib/commitReveal.js) ------------------------------------------------------
{
  const SALT = "00112233445566778899aabbccddeeff";
  const fake = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
  };
  const storage = fake();
  let now = T0;
  const store = createDeployRecordStore({ storage, now: () => now });
  assert.equal(store.load(ADDR), null);
  assert.equal(deployRecordKey(ADDR.toUpperCase()), `lp.deploy.${ADDR.toLowerCase()}`, "keyed per address, lower-cased");
  const draft = store.start(ADDR, { ticker: "NEW", salt: SALT, carrierScript: SPK });
  assert.equal(draft.hash, commitHashFor("NEW", SALT, SPK), "the hash is derived from ticker + salt + carrier script, never trusted");
  assert.equal(draft.carrierScript, SPK, "the record keeps the script H binds");
  assert.throws(() => store.start("bc1qnoscript", { ticker: "NEW", salt: SALT }), /carrier script/, "no script, no reservation");
  assert.equal(deployStage(draft), "draft");
  assert.ok(storage.m.has(deployRecordKey(ADDR)), "persisted BEFORE anything is signed");
  const step = { txid: TXID, psbt: "70736274ff", signedAt: T0, sentAt: null, height: null, feeSats: 738, feeRateSatVb: 3, vsize: 246, changeVout: 2, inputs: [{ txid: OTHER_TXID, vout: 1, sats: 90_000 }] };
  store.update(ADDR, (r) => ({ ...r, carrierSats: 546, commit: step }));
  assert.equal(deployStage(store.load(ADDR)), "commit-unsent");
  store.update(ADDR, (r) => ({ ...r, commit: { ...r.commit, sentAt: T0 + 1 } }));
  const sent = store.load(ADDR);
  assert.equal(deployStage(sent), "committed");
  assert.equal(sent.salt, SALT, "the salt survives a reload (a fresh read of storage)");
  // A tampered salt, script or hash is refused (it could never match the on-chain COMMIT).
  assert.equal(normalizeDeployRecord({ ...sent, salt: "f".repeat(32) }), null);
  assert.equal(normalizeDeployRecord({ ...sent, hash: "0".repeat(64) }), null);
  assert.equal(normalizeDeployRecord({ ...sent, carrierScript: SPK_OTHER }), null, "another script is another H");
  assert.equal(normalizeDeployRecord({ ...sent, carrierScript: undefined, hash: undefined }), null, "a record without its script (version 1) cannot recompute H");
  assert.equal(normalizeDeployRecord({ ...sent, carrierScript: SPK_OTHER, hash: undefined }).hash, commitHashFor("NEW", SALT, SPK_OTHER));
  assert.equal(normalizeDeployRecord({ ...sent, ticker: "bad" }), null);
  assert.equal(normalizeDeployRecord({ ...sent, commit: null, reveal: step }).reveal, null, "a reveal without a commit is dropped");
  storage.setItem(deployRecordKey(ADDR), "{not json");
  assert.equal(store.load(ADDR), null, "garbage reads as no record");
  // A storage that throws falls back to memory.
  const broken = createDeployRecordStore({ storage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} } });
  broken.start(ADDR, { ticker: "NEW", salt: SALT, carrierScript: SPK });
  assert.equal(broken.backend(), "memory");
  assert.equal(broken.load(ADDR).ticker, "NEW");
  now += 1;
  console.log("commitReveal: record stored before signing, stages, tamper-proof hash, storage fallback");
}

// ---- a draft is never deleted under a signature, and never overwritten -------------------------
{
  const SALT_A = "0123456789abcdef0123456789abcdef";
  const SALT_B = "fedcba9876543210fedcba9876543210";
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  let now = T0;
  // Two tabs = two stores over the same storage.
  const tabA = createDeployRecordStore({ storage, now: () => now });
  const tabB = createDeployRecordStore({ storage, now: () => now });
  const a = tabA.start(ADDR, { ticker: "ONE", salt: SALT_A, carrierScript: SPK });
  // Tab B presses Reserve a moment later: refused — it can never overwrite A's salt.
  assert.throws(() => tabB.start(ADDR, { ticker: "TWO", salt: SALT_B, carrierScript: SPK }), (e) => e.code === "busy" && /already open/.test(e.message));
  assert.equal(tabB.load(ADDR).salt, SALT_A);
  // A young draft is not stale (a wallet window may still be open)…
  assert.equal(isStaleDraft(a, T0 + 60_000), false);
  assert.equal(isStaleDraft(a, T0 + DRAFT_STALE_MS + 1), true, "…an old one is");
  // …and after DRAFT_STALE_MS another start may replace it.
  now = T0 + DRAFT_STALE_MS + 1;
  const b = tabB.start(ADDR, { ticker: "TWO", salt: SALT_B, carrierScript: SPK });
  assert.equal(tabA.load(ADDR).salt, SALT_B);
  // Tab A's signature returns: the claim sees the record changed → nothing is written (and nothing may be broadcast).
  const step = { txid: TXID, psbt: "70736274ff", signedAt: now, sentAt: null, height: null };
  const mine = (salt, ticker) => (r) => r.ticker === ticker && r.salt === salt && !r.commit;
  assert.equal(tabA.claim(ADDR, mine(SALT_A, "ONE"), (r) => ({ ...r, commit: step })), null);
  assert.equal(tabA.load(ADDR).commit, null, "B's draft is untouched");
  // B's own claim succeeds exactly once.
  assert.equal(tabB.claim(ADDR, mine(SALT_B, "TWO"), (r) => ({ ...r, commit: step })).commit.txid, TXID);
  assert.equal(tabB.claim(ADDR, mine(SALT_B, "TWO"), (r) => ({ ...r, commit: step })), null, "a claimed draft is no draft any more");
  // A discarded draft (e.g. Discard in another tab) → the claim finds nothing.
  tabA.clear(ADDR);
  tabA.start(ADDR, { ticker: "ONE", salt: SALT_A, carrierScript: SPK });
  tabB.clear(ADDR);
  assert.equal(tabA.claim(ADDR, mine(SALT_A, "ONE"), (r) => ({ ...r, commit: step })), null);
  assert.equal(deployStage(b), "draft");
  console.log("commitReveal: a second Reserve is refused while a reservation is open; a changed / discarded draft is never claimed (nothing broadcast)");
}

// ---- a replaced or unseen step is never given up --------------------------------------------------
{
  const TX_A = "1".repeat(64);
  const TX_B = "2".repeat(64);
  const TX_C = "3".repeat(64);
  const step = { txid: TX_C, psbt: "70736274ff", signedAt: T0, sentAt: T0, height: null, feeSats: 900, replaces: [TX_A, TX_B] };
  assert.deepEqual(stepVersions(step), [TX_C, TX_B, TX_A], "current first, then newest replaced");
  const st = (confirmed, seen, h = null) => ({ confirmed, seen, in_mempool: seen && !confirmed, block_height: h });
  assert.deepEqual(resolveVersions([{ txid: TX_C, status: st(false, false) }, { txid: TX_A, status: st(true, true, 970_110) }]), { kind: "confirmed", txid: TX_A, height: 970_110 }, "the ORIGINAL confirmed after a Speed up");
  assert.deepEqual(resolveVersions([{ txid: TX_C, status: st(false, false) }, { txid: TX_B, status: st(false, true) }]), { kind: "seen", txid: TX_B });
  assert.deepEqual(resolveVersions([{ txid: TX_C, status: st(false, false) }, { txid: TX_B, status: null }]), { kind: "unknown" });
  assert.deepEqual(resolveVersions([{ txid: TX_C, status: st(false, false) }]), { kind: "none" });
  const sw = switchStepTo(step, TX_A, { height: 970_110 });
  assert.equal(sw.txid, TX_A);
  assert.equal(sw.height, 970_110);
  assert.deepEqual(new Set(sw.replaces), new Set([TX_B, TX_C]), "the other versions stay known");
  assert.equal(sw.feeSats, null, "the fee shown was the replacement's, not this version's");
  assert.equal(sw.unseenAt, null);
  // The record keeps the salt through all of it: phases never clear it.
  const SALT = "00112233445566778899aabbccddeeff";
  const base = { ticker: "NEW", salt: SALT, carrierScript: SPK, createdAt: T0, carrierSats: 546, commit: null, reveal: null };
  const rec = (c, r = null, extra = {}) => normalizeDeployRecord({ ...base, commit: c, reveal: r, ...extra });
  const ph = (r, extra = {}) => deployPhase({ rec: r, commitStatus: undefined, row: undefined, tip: 969_700, ...extra });
  assert.equal(ph(rec({ ...step, unseenAt: T0 + 200_000 })), "reserve-unseen", "an unseen COMMIT is not nothing reserved");
  assert.equal(ph(rec({ txid: TX_C, signedAt: T0, sentAt: null, unseenAt: T0 + 200_000 })), "reserve-unseen", "…nor is an unsent one");
  assert.equal(rec({ ...step, unseenAt: T0 + 200_000 }).salt, SALT);
  const conf = { txid: TX_A, sentAt: T0, height: 969_700 };
  const rv = { txid: TX_B, sentAt: T0 + 5, height: null, unseenAt: T0 + 300_000 };
  assert.equal(ph(rec(conf, rv), { row: null }), "publish-unseen");
  assert.equal(ph(rec(conf, { ...rv, replaces: [TX_C] }), { row: { deploy_txid: TX_C } }), "registered-provisional", "the replaced publish confirmed (its depth unknown: not final)");
  assert.equal(ph(rec(conf, { ...rv, replaces: [TX_C] }), { row: { deploy_txid: TX_C, deploy_block: 969_695 } }), "registered", "…and final once its block is 6 deep");
  // A released publish (droppedReveals) that confirmed after all is still ours.
  const released = rec(conf, null, { droppedReveals: [TX_B] });
  assert.deepEqual(released.droppedReveals, [TX_B]);
  assert.equal(ph(released, { commitStatus: "open", row: { deploy_txid: TX_B } }), "recording", "our own released publish holds the name — not taken");
  assert.equal(ph(released, { commitStatus: "revealed", commitInfo: { status: "revealed", spent_txid: TX_B } }), "recording", "…and spent the carrier — not carrier-spent");
  assert.equal(ph(released, { commitStatus: "revealed", commitInfo: { status: "revealed", spent_txid: TX_C } }), "carrier-spent");
  assert.equal(revealVerdict({ deploy_txid: TX_B }, released), "registered");
  console.log("commitReveal: every version of a sped-up / unseen step is checked; the salt is kept until one confirms or the user abandons");
}

// ---- publish only through our own, valid reservation ---------------------------------------------
{
  const SALT = "00112233445566778899aabbccddeeff";
  const rec = normalizeDeployRecord({ ticker: "NEW", salt: SALT, carrierScript: SPK, createdAt: T0, commit: { txid: TXID, sentAt: T0, height: 969_700 } });
  const view = { txid: TXID, status: "open", hash: rec.hash, committer: ADDR };
  assert.equal(commitMismatch(view, rec, ADDR), null);
  assert.equal(commitMismatch(view, rec, ADDR, { addressScript: SPK }), null, "the connected address has the script H was made with");
  assert.equal(commitMismatch(view, rec, ADDR, { addressScript: SPK.toUpperCase() }), null);
  assert.match(commitMismatch(view, rec, ADDR, { addressScript: SPK_OTHER }), /made for another address than the connected one/);
  assert.equal(commitMismatch(view, rec, ADDR.toUpperCase()), null, "bech32 compares case-insensitively");
  assert.match(commitMismatch({ ...view, hash: "0".repeat(64) }, rec, ADDR), /different sealed code/);
  // Someone copied our H into a COMMIT of their own: its record names THEIR
  // carrier's address — never publish through it (it could never apply).
  assert.match(commitMismatch({ ...view, committer: "bc1qsomeoneelse" }, rec, ADDR), /belongs to bc1qsomeoneelse, not to the connected address/);
  assert.match(commitMismatch({ ...view, hash: null }, rec, ADDR), /does not show its sealed code/);
  assert.equal(sameAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "1bvbmseystwetqtfn5au4m4gfg7xjanvn2"), false, "base58 is case-sensitive");
  assert.equal(commitStatusText("invalid"), "not accepted by the indexer");
  assert.equal(commitStatusText("open"), "recorded by the indexer — ready to publish");
  assert.match(invalidReasonText("carrier_no_address"), /cannot hold a reservation/);
  assert.equal(invalidReasonText("some_new_code"), "The indexer did not accept step 1 as a reservation.");
  console.log("commitReveal: publish refuses a record whose hash / committer / carrier script is not the indexer's or the connected address's");
}

// ---- the reveal window and the page phases --------------------------------------------------------------
{
  const SALT = "00112233445566778899aabbccddeeff";
  assert.deepEqual(revealWindow(969_700), { revealFrom: 969_701, expiresAt: 971_716 });
  const t0 = revealTiming(969_700, 969_700);
  assert.equal(t0.ready, true, "the rules would take a publish sent right after the commit's block (it confirms at 969,701 or later)");
  assert.equal(t0.blocksLeft, 2_016);
  // …but Publish waits for step 1's 2nd confirmation: at the first, a chain
  // reorganization could put both steps into one block (commit_too_recent).
  assert.deepEqual([t0.confirmations, t0.settled, t0.publishable, t0.publishFrom], [1, false, false, 969_701]);
  const t1 = revealTiming(969_700, 969_701);
  assert.deepEqual([t1.confirmations, t1.settled, t1.publishable], [2, true, true]);
  assert.equal(PUBLISH_MIN_CONFIRMATIONS, 2);
  assert.equal(revealTiming(969_700, 971_715).blocksLeft, 1, "the next block is the last one");
  // The last PUBLISH_CUTOFF_BLOCKS blocks of the window: Publish is closed.
  assert.equal(PUBLISH_CUTOFF_BLOCKS, 6);
  assert.deepEqual([revealTiming(969_700, 971_710).closing, revealTiming(969_700, 971_710).publishable], [false, true], "6 blocks left: still open");
  assert.deepEqual([revealTiming(969_700, 971_711).closing, revealTiming(969_700, 971_711).publishable], [true, false], "5 left: closed");
  assert.equal(revealTiming(969_700, 971_715).closing, true);
  assert.equal(revealTiming(969_700, 971_716).expired, true);
  assert.equal(revealTiming(969_700, 971_716).closing, false, "expired is not closing");
  assert.equal(revealTiming(null, 969_700), null);
  assert.match(expiryText(revealTiming(969_700, 969_700)), /^Publish by block #971,710 — 2,011 blocks left \(about 14 days\); publishing closes 6 blocks before the reservation expires\.$/);
  assert.match(expiryText(revealTiming(969_700, 971_712)), /fewer than 6 blocks are left, so Publish is closed/);
  assert.match(expiryText(revealTiming(969_700, 971_716)), /expired at block #971,716/);

  const base = { ticker: "NEW", salt: SALT, carrierScript: SPK, hash: commitHashFor("NEW", SALT, SPK), createdAt: T0, carrierSats: 546, commit: null, reveal: null };
  const commit = { txid: TXID, sentAt: T0, height: null };
  const rec = (c, r = null) => normalizeDeployRecord({ ...base, commit: c, reveal: r });
  const ph = (r, extra = {}) => deployPhase({ rec: r, commitStatus: undefined, row: undefined, tip: 969_700, ...extra });
  assert.equal(ph(null), "idle");
  assert.equal(ph(rec(null)), "draft");
  assert.equal(ph(rec({ txid: TXID, sentAt: null })), "reserve-unsent");
  assert.equal(ph(rec(commit)), "reserve-pending");
  const conf = { ...commit, height: 969_700 };
  assert.equal(ph(rec(conf)), "recording", "confirmed, the indexer not asked yet");
  assert.equal(ph(rec(conf), { commitStatus: null }), "recording", "404: not recorded yet");
  assert.equal(ph(rec(conf), { commitStatus: "open", row: null }), "settling", "1 confirmation: Publish waits for the 2nd");
  assert.equal(ph(rec(conf), { commitStatus: "open", row: null, tip: 969_701 }), "ready");
  assert.equal(ph(rec(conf), { commitStatus: "open", tip: 969_701 }), "recording", "never ready before the registry row was read");
  const other = (h) => ({ deploy_txid: OTHER_TXID, deploy_block: h });
  assert.equal(ph(rec(conf), { commitStatus: "open", row: other(969_695) }), "taken", "another deploy took the name before the publish — final (6 deep)");
  assert.equal(ph(rec(conf), { commitStatus: "open", row: other(969_696) }), "taken-tentative", "…5 deep: a chain reorganization could still undo it");
  assert.equal(ph(rec(conf), { commitStatus: "open", row: { deploy_txid: OTHER_TXID } }), "taken-tentative", "…depth unknown: not final");
  assert.equal(ph(rec(commit), { row: other(969_690) }), "taken", "…even while step 1 is pending");
  assert.ok(!DEAD_END_PHASES.has("taken-tentative") && DEAD_END_PHASES.has("taken"), "a tentative verdict is not a dead end");
  assert.equal(ph(rec(conf), { commitStatus: "open", row: null, tip: 971_711 }), "closing", "fewer than 6 blocks left: Publish closed");
  assert.ok(DEAD_END_PHASES.has("closing"));
  assert.equal(ph(rec(conf), { commitStatus: "open", tip: 971_716 }), "expired");
  assert.equal(ph(rec(conf), { commitStatus: "invalid" }), "invalid");
  assert.equal(ph(rec(conf), { commitStatus: "revealed" }), "carrier-spent");
  // Step 1 confirmed below ACTIVATION_HEIGHT: ignored by the rules, never recorded — a dead end, not "recording".
  const early = { ...commit, height: ACTIVATION_HEIGHT - 1 };
  assert.equal(ph(rec(early), { commitStatus: null, row: null, tip: ACTIVATION_HEIGHT + 10 }), "before-activation");
  assert.ok(DEAD_END_PHASES.has("before-activation"));
  assert.equal(commitRecheckNeeded({ commit: early, commitData: null, indexed: ACTIVATION_HEIGHT + 10, misses: 2 }), false, "the indexer never records it: nothing to re-check");
  assert.equal(ph(rec({ ...commit, height: ACTIVATION_HEIGHT }), { commitStatus: null, row: null, tip: ACTIVATION_HEIGHT + 10 }), "recording", "confirmed in the activation block: waits for the indexer");
  const rv ={ txid: OTHER_TXID, sentAt: T0 + 5, height: null };
  assert.equal(ph(rec(conf, { txid: OTHER_TXID, sentAt: null })), "publish-unsent");
  assert.equal(ph(rec(conf, rv), { row: null }), "publish-pending");
  assert.equal(ph(rec(conf, rv), { row: { deploy_txid: TXID.replace(/a/g, "b") } }), "publish-pending-taken");
  const rvc = { ...rv, height: 969_702 };
  assert.equal(ph(rec(conf, rvc), { row: null, rowAsOf: 969_701 }), "publish-confirmed", "the row was read before the publish's block was applied");
  const ourSpend = { status: "revealed", spent_txid: OTHER_TXID, reveal_applied: null, reveal_reason: null };
  assert.equal(ph(rec(conf, rvc), { row: null, rowAsOf: 969_702, commitInfo: ourSpend }), "refused", "applied, our publish spent the reservation, still no row → it did not register");
  assert.equal(ph(rec(conf, rvc), { row: null, rowAsOf: 969_702 }), "publish-confirmed", "no row but no word on the spend: not a verdict (a chain reorganization can take the publish out)");
  assert.equal(ph(rec(conf, rvc), { row: null, rowAsOf: 969_702, commitInfo: { status: "open" } }), "publish-confirmed", "the reservation is open again: the publish left its block — keep checking");
  assert.equal(ph(rec(conf, rvc), { row: { deploy_txid: OTHER_TXID } }), "registered-provisional", "ours, depth unknown");
  assert.equal(ph(rec(conf, rvc), { row: { deploy_txid: OTHER_TXID, deploy_block: 969_702 }, tip: 969_706 }), "registered-provisional", "ours, 5 confirmations");
  assert.equal(ph(rec(conf, rvc), { row: { deploy_txid: OTHER_TXID, deploy_block: 969_702 }, tip: 969_707 }), "registered", "ours, 6 confirmations: final");
  assert.equal(ph(rec(conf, rvc), { row: { deploy_txid: OTHER_TXID, deploy_block: 969_702 }, tip: 969_720, indexed: 969_703 }), "registered-provisional", "depth counts on the indexer's applied height");
  assert.equal(ph(rec(conf, { ...rvc, txid: "9".repeat(64), replaces: [OTHER_TXID] }), { row: { deploy_txid: OTHER_TXID, deploy_block: 969_690 } }), "registered", "a replaced (sped-up) publish still counts as ours");
  assert.equal(ph(rec(conf, rvc), { row: { deploy_txid: "8".repeat(64) } }), "taken-after");
  assert.equal(revealVerdict(null, rec(conf, rvc)), "unindexed");
  // The indexer's own verdict on the spend of our carrier (CommitView.reveal_applied / reveal_reason).
  const spent = (reason) => ({ status: "revealed", spent_txid: OTHER_TXID, reveal_applied: false, reveal_reason: reason });
  assert.equal(ph(rec(conf, rvc), { row: null, commitInfo: spent("commit_expired") }), "refused");
  assert.equal(ph(rec(conf, rvc), { row: null, commitInfo: spent("ticker_taken") }), "taken-after");
  assert.equal(ph(rec(conf, rvc), { row: null, commitInfo: { ...spent("fee_missing"), spent_txid: "7".repeat(64) } }), "publish-confirmed", "someone else's spend is not our verdict");
  assert.match(revealReasonText("commit_expired"), /after the reservation expired/);
  assert.equal(revealReasonText("some_new_code"), "indexer reason: some_new_code");
  // /commits/:txid sanitizer
  const cv = _sanitizeCommit({ txid: TXID, height: 969_700, tx_index: 7, hash: "1ac55b4c608ed7c39eb3dbcecaf04c41222d5b3c37b6343477c9a91d4a6f33fc", carrier: `${TXID}:0`, committer: ADDR, status: "open", reveal_from_height: 969_701, expires_at_height: 971_716, invalid_reason: null, spent_txid: null, spent_height: null, reveal_applied: null, reveal_reason: null }, TXID);
  assert.equal(cv.status, "open");
  assert.equal(cv.tx_index, 7);
  assert.equal(cv.expires_at_height, 971_716);
  assert.equal(_sanitizeCommit({ txid: TXID, height: 969_700, status: "open" }, TXID).expires_at_height, 969_700 + 2_016, "window derived when omitted");
  assert.equal(_sanitizeCommit({ txid: TXID, height: 969_700, status: "weird" }, TXID), null, "unknown status is malformed");
  assert.equal(_sanitizeCommit({ txid: OTHER_TXID, height: 969_700, status: "open" }, TXID), null, "a row for another txid is malformed");
  const odd = _sanitizeCommit({ txid: TXID, height: 969_700, status: "revealed", reveal_applied: "no", reveal_reason: "<b>" }, TXID);
  assert.equal(odd.reveal_applied, null);
  assert.equal(odd.reveal_reason, null);
  console.log("commitReveal: reveal window, expiry countdown, every page phase");
}

// ---- chain reorganizations under a reservation, and created names until final ------------------------------------
{
  const SALT = "00112233445566778899aabbccddeeff";
  const TX_NEXT = "4".repeat(64);
  const commit = { txid: TXID, sentAt: T0, height: 969_700, replaces: [] };
  // step 1 left its block: the indexer no longer has it although it applied the next blocks — twice in a row
  assert.equal(commitRecheckNeeded({ commit, commitData: null, indexed: 969_703, misses: 2 }), true);
  assert.equal(commitRecheckNeeded({ commit, commitData: null, indexed: 969_703, misses: 1 }), false, "one 404 can race the indexer");
  assert.equal(commitRecheckNeeded({ commit, commitData: null, indexed: 969_699, misses: 5 }), false, "the indexer is still behind step 1's block");
  assert.equal(commitRecheckNeeded({ commit, commitData: { status: "open" }, indexed: 969_703, misses: 5 }), false, "recorded: nothing to re-check");
  assert.equal(commitRecheckNeeded({ commit: { ...commit, height: null }, commitData: null, indexed: 969_703, misses: 5 }), false, "not confirmed: tracked as pending anyway");
  // …and what the re-check does
  const back = commitAfterRecheck(commit, { kind: "seen", txid: TXID }, T0 + 1);
  assert.deepEqual([back.txid, back.height, back.unseenAt], [TXID, null, null], "back in the mempool: unconfirmed (tracking and Speed up resume)");
  const moved = commitAfterRecheck({ ...commit, replaces: [TX_NEXT] }, { kind: "confirmed", txid: TX_NEXT, height: 969_701 }, T0 + 1);
  assert.deepEqual([moved.txid, moved.height, moved.replaces], [TX_NEXT, 969_701, [TXID]], "another version confirmed (a Speed up) — switched to it and its height");
  const gone = commitAfterRecheck(commit, { kind: "none" }, T0 + 9);
  assert.deepEqual([gone.height, gone.unseenAt], [null, T0 + 9], "unknown to the node: unseen (the reserve-unseen flow)");
  assert.equal(commitAfterRecheck(commit, { kind: "unknown" }, T0), commit, "no answer: unchanged");
  // our publish left its block: the reservation is open again at a height the indexer has applied
  const reveal = { txid: OTHER_TXID, sentAt: T0, height: 969_702 };
  assert.equal(revealLeftBlock({ reveal, commitData: { status: "open" }, indexed: 969_702 }), true);
  assert.equal(revealLeftBlock({ reveal, commitData: { status: "open" }, indexed: 969_701 }), false, "the indexer has not applied the publish's block yet");
  assert.equal(revealLeftBlock({ reveal, commitData: { status: "revealed" }, indexed: 969_705 }), false);
  assert.equal(revealLeftBlock({ reveal: { ...reveal, height: null }, commitData: { status: "open" }, indexed: 969_705 }), false);
  // a sent publish that a block went by without: said, so it is sped up while the name is exposed
  const sent = { txid: OTHER_TXID, sentAt: T0, sentTip: 969_702, height: null, unseenAt: null };
  assert.equal(publishMissedBlock(sent, 969_702), false, "no block since it was sent");
  assert.equal(publishMissedBlock(sent, 969_703), true, "a block came without it");
  assert.equal(publishMissedBlock({ ...sent, height: 969_703 }, 969_704), false, "confirmed");
  assert.equal(publishMissedBlock({ ...sent, sentTip: null }, 969_704), false, "unknown send height");
  assert.equal(publishMissedBlock({ ...sent, unseenAt: T0 }, 969_704), false, "unseen is said otherwise");
  assert.equal(publishMissedBlock(sent, null), false);
  assert.equal(normalizeDeployRecord({ ticker: "NEW", salt: SALT, carrierScript: SPK, createdAt: T0, commit, reveal: sent }).reveal.sentTip, 969_702, "the record keeps the send height");

  // a created name is followed until final (settling notes, the whole record kept)
  const full = normalizeDeployRecord({ ticker: "NEW", salt: SALT, carrierScript: SPK, createdAt: T0, commit, reveal });
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  let now = T0;
  const st = createSettlingStore({ storage, now: () => now });
  assert.equal(settlingKey(" BC1QX "), "lp.deploy.settling.bc1qx");
  const [note] = st.add(ADDR, { rec: full, height: 969_702 });
  assert.deepEqual([note.ticker, note.revealTxid, note.height, note.verdict, note.rec.salt], ["NEW", OTHER_TXID, 969_702, "provisional", SALT], "the note keeps the salt");
  assert.equal(settlingVerdict(note, undefined, 969_704), "unknown");
  assert.equal(settlingVerdict(note, { deploy_txid: OTHER_TXID, deploy_block: 969_702 }, 969_704), "provisional");
  assert.equal(settlingVerdict(note, { deploy_txid: OTHER_TXID, deploy_block: 969_702 }, 969_707), "final");
  assert.equal(settlingVerdict(note, { deploy_txid: "8".repeat(64), deploy_block: 969_703 }, 969_704), "changed-taken", "a reorganization put another publish first");
  assert.equal(settlingVerdict(note, null, 969_704), "changed-missing", "our publish left its block");
  // no row is only a reorganization when the indexer that answered has applied the note's block and is not rebuilding
  assert.equal(settlingVerdict(note, null, 969_704, { applied: 969_701 }), "unknown", "the indexer has not applied the publish's block (a restart, a cold scan)");
  assert.equal(settlingVerdict(note, null, 969_704, { applied: 969_704, rebuilding: true }), "unknown", "a rebuild from the activation height");
  assert.equal(settlingVerdict(note, null, 969_704, { applied: null }), "unknown", "its height unknown");
  assert.equal(settlingVerdict(note, null, 969_704, { applied: 969_702 }), "changed-missing", "applied the block itself: the publish is out of it");
  assert.equal(settlingVerdict({ ...note, height: null }, null, 969_704), "unknown", "a note without a height never reads as missing");
  assert.equal(st.update(ADDR, OTHER_TXID, (n) => ({ ...n, verdict: "changed-missing" }))[0].verdict, "changed-missing");
  assert.equal(st.list(ADDR)[0].changes, 0, "a note starts with no change counted");
  assert.equal(st.update(ADDR, OTHER_TXID, (n) => ({ ...n, changes: 2 }))[0].changes, 2, "the note keeps its count of changes");
  assert.equal(st.list(ADDR).length, 1);
  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(st.list(ADDR).length, 0, "dropped after a day whatever it says");
  now = T0;
  st.add(ADDR, { rec: full, height: 969_702 });
  assert.equal(st.remove(ADDR, OTHER_TXID).length, 0);
  assert.equal(normalizeSettlingNote({ rec: { ...full, reveal: null }, revealTxid: OTHER_TXID }), null, "a note needs a published record");
  // lines
  const final = keep(createdFinalLine("NEW", 969_702, OTHER_TXID, T0));
  assert.match(final.text, /^NEW final {2}block 969,702 {2}6 confirmations {2}· {2}the name is yours$/);
  assert.match(keep(createdReorgLine("NEW", "changed-taken", OTHER_TXID, "8".repeat(64), T0)).text, /^chain reorganization {2}NEW is now registered to another publish \(tx 88888…888\)/);
  assert.match(keep(createdReorgLine("NEW", "changed-missing", OTHER_TXID, null, T0)).text, /your publish of NEW left its block/);
  assert.notEqual(createdReorgLine("NEW", "changed-missing", OTHER_TXID, null, T0).key, createdReorgLine("NEW", "provisional", OTHER_TXID, null, T0).key, "one line per change");
  // the same change twice (out, back, out again) is two lines: the note counts its changes
  const out1 = createdReorgLine("NEW", "changed-missing", OTHER_TXID, null, T0, { change: 1 });
  const out2 = createdReorgLine("NEW", "changed-missing", OTHER_TXID, null, T0 + 60_000, { change: 3 });
  assert.notEqual(out1.key, out2.key);
  assert.equal(appendLine(appendLine([], out1), out2).length, 2, "the second flip is not dropped as a repeat");
  assert.equal(createdReorgLine("NEW", "changed-missing", OTHER_TXID, null, T0 + 5_000, { change: 1 }).key, out1.key, "one change is still one line (a repeated check)");
  assert.match(keep(stepLeftBlockLine("COMMIT", TXID, 969_700, T0)).text, /^COMMIT .+ left block #969,700 \(chain reorganization\) {2}· {2}waiting for it to confirm again$/);
  const left1 = stepLeftBlockLine("COMMIT", TXID, 969_700, T0);
  const left2 = stepLeftBlockLine("COMMIT", TXID, 969_700, T0 + 30 * 60_000);
  assert.equal(appendLine(appendLine([], left1), left2).length, 2, "a step that leaves the same height twice is logged twice");
  assert.notEqual(reserveConfirmedLine(969_701, null, TXID, T0).key, reserveConfirmedLine(969_702, null, TXID, T0).key, "a COMMIT confirmed again at another height is logged again");
  assert.match(keep(deployedLine("NEW", 969_702, OTHER_TXID, T0, { provisional: true })).text, /✓ yours {2}· {2}provisional until 6 confirmations$/);
  console.log("commitReveal: a reorganized step 1 / publish is followed again; Publish waits for 2 confirmations and closes 6 blocks before expiry; a created name stays provisional until 6");
}

// ---- vocabulary gate on every produced line ------------------------------------------------------------
{
  assert.ok(outputs.length >= 15, `collected ${outputs.length} lines`);
  for (const l of outputs) {
    const all = [l.text, l.sum, l.pre, l.post].filter(Boolean).join(" ").replace(BRAND, "");
    const m = all.match(DENY);
    assert.equal(m, null, `denied word "${m && m[0]}" in: ${l.text}`);
  }
  // Keys are deterministic per event: the same inputs always yield the same key (variants of one event share it on purpose).
  assert.equal(deployedLine("NEW", 970_102, TXID, T0).key, deployedLine("NEW", 970_102, TXID, T0 + 999).key);
  assert.equal(deployMempoolLine("NEW", 970_102, TXID, T0).key, deployMempoolLine("NEW", 970_102, TXID, T0 + 999).key);
  console.log(`deploylog: ${outputs.length} formatter outputs free of denied vocabulary, keys deterministic`);
}
