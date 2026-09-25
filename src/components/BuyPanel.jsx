import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as unisat from "../lib/unisat.js";
import { usePoll } from "../hooks/usePoll.js";
import { useTxStatus } from "../hooks/useTxStatus.js";
import { friendlyError } from "../hooks/useWallet.js";
import { buildFillPsbt, finalizeFill, verifyListing, estimateFillCost } from "../lib/swap.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import { DUST_SATS, SEND_PROTOCOL_FEE_SATS } from "../lib/payloads.js";
import { fmtBtcShort, fmtInt, fmtSats, fmtUnit, shortAddr } from "../lib/format.js";
import TxProgress, { ConnectPrompt } from "./TxProgress.jsx";
import Identicon from "./Identicon.jsx";

const POLL_MS = 15_000;
const IDLE = { phase: "idle" };
const RACE_MESSAGE = "This listing was just filled or cancelled by someone else.";

const CHECK_ORDER = [
  { id: "shape", n: 1, label: "Listing has exactly 1 input and 1 output" },
  { id: "signature", n: 2, label: "Seller signed input 0 with SINGLE|ANYONECANPAY (0x83)" },
  { id: "live", n: 3, label: "Order is still open and the seller still holds the UTXO" },
  { id: "output", n: 4, label: "Output 0 pays exactly price_sats back to the seller" },
  { id: "carrier", n: 5, label: "witnessUtxo value matches the indexer's carrier_sats" },
];

