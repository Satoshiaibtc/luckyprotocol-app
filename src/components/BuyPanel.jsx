import { useCallback, useEffect, useRef, useState } from "react";
import { hex } from "@scure/base";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { useTxStatus } from "../hooks/useTxStatus.js";
import { friendlyError } from "../hooks/useWallet.js";
import { buildFillPsbt, finalizeFill, parseListing, verifyListing } from "../lib/swap.js";
import { expectPsbtPayload, minFeeInputSats } from "../lib/psbt.js";
import { isUsableFeeRate, missingFeeHint } from "../lib/feechoice.js";
import { fillQuote } from "../lib/market.js";
import { SECOND_SOURCE_NAME, checkSecondSource } from "../lib/secondSource.js";
import { mockCheckSecondSource } from "../lib/mock.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import { fmtBtcShort, fmtInt, fmtSats, fmtUnit, fmtUsd } from "../lib/format.js";
import TxProgress, { ConnectPrompt } from "./TxProgress.jsx";
import FeeSelector from "./FeeSelector.jsx";
import Identicon from "./Identicon.jsx";
import Led from "./hud/Led.jsx";

const IDLE = { phase: "idle" };
const BUSY = new Set(["building", "signing", "broadcasting", "pending"]);
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
 * (audit M-12), then signs and broadcasts.
 */
export default function BuyPanel({ ticker, token, order, onClear, onSettled, usd = null }) {
  const { wallet: w, address, fee, indexerOk } = useApp();
  // The sheet works on a SNAPSHOT of the ask it was opened for: the book
  // keeps polling behind it, and once the fill confirms the ask leaves the
  // book (and the selection) — the sheet must still show "Filled".
  const [sheetOrder, setSheetOrder] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [flow, setFlow] = useState(IDLE);
  const connected = w.status === "connected";
  const busy = BUSY.has(flow.phase);

  // A wallet change abandons the sheet's state.
  useEffect(() => {
    setFlow(IDLE);
    setSheetOpen(false);
    setSheetOrder(null);
  }, [address]);
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
                <span className="muted">{flow.phase === "confirmed" ? "Filled." : flow.phase === "error" ? flow.error : "In progress — checking every 15 s."}</span>
                <button className="btn btn-sm" type="button" onClick={() => setSheetOpen(true)}>
                  Show
                </button>
                {(flow.phase === "confirmed" || flow.phase === "error") && (
                  <button className="btn btn-ghost btn-sm" type="button" onClick={reset}>
                    Done
                  </button>
                )}
              </span>
            </>
          ) : order ? (
            <>
              <span className="label">Selected ask</span>
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
              <span className="muted">Select an ask above. A fill completes the seller&apos;s signed listing on-chain — nobody holds funds in between.</span>
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
              <dt>Ask</dt>
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
            <div className="total">
              <dt>Total</dt>
              <dd className="mono">
                {quote ? (
                  <>
                    {fmtSats(quote.totalSats)} <span className="muted">({fmtBtcShort(quote.totalSats)}{usd ? ` · ${fmtUsd(quote.totalSats, usd)}` : ""})</span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
          <button className="btn btn-primary btn-lg buybar-confirm" type="button" onClick={open} disabled={!order || !quote || !indexerOk || busy || (inFlight && flow.phase === "confirmed")}>
            {busy ? "Working…" : order ? `Confirm · buy ${fmtInt(order.amount)} ${ticker}` : "Select an ask"}
          </button>
          {order && !fee.satVb && <div className="err">{missingFeeHint(fee.choice, fee.satVb, "buy")}</div>}
          {order && !indexerOk && <div className="err">Indexer offline — fills are paused until it is reachable.</div>}
        </div>
        )}
      </div>

      {sheetOpen && sheetOrder && (
        <BuySheet order={sheetOrder} ticker={ticker} token={token} usd={usd} flow={flow} setFlow={setFlow} onClose={() => setSheetOpen(false)} onReset={reset} onSettled={onSettled} connected={connected} />
      )}
    </div>
  );
}

