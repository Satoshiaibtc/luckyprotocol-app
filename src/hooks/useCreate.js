import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { useTxStatus } from "./useTxStatus.js";
import { friendlyError } from "./useWallet.js";
import { useSeedWait } from "./useSeedWait.js";
import { seedWaitNote } from "../lib/retry.js";
import { RBF_SEQUENCE, buildDeployPsbt, buildSpeedUpPsbt, expectPsbtPayload, minFeeInputSats } from "../lib/psbt.js";
import { PROTOCOL_LOCKTIME } from "../lib/payloads.js";
import { withPending } from "../lib/pending.js";
import { forgetTx, markTxConfirmed, recordBroadcastTx, refreshTxRecords, txRecords } from "../lib/txrecords.js";
import { chainTipOf, syncRetryText, syncStateOf } from "../lib/sync.js";
import { isUsableFeeRate } from "../lib/feechoice.js";
import { activationNotice, activationState } from "../lib/activation.js";
import { fundingMessage } from "../lib/funding.js";
import {
  addSettlingNote,
  claimReview,
  clearUnusedDeployKeys,
  deployHeadroom,
  deployMissedBlock,
  deployReleased,
  deployVerdict,
  deployVersions,
  followSeenVersion,
  isOwnVerdict,
  ownDeployText,
  removeSettlingNote,
  resolveVersions,
  rowIsFinal,
  settlingNotes,
  settlingVerdict,
  updateSettlingNote,
} from "../lib/createFlow.js";
import {
  DEPLOY_BUSY,
  acceptedLine,
  broadcastingLine,
  createdFinalLine,
  createdReorgLine,
  deployBuildLine,
  deployConfirmedLine,
  deployMempoolLine,
  deployResumedLine,
  deployedLine,
  errorLine,
  missedBlockLine,
  registrationLine,
  resumeDeployState,
  signLine,
  speedUpLine,
  stepDroppedLine,
  stepFoundLine,
  stepUnseenLine,
  takenWhilePendingLine,
} from "../lib/deploylog.js";

const POLL_MS = 15_000;
const REGISTRY_POLL_MS = 15_000;
const REGISTRY_MAX_ATTEMPTS = 8;
export const IDLE_CREATE = { phase: "idle" };

/**
 * This browser's own earlier DEPLOY of `ticker` from `address` that has not
 * been seen to settle (src/lib/txrecords.js), re-checked against
 * /tx-status: `{ txid, state }` or null. A dropped one is forgotten on the
 * way (and reads as null).
 */
export async function ownDeployFor(address, ticker) {
  if (!address) return null;
  if (!txRecords(address).some((r) => r.kind === "deploy" && r.ticker === ticker && !r.done)) return null;
  const recs = await refreshTxRecords(address, (txid) => indexer.txStatus(txid));
  const rec = [...recs].reverse().find((r) => r.kind === "deploy" && r.ticker === ticker && !r.done);
  return rec ? { txid: rec.txid, state: rec.state } : null;
}

/** Ask the indexer about every version: `[{ txid, status }]` (status null when it could not be asked). */
async function versionAnswers(txids) {
  return Promise.all(
    txids.map(async (txid) => {
      try {
        return { txid, status: await indexer.txStatus(txid) };
      } catch {
        return { txid, status: null };
      }
    }),
  );
}

