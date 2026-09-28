import { useCallback, useEffect, useRef, useState } from "react";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { buildMinePsbt, expectPsbtPayload, minFeeInputSats } from "../lib/psbt.js";
import { isUsableFeeRate } from "../lib/feechoice.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import { DROP_GRACE_MS, forgetTx, markTxConfirmed, txRecords } from "../lib/txrecords.js";
import { fundingMessage } from "../lib/funding.js";
import {
  MINE_FLOW_BUSY,
  addPendingMine,
  applyMineStatus,
  applyReconcile,
  isFinished,
  mineFocus,
  newPendingMine,
  resumeMinePendings,
  updatePendingMine,
} from "../lib/minePending.js";
import { friendlyError } from "./useWallet.js";

const STATUS_POLL_MS = 15_000;
const RECONCILE_MAX_ATTEMPTS = 8;
export const IDLE_MINE = { phase: "idle" };
/** Phases of the build → sign → broadcast flow that hold the Mine button. */
export const MINE_BUSY = MINE_FLOW_BUSY;

/**
 * The newest MINE this browser broadcast for `address` / `ticker` whose
 * result the console has not shown yet, as a resumed "pending" state (audit
 * usertx-2 / mine-4). The console itself resumes EVERY such MINE
 * (resumeMinePendings); this single-item view is kept for callers and
 * tests that only need the latest one.
 */
export function resumeMineState(address, ticker, records = address ? txRecords(address) : []) {
  const all = resumeMinePendings(records, ticker);
  const rec = all[all.length - 1];
  if (!rec) return IDLE_MINE;
  return { phase: "pending", ticker, txid: rec.txid, broadcastAt: rec.broadcastAt, resumed: true };
}

/** A line saying the indexer is still scanning this wallet (first use of an address, src/lib/retry.js). */
export function seedWaitNote({ elapsedMs = 0, busy = false } = {}) {
  const s = Math.round(elapsedMs / 1000);
  return busy
    ? `The indexer's UTXO-scan queue is full — waiting for room in it (${s} s).`
    : `The indexer is scanning the UTXO set for this address (first use) — this takes a minute or two (${s} s).`;
}

/**
 * The mine console's state (owner decision F, audit mine-5):
 *
 *   flow      idle → building → signing → broadcasting → idle   (↘ error)
 *             — one MINE being assembled; the only thing that holds the button
 *   pendings  every MINE broadcast and not finished yet, each tracked on its
 *             own: pending → confirmed (+ the indexer's credit) | dropped
 *             (src/lib/minePending.js)
 *
 * A broadcast MINE leaves the flow at once and joins `pendings`, so another
 * can be started while earlier ones wait for their block. The inputs of
 * every pending tx stay excluded from the next build through the broadcast
 * records (wallet.getBitcoinUtxos), and each MINE's vout0 through the
 * pending-carrier registry, so a new MINE never re-spends — and never
 * replaces — an earlier one.
 *
 * `mine` is the single state the terminal's LEDs / caption / digit strip
 * follow (mineFocus). `onSettled` runs after each confirmation and each
 * credit so callers refresh balances / token stats / feeds.
 */
