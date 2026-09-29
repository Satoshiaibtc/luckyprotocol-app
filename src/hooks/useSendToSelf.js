import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { droppedMessage, useTxStatus } from "./useTxStatus.js";
import { friendlyError } from "./useWallet.js";
import { useSeedWait } from "./useSeedWait.js";
import { buildSendPsbt, buildSpeedUpPsbt, estimateSendFeeSats, expectPsbtPayload, minFeeInputSats, MAX_FEE_RATE_SAT_VB, RBF_SEQUENCE } from "../lib/psbt.js";
import { PROTOCOL_LOCKTIME } from "../lib/payloads.js";
import { isUsableFeeRate, missingFeeHint } from "../lib/feechoice.js";
import { cancelFeeRate } from "../lib/market.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import { isConflictError } from "../lib/walletShapes.js";
import { seedWaitNote } from "../lib/retry.js";
import { fundingMessage } from "../lib/funding.js";
import { forgetTx, markTxConfirmed, markTxUnconfirmed, recordBroadcastTx, txRecords } from "../lib/txrecords.js";
import { sendPendingOutpoints, sendVersions, switchSendVersion } from "../lib/send.js";

const IDLE = { phase: "idle" };
const BUSY = new Set(["building", "signing", "broadcasting", "pending"]);
/** Phases whose tx is still tracked (useTxStatus keeps checking until final). */
const TRACKED = new Set(["pending", "unseen", "confirmed"]);
const outKey = (u) => `${u.txid}:${u.vout}`;

const WHAT = { cancel: "withdrawal", split: "split", send: "send" };
/** How often the versions a Speed up replaced are asked about while the send waits. */
const VERSION_POLL_MS = 15_000;

/**
 * The on-chain SEND shared by the Sell fold, the portfolio and the Send
 * page (§2.3 reference layout — vout0 protocol fee, vout1 recipient,
 * vout2 your residual carrier, vout3 OP_RETURN, vout4 BTC change):
 *
 *   split   — move `amount` of `ticker` off a carrier onto a fresh 546-sat
 *             vout1 of your own (the residual stays on vout2), so part of it
 *             can be listed — or a multi-ticker carrier's ticker moved onto
 *             its own carrier
 *   cancel  — spend a LISTED carrier back to yourself: the only real cancel
 *             (§7.3). When the order is `filling` (a fill sits in the
 *             mempool) the fee rate is raised to the BIP125 replacement
 *             floor from src/lib/market.js cancelFeeRate and the reason is
 *             surfaced in `chain.rule`.
 *   send    — `amount` of `ticker` from the carriers in `utxos` to
 *             `toAddress` (anyone, or yourself — then it is a split)
 *
 *   const { chain, status, run, reset, stopWaiting, busy, speedUpQuote, speedUp } = useSendToSelf({ onSettled })
 *   run({ kind: "split" | "cancel" | "send", ticker, amount, utxo: { txid, vout, sats? } | utxos: [...], toAddress?, order? })
 *
 * `chain` = { phase, kind, ticker, amount, toAddress, txid, feeSats,
 * feeRateSatVb, vsize, inputs, assetSafe, rule, error, note, psbt,
 * changeVout, speeding, speedError }, phase ∈ idle |
 * building | signing | broadcasting | pending | unseen | confirmed | error.
 *
 * Speed up: while the tx is pending (or unseen) `speedUp(rate)` replaces it
 * with a copy that pays more (BIP125 — the same inputs, which all signal
 * replace-by-fee, and the same outputs, the extra fee taken from the BTC
 * change; psbt.buildSpeedUpPsbt), signed again and broadcast; the flow
 * then follows the new txid — and keeps asking about the versions it
 * replaced: when a block confirms one of those instead, the flow follows
 * that one. `speedUpQuote(rate)` previews it.
 * A confirmed tx is tracked until its block is final (`status.final`): a
 * chain reorganization can still put it back in the mempool — the chain
 * then returns to "pending" and its record guards its inputs again. A
 * wallet change resets it. `stopWaiting()` ends the build's wait for the
 * indexer's scan of the wallet (back to idle).
 */
