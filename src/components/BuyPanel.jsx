import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hex } from "@scure/base";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { droppedMessage, useTxStatus } from "../hooks/useTxStatus.js";
import { useModalFocus } from "../hooks/useModalFocus.js";
import { friendlyError } from "../hooks/useWallet.js";
import { useBuildSignal } from "../hooks/useBuildSignal.js";
import { buildFillPsbt, fillSendAmount, finalizeFill, parseListing, verifyListing } from "../lib/swap.js";
import { expectPsbtPayload, minFeeInputSats } from "../lib/psbt.js";
import { isUsableFeeRate, missingFeeHint } from "../lib/feechoice.js";
import { filledLineText, fillOutcome, fillOutcomeText, fillQuote, fmtChangePct, signTimeOrderProblem, slowFillWarning } from "../lib/market.js";
import { usePoll } from "../hooks/usePoll.js";
import { SECOND_SOURCE_NAME, checkSecondSource, secondSourceAllowsSigning } from "../lib/secondSource.js";
import { carrierRowOf, sellerCarrierCheck } from "../lib/buyChecks.js";
import { mockCheckSecondSource } from "../lib/mock.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import { fundingMessage } from "../lib/funding.js";
import { syncPauseText } from "../lib/sync.js";
import { forgetTx, markTxConfirmed, markTxUnconfirmed } from "../lib/txrecords.js";
import { FINAL_DEPTH, isMarketOpen, marketPendingText } from "../lib/finality.js";
import { fmtBtcShort, fmtInt, fmtSats, fmtUnit, fmtUsd } from "../lib/format.js";
import TxProgress, { ConnectPrompt } from "./TxProgress.jsx";
import FeeSelector from "./FeeSelector.jsx";
import Identicon from "./Identicon.jsx";
import Led from "./hud/Led.jsx";

const IDLE = { phase: "idle" };
const BUSY = new Set(["building", "signing", "broadcasting", "pending"]);
/** Phases whose fill is still tracked (until its block is final). */
const TRACKED = new Set(["pending", "unseen", "confirmed"]);
/** Phases in which the listing's own state is read too: another spend of it may have taken its place. */
const WATCH_ORDER = new Set(["pending", "unseen"]);
const ORDER_POLL_MS = 15_000;
const RACE_MESSAGE = "This listing was just filled or withdrawn by someone else — your funds did not move.";

const CHECK_ORDER = [
  { id: "shape", n: 1, label: "Listing has exactly 1 input and 1 output" },
  { id: "signature", n: 2, label: "Seller signed input 0 with SINGLE|ANYONECANPAY (0x83)" },
  { id: "live", n: 3, label: "Order is still open and the seller still holds the UTXO" },
  { id: "output", n: 4, label: "Output 0 pays exactly price_sats (≥ the UTXO's own value) back to the seller" },
  { id: "carrier", n: 5, label: "witnessUtxo value matches the indexer's carrier_sats" },
];

/**
 * The persistent buy bar at the bottom of the Market tab plus the buy
 * sheet it opens. `order` is the ask selected in the order book (or null).
 * The bar shows what the fill costs at the shared fee choice; Confirm opens
 * the sheet, which runs the five §7.2 checks, then the second-source check
 * of the listed outpoint, then signs and broadcasts.
 */
