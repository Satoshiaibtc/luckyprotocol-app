import { useCallback, useEffect, useRef, useState } from "react";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { buildMinePsbt, buildSpeedUpPsbt, decodeAddress, expectPsbtPayload, filterSpendable, inputCostSats, minFeeInputSats, outpointKey } from "../lib/psbt.js";
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
  mineSpeedUpState,
  mineVersions,
  newPendingMine,
  pickMineVersion,
  resumeMinePendings,
  switchMineVersion,
  updatePendingMine,
  withDepth,
} from "../lib/minePending.js";
import { friendlyError } from "./useWallet.js";
import { useSeedWait } from "./useSeedWait.js";
import { seedWaitNote } from "../lib/retry.js";

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
 * result the console has not shown yet, as a resumed "pending" state.
 * The console itself resumes EVERY such MINE
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
 * How many confirmed outputs of `utxos` could still pay for another MINE
 * once `used` (the inputs of the one just built) are spent: not a token
 * carrier, above the list's fee-input floor, and worth more than their own
 * input fee at `feeRate`. → a count.
 */
export function spareFeeInputs({ utxos, tokenOutpoints, used, assetSafe, address, feeRate }) {
  let type = "tr";
  try {
    type = decodeAddress(address).type;
  } catch {
    type = "tr";
  }
  const spent = new Set((used || []).map(outpointKey));
  const floor = inputCostSats(type, feeRate);
  return filterSpendable(utxos, tokenOutpoints, { minSats: minFeeInputSats(assetSafe) }).filter((u) => !spent.has(outpointKey(u)) && Number(u.sats) > floor).length;
}

/**
 * The mine console's state:
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
 *
 * `spare` = how many other fee inputs the wallet had left after the last
 * MINE built here (null = not known): 0 means the next MINE has to wait
 * for a pending one's change to confirm.
 *
 * Speed up (`speedUp(txid, rate)`, preview `speedUpQuote(txid, rate)`): a
 * MINE still waiting for a block is replaced by the same transaction —
 * same inputs, same outputs, the same MINE payload — paying a higher fee
 * taken from its BTC change (psbt.buildSpeedUpPsbt). The item follows the
 * new txid and keeps asking about the versions it replaced: a miner may
 * still confirm one of them, and then that one is the MINE (its block, its
 * digit, its credit).
 */
