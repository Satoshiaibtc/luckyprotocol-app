import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { useTxStatus } from "./useTxStatus.js";
import { friendlyError } from "./useWallet.js";
import { buildSendPsbt, estimateSendFeeSats, expectPsbtPayload, minFeeInputSats, MAX_FEE_RATE_SAT_VB } from "../lib/psbt.js";
import { isUsableFeeRate, missingFeeHint } from "../lib/feechoice.js";
import { cancelFeeRate } from "../lib/market.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import { isConflictError } from "../lib/walletShapes.js";

const IDLE = { phase: "idle" };
const BUSY = new Set(["building", "signing", "broadcasting", "pending"]);
const outKey = (u) => `${u.txid}:${u.vout}`;

/**
 * The on-chain SEND-to-self shared by the Sell fold and the portfolio:
 *
 *   split   — move `amount` of `ticker` off a carrier onto a fresh 546-sat
 *             vout0 (the residual stays on vout3), so part of it can be listed
 *   cancel  — spend a LISTED carrier back to yourself: the only real cancel
 *             (§7.3). When the order is `filling` (a fill sits in the mempool,
 *             audit M-9) the fee rate is raised to the BIP125 replacement
 *             floor from src/lib/market.js cancelFeeRate and the reason is
 *             surfaced in `chain.rule`.
 *
 *   const { chain, status, run, reset, busy } = useSendToSelf({ onSettled })
 *   run({ kind: "split" | "cancel", ticker, amount, utxo: { txid, vout, sats? }, order? })
 *
 * `chain` = { phase, kind, ticker, amount, txid, feeSats, feeRateSatVb, vsize,
 * inputs, assetSafe, rule, error }, phase ∈ idle | building | signing |
 * broadcasting | pending | confirmed | error. A wallet change resets it.
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
      setChain((c) => ({ ...c, phase: "confirmed" }));
      refreshAll();
      settledRef.current?.();
    },
  });

  const run = useCallback(
    async ({ kind, ticker, amount, utxo, order = null }) => {
      if (w.status !== "connected" || !address) return;
      // (never the word "cancel" in an error string: friendlyError reads it as a declined signature)
      const label = kind === "cancel" ? "withdraw this listing" : "split";
      setChain({ phase: "building", kind, ticker, amount, order, rule: null });
      try {
        const chosen = fee.satVb;
        if (!isUsableFeeRate(chosen)) throw new Error(missingFeeHint(fee.choice, chosen, label));
        // The cancel's own size (one carrier + one fee input) — the absolute-fee
        // floor of the M-9 rule needs it; the real build may add inputs, which
        // only raises the absolute fee further.
        const est = estimateSendFeeSats({ address, toAddress: address, ticker, amount, feeRateSatVb: chosen });
        const rule = kind === "cancel" ? cancelFeeRate({ chosenSatVb: chosen, order, incrementalRelayFee: fees.data?.incrementalrelayfee ?? null, vsize: est.vsize }) : null;
        if (rule && rule.overCap) {
          throw new Error(
            `The pending fill of this listing pays ${Number(order.pending_fee_sats).toLocaleString("en-US")} sats; replacing it would need ` +
            `≥ ${rule.floorSatVb} sat/vB, above the ${MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")} sat/vB safety cap. Wait for that fill to confirm or drop out of the mempool.`,
          );
        }
        const rate = rule ? rule.satVb : chosen;
        const [utxoRes, tokenRows, btcRows] = await Promise.all([wallet.getBitcoinUtxos(address), indexer.tokenUtxos(address), indexer.btcUtxos(address)]);
        // The carrier's exact sats come from the indexer's BTC view (a wallet's
        // asset-safe list may omit 546-sat dust); the sighash commits to it.
        const known = new Map(btcRows.map((u) => [outKey(u), u.sats]));
        const carrierSats = Number.isInteger(utxo.sats) && utxo.sats > 0 ? utxo.sats : known.get(outKey(utxo)) ?? (order ? order.carrier_sats : null);
        const built = buildSendPsbt({
          address,
          pubkeyHex,
          utxos: utxoRes.utxos,
          tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), address),
          tokenUtxos: [{ txid: utxo.txid, vout: utxo.vout, ...(carrierSats ? { sats: carrierSats } : {}) }],
          feeRateSatVb: rate,
          ticker,
          amount,
          toAddress: address,
          minInputSats: minFeeInputSats(utxoRes.assetSafe), // M-8
        });
        setChain({ phase: "signing", kind, ticker, amount, order, rule, feeSats: built.feeSats, feeRateSatVb: built.feeRateSatVb, vsize: built.estimatedVsize, inputs: built.inputs, assetSafe: utxoRes.assetSafe });
        // Sign-time guard (M-1): exactly one OP_RETURN and it is a SEND of this ticker/amount.
        expectPsbtPayload(built.psbtHex, { op: "SEND", ticker, amount });
        const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
        setChain((c) => ({ ...c, phase: "broadcasting" }));
        let txid;
        try {
          txid = await wallet.broadcastSignedPsbt(signed);
        } catch (e) {
          if (kind === "cancel" && isConflictError(e) && /insufficient fee|replacement/i.test(String(e?.message || e))) {
            throw new Error(
              `The node refused the replacement: the fill already in the mempool pays more than this transaction would (BIP125). ` +
              `Pick Custom, enter a higher sat/vB${rule?.floorSatVb ? ` (≥ ${rule.floorSatVb})` : ""} and retry — or wait for that fill to confirm or expire.`,
            );
          }
          throw e;
        }
        // vout0 = the new carrier, vout3 = the residual carrier (both 546-sat
        // token outputs); vout4, when present, is plain BTC change.
        addPendingTokenOutpoints([{ txid, vout: 0 }, { txid, vout: 3 }], address);
        setChain((c) => ({ ...c, phase: "pending", txid }));
      } catch (e) {
        setChain((c) => ({ ...c, phase: "error", error: friendlyError(e) }));
      }
    },
    [w.status, address, pubkeyHex, fee.satVb, fee.choice, fees.data],
  );

  const reset = useCallback(() => setChain(IDLE), []);
  return { chain, status, run, reset, busy: BUSY.has(chain.phase) };
}