function requireRate(v) {
  if (!isUsableFeeRate(v)) throw new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.");
  return v;
}

const SECOND_IDLE = { state: "pending", detail: "", reasons: [] };

/**
 * The buy sheet: the five mandatory §7.2 checks (1, 2, 4, 5 from the PSBT
 * against the OrderView; 3 a live read), then the M-12 second-source
 * check of the listed outpoint against mempool.space, the plain-words
 * explanation, the totals, and the sign → broadcast → confirm flow.
 */
function BuySheet({ order, ticker, token, usd, flow, setFlow, onClose, onReset, onSettled, connected }) {
  const { wallet: w, fee, indexerOk, refreshAll, mock } = useApp();
  const [checks, setChecks] = useState(() => CHECK_ORDER.map((c) => ({ ...c, state: "pending", detail: "" })));
  const [second, setSecond] = useState(SECOND_IDLE);
  const [ack, setAck] = useState(false);
  const [full, setFull] = useState(null);
  const [verifyError, setVerifyError] = useState(null);
  const runRef = useRef(0);

  const status = useTxStatus(flow.phase === "pending" || flow.phase === "confirmed" ? flow.txid : null, {
    onConfirmed: () => {
      setFlow((f) => ({ ...f, phase: "confirmed" }));
      refreshAll();
      onSettled?.();
    },
  });

  const verify = useCallback(async () => {
    const run = ++runRef.current;
    setVerifyError(null);
    setFull(null);
    setAck(false);
    setSecond(SECOND_IDLE);
    setChecks(CHECK_ORDER.map((c) => ({ ...c, state: "pending", detail: "" })));
    const apply = (id, ok, detail) => setChecks((cs) => cs.map((c) => (c.id === id ? { ...c, state: ok ? "ok" : "fail", detail } : c)));
    const failAll = (detail) => {
      for (const c of CHECK_ORDER) apply(c.id, false, detail);
      setSecond({ state: "skipped", detail: "not consulted — the indexer checks failed first", reasons: [] });
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
      // Check 3: live reads.
      let liveOk = o.status === "open";
      let liveDetail = liveOk ? "order open" : o.status === "filling" ? "a fill of this listing is already in the mempool" : `order is ${o.status}`;
      if (liveOk) {
        try {
          const utxos = await indexer.tokenUtxos(o.seller);
          if (run !== runRef.current) return;
          const [txid, vout] = o.id.split(":");
          const row = utxos.find((u) => u.txid === txid && u.vout === Number(vout));
          const bal = row ? Object.entries(row.balances) : [];
          liveOk = !!row && bal.length === 1 && bal[0][0] === o.ticker && bal[0][1] === o.amount;
          liveDetail = !row
            ? "seller no longer holds this outpoint"
            : !liveOk
              ? `outpoint carries ${JSON.stringify(row.balances)}, order says { ${o.ticker}: ${o.amount} }`
              : `seller holds ${fmtInt(o.amount)} ${o.ticker} on ${txid.slice(0, 8)}…:${vout}`;
        } catch (e) {
          liveOk = false;
          liveDetail = `could not read seller UTXOs: ${friendlyError(e)}`;
        }
      }
      apply("live", liveOk, liveDetail);
      const indexerOkAll = v.ok && liveOk;
      setFull(indexerOkAll ? o : null);
      if (!indexerOkAll) {
        setSecond({ state: "skipped", detail: "not consulted — the indexer checks failed first", reasons: [] });
        return;
      }
      // M-12: a second, independent source must describe the same UTXO.
      const L = parseListing(o.psbt);
      const [txid, vout] = o.id.split(":");
      const listing = { txid, vout: Number(vout), carrierSats: o.carrier_sats, scriptHex: L.input0?.witnessUtxo?.script ? hex.encode(L.input0.witnessUtxo.script) : "" };
      setSecond({ state: "checking", detail: `asking ${SECOND_SOURCE_NAME}…`, reasons: [] });
      const r = mock ? await mockCheckSecondSource(listing) : await checkSecondSource(listing);
      if (run !== runRef.current) return;
      setSecond({ state: r.verdict, detail: r.detail, reasons: r.reasons });
    } catch (e) {
      if (run !== runRef.current) return;
      setVerifyError(friendlyError(e));
    }
  }, [order.id, mock]);

  useEffect(() => {
    verify();
    return () => {
      runRef.current += 1;
    };
  }, [verify]);

  const allOk = checks.every((c) => c.state === "ok");
  const anyFail = checks.some((c) => c.state === "fail");
  const secondOk = second.state === "agree" || (second.state === "unreachable" && ack);
  const quote = fillQuote({ order, address: w.address || order.seller, feeRateSatVb: fee.satVb });
  const feeSats = flow.feeSats ?? quote?.feeSats ?? null;
  const totalSats = flow.totalSats ?? quote?.totalSats ?? null;
  const busy = BUSY.has(flow.phase);
  const canConfirm = connected && indexerOk && !!full && allOk && secondOk && !busy && flow.phase !== "confirmed";

  const confirm = async () => {
    if (!canConfirm) return;
    const { address: addr, pubkeyHex } = w;
    setFlow({ phase: "building" });
    try {
      const rate = requireRate(fee.satVb);
      const [utxoRes, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(addr), indexer.tokenUtxos(addr)]);
      const built = buildFillPsbt({
        listingPsbtHex: full.psbt,
        order: full,
        address: addr,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), addr),
        feeRateSatVb: rate,
        minInputSats: minFeeInputSats(utxoRes.assetSafe), // M-8: an inscribed sat here would go to the seller
      });
      setFlow({ phase: "signing", feeSats: built.feeSats, feeRateSatVb: built.feeRateSatVb, totalSats: built.totalSats, inputs: built.inputs, assetSafe: utxoRes.assetSafe, detail: `${built.inputIndexes.length} input${built.inputIndexes.length === 1 ? "" : "s"} from your wallet` });
      // Sign-time guard (M-1): a fill is a SEND of exactly this order — never
      // sign a PSBT whose OP_RETURN says anything else.
      expectPsbtPayload(built.psbtHex, { op: "SEND", ticker: full.ticker, amount: full.amount });
      // Buyer signs ONLY inputs 1..n; input0 keeps the seller's 0x83 signature.
      const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address: addr, autoFinalized: true });
      setFlow((f) => ({ ...f, phase: "broadcasting" }));
      const raw = finalizeFill(signed);
      let txid;
      try {
        txid = await wallet.broadcastRawTx(raw);
      } catch (e) {
        if (wallet.isConflictError(e)) throw new Error(RACE_MESSAGE);
        throw e;
      }
      // vout1 = the token carrier, vout4 = the residual carrier; vout5, when present, is plain BTC.
      addPendingTokenOutpoints([{ txid, vout: 1 }, { txid, vout: 4 }], addr);
      setFlow((f) => ({ ...f, phase: "pending", txid }));
    } catch (e) {
      setFlow((f) => ({ ...f, phase: "error", error: friendlyError(e) }));
    }
  };

  const secondLed = second.state === "agree" ? "ok" : second.state === "disagree" ? "err" : second.state === "checking" ? "busy" : second.state === "unreachable" ? "err" : "idle";
  const secondMark = second.state === "agree" ? "✓" : second.state === "disagree" ? "✗" : second.state === "unreachable" ? "!" : second.state === "skipped" ? "–" : "…";

  return (
    <div className="sheet-backdrop" role="presentation" onClick={busy ? undefined : onClose}>
      <div className="sheet panel" role="dialog" aria-modal="true" aria-labelledby="buy-sheet-title" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <Led state={verifyError || anyFail || second.state === "disagree" ? "err" : allOk && second.state === "agree" ? "ok" : "busy"} />
          <div className="panel-title" id="buy-sheet-title">
            <Identicon ticker={ticker} size={20} /> Buy {fmtInt(order.amount)} {ticker}
          </div>
          <div className="panel-right">
            <button className="btn btn-ghost btn-sm" type="button" onClick={onClose} aria-label="Close">
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
                <Led state={secondLed} /> Second source: {SECOND_SOURCE_NAME} shows the outpoint unspent, {fmtInt(order.carrier_sats)} sats, same script
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
        {verifyError && <div className="err">{verifyError}</div>}
        {anyFail && !verifyError && <div className="err">Verification failed — this listing will not be signed.</div>}
        {second.state === "disagree" && (
          <div className="err">
            {SECOND_SOURCE_NAME} does not describe the UTXO the indexer vouches for. This listing will not be signed — if the indexer is wrong about this outpoint, it may be wrong about the tokens on it.
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
            <dt>Protocol fee (vout2)</dt>
            <dd className="mono">{fmtSats(quote?.protocolFeeSats ?? 546)}</dd>
          </div>
          <div>
            <dt>Your residual carrier (vout4, always present)</dt>
            <dd className="mono">{fmtSats(quote?.residualCarrierSats ?? 546)}</dd>
          </div>
          <div>
            <dt>Network fee {flow.feeSats == null ? (fee.satVb ? `(est. @ ${fee.satVb} sat/vB)` : "(no estimate)") : `(@ ${flow.feeRateSatVb} sat/vB)`}</dt>
            <dd className="mono">{feeSats != null ? fmtSats(feeSats) : "—"}</dd>
          </div>
          <div className="total">
            <dt>Total</dt>
            <dd className="mono">
              {totalSats != null ? (
                <>
                  {fmtSats(totalSats)} <span className="muted">({fmtBtcShort(totalSats)}{usd ? ` · ${fmtUsd(totalSats, usd)}` : ""})</span>
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
        {token?.last_trade && (
          <div className="fineprint">
            Last trade {fmtUnit(token.last_trade.unit_price)} sats · this ask is {(((order.unit_price - token.last_trade.unit_price) / token.last_trade.unit_price) * 100).toFixed(1)}% {order.unit_price >= token.last_trade.unit_price ? "above" : "below"} it.
            BTC change comes back to you as vout5 when it is at least 546 sats, otherwise it folds into the fee. If another buyer fills first, the network rejects your transaction and your funds stay where they were.
          </div>
        )}

        {!connected ? (
          <ConnectPrompt action="buy" />
        ) : (
          <div className="sheet-actions">
            <button className="btn btn-primary btn-lg" type="button" onClick={confirm} disabled={!canConfirm}>
              {flow.phase === "idle" || flow.phase === "error" ? `Sign in ${w.providerName || "your wallet"} · ${totalSats != null ? fmtSats(totalSats) : ""}` : flow.phase === "confirmed" ? "Filled" : "Working…"}
            </button>
            {(flow.phase === "error" || flow.phase === "confirmed") && (
              <button className="btn" type="button" onClick={onReset}>
                {flow.phase === "confirmed" ? "Done" : "Reset"}
              </button>
            )}
          </div>
        )}

        <TxProgress
          flow={flow}
          status={status}
          labels={{
            building: "Building the fill — your inputs are filtered so no token-bearing UTXO is ever spent as fee.",
            signing: `Awaiting signature — ${w.providerName || "your wallet"} signs only your inputs; the seller's signature stays intact.`,
            broadcasting: "Finalizing the seller's input and broadcasting…",
            pending: "Fill broadcast. Pending confirmation — checking every 15 s.",
            confirmed: `Filled. ${fmtInt(order.amount)} ${ticker} are now on your address.`,
          }}
        />
      </div>
    </div>
  );
}