/**
 * The Create page's DEPLOY (PROTOCOL.md §2.1): one transaction that names
 * the ticker. Only the connected address's DEPLOYs are tracked.
 *
 *   create(ticker, rate)   re-check (activation, sync, the ticker, a DEPLOY of it
 *                          already pending here), build (largest inputs first, so
 *                          the change can pay a Speed up), then sign and broadcast —
 *                          or stop at "review" when the change leaves too little
 *                          room for a Speed up (`flow.headroom`)
 *   confirmCreate()        sign and broadcast the reviewed DEPLOY (the user ticked
 *                          "Create anyway")
 *   cancelReview()         drop the reviewed DEPLOY (nothing was signed)
 *   speedUp(rate)          replace the pending DEPLOY with a higher-fee copy (RBF)
 *   speedUpQuote(rate)     that replacement's fee, without signing
 *   dismiss()              clear a finished result or an error
 *   dismissSettling(txid)  stop following a result (its settling note)
 *
 * `flow.phase`: idle → building → (review →) signing → broadcasting →
 * pending → confirmed → done (`flow.verdict`: registered | registered-own |
 * taken | unindexed); a pending DEPLOY every version of which left the
 * node's mempool is `released`; any failure is `error`.
 *
 * A pending DEPLOY is judged by ALL its versions (`flow.versions`, newest
 * first): after a Speed up the replaced version always leaves the mempool,
 * and a miner may still confirm any of them. One `useTxStatus` follows the
 * newest version; next to it the versions are asked about together while
 * the newest is unseen, the DEPLOY has been sped up, or no relay confirmed
 * its broadcast. While pending, the registry is read on every new indexed
 * block: another DEPLOY of the ticker registered meanwhile is `flow.takenRow`
 * (no Speed up then). Every result stays provisional until its block is
 * FINAL_DEPTH deep: a settling note (src/lib/createFlow.js) follows it.
 */
