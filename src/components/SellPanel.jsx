import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { usePoll } from "../hooks/usePoll.js";
import { useSendToSelf } from "../hooks/useSendToSelf.js";
import { friendlyError } from "../hooks/useWallet.js";
import { buildListingPsbt, LISTING_SIGHASH, MIN_PRICE_SATS, maxPriceSats } from "../lib/swap.js";
import { decodeAddress, estimateSendFeeSats } from "../lib/psbt.js";
import {
  BOOK_UNSAVED_PAUSE_TEXT,
  RAISE_PRICE_TEXT,
  WITHDRAW_CONFIRMED_TEXT,
  WITHDRAW_FEE_NOTE,
  WITHDRAW_PENDING_TEXT,
  cancelFeeRate,
  listingRefusalText,
  lowPriceCheck,
  parseTotalInput,
  parseUnitInput,
  splitAmountError,
  unitInputProblem,
} from "../lib/market.js";
import {
  OFF_BOOK_LISTING_TEXT,
  OWN_PENDING_SPEND_TEXT,
  UNKNOWN_VALUE_TEXT,
  commitCarrierProblem,
  isOffBook,
  listingCapDecision,
  listingCapText,
  listingQuota,
  listingQuotaText,
  listingShapeProblems,
  offBookText,
  readSellerOrders,
  relistDecision,
  sellRowState,
  smallCarrierText,
  splitBlockedReason,
} from "../lib/listingRules.js";
import { ORIGIN_REFUSED_TEXT, checkSecondSource, originCheckState, originRefused } from "../lib/secondSource.js";
import { mockCheckSecondSource } from "../lib/mock.js";
import { ownPendingSpendOf, pendingSpentOutpoints, txRecords } from "../lib/txrecords.js";
import { DUST_SATS, SEND_PROTOCOL_FEE_SATS } from "../lib/payloads.js";
import { fmtBtcShort, fmtInt, fmtSats, fmtUnit, fmtUsd, shortTxid, subUnitDecimals } from "../lib/format.js";
import { isMarketOpen } from "../lib/marketBoard.js";
import { syncPauseText } from "../lib/sync.js";
import { marketClosedNotice } from "../lib/tokenTabs.js";
import TxProgress, { ConnectPrompt } from "./TxProgress.jsx";
import SpeedUpSend from "./SpeedUpSend.jsx";
import { OrdersTable } from "./Tables.jsx";
import Led from "./hud/Led.jsx";
import { indexerErrorText, indexerErrorTitle } from "../lib/errors.js";

const POLL_MS = 15_000;
const IDLE = { phase: "idle" };
const outKey = (u) => `${u.txid}:${u.vout}`;

const RELIST_WARNING =
  "A signed listing is a bearer instrument: anyone who saved the earlier PSBT can still fill it at the old price. Re-listing replaces the order in the book but does NOT void that signature — only moving the tokens on-chain does.";

/**
 * List / Split / Withdraw for the connected address (mounted under a fold
 * on the Market tab): pick a carrier, list its whole balance at a unit or
 * total price (prefilled from the floor / last trade), split part of it
 * off first when needed, and manage the listings — Renew (re-POST the same
 * PSBT before the 14-day expiry) and Withdraw (the spec's "cancel": a SEND
 * to yourself; the replacement-fee rule applies while a fill is pending).
 * One word for one action on every surface: the button, the fold, the
 * notices and the progress labels all say "withdraw".
 *
 * `active` false (the fold is closed): its reads pause and resume when it
 * opens again; a split or withdrawal already sent is still followed.
 */
