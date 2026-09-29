// Pure-part tests for the user journeys (visit / wallet / create / mine /
// portfolio / market). Plain Node, no framework.
import assert from "node:assert/strict";
import { ACTIVATION_HEIGHT, PROTOCOL_LOCKTIME } from "../src/lib/payloads.js";
import { UNLOCK_HEIGHT, activationBannerText, activationNotice, activationState, blocksEtaText, blocksText, countdownText, lockedHint } from "../src/lib/activation.js";
import { cleanTickerInput, cleanedCaret } from "../src/lib/tickerInput.js";
import { fundingMessage, isFundingError } from "../src/lib/funding.js";
import { insufficientFundsError, noSpendableError, p2trAddressOfXOnly } from "../src/lib/psbt.js";
import { mineIdleReason, readyText } from "../src/lib/statusText.js";
import { syncRetryText, syncStateOf } from "../src/lib/sync.js";
import { createTxRecordStore, ownPendingSpendOf, parseTxRecords, replacedOwnSpendOf, trimRecords, TXREC_MAX } from "../src/lib/txrecords.js";
import { resumeMineState } from "../src/hooks/useMine.js";
import { afterConnectFailure } from "../src/hooks/useWallet.js";
import { deployResumedLine, deployUntrackedLine, resumeDeployState } from "../src/lib/deploylog.js";
import { creditOf, mineCaption, resumedLine, settledYoursLine, tipLine, yoursLine } from "../src/lib/minerlog.js";
import { fmtMintedPct, fmtSatsShort, walletBalanceText } from "../src/lib/format.js";
import { isValidBech32Address, pubkeyFromConnect } from "../src/lib/walletShapes.js";
import { isSearchableAddress, normalizeSearchAddress } from "../src/lib/activity.js";
import { indexerErrorText, isIndexerOffline } from "../src/lib/errors.js";
import { MAX_ERROR_TEXT, serverErrorText } from "../src/lib/httpError.js";
import { orderHttpError } from "../src/lib/indexer.js";
import { hashRouteForPath } from "../src/lib/canonicalHost.js";
import { BOOK_NOT_SAVED_TEXT, fmtCandleTime, fmtTimeTick, listingRefusalText, parseUnitInput, splitAmountError } from "../src/lib/market.js";
import { EXPECTED_YIELD, expectedYieldCapped } from "../src/lib/yield.js";
import { marketClosedNotice, mintedOutFlipNotice } from "../src/lib/tokenTabs.js";
import { MAX_UNIT_PRICE_SATS, buildListingPsbt, maxPriceSats } from "../src/lib/swap.js";
import { MOCK_WALLET } from "../src/lib/mock.js";
import { emptyBoardState, isMintedOut } from "../src/lib/marketBoard.js";

const TX = (c) => c.repeat(64);
const ADDR = MOCK_WALLET.address;