export default function BuyPanel({ ticker, token, order, onClear, onSettled, usd = null }) {
  const { wallet: w, address, fee, indexerOk, refreshAll } = useApp();
  // The sheet works on a SNAPSHOT of the ask it was opened for: the book
  // keeps polling behind it, and once the fill confirms the ask leaves the
  // book (and the selection) — the sheet must still show "Filled".
  const [sheetOrder, setSheetOrder] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [flow, setFlow] = useState(IDLE);
  const connected = w.status === "connected";
  const busy = BUSY.has(flow.phase);
  // The fill's reads live with the flow, not the sheet: hiding the sheet
  // keeps them; leaving the tab or a wallet change stops them.
  const reads = useBuildSignal();

  // The fill's confirmation is polled HERE, not in the sheet: the sheet can
  // be hidden while the fill is pending (Hide / Esc / the backdrop), and the
  // bar's "checking every 15 s" must stay true then.
  const status = useTxStatus(TRACKED.has(flow.phase) ? flow.txid : null, {
    onConfirmed: (s) => {
      // Tracked (and its inputs guarded) until the block is final.
      if (address && flow.txid) markTxConfirmed(address, flow.txid, s.block_height ?? null);
      setFlow((f) => ({ ...f, phase: "confirmed" }));
      refreshAll();
      onSettled?.();
    },
    onReorg: (kind) => {
      if (kind !== "mempool") return;
      // Back in the mempool: pending again; a competing fill or the seller's
      // withdrawal can still take its place until it confirms.
      if (address && flow.txid) markTxUnconfirmed(address, flow.txid);
      setFlow((f) => (f.phase === "confirmed" ? { ...f, phase: "pending" } : f));
      refreshAll();
    },
  });
  useEffect(() => {
    if (status.final && address && flow.txid) forgetTx(address, flow.txid);
  }, [status.final, address, flow.txid]);

  // The node has not seen the fill for a while — a competing fill or a
  // withdrawal may have replaced it, or the node may just not have it: say
  // so and keep checking (the listing's own state, below, says which when
  // it knows).
  useEffect(() => {
    if (status.dropped) setFlow((f) => (f.phase === "pending" ? { ...f, phase: "unseen", note: f.replacing ? f.note : droppedMessage(f.txid, "fill") } : f));
    else setFlow((f) => (f.phase === "unseen" ? { ...f, phase: "pending", note: f.replacing ? f.note : null } : f));
  }, [status.dropped]);

  // While the fill waits, the book's view of the listing says what became of
  // it: another spend in the mempool ahead of it ("replacing" — said at
  // once, still followed), another buyer's fill or the seller's withdrawal
  // confirmed ("other" / "seller" — this fill can never confirm: the flow
  // ends, the BTC did not move and the inputs are free again), or this
  // address's own fill under another txid ("mine" — followed).
  const watchId = WATCH_ORDER.has(flow.phase) && flow.txid && sheetOrder ? sheetOrder.id : null;
  const orderNow = usePoll(watchId ? (s) => indexer.order(watchId, s) : null, ORDER_POLL_MS, [watchId, flow.txid]);
  const outcome = useMemo(() => (watchId ? fillOutcome(orderNow.data, { txid: flow.txid, address }) : null), [watchId, orderNow.data, flow.txid, address]);
  useEffect(() => {
    if (!outcome) return;
    const mine = flow.txid;
    if (outcome.kind === "mine") {
      setFlow((f) => (f.txid === mine && WATCH_ORDER.has(f.phase) ? { ...f, phase: "pending", txid: outcome.txid, note: null, replacing: null } : f));
      return;
    }
    if (outcome.kind === "other" || outcome.kind === "seller") {
      // The spend that took its place is confirmed: this fill can never confirm, its inputs are free.
      if (address && mine) forgetTx(address, mine);
      setFlow((f) => (f.txid === mine && WATCH_ORDER.has(f.phase) ? { ...f, phase: "replaced", note: fillOutcomeText(outcome), replacing: null, by: outcome.txid } : f));
      return;
    }
    setFlow((f) => (f.txid === mine && WATCH_ORDER.has(f.phase) ? { ...f, note: fillOutcomeText(outcome), replacing: outcome.txid } : f));
    // reacts to a new verdict only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome?.kind, outcome?.txid]);

  // A wallet change abandons the sheet's state.
  useEffect(() => {
    reads.stop();
    setFlow(IDLE);
    setSheetOpen(false);
    setSheetOrder(null);
  }, [address, reads]);
  // A new selection while nothing is in flight replaces the snapshot.
  useEffect(() => {
    if (busy || flow.phase === "confirmed") return;
    if (order && sheetOrder && order.id !== sheetOrder.id) {
      setFlow(IDLE);
      setSheetOpen(false);
      setSheetOrder(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the selection only
  }, [order?.id]);

  const quote = order ? fillQuote({ order, address: address || order.seller, feeRateSatVb: fee.satVb }) : null;
  // No fill before the market is open: the token is minted out AND the block
  // that completed its supply is FINAL_DEPTH deep — until then a chain
  // reorganization could still change how many tokens a listed output holds.
  const marketOpen = isMarketOpen(token) && order?.market_open !== false;
  const open = () => {
    setSheetOrder(order);
    setFlow(IDLE);
    setSheetOpen(true);
  };
  const reset = () => {
    setFlow(IDLE);
    setSheetOpen(false);
    setSheetOrder(null);
    onClear?.();
  };
  const inFlight = sheetOrder && flow.phase !== "idle";

  return (
    <div className="buybar-wrap">
      <div className="buybar" aria-label="Buy">
        <div className="buybar-sel">
          {inFlight && !sheetOpen ? (
            <>
              <span className="label">Buy · {fmtInt(sheetOrder.amount)} {ticker}</span>
              <span className="buybar-line">
                <span className="muted">
                  {flow.phase === "confirmed"
                    ? filledLineText(status)
                    : flow.phase === "error"
                      ? flow.error
                      : flow.phase === "replaced"
                        ? flow.note
                        : flow.replacing
                          ? flow.note
                          : flow.phase === "unseen"
                            ? status.watchEnded
                              ? "Not seen by the indexer's node for over an hour — no longer checked here. Look at your Portfolio."
                              : "Not seen by the indexer's node for a while — still checking."
                            : "In progress — checking every 15 s."}
                </span>
                <button className="btn btn-sm" type="button" onClick={() => setSheetOpen(true)}>
                  Show
                </button>
                {(flow.phase === "confirmed" || flow.phase === "error" || flow.phase === "replaced" || (flow.phase === "unseen" && status.watchEnded)) && (
                  <button className="btn btn-ghost btn-sm" type="button" onClick={reset}>
                    Done
                  </button>
                )}
              </span>
            </>
          ) : order ? (
            <>
              <span className="label">Selected listing</span>
              <span className="buybar-line">
                <span className="hero-num">
                  {fmtInt(order.amount)} <small>{ticker}</small>
                </span>
                <span className="mono muted">
                  @ {fmtUnit(order.unit_price)} sats → <span className="strong">{fmtSats(order.price_sats)}</span>
                  {usd ? ` · ${fmtUsd(order.price_sats, usd)}` : ""}
                </span>
                <button className="btn btn-ghost btn-sm" type="button" onClick={reset} disabled={busy} aria-label="Clear selection">
                  ×
                </button>
              </span>
            </>
          ) : (
            <>
              <span className="label">Buy</span>
              <span className="muted">Select a listing above — one listing per purchase. A fill completes the seller&apos;s signed listing on-chain; nobody holds funds in between.</span>
            </>
          )}
        </div>

        {/* Fee presets and the cost breakdown appear once an ask is picked — the
            idle bar stays one line tall so it never crowds a phone screen. */}
        {order && (
        <div className="buybar-fee">
          <FeeSelector fee={fee} disabled={busy} />
        </div>
        )}

        {order && (
        <div className="buybar-total">
          <dl className="buybar-costs">
            <div>
              <dt>Listing price</dt>
              <dd className="mono">{order ? fmtSats(order.price_sats) : "—"}</dd>
            </div>
            <div>
              <dt>Protocol fee + 2 carriers</dt>
              <dd className="mono">{quote ? fmtSats(quote.protocolFeeSats + quote.tokenCarrierSats + quote.residualCarrierSats) : "—"}</dd>
            </div>
            <div>
              <dt>Network fee{fee.satVb ? ` @ ${fee.satVb} sat/vB` : ""}</dt>
              <dd className="mono">{quote ? `≈ ${fmtSats(quote.feeSats)}` : "—"}</dd>
            </div>
            <div>
              <dt>Seller&apos;s UTXO value, back in your change</dt>
              <dd className="mono">{quote ? `−${fmtSats(quote.carrierInSats)}` : "—"}</dd>
            </div>
            <div className="total">
              <dt>Leaves your wallet</dt>
              <dd className="mono">
                {quote ? (
                  <>
                    ≈ {fmtSats(quote.netSats)} <span className="muted">({fmtBtcShort(quote.netSats)}{usd ? ` · ${fmtUsd(quote.netSats, usd)}` : ""})</span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
          <button className="btn btn-primary btn-lg buybar-confirm" type="button" onClick={open} disabled={!order || !quote || !indexerOk || busy || !marketOpen || (inFlight && flow.phase === "confirmed")}>
            {busy ? "Working…" : order ? `Confirm · buy ${fmtInt(order.amount)} ${ticker}` : "Select a listing"}
          </button>
          {order && !fee.satVb && <div className="err">{missingFeeHint(fee.choice, fee.satVb, "buy", { awaitingAck: !!fee.highFee?.pending })}</div>}
          {order && !indexerOk && <div className="err">The indexer is not answering right now — fills are paused until it does.</div>}
          {order && !marketOpen && <div className="err">{marketPendingText(token || { ticker })}</div>}
        </div>
        )}
      </div>

      {/* Portalled to <body>: inside the sticky .buybar-wrap (its own stacking
          context, z 6) the sheet painted under the top bar (z 20) and the
          phone tab bar (z 30) — Close and Sign sat under them. */}
      {sheetOpen &&
        sheetOrder &&
        createPortal(
          <BuySheet order={sheetOrder} ticker={ticker} token={token} usd={usd} flow={flow} setFlow={setFlow} status={status} reads={reads} onClose={() => setSheetOpen(false)} onReset={reset} connected={connected} />,
          document.body,
        )}
    </div>
  );
}

/**
 * Build (never sign) the fill of verified order `full` for `addr` at `rate`
 * from the wallet's current UTXOs — the dry run and the real build share it.
 * `signal` stops the reads.
 * `sendAmount` is the SEND's AMT (fillSendAmount): the listed amount only when
 * the second source confirmed it, else 1 — every token the output holds
 * still reaches the buyer (1 on vout1, the rest on vout2).
 */
async function buildFill(full, addr, pubkeyHex, rate, signal, sendAmount) {
  const [utxoRes, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(addr, { signal }), indexer.tokenUtxos(addr, signal)]);
  let built;
  try {
    built = buildFillPsbt({
      listingPsbtHex: full.psbt,
      order: full,
      address: addr,
      pubkeyHex,
      utxos: utxoRes.utxos,
      tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), addr),
      feeRateSatVb: rate,
      minInputSats: minFeeInputSats(utxoRes.assetSafe), // an inscribed sat on a small output would go to the seller
      sendAmount,
    });
  } catch (e) {
    // Not enough (confirmed) BTC: say why in plain words.
    const plain = fundingMessage(e, utxoRes, { action: "this fill" });
    throw plain ? new Error(plain) : e;
  }
  return { ...built, assetSafe: utxoRes.assetSafe };
}

function requireRate(v) {
  if (!isUsableFeeRate(v)) throw new Error("No fee rate — neither the indexer nor mempool.space has an estimate; pick Custom and enter a sat/vB.");
  return v;
}

const SECOND_IDLE = { state: "pending", detail: "", reasons: [], notes: [] };

/**
 * The buy sheet: the five mandatory §7.2 checks (1, 2, 4, 5 from the PSBT
 * against the OrderView; 3 a live read), then the independent second-source
 * check of the listed outpoint against mempool.space, the plain-words
 * explanation, the totals, and the sign → broadcast → confirm flow.
 */
function BuySheet({ order, ticker, token, usd, flow, setFlow, status, reads, onClose, onReset, connected }) {
  const { wallet: w, fee, fees, indexerOk, mock, sync } = useApp();
  const [checks, setChecks] = useState(() => CHECK_ORDER.map((c) => ({ ...c, state: "pending", detail: "" })));
  const [second, setSecond] = useState(SECOND_IDLE);
  const [ack, setAck] = useState(false);
  // A separate, explicit confirmation for a carrier whose AMOUNT the second
  // source cannot confirm — never the same tick as the
  // "second source unreachable" one.
  const [amountAck, setAmountAck] = useState(false);
  const [full, setFull] = useState(null);
  const [verifyError, setVerifyError] = useState(null);
  const runRef = useRef(0);
  const sheetRef = useRef(null);
  const busy = BUSY.has(flow.phase);
  // The block that completed the supply — the only block whose MINE may
  // carry a §3 partial credit. A primitive, so the
  // token poll behind the sheet does not re-run the checks.
  const capHeight = Number.isInteger(token?.minted_out_height) ? token.minted_out_height : null;
  // Dialog semantics: focus moves in, Tab cycles inside, Esc closes (while
  // a fill is in flight Esc and the backdrop HIDE the sheet — the fill keeps
  // running and Show on the bar brings it back), body scroll locked, focus
  // restored.
  useModalFocus(sheetRef, true, onClose);

  const verify = useCallback(async () => {
    const run = ++runRef.current;
    setVerifyError(null);
    setFull(null);
    setAck(false);
    setAmountAck(false);
    setSecond(SECOND_IDLE);
    setChecks(CHECK_ORDER.map((c) => ({ ...c, state: "pending", detail: "" })));
    const apply = (id, ok, detail) => setChecks((cs) => cs.map((c) => (c.id === id ? { ...c, state: ok ? "ok" : "fail", detail } : c)));
    const failAll = (detail) => {
      for (const c of CHECK_ORDER) apply(c.id, false, detail);
      setSecond({ state: "skipped", detail: "not consulted — the indexer checks failed first", reasons: [], notes: [] });
    };
    try {
      const o = await indexer.order(order.id);
      if (run !== runRef.current) return;
      if (!o) {
        failAll("listing not found");
        setVerifyError("This listing is no longer on the order book.");
        return;
      }
      if (!o.psbt) {
        failAll("indexer returned no PSBT");
        setVerifyError("The indexer returned the order without its PSBT.");
        return;
      }
      const v = verifyListing({ psbtHex: o.psbt, order: o });
      for (const c of v.checks) apply(c.id, c.ok, c.detail);
      // Every number this sheet shows comes from the row it was opened for
      // (`order`), while the PSBT that would be signed is the one just
      // fetched (`o`). A seller can re-POST the same outpoint at another
      // price between the book's poll and this read — that must never be
      // signed at a total the sheet did not display, so it fails check 3.
      const drift = [];
      if (o.price_sats !== order.price_sats) drift.push(`price ${fmtSats(order.price_sats)} → ${fmtSats(o.price_sats)}`);
      if (o.amount !== order.amount) drift.push(`amount ${fmtInt(order.amount)} → ${fmtInt(o.amount)}`);
      if (o.ticker !== order.ticker) drift.push(`ticker ${order.ticker} → ${o.ticker}`);
      if (o.seller !== order.seller) drift.push("seller differs");
      if (o.carrier_sats !== order.carrier_sats) drift.push(`carrier ${fmtInt(order.carrier_sats)} → ${fmtInt(o.carrier_sats)} sats`);
      // Check 3: live reads.
      let liveOk = o.status === "open" && drift.length === 0;
      let liveDetail = drift.length
        ? `the seller re-published this listing since you selected it (${drift.join(", ")}) — close and pick it again`
        : liveOk
          ? "order open"
          : o.status === "filling"
            ? "a fill of this listing is already in the mempool"
            : `order is ${o.status}`;
      if (drift.length) setVerifyError("This listing changed since you selected it. Close the sheet and select it again to see the new total.");
      if (liveOk) {
        try {
          const utxos = await indexer.tokenUtxos(o.seller);
          if (run !== runRef.current) return;
          // Exactly { TICKER: amount } with amount > 0 — a zero-token carrier
          // is never buyable.
          const c = sellerCarrierCheck(carrierRowOf(utxos, o.id), o);
          liveOk = c.ok;
          liveDetail = c.detail;
        } catch (e) {
          liveOk = false;
          liveDetail = `could not read seller UTXOs: ${friendlyError(e)}`;
        }
      }
      apply("live", liveOk, liveDetail);
      const indexerOkAll = v.ok && liveOk;
      setFull(indexerOkAll ? o : null);
      if (!indexerOkAll) {
        setSecond({ state: "skipped", detail: "not consulted — the indexer checks failed first", reasons: [], notes: [] });
        return;
      }
      // A second, independent source must describe the same UTXO.
      const L = parseListing(o.psbt);
      const [txid, vout] = o.id.split(":");
      const listing = { txid, vout: Number(vout), carrierSats: o.carrier_sats, scriptHex: L.input0?.witnessUtxo?.script ? hex.encode(L.input0.witnessUtxo.script) : "", ticker: o.ticker, amount: o.amount, capHeight };
      setSecond({ state: "checking", detail: `checking ${SECOND_SOURCE_NAME}…`, reasons: [], notes: [] });
      const r = mock ? await mockCheckSecondSource(listing) : await checkSecondSource(listing);
      if (run !== runRef.current) return;
      setSecond({ state: r.verdict, detail: r.detail, reasons: r.reasons || [], notes: r.notes || [] });
    } catch (e) {
      if (run !== runRef.current) return;
      setVerifyError(friendlyError(e));
    }
    // `order` is the snapshot the sheet was opened for (stable until re-opened)
  }, [order, mock, capHeight]);

  useEffect(() => {
    verify();
    return () => {
      runRef.current += 1;
    };
  }, [verify]);

  const allOk = checks.every((c) => c.state === "ok");
  const anyFail = checks.some((c) => c.state === "fail");
  const secondOk = secondSourceAllowsSigning(second.state, { unreachableAck: ack, unverifiedAck: amountAck });
  // The fill's AMT follows the second source's verdict (fillSendAmount).
  const secondState = second.state;
  const sendAmount = full ? fillSendAmount(secondState, full.amount) : null;
  const quote = fillQuote({ order, address: w.address || order.seller, feeRateSatVb: fee.satVb });

  // The quote assumes ONE buyer input. Once the listing
  // verified, build the fill for real (nothing is signed) so the sheet and
  // the Sign button show the exact total the wallet will be asked for.
  const [dry, setDry] = useState(null); // { rate, loading } | { rate, totalSats, feeSats, inputCount } | { rate, error }
  // The running dry run's stop handle: Sign stops it (see confirm).
  const dryCtrl = useRef(null);
  const walletAddress = w.address;
  const walletPubkey = w.pubkeyHex;
  useEffect(() => {
    const rate = fee.satVb;
    if (!connected || !full || !isUsableFeeRate(rate) || !walletAddress) {
      setDry(null);
      return undefined;
    }
    let alive = true;
    // Closing the sheet (or a new rate) stops this read; Sign reads on its own.
    const ctrl = new AbortController();
    dryCtrl.current = ctrl;
    setDry({ rate, loading: true });
    (async () => {
      try {
        const built = await buildFill(full, walletAddress, walletPubkey, rate, ctrl.signal, fillSendAmount(secondState, full.amount));
        if (alive) setDry({ rate, totalSats: built.totalSats, feeSats: built.feeSats, inputCount: built.inputs.length });
      } catch (e) {
        if (!alive) return;
        // Stopped by Sign, whose own build computes the exact total.
        if (ctrl.signal.aborted) setDry((d) => (d && d.loading && d.rate === rate ? null : d));
        else setDry({ rate, error: friendlyError(e) });
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
      if (dryCtrl.current === ctrl) dryCtrl.current = null;
    };
  }, [connected, full, fee.satVb, walletAddress, walletPubkey, secondState]);
  const exact = dry && !dry.loading && !dry.error && dry.rate === fee.satVb ? dry : null;
  const feeSats = flow.feeSats ?? exact?.feeSats ?? quote?.feeSats ?? null;
  const totalSats = flow.totalSats ?? exact?.totalSats ?? quote?.totalSats ?? null;
  // The listed UTXO's own BTC is input 0 and returns in the buyer's change:
  // the wallet pays the total minus it (the total stays the ceiling signed against).
  const carrierIn = Number.isInteger(order.carrier_sats) ? order.carrier_sats : 0;
  const netSats = totalSats != null ? totalSats - carrierIn : null;
  const slowNote = flow.phase === "idle" || flow.phase === "error" ? slowFillWarning(fee.satVb, fees?.data) : null;
  // A fill of this listing was broadcast from here: re-opening the sheet re-reads the listing, which is
  // then naturally no longer open — that is the fill's own story, not a failed verification.
  const settledView = TRACKED.has(flow.phase) || flow.phase === "replaced";
  // The market gate, from the token row and the order view (§7.4).
  const marketOpen = isMarketOpen(token) && order.market_open !== false && full?.market_open !== false;
  // Paused while the indexer's view may be stale (lagging, stalled, rebuilding, behind the network).
  const pauseText = indexerOk ? syncPauseText(sync, "buying") : null;
  const canConfirm = connected && indexerOk && !pauseText && marketOpen && !!full && allOk && secondOk && !busy && flow.phase !== "confirmed" && flow.phase !== "replaced";

  const confirm = async () => {
    if (!canConfirm) return;
    const { address: addr, pubkeyHex } = w;
    // The total on the button the user just pressed.
    const shownTotal = totalSats;
    // Sign reads the wallet's UTXOs itself: a dry run still running stops,
    // so the wallet and the indexer are asked once, not twice side by side.
    dryCtrl.current?.abort();
    setFlow({ phase: "building" });
    const signal = reads.begin();
    // Signed but never handed to a relay: its inputs are released at once.
    let signedPsbt = null;
    let relayed = false;
    try {
      const rate = requireRate(fee.satVb);
      // Right before the wallet opens (§7.2 step 3, "before signing"): the
      // book must STILL show the listing open — not filling, filled or
      // withdrawn — exactly as the sheet verified it...
      const live = await indexer.order(full.id);
      const changed = signTimeOrderProblem(live, full);
      if (changed) {
        verify();
        throw new Error(changed);
      }
      // ...and the indexer must STILL list the
      // outpoint with exactly { TICKER: amount }, amount > 0 — a carrier that
      // was emptied since the sheet opened is never signed.
      const carrier = sellerCarrierCheck(carrierRowOf(await indexer.tokenUtxos(full.seller), full.id), full);
      if (!carrier.ok) throw new Error(`Not signed: ${carrier.detail}.`);
      const built = await buildFill(full, addr, pubkeyHex, rate, signal, fillSendAmount(second.state, full.amount));
      reads.done(signal);
      // Never open the wallet for more than the sheet showed: a build that
      // costs more (the UTXO set changed since the dry run) stops here and
      // shows the new total, and the next press signs that.
      if (shownTotal == null || built.totalSats > shownTotal) {
        setDry({ rate, totalSats: built.totalSats, feeSats: built.feeSats, inputCount: built.inputs.length });
        setFlow({
          phase: "error",
          error:
            `This fill costs ${fmtSats(built.totalSats)} (${built.inputs.length} input${built.inputs.length === 1 ? "" : "s"} from your wallet)` +
            `${shownTotal == null ? "" : `, more than the ${fmtSats(shownTotal)} shown`} — the total below is now the real one; press Sign again to continue.`,
        });
        return;
      }
      setFlow({ phase: "signing", feeSats: built.feeSats, feeRateSatVb: built.feeRateSatVb, totalSats: built.totalSats, inputs: built.inputs, assetSafe: built.assetSafe, detail: `${built.inputIndexes.length} input${built.inputIndexes.length === 1 ? "" : "s"} from your wallet` });
      // Sign-time guard: a fill is a SEND of this order's ticker and the
      // amount it was built with — never sign a PSBT whose OP_RETURN says
      // anything else.
      expectPsbtPayload(built.psbtHex, { op: "SEND", ticker: full.ticker, amount: built.sendAmount });
      // Buyer signs ONLY inputs 1..n; input0 keeps the seller's 0x83 signature.
      const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address: addr, autoFinalized: true });
      signedPsbt = built.psbtHex;
      setFlow((f) => ({ ...f, phase: "broadcasting" }));
      // Broadcast-time guard, same shape as the sign-time one: the extracted
      // tx is a SEND of exactly this ticker / amount, nothing else.
      const raw = finalizeFill(signed, { op: "SEND", ticker: full.ticker, amount: built.sendAmount });
      let txid;
      try {
        relayed = true;
        txid = await wallet.broadcastRawTx(raw, { kind: "fill", ticker: full.ticker, address: addr });
      } catch (e) {
        if (wallet.isConflictError(e)) throw new Error(RACE_MESSAGE);
        throw e;
      }
      // vout1 = the token carrier, vout2 = the residual carrier; vout5, when present, is plain BTC.
      addPendingTokenOutpoints([{ txid, vout: 1 }, { txid, vout: 2 }], addr);
      setFlow((f) => ({ ...f, phase: "pending", txid }));
    } catch (e) {
      if (signedPsbt && !relayed) wallet.releaseInputs(signedPsbt);
      // The wallet changed (or the tab left) during the reads: back to idle, nothing to report.
      if (signal.aborted) {
        setFlow((f) => (f.phase === "building" ? IDLE : f));
        return;
      }
      setFlow((f) => ({ ...f, phase: "error", error: friendlyError(e) }));
    } finally {
      reads.done(signal);
    }
  };

  const secondLed = second.state === "agree" ? "ok" : second.state === "disagree" ? "err" : second.state === "checking" ? "busy" : second.state === "unreachable" || second.state === "unverified" ? "err" : "idle";
  const secondMark = second.state === "agree" ? "✓" : second.state === "disagree" ? "✗" : second.state === "unreachable" || second.state === "unverified" ? "!" : second.state === "skipped" ? "–" : "…";

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="sheet panel" role="dialog" aria-modal="true" aria-labelledby="buy-sheet-title" ref={sheetRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <Led state={verifyError || anyFail || second.state === "disagree" ? "err" : allOk && second.state === "agree" ? "ok" : "busy"} />
          <div className="panel-title" id="buy-sheet-title">
            <Identicon ticker={ticker} size={20} /> Buy {fmtInt(order.amount)} {ticker}
          </div>
          <div className="panel-right">
            {/* the visible text is the accessible name: "Hide" keeps the flow running, "Close" does not */}
            <button className="btn btn-ghost btn-sm sheet-close" type="button" onClick={onClose} title={busy ? "Hide the sheet — the fill keeps running; Show on the bar brings it back" : undefined}>
              {busy ? "Hide" : "Close"}
            </button>
          </div>
        </div>

        <p className="fineprint sheet-explain">
          The seller signed this listing; your transaction completes it; nobody holds funds in between. The tokens move to you and {fmtSats(order.price_sats)} moves to the seller in the same transaction, or nothing moves at all.
          The listed outpoint is re-checked against {SECOND_SOURCE_NAME} before you sign.
        </p>

        <ol className="checks" aria-label="Verification checklist (spec §7.2)">
          {checks.map((c) => (
            <li key={c.id} className={`check ${c.state}`}>
              <span className="check-mark" aria-hidden="true">
                {c.state === "ok" ? "✓" : c.state === "fail" ? "✗" : "…"}
              </span>
              <span className="check-body">
                <span className="check-label">
                  <span className="muted">{c.n}.</span> {c.label}
                </span>
                {c.detail && <span className="check-detail mono">{c.detail}</span>}
              </span>
            </li>
          ))}
          <li className={`check second ${second.state}`}>
            <span className="check-mark" aria-hidden="true">
              {secondMark}
            </span>
            <span className="check-body">
              <span className="check-label">
                <Led state={secondLed} /> Second source: {SECOND_SOURCE_NAME} shows the outpoint unspent, {fmtInt(order.carrier_sats)} sats, same script, and its OP_RETURN names this vout as a {order.ticker} carrier
                {second.state === "unverified" && <span className="status-tag s-filling amount-tag">amount not independently verified</span>}
              </span>
              {second.detail && <span className="check-detail mono">{second.detail}</span>}
              {second.reasons.length > 1 && (
                <ul className="check-reasons mono">
                  {second.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </span>
          </li>
        </ol>
        {/* once a fill of it is broadcast, the flow's own status says what became of the listing */}
        {verifyError && !settledView && <div className="err">{verifyError}</div>}
        {!marketOpen && <div className="err">Not signed: {marketPendingText(token || { ticker })}</div>}
        {pauseText && flow.phase === "idle" && <div className="err">{pauseText}</div>}
        {anyFail && !verifyError && !settledView && <div className="err">Verification failed — this listing will not be signed.</div>}
        {second.state === "disagree" && (
          <div className="err">
            {SECOND_SOURCE_NAME} does not describe the UTXO the indexer vouches for. This listing will not be signed — if the indexer is wrong about this outpoint, it may be wrong about the tokens on it.
          </div>
        )}
        {second.state === "unverified" && (
          <div className="notice notice-second notice-amount" role="alert">
            <div>
              <strong>Amount not independently verified.</strong> {SECOND_SOURCE_NAME} confirms this outpoint (unspent, {fmtInt(order.carrier_sats)} sats, the seller&apos;s script, a {order.ticker} carrier), but it cannot see token balances, so it cannot confirm that it carries{" "}
              {fmtInt(order.amount)} {order.ticker}. Only the indexer says so.
            </div>
            {second.notes.length > 0 && (
              <ul className="check-reasons mono">
                {second.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <div className="notice-row">
              <label className="ack">
                <input type="checkbox" checked={amountAck} onChange={(e) => setAmountAck(e.target.checked)} disabled={busy} />
                <span>
                  I understand that only the indexer vouches for the {fmtInt(order.amount)} {order.ticker} on this outpoint. If it is wrong, I pay {fmtSats(order.price_sats)} and receive fewer tokens. Proceed anyway.
                </span>
              </label>
            </div>
          </div>
        )}
        {second.state === "unreachable" && (
          <div className="notice notice-second">
            <div>
              <strong>Second source unreachable — only the indexer vouches for this listing.</strong> {second.detail}. You can retry, or proceed on the indexer&apos;s word alone.
            </div>
            <div className="notice-row">
              <label className="ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={busy} />
                <span>I understand only the indexer has confirmed this outpoint; proceed anyway.</span>
              </label>
              <button className="btn btn-sm" type="button" onClick={verify} disabled={busy}>
                Retry
              </button>
            </div>
          </div>
        )}

        <dl className="totals">
          <div>
            <dt>
              Ask ({fmtUnit(order.unit_price)} sats × {fmtInt(order.amount)})
            </dt>
            <dd className="mono">{fmtSats(order.price_sats)}</dd>
          </div>
          <div>
            <dt>Your token carrier (vout1)</dt>
            <dd className="mono">{fmtSats(quote?.tokenCarrierSats ?? 546)}</dd>
          </div>
          <div>
            <dt>Your residual carrier (vout2, always present)</dt>
            <dd className="mono">{fmtSats(quote?.residualCarrierSats ?? 546)}</dd>
          </div>
          <div>
            <dt>Protocol fee (vout3)</dt>
            <dd className="mono">{fmtSats(quote?.protocolFeeSats ?? 546)}</dd>
          </div>
          <div>
            <dt>
              Network fee{" "}
              {flow.feeSats != null
                ? `(@ ${flow.feeRateSatVb} sat/vB)`
                : exact
                  ? `(${exact.inputCount} input${exact.inputCount === 1 ? "" : "s"} @ ${exact.rate} sat/vB)`
                  : fee.satVb
                    ? `(est. @ ${fee.satVb} sat/vB${dry?.loading ? ", computing the exact total…" : ""})`
                    : "(no estimate)"}
            </dt>
            <dd className="mono">{feeSats != null ? fmtSats(feeSats) : "—"}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd className="mono">{totalSats != null ? fmtSats(totalSats) : "—"}</dd>
          </div>
          <div>
            <dt>Seller&apos;s UTXO value (input 0), back in your change</dt>
            <dd className="mono">−{fmtSats(carrierIn)}</dd>
          </div>
          <div className="total">
            <dt>Leaves your wallet</dt>
            <dd className="mono">
              {netSats != null ? (
                <>
                  {fmtSats(netSats)} <span className="muted">({fmtBtcShort(netSats)}{usd ? ` · ${fmtUsd(netSats, usd)}` : ""})</span>
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
        <div className="fineprint">
          The listed UTXO&apos;s own {fmtSats(carrierIn)} is an input of your transaction, so it comes back to you with your change. Of what leaves your wallet, 2 × 546 sats land on your own new token carriers (vout1 and vout2), so your wallet may show a smaller amount.
        </div>
        {sendAmount === 1 && order.amount > 1 && (
          <div className="fineprint">
            The amount on this listing is not independently confirmed, so this purchase sends 1 {order.ticker} to your token carrier (vout1) and the rest of the listed output to your
            residual carrier (vout2). You receive every token the output really holds.
          </div>
        )}
        {slowNote && <div className="notice">{slowNote}</div>}
        {dry?.error && flow.phase === "idle" && <div className="fineprint">Exact total not available yet ({dry.error}) — it is computed again when you press Sign, and nothing is signed above the total shown.</div>}
        {token?.last_trade && (
          <div className="fineprint">
            Last trade {fmtUnit(token.last_trade.unit_price)} sats
            {token.last_trade.unit_price > 0 ? ` · this listing is ${fmtChangePct(((order.unit_price - token.last_trade.unit_price) / token.last_trade.unit_price) * 100)} against it` : ""}.
            BTC change comes back to you as vout5 when it is at least 546 sats, otherwise it folds into the fee. Whichever spend of this listing confirms first counts: if another buyer&apos;s fill or the seller&apos;s withdrawal confirms first, yours cannot, and your BTC does not move.
          </div>
        )}

        {!connected ? (
          <ConnectPrompt action="buy" />
        ) : (
          <div className="sheet-actions">
            <button className="btn btn-primary btn-lg" type="button" onClick={confirm} disabled={!canConfirm}>
              {/* "Sign with", not "Sign in": a translated page would read it as a login. */}
              {flow.phase === "idle" || flow.phase === "error"
                ? `Sign with ${w.providerName || "your wallet"} · pay ${netSats != null ? fmtSats(netSats) : "—"}`
                : flow.phase === "confirmed"
                  ? "Filled"
                  : flow.phase === "replaced"
                    ? "Not filled"
                    : "Working…"}
            </button>
            {(flow.phase === "error" || flow.phase === "confirmed" || flow.phase === "replaced") && (
              <button className="btn" type="button" onClick={onReset}>
                {flow.phase === "confirmed" || flow.phase === "replaced" ? "Done" : "Reset"}
              </button>
            )}
          </div>
        )}

        {flow.phase === "replaced" && (
          <div className="status s-err" role="status" aria-live="polite">
            <div className="line">
              <span className="dot" aria-hidden="true" />
              <span>{flow.note}</span>
            </div>
          </div>
        )}
        <TxProgress
          flow={flow}
          status={status}
          labels={{
            building: "Building the fill — your inputs are filtered so no token-bearing UTXO is ever spent as fee.",
            signing: `Awaiting signature — ${w.providerName || "your wallet"} signs only your inputs; the seller's signature stays intact.`,
            broadcasting: "Finalizing the seller's input and broadcasting…",
            pending: flow.replacing ? flow.note : "Fill broadcast. Pending confirmation — checking every 15 s.",
            unseen: flow.replacing ? flow.note : undefined,
            confirmed: `Fill confirmed — ${fmtInt(order.amount)} ${ticker} move to your address; final after ${FINAL_DEPTH} confirmations.`,
            final: `Filled. ${fmtInt(order.amount)} ${ticker} are on your address.`,
          }}
        />
      </div>
    </div>
  );
}
