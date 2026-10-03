import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { useSendToSelf } from "../hooks/useSendToSelf.js";
import { useOutputValues } from "../hooks/useOutputValues.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import Identicon from "../components/Identicon.jsx";
import TransferEmpty from "../components/TransferEmpty.jsx";
import FeeSelector from "../components/FeeSelector.jsx";
import TxProgress, { ConnectPrompt } from "../components/TxProgress.jsx";
import SpeedUpSend from "../components/SpeedUpSend.jsx";
import Panel from "../components/hud/Panel.jsx";
import Led from "../components/hud/Led.jsx";
import { SEND_OP_RETURN_VOUT, estimateSendFeeSats } from "../lib/psbt.js";
import { buildSendPayload, DUST_SATS, SEND_PROTOCOL_FEE_SATS, SEND_TO_VOUT } from "../lib/payloads.js";
import { missingFeeHint } from "../lib/feechoice.js";
import { pendingSpentOutpoints, refreshTxRecords, txRecords } from "../lib/txrecords.js";
import { syncPauseText } from "../lib/sync.js";
import { indexerErrorText, indexerErrorTitle } from "../lib/errors.js";
import {
  ORDERS_INCOMPLETE_TEXT,
  TRANSFER_NO_CHANGE,
  TRANSFER_SPEEDUP_ELSEWHERE,
  carrierNote,
  carriersToSpend,
  followConfirmedTransfer,
  parseSendAmount,
  pendingSendsOf,
  pendingTransferText,
  pickedAmount,
  recipientState,
  sendAmountError,
  sendCarrierRows,
  sendFormHint,
  sendReviewModel,
  sendVersions,
  transferRootOf,
  transferSpeedUpNote,
  transferSpeedUpState,
} from "../lib/send.js";
import { readSellerOrders } from "../lib/listingRules.js";
import { fmtInt, fmtSats, shortAddr, shortTxid, txUrl } from "../lib/format.js";

const POLL_MS = 15_000;

/**
 * Transfer any LUCKY-20 token: to another address, or to
 * yourself — which is how a carrier is split, including a carrier that
 * holds several tickers. One SEND in the
 * §2.3 reference layout: vout0 546 sats → protocol fee, vout1 546 →
 * recipient with the amount, vout2 546 → you (the rest of this ticker and
 * every other ticker on the carriers spent), vout3 OP_RETURN, vout4 BTC
 * change. Form → confirm screen → sign → pending → confirmed.
 *
 * Route: #/send/<TICKER> or #/transfer/<TICKER>[?utxo=<txid:vout>&to=self]
 * — the portfolio's "Split" link pre-selects one carrier and your own
 * address. `embedded`: the token page's Transfer tab (#/t/<TICKER>?tab=transfer,
 * the same query), without the page shell and header; `onSettled` is
 * called when a transfer settles.
 */