// ---- one activation wording, "1 block", the gate one block early -----
{
  assert.deepEqual(activationState(null), { locked: true, unknown: true, blocksLeft: null, active: false, blocksToActivation: null }, "unknown tip fails closed");
  // Create and Mine unlock at tip ACTIVATION_HEIGHT − 1 (969,599) —
  // every tx the app builds has nLockTime 969,599, so none can confirm before 969,600.
  assert.equal(UNLOCK_HEIGHT, ACTIVATION_HEIGHT - 1);
  assert.equal(UNLOCK_HEIGHT, PROTOCOL_LOCKTIME, "the gate opens exactly where the lock time allows the next block");
  assert.deepEqual(activationState(ACTIVATION_HEIGHT - 463), { locked: true, unknown: false, blocksLeft: 462, active: false, blocksToActivation: 463 });
  assert.equal(activationState(ACTIVATION_HEIGHT - 2).locked, true);
  assert.deepEqual(activationState(ACTIVATION_HEIGHT - 1), { locked: false, unknown: false, blocksLeft: 0, active: false, blocksToActivation: 1 }, "open at 969,599");
  assert.equal(activationState(ACTIVATION_HEIGHT).locked, false);
  assert.equal(activationState(ACTIVATION_HEIGHT).active, true);
  assert.equal(blocksText(1), "1 block");
  assert.equal(blocksText(462), "462 blocks");
  assert.equal(blocksEtaText(462), "about 3 days");
  assert.equal(blocksEtaText(1), "about 10 minutes");
  assert.equal(blocksEtaText(30), "about 5 hours");
  assert.equal(blocksEtaText(144), "about 24 hours");
  assert.equal(countdownText(1), "1 block from now (about 10 minutes)");
  assert.match(activationNotice(ACTIVATION_HEIGHT - 2, "Mining"), /Mining opens when block #969,599 is mined — 1 block from now \(about 10 minutes\)\./);
  assert.ok(!/1 blocks/.test(activationNotice(ACTIVATION_HEIGHT - 2, "Creating a ticker")));
  assert.match(activationNotice(ACTIVATION_HEIGHT - 2, "Creating a ticker"), /^LUCKY-20 starts at block #[\d,]+\. Creating a ticker opens when block #[\d,]+ is mined/);
  assert.match(activationNotice(ACTIVATION_HEIGHT - 2, "Mining"), /lock time, so none can be confirmed before block #969,600/);
  assert.match(activationNotice(null, "Creating a ticker"), /has not reported the chain tip yet/);
  assert.equal(activationNotice(ACTIVATION_HEIGHT - 1, "Mining"), null, "no lock notice at 969,599");
  assert.equal(activationNotice(ACTIVATION_HEIGHT, "Mining"), null);
  assert.match(activationBannerText(ACTIVATION_HEIGHT - 463), /^LUCKY-20 starts at block #969,600\. Create and Mine open at block #969,599, 462 blocks from now \(about 3 days\);/);
  assert.match(activationBannerText(ACTIVATION_HEIGHT - 1), /^LUCKY-20 starts with the next block, #969,600\. Create and Mine are open/, "at 969,599 the banner says the gate is open");
  assert.equal(activationBannerText(null), null, "no banner while the tip is unknown");
  assert.equal(activationBannerText(ACTIVATION_HEIGHT), null, "no banner once active");
  assert.equal(activationBannerText(ACTIVATION_HEIGHT + 5), null, "no banner after activation");
  assert.match(lockedHint(), /Locked until block #969,599/);
  console.log("activation: gate opens at 969,599, one countdown wording, singular '1 block', banner until 969,600");
}

// ---- the board's empty states -------------------------------------------------------
{
  const LUCKY = { ticker: "LUCKY", supply: 21_000_000, minted: 1_234_800, mine_count: 3, deploy_block: 969_601 };
  const BLOK = { ticker: "BLOK", supply: 21_000_000, minted: 21_000_000, minted_out: true, minted_out_height: 970_000, mine_count: 9, deploy_block: 969_602 };
  const items = [LUCKY, BLOK];
  const view = (sort, q) => {
    const needle = q.trim().toUpperCase();
    const matches = needle ? items.filter((t) => t.ticker.includes(needle)) : items;
    // Board.sortTokens: the Minted out view keeps minted-out tokens only.
    const shown = sort === "mintedout" ? matches.filter(isMintedOut) : matches;
    return emptyBoardState({ items, shown, sort, q });
  };
  assert.equal(view("mintedout", "lucky"), "not-minted", "LUCKY exists but is not minted out — never 'No ticker matches … Create LUCKY'");
  assert.equal(view("active", "lucky"), null);
  assert.equal(view("mintedout", "zzz"), "no-match");
  assert.equal(view("active", "zzz"), "no-match");
  assert.equal(view("mintedout", ""), null, "BLOK is minted out");
  assert.equal(emptyBoardState({ items: [LUCKY], shown: [], sort: "mintedout", q: "" }), "no-mintedout");
  assert.equal(emptyBoardState({ items: [], shown: [], sort: "active", q: "x" }), "none");
  console.log("board: a filter on the Minted out view that matches a minting token says so; 'no match' only when nothing matches");
}

// ---- clean first, cut after; the caret stays put ------------------------------------
{
  assert.deepEqual(cleanTickerInput("    LUCKY"), { ticker: "LUCKY", note: "Spaces and symbols were removed — a ticker uses only A–Z and 0–9." });
  assert.equal(cleanTickerInput("$LUCKYCAT").ticker, "LUCKYCAT", "cleaned before it is cut: not LUCKYCA");
  assert.equal(cleanTickerInput("LUCKY-20").ticker, "LUCKY20");
  assert.equal(cleanTickerInput("ABCDEFGHIJK").ticker, "ABCDEFGH");
  assert.equal(cleanTickerInput("ABCDEFGHIJK").note, "Cut to 8 characters: ABCDEFGH.");
  assert.match(cleanTickerInput("$ABCDEFGHIJ").note, /removed and the name was cut to 8 characters: ABCDEFGH/);
  assert.deepEqual(cleanTickerInput("moon"), { ticker: "MOON", note: null }, "upper-casing alone is not a change worth a note");
  assert.equal(cleanTickerInput("").note, null);
  // 'lucy', caret left of 'y', type 'k' → 'luck|y' → caret 4 in 'LUCKY'
  assert.equal(cleanedCaret("luckyy".slice(0, 5), 4), 4);
  assert.equal(cleanedCaret("lucky", 4), 4, "the caret stays after the typed k, not at the end");
  assert.equal(cleanedCaret("lu-cky", 3), 2, "a removed character before the caret moves it back one");
  assert.equal(cleanedCaret("ABC", null), 3);
  console.log("ticker input: cleaned then cut, said out loud; the caret keeps its place");
}

// ---- plain funding errors ---------------------------------------------------------------
{
  const none = noSpendableError(ADDR, 0);
  assert.equal(none.code, "no-spendable");
  assert.match(none.message, /no spendable BTC/, "the builder's own text is unchanged");
  assert.equal(isFundingError(none), true);
  assert.equal(isFundingError(new Error("Signature declined in the wallet.")), false);
  assert.equal(fundingMessage(new Error("boom"), null), null, "not a funding error → left to the caller");
  const waiting = fundingMessage(none, { assetSafe: true, waitingSats: 5000 }, { action: "this MINE" });
  assert.equal(waiting, "Your 5,000 sats have not confirmed yet — this MINE can only spend confirmed BTC. Try again after the next block confirms them; nothing was sent.");
  const okxNone = fundingMessage(noSpendableError(ADDR, 10_000), { assetSafe: false, waitingSats: 0 }, { action: "this MINE" });
  assert.match(okxNone, /outputs of 10,000 sats or less are not used \(this wallet has no asset-safe UTXO list\)\. Send more than 10,000 sats/);
  const okxWaiting = fundingMessage(noSpendableError(ADDR, 10_000), { assetSafe: false, waitingSats: 20_000 });
  assert.match(okxWaiting, /^Your 20,000 sats have not confirmed yet/, "an OKX user who just deposited is told to wait, not to send more");
  const poor = insufficientFundsError(13_446, 12_000, 1);
  assert.match(poor.message, /\(1 UTXO\)$/, "no '(1 UTXOs)'");
  assert.match(insufficientFundsError(10, 5, 2).message, /\(2 UTXOs\)$/);
  const msg = fundingMessage(poor, { assetSafe: false, waitingSats: 0 }, { action: "this DEPLOY" });
  assert.match(msg, /^Not enough confirmed BTC for this DEPLOY: it needs 13,446 sats \(outputs \+ network fee\) and 12,000 sats can be used\./);
  assert.match(msg, /Wait for pending transactions to confirm, pick a lower fee rate, or add BTC\.$/);
  assert.ok(!/insufficient funds|UTXOs/.test(msg));
  console.log("funding: 'wait for a confirmation' when the BTC is only unconfirmed; plain need/have with a next step");
}

// ---- the idle line says why the button is off ------------------------------------
{
  const base = { connected: true, indexerOk: true, preActivation: false, exhausted: false, lagText: null, ticker: "BLOK" };
  assert.equal(mineIdleReason(base), null);
  assert.equal(mineIdleReason({ ...base, exhausted: true }), "BLOK is fully minted — mining is closed; a MINE would credit 0.");
  assert.match(mineIdleReason({ ...base, preActivation: true }), /Locked until block #969,599/);
  assert.equal(mineIdleReason({ ...base, connected: false }), "Connect a wallet to mine.");
  assert.match(mineIdleReason({ ...base, indexerOk: false, preActivation: true }), /indexer is not answering/, "offline first (the unknown tip is why it reads locked)");
  assert.match(readyText(true, "Mine"), /^Ready\. Fee inputs are selected from spendable BTC only/);
  const okx = readyText(false, "Mine");
  assert.match(okx, /^Ready to mine\. This wallet has no asset-safe UTXO list/);
  assert.match(okx, /Ordinals or Runes on larger outputs cannot be detected — use an address that holds none\.$/);
  assert.ok(!/never spent/.test(okx), "no 'token-bearing outputs are never spent' promise without an asset-safe list");
  assert.match(readyText("inscriptions-only", "Create"), /^Ready to create\./);
  console.log("status: the reason MINE / Create is off; Ready warns a wallet without an asset-safe list");
}

// ---- the click-time lag error says nothing was sent ----------------------------------------------------
{
  const lag = syncStateOf({ indexed_height: 970_098, tip_height: 970_100 });
  assert.equal(syncRetryText(lag, "LAG1's availability"), "Nothing was sent: the indexer is 2 blocks behind the chain tip (#970,098 of #970,100), so LAG1's availability could be out of date. Press Create again once it has caught up.");
  assert.ok(!/paused until/.test(syncRetryText(lag, "x")));
  assert.match(syncRetryText(syncStateOf({ indexed_height: 5, tip_height: 5, stalled: true }), "x"), /stopped making progress/);
  assert.equal(syncRetryText(syncStateOf({ indexed_height: 5, tip_height: 5 }), "x"), null);
  console.log("sync: a click-time lag error says nothing was sent and to press again");
}

// ---- records that resume, trim and name own spends ------------------------------------
{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  let now = 5_000_000;
  const store = createTxRecordStore({ storage, now: () => now });
  store.add(ADDR, { txid: TX("a"), kind: "mine", ticker: "LUCKY", inputs: [`${TX("1")}:0`] });
  now += 1;
  store.markConfirmed(ADDR, TX("a"));
  const recs = store.list(ADDR);
  const resumed = resumeMineState(ADDR, "LUCKY", recs);
  assert.equal(resumed.phase, "pending", "a MINE that confirmed while away is resumed (its reveal was never shown)");
  assert.equal(resumed.txid, TX("a"));
  assert.equal(resumed.resumed, true);
  assert.equal(resumeMineState(ADDR, "SATS", recs).phase, "idle", "per ticker");

  // DEPLOY resume: the newest unsettled deploy record
  store.add(ADDR, { txid: TX("b"), kind: "deploy", ticker: "AWAY1", inputs: [] });
  now += 5;
  store.add(ADDR, { txid: TX("c"), kind: "deploy", ticker: "AWAY2", inputs: [] });
  const d = resumeDeployState(store.list(ADDR));
  assert.deepEqual([d.phase, d.ticker, d.txid, d.resumed], ["pending", "AWAY2", TX("c"), true]);
  assert.equal(resumeDeployState([]), null);
  assert.match(deployUntrackedLine(TX("c")).text, /tracking resumes when you return$/, "the promise the page keeps");
  const r = deployResumedLine("AWAY2", TX("c"), new Date(2026, 8, 27, 20, 20, 39).getTime());
  assert.equal(r.text, "resumed DEPLOY AWAY2  tx ccccc…ccc  ·  broadcast 20:20:39");
  assert.equal(r.key, `resumed:${TX("c")}`);

  // trim: confirmed records go first, so an unconfirmed one (it guards inputs) is never evicted by them
  const list = [];
  for (let i = 0; i < TXREC_MAX; i++) list.push({ txid: i.toString(16).padStart(64, "0"), kind: "mine", ticker: "X", inputs: [], at: i, confirmed: true });
  list.unshift({ txid: TX("e"), kind: "send", ticker: "X", inputs: [`${TX("9")}:1`], at: -1, confirmed: false });
  const trimmed = trimRecords(list);
  assert.equal(trimmed.length, TXREC_MAX);
  assert.ok(trimmed.some((x) => x.txid === TX("e")), "the oldest record survives because it is unconfirmed");
  assert.equal(parseTxRecords(JSON.stringify(list), 1_000).length, TXREC_MAX);

  // own pending spend of a listing: by the order's pending_spend_txid, else by the record's inputs
  const own = [{ txid: TX("f"), kind: "send", ticker: "BLOK", inputs: [`${TX("7")}:1`], at: 1, confirmed: false }];
  assert.equal(ownPendingSpendOf(own, `${TX("7")}:1`, null).txid, TX("f"), "matched by input before the indexer marks it filling");
  assert.equal(ownPendingSpendOf(own, `${TX("8")}:0`, TX("f")).txid, TX("f"), "matched by the order's pending_spend_txid");
  assert.equal(ownPendingSpendOf(own, `${TX("8")}:0`, TX("d")), null, "someone else's fill");
  // withdrawal replaced by a fill: the indexer names ANOTHER spend of an outpoint my record spends —
  // my withdrawal was replaced; it is not "your withdrawal is pending" any more
  assert.equal(ownPendingSpendOf(own, `${TX("7")}:1`, TX("d")), null, "the outpoint is in my record, but the named spend is someone else's");
  assert.equal(replacedOwnSpendOf(own, `${TX("7")}:1`, TX("d")).txid, TX("f"), "…my withdrawal was replaced");
  assert.equal(replacedOwnSpendOf(own, `${TX("7")}:1`, TX("f")), null, "the named spend is mine: not replaced");
  assert.equal(replacedOwnSpendOf(own, `${TX("7")}:1`, null), null, "nothing named yet");
  assert.equal(ownPendingSpendOf([{ ...own[0], confirmed: true }], `${TX("7")}:1`, null), null, "a confirmed one no longer pends by its inputs");
  assert.equal(ownPendingSpendOf([{ ...own[0], confirmed: true }], `${TX("7")}:1`, TX("f")).txid, TX("f"), "…but when the indexer names it in the mempool again (a chain reorganization), it is mine");
  assert.equal(ownPendingSpendOf([{ ...own[0], kind: "fill" }], `${TX("7")}:1`, null), null, "an own FILL (buying) is not a withdrawal");
  console.log("txrecords: confirmed MINEs resume, DEPLOYs resume, trim keeps unconfirmed records, own withdrawals are recognised");
}

// ---- the ✓ yours banner shows what the indexer credited -----------------------------------------
{
  const T0 = 1_000;
  const base = { txid: TX("a"), blockHeight: 970_102, yieldLocal: 1000 };
  assert.equal(settledYoursLine("LUCKY", { ...base, reconcile: "pending" }, T0), null, "no banner before the indexer answers");
  assert.equal(settledYoursLine("LUCKY", { ...base, reconcile: "timeout" }, T0), null, "no amount on a timeout");
  const full = settledYoursLine("LUCKY", { ...base, reconcile: "done", indexed: { status: "settled", yield_smallest: 1000, cap_exhausted: false } }, T0);
  assert.equal(full.sum, "+1,000 LUCKY");
  assert.equal(full.tier, 1000);
  assert.equal(full.text, "LUCKY mine settled  block 970,102  ✓ yours");
  const partial = settledYoursLine("LUCKY", { ...base, reconcile: "done", indexed: { status: "settled", yield_smallest: 100, cap_exhausted: false } }, T0);
  assert.equal(partial.sum, "+100 LUCKY", "the partial credit, never the +1,000 tier");
  assert.equal(partial.tier, null, "no tier colour on a short credit");
  assert.match(partial.text, /✓ yours {2}· {2}cap reached: tier 1,000, credited 100$/);
  const zero = settledYoursLine("LUCKY", { ...base, reconcile: "done", indexed: { status: "settled", yield_smallest: 0, cap_exhausted: true } }, T0);
  assert.equal(zero.sum, "+0 LUCKY");
  assert.match(zero.text, /supply exhausted, 0 credited$/);
  assert.equal(settledYoursLine("LUCKY", { ...base, reconcile: "done", indexed: { status: "invalid" } }, T0), null);
  assert.equal(creditOf(null, 1000), null);
  assert.equal(yoursLine("X", 1, 200, null, T0).tier, 200, "the old positional call still works");
  // caption: the tier while pending, the credit once known
  assert.equal(mineCaption("f", { reconcile: "pending" }, "LUCKY").text, "confirming digit f · tier 1,000 · 1 of 16");
  assert.equal(mineCaption("f", { reconcile: "done", indexed: { status: "settled", yield_smallest: 1000 } }, "LUCKY").text, "confirming digit f · 1,000 LUCKY · 1 of 16");
  assert.equal(mineCaption("f", { reconcile: "done", indexed: { status: "settled", yield_smallest: 100 } }, "LUCKY").text, "confirming digit f · tier 1,000 · 100 LUCKY credited (cap reached)");
  assert.equal(mineCaption("f", { reconcile: "done", indexed: { status: "settled", yield_smallest: 0, cap_exhausted: true } }, "LUCKY").text, "confirming digit f · tier 1,000 · 0 LUCKY credited (supply exhausted)");
  assert.equal(mineCaption(null, null, "LUCKY").text, "16 possible digits · the confirming block decides");
  const res = resumedLine(TX("b"), new Date(2026, 8, 27, 20, 20, 39).getTime(), T0);
  assert.equal(res.text, "resumed tracking  tx bbbbb…bbb  ·  broadcast 20:20:39", "one honest line after a reload — no 'accepted by node' at the reload time");
  assert.equal(resumedLine(TX("b"), null, T0).text, "resumed tracking  tx bbbbb…bbb");
  console.log("minerlog: ✓ yours carries the credited amount (partial / 0 near the cap); the caption follows; resumed line");
}

// ---- capped expectations, never '100%' early ----------------------------------------------
{
  assert.equal(expectedYieldCapped(null), EXPECTED_YIELD);
  assert.equal(expectedYieldCapped(5000), EXPECTED_YIELD);
  assert.equal(expectedYieldCapped(0), 0, "minted out: 0, not 262.5");
  assert.equal(expectedYieldCapped(100), 100, "every tier capped at 100");
  assert.equal(expectedYieldCapped(300), (1 * 300 + 3 * 300 + 5 * 200 + 7 * 100) / 16);
  assert.equal(fmtMintedPct(20_999_900, 21_000_000), "99.99%", "not 100.00% with 100 left");
  assert.equal(fmtMintedPct(20_999_999, 21_000_000, 1), "99.9%");
  assert.equal(fmtMintedPct(21_000_000, 21_000_000), "100%");
  assert.equal(fmtMintedPct(1_234_800, 21_000_000), "5.88%");
  assert.equal(fmtMintedPct(0, 21_000_000), "0.00%");
  assert.equal(fmtMintedPct(5, 0), "0.00%");
  assert.equal(tipLine({ height: 970_100 }, "LUCKY", { minted: 20_999_700, supply: 21_000_000 }, 1).text, "tip #970,100  ·  LUCKY minted 99.9%");
  assert.equal(marketClosedNotice("LUCKY", { ticker: "LUCKY", minted: 20_999_900, supply: 21_000_000 }), "Market opens when LUCKY is fully minted · 99.99% minted");
  assert.equal(marketClosedNotice("S", { ticker: "S", minted: 8_400_000, supply: 21_000_000 }), "Market opens when S is fully minted · 40% minted");
  console.log("supply: expected yield capped by what is left; the minted share never reads 100% early");
}

// ---- the tab stays put when a token flips to minted out ------------------------------------------------------
{
  const minting = { ticker: "LUCKY", minted: 20_999_900, supply: 21_000_000 };
  const out = { ...minting, minted: 21_000_000, minted_out: true, market_open: true };
  assert.equal(mintedOutFlipNotice({ tab: "mine", marketOpen: false }, out), "LUCKY is fully minted — its market is open.");
  assert.equal(mintedOutFlipNotice({ tab: "mine", marketOpen: false }, minting), null);
  assert.equal(mintedOutFlipNotice({ tab: "market", marketOpen: true }, out), null, "opened with the market open: nothing flipped");
  assert.equal(mintedOutFlipNotice({ tab: "mine", marketOpen: false }, { ...out, market_open: false }), null, "minted out, but its market not open yet: no notice");
  assert.equal(mintedOutFlipNotice(null, out), null);
  console.log("token tabs: a mid-visit flip is a notice, not a navigation");
}

// ---- a failed or declined switch keeps the live session ------------------------------------------------------
{
  const live = { status: "connected", address: ADDR, pubkeyHex: "02" + "ab".repeat(32), provider: "unisat", providerName: "UniSat", balance: 5000, balanceConfirmed: 5000, switching: "okx", error: null, providers: [] };
  const kept = afterConnectFailure(live, { attemptedId: "okx", message: "Connection declined in the wallet.", hasProvider: true });
  assert.equal(kept.status, "connected");
  assert.equal(kept.address, ADDR, "the address every in-flight flow is keyed on survives");
  assert.equal(kept.balance, 5000);
  assert.equal(kept.switching, null);
  assert.equal(kept.error, "Connection declined in the wallet. Still connected to UniSat.");
  const fresh = afterConnectFailure({ ...live, status: "connecting", switching: null }, { attemptedId: "unisat", message: "x", hasProvider: true });
  assert.equal(fresh.status, "disconnected", "a first connect that fails leaves nothing connected");
  assert.equal(fresh.address, null);
  const same = afterConnectFailure({ ...live, switching: null }, { attemptedId: "unisat", message: "x", hasProvider: false });
  assert.equal(same.status, "absent", "a reconnect of the same provider that fails is a disconnect");
  console.log("wallet: declining 'Switch to …' keeps the working session");
}

// ---- OKX's x-only Taproot key from connect() -----------------------------------------------------------------
{
  const xonly = MOCK_WALLET.pubkeyHex.slice(2);
  assert.equal(p2trAddressOfXOnly(xonly), ADDR, "fixture: the mock wallet's x-only key derives its bc1p address");
  assert.equal(pubkeyFromConnect({ address: ADDR, publicKey: xonly }, ADDR, p2trAddressOfXOnly), `02${xonly}`);
  assert.equal(pubkeyFromConnect({ address: ADDR, publicKey: MOCK_WALLET.pubkeyHex }, ADDR, p2trAddressOfXOnly), MOCK_WALLET.pubkeyHex, "a compressed key is used as is");
  assert.equal(pubkeyFromConnect({ address: ADDR, publicKey: xonly, compressedPublicKey: MOCK_WALLET.pubkeyHex }, ADDR, p2trAddressOfXOnly), MOCK_WALLET.pubkeyHex);
  assert.equal(pubkeyFromConnect({ address: ADDR, publicKey: "cd".repeat(32) }, ADDR, p2trAddressOfXOnly), null, "an x-only key that does not derive the address is refused");
  assert.equal(pubkeyFromConnect({ address: "bc1q" + "x".repeat(38), publicKey: xonly }, "bc1q" + "x".repeat(38), p2trAddressOfXOnly), null, "x-only only for bc1p");
  assert.equal(pubkeyFromConnect(null, ADDR, p2trAddressOfXOnly), null);
  assert.equal(p2trAddressOfXOnly("zz"), null);
  console.log("wallet: OKX's x-only Taproot key is accepted after checking it derives the account");
}

// ---- balance text -----------------------------------------------------------------------------------
{
  assert.equal(walletBalanceText(5000, 0), "0.0000 BTC (unconfirmed)".replace("0.0000", "0.00005"));
  assert.equal(walletBalanceText(1_317_684, 1_317_684), "0.01317684 BTC");
  assert.equal(walletBalanceText(1_317_684, 1_300_000), "0.01317684 BTC (0.00017684 unconfirmed)");
  assert.equal(walletBalanceText(1_317_684, 1_300_000, { short: true }), "0.01317684 BTC");
  assert.equal(walletBalanceText(null, null), "");
  assert.equal(walletBalanceText(5000, null), "0.00005 BTC");
  console.log("balance: the unconfirmed part is named");
}

// ---- the activity address filter ------------------------------------------------------------------------------
{
  const up = ADDR.toUpperCase();
  assert.equal(isSearchableAddress(up), true, "upper-case bech32 is valid");
  assert.equal(normalizeSearchAddress(` ${up} `), ADDR, "and lower-cased before it filters");
  const typo = ADDR.slice(0, -1) + (ADDR.endsWith("x") ? "y" : "x");
  assert.equal(isValidBech32Address(typo), false, "a checksum typo is not an address");
  assert.equal(isSearchableAddress(typo), false);
  assert.equal(isValidBech32Address("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), true, "BIP173 v0 vector");
  assert.equal(isValidBech32Address("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"), false, "testnet");
  assert.equal(isValidBech32Address("bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx"), false, "v1 must be 32 bytes");
  console.log("activity: upper-case addresses filter; checksum typos are refused");
}

// ---- plain indexer and order-book errors ----------------------------------------------------------------
{
  const off = new Error("Indexer unreachable: https://app.luckyprotocolai.com/tokens?limit=200 — Failed to fetch");
  assert.equal(isIndexerOffline(off), true);
  assert.equal(indexerErrorText(off, { retrySec: 15 }), "The indexer is offline. Retrying every 15 s.");
  assert.ok(!/https?:/.test(indexerErrorText(off)), "no raw URL on the page");
  assert.equal(indexerErrorText(Object.assign(new Error("Indexer /x -> HTTP 502: bad gateway"), { status: 502 })), "The indexer answered with an error (HTTP 502).");
  assert.equal(indexerErrorText(new Error("something specific")), "something specific");
  assert.equal(serverErrorText('{"error":"unit price 60.0000 sats/token is outside the price band"}'), "unit price 60.0000 sats/token is outside the price band");
  assert.equal(serverErrorText("bad-txns-inputs-missingorspent"), "bad-txns-inputs-missingorspent");
  assert.equal(serverErrorText(""), "");
  const long = `{"error":"${"word ".repeat(200).trim()}"}`;
  const cut = serverErrorText(long);
  assert.ok(cut.length <= MAX_ERROR_TEXT + 1 && cut.endsWith("…") && !cut.endsWith(" …"), "long refusals are cut at a word, with an ellipsis");
  const e = orderHttpError("/orders", 400, '{"error":"unit price 60.0000 sats/token is outside the price band: at most 100× the current best BLOK ask (0.4964 sats/token → ceiling 49.6364)"}');
  assert.equal(e.status, 400);
  assert.ok(!/HTTP|\{|"error"/.test(e.message), "no HTTP prefix, no JSON punctuation");
  assert.equal(listingRefusalText(e), "The order book refused this price: unit price 60.0000 sats/token is outside the price band: at most 100× the current best BLOK ask (0.4964 sats/token → ceiling 49.6364).");
  assert.match(listingRefusalText(orderHttpError("/orders", 409, '{"error":"outpoint has a pending spend in the mempool (abc)"}')), /already in the mempool/);
  assert.match(listingRefusalText(orderHttpError("/orders", 400, '{"error":"price_sats must be in [546, 100000000]"}')), /at most 1 BTC per whole token/);
  assert.equal(listingRefusalText(new Error("Signature declined in the wallet.")), null, "a wallet error keeps its own text");
  // The book could not save the listing: not confirmed, safe to post again, still fillable until withdrawn.
  const unsaved = listingRefusalText(orderHttpError("/orders", 503, '{"error":"the order book cannot be saved right now; retry shortly"}'));
  assert.equal(unsaved, BOOK_NOT_SAVED_TEXT);
  assert.match(unsaved, /may not be listed.*can be filled at your price.*posting the same listing again is safe/);
  assert.equal(listingRefusalText(orderHttpError("/orders", 503, "")), null, "a busy indexer (503 without that sentence) keeps its own text");
  console.log("errors: the indexer offline in one sentence; order-book refusals as the book's own words");
}

// ---- path-style links become hash routes ------------------------------------------------------------------------------
{
  assert.equal(hashRouteForPath({ pathname: "/t/LUCKY" }), "/#/t/LUCKY");
  assert.equal(hashRouteForPath({ pathname: "/t/LUCKY", search: "?tab=market" }), "/#/t/LUCKY?tab=market");
  assert.equal(hashRouteForPath({ pathname: "/market/" }), "/#/market");
  assert.equal(hashRouteForPath({ pathname: "/t/LUCKY", hash: "#/activity" }), "/#/activity", "an explicit hash route wins");
  assert.equal(hashRouteForPath({ pathname: "/" }), null);
  assert.equal(hashRouteForPath({ pathname: "/PROTOCOL.md" }), null, "files are left alone");
  assert.equal(hashRouteForPath({ pathname: "/index.html" }), null);
  console.log("routing: /t/LUCKY → /#/t/LUCKY");
}

// ---- the sell form and the chart -------------------------------------------------
{
  assert.equal(parseUnitInput("15"), 15);
  assert.equal(parseUnitInput("15,5"), 15.5, "decimal comma");
  assert.equal(parseUnitInput(".5"), 0.5);
  assert.equal(parseUnitInput("15x"), null);
  assert.equal(parseUnitInput(""), null);
  assert.equal(parseUnitInput("0"), null);
  assert.equal(parseUnitInput("-3"), null);
  assert.equal(splitAmountError("500", 1920, 1921, "BLOK"), null);
  assert.equal(splitAmountError("", 1920, 1921, "BLOK"), null);
  assert.equal(splitAmountError("2000", 1920, 1921, "BLOK"), "Enter a whole number from 1 to 1,920 (more than this carrier holds); this carrier holds 1,921 BLOK.");
  assert.match(splitAmountError("1921", 1920, 1921, "BLOK"), /the whole carrier/);
  assert.match(splitAmountError("0", 1920, 1921, "BLOK"), /\(zero\)/);
  for (const bad of ["1.5", "-1", "abc"]) assert.match(splitAmountError(bad, 1920, 1921, "BLOK"), /whole tokens only/);
  assert.equal(splitAmountError("1921", 1921, 1921, "BLOK"), null, "a multi-ticker / fat carrier may move its whole amount");
  assert.equal(maxPriceSats(1), MAX_UNIT_PRICE_SATS);
  assert.equal(maxPriceSats(1921), 1921 * 100_000_000);
  const utxo = { txid: TX("d"), vout: 0, sats: 546 };
  assert.throws(() => buildListingPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: utxo, priceSats: 200_000_000, amount: 1 }), /cap of 1 BTC per token/, "never signed: the book would refuse it");
  assert.ok(buildListingPsbt({ address: ADDR, pubkeyHex: MOCK_WALLET.pubkeyHex, tokenUtxo: utxo, priceSats: 100_000_000, amount: 1 }).psbtHex);
  const t = Date.UTC(2026, 8, 27, 11, 0) / 1000;
  assert.equal(fmtCandleTime(t, "1h"), "2026-09-27 11:00 UTC");
  assert.equal(fmtCandleTime(t, "1d"), "2026-09-27 UTC");
  assert.equal(fmtTimeTick(t, "1h"), "27 11:00", "same clock as the axis");
  console.log("market: unit box never disagrees with the total; split reasons; 1 BTC/token cap; UTC readout");
}

// ---- compact sats ----------------------------------------------------------------------------------------------------
{
  assert.equal(fmtSatsShort(16_324), "16,324 sats");
  assert.equal(fmtSatsShort(1_234_567), "1.23M sats");
  assert.equal(fmtSatsShort(null), "—");
  console.log("format: compact sats for the phone listings table");
}

console.log("journeys: all checks passed");
