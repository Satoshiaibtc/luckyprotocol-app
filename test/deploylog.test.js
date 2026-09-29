// DEPLOY // LOG line model: every deploy formatter's text against the
// grammar with fixed inputs, deterministic keys, the registry verdict lines
// and a denied-word sweep of every produced line. Plain Node, no framework.
import assert from "node:assert/strict";
import * as deploylog from "../src/lib/deploylog.js";
import {
  DEPLOY_BUSY,
  DEPLOY_PHASES,
  createdFinalLine,
  createdReorgLine,
  missedBlockLine,
  resumeDeployState,
  speedUpLine,
  stepDroppedLine,
  stepFoundLine,
  stepLeftBlockLine,
  stepUnseenLine,
  takenWhilePendingLine,
  acceptedLine,
  blockFoundLine,
  broadcastingLine,
  deployBuildLine,
  deployConfirmedLine,
  deployHeartbeatLine,
  deployMempoolLine,
  deployResumedLine,
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
import { ACTIVATION_HEIGHT, DEPLOY_PROTOCOL_FEE_SATS } from "../src/lib/payloads.js";
import { appendLine } from "../src/lib/minerlog.js";

// Same gate as test/vocab.test.js — no formatter may emit a denied word.
const DENY =
  /\b(bet|bets|betting|wager|wagers|win|wins|winner|winning|won|lose|loses|losing|loss|lost|jackpot|casino|slots?|dice|roulette|wheel|lottery|raffle|draws?|confetti|odds|payout|spin|spins|roll|rolls|prize|prizes|reward|rewards|chance|chances|gamble|gambling|lucky|luck)\b/i;
const BRAND = /LUCKY\/\/PROTOCOL|LuckyProtocol|LUCKY-20|lucky-20|\bLUCKY\b/g;

const HASH = "000000000000000000009e4d7b21f0a83c5ed19b4407a6e258fd0c93b71a4c3f";
const TXID = "a3f9c2d1e0b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a621e";
const OTHER_TXID = "1111c2d1e0b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6222";
const ADDR = "bc1pqx7v9c2k4m8n3r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0z1x2c3v4b5n62s";
const T0 = new Date(2026, 8, 27, 9, 30, 15).getTime();
const H = ACTIVATION_HEIGHT + 102;
const fmt = (n) => n.toLocaleString("en-US");

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
  assert.deepEqual(DEPLOY_PHASES, ["Sign", "Broadcast", "Confirm", "Registered"], "one transaction: sign, broadcast, its block, the registry's verdict");
  assert.ok(DEPLOY_BUSY.has("building") && DEPLOY_BUSY.has("signing") && DEPLOY_BUSY.has("broadcasting"));
  assert.ok(!DEPLOY_BUSY.has("pending") && !DEPLOY_BUSY.has("confirmed") && !DEPLOY_BUSY.has("error"), "a sent DEPLOY does not hold the page");
  assert.equal(DEPLOY_PROTOCOL_FEE_SATS, 5_460, "the build line prints the protocol fee constant");
  for (const gone of ["PLAIN_PHASES", "PLAIN_BUSY", "AVATAR_PHASES", "AVATAR_BUSY", "avatarLeds", "avatarLine", "reclaimLine"]) {
    assert.equal(deploylog[gone], undefined, `${gone} is not part of the grammar`);
  }
  console.log("deploylog: phase labels / busy set");
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

// ---- Speed up, missed block, unseen, found, dropped, taken while pending ---------------------------
{
  const su = keep(speedUpLine("DEPLOY", { oldFeeSats: 738, feeSats: 1_476, feeRateSatVb: 6, txid: OTHER_TXID }, T0));
  assert.equal(su.text, "speed up DEPLOY  fee 738 → 1,476 sats @ 6 sat/vB  new tx 1111c…222");
  assert.equal(su.kind, "act");
  const mb = keep(missedBlockLine("NEW", TXID, H, T0));
  assert.equal(mb.text, `DEPLOY a3f9c…21e missed block #${fmt(H)}  ·  NEW is visible in the mempool — speed it up`);
  assert.equal(mb.kind, "err");
  assert.notEqual(missedBlockLine("NEW", TXID, H + 1, T0).key, mb.key, "one line per missed block");
  assert.equal(missedBlockLine("NEW", TXID, H, T0 + 60_000).key, mb.key, "…and one only");
  assert.equal(missedBlockLine("NEW", TXID, null, T0).text, "DEPLOY a3f9c…21e missed a block  ·  NEW is visible in the mempool — speed it up");
  const dr = keep(stepDroppedLine("DEPLOY", TXID, T0));
  assert.equal(dr.text, "DEPLOY a3f9c…21e left the mempool without confirming");
  const un = keep(stepUnseenLine("DEPLOY", TXID, T0));
  assert.equal(un.text, "DEPLOY a3f9c…21e not seen by the indexer's node for a few minutes · still checking (it may confirm)");
  assert.equal(keep(stepFoundLine("DEPLOY", TXID, H, T0)).text, `DEPLOY a3f9c…21e found  confirmed in block #${fmt(H)}`);
  assert.equal(keep(stepFoundLine("DEPLOY", TXID, null, T0)).text, "DEPLOY a3f9c…21e found  in the mempool");
  const tw = keep(takenWhilePendingLine("NEW", "k", T0));
  assert.equal(tw.kind, "err");
  assert.equal(tw.text, "indexer: NEW was registered by another DEPLOY while yours was waiting");
  const rs = keep(deployResumedLine("NEW", TXID, T0, { at: T0 }));
  assert.match(rs.text, /^resumed DEPLOY NEW {2}tx a3f9c…21e {2}· {2}broadcast \d\d:\d\d:\d\d$/);
  console.log("deploylog: speed up / missed block / unseen / found / dropped / taken while pending / resumed");
}

// ---- a result follows its block until final; a chain reorganization is said ----------------------
{
  const final = keep(createdFinalLine("NEW", H, OTHER_TXID, T0));
  assert.equal(final.text, `NEW final  block ${fmt(H)}  6 confirmations  ·  the name is yours`);
  assert.match(keep(createdReorgLine("NEW", "changed-taken", OTHER_TXID, "8".repeat(64), T0)).text, /^chain reorganization {2}NEW is now registered to another DEPLOY \(tx 88888…888\)/);
  assert.match(keep(createdReorgLine("NEW", "changed-missing", OTHER_TXID, null, T0)).text, /your DEPLOY of NEW left its block/);
  assert.match(keep(createdReorgLine("NEW", "provisional", OTHER_TXID, null, T0)).text, /^NEW is registered to your DEPLOY again/);
  assert.notEqual(createdReorgLine("NEW", "changed-missing", OTHER_TXID, null, T0).key, createdReorgLine("NEW", "provisional", OTHER_TXID, null, T0).key, "one line per change");
  // the same change twice (out, back, out again) is two lines: the note counts its changes
  const out1 = createdReorgLine("NEW", "changed-missing", OTHER_TXID, null, T0, { change: 1 });
  const out2 = createdReorgLine("NEW", "changed-missing", OTHER_TXID, null, T0 + 60_000, { change: 3 });
  assert.notEqual(out1.key, out2.key);
  assert.equal(appendLine(appendLine([], out1), out2).length, 2, "the second flip is not dropped as a repeat");
  assert.equal(createdReorgLine("NEW", "changed-missing", OTHER_TXID, null, T0 + 5_000, { change: 1 }).key, out1.key, "one change is still one line (a repeated check)");
  const left = keep(stepLeftBlockLine("DEPLOY", TXID, H, T0));
  assert.equal(left.text, `DEPLOY a3f9c…21e left block #${fmt(H)} (chain reorganization)  ·  waiting for it to confirm again`);
  const left2 = stepLeftBlockLine("DEPLOY", TXID, H, T0 + 30 * 60_000);
  assert.equal(appendLine(appendLine([], left), left2).length, 2, "a DEPLOY that leaves the same height twice is logged twice");
  assert.match(keep(deployedLine("NEW", H, OTHER_TXID, T0, { provisional: true })).text, /✓ yours {2}· {2}provisional until 6 confirmations$/);
  console.log("deploylog: final / reorganization / left-block lines, one per change");
}

// ---- the state the Create page resumes ------------------------------------------------------------------
{
  const rec = { txid: TXID, kind: "deploy", ticker: "NEW", inputs: [], at: T0, psbt: "70736274ff", changeVout: 3, replaces: ["2".repeat(64), OTHER_TXID] };
  const r = resumeDeployState([rec]);
  assert.deepEqual([r.phase, r.ticker, r.txid, r.resumed, r.broadcastAt], ["pending", "NEW", TXID, true, T0]);
  assert.deepEqual(r.versions, [TXID, OTHER_TXID, "2".repeat(64)], "the txid, then the versions it replaced, newest first");
  assert.equal(r.psbt, "70736274ff", "a record with its PSBT resumes with Speed up");
  assert.equal(r.changeVout, 3);
  const bare = resumeDeployState([{ txid: TXID, kind: "deploy", ticker: "NEW", inputs: [], at: T0 }]);
  assert.deepEqual([bare.psbt, bare.changeVout, bare.versions], [null, null, [TXID]], "a record without its PSBT resumes without Speed up");
  assert.equal(resumeDeployState([{ ...rec, kind: "mine" }]), null, "only DEPLOY records");
  assert.equal(resumeDeployState([{ ...rec, ticker: null }]), null, "a DEPLOY record needs its ticker");
  assert.equal(resumeDeployState(null), null);
  console.log("deploylog: resumeDeployState carries the versions and what a Speed up needs");
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
