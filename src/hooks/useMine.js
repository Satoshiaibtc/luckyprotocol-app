import { useCallback, useEffect, useRef, useState } from "react";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { buildMinePsbt, expectPsbtPayload, minFeeInputSats } from "../lib/psbt.js";
import { isUsableFeeRate } from "../lib/feechoice.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import { DROP_GRACE_MS, forgetTx, markTxConfirmed, markTxUnconfirmed, recordBroadcastTx, txRecords } from "../lib/txrecords.js";
import { fundingMessage } from "../lib/funding.js";
import {
  DROPPED_WATCH_MS,
  MINE_FLOW_BUSY,
  addPendingMine,
  applyMineStatus,
  applyReconcile,
  confirmedFromRow,
  isFinished,
  mineFocus,
  newPendingMine,
  resumeMinePendings,
  updatePendingMine,
  withDepth,
} from "../lib/minePending.js";
import { friendlyError } from "./useWallet.js";

const STATUS_POLL_MS = 15_000;
/** A confirmed MINE is re-checked this often until its block is final. */
const CONFIRMED_POLL_MS = 60_000;
/** A MINE the node lost sight of is re-checked this often (for DROPPED_WATCH_MS: it may still confirm). */
const DROPPED_POLL_MS = 120_000;
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

/**
 * A line saying the indexer is still scanning this wallet (src/lib/retry.js):
 * on an address's first use, or — `rescan`, this browser has read it
 * before — again after a chain reorganization or an indexer restart.
 */
export function seedWaitNote({ elapsedMs = 0, busy = false, rescan = false } = {}) {
  const s = Math.round(elapsedMs / 1000);
  if (busy) return `The indexer's UTXO-scan queue is full — waiting for room in it (${s} s).`;
  return rescan
    ? `The indexer is scanning this address's UTXOs again (after a chain reorganization or an indexer restart) — this takes a minute or two (${s} s).`
    : `The indexer is scanning the UTXO set for this address (first use) — this takes a minute or two (${s} s).`;
}