export function useCreate({ address, pubkeyHex, providerName, tip, indexed, trustUnseen = true, incrementalRelayFee, requested = null, log, onSettled }) {
  const [flow, setFlow] = useState(IDLE_CREATE);
  const [otherPending, setOtherPending] = useState(null);
  const [settling, setSettling] = useState(() => (address ? settlingNotes(address) : []));
  const [speeding, setSpeeding] = useState(null); // null | "building" | "signing" | "broadcasting"
  const [speedError, setSpeedError] = useState(null);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const logRef = useRef(log);
  logRef.current = log;
  const emit = useCallback((l) => logRef.current?.(l), []);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const tipRef = useRef(tip);
  tipRef.current = tip;
  const indexedRef = useRef(indexed);
  indexedRef.current = indexed;
  const trustRef = useRef(trustUnseen);
  trustRef.current = trustUnseen;
  const requestedRef = useRef(requested);
  requestedRef.current = requested;
  const reviewRef = useRef(null);
  const seedWait = useSeedWait();

  // ---- mount / account switch: unused keys go, the newest unsettled DEPLOY resumes ----------
  useEffect(() => {
    seedWait.stop();
    reviewRef.current = null;
    setSpeeding(null);
    setSpeedError(null);
    clearUnusedDeployKeys(undefined, address);
    const notes = address ? settlingNotes(address) : [];
    setSettling(notes);
    // A released DEPLOY is followed by its settling note, not resumed.
    const released = new Set(notes.filter((n) => n.origin === "released").flatMap((n) => n.versions));
    const resumed = address ? resumeDeployState(txRecords(address).filter((r) => !r.done && !released.has(r.txid))) : null;
    const want = requestedRef.current;
    if (resumed && (!want || want === resumed.ticker)) {
      setOtherPending(null);
      setFlow({ ...resumed, sentTip: Number.isInteger(tipRef.current) ? tipRef.current : null, unseenSince: null });
      emit(deployResumedLine(resumed.ticker, resumed.txid, resumed.broadcastAt));
    } else {
      setOtherPending(resumed);
      setFlow(IDLE_CREATE);
    }
  }, [address, emit, seedWait]);

  // A resumed DEPLOY takes the tip it is first seen at as its send tip (missed-block notice).
  useEffect(() => {
    if (flow.phase === "pending" && !Number.isInteger(flow.sentTip) && Number.isInteger(tip)) setFlow((f) => (f.phase === "pending" && !Number.isInteger(f.sentTip) ? { ...f, sentTip: tip } : f));
  }, [flow.phase, flow.sentTip, tip]);

  // ---- build → (review →) sign → broadcast ---------------------------------------------------------
  const signAndSend = useCallback(
    async (ctx) => {
      const { built, utxoRes, startedAt, ticker: t } = ctx;
      const info = {
        feeSats: built.feeSats,
        feeRateSatVb: built.feeRateSatVb,
        vsize: built.estimatedVsize,
        inputCount: built.inputIndexes.length,
        inputs: built.inputs,
        assetSafe: utxoRes.assetSafe,
        utxoSource: utxoRes.source,
      };
      setFlow({ phase: "signing", ticker: t, startedAt, ...info });
      emit(deployBuildLine({ startedAt, ...info }, t));
      emit(signLine(providerName, startedAt));
      // Sign-time guard: one OP_RETURN, a DEPLOY of this ticker, the protocol
      // lock time, replace-by-fee on every input, and the reference layout.
      expectPsbtPayload(built.psbtHex, { op: "DEPLOY", ticker: t, lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self: address } });
      const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
      setFlow((f) => (f.startedAt === startedAt ? { ...f, phase: "broadcasting" } : f));
      emit(broadcastingLine(startedAt));
      // The unsigned PSBT and its change output ride with the record: a Speed up rebuilds from them, also after a reload.
      const meta = { kind: "deploy", ticker: t, address, psbt: built.psbtHex, changeVout: built.changeVout ?? null };
      const sentTip = Number.isInteger(tipRef.current) ? tipRef.current : null;
      let txid;
      let unsent = null;
      try {
        txid = await wallet.broadcastSignedPsbt(signed, meta);
      } catch (e) {
        // Neither relay confirmed it, but it may still reach the network (it
        // is recorded): it is followed like a sent one.
        if (!(e?.recorded && e.txid)) throw e;
        txid = e.txid;
        unsent = friendlyError(e);
      }
      reviewRef.current = null;
      setFlow({
        phase: "pending",
        ticker: t,
        startedAt,
        txid,
        versions: [txid],
        psbt: built.psbtHex,
        changeVout: built.changeVout ?? null,
        broadcastAt: Date.now(),
        sentTip,
        unsent: !!unsent,
        unseenSince: null,
        ...info,
      });
      if (unsent) emit(errorLine(unsent, startedAt));
      else emit(acceptedLine(txid));
      emit(deployMempoolLine(t, Number.isInteger(sentTip) ? sentTip + 1 : null, txid));
    },
    [address, providerName, emit],
  );

  const fail = useCallback(
    (e, utxoRes, startedAt) => {
      const message = e?.code === "busy" ? e.message : fundingMessage(e, utxoRes, { action: "this DEPLOY" }) ?? friendlyError(e);
      emit(errorLine(message, startedAt));
      setFlow((f) => ({ ...f, phase: "error", error: message, errorAt: f.phase }));
    },
    [emit],
  );

  /** Create `t` at `rate` sat/vB (the headroom review of the Create page). */
  const create = useCallback(
    async (t, rate) => {
      if (!address) return;
      const cur = flowRef.current.phase;
      if (DEPLOY_BUSY.has(cur) || cur === "pending" || cur === "confirmed") return;
      const startedAt = Date.now();
      reviewRef.current = null;
      setSpeedError(null);
      setFlow({ phase: "building", ticker: t, startedAt, rate });
      let utxoRes = null;
      const signal = seedWait.begin();
      try {
        if (!isUsableFeeRate(rate)) throw new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.");
        // Re-checked at the moment of the click, not from the last poll: the
        // protocol is (about to be) active, the indexer has applied the tip,
        // the ticker is still absent, and this browser has no pending DEPLOY of it.
        const [h, row] = await Promise.all([indexer.health(), indexer.token(t)]);
        const tipNow = chainTipOf(h);
        if (activationState(tipNow).locked) throw new Error(activationNotice(tipNow, "Creating a ticker"));
        const fresh = syncStateOf(h);
        if (!fresh.synced) throw new Error(syncRetryText(fresh, `${t}'s availability`));
        if (row) throw new Error(`${t} is already deployed (tx ${String(row.deploy_txid).slice(0, 12)}…) — a second DEPLOY is ignored and only costs fees.`);
        const own = await ownDeployFor(address, t);
        if (own) throw new Error(ownDeployText(t, own));
        const onWait = (info) => setFlow((f) => (f.phase === "building" && f.startedAt === startedAt ? { ...f, waitNote: seedWaitNote(info) } : f));
        const [list, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(address, { onWait, signal }), indexer.tokenUtxos(address, signal)]);
        seedWait.done(signal);
        utxoRes = list;
        // Largest inputs first: the fewest inputs and the largest change —
        // the change is what a Speed up takes its extra fee from.
        const built = buildDeployPsbt({
          address,
          pubkeyHex,
          utxos: utxoRes.utxos,
          tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), address),
          feeRateSatVb: rate,
          ticker: t,
          minInputSats: minFeeInputSats(utxoRes.assetSafe),
          selectionOrder: "largest",
        });
        const ctx = { built, utxoRes, startedAt, ticker: t, rate };
        const headroom = deployHeadroom(built, built.feeRateSatVb);
        if (headroom) {
          // Signed only after the user acknowledged it (confirmCreate).
          reviewRef.current = ctx;
          setFlow({
            phase: "review",
            ticker: t,
            startedAt,
            rate,
            headroom,
            feeSats: built.feeSats,
            feeRateSatVb: built.feeRateSatVb,
            vsize: built.estimatedVsize,
            inputCount: built.inputIndexes.length,
            inputs: built.inputs,
            assetSafe: utxoRes.assetSafe,
            utxoSource: utxoRes.source,
          });
          return;
        }
        await signAndSend(ctx);
      } catch (e) {
        // Stop waiting, an account switch or the page left: back to idle, nothing to report.
        if (signal.aborted) {
          setFlow((f) => (f.startedAt === startedAt ? IDLE_CREATE : f));
          return;
        }
        fail(e, utxoRes, startedAt);
      } finally {
        seedWait.done(signal);
      }
    },
    [address, pubkeyHex, seedWait, signAndSend, fail],
  );

  /** Sign and broadcast the reviewed DEPLOY (its Speed up headroom was acknowledged). */
  const confirmCreate = useCallback(async () => {
    // Claimed before the first await: a second click returns here.
    const ctx = claimReview(reviewRef, flowRef.current);
    if (!ctx) return;
    try {
      // The name may have been taken while the warning was read.
      const row = await indexer.token(ctx.ticker);
      if (row) throw new Error(`${ctx.ticker} is already deployed (tx ${String(row.deploy_txid).slice(0, 12)}…) — a second DEPLOY is ignored and only costs fees.`);
      // Cancelled while the name was checked: nothing to sign.
      if (flowRef.current.phase !== "review" || flowRef.current.startedAt !== ctx.startedAt) return;
      await signAndSend(ctx);
    } catch (e) {
      reviewRef.current = null;
      fail(e, ctx.utxoRes, ctx.startedAt);
    }
  }, [signAndSend, fail]);

  /** Drop a reviewed DEPLOY: nothing was signed. */
  const cancelReview = useCallback(() => {
    reviewRef.current = null;
    setFlow((f) => (f.phase === "review" ? IDLE_CREATE : f));
  }, []);

  // ---- tracking a pending DEPLOY ----------------------------------------------------------------------
  const tracked = flow.phase === "pending" || flow.phase === "confirmed" ? flow.txid : null;
  const status = useTxStatus(tracked, {
    since: flow.broadcastAt ?? null,
    onConfirmed: (s) => {
      const f = flowRef.current;
      if (f.phase !== "pending" || !Number.isInteger(s?.block_height)) return;
      setFlow((x) => (x.phase === "pending" && x.txid === f.txid ? { ...x, phase: "confirmed", height: s.block_height, unsent: false, unseenSince: null } : x));
      emit(deployConfirmedLine(f.ticker, s.block_height, f.txid));
      settledRef.current?.();
    },
    onReorg: (kind) => {
      // Back in the mempool: pending again (Speed up and the missed-block notice return).
      if (kind !== "mempool") return;
      setFlow((x) => (x.phase === "confirmed" ? { ...x, phase: "pending", height: null, sentTip: Number.isInteger(tipRef.current) ? tipRef.current : null } : x));
    },
  });
  const newestUnseen = flow.phase === "pending" && status.dropped;
  const newestUnseenRef = useRef(newestUnseen);
  newestUnseenRef.current = newestUnseen;
  const [unseenAt, setUnseenAt] = useState(null);
  useEffect(() => {
    if (!newestUnseen) {
      setUnseenAt(null);
      return;
    }
    setUnseenAt((u) => u ?? Date.now());
    if (flowRef.current.txid) emit(stepUnseenLine("DEPLOY", flowRef.current.txid));
  }, [newestUnseen, emit]);

  // The version poll: every version together, while the newest is unseen,
  // the DEPLOY has been sped up, or no relay confirmed its broadcast.
  const versionsKey = flow.phase === "pending" ? deployVersions(flow).join(",") : "";
  const watchVersions = flow.phase === "pending" && (newestUnseen || (flow.versions?.length ?? 0) > 1 || flow.unsent);
  useEffect(() => {
    if (!watchVersions || !versionsKey || !address) return undefined;
    let alive = true;
    const check = async () => {
      const f0 = flowRef.current;
      const results = await versionAnswers(versionsKey.split(","));
      if (!alive) return;
      const f = flowRef.current;
      if (f.phase !== "pending" || f.startedAt !== f0.startedAt) return;
      const v = resolveVersions(results);
      if (v.kind === "confirmed") {
        setFlow((x) => (x.phase === "pending" && x.startedAt === f.startedAt ? { ...x, phase: "confirmed", txid: v.txid, height: v.height, unsent: false, unseenSince: null } : x));
        if (v.txid !== f.txid) emit(stepFoundLine("DEPLOY", v.txid, v.height));
        emit(deployConfirmedLine(f.ticker, v.height, v.txid));
        settledRef.current?.();
        return;
      }
      if (v.kind === "seen") {
        // Right after a Speed up the node still holds the replaced version
        // until the new one reaches it: keep following the tracked version
        // unless it has been unseen for DROP_GRACE_MS.
        if (!followSeenVersion(v.txid, f.txid, newestUnseenRef.current)) return;
        if (v.txid !== f.txid) emit(stepFoundLine("DEPLOY", v.txid, null));
        setFlow((x) => (x.phase === "pending" && x.startedAt === f.startedAt ? { ...x, txid: v.txid, unsent: false, unseenSince: null } : x));
        return;
      }
      if (v.kind !== "none") return;
      const now = Date.now();
      const trusted = trustRef.current;
      const since = trusted ? (Number.isFinite(f.unseenSince) ? f.unseenSince : now) : null;
      if (deployReleased(results, { unseenSince: since, now, trustUnseen: trusted })) {
        // Every version has been unknown to the node for DROP_GRACE_MS: the
        // flow ends, and a note keeps the versions (one may still confirm).
        const versions = deployVersions(f);
        setSettling(addSettlingNote(address, { ticker: f.ticker, txid: f.txid, versions, height: null, origin: "released" }));
        emit(stepDroppedLine("DEPLOY", f.txid));
        setFlow({ phase: "released", ticker: f.ticker, txid: f.txid, versions });
        return;
      }
      if (since !== f.unseenSince) setFlow((x) => (x.phase === "pending" && x.startedAt === f.startedAt ? { ...x, unseenSince: since } : x));
    };
    check();
    const id = setInterval(check, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [watchVersions, versionsKey, address, emit]);

  // A block came without the pending DEPLOY: one log line per such block.
  const missed = flow.phase === "pending" && deployMissedBlock({ sentTip: flow.sentTip, height: flow.height, unseen: newestUnseen }, tip);
  useEffect(() => {
    if (!missed) return;
    const f = flowRef.current;
    if (f.txid && !f.takenRow) emit(missedBlockLine(f.ticker, f.txid, tip));
  }, [missed, tip, emit]);

  // While pending: the registry on every new indexed block. Another DEPLOY
  // of the ticker registered meanwhile → the taken-while-pending notice (no Speed up); one of
  // ours (or of this address) → the registry decides at once.
  const pendingTicker = flow.phase === "pending" ? flow.ticker : null;
  useEffect(() => {
    if (!pendingTicker || !address) return undefined;
    let alive = true;
    (async () => {
      let row;
      try {
        row = await indexer.token(pendingTicker);
      } catch {
        return; // unknown — asked again on the next block
      }
      if (!alive) return;
      const f = flowRef.current;
      if (f.phase !== "pending" || f.ticker !== pendingTicker) return;
      if (!row) {
        if (f.takenRow) setFlow((x) => (x.phase === "pending" ? { ...x, takenRow: null } : x));
        return;
      }
      const verdict = deployVerdict(row, deployVersions(f), address);
      if (verdict === "taken") {
        if (!f.takenRow || f.takenRow.deploy_txid !== row.deploy_txid) emit(takenWhilePendingLine(f.ticker, `${f.startedAt}:${row.deploy_txid}`));
        setFlow((x) => (x.phase === "pending" ? { ...x, takenRow: row } : x));
        return;
      }
      // Ours: the registry listed it before the tx-status poll saw the block.
      const height = Number.isInteger(row.deploy_block) ? row.deploy_block : null;
      const txid = verdict === "registered" ? String(row.deploy_txid).toLowerCase() : f.txid;
      setFlow((x) => (x.phase === "pending" ? { ...x, phase: "confirmed", txid, height, unsent: false, unseenSince: null, takenRow: null } : x));
      if (height !== null) emit(deployConfirmedLine(f.ticker, height, txid));
    })();
    return () => {
      alive = false;
    };
  }, [pendingTicker, indexed, address, emit]);

  // ---- confirmed → the registry's verdict ------------------------------------------------------------
  const confirmedKey = flow.phase === "confirmed" ? `${flow.ticker}:${flow.txid}` : null;
  useEffect(() => {
    if (!confirmedKey || !address) return undefined;
    let alive = true;
    let attempts = 0;
    let id = null;
    const settle = (row) => {
      const f = flowRef.current;
      const versions = deployVersions(f);
      const verdict = deployVerdict(row, versions, address);
      const ownTxid = String(row.deploy_txid || "").toLowerCase();
      const height = Number.isInteger(row.deploy_block) ? row.deploy_block : f.height ?? null;
      // The records have done their job: a confirmed one keeps guarding its
      // inputs until final (marked done), the others go.
      const inputs = txRecords(address).find((r) => versions.includes(r.txid))?.inputs ?? [];
      for (const v of versions) {
        if (verdict === "registered" && v === ownTxid) {
          if (!txRecords(address).some((r) => r.txid === v)) recordBroadcastTx(address, { txid: v, kind: "deploy", ticker: f.ticker, inputs });
          markTxConfirmed(address, v, height);
        }
        forgetTx(address, v);
      }
      const final = rowIsFinal(row, indexedRef.current);
      if (isOwnVerdict(verdict)) {
        emit(deployedLine(f.ticker, height, ownTxid, Date.now(), { provisional: !final }));
        emit(registrationLine(f.ticker, "registered", ownTxid));
        if (!final) setSettling(addSettlingNote(address, { ticker: f.ticker, txid: ownTxid, versions: [ownTxid, ...versions], height, origin: "registered" }));
      } else {
        emit(registrationLine(f.ticker, "taken", f.txid));
        if (!final) setSettling(addSettlingNote(address, { ticker: f.ticker, txid: f.txid, versions, height, origin: "taken", otherTxid: ownTxid }));
      }
      setFlow((x) => (x.phase === "confirmed" ? { ...x, phase: "done", verdict, row, final } : x));
      settledRef.current?.();
    };
    const check = async () => {
      attempts += 1;
      try {
        const row = await indexer.token(flowRef.current.ticker);
        if (!alive) return;
        if (row) {
          if (id) clearInterval(id);
          id = null;
          settle(row);
          return;
        }
      } catch {
        /* transient — asked again on the next tick */
      }
      if (alive && attempts >= REGISTRY_MAX_ATTEMPTS) {
        if (id) clearInterval(id);
        id = null;
        const f = flowRef.current;
        emit(registrationLine(f.ticker, "unindexed", f.txid));
        // The record stays: the page checks again when the user returns.
        setFlow((x) => (x.phase === "confirmed" ? { ...x, phase: "done", verdict: "unindexed" } : x));
      }
    };
    check();
    id = setInterval(() => {
      if (attempts < REGISTRY_MAX_ATTEMPTS) check();
    }, REGISTRY_POLL_MS);
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
  }, [confirmedKey, address, emit]);

  // ---- settling notes: each followed until final ------------------------------------------------------
  const settlingKey = settling.map((n) => `${n.txid}:${n.verdict}`).join(",");
  useEffect(() => {
    if (!address || !settlingKey) return undefined;
    let alive = true;
    const check = async () => {
      for (const n of settlingNotes(address)) {
        let row;
        try {
          row = await indexer.token(n.ticker);
        } catch {
          continue; // unknown — asked again next time
        }
        if (!alive) return;
        // No row: only a reorganization if the indexer that answered has
        // applied the note's block and is not rebuilding — its health is
        // read after the 404, so both describe the same state.
        let applied = indexedRef.current;
        let rebuilding = false;
        if (row === null) {
          const h = syncStateOf(await indexer.health().catch(() => null));
          if (!alive) return;
          applied = h.indexed;
          rebuilding = h.rebuilding;
        }
        const at = Number.isInteger(indexedRef.current) ? indexedRef.current : tipRef.current;
        const v = settlingVerdict(n, row, at, { applied, rebuilding, address });
        if (v === "final" || v === "final-taken") {
          removeSettlingNote(address, n.txid);
          if (v === "final") {
            if (n.verdict !== "provisional") emit(deployedLine(n.ticker, row.deploy_block, row.deploy_txid, Date.now()));
            emit(createdFinalLine(n.ticker, row.deploy_block, row.deploy_txid));
          }
          setFlow((f) => (f.phase === "done" && deployVersions(f).some((t) => n.versions.includes(t)) ? { ...f, final: v === "final" } : f));
        } else if (v !== "unknown" && v !== n.verdict) {
          const change = (n.changes || 0) + 1;
          updateSettlingNote(address, n.txid, (x) => ({ ...x, verdict: v, changes: change, otherTxid: v === "changed-taken" ? row?.deploy_txid ?? null : x.otherTxid }));
          if (v === "provisional" && n.origin !== "registered") {
            // A released or out-run DEPLOY of this browser holds the name after all.
            emit(stepFoundLine("DEPLOY", row.deploy_txid, row.deploy_block));
            emit(deployedLine(n.ticker, row.deploy_block, row.deploy_txid, Date.now(), { provisional: true }));
          } else if (n.origin === "released" && v === "changed-taken") {
            emit(registrationLine(n.ticker, "taken", n.txid));
          } else {
            emit(createdReorgLine(n.ticker, v, n.txid, row?.deploy_txid ?? null, Date.now(), { change }));
          }
          // A "Created" result on the page no longer holds: the note says what changed.
          if (v !== "provisional") setFlow((f) => (f.phase === "done" && isOwnVerdict(f.verdict) && deployVersions(f).some((t) => n.versions.includes(t)) ? IDLE_CREATE : f));
        }
      }
      if (alive) setSettling(settlingNotes(address));
    };
    check();
    const id = setInterval(check, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [settlingKey, address, emit]);

  // ---- Speed up -----------------------------------------------------------------------------------------
  const canSpeedUp = flow.phase === "pending" && !!flow.psbt && Number.isInteger(flow.changeVout) && !flow.takenRow;

  /** The replacement a Speed up at `rate` would sign, `{ error, code }` when it cannot, or null. Pure preview. */
  const speedUpQuote = useCallback(
    (rate) => {
      const f = flowRef.current;
      if (f.phase !== "pending" || !f.psbt || !Number.isInteger(f.changeVout)) return null;
      try {
        return buildSpeedUpPsbt({ psbtHex: f.psbt, changeVout: f.changeVout, feeRateSatVb: rate, incrementalRelayFee });
      } catch (e) {
        return { error: String(e?.message || e), code: e?.code || null };
      }
    },
    [incrementalRelayFee],
  );

  /** Replace the pending DEPLOY with a copy that pays `rate` sat/vB (same inputs, outputs and payload), and follow it. */
  const speedUp = useCallback(
    async (rate) => {
      const f = flowRef.current;
      if (!address || speeding || f.phase !== "pending" || !f.psbt || !Number.isInteger(f.changeVout) || f.takenRow) return;
      const startedAt = Date.now();
      setSpeedError(null);
      setSpeeding("building");
      const versions = deployVersions(f);
      try {
        // Re-read at the click: confirmed meanwhile, or the name taken — a faster copy would only pay more.
        const [results, row] = await Promise.all([versionAnswers(versions), indexer.token(f.ticker)]);
        const v = resolveVersions(results);
        if (v.kind === "confirmed") throw new Error("It has just confirmed — no need to speed it up.");
        if (row) {
          if (deployVerdict(row, versions, address) === "taken") throw new Error(`${f.ticker} is already registered to another DEPLOY; a faster copy would only pay more.`);
          throw new Error("It has just confirmed — no need to speed it up.");
        }
        const q = buildSpeedUpPsbt({ psbtHex: f.psbt, changeVout: f.changeVout, feeRateSatVb: rate, incrementalRelayFee });
        // The same guard as the first signature.
        expectPsbtPayload(q.psbtHex, { op: "DEPLOY", ticker: f.ticker, lockTime: PROTOCOL_LOCKTIME, inputsSequence: RBF_SEQUENCE, layout: { self: address } });
        setSpeeding("signing");
        emit(signLine(providerName, startedAt));
        // A replacement: the inputs of every version it replaces may be spent again.
        const signed = await wallet.signPsbt(q.psbtHex, { inputIndexes: q.inputIndexes, address, replaces: versions });
        setSpeeding("broadcasting");
        emit(broadcastingLine(startedAt));
        let newTxid;
        let unsure = null;
        try {
          newTxid = await wallet.broadcastSignedPsbt(signed, { kind: "deploy", ticker: f.ticker, address, psbt: q.psbtHex, changeVout: f.changeVout, replaces: versions });
        } catch (e) {
          // Neither relay confirmed the faster version, but it may still
          // reach the network (it is recorded): the DEPLOY follows it and
          // keeps asking about the earlier versions.
          if (!(e?.recorded && e.txid)) throw e;
          newTxid = e.txid;
          unsure = e;
        }
        // The replacement spends the same inputs: its record guards them now
        // (the earlier record stays while the faster one is not seen).
        if (!unsure) forgetTx(address, f.txid);
        const tipNow = Number.isInteger(tipRef.current) ? tipRef.current : f.sentTip;
        setFlow((x) =>
          x.phase === "pending" && x.startedAt === f.startedAt
            ? {
                ...x,
                txid: newTxid,
                versions: [newTxid, ...deployVersions(x)].filter((t, i, a) => a.indexOf(t) === i),
                psbt: q.psbtHex,
                feeSats: q.feeSats,
                feeRateSatVb: q.feeRateSatVb,
                broadcastAt: Date.now(),
                sentTip: tipNow,
                unsent: !!unsure,
                unseenSince: null,
              }
            : x,
        );
        emit(speedUpLine("DEPLOY", { oldFeeSats: q.oldFeeSats, feeSats: q.feeSats, feeRateSatVb: q.feeRateSatVb, txid: newTxid }));
        if (unsure) setSpeedError(friendlyError(unsure));
      } catch (e) {
        const message = friendlyError(e);
        emit(errorLine(`speed up: ${message}`, startedAt));
        setSpeedError(message);
      } finally {
        setSpeeding(null);
      }
    },
    [address, speeding, incrementalRelayFee, providerName, emit],
  );

  // ---- small actions ------------------------------------------------------------------------------------
  /** Clear a finished result, a released DEPLOY or an error (never a flow in progress). */
  const dismiss = useCallback(() => {
    reviewRef.current = null;
    setSpeedError(null);
    setFlow((f) => (f.phase === "done" || f.phase === "error" || f.phase === "released" || f.phase === "review" ? IDLE_CREATE : f));
  }, []);

  /** Stop following a result (its settling note). */
  const dismissSettling = useCallback(
    (txid) => {
      if (!address) return;
      setSettling(removeSettlingNote(address, txid));
    },
    [address],
  );

  const busy = DEPLOY_BUSY.has(flow.phase) || !!speeding;
  return useMemo(
    () => ({
      flow,
      status,
      newestUnseen,
      unseenAt,
      missed,
      otherPending,
      settling,
      busy,
      speeding,
      speedError,
      canSpeedUp,
      create,
      confirmCreate,
      cancelReview,
      speedUp,
      speedUpQuote,
      dismiss,
      dismissSettling,
      stopWaiting: seedWait.stop,
    }),
    [flow, status, newestUnseen, unseenAt, missed, otherPending, settling, busy, speeding, speedError, canSpeedUp, create, confirmCreate, cancelReview, speedUp, speedUpQuote, dismiss, dismissSettling, seedWait],
  );
}