export default function SellPanel({ ticker, token, onSettled, usd = null, active = true }) {
  const { wallet: w, address, pubkeyHex, fees, fee, indexerOk, sync, health, mock } = useApp();
  const connected = w.status === "connected";
  const pollOpts = { paused: !active };

  const tokenUtxos = usePoll(address ? (s) => indexer.tokenUtxos(address, s) : null, POLL_MS, [address], pollOpts);
  const btcUtxos = usePoll(address ? (s) => indexer.btcUtxos(address, s) : null, POLL_MS, [address], pollOpts);
  // The seller's listings: the per-address history is PAGED by the indexer
  // (newest first, 200 a page, every status and ticker) and read page by
  // page; the ticker's live book (open + filling, ≤ 200 each, the same reads
  // the Asks panel makes) is merged in by seller as well, so a live listing
  // is never shown as "listable". `rows` = this ticker's listings; `all` =
  // every ticker's, for the per-address listing cap (§7.4), which counts
  // the address's open listings of all tokens together.
  const myOrders = usePoll(
    address
      ? async (s) => {
          const [mine, open, filling] = await Promise.all([
            readSellerOrders((offset, limit) => indexer.ordersByAddress(address, { limit, offset }, s), { pageSize: indexer.ADDR_LIST_MAX_LIMIT }),
            indexer.orders({ ticker, status: "open", limit: indexer.ADDR_LIST_MAX_LIMIT }, s),
            indexer.orders({ ticker, status: "filling", limit: indexer.ADDR_LIST_MAX_LIMIT }, s),
          ]);
          const book = [...open.items, ...filling.items].filter((o) => o.seller === address);
          const byId = new Map(mine.items.filter((o) => o.ticker === ticker).map((o) => [o.id, o]));
          for (const o of book) byId.set(o.id, o);
          // Listings of this ticker that left the book but can still be filled
          // (never where a live row of the same outpoint stands).
          for (const o of mine.expired || []) if (o.ticker === ticker && !byId.has(o.id)) byId.set(o.id, o);
          return { rows: [...byId.values()], all: [...mine.items, ...book], complete: mine.complete };
        }
      : null,
    POLL_MS,
    [address, ticker],
    pollOpts,
  );
  const myRows = myOrders.data?.rows;
  // "N of 10 listings used": open listings of this address, all tickers (null until read).
  const quota = useMemo(() => (myOrders.data && address ? listingQuota(myOrders.data.all, address, { complete: myOrders.data.complete }) : null), [myOrders.data, address]);

  const refreshMine = useCallback(() => {
    tokenUtxos.refresh();
    btcUtxos.refresh();
    myOrders.refresh();
  }, [tokenUtxos, btcUtxos, myOrders]);

  const settled = useCallback(() => {
    refreshMine();
    onSettled?.();
  }, [refreshMine, onSettled]);

  // ---- on-chain flows: split / withdraw (the spec's "cancel", §7.3) ------------------------
  const sendFlow = useSendToSelf({ onSettled: settled });
  const { chain, status, run, reset, stopWaiting, busy: chainBusy } = sendFlow;

  // This browser's own pending transactions: a `filling` listing whose
  // pending spend is one of them is the user's own withdrawal — no "a fill
  // sits in the mempool … you are paid" note, no second Withdraw — and a
  // carrier one of them spends is "pending" here (its new carrier shows once
  // that confirms), never "listable".
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read the store on each listings refresh / flow step
  const records = useMemo(() => (address ? txRecords(address) : []), [address, myRows, tokenUtxos.data, chain.phase]);
  const pendingSpent = useMemo(() => pendingSpentOutpoints(records), [records]);

  // Rows: this ticker's UTXOs joined with their BTC value + listing status.
  // `offBook` = an earlier listing of it that left the book but can still be
  // filled (the by-address row with status "expired").
  const rows = useMemo(() => {
    const sats = new Map((btcUtxos.data || []).map((u) => [outKey(u), u.sats]));
    const live = new Map((myRows || []).filter((o) => o.status === "open" || o.status === "filling").map((o) => [o.id, o]));
    const off = new Map((myRows || []).filter(isOffBook).map((o) => [o.id, o]));
    return (tokenUtxos.data || [])
      .filter((u) => u.balances[ticker] > 0)
      .map((u) => {
        const k = outKey(u);
        const tickers = Object.keys(u.balances);
        const listing = live.get(k) || null;
        return { key: k, txid: u.txid, vout: u.vout, amount: u.balances[ticker], balances: u.balances, multi: tickers.length > 1, sats: sats.get(k) ?? null, listing, offBook: listing ? null : off.get(k) || null, pending: pendingSpent.has(k.toLowerCase()) };
      })
      // 546-sat carriers first (the ones meant to be listed); fatter SEND
      // change outputs sink to the bottom — listing one hands its BTC surplus
      // to the buyer, so they are tagged "split first".
      .sort((a, b) => (a.sats === DUST_SATS ? 0 : 1) - (b.sats === DUST_SATS ? 0 : 1) || b.amount - a.amount);
  }, [tokenUtxos.data, btcUtxos.data, myRows, ticker, pendingSpent]);

  const ordersHere = useMemo(
    () => [...(myRows || [])].sort((a, b) => (a.status === "open" || a.status === "filling" ? -1 : 1) - (b.status === "open" || b.status === "filling" ? -1 : 1) || (b.updated_at ?? 0) - (a.updated_at ?? 0)),
    [myRows],
  );
  const ordersQ = { rows: ordersHere, total: ordersHere.length, loading: myOrders.loading, error: myOrders.error, hasMore: false, loadMore: () => {} };

  const [selKey, setSelKey] = useState(null);
  const sel = rows.find((r) => r.key === selKey) || null;
  useEffect(() => {
    if (selKey && !rows.some((r) => r.key === selKey)) setSelKey(null);
  }, [rows, selKey]);
  useEffect(() => {
    setSelKey(null);
  }, [address, ticker]);

  // ---- listing flow (off-chain: sign + POST) ------------------------------------------------
  const [listFlow, setListFlow] = useState(IDLE);
  const [unitStr, setUnitStr] = useState("");
  const [totalStr, setTotalStr] = useState("");
  // Seed the price form ONLY when the selection changes — `sel` / `token`
  // are re-derived on every poll and must not wipe what the user typed.
  const seedRef = useRef({ sel: null, token: null });
  seedRef.current = { sel, token };
  useEffect(() => {
    setListFlow(IDLE);
    const { sel: s, token: t } = seedRef.current;
    if (!s) return;
    const ref = t?.floor_unit_price ?? t?.last_trade?.unit_price ?? null;
    const floorSats = Math.max(MIN_PRICE_SATS, Number.isInteger(s.sats) ? s.sats : 0); // never below the carrier's own value
    if (ref) {
      const total = Math.max(floorSats, Math.round(ref * s.amount));
      setTotalStr(String(total));
      setUnitStr(fmtUnitInput(total / s.amount));
    } else if (floorSats > MIN_PRICE_SATS) {
      setTotalStr(String(floorSats));
      setUnitStr(fmtUnitInput(floorSats / s.amount));
    } else {
      setUnitStr("");
      setTotalStr("");
    }
  }, [selKey]);

  // The two boxes never disagree: a unit price that does
  // not parse ("", "15x", "1,000") clears the total, so Sign cannot go out at a total
  // the unit box no longer shows; "15,5" reads as 15.5, and "1,000" is
  // refused with a plain reason — never read as 1.
  // A new price starts a new listing attempt: the last "Listed" / refusal line goes.
  const clearDone = () => setListFlow((f) => (f.phase === "listed" || f.phase === "error" ? IDLE : f));
  const onUnit = (v) => {
    clearDone();
    setUnitStr(v);
    const n = parseUnitInput(v);
    if (!sel) return;
    setTotalStr(n === null ? "" : String(Math.round(n * sel.amount)));
  };
  const onTotal = (v) => {
    clearDone();
    setTotalStr(v);
    const n = parseTotalInput(v);
    if (!sel) return;
    setUnitStr(Number.isFinite(n) && n > 0 ? fmtUnitInput(n / sel.amount) : "");
  };
  const priceSats = parseTotalInput(totalStr);
  const minPriceSats = Math.max(MIN_PRICE_SATS, sel && Number.isInteger(sel.sats) ? sel.sats : 0);
  // §7.4: at most 1 BTC per whole token — refused by the book above that.
  const maxPrice = sel ? maxPriceSats(sel.amount) : null;
  const priceOk = Number.isInteger(priceSats) && priceSats >= minPriceSats && (maxPrice === null || priceSats <= maxPrice);
  // A carrier whose spend already sits in the mempool: the book refuses a
  // new listing for it (409) until that spend confirms or drops.
  const selFilling = !!sel && sel.listing?.status === "filling";
  // One of this browser's own transactions already spends it: nothing new may spend or list it.
  const selPending = !!sel && sel.pending;
  const selOffBook = sel && !sel.listing ? sel.offBook : null;
  const fatCarrier = !!sel && Number.isInteger(sel.sats) && sel.sats > DUST_SATS;
  // Below 546 sats: the order book refuses the listing, so the tokens move to a 546-sat carrier first.
  const smallCarrier = !!sel && Number.isInteger(sel.sats) && sel.sats < DUST_SATS;
  const listBusy = listFlow.phase === "checking" || listFlow.phase === "signing" || listFlow.phase === "posting";
  // The market gate: a listing is accepted only once the token's market is
  // open — minted out AND the block that completed the supply FINAL_DEPTH
  // deep (the indexer answers 409 otherwise — this is the same rule, said first).
  const marketOpen = isMarketOpen(token);
  // A new listing pauses while the indexer's view may be stale (lagging,
  // stalled, rebuilding, or its node behind the network), and while the
  // order book reports that it cannot save listings — Withdraw never does.
  const listPause = indexerOk ? syncPauseText(sync, "listing") ?? (health?.data?.persist_ok === false ? BOOK_UNSAVED_PAUSE_TEXT : null) : null;
  const marketClosed = marketClosedNotice(ticker, token);
  // §7.4 price band: the indexer refuses an ask above 100× the ticker's best
  // OTHER open ask. Said here, before the wallet is opened, rather than only
  // as the server's 400 afterwards. The floor is the closest public
  // reference (it may be the seller's own ask, in which case the server's
  // ceiling is higher), so this is a warning, not a gate; a re-list of the
  // book's only open ask has no band at all.
  const bandRef = (token?.floor_unit_price ?? null) > 0 ? token.floor_unit_price : null;
  const aboveBand = !!sel && priceOk && bandRef !== null && !(sel.listing && sel.listing.status === "open" && token?.open_orders === 1) && priceSats / sel.amount > 100 * bandRef;
  // §7.4: the book keeps the cheapest live signed listing of an
  // outpoint — a HIGHER price needs Withdraw first; the same or a lower
  // price replaces the listing. A listing that left the book guards its
  // price the same way: its signature can still be filled.
  const relist = !!sel && !sel.multi && priceOk ? relistDecision(sel.listing ?? selOffBook, priceSats, sel.amount) : null;
  const raiseBlocked = !!relist && !relist.ok && relist.kind === "raise";
  // The listing a "Withdraw first" spends: the live one, or the one that left the book.
  const guarding = sel ? sel.listing ?? selOffBook : null;
  // A unit price below a tenth of the floor (or the last trade) is signed only after one explicit tick.
  const low = !!sel && priceOk ? lowPriceCheck(priceSats / sel.amount, token) : null;
  const lowKey = low && sel ? `${sel.key}:${priceSats}` : null;
  const [lowAck, setLowAck] = useState(null);
  const lowBlocked = !!low && lowAck !== lowKey;
  const unitProblem = unitInputProblem(unitStr);

  // §7.4: the first output of a step-1 reservation (COMMIT) that can
  // still be published is never listed — checked through /commits/:txid
  // when the row is picked, and again right before the wallet signs.
  const selTxid = sel?.txid ?? null;
  const selVout = sel?.vout ?? null;
  const [carrierCheck, setCarrierCheck] = useState({ key: null, problem: null, error: null });
  useEffect(() => {
    if (!selKey || selVout !== 0 || !selTxid) {
      setCarrierCheck({ key: selKey, problem: null, error: null });
      return undefined;
    }
    let alive = true;
    setCarrierCheck({ key: selKey, problem: undefined, error: null });
    indexer.commit(selTxid).then(
      (c) => alive && setCarrierCheck({ key: selKey, problem: commitCarrierProblem(0, c, sync?.indexed ?? null), error: null }),
      (e) => alive && setCarrierCheck({ key: selKey, problem: null, error: friendlyError(e) }),
    );
    return () => {
      alive = false;
    };
    // the indexed height moves every block; the check follows the selection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, selTxid, selVout]);
  const reservedCarrier = !!sel && carrierCheck.key === sel.key && !!carrierCheck.problem;

  // §7.2 step 3 on the seller's side: a buyer re-checks where the listed
  // UTXO's tokens came from (the creating tx's OP_RETURN) and refuses a
  // carrier that no MINE or SEND credited directly — so such a UTXO is
  // never offered as listable: the same check runs on it here, and it is
  // moved to a fresh carrier first. An unreachable second source says
  // nothing; the listing goes ahead.
  const selSats = sel?.sats ?? null;
  const selAmount = sel?.amount ?? null;
  const selMulti = !!sel?.multi;
  const capHeight = Number.isInteger(token?.minted_out_height) ? token.minted_out_height : null;
  const [originCheck, setOriginCheck] = useState({ key: null, refused: false });
  useEffect(() => {
    if (!selKey || selMulti || !Number.isInteger(selSats) || !address || selTxid === null) {
      setOriginCheck({ key: selKey, refused: false });
      return undefined;
    }
    let alive = true;
    let scriptHex = "";
    try {
      scriptHex = Array.from(decodeAddress(address).script, (b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      scriptHex = "";
    }
    const listing = { txid: selTxid, vout: selVout, carrierSats: selSats, scriptHex, ticker, amount: selAmount, capHeight };
    setOriginCheck({ key: selKey, refused: false, checking: true });
    (mock ? mockCheckSecondSource(listing) : checkSecondSource(listing)).then(
      (r) => alive && setOriginCheck({ key: selKey, refused: originRefused(r) }),
      () => alive && setOriginCheck({ key: selKey, refused: false }),
    );
    return () => {
      alive = false;
    };
  }, [selKey, selTxid, selVout, selSats, selAmount, selMulti, address, ticker, capHeight, mock]);
  // Signing waits for the answer: a carrier is never listed while its check is still running.
  const { blocked: originBlocked, pending: originPending } = originCheckState(originCheck, sel);

  // §7.4 per-seller cap: at MAX_OPEN_LISTINGS_PER_ADDRESS open listings a NEW
  // listing (an outpoint without an open listing) is refused — said here,
  // before the wallet is opened; listing an already-listed outpoint again
  // replaces it and stays allowed. A `filling` UTXO has its own notice.
  const capCheck = sel && !sel.multi ? listingCapDecision(quota, sel.key) : null;
  const capBlocked = !!capCheck && !capCheck.ok && !selFilling;

  const signListing = async () => {
    if (!connected || !sel || sel.multi || selFilling || selPending || !priceOk || sel.sats === null || smallCarrier || !marketOpen || listPause || raiseBlocked || reservedCarrier || capBlocked || originBlocked || originPending || lowBlocked) return;
    // "checking" = the reads made before the wallet is opened (cap, reserved carrier).
    setListFlow({ phase: "checking" });
    try {
      // §7.4 per-seller cap, re-read at the click (another tab or device may
      // have listed since the last poll). An unreadable list fails open:
      // the order book still refuses, and that refusal gets the same words.
      let fresh = null;
      try {
        const r = await readSellerOrders((offset, limit) => indexer.ordersByAddress(address, { limit, offset }), { pageSize: indexer.ADDR_LIST_MAX_LIMIT });
        fresh = listingQuota(r.items, address, { complete: r.complete });
      } catch {
        fresh = null;
      }
      const cap = listingCapDecision(fresh, sel.key);
      if (!cap.ok) {
        myOrders.refresh();
        setListFlow({ phase: "error", error: listingCapText(cap.cap, cap.used) });
        return;
      }
      if (sel.vout === 0) {
        // Re-checked at the click — fails closed when the indexer cannot say.
        const problem = commitCarrierProblem(0, await indexer.commit(sel.txid), sync?.indexed ?? null);
        if (problem) throw new Error(problem);
      }
      const built = buildListingPsbt({ address, pubkeyHex, tokenUtxo: { txid: sel.txid, vout: sel.vout, sats: sel.sats }, priceSats, amount: sel.amount });
      // Never ask the wallet to sign a listing no fill could relay.
      const before = listingShapeProblems(built.psbtHex);
      if (before.length) throw new Error(`Not signed: ${before.join("; ")}.`);
      setListFlow({ phase: "signing" });
      // Seller signs input 0 only, SINGLE|ANYONECANPAY, and must NOT finalize.
      const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address, autoFinalized: false, sighashTypes: [LISTING_SIGHASH] });
      // ...and never publish one the wallet changed into such a listing while signing.
      const after = listingShapeProblems(signed);
      if (after.length) throw new Error(`Not published — your wallet returned a listing no buyer could complete: ${after.join("; ")}.`);
      setListFlow({ phase: "posting" });
      const view = await indexer.postOrder({ psbt: signed, ticker, amount: sel.amount, price_sats: priceSats });
      setListFlow({ phase: "listed", order: view });
      settled();
    } catch (e) {
      // 409 `market opens when TICKER is fully minted (minted X of Y)` or
      // `market opens at block N` → the same one-line notice the tabs show;
      // every other refusal of the book → one plain sentence.
      const closed = e?.status === 409 && /market opens (when|at block)/i.test(String(e?.message || ""));
      setListFlow({ phase: "error", error: closed ? marketClosed : listingRefusalText(e) ?? friendlyError(e) });
    }
  };

  // ---- renew (off-chain: GET the stored PSBT, POST it again) ---------------------------------
  const [renew, setRenew] = useState(IDLE); // { phase: idle|busy|done|error, id, error }
  const renewOrder = async (o) => {
    setRenew({ phase: "busy", id: o.id });
    try {
      const view = await indexer.renewOrder(o.id);
      setRenew({ phase: "done", id: o.id, order: view });
      refreshMine();
    } catch (e) {
      setRenew({ phase: "error", id: o.id, error: listingRefusalText(e) ?? friendlyError(e) });
    }
  };

  const [splitStr, setSplitStr] = useState("");
  useEffect(() => {
    setSplitStr("");
  }, [selKey]);
  const splitAmt = Number(splitStr);
  // Moving the WHOLE amount is allowed where it helps: a carrier that also
  // holds other tickers or BTC above 546 sats, or one a buyer could not
  // verify (it lands alone on a fresh 546-sat carrier that a SEND credited).
  // Anything else keeps at least 1 behind.
  const splitMax = sel ? (sel.multi || originBlocked || (Number.isInteger(sel.sats) && sel.sats !== DUST_SATS) ? sel.amount : sel.amount - 1) : 0;
  const splitErr = sel ? splitAmountError(splitStr, splitMax, sel.amount, ticker) : null;
  const splitOk = !!sel && splitStr !== "" && splitErr === null;
  // A split or move spends the carrier: never while a fill of it (or this browser's own spend) is in the mempool.
  const splitBlocked = splitBlockedReason(sel, { ownPending: !!sel?.listing && !!ownPendingSpendOf(records, sel.key, sel.listing.pending_spend_txid) });

  // Withdraw spends the listed carrier to yourself. A listing that left the
  // book may not name its carrier's value: the UTXO row does.
  const cancelOrder = (o) => {
    const [txid, vout] = o.id.split(":");
    const known = rows.find((r) => r.key === o.id)?.sats ?? null;
    run({ kind: "cancel", ticker, amount: o.amount, utxo: { txid, vout: Number(vout), sats: o.carrier_sats ?? known }, order: isOffBook(o) ? null : o });
  };

  // The replacement-fee rule, previewed for every filling listing before Withdraw is clicked.
  const fillingNotes = useMemo(() => {
    const out = [];
    for (const o of ordersHere) {
      if (o.status !== "filling") continue;
      if (ownPendingSpendOf(records, o.id, o.pending_spend_txid)) continue;
      let vsize = null;
      try {
        vsize = address ? estimateSendFeeSats({ address, toAddress: address, ticker, amount: o.amount, feeRateSatVb: fee.satVb || 1 }).vsize : null;
      } catch {
        vsize = null;
      }
      out.push({ order: o, rule: cancelFeeRate({ chosenSatVb: fee.satVb, order: o, incrementalRelayFee: fees.data?.incrementalrelayfee ?? null, vsize }), vsize });
    }
    return out;
  }, [ordersHere, records, address, ticker, fee.satVb, fees.data]);

  if (!connected) {
    return (
      <div className="action-body">
        <ConnectPrompt action={`list ${ticker}`} />
        <p className="fineprint">Listings are signed with SIGHASH_SINGLE|ANYONECANPAY: the tokens never leave your wallet until a buyer&apos;s fill pays you in full, on-chain.</p>
      </div>
    );
  }

  return (
    <div className="action-body sell">
      <div className="orders-head">
        <span className="label">Your {ticker} UTXOs · {rows.length}</span>
        <button className="btn btn-ghost btn-sm" type="button" onClick={refreshMine} disabled={tokenUtxos.loading}>
          Refresh
        </button>
      </div>

      {tokenUtxos.error && !tokenUtxos.data ? (
        <div className="err" title={indexerErrorTitle(tokenUtxos.error)}>Could not load your UTXOs. {indexerErrorText(tokenUtxos.error)}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{tokenUtxos.loading ? "Loading…" : `No ${ticker} on this address yet. Mine some, or buy a listing.`}</div>
      ) : (
        <>
        <ul className="utxo-list" role="radiogroup" aria-label={`${ticker} UTXOs`}>
          {rows.map((r) => {
            // A multi-ticker carrier stays selectable: it cannot be listed, but
            // its tokens can be moved onto their own carrier.
            const disabled = chainBusy;
            return (
              <li key={r.key}>
                <label className={`utxo${selKey === r.key ? " selected" : ""}${disabled ? " disabled" : ""}`}>
                  <input type="radio" name="sell-utxo" value={r.key} checked={selKey === r.key} onChange={() => setSelKey(r.key)} disabled={disabled} />
                  <span className="utxo-main">
                    <span className="num strong">
                      {fmtInt(r.amount)} {ticker}
                    </span>
                    <span className="mono muted">
                      {shortTxid(r.txid, 6, 4)}:{r.vout} · {r.sats !== null ? `${fmtInt(r.sats)} sats` : "value unknown"}
                    </span>
                  </span>
                  <span className="utxo-tag">
                    <RowTag r={r} ticker={ticker} state={sellRowState(r, pendingSpent)} />
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {/* The reasons a row cannot be listed, in plain sight (a title tooltip
            never opens on a touch screen and a disabled radio cannot be picked). */}
        {rows.some((r) => r.multi) && (
          <p className="fineprint utxo-note">
            <span className="status-tag s-cancelled">several tickers</span> — a UTXO carrying more than one ticker cannot be listed (§7.1). Select it and use <strong>Move {ticker} to its own carrier</strong>: a SEND to yourself puts the {ticker} on a fresh 546-sat carrier (the other tickers ride together to the residual carrier); list that carrier once it confirms.
          </p>
        )}
        {rows.some((r) => !r.multi && !r.listing && r.sats !== null && r.sats > DUST_SATS) && (
          <p className="fineprint utxo-note">
            <span className="status-tag s-cancelled">split first</span> — this UTXO also holds BTC above 546 sats, which a fill would hand to the buyer together with the tokens. Select it and use Split below to move the tokens onto a 546-sat carrier, then list that.
          </p>
        )}
        {rows.some((r) => sellRowState(r, pendingSpent) === "small") && (
          <p className="fineprint utxo-note">
            <span className="status-tag s-cancelled">under 546 sats</span> — the order book lists only a carrier of at least 546 sats. Select it and move the tokens to a fresh 546-sat carrier (a send to yourself), then list that.
          </p>
        )}
        {rows.some((r) => sellRowState(r, pendingSpent) === "offbook") && (
          <p className="fineprint utxo-note">
            <span className="status-tag s-filling">still buyable</span> — {OFF_BOOK_LISTING_TEXT}
          </p>
        )}
        {rows.some((r) => r.pending) && (
          <p className="fineprint utxo-note">
            <span className="status-tag s-filling">pending</span> — {OWN_PENDING_SPEND_TEXT}
          </p>
        )}
        </>
      )}

      {sel && sel.multi && (
        <div className="sell-form">
          <div className="sell-form-head">
            <span className="strong">
              {fmtInt(sel.amount)} {ticker} on a shared UTXO
            </span>
            <span className="muted">also carries {Object.keys(sel.balances).filter((t) => t !== ticker).join(", ")}</span>
          </div>
          <div className="notice">
            This UTXO carries more than one ticker, so it cannot be listed (§7.1). Moving the {fmtInt(sel.amount)} {ticker} to its own 546-sat carrier (a SEND to yourself) makes them
            listable once it confirms; the other tickers move together to the residual carrier (vout3).
          </div>
          <div className="sheet-actions">
            <button
              className="btn btn-primary btn-lg"
              type="button"
              onClick={() => run({ kind: "split", ticker, amount: sel.amount, utxo: { txid: sel.txid, vout: sel.vout, sats: sel.sats } })}
              disabled={chainBusy || !indexerOk || !!splitBlocked}
            >
              Move {fmtInt(sel.amount)} {ticker} to its own carrier
            </button>
          </div>
          {splitBlocked && <div className="notice">{splitBlocked}</div>}
          <div className="fineprint">
            Leaves your wallet: the {SEND_PROTOCOL_FEE_SATS}-sat protocol fee + the network fee at your fee choice{fee.satVb ? ` (${fee.satVb} sat/vB)` : ""}. The new carrier and the residual carrier ({DUST_SATS} sats each) stay yours.
          </div>
        </div>
      )}

      {sel && !sel.multi && (
        <div className="sell-form">
          <div className="sell-form-head">
            <span className="strong">
              List {fmtInt(sel.amount)} {ticker}
            </span>
            <span className="muted">whole UTXO — the listing sells its entire balance</span>
          </div>
          {!marketOpen && <div className="notice">{marketClosed}</div>}
          {marketOpen && listPause && <div className="notice">{listPause}</div>}
          {selPending && <div className="notice">{OWN_PENDING_SPEND_TEXT}</div>}
          {selOffBook && !raiseBlocked && (
            <div className="notice notice-raise" role="alert">
              <div>
                <strong>{offBookText({ amount: selOffBook.amount, ticker, unitText: fmtUnit(selOffBook.unit_price) })}</strong>
              </div>
              <div className="notice-row">
                <button className="btn btn-sm" type="button" onClick={() => cancelOrder(selOffBook)} disabled={chainBusy || !indexerOk || selPending}>
                  Withdraw
                </button>
                <span className="muted">
                  A send to yourself: leaves your wallet the {SEND_PROTOCOL_FEE_SATS}-sat protocol fee + the network fee{fee.satVb ? ` at ${fee.satVb} sat/vB` : ""}. The tokens move to a new carrier of yours, which you can list at any price.
                </span>
              </div>
            </div>
          )}
          {smallCarrier && !selPending && (
            <div className="notice notice-raise" role="alert">
              <div>{smallCarrierText(sel.sats)}</div>
              <div className="notice-row">
                <button className="btn btn-sm" type="button" onClick={() => run({ kind: "split", ticker, amount: sel.amount, utxo: { txid: sel.txid, vout: sel.vout, sats: sel.sats } })} disabled={chainBusy || !indexerOk || !!splitBlocked}>
                  Move {fmtInt(sel.amount)} {ticker} to a 546-sat carrier
                </button>
                <span className="muted">
                  Leaves your wallet: the {SEND_PROTOCOL_FEE_SATS}-sat protocol fee + the network fee{fee.satVb ? ` at ${fee.satVb} sat/vB` : ""}.
                </span>
              </div>
            </div>
          )}
          {originBlocked && !selPending && (
            <div className="notice notice-raise" role="alert">
              <div>{ORIGIN_REFUSED_TEXT}</div>
              <div className="notice-row">
                <button className="btn btn-sm" type="button" onClick={() => run({ kind: "split", ticker, amount: sel.amount, utxo: { txid: sel.txid, vout: sel.vout, sats: sel.sats } })} disabled={chainBusy || !indexerOk || !!splitBlocked}>
                  Move {fmtInt(sel.amount)} {ticker} to a fresh carrier
                </button>
                <span className="muted">
                  Leaves your wallet: the {SEND_PROTOCOL_FEE_SATS}-sat protocol fee + the network fee{fee.satVb ? ` at ${fee.satVb} sat/vB` : ""}.
                </span>
              </div>
            </div>
          )}
          <div className="price-grid">
            <label>
              <span className="label">Sats per token</span>
              <input className="input mono" inputMode="decimal" value={unitStr} onChange={(e) => onUnit(e.target.value)} placeholder="0.00" disabled={listBusy} />
            </label>
            <label>
              <span className="label">Total sats</span>
              <input className="input mono" inputMode="numeric" value={totalStr} onChange={(e) => onTotal(e.target.value)} placeholder={String(MIN_PRICE_SATS)} disabled={listBusy} />
            </label>
          </div>
          <div className="fee-row">
            <span>
              <span className="k">You receive</span>
              <span className="v">{priceOk ? fmtBtcShort(priceSats) : "—"}</span>
              {priceOk && usd ? ` · ${fmtUsd(priceSats, usd)}` : ""}
            </span>
            <span>
              {token?.floor_unit_price ? (
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => onUnit(fmtUnitInput(token.floor_unit_price))} disabled={listBusy}>
                  floor {fmtUnit(token.floor_unit_price)}
                </button>
              ) : (
                <span className="muted">no listings</span>
              )}
              {token?.last_trade ? (
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => onUnit(fmtUnitInput(token.last_trade.unit_price))} disabled={listBusy}>
                  last {fmtUnit(token.last_trade.unit_price)}
                </button>
              ) : null}
            </span>
          </div>
          {!priceOk && totalStr !== "" && (
            <div className="err">
              {maxPrice !== null && Number.isInteger(priceSats) && priceSats > maxPrice
                ? `At most 1 BTC per token: ≤ ${fmtInt(maxPrice)} sats for these ${fmtInt(sel.amount)} ${ticker} — the order book refuses a higher price.`
                : `Price must be a whole number of sats ≥ ${fmtInt(minPriceSats)}.`}
            </div>
          )}
          {!priceOk && totalStr === "" && unitStr.trim() !== "" && <div className="err">{unitProblem || "Enter the price as a number of sats per token, e.g. 15.5."}</div>}
          {priceOk && unitStr.trim() !== "" && (
            <div className="fineprint">
              = {fmtUnit(priceSats / sel.amount)} sats per token · {fmtInt(priceSats)} sats for {fmtInt(sel.amount)} {ticker}
            </div>
          )}
          {low && (
            <div className="notice notice-raise" role="alert">
              <div>
                <strong>
                  {fmtUnit(priceSats / sel.amount)} sats per token is less than a tenth of the {low.refKind} ({fmtUnit(low.ref)}).
                </strong>{" "}
                A signed listing can be bought by anyone at this price as soon as it is published, and only an on-chain Withdraw voids it.
              </div>
              <label className="ack">
                <input type="checkbox" checked={lowAck === lowKey} onChange={(e) => setLowAck(e.target.checked ? lowKey : null)} disabled={listBusy} />
                <span>
                  I mean {fmtUnit(priceSats / sel.amount)} sats per token — {fmtInt(priceSats)} sats in total for {fmtInt(sel.amount)} {ticker}.
                </span>
              </label>
            </div>
          )}
          {fatCarrier && (
            <div className="err">
              This UTXO also carries {fmtInt(sel.sats)} sats of BTC, which go to the buyer together with the tokens — the minimum price is {fmtInt(sel.sats)} sats. To list the tokens only, split them onto a 546-sat carrier first (below) and list that.
            </div>
          )}
          {sel.sats === null && <div className="err">{UNKNOWN_VALUE_TEXT}</div>}
          {aboveBand && (
            <div className="notice">
              {fmtUnit(priceSats / sel.amount)} sats/token is more than 100× the current floor ({fmtUnit(bandRef)}). The order book accepts an ask only up to 100× the best other open {ticker} ask (§7.4) — your own other listings count too, so expect it to be refused unless that floor is this same UTXO&apos;s current listing (re-listing it).
            </div>
          )}
          {sel.listing && sel.listing.status === "open" && !raiseBlocked && (
            <div className="notice">
              Already listed at {fmtUnit(sel.listing.unit_price)} sats per token.{relist?.kind === "lower" ? " A lower price replaces that listing in the book." : ""} {RELIST_WARNING}
            </div>
          )}
          {raiseBlocked && guarding && (
            <div className="notice notice-raise" role="alert">
              <div>
                <strong>
                  {relist?.offBook ? "An earlier listing of this output (it left the order book, but can still be bought) is" : "Listed"} at {fmtUnit(guarding.unit_price)} sats per token — {fmtUnit(priceSats / sel.amount)} is higher.
                </strong>{" "}
                {RAISE_PRICE_TEXT}
              </div>
              <div className="notice-row">
                <button className="btn btn-sm" type="button" onClick={() => cancelOrder(guarding)} disabled={chainBusy || !indexerOk || selPending}>
                  Withdraw first
                </button>
                <span className="muted">
                  Leaves your wallet: the {SEND_PROTOCOL_FEE_SATS}-sat protocol fee + the network fee{fee.satVb ? ` at ${fee.satVb} sat/vB` : ""}. The two {DUST_SATS}-sat carriers it creates stay yours.
                </span>
              </div>
            </div>
          )}
          {reservedCarrier && (
            <div className="notice notice-raise" role="alert">
              {carrierCheck.problem}
            </div>
          )}
          {selFilling && (
            <div className="notice">
              {ownPendingSpendOf(records, sel.key, sel.listing.pending_spend_txid)
                ? "Your own transaction spending this UTXO is in the mempool — the order book refuses a new listing for it until that confirms or drops."
                : "A fill of this listing is already in the mempool — the order book refuses a new listing for this UTXO until that fill confirms, or a Withdraw replaces it."}
            </div>
          )}
          {capBlocked && (
            <div className="notice notice-raise" role="alert">
              {listingCapText(capCheck.cap, capCheck.used)}
            </div>
          )}
          {quota && (
            <div className={`listing-quota${quota.full ? " full" : ""}`}>
              <span className="quota-meter" aria-hidden="true">
                {Array.from({ length: quota.cap }, (_, i) => (
                  <i key={i} className={i < quota.used ? "on" : undefined} />
                ))}
              </span>
              <span className="quota-count">{listingQuotaText(quota)}</span>
              <span className="quota-note">
                {capCheck?.kind === "replace" && quota.full
                  ? "This UTXO is already one of them, so listing it again at the same or a lower price is allowed."
                  : `One address can have ${quota.cap} open listings at a time, all tokens together.`}
              </span>
            </div>
          )}

          <div className="sheet-actions">
            <button className="btn btn-primary btn-lg" type="button" onClick={signListing} disabled={!marketOpen || !!listPause || !priceOk || selFilling || selPending || raiseBlocked || reservedCarrier || capBlocked || originBlocked || originPending || lowBlocked || sel.sats === null || smallCarrier || listBusy || !indexerOk || chainBusy}>
              {listFlow.phase === "checking" ? "Checking…" : listFlow.phase === "signing" ? "Awaiting signature…" : listFlow.phase === "posting" ? "Publishing…" : originPending ? "Checking this UTXO…" : sel.listing ? "Sign new listing" : "Sign listing"}
            </button>
          </div>
          {listFlow.phase === "signing" && (
            <div className="status" role="status">
              <div className="line">
                <Led state="busy" />
                <span>{w.providerName || "Your wallet"}: sign input 0 with SINGLE|ANYONECANPAY (0x83), not finalized. Nothing is broadcast — the listing only becomes a transaction when a buyer fills it.</span>
              </div>
            </div>
          )}
          {listFlow.phase === "listed" && (
            <div className="status" role="status">
              <div className="line">
                <Led state="ok" />
                <span>
                  Listed{listFlow.order?.replaced ? " (replaced your previous listing for this UTXO)" : ""}: {fmtInt(listFlow.order?.amount)} {ticker} for {fmtSats(listFlow.order?.price_sats)}.
                </span>
              </div>
              <div className="detail">Tokens stay on your address until a buyer&apos;s fill pays you. The book shows it for 14 days; Renew below extends that for free. After that it leaves the book, but its signature stays valid — it can still be bought at this price until you Withdraw (below), the only thing that voids it.</div>
            </div>
          )}
          {listFlow.phase === "error" && (
            <div className="status" role="status">
              <div className="line">
                <Led state="err" />
                <span>{listFlow.error}</span>
              </div>
              <div className="actions">
                <button className="btn btn-sm" type="button" onClick={() => setListFlow(IDLE)}>
                  Reset
                </button>
              </div>
            </div>
          )}

          <details className="split">
            <summary>Want to sell only part of it? Split first</summary>
            <p className="fineprint">
              A listing always sells a whole UTXO. A split is a SEND to yourself: vout0 becomes a new 546-sat {ticker} carrier holding the amount you enter, vout3 (also 546 sats) keeps the rest; any BTC change comes back separately as vout4. After it confirms, list the new vout0.
              {guarding && guarding.status !== "filling" ? " Splitting a listed UTXO spends it on-chain, which withdraws its listing." : ""}
            </p>
            {splitBlocked && <div className="notice">{splitBlocked}</div>}
            <div className="price-grid">
              <label>
                <span className="label">Amount to split off</span>
                <input className="input mono" inputMode="numeric" value={splitStr} onChange={(e) => setSplitStr(e.target.value)} placeholder={`1 – ${splitMax}`} disabled={chainBusy || !!splitBlocked} aria-describedby="split-err" />
              </label>
              <div className="price-grid-btn">
                <button className="btn" type="button" onClick={() => run({ kind: "split", ticker, amount: splitAmt, utxo: { txid: sel.txid, vout: sel.vout, sats: sel.sats } })} disabled={!splitOk || chainBusy || !indexerOk || !!splitBlocked}>
                  Split {splitOk ? fmtInt(splitAmt) : ""} {ticker}
                </button>
              </div>
            </div>
            {splitStr !== "" && splitErr && (
              <div className="err" id="split-err">
                {splitErr}
              </div>
            )}
            <div className="fineprint">
              Leaves your wallet: the {SEND_PROTOCOL_FEE_SATS}-sat protocol fee + the network fee at your fee choice{fee.satVb ? ` (${fee.satVb} sat/vB)` : ""}. The new carrier and the residual carrier ({DUST_SATS} sats each) stay yours.
            </div>
          </details>
        </div>
      )}

      {chain.phase !== "idle" && (
        <>
          {chain.rule?.raised && (
            <div className="notice">
              <strong>Replacement fee.</strong> A fill of this listing is pending in the mempool at {chain.order?.pending_feerate ?? "?"} sat/vB; to replace it the network requires at least {chain.rule.floorSatVb} sat/vB — max of your {fee.satVb} sat/vB, {chain.rule.rateFloor} (its rate + {chain.rule.incr} increment + 1)
              {chain.rule.absFloor !== null ? ` and ${chain.rule.absFloor} (enough absolute fee to beat what it already pays)` : ""}. This transaction uses {chain.rule.satVb} sat/vB.
            </div>
          )}
          <TxProgress
            flow={chain}
            status={status}
            onReset={reset}
            onStopWaiting={stopWaiting}
            labels={{
              signing: chain.kind === "cancel" ? `Awaiting signature — ${WITHDRAW_FEE_NOTE}` : undefined,
              building: chain.kind === "cancel" ? "Building the withdrawal — a SEND of the listed UTXO to yourself." : "Building the split — a SEND to yourself.",
              pending: chain.kind === "cancel" ? WITHDRAW_PENDING_TEXT : "Split broadcast. Pending confirmation — checking every 15 s.",
              confirmed: chain.kind === "cancel" ? WITHDRAW_CONFIRMED_TEXT : "Split confirmed. The new vout0 is listable above.",
              final:
                chain.kind === "cancel"
                  ? "Withdrawn on-chain and final. The old signed listing can no longer be filled. The tokens are on a new carrier (listed above once the indexer shows it) — select it to list at any price."
                  : "Split confirmed and final. The new vout0 is listable above.",
            }}
          />
          <SpeedUpSend send={sendFlow} fees={fees.data} note={chain.kind === "cancel" ? "Until it confirms, anyone who saved the listing can still fill it with a higher-fee transaction." : null} />
        </>
      )}

      <div className="my-listings">
        <div className="orders-head">
          <span className="label">My {ticker} listings</span>
          {renew.phase === "busy" && <span className="muted">Renewing…</span>}
          {renew.phase === "done" && <span className="ok">Renewed — 14 more days.</span>}
          {renew.phase === "error" && <span className="err">{renew.error}</span>}
        </div>
        {fillingNotes.map(({ order: o, rule }) => (
          <div className="notice" key={o.id}>
            <strong>Fill pending.</strong> {fmtInt(o.amount)} {ticker} @ {fmtUnit(o.unit_price)}: a fill sits in the mempool at {o.pending_feerate ?? "?"} sat/vB{o.pending_fee_sats !== null ? ` (${fmtInt(o.pending_fee_sats)} sats${o.pending_vsize !== null ? ` over ${fmtInt(o.pending_vsize)} vB` : ""})` : ""}. If it confirms you are paid. Withdraw would have to replace it and will use{" "}
            {rule.overCap ? <span className="err">more than the {fmtInt(1000)} sat/vB safety cap — not possible until it confirms or drops</span> : <span className="mono">≥ {rule.floorSatVb ?? rule.satVb} sat/vB</span>}
            {rule.raised && !rule.overCap ? ` (raised from your ${fee.satVb} sat/vB)` : ""}.
          </div>
        ))}
        <OrdersTable q={ordersQ} onCancel={cancelOrder} onRenew={renewOrder} busy={chainBusy || renew.phase === "busy"} records={records} empty={`No ${ticker} listings from this address.`} />
        <p className="fineprint">
          <strong>Renew</strong> re-publishes the same signed listing (nothing to sign) so the book keeps showing it past its 14 days; at the same price it keeps its place among equal-priced listings. A listing that leaves the book is NOT void: it can still be bought at its price until you withdraw it. <strong>Withdraw</strong> moves the listed tokens to a fresh UTXO of yours (a SEND to yourself) — the spec&apos;s cancel; pick a fee that confirms soon. {RELIST_WARNING}
        </p>
      </div>
    </div>
  );
}

/** The status tag of one of the seller's carriers (listingRules.sellRowState). */
function RowTag({ r, ticker, state }) {
  if (state === "pending") return <span className="status-tag s-filling" title={OWN_PENDING_SPEND_TEXT}>pending</span>;
  if (state === "multi") {
    return (
      <span className="status-tag s-cancelled" title={`Carries ${Object.keys(r.balances).join(" + ")} — a UTXO with more than one ticker cannot be listed (§7.1). Select it and use "Move ${ticker} to its own carrier".`}>
        several tickers
      </span>
    );
  }
  if (state === "filling") return <span className="status-tag s-filling">fill pending</span>;
  if (state === "listed") return <span className="status-tag s-open">listed @ {fmtUnit(r.listing.unit_price)}</span>;
  if (state === "offbook") {
    return (
      <span className="status-tag s-filling" title={offBookText({ amount: r.amount, ticker, unitText: fmtUnit(r.offBook.unit_price) })}>
        still buyable @ {fmtUnit(r.offBook.unit_price)}
      </span>
    );
  }
  if (state === "unknown") {
    return (
      <span className="status-tag s-cancelled" title={UNKNOWN_VALUE_TEXT}>
        value unknown
      </span>
    );
  }
  if (state === "small") {
    return (
      <span className="status-tag s-cancelled" title={smallCarrierText(r.sats)}>
        under 546 sats
      </span>
    );
  }
  if (state === "fat") {
    return (
      <span className="status-tag s-cancelled" title={`This UTXO also holds ${fmtInt(r.sats)} sats of BTC that would go to the buyer — split the tokens onto a 546-sat carrier first.`}>
        split first
      </span>
    );
  }
  return <span className="status-tag">listable</span>;
}

// Formats any finite value — whole numbers and fractions alike (2 decimals
// at ≥ 1, below 1 as many as three significant digits need, at least 4;
// Number() drops trailing zeros so 5 stays "5").
function fmtUnitInput(v) {
  if (!Number.isFinite(v)) return "";
  return String(Number(v.toFixed(v >= 1 ? 2 : subUnitDecimals(v))));
}
