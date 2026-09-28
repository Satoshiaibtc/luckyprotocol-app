import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { droppedMessage, useTxStatus } from "./useTxStatus.js";
import { friendlyError } from "./useWallet.js";
import { buildSendPsbt, estimateSendFeeSats, expectPsbtPayload, minFeeInputSats, MAX_FEE_RATE_SAT_VB } from "../lib/psbt.js";
import { isUsableFeeRate, missingFeeHint } from "../lib/feechoice.js";
import { cancelFeeRate } from "../lib/market.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import { isConflictError } from "../lib/walletShapes.js";
import { retryWhileSeeding } from "../lib/retry.js";
import { fundingMessage } from "../lib/funding.js";
import { forgetTx } from "../lib/txrecords.js";
import { sendPendingOutpoints } from "../lib/send.js";

const IDLE = { phase: "idle" };
const BUSY = new Set(["building", "signing", "broadcasting", "pending"]);
const outKey = (u) => `${u.txid}:${u.vout}`;

const WHAT = { cancel: "withdrawal", split: "split", send: "send" };

/**
 * The on-chain SEND shared by the Sell fold, the portfolio and the Send
 * page (§2.3 reference layout — vout0 recipient, vout1 fee, vout2
 * OP_RETURN, vout3 your residual slot, vout4 BTC change):
 *
 *   split   — move `amount` of `ticker` off a carrier onto a fresh 546-sat
 *             vout0 of your own (the residual stays on vout3), so part of it
 *             can be listed — or a multi-ticker carrier's ticker moved onto
 *             its own carrier
 *   cancel  — spend a LISTED carrier back to yourself: the only real cancel
 *             (§7.3). When the order is `filling` (a fill sits in the mempool,
 *             audit M-9) the fee rate is raised to the BIP125 replacement
 *             floor from src/lib/market.js cancelFeeRate and the reason is
 *             surfaced in `chain.rule`.
 *   send    — `amount` of `ticker` from the carriers in `utxos` to
 *             `toAddress` (anyone, or yourself — then it is a split)
 *
 *   const { chain, status, run, reset, busy } = useSendToSelf({ onSettled })
 *   run({ kind: "split" | "cancel" | "send", ticker, amount, utxo: { txid, vout, sats? } | utxos: [...], toAddress?, order? })
 *
 * `chain` = { phase, kind, ticker, amount, toAddress, txid, feeSats,
 * feeRateSatVb, vsize, inputs, assetSafe, rule, error }, phase ∈ idle |
 * building | signing | broadcasting | pending | confirmed | error. A wallet
 * change resets it.
 */
export function useSendToSelf({ onSettled } = {}) {
  const { wallet: w, address, pubkeyHex, fees, fee, refreshAll } = useApp();
  const [chain, setChain] = useState(IDLE);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    setChain(IDLE);
  }, [address]);

  const status = useTxStatus(chain.phase === "pending" || chain.phase === "confirmed" ? chain.txid : null, {
    onConfirmed: () => {
      // Confirmed: the record has nothing left to guard (its listing is no
      // longer "your withdrawal is pending" anywhere).
      if (address && chain.txid) forgetTx(address, chain.txid);
      setChain((c) => ({ ...c, phase: "confirmed" }));
      refreshAll();
      settledRef.current?.();
    },
  });

  // The pending tx left the node's mempool without confirming (replaced or
  // evicted): say so instead of polling a dead txid forever (audit usertx-6).
  useEffect(() => {
    if (!status.dropped) return;
    setChain((c) => (c.phase === "pending" ? { ...c, phase: "error", error: droppedMessage(c.txid, WHAT[c.kind] || "send") } : c));
  }, [status.dropped]);

  const run = useCallback(
    async ({ kind, ticker, amount, utxo, utxos, toAddress, order = null }) => {
      if (w.status !== "connected" || !address) return;
      // (never the word "cancel" in an error string: friendlyError reads it as a declined signature)
      const label = kind === "cancel" ? "withdraw this listing" : kind === "send" ? "send" : "split";
      const to = kind === "send" && toAddress ? String(toAddress).trim() : address;
      const picked = Array.isArray(utxos) && utxos.length ? utxos : utxo ? [utxo] : [];
      setChain({ phase: "building", kind, ticker, amount, toAddress: to, order, rule: null });
      let utxoRes = null;
      try {
        if (picked.length === 0) throw new Error(`No ${ticker} carrier selected to spend.`);
        const chosen = fee.satVb;
        if (!isUsableFeeRate(chosen)) throw new Error(missingFeeHint(fee.choice, chosen, label, { awaitingAck: !!fee.highFee?.pending }));
        // The cancel's own size (one carrier + one fee input) — the absolute-fee
        // floor of the M-9 rule needs it; the real build may add inputs, which
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
        // both reads wait for it the same way (src/lib/retry.js).
        const [utxoList, tokenRows, btcRows] = await Promise.all([
          wallet.getBitcoinUtxos(address),
          indexer.tokenUtxos(address),
          retryWhileSeeding(() => indexer.btcUtxos(address)),
        ]);
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
          minInputSats: minFeeInputSats(utxoRes.assetSafe), // M-8
        });
        setChain({ phase: "signing", kind, ticker, amount, toAddress: to, order, rule, feeSats: built.feeSats, feeRateSatVb: built.feeRateSatVb, vsize: built.estimatedVsize, inputs: built.inputs, assetSafe: utxoRes.assetSafe });
        // Sign-time guard (M-1): exactly one OP_RETURN and it is a SEND of this ticker/amount.
        expectPsbtPayload(built.psbtHex, { op: "SEND", ticker, amount });
        const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
        setChain((c) => ({ ...c, phase: "broadcasting" }));
        let txid;
        try {
          txid = await wallet.broadcastSignedPsbt(signed, { kind: "send", ticker });
        } catch (e) {
          if (kind === "cancel" && isConflictError(e) && /insufficient fee|replacement/i.test(String(e?.message || e))) {
            throw new Error(
              `The node refused the replacement: the fill already in the mempool pays more than this transaction would (BIP125). ` +
              `Pick Custom, enter a higher sat/vB${rule?.floorSatVb ? ` (≥ ${rule.floorSatVb})` : ""} and retry — or wait for that fill to confirm or expire.`,
            );
          }
          throw e;
        }
        // Your token outputs of this tx: vout3 (the residual carrier) always,
        // vout0 too when it pays yourself; vout4, when present, is plain BTC.
        addPendingTokenOutpoints(sendPendingOutpoints(txid, { toSelf: to === address }), address);
        setChain((c) => ({ ...c, phase: "pending", txid }));
      } catch (e) {
        const error = fundingMessage(e, utxoRes, { action: `this ${WHAT[kind] || "send"}` }) ?? friendlyError(e);
        setChain((c) => ({ ...c, phase: "error", error }));
      }
    },
    [w.status, address, pubkeyHex, fee.satVb, fee.choice, fee.highFee, fees.data],
  );

  const reset = useCallback(() => setChain(IDLE), []);
  return { chain, status, run, reset, busy: BUSY.has(chain.phase) };
}
