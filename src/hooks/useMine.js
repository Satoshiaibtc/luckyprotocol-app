import { useCallback, useEffect, useRef, useState } from "react";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { buildMinePsbt, expectPsbtPayload, minFeeInputSats } from "../lib/psbt.js";
import { mineYield } from "../lib/yield.js";
import { isUsableFeeRate } from "../lib/feechoice.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import { friendlyError } from "./useWallet.js";

const STATUS_POLL_MS = 15_000;
const RECONCILE_MAX_ATTEMPTS = 8;
export const IDLE_MINE = { phase: "idle" };
export const MINE_BUSY = new Set(["building", "signing", "broadcasting", "pending"]);

/**
 * The MINE state machine:
 *   idle → building → signing → broadcasting → pending → confirmed (+ reconcile with /mines/by-txid)
 *                                                        ↘ error
 * `walletState` is the connected wallet ({ address, pubkeyHex } when status ==
 * "connected"); `feeRateSatVb` is the user's fee choice (see useFeeRate —
 * null when a preset was chosen but /fees is unavailable, which refuses to
 * build); `onSettled` runs after confirmation and again after reconcile so
 * callers refresh balances / token stats / feeds.
 */
export function useMine({ wallet: walletState, ticker, tokenInfo, feeRateSatVb, onSettled }) {
  const [mine, setMine] = useState(IDLE_MINE);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  // A wallet change or disconnect abandons an in-flight flow's UI state.
  const address = walletState.status === "connected" ? walletState.address : null;
  useEffect(() => {
    setMine(IDLE_MINE);
  }, [address]);

  const startMine = useCallback(async () => {
    if (walletState.status !== "connected" || !tokenInfo) return;
    const { address: addr, pubkeyHex } = walletState;
    const startedAt = Date.now(); // keys the terminal's per-attempt lines
    setMine({ phase: "building", ticker, startedAt });
    try {
      if (!isUsableFeeRate(feeRateSatVb)) {
        throw new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.");
      }
      const [utxoRes, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(addr), indexer.tokenUtxos(addr)]);
      const tokenOutpoints = withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), addr);
      const built = buildMinePsbt({
        address: addr,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints,
        feeRateSatVb,
        ticker,
        minInputSats: minFeeInputSats(utxoRes.assetSafe), // M-8: 10,000-sat floor on non-asset-safe lists
      });
      setMine({
        phase: "signing",
        ticker,
        startedAt,
        feeSats: built.feeSats,
        feeRateSatVb: built.feeRateSatVb,
        vsize: built.estimatedVsize,
        inputCount: built.inputIndexes.length,
        inputs: built.inputs,
        utxoSource: utxoRes.source,
        assetSafe: utxoRes.assetSafe,
      });

      // Sign-time guard: the OP_RETURN must be exactly one MINE for this ticker.
      expectPsbtPayload(built.psbtHex, { op: "MINE", ticker });
      const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address: addr });
      setMine((m) => ({ ...m, phase: "broadcasting" }));
      const txid = await wallet.broadcastSignedPsbt(signed);
      addPendingTokenOutpoints([{ txid, vout: 0 }], addr);
      setMine((m) => ({ ...m, phase: "pending", txid, broadcastAt: Date.now() }));
    } catch (e) {
      setMine((m) => ({ ...m, phase: "error", error: friendlyError(e) }));
    }
  }, [walletState, tokenInfo, ticker, feeRateSatVb]);

  const resetMine = useCallback(() => setMine(IDLE_MINE), []);

  // Pending → poll /tx-status until confirmed; compute yield client-side.
  useEffect(() => {
    if (mine.phase !== "pending" || !mine.txid) return undefined;
    let alive = true;
    const txid = mine.txid;
    const check = async () => {
      try {
        const s = await indexer.txStatus(txid);
        if (!alive) return;
        if (s.confirmed && s.block_hash) {
          setMine((m) => ({
            ...m,
            phase: "confirmed",
            blockHeight: s.block_height,
            blockHash: s.block_hash,
            blockTime: s.block_time,
            yieldLocal: mineYield(s.block_hash),
            reconcile: "pending",
            pollError: null,
          }));
          settledRef.current?.();
        } else {
          setMine((m) => ({ ...m, pollError: null, lastChecked: Date.now() }));
        }
      } catch (e) {
        if (alive) setMine((m) => ({ ...m, pollError: friendlyError(e) }));
      }
    };
    check();
    const id = setInterval(check, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mine.phase, mine.txid]);

  // Confirmed → reconcile with /mines/by-txid (the indexer is authoritative).
  useEffect(() => {
    if (mine.phase !== "confirmed" || mine.reconcile !== "pending" || !mine.txid) return undefined;
    let alive = true;
    let attempts = 0;
    const txid = mine.txid;
    const check = async () => {
      attempts += 1;
      try {
        const row = await indexer.mineByTxid(txid);
        if (!alive) return;
        if (row) {
          setMine((m) => ({ ...m, reconcile: "done", indexed: row }));
          settledRef.current?.();
          return;
        }
      } catch {
        /* transient — retry on next tick */
      }
      if (alive && attempts >= RECONCILE_MAX_ATTEMPTS) {
        setMine((m) => ({ ...m, reconcile: "timeout" }));
      }
    };
    check();
    const id = setInterval(() => {
      if (attempts < RECONCILE_MAX_ATTEMPTS) check();
    }, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mine.phase, mine.reconcile, mine.txid]);

  return { mine, startMine, resetMine, busy: MINE_BUSY.has(mine.phase) };
}