export function useMine({ wallet: walletState, ticker, tokenInfo, feeRateSatVb, onSettled }) {
  const [flow, setFlow] = useState(IDLE_MINE);
  const [pendings, setPendings] = useState([]);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const pendingsRef = useRef(pendings);
  pendingsRef.current = pendings;
  const flowRef = useRef(flow);
  flowRef.current = flow;

  // A wallet change or disconnect abandons the flow; this ticker's MINEs
  // whose result has not been shown are resumed from the broadcast records.
  const address = walletState.status === "connected" ? walletState.address : null;
  useEffect(() => {
    setFlow(IDLE_MINE);
    setPendings(address ? resumeMinePendings(txRecords(address), ticker) : []);
  }, [address, ticker]);

  const startMine = useCallback(async () => {
    if (walletState.status !== "connected" || !tokenInfo) return;
    if (MINE_FLOW_BUSY.has(flowRef.current.phase)) return; // one wallet prompt at a time
    const { address: addr, pubkeyHex } = walletState;
    const startedAt = Date.now(); // keys the terminal's per-attempt lines
    setFlow({ phase: "building", ticker, startedAt });
    let utxoRes = null;
    try {
      if (!isUsableFeeRate(feeRateSatVb)) {
        throw new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.");
      }
      const onWait = (info) => setFlow((m) => (m.phase === "building" ? { ...m, waitNote: seedWaitNote(info) } : m));
      // getBitcoinUtxos drops the inputs of every broadcast that has not
      // confirmed yet — the earlier MINEs in the pending list included.
      const [utxoList, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(addr, { onWait }), indexer.tokenUtxos(addr)]);
      utxoRes = utxoList;
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
      setFlow({
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
      setFlow((m) => ({ ...m, phase: "broadcasting" }));
      const txid = await wallet.broadcastSignedPsbt(signed, { kind: "mine", ticker });
      addPendingTokenOutpoints([{ txid, vout: 0 }], addr);
      // Into the pending list; the button is free again for the next MINE.
      setPendings((l) => addPendingMine(l, newPendingMine({ txid, ticker })));
      setFlow(IDLE_MINE);
    } catch (e) {
      const error = fundingMessage(e, utxoRes, { action: "this MINE" }) ?? friendlyError(e);
      setFlow((m) => ({ ...m, phase: "error", error }));
    }
  }, [walletState, tokenInfo, ticker, feeRateSatVb]);

  /** Clear the flow's error (the pending list is untouched). */
  const resetMine = useCallback(() => setFlow((f) => (MINE_FLOW_BUSY.has(f.phase) ? f : IDLE_MINE)), []);
  /** Remove one finished item from the list. */
  const dismissMine = useCallback((txid) => setPendings((l) => l.filter((x) => x.txid !== txid || !isFinished(x))), []);
  /** Remove every finished item. */
  const clearFinished = useCallback(() => setPendings((l) => l.filter((x) => !isFinished(x))), []);

  // Pending items → poll /tx-status (one pass over all of them per tick);
  // the yield is computed client-side on confirmation. A tx the node has
  // not seen for DROP_GRACE_MS is dropped / replaced (audit usertx-6).
  const pendingKey = pendings
    .filter((x) => x.phase === "pending")
    .map((x) => x.txid)
    .join(",");
  useEffect(() => {
    if (!pendingKey) return undefined;
    let alive = true;
    const txids = pendingKey.split(",");
    const check = async () => {
      for (const txid of txids) {
        let s;
        try {
          s = await indexer.txStatus(txid);
        } catch (e) {
          if (!alive) return;
          setPendings((l) => updatePendingMine(l, txid, (x) => (x.phase === "pending" ? { ...x, pollError: friendlyError(e) } : x)));
          continue;
        }
        if (!alive) return;
        const cur = pendingsRef.current.find((x) => x.txid === txid);
        if (!cur || cur.phase !== "pending") continue;
        const next = applyMineStatus(cur, s, Date.now(), DROP_GRACE_MS);
        if (next === cur) continue;
        setPendings((l) => updatePendingMine(l, txid, (x) => (x.phase === "pending" ? next : x)));
        if (next.phase === "dropped") {
          if (address) forgetTx(address, txid);
        } else if (next.phase === "confirmed") {
          // The record is forgotten once the indexer's verdict is in (below):
          // leaving the page before that still resumes this reveal.
          if (address) markTxConfirmed(address, txid);
          settledRef.current?.();
        }
      }
    };
    check();
    const id = setInterval(check, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pendingKey, address]);

  // Confirmed items → reconcile with /mines/by-txid (the indexer is
  // authoritative), each on its own attempt budget.
  const attemptsRef = useRef(new Map());
  const reconcileKey = pendings
    .filter((x) => x.phase === "confirmed" && x.reconcile === "pending")
    .map((x) => x.txid)
    .join(",");
  useEffect(() => {
    if (!reconcileKey) return undefined;
    let alive = true;
    const txids = reconcileKey.split(",");
    const finish = (txid, verdict) => {
      if (address) forgetTx(address, txid);
      attemptsRef.current.delete(txid);
      setPendings((l) => updatePendingMine(l, txid, (x) => applyReconcile(x, verdict)));
    };
    const check = async () => {
      for (const txid of txids) {
        const n = (attemptsRef.current.get(txid) || 0) + 1;
        attemptsRef.current.set(txid, n);
        try {
          const row = await indexer.mineByTxid(txid);
          if (!alive) return;
          if (row) {
            finish(txid, row);
            settledRef.current?.();
            continue;
          }
        } catch {
          /* transient — retry on the next tick */
        }
        if (alive && n >= RECONCILE_MAX_ATTEMPTS) finish(txid, "timeout");
      }
    };
    check();
    const id = setInterval(check, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [reconcileKey, address]);

  return {
    mine: mineFocus(flow, pendings),
    flow,
    pendings,
    startMine,
    resetMine,
    dismissMine,
    clearFinished,
    busy: MINE_FLOW_BUSY.has(flow.phase),
  };
}