export default function BuyPanel({ ticker, token, onSettled }) {
  const { wallet, address, fees, indexerOk, refreshAll } = useApp();
  const orders = usePoll((s) => indexer.orders({ ticker, status: "open", limit: 50 }, s), POLL_MS, [ticker]);
  const [sel, setSel] = useState(null); // OrderView being bought
  const [flow, setFlow] = useState(IDLE);
  const [sheetOpen, setSheetOpen] = useState(false);

  // A wallet change abandons an in-flight fill's UI state.
  useEffect(() => {
    setFlow(IDLE);
    setSel(null);
    setSheetOpen(false);
  }, [address]);

  const settled = useCallback(() => {
    orders.refresh();
    onSettled?.();
    refreshAll();
  }, [orders, onSettled, refreshAll]);

  const status = useTxStatus(flow.phase === "pending" || flow.phase === "confirmed" ? flow.txid : null, {
    onConfirmed: () => {
      setFlow((f) => ({ ...f, phase: "confirmed" }));
      settled();
    },
  });

  const open = (o) => {
    setSel(o);
    setFlow(IDLE);
    setSheetOpen(true);
  };
  const close = () => setSheetOpen(false);
  const reset = () => {
    setFlow(IDLE);
    setSel(null);
    setSheetOpen(false);
  };

  const rows = orders.data?.items || [];
  const floor = rows.length ? rows[0].unit_price : null;

  return (
    <div className="action-body">
      <div className="orders-head">
        <span className="muted">
          {rows.length} open ask{rows.length === 1 ? "" : "s"}
          {floor !== null ? <> · floor <span className="mono strong">{fmtUnit(floor)}</span> sats</> : null}
        </span>
        <button className="btn btn-ghost btn-sm" type="button" onClick={orders.refresh} disabled={orders.loading}>
          Refresh
        </button>
      </div>

      {!sheetOpen && flow.phase !== "idle" && (
        <TxProgress
          flow={flow}
          status={status}
          onReset={reset}
          labels={{ pending: "Fill broadcast. Pending confirmation — checking every 15 s.", confirmed: `Filled. ${fmtInt(sel?.amount)} ${ticker} are on your address.` }}
        />
      )}

      <div className="table cols-asks" role="table" aria-label="Open asks">
        <div className="tr th" role="row">
          <span className="right">Unit</span>
          <span className="right">Amount</span>
          <span className="right">Total</span>
          <span>Seller</span>
          <span className="right" />
        </div>
        {orders.error && rows.length === 0 ? (
          <div className="err">Could not load asks: {String(orders.error.message)}</div>
        ) : rows.length === 0 ? (
          <div className="empty">{orders.loading ? "Loading asks…" : `No open asks for ${ticker}. Holders can list on the Sell tab.`}</div>
        ) : (
          rows.map((o) => {
            const mine = address && o.seller === address;
            return (
              <div className={`tr${mine ? " me" : ""}`} key={o.id} role="row">
                <span className="num right strong">{fmtUnit(o.unit_price)}</span>
                <span className="num right">{fmtInt(o.amount)}</span>
                <span className="num right">{fmtBtcShort(o.price_sats)}</span>
                <span className="mono" title={o.seller}>
                  {mine ? "you" : shortAddr(o.seller, 4, 4)}
                </span>
                <span className="right">
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => open(o)} disabled={mine || !indexerOk || (flow.phase !== "idle" && flow.phase !== "confirmed" && flow.phase !== "error")} title={mine ? "This is your own listing" : undefined}>
                    Buy
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>

      <p className="fineprint">
        A fill completes the seller&apos;s signed listing into a SEND. You pay the ask + {DUST_SATS} sats (your token slot) +{" "}
        {SEND_PROTOCOL_FEE_SATS} sats protocol fee + network fee; your BTC change comes back as vout4 (≥ {DUST_SATS} sats, required).
        If another buyer fills first, the network rejects yours and your funds stay exactly where they were.
      </p>

      {sheetOpen && sel && (
        <BuySheet
          order={sel}
          ticker={ticker}
          token={token}
          wallet={wallet}
          fees={fees}
          flow={flow}
          setFlow={setFlow}
          status={status}
          onClose={close}
          onReset={reset}
        />
      )}
    </div>
  );
}

function BuySheet({ order, ticker, token, wallet, fees, flow, setFlow, status, onClose, onReset }) {
  const [checks, setChecks] = useState(() => CHECK_ORDER.map((c) => ({ ...c, state: "pending", detail: "" })));
  const [full, setFull] = useState(null);
  const [verifyError, setVerifyError] = useState(null);
  const runRef = useRef(0);

  const connected = wallet.status === "connected";
  const feeRate = fees.data?.halfHourFee ?? 8;

  // Run the §7.2 checks whenever the sheet opens for an order.
  const verify = useCallback(async () => {
    const run = ++runRef.current;
    setVerifyError(null);
    setFull(null);
    setChecks(CHECK_ORDER.map((c) => ({ ...c, state: "pending", detail: "" })));
    const apply = (id, ok, detail) => setChecks((cs) => cs.map((c) => (c.id === id ? { ...c, state: ok ? "ok" : "fail", detail } : c)));
    try {
      const o = await indexer.order(order.id);
      if (run !== runRef.current) return;
      if (!o) {
        for (const c of CHECK_ORDER) apply(c.id, false, "listing not found");
        setVerifyError("This listing is no longer on the order book.");
        return;
      }
      if (!o.psbt) {
        for (const c of CHECK_ORDER) apply(c.id, false, "indexer returned no PSBT");
        setVerifyError("The indexer returned the order without its PSBT.");
        return;
      }
      const v = verifyListing({ psbtHex: o.psbt, order: o });
      for (const c of v.checks) apply(c.id, c.ok, c.detail);
      // Check 3: live reads.
      let liveOk = o.status === "open";
      let liveDetail = liveOk ? "order open" : `order is ${o.status}`;
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
      setFull(o);
    } catch (e) {
      if (run !== runRef.current) return;
      setVerifyError(friendlyError(e));
    }
  }, [order.id]);

  useEffect(() => {
    verify();
    return () => {
      runRef.current += 1;
    };
  }, [verify]);

  const allOk = checks.every((c) => c.state === "ok");
  const anyFail = checks.some((c) => c.state === "fail");
  const est = (() => {
    try {
      return estimateFillCost({ order, address: wallet.address || order.seller, feeRateSatVb: feeRate });
    } catch {
      return null;
    }
  })();
  const feeSats = flow.feeSats ?? est?.feeSats ?? null;
  const totalSats = flow.totalSats ?? est?.totalSats ?? null;
  const busy = ["building", "signing", "broadcasting", "pending"].includes(flow.phase);

  const confirm = async () => {
    if (!connected || !full || !allOk) return;
    const { address: addr, pubkeyHex } = wallet;
    setFlow({ phase: "building" });
    try {
      const [feeInfo, utxoRes, tokenRows] = await Promise.all([
        fees.data ? Promise.resolve(fees.data) : indexer.fees(),
        unisat.getBitcoinUtxos(addr),
        indexer.tokenUtxos(addr),
      ]);
      const built = buildFillPsbt({
        listingPsbtHex: full.psbt,
        order: full,
        address: addr,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout }))),
        feeRateSatVb: feeInfo.halfHourFee,
      });
      setFlow({ phase: "signing", feeSats: built.feeSats, totalSats: built.totalSats, detail: `${built.inputIndexes.length} input${built.inputIndexes.length === 1 ? "" : "s"} from your wallet` });
      // Buyer signs ONLY inputs 1..n; input0 keeps the seller's 0x83 signature.
      const signed = await unisat.signPsbt(built.psbtHex, built.inputIndexes, addr, { autoFinalized: true });
      setFlow((f) => ({ ...f, phase: "broadcasting" }));
      const raw = finalizeFill(signed);
      let txid;
      try {
        txid = await unisat.broadcastRawTx(raw);
      } catch (e) {
        if (unisat.isConflictError(e)) throw new Error(RACE_MESSAGE);
        throw e;
      }
      addPendingTokenOutpoints([{ txid, vout: 1 }]);
      setFlow((f) => ({ ...f, phase: "pending", txid }));
    } catch (e) {
      setFlow((f) => ({ ...f, phase: "error", error: friendlyError(e) }));
    }
  };

  return (
    <div className="sheet-backdrop" role="presentation" onClick={busy ? undefined : onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="buy-sheet-title" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-title" id="buy-sheet-title">
            <Identicon ticker={ticker} size={28} />
            <span>
              Buy {fmtInt(order.amount)} {ticker}
            </span>
          </div>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose} aria-label="Close">
            {busy ? "Hide" : "Close"}
          </button>
        </div>

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
        </ol>
        {verifyError && <div className="err">{verifyError}</div>}
        {anyFail && !verifyError && <div className="err">Verification failed — this listing will not be signed.</div>}

        <dl className="totals">
          <div>
            <dt>Ask ({fmtUnit(order.unit_price)} sats × {fmtInt(order.amount)})</dt>
            <dd className="mono">{fmtSats(order.price_sats)}</dd>
          </div>
          <div>
            <dt>Your token slot</dt>
            <dd className="mono">{fmtSats(DUST_SATS)}</dd>
          </div>
          <div>
            <dt>Protocol fee</dt>
            <dd className="mono">{fmtSats(SEND_PROTOCOL_FEE_SATS)}</dd>
          </div>
          <div>
            <dt>Network fee {flow.feeSats == null ? `(est. @ ${feeRate} sat/vB)` : ""}</dt>
            <dd className="mono">{feeSats != null ? fmtSats(feeSats) : "—"}</dd>
          </div>
          <div className="total">
            <dt>Total</dt>
            <dd className="mono">
              {totalSats != null ? (
                <>
                  {fmtSats(totalSats)} <span className="muted">({fmtBtcShort(totalSats)})</span>
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
        {token?.last_trade && (
          <div className="fineprint">
            Last trade {fmtUnit(token.last_trade.unit_price)} sats · this ask is{" "}
            {(((order.unit_price - token.last_trade.unit_price) / token.last_trade.unit_price) * 100).toFixed(1)}% {order.unit_price >= token.last_trade.unit_price ? "above" : "below"} it.
          </div>
        )}

        {!connected ? (
          <ConnectPrompt action="buy" />
        ) : (
          <div className="sheet-actions">
            <button className="btn btn-primary btn-lg" type="button" onClick={confirm} disabled={!allOk || !full || busy || flow.phase === "confirmed"}>
              {flow.phase === "idle" || flow.phase === "error" ? "Confirm & sign in UniSat" : flow.phase === "confirmed" ? "Filled" : "Working…"}
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
            signing: "Awaiting signature — UniSat signs only your inputs; the seller's signature stays intact.",
            broadcasting: "Finalizing the seller's input and broadcasting…",
            pending: "Fill broadcast. Pending confirmation — checking every 15 s.",
            confirmed: `Filled. ${fmtInt(order.amount)} ${ticker} are now on your address.`,
          }}
        />
      </div>
    </div>
  );
}