export default function SendPage({ ticker, params = {}, embedded = false, onSettled = null }) {
  const { wallet: w, address, fee, fees, indexerOk, sync } = useApp();
  const connected = w.status === "connected";
  const Shell = embedded ? "div" : "main";
  const shellClass = embedded ? "send-page send-embedded" : "page send-page";

  const tokenUtxos = usePoll(address ? (s) => indexer.tokenUtxos(address, s) : null, POLL_MS, [address]);
  // Each carrier's BTC value (a SEND signs it exactly), read once per outpoint.
  const tickerCarriers = useMemo(() => (tokenUtxos.data || []).filter((u) => Number(u.balances?.[ticker]) > 0), [tokenUtxos.data, ticker]);
  const values = useOutputValues(tickerCarriers, POLL_MS);
  // Every page of this address's listings (newest first, 200 a page): an
  // old open listing behind many closed ones must still mark its carrier.
  const orders = usePoll(
    address ? (s) => readSellerOrders((offset, limit) => indexer.ordersByAddress(address, { limit, offset }, s), { pageSize: indexer.ADDR_LIST_MAX_LIMIT }) : null,
    POLL_MS,
    [address],
  );
  // Not every listing was read: no carrier is chosen automatically.
  const ordersIncomplete = !!orders.data && orders.data.complete === false;
  const transferFlow = useSendToSelf({
    onSettled: () => {
      tokenUtxos.refresh();
      values.refresh();
      orders.refresh();
      onSettled?.();
    },
  });
  const { chain, status, run, reset, busy, follow } = transferFlow;

  // This browser's own unconfirmed transfers are re-checked on the page's poll:
  // a confirmed or dropped one leaves the store, so the
  // "unconfirmed transfers" list clears and its carriers are free again.
  const [recTick, setRecTick] = useState(0);
  // A listed transfer that confirmed (followed by its row): re-read everything it changed.
  const refreshCarriers = tokenUtxos.refresh;
  const refreshValues = values.refresh;
  const refreshOrders = orders.refresh;
  const rowSettled = useCallback(() => {
    refreshCarriers();
    refreshValues();
    refreshOrders();
    setRecTick((t) => t + 1);
    onSettled?.();
  }, [refreshCarriers, refreshValues, refreshOrders, onSettled]);
  useEffect(() => {
    if (!address) return undefined;
    let alive = true;
    const check = async () => {
      if (!txRecords(address).some((r) => !r.confirmed && r.kind === "send")) return;
      try {
        await refreshTxRecords(address, (txid) => indexer.txStatus(txid));
      } catch {
        return;
      }
      if (alive) setRecTick((t) => t + 1);
    };
    check();
    const id = setInterval(check, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [address]);
  // This browser's own unconfirmed broadcasts: their inputs cannot be spent again.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read the store on each poll / flow step
  const records = useMemo(() => (address ? txRecords(address) : []), [address, tokenUtxos.data, chain.phase, chain.txid, recTick]);
  const rows = useMemo(
    () => sendCarrierRows({ tokenUtxos: tokenUtxos.data, values: values.data, orders: orders.data?.items, expired: orders.data?.expired, pendingSpent: pendingSpentOutpoints(records), ticker }),
    [tokenUtxos.data, values.data, orders.data, records, ticker],
  );
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const pendingSends = useMemo(() => pendingSendsOf(records, ticker), [records, ticker]);
  // The versions of the transfer the form follows while it waits: its rows point at the form's Speed up.
  const waiting = chain.phase === "pending" || chain.phase === "unseen";
  const followed = useMemo(() => (waiting ? sendVersions(chain) : []), [waiting, chain]);
  // The form's transfer was sped up in another tab: the form follows the faster
  // version — or the version that confirmed, when one did before this page read it.
  useEffect(() => {
    if (!waiting) return;
    const settled = records.find((r) => followConfirmedTransfer(chain, r, address) !== chain);
    const newer = settled ?? pendingSends.find((r) => r.txid !== chain.txid && (r.replaces || []).includes(chain.txid));
    if (newer) follow(newer);
  }, [waiting, records, pendingSends, chain, address, follow]);

  // ---- form state -----------------------------------------------------------------------------
  const [toText, setToText] = useState(params.to === "self" && address ? address : "");
  const [amountText, setAmountText] = useState("");
  const [mode, setMode] = useState(params.utxo ? "manual" : "auto"); // auto: carriers follow the amount
  const [manual, setManual] = useState(() => (params.utxo ? [String(params.utxo).toLowerCase()] : []));
  const [step, setStep] = useState("form"); // form | review
  // What was signed, frozen at the click: the review shows THIS
  // while the send is in flight, not a model rebuilt from the live rows.
  const [sent, setSent] = useState(null);
  // The confirm screen sits under the form on a phone: bring it into view when it opens.
  const reviewRef = useRef(null);
  useEffect(() => {
    if (step === "review") reviewRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [step]);
  // ?utxo=…&to=self (the portfolio's Split link): once the rows load, the amount is that carrier's whole balance.
  const [seeded, setSeeded] = useState(!params.utxo);
  useEffect(() => {
    if (seeded || !tokenUtxos.data) return;
    const r = rows.find((x) => x.key === String(params.utxo).toLowerCase());
    if (r) setAmountText(String(r.amount));
    setSeeded(true);
  }, [seeded, rows, tokenUtxos.data, params.utxo]);
  useEffect(() => {
    if (params.to === "self" && address && !toText) setToText(address);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fills the field once the wallet is known
  }, [address]);

  const rcpt = recipientState(toText, address);
  const amount = parseSendAmount(amountText);
  const freeTotal = rows.filter((r) => !r.blocked && Number.isInteger(r.sats)).reduce((s, r) => s + r.amount, 0);
  const liveManual = carriersToSpend({ mode: "manual", rows, manual });
  const keys = carriersToSpend({ mode, rows, amount, manual, ordersComplete: !ordersIncomplete });
  const max = mode === "auto" ? freeTotal : pickedAmount(rows, liveManual);
  const amountErr = sendAmountError(amountText, max, ticker);
  const picked = rows.filter((r) => keys.includes(r.key));
  // A SEND signs each input's exact BTC value: a carrier without one cannot be sent yet.
  const unknownPicked = picked.some((r) => !Number.isInteger(r.sats));
  const lagText = indexerOk ? syncPauseText(sync, "transferring") : null;

  const est = useMemo(() => {
    if (!address || !amount) return null;
    try {
      return estimateSendFeeSats({ address, toAddress: rcpt.state === "ok" ? rcpt.address : address, ticker, amount, feeRateSatVb: fee.satVb || 1, carrierCount: Math.max(1, keys.length) });
    } catch {
      return null;
    }
  }, [address, rcpt.state, rcpt.address, ticker, amount, fee.satVb, keys.length]);
  // The OP_RETURN the confirm screen shows; an amount the payload grammar refuses (> 21,000,000) shows none.
  let payloadText = "";
  try {
    if (amount) payloadText = new TextDecoder().decode(buildSendPayload({ ticker, amount }));
  } catch {
    payloadText = "";
  }

  const formOk = connected && indexerOk && !lagText && rcpt.state === "ok" && !rcpt.feeAddress && !!amount && !amountErr && keys.length > 0 && pickedAmount(rows, keys) >= amount && !unknownPicked && !!fee.satVb;
  const whyNot = sendFormHint({
    connected,
    indexerOk,
    lagText,
    rcptState: rcpt.state,
    amount,
    amountErr,
    keysCount: keys.length,
    pickedTotal: pickedAmount(rows, keys),
    mode,
    freeTotal,
    ticker,
    feeHint: !fee.satVb ? missingFeeHint(fee.choice, fee.satVb, "transfer", { awaitingAck: !!fee.highFee?.pending, reading: fee.reading }) : null,
    unknownValue: unknownPicked,
    ordersIncomplete,
  });

  const toggle = (k) => {
    setMode("manual");
    setManual((m) => (m.includes(k) ? m.filter((x) => x !== k) : [...m, k]));
  };
  const useAuto = () => {
    setMode("auto");
    setManual([]);
  };
  const splitOff = (r) => {
    setMode("manual");
    setManual([r.key]);
    setAmountText(String(r.amount));
    if (address) setToText(address);
    setStep("form");
  };
  const sign = () => {
    if (!formOk || busy) return;
    setSent(sendReviewModel({ rows, keys, ticker, amount, toAddress: rcpt.address, self: address, payloadText, feeRateSatVb: fee.satVb }));
    run({ kind: "send", ticker, amount, toAddress: rcpt.address, utxos: picked.map((r) => ({ txid: r.txid, vout: r.vout, ...(Number.isInteger(r.sats) ? { sats: r.sats } : {}) })) });
  };
  const done = () => {
    reset();
    setSent(null);
    setStep("form");
    setAmountText("");
    if (mode === "manual") setManual([]);
  };

  if (!connected) {
    return (
      <Shell className={shellClass}>
        <div className="empty-state">
          {!embedded && <Identicon ticker={ticker} size={48} />}
          {!embedded && <h2>Transfer {ticker}</h2>}
          <p className="muted">Transfer tokens to any Bitcoin address, or to yourself to split a carrier.</p>
          <ConnectPrompt action={`transfer ${ticker}`} />
        </div>
      </Shell>
    );
  }

  if (tokenUtxos.data && rows.length === 0 && pendingSends.length === 0 && chain.phase === "idle") {
    return (
      <Shell className={shellClass}>
        <TransferEmpty ticker={ticker} embedded={embedded} />
      </Shell>
    );
  }

  const inFlight = chain.phase !== "idle";
  const toSelf = rcpt.state === "ok" && rcpt.self;
  // The review: the live form until Sign, then what was signed.
  const review = inFlight && sent ? sent : sendReviewModel({ rows, keys, ticker, amount: amount || 0, toAddress: rcpt.address, self: address, payloadText, feeRateSatVb: fee.satVb });
  const reviewSelf = review.toSelf;
  // vout1's 546 sats leave with the tokens — unless vout1 pays yourself (a split).
  const carrierOut = toSelf ? 0 : DUST_SATS;
  const btcOut = carrierOut + SEND_PROTOCOL_FEE_SATS + (est?.feeSats ?? 0);

  return (
    <Shell className={shellClass}>
      {!embedded && (
        <header className="token-head">
          <div className="token-head-main">
            <Identicon ticker={ticker} size={40} />
            <div>
              <h1 className="ticker">Transfer {ticker}</h1>
              <div className="meta">
                <span className="mono">
                  {tokenUtxos.data ? `${fmtInt(total)} ${ticker} on ${fmtInt(rows.length)} carrier${rows.length === 1 ? "" : "s"}` : "Loading your carriers…"}
                </span>
                <a href="#/me">← Portfolio</a>
                <a href={tokenHref(ticker)}>{ticker} page</a>
              </div>
            </div>
          </div>
        </header>
      )}

      <div className="send-grid">
        <Panel
          title="Recipient and amount"
          led={rcpt.state === "invalid" || amountErr ? "err" : formOk ? "ok" : "idle"}
          right={embedded ? <span className="label">{tokenUtxos.data ? `${fmtInt(total)} ${ticker} on ${fmtInt(rows.length)} carrier${rows.length === 1 ? "" : "s"}` : tokenUtxos.error ? "—" : "Loading…"}</span> : undefined}
          aria-label="Recipient and amount"
        >
          <div className="send-form">
            <label className="send-field">
              <span className="label">Recipient address</span>
              <input
                className="input mono"
                value={toText}
                onChange={(e) => {
                  setToText(e.target.value);
                  setStep("form");
                }}
                placeholder="bc1q… / bc1p… / 1… / 3…"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                disabled={busy}
                aria-invalid={rcpt.state === "invalid"}
                aria-describedby="send-to-msg"
              />
            </label>
            <div className="send-field-row">
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setToText(address)} disabled={busy}>
                Use my address (split)
              </button>
              {rcpt.state === "ok" && <span className="muted">{rcpt.label}</span>}
            </div>
            <div id="send-to-msg">
              {rcpt.state === "invalid" && <div className="err">{rcpt.error.replace(/^./, (c) => c.toUpperCase())}.</div>}
              {toSelf && (
                <div className="notice">
                  This is your own address. Transferring to yourself moves the {ticker} onto a new 546-sat carrier (vout1) — that is how a carrier is split; the tokens stay yours. It still costs the protocol
                  fee and the network fee.
                </div>
              )}
              {rcpt.feeAddress && <div className="err">That is the protocol fee address; tokens sent there cannot be moved by you.</div>}
            </div>

            <label className="send-field">
              <span className="label">Amount ({ticker}, whole tokens)</span>
              <span className="send-amount">
                <input
                  className="input mono"
                  inputMode="numeric"
                  value={amountText}
                  onChange={(e) => {
                    setAmountText(e.target.value);
                    setStep("form");
                  }}
                  placeholder={max > 0 ? `1 – ${fmtInt(max)}` : "0"}
                  disabled={busy}
                  aria-invalid={!!amountErr}
                />
                <button className="btn btn-sm" type="button" onClick={() => setAmountText(String(max))} disabled={busy || max < 1}>
                  Max
                </button>
              </span>
            </label>
            {amountErr && <div className="err">{amountErr}</div>}

            <div className="send-carriers">
              <div className="orders-head">
                <span className="label">
                  Carriers to spend · {mode === "auto" ? "chosen automatically" : "your choice"}
                </span>
                {mode === "manual" && (
                  <button className="btn btn-ghost btn-sm" type="button" onClick={useAuto} disabled={busy}>
                    Choose automatically
                  </button>
                )}
              </div>
              {tokenUtxos.error && !tokenUtxos.data ? (
                <div className="err" title={indexerErrorTitle(tokenUtxos.error)}>
                  Could not load your carriers. {indexerErrorText(tokenUtxos.error)}
                </div>
              ) : rows.length === 0 ? (
                <div className="empty">{tokenUtxos.loading ? "Loading…" : `No ${ticker} on this address.`}</div>
              ) : (
                <ul className="utxo-list" aria-label={`${ticker} carriers`}>
                  {rows.map((r) => {
                    const on = keys.includes(r.key);
                    const off = busy || r.blocked === "pending" || r.blocked === "filling";
                    return (
                      <li key={r.key}>
                        <label className={`utxo${on ? " selected" : ""}${off ? " disabled" : ""}`}>
                          <input type="checkbox" checked={on} onChange={() => toggle(r.key)} disabled={off} />
                          <span className="utxo-main">
                            <span className="num strong">
                              {fmtInt(r.amount)} {ticker}
                            </span>
                            <span className="mono muted">
                              {shortTxid(r.txid, 6, 4)}:{r.vout} · {r.sats !== null ? `${fmtInt(r.sats)} sats` : "value unknown"}
                            </span>
                            <span className="fineprint">{carrierNote(r, ticker)}</span>
                          </span>
                          <span className="utxo-tag">
                            {r.others.length > 0 && !r.blocked ? (
                              <button className="btn btn-sm" type="button" onClick={(e) => { e.preventDefault(); splitOff(r); }} disabled={busy} title={`Transfer its ${fmtInt(r.amount)} ${ticker} to yourself: they land alone on a new carrier, the other tickers on your residual carrier`}>
                                Split off
                              </button>
                            ) : r.blocked === "listed" ? (
                              <span className="status-tag s-open">listed</span>
                            ) : r.blocked === "filling" ? (
                              <span className="status-tag s-filling">fill pending</span>
                            ) : r.blocked === "pending" ? (
                              <span className="status-tag s-filling">spent · pending</span>
                            ) : !Number.isInteger(r.sats) ? (
                              <span className="status-tag s-cancelled">value unknown</span>
                            ) : r.offBook ? (
                              <span className="status-tag s-filling">still buyable</span>
                            ) : (
                              <span className="status-tag">free</span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {mode === "auto" && rows.some((r) => r.blocked === "listed") && (
                <p className="fineprint">Listed carriers are never picked automatically — tick one to transfer it anyway (that withdraws its listing).</p>
              )}
              {ordersIncomplete && <p className="notice">{ORDERS_INCOMPLETE_TEXT}</p>}
            </div>

            <FeeSelector fee={fee} disabled={busy} />

            <dl className="totals">
              <div>
                <dt>Protocol fee (vout0)</dt>
                <dd className="mono">{fmtSats(SEND_PROTOCOL_FEE_SATS)}</dd>
              </div>
              <div>
                <dt>{toSelf ? "New carrier (vout1, stays yours)" : "Recipient carrier (vout1, goes with the tokens)"}</dt>
                <dd className="mono">{fmtSats(DUST_SATS)}</dd>
              </div>
              <div>
                <dt>Network fee{est && fee.satVb ? ` (≈ ${fmtInt(est.vsize)} vB @ ${fee.satVb} sat/vB)` : ""}</dt>
                <dd className="mono">{est && fee.satVb ? `≈ ${fmtSats(est.feeSats)}` : "—"}</dd>
              </div>
              <div className="total">
                <dt>BTC leaving your wallet</dt>
                <dd className="mono">{est && fee.satVb ? `≈ ${fmtSats(btcOut)}` : "—"}</dd>
              </div>
            </dl>
            <p className="fineprint">Your residual carrier (vout2, {DUST_SATS} sats) stays yours; BTC change comes back as vout4 when it is at least {DUST_SATS} sats.</p>

            {whyNot && step === "form" && !inFlight && <div className="muted">{whyNot}</div>}
            <div className="sheet-actions">
              <button className="btn btn-primary btn-lg" type="button" onClick={() => setStep("review")} disabled={!formOk || busy || inFlight}>
                Review
              </button>
            </div>
          </div>
        </Panel>

        {(step === "review" || inFlight) && (
          <div ref={reviewRef} className="send-review-wrap">
          <Panel title="Review and sign" led={chain.phase === "error" ? "err" : chain.phase === "confirmed" ? "ok" : inFlight ? "busy" : "idle"} aria-label="Review and sign">
            <div className="send-review">
              <p className="send-summary">
                Transfer <strong>{fmtInt(review.amount)} {ticker}</strong> to{" "}
                {reviewSelf ? (
                  <strong>yourself</strong>
                ) : (
                  <span className="mono strong send-to" title={review.toAddress}>
                    {review.toAddress}
                  </span>
                )}
                .
              </p>
              <table className="send-layout">
                <thead>
                  <tr>
                    <th>vout</th>
                    <th>sats</th>
                    <th>to</th>
                    <th>carries</th>
                  </tr>
                </thead>
                <tbody>
                  {review.layout.map((o) => (
                    <tr key={o.vout}>
                      <td className="mono">{o.vout}</td>
                      <td className="mono">{o.sats === null ? "change" : fmtInt(o.sats)}</td>
                      <td className={o.vout === SEND_TO_VOUT && !reviewSelf ? "mono send-to" : undefined}>{o.vout === SEND_TO_VOUT && !reviewSelf ? shortAddr(o.to, 10, 8) : o.to}</td>
                      <td className={o.vout === SEND_OP_RETURN_VOUT ? "mono send-payload" : undefined}>{o.carries}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {review.others.length > 0 && (
                <div className="notice">
                  {review.others.length === 1 ? "A carrier you spend also holds" : "Carriers you spend also hold"}{" "}
                  {review.others.flatMap((r) => r.others.map(([t, a]) => `${fmtInt(a)} ${t}`)).join(", ")} — {reviewSelf ? "they move together onto your residual carrier (vout2), separate from the " + ticker : "they stay yours, on your residual carrier (vout2); only the " + ticker + " goes to the recipient"}.
                </div>
              )}
              {review.listed.length > 0 && (
                <div className="notice">
                  {review.listed.length === 1 ? "One carrier is" : `${review.listed.length} carriers are`} listed for sale. Transferring spends {review.listed.length === 1 ? "it" : "them"} on-chain, which withdraws the listing{review.listed.length === 1 ? "" : "s"} — the signed listing can no longer be filled.
                </div>
              )}
              {review.offBook?.length > 0 && (
                <div className="notice">
                  {review.offBook.length === 1 ? "An earlier listing of a carrier you spend" : "Earlier listings of carriers you spend"} can still be bought, although {review.offBook.length === 1 ? "it has" : "they have"} left the book. Transferring cancels {review.offBook.length === 1 ? "it" : "them"} for good.
                </div>
              )}
              {!reviewSelf && !inFlight && rcpt.state === "ok" && (
                <div className="fineprint">Check the address character by character: a transfer cannot be reversed. The recipient needs a wallet that shows LUCKY-20 balances (any wallet holds them; this site shows them).</div>
              )}
              <dl className="totals">
                <div>
                  <dt>Network fee @ {(inFlight ? chain.feeRateSatVb ?? review.feeRateSatVb : fee.satVb) ?? "—"} sat/vB</dt>
                  <dd className="mono">{chain.feeSats != null ? fmtSats(chain.feeSats) : est ? `≈ ${fmtSats(est.feeSats)}` : "—"}</dd>
                </div>
                <div className="total">
                  <dt>BTC leaving your wallet</dt>
                  <dd className="mono">{chain.feeSats != null ? fmtSats((chain.toAddress === address ? 0 : DUST_SATS) + SEND_PROTOCOL_FEE_SATS + chain.feeSats) : est ? `≈ ${fmtSats(btcOut)}` : "—"}</dd>
                </div>
              </dl>
              <div className="sheet-actions send-actions">
                {chain.phase === "idle" && (
                  <>
                    <button className="btn btn-primary btn-lg" type="button" onClick={sign} disabled={!formOk || busy}>
                      Sign with {w.providerName || "your wallet"} · transfer {fmtInt(amount ?? 0)} {ticker}
                    </button>
                    <button className="btn" type="button" onClick={() => setStep("form")}>
                      Back
                    </button>
                  </>
                )}
              </div>
              <TxProgress
                flow={chain}
                status={status}
                onReset={done}
                labels={{
                  building: "Building the transfer — your fee inputs are filtered so no other token carrier is ever spent as fee.",
                  signing: `Awaiting signature — confirm in ${w.providerName || "your wallet"}.`,
                  pending: `${chain.toAddress === address ? "Split" : "Transfer"} broadcast. Pending confirmation — checking every 15 s.`,
                  confirmed:
                    chain.toAddress === address
                      ? `Done. ${fmtInt(chain.amount ?? 0)} ${ticker} are on a new carrier of yours (vout1); the rest is on your residual carrier (vout2).`
                      : `Transferred. ${fmtInt(chain.amount ?? 0)} ${ticker} are on ${shortAddr(chain.toAddress || "", 8, 6)}'s new carrier.`,
                }}
              />
              {Number.isInteger(chain.changeVout) ? (
                <SpeedUpSend send={transferFlow} fees={fees?.data} note={transferSpeedUpNote(chain.toAddress === address)} />
              ) : waiting && chain.psbt ? (
                <div className="muted">{TRANSFER_NO_CHANGE}</div>
              ) : null}
            </div>
          </Panel>
          </div>
        )}
      </div>

      {pendingSends.length > 0 && (
        <Panel title={`Your unconfirmed ${ticker} transfers`} led="busy" aria-label="Unconfirmed transfers">
          <ul className="mine-pending-list">
            {pendingSends.map((r) => (
              <PendingTransferRow key={transferRootOf(r)} record={r} address={address} followed={followed} fees={fees?.data} onSettled={rowSettled} />
            ))}
          </ul>
        </Panel>
      )}
    </Shell>
  );
}

/**
 * One row of "Your unconfirmed transfers". A transfer whose record holds
 * what a replacement needs is followed by the row's own flow, which offers
 * Speed up and moves to the faster version afterwards; the form's own
 * transfer points at the form; any other row says where it can be sped
 * up. A transfer whose inputs are not this address's is never offered one.
 */
function PendingTransferRow({ record, address, followed, fees, onSettled }) {
  const flow = useSendToSelf({ onSettled });
  const { chain, follow } = flow;
  const state = useMemo(() => transferSpeedUpState(record, { address, followed }), [record, address, followed]);
  useEffect(() => {
    if (state === "yes") follow(record);
  }, [state, record, follow]);
  const mine = !!chain.txid && sendVersions(chain).includes(record.txid);
  const txid = mine ? chain.txid : record.txid;
  return (
    <li className="mine-pending-row t-busy">
      <Led state="busy" />
      <a className="mono" href={txUrl(txid)} target="_blank" rel="noopener noreferrer" title={txid}>
        {shortTxid(txid, 6, 4)}
      </a>
      <span className="mine-pending-text">{pendingTransferText(mine ? chain : record)}</span>
      {state === "yes" && mine ? (
        <div className="mine-pending-extra">
          <SpeedUpSend send={flow} fees={fees} note={transferSpeedUpNote(chain.toAddress === address)} />
        </div>
      ) : state === "form" ? (
        <div className="mine-pending-extra muted">Its Speed up is in the transfer above.</div>
      ) : state === "no-change" ? (
        <div className="mine-pending-extra muted">{TRANSFER_NO_CHANGE}</div>
      ) : state === "page" ? (
        <div className="mine-pending-extra muted">{TRANSFER_SPEEDUP_ELSEWHERE}</div>
      ) : null}
    </li>
  );
}