export function useSendToSelf({ onSettled } = {}) {
  const { wallet: w, address, pubkeyHex, fees, fee, refreshAll } = useApp();
  const [chain, setChain] = useState(IDLE);
  const chainRef = useRef(chain);
  chainRef.current = chain;
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const seedWait = useSeedWait();

  useEffect(() => {
    seedWait.stop();
    setChain(IDLE);
  }, [address, seedWait]);

  const status = useTxStatus(TRACKED.has(chain.phase) ? chain.txid : null, {
    onConfirmed: (s) => {
      // Confirmed, not final: the record keeps guarding its inputs until
      // the block is final (a chain reorganization could undo it).
      if (address && chain.txid) markTxConfirmed(address, chain.txid, s.block_height ?? null);
      setChain((c) => ({ ...c, phase: "confirmed" }));
      refreshAll();
      settledRef.current?.();
    },
    onReorg: (kind) => {
      if (kind !== "mempool") return;
      if (address && chain.txid) markTxUnconfirmed(address, chain.txid);
      setChain((c) => (c.phase === "confirmed" ? { ...c, phase: "pending" } : c));
      refreshAll();
    },
  });

  // Final: nothing can undo it any more — the record may go.
  useEffect(() => {
    if (status.final && address && chain.txid) forgetTx(address, chain.txid);
  }, [status.final, address, chain.txid]);

  // The node has not seen the tx for a while: say so, keep checking — it may
  // still confirm; seen again, it is pending again.
  useEffect(() => {
    if (status.dropped) setChain((c) => (c.phase === "pending" ? { ...c, phase: "unseen", note: droppedMessage(c.txid, WHAT[c.kind] || "send") } : c));
    else setChain((c) => (c.phase === "unseen" ? { ...c, phase: "pending", note: null } : c));
  }, [status.dropped]);

  // A send that was sped up: while it waits, every earlier version is
  // asked about too — the one a block confirms is the send (its record
  // takes over the guard of the inputs they all spend).
  const versionsKey = (chain.phase === "pending" || chain.phase === "unseen") && chain.replaces?.length ? sendVersions(chain).join(",") : null;
  useEffect(() => {
    if (!versionsKey || !address) return undefined;
    const [cur, ...older] = versionsKey.split(",");
    let alive = true;
    const check = async () => {
      for (const v of older) {
        let st = null;
        try {
          st = await indexer.txStatus(v);
        } catch {
          st = null; // unknown — ask again next time
        }
        if (!alive) return;
        if (!st || !st.confirmed) continue;
        const c = chainRef.current;
        if (c.txid !== cur) return;
        const inputs = txRecords(address).find((r) => r.txid === cur)?.inputs ?? c.inputs ?? [];
        recordBroadcastTx(address, { txid: v, kind: "send", ticker: c.ticker, inputs });
        for (const t of sendVersions(c)) if (t !== v) forgetTx(address, t);
        addPendingTokenOutpoints(sendPendingOutpoints(v, { toSelf: c.toAddress === address }), address);
        setChain((x) => (x.txid === cur ? switchSendVersion(x, v) : x));
        return;
      }
    };
    check();
    const id = setInterval(check, VERSION_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [versionsKey, address]);

  const run = useCallback(
    async ({ kind, ticker, amount, utxo, utxos, toAddress, order = null }) => {
      if (w.status !== "connected" || !address) return;
      // (never the word "cancel" in an error string: friendlyError reads it as a declined signature)
      const label = kind === "cancel" ? "withdraw this listing" : kind === "send" ? "send" : "split";
      const to = kind === "send" && toAddress ? String(toAddress).trim() : address;
      const picked = Array.isArray(utxos) && utxos.length ? utxos : utxo ? [utxo] : [];
      setChain({ phase: "building", kind, ticker, amount, toAddress: to, order, rule: null });
      let utxoRes = null;
      const signal = seedWait.begin();
      try {
        if (picked.length === 0) throw new Error(`No ${ticker} carrier selected to spend.`);
        const chosen = fee.satVb;
        if (!isUsableFeeRate(chosen)) throw new Error(missingFeeHint(fee.choice, chosen, label, { awaitingAck: !!fee.highFee?.pending }));
        // The cancel's own size (one carrier + one fee input) — the absolute-fee
        // floor of the replacement rule needs it; the real build may add inputs, which
        // only raises the absolute fee further.
        const est = estimateSendFeeSats({ address, toAddress: to, ticker, amount, feeRateSatVb: chosen, carrierCount: picked.length });
        const rule = kind === "cancel" ? cancelFeeRate({ chosenSatVb: chosen, order, incrementalRelayFee: fees.data?.incrementalrelayfee ?? null, vsize: est.vsize }) : null;
        if (rule && rule.overCap) {
          throw new Error(
            `The pending fill of this listing pays ${Number(order.pending_fee_sats).toLocaleString("en-US")} sats; replacing it would need ` +
            `≥ ${rule.floorSatVb} sat/vB, above the ${MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")} sat/vB safety cap. Wait for that fill to confirm or drop out of the mempool.`,
          );
        }
        const rate = rule ? rule.satVb : chosen;
        // /btc-utxos may still be scanning a first-time address (503 / 429):
        // the wallet read waits for it (src/lib/retry.js); the indexer's
        // own rows are read after it, when the scan is done — one wait,
        // not two polling side by side.
        const onWait = (info) => setChain((c) => (c.phase === "building" ? { ...c, waitNote: seedWaitNote(info) } : c));
        const [utxoList, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(address, { onWait, signal }), indexer.tokenUtxos(address, signal)]);
        const btcRows = await wallet.indexerBtcRows(address, { onWait, signal });
        seedWait.done(signal);
        utxoRes = utxoList;
        // Each carrier's exact sats come from the indexer's BTC view (a wallet's
        // asset-safe list may omit 546-sat dust); the sighash commits to it.
        const known = new Map(btcRows.map((u) => [outKey(u), u.sats]));
        const carriers = picked.map((u) => {
          const sats = Number.isInteger(u.sats) && u.sats > 0 ? u.sats : known.get(outKey(u)) ?? (order ? order.carrier_sats : null);
          return { txid: u.txid, vout: u.vout, ...(sats ? { sats } : {}) };
        });
        const built = buildSendPsbt({
          address,
          pubkeyHex,
          utxos: utxoRes.utxos,
          tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), address),
          tokenUtxos: carriers,
          feeRateSatVb: rate,
          ticker,
          amount,
          toAddress: to,
          minInputSats: minFeeInputSats(utxoRes.assetSafe), // 10,000-sat floor on non-asset-safe lists
        });
        setChain({ phase: "signing", kind, ticker, amount, toAddress: to, order, rule, feeSats: built.feeSats, feeRateSatVb: built.feeRateSatVb, vsize: built.estimatedVsize, inputs: built.inputs, assetSafe: utxoRes.assetSafe });
        // Sign-time guard: exactly one OP_RETURN and it is a SEND of this
        // ticker / amount, the protocol lock time, replace-by-fee on every
        // input, and the reference layout — the fee at vout0, `to` at vout1,
        // yourself at vout2.
        expectPsbtPayload(built.psbtHex, { op: "SEND", ticker, amount, lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self: address, to } });
        const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
        setChain((c) => ({ ...c, phase: "broadcasting" }));
        let txid;
        try {
          txid = await wallet.broadcastSignedPsbt(signed, { kind: "send", ticker, address });
        } catch (e) {
          if (kind === "cancel" && isConflictError(e) && /insufficient fee|replacement/i.test(String(e?.message || e))) {
            throw new Error(
              `The node refused the replacement: the fill already in the mempool pays more than this transaction would (BIP125). ` +
              `Pick Custom, enter a higher sat/vB${rule?.floorSatVb ? ` (≥ ${rule.floorSatVb})` : ""} and retry — or wait for that fill to confirm or expire.`,
            );
          }
          throw e;
        }
        // Your token outputs of this tx: vout2 (the residual carrier) always,
        // vout1 too when it pays yourself; vout4, when present, is plain BTC.
        addPendingTokenOutpoints(sendPendingOutpoints(txid, { toSelf: to === address }), address);
        // The unsigned PSBT and its change output stay with the flow: a Speed up rebuilds from them.
        setChain((c) => ({ ...c, phase: "pending", txid, psbt: built.psbtHex, changeVout: built.changeVout ?? null }));
      } catch (e) {
        // Stop waiting (or the page left): back to idle, nothing to report.
        if (signal.aborted) {
          setChain((c) => (c.phase === "building" ? IDLE : c));
          return;
        }
        const error = fundingMessage(e, utxoRes, { action: `this ${WHAT[kind] || "send"}` }) ?? friendlyError(e);
        setChain((c) => ({ ...c, phase: "error", error }));
      } finally {
        seedWait.done(signal);
      }
    },
    [w.status, address, pubkeyHex, fee.satVb, fee.choice, fee.highFee, fees.data, seedWait],
  );

  const incrementalRelayFee = fees.data?.incrementalrelayfee ?? undefined;

  /** The replacement a Speed up at `rate` would sign, `{ error, code }` when it cannot, or null when nothing is pending. Pure preview. */
  const speedUpQuote = useCallback(
    (rate) => {
      const c = chain;
      if ((c.phase !== "pending" && c.phase !== "unseen") || !c.psbt || !c.txid) return null;
      try {
        return buildSpeedUpPsbt({ psbtHex: c.psbt, changeVout: c.changeVout, feeRateSatVb: rate, incrementalRelayFee });
      } catch (e) {
        return { error: String(e?.message || e), code: e?.code || null };
      }
    },
    [chain, incrementalRelayFee],
  );

  /** Replace the pending tx with a higher-fee copy at `rate` (same inputs and outputs) and follow the new txid. */
  const speedUp = useCallback(
    async (rate) => {
      const c = chainRef.current;
      if ((c.phase !== "pending" && c.phase !== "unseen") || !c.psbt || !c.txid || c.speeding || !address) return;
      setChain((x) => ({ ...x, speeding: "building", speedError: null }));
      try {
        const st = await indexer.txStatus(c.txid);
        if (st && st.confirmed) throw new Error("It has just confirmed — no need to speed it up.");
        const q = buildSpeedUpPsbt({ psbtHex: c.psbt, changeVout: c.changeVout, feeRateSatVb: rate, incrementalRelayFee });
        // The same guard as the first signature.
        expectPsbtPayload(q.psbtHex, { op: "SEND", ticker: c.ticker, amount: c.amount, lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self: address, to: c.toAddress || address } });
        setChain((x) => ({ ...x, speeding: "signing" }));
        // A replacement: the inputs of every version it replaces may be spent
        // again — an earlier one whose faster copy was never confirmed as
        // sent still keeps its record.
        const signed = await wallet.signPsbt(q.psbtHex, { inputIndexes: q.inputIndexes, address, replaces: sendVersions(c) });
        setChain((x) => ({ ...x, speeding: "broadcasting" }));
        let txid;
        let unsure = null;
        try {
          txid = await wallet.broadcastSignedPsbt(signed, { kind: "send", ticker: c.ticker, address });
        } catch (e) {
          // Neither relay confirmed the faster copy, but it may still reach
          // the network (it is recorded): the flow follows it and keeps
          // asking about the earlier versions — one of them may confirm instead.
          if (!(e?.recorded && e.txid)) throw e;
          txid = e.txid;
          unsure = e;
        }
        // The replacement spends the same inputs: the old record's guard is
        // redundant now (it stays while the faster copy is not known to be sent).
        if (!unsure) forgetTx(address, c.txid);
        addPendingTokenOutpoints(sendPendingOutpoints(txid, { toSelf: c.toAddress === address }), address);
        const speedError = unsure ? friendlyError(unsure) : null;
        setChain((x) => (x.txid === c.txid ? { ...x, phase: "pending", note: null, txid, psbt: q.psbtHex, feeSats: q.feeSats, feeRateSatVb: q.feeRateSatVb, speeding: null, speedError, replaces: [...(x.replaces || []), c.txid] } : { ...x, speeding: null, speedError }));
      } catch (e) {
        setChain((x) => ({ ...x, speeding: null, speedError: friendlyError(e) }));
      }
    },
    [address, incrementalRelayFee],
  );

  const reset = useCallback(() => setChain(IDLE), []);
  return { chain, status, run, reset, stopWaiting: seedWait.stop, busy: BUSY.has(chain.phase) || !!chain.speeding, speedUpQuote, speedUp };
}
