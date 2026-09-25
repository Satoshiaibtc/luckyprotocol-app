// unrendered since 2026-09-25 (trading removed from UI)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as unisat from "../lib/unisat.js";
import { usePoll } from "../hooks/usePoll.js";
import { useTxStatus } from "../hooks/useTxStatus.js";
import { friendlyError } from "../hooks/useWallet.js";
import { buildListingPsbt, LISTING_SIGHASH, MIN_PRICE_SATS } from "../lib/swap.js";
import { buildSendPsbt } from "../lib/psbt.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import { DUST_SATS } from "../lib/payloads.js";
import { fmtBtcShort, fmtInt, fmtSats, fmtUnit, shortTxid } from "../lib/format.js";
import TxProgress, { ConnectPrompt } from "./TxProgress.jsx";
import { OrdersTable } from "./Tables.jsx";

const POLL_MS = 15_000;
const IDLE = { phase: "idle" };
const outKey = (u) => `${u.txid}:${u.vout}`;

const RELIST_WARNING =
  "A signed listing is a bearer instrument: anyone who saved the earlier PSBT can still fill it at the old price. Re-listing replaces the order in the book but does NOT void that signature — only moving the tokens on-chain does.";

export default function SellPanel({ ticker, token, onSettled }) {
  const { wallet, address, pubkeyHex, fees, indexerOk, refreshAll } = useApp();
  const connected = wallet.status === "connected";

  const tokenUtxos = usePoll(address ? (s) => indexer.tokenUtxos(address, s) : null, POLL_MS, [address]);
  const btcUtxos = usePoll(address ? (s) => indexer.btcUtxos(address, s) : null, POLL_MS, [address]);
  const myOrders = usePoll(address ? (s) => indexer.ordersByAddress(address, s) : null, POLL_MS, [address]);

  const refreshMine = useCallback(() => {
    tokenUtxos.refresh();
    btcUtxos.refresh();
    myOrders.refresh();
  }, [tokenUtxos, btcUtxos, myOrders]);

  // Rows: this ticker's UTXOs joined with their BTC value + listing status.
  const rows = useMemo(() => {
    const sats = new Map((btcUtxos.data || []).map((u) => [outKey(u), u.sats]));
    const open = new Map((myOrders.data || []).filter((o) => o.status === "open").map((o) => [o.id, o]));
    return (tokenUtxos.data || [])
      .filter((u) => u.balances[ticker] > 0)
      .map((u) => {
        const k = outKey(u);
        const tickers = Object.keys(u.balances);
        return {
          key: k,
          txid: u.txid,
          vout: u.vout,
          amount: u.balances[ticker],
          balances: u.balances,
          multi: tickers.length > 1,
          sats: sats.get(k) ?? null,
          listing: open.get(k) || null,
        };
      })
      // 546-sat carriers first (they are the ones meant to be listed); fat
      // SEND change outputs sink to the bottom — listing one hands its BTC
      // surplus to the buyer (audit H-3), so they are tagged "split first".
      .sort((a, b) => (a.sats === DUST_SATS ? 0 : 1) - (b.sats === DUST_SATS ? 0 : 1) || b.amount - a.amount);
  }, [tokenUtxos.data, btcUtxos.data, myOrders.data, ticker]);

  const ordersHere = useMemo(
    () => (myOrders.data || []).filter((o) => o.ticker === ticker).sort((a, b) => (a.status === "open" ? -1 : 1) - (b.status === "open" ? -1 : 1) || b.updated_at - a.updated_at),
    [myOrders.data, ticker],
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
  // Seed the price form ONLY when the selection changes — `sel`/`token` are
  // re-derived on every 15 s poll and must not wipe what the user typed.
  const seedRef = useRef({ sel: null, token: null });
  seedRef.current = { sel, token };
  useEffect(() => {
    setListFlow(IDLE);
    const { sel: s, token: t } = seedRef.current;
    if (!s) return;
    const ref = t?.floor_unit_price ?? t?.last_trade?.unit_price ?? null;
    // Floor of the prefill: never below the carrier's own BTC value (H-3).
    const floorSats = Math.max(MIN_PRICE_SATS, Number.isInteger(s.sats) ? s.sats : 0);
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

  const onUnit = (v) => {
    setUnitStr(v);
    const n = Number(v);
    if (sel && Number.isFinite(n) && n > 0) setTotalStr(String(Math.round(n * sel.amount)));
  };
  const onTotal = (v) => {
    setTotalStr(v);
    const n = Number(v);
    if (sel && Number.isFinite(n) && n > 0) setUnitStr(fmtUnitInput(n / sel.amount));
  };
  const priceSats = Number(totalStr);
  // The listing must pay the seller at least what the carrier already holds
  // in BTC: a fill gives the buyer the whole UTXO and the seller only
  // output0, so anything below `sel.sats` is a gift to the buyer (H-3).
  const minPriceSats = Math.max(MIN_PRICE_SATS, sel && Number.isInteger(sel.sats) ? sel.sats : 0);
  const priceOk = Number.isInteger(priceSats) && priceSats >= minPriceSats;
  const fatCarrier = !!sel && Number.isInteger(sel.sats) && sel.sats > DUST_SATS;

  const signListing = async () => {
    if (!connected || !sel || !priceOk || sel.sats === null) return;
    setListFlow({ phase: "signing" });
    try {
      const built = buildListingPsbt({
        address,
        pubkeyHex,
        tokenUtxo: { txid: sel.txid, vout: sel.vout, sats: sel.sats },
        priceSats,
        amount: sel.amount,
      });
      // Seller signs input 0 only, SINGLE|ANYONECANPAY, and must NOT finalize.
      const signed = await unisat.signPsbt(built.psbtHex, built.inputIndexes, address, {
        autoFinalized: false,
        sighashTypes: [LISTING_SIGHASH],
      });
      setListFlow({ phase: "posting" });
      const view = await indexer.postOrder({ psbt: signed, ticker, amount: sel.amount, price_sats: priceSats });
      setListFlow({ phase: "listed", order: view });
      refreshMine();
      onSettled?.();
    } catch (e) {
      setListFlow({ phase: "error", error: friendlyError(e) });
    }
  };

  // ---- on-chain flows: split (SEND-to-self of part) / cancel (SEND-to-self of all) --------
  const [chain, setChain] = useState(IDLE); // { phase, kind: 'split'|'cancel', txid, feeSats, error }
  const [splitStr, setSplitStr] = useState("");
  useEffect(() => {
    setSplitStr("");
  }, [selKey]);
  const status = useTxStatus(chain.phase === "pending" || chain.phase === "confirmed" ? chain.txid : null, {
    onConfirmed: () => {
      setChain((c) => ({ ...c, phase: "confirmed" }));
      refreshMine();
      refreshAll();
      onSettled?.();
    },
  });
  const chainBusy = ["building", "signing", "broadcasting", "pending"].includes(chain.phase);

  const sendToSelf = async (utxo, amount, kind) => {
    if (!connected) return;
    setChain({ phase: "building", kind });
    try {
      const [feeInfo, utxoRes, tokenRows] = await Promise.all([
        fees.data ? Promise.resolve(fees.data) : indexer.fees(),
        unisat.getBitcoinUtxos(address),
        indexer.tokenUtxos(address),
      ]);
      // The carrier's exact sats come from the indexer's BTC view (UniSat's
      // asset-safe list may omit 546-sat dust); the sighash commits to it.
      const allSats = new Map((btcUtxos.data || []).map((u) => [outKey(u), u.sats]));
      const carrierSats = utxo.sats ?? allSats.get(outKey(utxo)) ?? null;
      const built = buildSendPsbt({
        address,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout }))),
        tokenUtxos: [{ txid: utxo.txid, vout: utxo.vout, ...(carrierSats ? { sats: carrierSats } : {}) }],
        feeRateSatVb: feeInfo.halfHourFee,
        ticker,
        amount,
        toAddress: address,
      });
      setChain({ phase: "signing", kind, feeSats: built.feeSats });
      const signed = await unisat.signPsbt(built.psbtHex, built.inputIndexes, address);
      setChain((c) => ({ ...c, phase: "broadcasting" }));
      const txid = await unisat.broadcastSignedPsbt(signed);
      addPendingTokenOutpoints([{ txid, vout: 0 }, { txid, vout: 3 }]);
      setChain((c) => ({ ...c, phase: "pending", txid }));
      refreshMine();
    } catch (e) {
      setChain((c) => ({ ...c, phase: "error", error: friendlyError(e) }));
    }
  };

  const splitAmt = Number(splitStr);
  const splitOk = sel && Number.isInteger(splitAmt) && splitAmt >= 1 && splitAmt < sel.amount;

  if (!connected) {
    return (
      <div className="action-body">
        <ConnectPrompt action={`list ${ticker}`} />
        <p className="fineprint">Listings are signed with SIGHASH_SINGLE|ANYONECANPAY: the tokens never leave your wallet until a buyer&apos;s fill pays you in full, on-chain.</p>
      </div>
    );
  }

  return (
    <div className="action-body">
      <div className="orders-head">
        <span className="muted">
          Your {ticker} UTXOs · {rows.length}
        </span>
        <button className="btn btn-ghost btn-sm" type="button" onClick={refreshMine} disabled={tokenUtxos.loading}>
          Refresh
        </button>
      </div>

      {tokenUtxos.error && !tokenUtxos.data ? (
        <div className="err">Could not load your UTXOs: {String(tokenUtxos.error.message)}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{tokenUtxos.loading ? "Loading…" : `No ${ticker} on this address yet. Mine some, or buy an ask.`}</div>
      ) : (
        <ul className="utxo-list" role="radiogroup" aria-label={`${ticker} UTXOs`}>
          {rows.map((r) => {
            const disabled = r.multi || chainBusy;
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
                    {r.multi ? (
                      <span className="status-tag s-cancelled" title={`Carries ${Object.keys(r.balances).join(" + ")} — a UTXO with more than one ticker cannot be listed (§7.1). Split it with a SEND first.`}>
                        multi-ticker
                      </span>
                    ) : r.listing ? (
                      <span className="status-tag s-open">listed @ {fmtUnit(r.listing.unit_price)}</span>
                    ) : r.sats !== null && r.sats > DUST_SATS ? (
                      <span className="status-tag s-cancelled" title={`This UTXO also holds ${fmtInt(r.sats)} sats of BTC that would go to the buyer — split the tokens onto a 546-sat carrier first.`}>
                        split first
                      </span>
                    ) : (
                      <span className="status-tag">listable</span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {sel && (
        <div className="sell-form">
          <div className="sell-form-head">
            <span className="strong">
              List {fmtInt(sel.amount)} {ticker}
            </span>
            <span className="muted">whole UTXO — the listing sells its entire balance</span>
          </div>
          <div className="price-grid">
            <label>
              <span className="muted">Sats per token</span>
              <input className="input mono" inputMode="decimal" value={unitStr} onChange={(e) => onUnit(e.target.value)} placeholder="0.00" disabled={listFlow.phase === "signing" || listFlow.phase === "posting"} />
            </label>
            <label>
              <span className="muted">Total sats</span>
              <input className="input mono" inputMode="numeric" value={totalStr} onChange={(e) => onTotal(e.target.value)} placeholder={String(MIN_PRICE_SATS)} disabled={listFlow.phase === "signing" || listFlow.phase === "posting"} />
            </label>
          </div>
          <div className="fee-row">
            <span>
              You receive <span className="v">{priceOk ? fmtBtcShort(priceSats) : "—"}</span>
            </span>
            <span className="muted">
              {token?.floor_unit_price ? `floor ${fmtUnit(token.floor_unit_price)}` : "no asks"}
              {token?.last_trade ? ` · last ${fmtUnit(token.last_trade.unit_price)}` : ""}
            </span>
          </div>
          {!priceOk && totalStr !== "" && <div className="err">Price must be a whole number of sats ≥ {fmtInt(minPriceSats)}.</div>}
          {fatCarrier && (
            <div className="err">
              This UTXO also carries {fmtInt(sel.sats)} sats of BTC, which go to the buyer together with the tokens — the minimum price is {fmtInt(sel.sats)} sats.
              To list the tokens only, split them onto a 546-sat carrier first (below) and list that.
            </div>
          )}
          {sel.sats === null && <div className="err">The BTC value of this UTXO is unknown — refresh and try again (the listing must commit the exact carrier value).</div>}
          {sel.listing && <div className="notice">Already listed at {fmtUnit(sel.listing.unit_price)} sats. {RELIST_WARNING}</div>}

          <div className="sheet-actions">
            <button className="btn btn-primary btn-lg" type="button" onClick={signListing} disabled={!priceOk || sel.sats === null || listFlow.phase === "signing" || listFlow.phase === "posting" || !indexerOk || chainBusy}>
              {listFlow.phase === "signing" ? "Awaiting signature…" : listFlow.phase === "posting" ? "Publishing…" : sel.listing ? "Sign new listing" : "Sign listing"}
            </button>
          </div>
          {listFlow.phase === "signing" && <div className="status s-busy"><div className="line"><span className="dot" /><span>UniSat: sign input 0 with SINGLE|ANYONECANPAY (0x83), not finalized.</span></div></div>}
          {listFlow.phase === "listed" && (
            <div className="status s-ok">
              <div className="line">
                <span className="dot" />
                <span>
                  Listed{listFlow.order?.replaced ? " (replaced your previous listing for this UTXO)" : ""}: {fmtInt(listFlow.order?.amount)} {ticker} for {fmtSats(listFlow.order?.price_sats)}.
                </span>
              </div>
              <div className="detail">Tokens stay on your address until a buyer&apos;s fill pays you. To withdraw, cancel on-chain below.</div>
            </div>
          )}
          {listFlow.phase === "error" && (
            <div className="status s-err">
              <div className="line">
                <span className="dot" />
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
              A listing always sells a whole UTXO. A split is a SEND to yourself: vout0 becomes a new {ticker} UTXO carrying the amount you enter,
              vout3 keeps the rest. After it confirms, list the new vout0.
            </p>
            <div className="price-grid">
              <label>
                <span className="muted">Amount to split off</span>
                <input className="input mono" inputMode="numeric" value={splitStr} onChange={(e) => setSplitStr(e.target.value)} placeholder={`1 – ${sel.amount - 1}`} disabled={chainBusy} />
              </label>
              <div className="price-grid-btn">
                <button className="btn" type="button" onClick={() => sendToSelf(sel, splitAmt, "split")} disabled={!splitOk || chainBusy || !indexerOk}>
                  Split {splitOk ? fmtInt(splitAmt) : ""} {ticker}
                </button>
              </div>
            </div>
            <div className="fineprint">Cost: {DUST_SATS} sats carrier + {DUST_SATS} sats protocol fee + network fee.</div>
          </details>
        </div>
      )}

      {chain.phase !== "idle" && (
        <TxProgress
          flow={chain}
          status={status}
          onReset={() => setChain(IDLE)}
          labels={{
            building: chain.kind === "cancel" ? "Building the cancel — a SEND of the listed UTXO to yourself." : "Building the split — a SEND to yourself.",
            pending: `${chain.kind === "cancel" ? "Cancel" : "Split"} broadcast. Pending confirmation — checking every 15 s.`,
            confirmed: chain.kind === "cancel" ? "Cancelled on-chain. The old signed listing can no longer be filled." : "Split confirmed. The new vout0 is listable above.",
          }}
        />
      )}

      <div className="my-listings">
        <div className="orders-head">
          <span className="muted">My {ticker} listings</span>
        </div>
        <OrdersTable q={ordersQ} onCancel={(o) => sendToSelf({ txid: o.id.split(":")[0], vout: Number(o.id.split(":")[1]) }, o.amount, "cancel")} cancelling={chainBusy} empty={`No ${ticker} listings from this address.`} />
        <p className="fineprint">
          <strong>Cancel on-chain</strong> moves the listed tokens to a fresh UTXO of yours (a SEND to yourself). {RELIST_WARNING}
        </p>
      </div>
    </div>
  );
}

function fmtUnitInput(v) {
  if (!Number.isFinite(v)) return "";
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(v >= 1 ? 2 : 4)));
}