/**
 * The mine console's state (owner decision F, audit mine-5):
 *
 *   flow      idle → building → signing → broadcasting → idle   (↘ error)
 *             — one MINE being assembled; the only thing that holds the button
 *   pendings  every MINE broadcast and not finished yet, each tracked on its
 *             own: pending → confirmed (+ the indexer's credit) → final |
 *             dropped (src/lib/minePending.js). A confirmed MINE is checked
 *             again every CONFIRMED_POLL_MS until its block is final at
 *             `tip` (the indexer's applied height): a chain reorganization
 *             moves it to another block or back to the mempool, and its
 *             record keeps guarding its inputs until then. A dropped one is
 *             checked every DROPPED_POLL_MS for DROPPED_WATCH_MS — and asked
 *             of the indexer's ledger first: it may have confirmed while
 *             the node did not report it.
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
export function useMine({ wallet: walletState, ticker, tokenInfo, feeRateSatVb, onSettled, tip = null, trustUnseen = true }) {
  const [flow, setFlow] = useState(IDLE_MINE);
  const [pendings, setPendings] = useState([]);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const pendingsRef = useRef(pendings);
  pendingsRef.current = pendings;
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const trustRef = useRef(trustUnseen);
  trustRef.current = trustUnseen;

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
        throw new Error("No fee rate — neither the indexer nor mempool.space has an estimate; pick Custom and enter a sat/vB.");
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

  // The depth of every confirmed item follows the indexer's applied height.
  useEffect(() => {
    if (!Number.isInteger(tip)) return;
    setPendings((l) => {
      const next = l.map((x) => withDepth(x, tip));
      return next.some((x, i) => x !== l[i]) ? next : l;
    });
  }, [tip]);

  // Final: nothing can move it any more — its record may go.
  const finalKey = pendings
    .filter((x) => x.phase === "confirmed" && x.final && x.reconcile && x.reconcile !== "pending")
    .map((x) => x.txid)
    .join(",");
  useEffect(() => {
    if (!finalKey || !address) return;
    for (const txid of finalKey.split(",")) forgetTx(address, txid);
  }, [finalKey, address]);

  // Items to check → /tx-status (one pass per tick, each item at its own
  // pace): pending every STATUS_POLL_MS; confirmed but not final every
  // CONFIRMED_POLL_MS; dropped every DROPPED_POLL_MS for DROPPED_WATCH_MS.
  // The yield is computed client-side on confirmation. A tx the node has
  // not seen for DROP_GRACE_MS is dropped / replaced (audit usertx-6) — not
  // before the indexer's ledger was asked, and not while the node's
  // "unknown" means nothing (`trustUnseen`).
  const now0 = Date.now();
  const watchKey = pendings
    .filter((x) => x.phase === "pending" || (x.phase === "confirmed" && !x.final) || (x.phase === "dropped" && now0 - (x.droppedAt ?? now0) < DROPPED_WATCH_MS))
    .map((x) => x.txid)
    .join(",");
  useEffect(() => {
    if (!watchKey) return undefined;
    let alive = true;
    const txids = watchKey.split(",");
    const due = (x, now) => {
      if (x.phase === "pending") return true;
      const every = x.phase === "confirmed" ? CONFIRMED_POLL_MS : DROPPED_POLL_MS;
      return !Number.isFinite(x.lastChecked) || now - x.lastChecked >= every - 1_000;
    };
    const check = async () => {
      for (const txid of txids) {
        const before = pendingsRef.current.find((x) => x.txid === txid);
        if (!before || !due(before, Date.now())) continue;
        let s;
        try {
          s = await indexer.txStatus(txid);
        } catch (e) {
          if (!alive) return;
          setPendings((l) => updatePendingMine(l, txid, (x) => ({ ...x, pollError: friendlyError(e), lastChecked: Date.now() })));
          continue;
        }
        if (!alive) return;
        const cur = pendingsRef.current.find((x) => x.txid === txid);
        if (!cur) continue;
        let next = applyMineStatus(cur, s, Date.now(), DROP_GRACE_MS, { trustUnseen: trustRef.current });
        if (next.phase === "dropped" && cur.phase === "pending") {
          // Before giving it up: the indexer's ledger may already hold it
          // (confirmed while its node did not report the tx).
          try {
            const row = await indexer.mineByTxid(txid);
            if (!alive) return;
            if (row) next = confirmedFromRow(cur, row);
          } catch {
            next = { ...cur, lastChecked: Date.now() }; // unknown — ask again next time
          }
        }
        if (next === cur) continue;
        // Given up: its record goes, but the item keeps the inputs — seen
        // again or confirmed after all, the record comes back and guards them
        // (until final) so no later build spends them again.
        if (address && next.phase === "dropped" && cur.phase !== "dropped") next = { ...next, inputs: txRecords(address).find((r) => r.txid === txid)?.inputs ?? [] };
        setPendings((l) => updatePendingMine(l, txid, (x) => (x === cur || x.phase === cur.phase ? withDepth(next, tip) : x)));
        if (!address) continue;
        if (cur.phase === "dropped" && next.phase !== "dropped" && Array.isArray(cur.inputs)) recordBroadcastTx(address, { txid, kind: "mine", ticker: cur.ticker, inputs: cur.inputs });
        if (next.phase === "dropped" && cur.phase !== "dropped") {
          forgetTx(address, txid);
        } else if (next.phase === "confirmed" && (cur.phase !== "confirmed" || next.blockHash !== cur.blockHash)) {
          // The record stays until the block is final and the credit shown:
          // leaving the page before that still resumes this MINE.
          markTxConfirmed(address, txid, next.blockHeight);
          settledRef.current?.();
        } else if (next.phase === "pending" && cur.phase === "confirmed") {
          // Back in the mempool (a chain reorganization): guarded again.
          markTxUnconfirmed(address, txid);
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
  }, [watchKey, address, tip]);

  // Confirmed items → reconcile with /mines/by-txid (the indexer is
  // authoritative), each on its own attempt budget — per block: a chain
  // reorganization that moves the MINE starts a new one.
  const attemptsRef = useRef(new Map());
  const reconcileKey = pendings
    .filter((x) => x.phase === "confirmed" && x.reconcile === "pending")
    .map((x) => `${x.txid}@${x.blockHash}`)
    .join(",");
  useEffect(() => {
    if (!reconcileKey) return undefined;
    let alive = true;
    const keys = reconcileKey.split(",");
    const finish = (key, verdict) => {
      const txid = key.split("@")[0];
      attemptsRef.current.delete(key);
      setPendings((l) => updatePendingMine(l, txid, (x) => withDepth(applyReconcile(x, verdict), tip)));
    };
    const check = async () => {
      for (const key of keys) {
        const txid = key.split("@")[0];
        const n = (attemptsRef.current.get(key) || 0) + 1;
        attemptsRef.current.set(key, n);
        try {
          const row = await indexer.mineByTxid(txid);
          if (!alive) return;
          if (row) {
            finish(key, row);
            settledRef.current?.();
            continue;
          }
        } catch {
          /* transient — retry on the next tick */
        }
        if (alive && n >= RECONCILE_MAX_ATTEMPTS) finish(key, "timeout");
      }
    };
    check();
    const id = setInterval(check, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [reconcileKey, address, tip]);

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