export function useMine({ wallet: walletState, ticker, tokenInfo, feeRateSatVb, onSettled, tip = null, trustUnseen = true, incrementalRelayFee = undefined }) {
  const [flow, setFlow] = useState(IDLE_MINE);
  const [pendings, setPendings] = useState([]);
  const [spare, setSpare] = useState(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const pendingsRef = useRef(pendings);
  pendingsRef.current = pendings;
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const trustRef = useRef(trustUnseen);
  trustRef.current = trustUnseen;
  const seedWait = useSeedWait();

  // A wallet change or disconnect abandons the flow (and any wait for the
  // indexer's scan of the old address); this ticker's MINEs whose result
  // has not been shown are resumed from the broadcast records.
  const address = walletState.status === "connected" ? walletState.address : null;
  useEffect(() => {
    seedWait.stop();
    setFlow(IDLE_MINE);
    setSpare(null);
    setPendings(address ? resumeMinePendings(txRecords(address), ticker) : []);
  }, [address, ticker, seedWait]);

  const startMine = useCallback(async () => {
    if (walletState.status !== "connected" || !tokenInfo) return;
    if (MINE_FLOW_BUSY.has(flowRef.current.phase)) return; // one wallet prompt at a time
    const { address: addr, pubkeyHex } = walletState;
    const startedAt = Date.now(); // keys the terminal's per-attempt lines
    setFlow({ phase: "building", ticker, startedAt });
    let utxoRes = null;
    const signal = seedWait.begin();
    try {
      if (!isUsableFeeRate(feeRateSatVb)) {
        throw new Error("No fee rate — neither the indexer nor mempool.space has an estimate; pick Custom and enter a sat/vB.");
      }
      const onWait = (info) => setFlow((m) => (m.phase === "building" ? { ...m, waitNote: seedWaitNote(info) } : m));
      // getBitcoinUtxos drops the inputs of every broadcast that has not
      // confirmed yet — the earlier MINEs in the pending list included.
      const [utxoList, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(addr, { onWait, signal }), indexer.tokenUtxos(addr, signal)]);
      seedWait.done(signal);
      utxoRes = utxoList;
      const tokenOutpoints = withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), addr);
      const built = buildMinePsbt({
        address: addr,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints,
        feeRateSatVb,
        ticker,
        minInputSats: minFeeInputSats(utxoRes.assetSafe), // 10,000-sat floor on non-asset-safe lists
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
      // The unsigned PSBT and its change output ride with the record: a Speed up rebuilds from them, also after a reload.
      const meta = { kind: "mine", ticker, address: addr, psbt: built.psbtHex, changeVout: built.changeVout ?? null };
      const item = (txid) => newPendingMine({ txid, ticker, psbt: built.psbtHex, changeVout: built.changeVout ?? null });
      setSpare(spareFeeInputs({ utxos: utxoRes.utxos, tokenOutpoints, used: built.inputs, assetSafe: utxoRes.assetSafe, address: addr, feeRate: built.feeRateSatVb }));
      let txid;
      try {
        txid = await wallet.broadcastSignedPsbt(signed, meta);
      } catch (e) {
        // Neither relay confirmed it, but it may still reach the network (it
        // is recorded): it joins the list and is followed like any other —
        // seen, confirmed, or given up after the grace period.
        if (e?.recorded && e.txid) {
          addPendingTokenOutpoints([{ txid: e.txid, vout: 0 }], addr);
          setPendings((l) => addPendingMine(l, item(e.txid)));
        }
        throw e;
      }
      addPendingTokenOutpoints([{ txid, vout: 0 }], addr);
      // Into the pending list; the button is free again for the next MINE.
      setPendings((l) => addPendingMine(l, item(txid)));
      setFlow(IDLE_MINE);
    } catch (e) {
      // Stop waiting (or the page left): back to idle, nothing to report.
      if (signal.aborted) {
        setFlow((m) => (m.startedAt === startedAt ? IDLE_MINE : m));
        return;
      }
      const error = fundingMessage(e, utxoRes, { action: "this MINE" }) ?? friendlyError(e);
      setFlow((m) => ({ ...m, phase: "error", error }));
    } finally {
      seedWait.done(signal);
    }
  }, [walletState, tokenInfo, ticker, feeRateSatVb, seedWait]);

  /** The replacement a Speed up of pending MINE `txid` at `rate` would sign, `{ error, code }` when it cannot, or null. Pure preview. */
  const speedUpQuote = useCallback(
    (txid, rate) => {
      const x = pendingsRef.current.find((p) => p.txid === txid);
      if (!x || mineSpeedUpState(x) === "no") return null;
      try {
        return buildSpeedUpPsbt({ psbtHex: x.psbt, changeVout: x.changeVout, feeRateSatVb: rate, incrementalRelayFee });
      } catch (e) {
        return { error: String(e?.message || e), code: e?.code || null };
      }
    },
    [incrementalRelayFee],
  );

  /** Replace pending MINE `txid` with a copy that pays `rate` sat/vB (same inputs, outputs and payload) and follow it. */
  const speedUp = useCallback(
    async (txid, rate) => {
      const x = pendingsRef.current.find((p) => p.txid === txid);
      if (!x || !address || x.speeding || mineSpeedUpState(x) !== "yes") return;
      const set = (fn) => setPendings((l) => updatePendingMine(l, txid, fn));
      set((p) => ({ ...p, speeding: "building", speedError: null }));
      try {
        const st = await indexer.txStatus(txid);
        if (st && st.confirmed) throw new Error("It has just confirmed — no need to speed it up.");
        const q = buildSpeedUpPsbt({ psbtHex: x.psbt, changeVout: x.changeVout, feeRateSatVb: rate, incrementalRelayFee });
        // The same guard as the first signature: one OP_RETURN, a MINE of this ticker.
        expectPsbtPayload(q.psbtHex, { op: "MINE", ticker: x.ticker });
        set((p) => ({ ...p, speeding: "signing" }));
        // A replacement: the inputs of every version it replaces may be spent
        // again — an earlier one whose faster copy was never confirmed as
        // sent still keeps its record.
        const signed = await wallet.signPsbt(q.psbtHex, { inputIndexes: q.inputIndexes, address, replaces: mineVersions(x) });
        set((p) => ({ ...p, speeding: "broadcasting" }));
        const replaces = [...(x.replaces || []), txid];
        let newTxid;
        let unsure = null;
        try {
          newTxid = await wallet.broadcastSignedPsbt(signed, { kind: "mine", ticker: x.ticker, address, psbt: q.psbtHex, changeVout: x.changeVout, replaces });
        } catch (e) {
          // Neither relay confirmed the faster version, but it may still
          // reach the network (it is recorded): the item follows it and
          // keeps asking about the earlier one.
          if (!(e?.recorded && e.txid)) throw e;
          newTxid = e.txid;
          unsure = e;
        }
        // The replacement spends the same inputs: its record guards them now
        // (the earlier record stays while the faster one is not seen).
        if (!unsure) forgetTx(address, txid);
        addPendingTokenOutpoints([{ txid: newTxid, vout: 0 }], address);
        const now = Date.now();
        setPendings((l) =>
          updatePendingMine(l, txid, (p) => ({
            ...p,
            txid: newTxid,
            psbt: q.psbtHex,
            replaces,
            unseenSince: now,
            lastChecked: null,
            pollError: null,
            speeding: null,
            speedError: unsure ? friendlyError(unsure) : null,
            feeSats: q.feeSats,
            feeRateSatVb: q.feeRateSatVb,
          })),
        );
      } catch (e) {
        set((p) => ({ ...p, speeding: null, speedError: friendlyError(e) }));
      }
    },
    [address, incrementalRelayFee],
  );

  /** Clear the flow's error (the pending list is untouched). */
  const resetMine = useCallback(() => setFlow((f) => (MINE_FLOW_BUSY.has(f.phase) ? f : IDLE_MINE)), []);
  /** Stop waiting for the indexer's scan of this wallet (the flow returns to idle). */
  const stopWaiting = seedWait.stop;
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
  // not seen for DROP_GRACE_MS is dropped / replaced — not
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
        // A MINE that was sped up: while it is not confirmed, every earlier
        // version is asked about too — the one a block confirms is the MINE.
        let version = txid;
        if (before.phase !== "confirmed" && before.replaces?.length && !(s && s.confirmed)) {
          const answers = [{ txid, status: s }];
          for (const v of mineVersions(before).slice(1)) {
            let vs = null;
            try {
              vs = await indexer.txStatus(v);
            } catch {
              vs = null;
            }
            answers.push({ txid: v, status: vs });
          }
          if (!alive) return;
          const pick = pickMineVersion(before, answers);
          version = pick.txid;
          s = pick.status ?? s;
        }
        const cur0 = pendingsRef.current.find((x) => x.txid === txid);
        if (!cur0) continue;
        const cur = switchMineVersion(cur0, version);
        let next = applyMineStatus(cur, s, Date.now(), DROP_GRACE_MS, { trustUnseen: trustRef.current });
        if (next.phase === "dropped" && cur.phase === "pending") {
          // Before giving it up: the indexer's ledger may already hold it
          // (confirmed while its node did not report the tx) — any version of it.
          try {
            for (const v of mineVersions(cur)) {
              const row = await indexer.mineByTxid(v);
              if (!alive) return;
              if (row) {
                next = confirmedFromRow(switchMineVersion(cur, v), row);
                break;
              }
            }
          } catch {
            next = { ...cur, lastChecked: Date.now() }; // unknown — ask again next time
          }
        }
        if (next === cur && cur === cur0) continue;
        if (address && next.txid !== txid) {
          // An earlier version confirmed instead of the faster one: its
          // record (the same inputs) takes over the guard.
          const inputs = txRecords(address).find((r) => r.txid === txid)?.inputs ?? [];
          recordBroadcastTx(address, { txid: next.txid, kind: "mine", ticker: cur.ticker, inputs });
          forgetTx(address, txid);
          addPendingTokenOutpoints([{ txid: next.txid, vout: 0 }], address);
        }
        // Given up: its record goes, but the item keeps the inputs — seen
        // again or confirmed after all, the record comes back and guards them
        // (until final) so no later build spends them again.
        if (address && next.phase === "dropped" && cur.phase !== "dropped") next = { ...next, inputs: txRecords(address).find((r) => r.txid === txid)?.inputs ?? [] };
        setPendings((l) => updatePendingMine(l, txid, (x) => (x === cur0 || x.phase === cur0.phase ? withDepth(next, tip) : x)));
        if (!address) continue;
        const t = next.txid;
        if (cur.phase === "dropped" && next.phase !== "dropped" && Array.isArray(cur.inputs)) recordBroadcastTx(address, { txid: t, kind: "mine", ticker: cur.ticker, inputs: cur.inputs });
        if (next.phase === "dropped" && cur.phase !== "dropped") {
          forgetTx(address, t);
        } else if (next.phase === "confirmed" && (cur.phase !== "confirmed" || next.blockHash !== cur.blockHash)) {
          // The record stays until the block is final and the credit shown:
          // leaving the page before that still resumes this MINE.
          markTxConfirmed(address, t, next.blockHeight);
          // A change output confirmed: what the wallet can spend next is not known any more.
          if (cur.phase !== "confirmed") setSpare(null);
          settledRef.current?.();
        } else if (next.phase === "pending" && cur.phase === "confirmed") {
          // Back in the mempool (a chain reorganization): guarded again.
          markTxUnconfirmed(address, t);
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
    spare,
    startMine,
    resetMine,
    stopWaiting,
    dismissMine,
    clearFinished,
    speedUp,
    speedUpQuote,
    busy: MINE_FLOW_BUSY.has(flow.phase),
  };
}
