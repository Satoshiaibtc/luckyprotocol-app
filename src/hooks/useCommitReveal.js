import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { droppedMessage, useTxStatus } from "./useTxStatus.js";
import { friendlyError } from "./useWallet.js";
import { seedWaitNote } from "./useMine.js";
import {
  buildCommitPsbt,
  buildRevealPsbt,
  buildSpeedUpPsbt,
  carrierScriptHex,
  COMMIT_CARRIER_VOUT,
  expectPsbtPayload,
  extractRawTxHex,
  minFeeInputSats,
  rawTxSummary,
} from "../lib/psbt.js";
import { DUST_SATS, PROTOCOL_LOCKTIME, newSalt } from "../lib/payloads.js";
import { withPending } from "../lib/pending.js";
import { DROP_GRACE_MS, forgetTx } from "../lib/txrecords.js";
import { syncRetryText, syncStateOf } from "../lib/sync.js";
import { isUsableFeeRate } from "../lib/feechoice.js";
import { activationNotice, activationState } from "../lib/activation.js";
import { fundingMessage } from "../lib/funding.js";
import {
  claimDeployRecord,
  clearDeployRecord,
  commitMismatch,
  commitStatusText,
  deployPhase,
  deployRecordBackend,
  deployRecordKey,
  deployStage,
  isStaleDraft,
  loadDeployRecord,
  resolveVersions,
  revealTiming,
  revealWindow,
  startDeployRecord,
  stepVersions,
  switchStepTo,
  updateDeployRecord,
} from "../lib/commitReveal.js";
import {
  abandonedLine,
  acceptedLine,
  broadcastingLine,
  deployConfirmedLine,
  deployMempoolLine,
  errorLine,
  publishBuildLine,
  reservationExpiredLine,
  reservationResumedLine,
  reserveBuildLine,
  reserveConfirmedLine,
  reserveMempoolLine,
  reserveRecordedLine,
  signLine,
  speedUpLine,
  stepDroppedLine,
  stepFoundLine,
  stepUnseenLine,
  takenBeforePublishLine,
} from "../lib/deploylog.js";

const POLL_MS = 15_000;
// How often the record is re-read from storage: another tab (or an earlier
// mount of this page whose wallet window was still open) may have changed it.
const RECORD_SYNC_MS = 3_000;

/**
 * Ask the indexer about every version of a step (`txids`): /tx-status first;
 * when none is confirmed or seen and `commits` is set, /commits too (a
 * recorded COMMIT is a confirmed one even while /tx-status lags). → the
 * `resolveVersions` verdict.
 */
async function findVersion(txids, { commits = false } = {}) {
  const results = [];
  for (const txid of txids) {
    let status = null;
    try {
      status = await indexer.txStatus(txid);
    } catch {
      status = null;
    }
    results.push({ txid, status });
  }
  const v = resolveVersions(results);
  if (v.kind === "confirmed" || v.kind === "seen" || !commits) return v;
  for (const txid of txids) {
    try {
      const c = await indexer.commit(txid);
      if (c && Number.isInteger(c.height)) return { kind: "confirmed", txid, height: c.height };
    } catch {
      /* unknown — the verdict of /tx-status stands */
    }
  }
  return v;
}

/**
 * The two-step (commit-reveal) deploy of the Create page — PROTOCOL.md
 * §2.1. One reservation per address, persisted in localStorage by
 * src/lib/commitReveal.js before step 1 is signed:
 *
 *   reserve(ticker, feeRate)  step 1: build, sign and broadcast the COMMIT (network fee only)
 *   publish(feeRate)          step 2: the REVEAL, input 0 = the COMMIT's carrier;
 *                             availability and the reservation are re-checked first
 *   speedUp(step, feeRate)    replace a pending COMMIT / REVEAL with a higher-fee copy (RBF)
 *   speedUpQuote(step, rate)  the replacement's fee, without signing (null when impossible)
 *   abandon()                 forget the reservation (its 546-sat output stays in the wallet)
 *   dismiss()                 clear a finished result
 *
 * `log(line)` receives every Deploy // log event of the flow. Returns the
 * record, the derived `phase` (commitReveal.deployPhase), the in-flight
 * `op`, the last `error`, the commit's indexer view, the reveal timing and
 * the live tx statuses.
 */
export function useCommitReveal({ address, pubkeyHex, providerName, tip, indexed, incrementalRelayFee, log, onSettled }) {
  const [rec, setRec] = useState(() => (address ? loadDeployRecord(address) : null));
  const [op, setOp] = useState(null);
  const [error, setError] = useState(null);
  const [commitInfo, setCommitInfo] = useState({ txid: null, data: undefined, error: null });
  const [tokenInfo, setTokenInfo] = useState({ ticker: null, row: undefined, asOf: null, error: null });
  // The finished result of a reservation whose record was cleared (registered, or dismissed later).
  const [finished, setFinished] = useState(null);
  const logRef = useRef(log);
  logRef.current = log;
  const emit = useCallback((l) => logRef.current?.(l), []);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const indexedRef = useRef(indexed);
  indexedRef.current = indexed;
  const tipRef = useRef(tip);
  tipRef.current = tip;

  // ---- the record ---------------------------------------------------------------------------
  // On mount and on an account switch: load that address's reservation.
  useEffect(() => {
    const r = address ? loadDeployRecord(address) : null;
    setRec(r);
    setOp(null);
    setError(null);
    setFinished(null);
    setCommitInfo({ txid: null, data: undefined, error: null });
    setTokenInfo({ ticker: null, row: undefined, asOf: null, error: null });
    if (!r) return;
    if (deployStage(r) === "draft") {
      // A draft may belong to a wallet window that is still open — in
      // another tab, or in an earlier mount of this page the user navigated
      // away from (audit LENS-3): it is kept, and only a stale one (older
      // than DRAFT_STALE_MS, no signature can still be pending) is cleared.
      if (isStaleDraft(r)) {
        clearDeployRecord(address);
        setRec(null);
      }
      return;
    }
    const step = r.reveal ? 2 : 1;
    const tx = r.reveal ? r.reveal.txid : r.commit.txid;
    emit(reservationResumedLine(r.ticker, step, tx));
  }, [address, emit]);

  const persist = useCallback(
    (fn) => {
      if (!address) return null;
      const next = updateDeployRecord(address, fn);
      setRec(next);
      return next;
    },
    [address],
  );

  // The stored record is the truth: re-read it when another tab writes it
  // (the `storage` event) and every few seconds (a reserve() of an earlier
  // mount of this page writes to the same storage without an event).
  useEffect(() => {
    if (!address) return undefined;
    const sync = () => {
      const cur = loadDeployRecord(address);
      setRec((prev) => (JSON.stringify(prev) === JSON.stringify(cur) ? prev : cur));
    };
    const onStorage = (e) => {
      if (!e || !e.key || e.key === deployRecordKey(address)) sync();
    };
    if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
    const id = setInterval(sync, RECORD_SYNC_MS);
    return () => {
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      clearInterval(id);
    };
  }, [address]);

  // ---- live chain facts -----------------------------------------------------------------------
  const commit = rec?.commit || null;
  const reveal = rec?.reveal || null;
  // An unseen step is watched by the version check below instead.
  const commitTracked = commit && commit.sentAt && !Number.isInteger(commit.height) && !commit.unseenAt ? commit.txid : null;
  const revealTracked = reveal && reveal.sentAt && !Number.isInteger(reveal.height) && !reveal.unseenAt ? reveal.txid : null;

  const commitStatus = useTxStatus(commitTracked, {
    since: commit?.sentAt ?? null,
    onConfirmed: (s) => {
      const next = persist((r) => (r.commit && r.commit.txid === s.txid ? { ...r, commit: { ...r.commit, height: s.block_height } } : r));
      if (next?.commit?.height != null) emit(reserveConfirmedLine(s.block_height, revealWindow(s.block_height), s.txid));
      settledRef.current?.();
    },
  });
  const revealStatus = useTxStatus(revealTracked, {
    since: reveal?.sentAt ?? null,
    onConfirmed: (s) => {
      const next = persist((r) => (r.reveal && r.reveal.txid === s.txid ? { ...r, reveal: { ...r.reveal, height: s.block_height } } : r));
      if (next?.reveal?.height != null) emit(deployConfirmedLine(next.ticker, s.block_height, s.txid));
      settledRef.current?.();
    },
  });

  // A tracked tx has not been in the node's mempool for DROP_GRACE_MS
  // without confirming. That is NOT proof it is gone (audits LENS-2 / ux-1):
  // after a Speed up a miner may confirm the ORIGINAL version, and a node
  // may evict a tx other nodes still hold. So the step is only marked
  // unseen — the record and its salt stay — and the version check below
  // looks for every version until one turns up or the user abandons.
  const markUnseen = useCallback(
    (step, txid) => {
      persist((r) => (r[step]?.txid === txid && !r[step].unseenAt ? { ...r, [step]: { ...r[step], unseenAt: Date.now() } } : r));
      emit(stepUnseenLine(step === "commit" ? "COMMIT" : "DEPLOY", txid));
    },
    [persist, emit],
  );
  useEffect(() => {
    if (commitStatus.dropped && commitTracked && address) markUnseen("commit", commitTracked);
  }, [commitStatus.dropped, commitTracked, address, markUnseen]);
  useEffect(() => {
    if (revealStatus.dropped && revealTracked && address) markUnseen("reveal", revealTracked);
  }, [revealStatus.dropped, revealTracked, address, markUnseen]);

  // The version check: while a step is pending and is unseen or has
  // replaced earlier versions (Speed up), ask about every version — the one
  // that confirms (or, for an unseen step, is in a mempool) becomes the
  // step's tx. An unseen publish whose versions the node knows none of,
  // while the indexer still shows the reservation open, is released: the
  // reservation can publish again, and the released txids stay recorded as
  // ours (droppedReveals) in case one of them still confirms.
  const watchCommit = commit && commit.signedAt !== null && !Number.isInteger(commit.height) && (commit.unseenAt || commit.replaces.length) ? `${commit.txid}|${commit.replaces.join(",")}|${commit.unseenAt ? 1 : 0}` : null;
  const watchReveal = reveal && !Number.isInteger(reveal.height) && (reveal.unseenAt || reveal.replaces.length) ? `${reveal.txid}|${reveal.replaces.join(",")}|${reveal.unseenAt ? 1 : 0}` : null;
  useEffect(() => {
    if (!address || (!watchCommit && !watchReveal)) return undefined;
    let alive = true;
    const check = async () => {
      const r = loadDeployRecord(address);
      if (!r) return;
      for (const step of ["commit", "reveal"]) {
        const s = r[step];
        if (!s || Number.isInteger(s.height) || !(s.unseenAt || s.replaces.length)) continue;
        const what = step === "commit" ? "COMMIT" : "DEPLOY";
        const versions = s.unseenAt ? stepVersions(s) : [...s.replaces].reverse();
        const v = await findVersion(versions, { commits: step === "commit" });
        if (!alive) return;
        if (v.kind === "confirmed" || (v.kind === "seen" && s.unseenAt)) {
          const height = v.kind === "confirmed" ? v.height : null;
          const next = persist((x) => (x[step]?.txid === s.txid ? { ...x, [step]: switchStepTo(x[step], v.txid, { height }) } : x));
          if (next?.[step]?.txid === v.txid) {
            emit(stepFoundLine(what, v.txid, height));
            if (height !== null) {
              if (step === "commit") emit(reserveConfirmedLine(height, revealWindow(height), v.txid));
              else emit(deployConfirmedLine(next.ticker, height, v.txid));
              settledRef.current?.();
            }
          }
          continue;
        }
        if (step !== "reveal" || !s.unseenAt || v.kind !== "none") continue;
        // An unseen publish the node knows nothing of. Did one of its
        // versions spend the carrier after all (the indexer lagging)?
        let c = null;
        try {
          c = await indexer.commit(r.commit.txid);
        } catch {
          continue; // unknown — ask again next time
        }
        if (!alive) return;
        const ours = stepVersions(s);
        if (c && c.status === "revealed" && ours.includes(c.spent_txid)) {
          const next = persist((x) => (x.reveal?.txid === s.txid ? { ...x, reveal: switchStepTo(x.reveal, c.spent_txid, { height: c.spent_height }) } : x));
          if (next?.reveal?.txid === c.spent_txid) emit(stepFoundLine(what, c.spent_txid, c.spent_height));
        } else if (c && c.status === "open") {
          const released = persist((x) =>
            x.reveal?.txid === s.txid ? { ...x, reveal: null, droppedReveals: [...(x.droppedReveals || []), ...stepVersions(x.reveal)] } : x,
          );
          if (released && !released.reveal) {
            for (const t of ours) forgetTx(address, t);
            emit(stepDroppedLine("DEPLOY", s.txid));
            setError({ kind: "publish", message: `${droppedMessage(s.txid, "publish transaction (step 2)")} Your reservation is still open — you can publish again.` });
          }
        }
      }
    };
    check();
    const id = setInterval(check, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [watchCommit, watchReveal, address, persist, emit]);

  // Resume of a SIGNED step whose broadcast was never confirmed (the page
  // closed mid-broadcast, or both relays failed and the node could not be
  // asked): ask the indexer's node. Seen / confirmed → sent; still unknown
  // after DROP_GRACE_MS → it never left this browser, drop it.
  const unsent = commit && !commit.sentAt && !commit.unseenAt ? { step: "commit", s: commit } : reveal && !reveal.sentAt && !reveal.unseenAt ? { step: "reveal", s: reveal } : null;
  const unsentTxid = unsent?.s.txid ?? null;
  const unsentStep = unsent?.step ?? null;
  const unsentSince = unsent ? (unsent.s.signedAt ?? rec?.createdAt ?? Date.now()) : null;
  useEffect(() => {
    if (!unsentTxid || !address) return undefined;
    let alive = true;
    const check = async () => {
      let st = null;
      try {
        st = await indexer.txStatus(unsentTxid);
      } catch {
        return; // unknown — ask again
      }
      if (!alive) return;
      if (st.confirmed || st.seen) {
        persist((r) => (r[unsentStep]?.txid === unsentTxid ? { ...r, [unsentStep]: { ...r[unsentStep], sentAt: Date.now(), height: st.confirmed ? st.block_height : null, unseenAt: null } } : r));
      } else if (Date.now() - unsentSince > DROP_GRACE_MS) {
        // Never given up on its own: a signed step may still reach a miner
        // (the relay's answer was lost). Unseen → the version check takes
        // over; the user can abandon (step 1) or it is released (step 2).
        markUnseen(unsentStep, unsentTxid);
      }
    };
    check();
    const id = setInterval(check, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [unsentTxid, unsentStep, unsentSince, address, persist, markUnseen]);

  // The indexer's view of the COMMIT once it confirmed: /commits/:txid.
  const commitTxid = commit?.sentAt && Number.isInteger(commit.height) ? commit.txid : null;
  const [commitPollKey, setCommitPollKey] = useState(0);
  useEffect(() => {
    if (!commitTxid) return undefined;
    let alive = true;
    const read = async () => {
      try {
        const data = await indexer.commit(commitTxid);
        if (alive) setCommitInfo({ txid: commitTxid, data, error: null });
      } catch (e) {
        if (alive) setCommitInfo((c) => ({ ...c, txid: commitTxid, error: friendlyError(e) }));
      }
    };
    read();
    const id = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [commitTxid, commitPollKey]);
  const commitData = commitInfo.txid === commitTxid ? commitInfo.data : undefined;

  // The registry row of the reserved ticker (taken by someone else? ours?).
  const ticker = rec?.ticker || null;
  useEffect(() => {
    if (!ticker) return undefined;
    let alive = true;
    const read = async () => {
      const asOf = indexedRef.current;
      try {
        const row = await indexer.token(ticker);
        if (alive) setTokenInfo({ ticker, row, asOf: Number.isInteger(asOf) ? asOf : null, error: null });
      } catch (e) {
        if (alive) setTokenInfo((t) => ({ ...t, ticker, error: friendlyError(e) }));
      }
    };
    read();
    const id = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ticker]);
  const row = tokenInfo.ticker === ticker ? tokenInfo.row : undefined;

  const phase = deployPhase({ rec, commitStatus: commitData === undefined ? undefined : commitData?.status ?? null, commitInfo: commitData ?? null, row, rowAsOf: tokenInfo.ticker === ticker ? tokenInfo.asOf : null, tip });

  // A publish released as dropped spent the carrier after all (the indexer
  // shows the reservation used by one of our released txids): it is our
  // step 2 again — the registry decides the rest.
  const releasedSpend = !reveal && rec?.droppedReveals?.length && commitData?.status === "revealed" && rec.droppedReveals.includes(commitData.spent_txid) ? commitData.spent_txid : null;
  useEffect(() => {
    if (!releasedSpend || !commitData) return;
    const next = persist((x) =>
      !x.reveal && x.droppedReveals.includes(releasedSpend)
        ? { ...x, reveal: { txid: releasedSpend, sentAt: Date.now(), height: commitData.spent_height, replaces: x.droppedReveals.filter((t) => t !== releasedSpend) }, droppedReveals: [] }
        : x,
    );
    if (next?.reveal?.txid === releasedSpend) emit(stepFoundLine("DEPLOY", releasedSpend, commitData.spent_height));
  }, [releasedSpend, commitData, persist, emit]);
  const timing = commit && Number.isInteger(commit.height) ? revealTiming(commit.height, tip) : null;

  // Log the step transitions that are not an action's own lines.
  useEffect(() => {
    if (!rec) return;
    if (phase === "ready" && commitTxid) emit(reserveRecordedLine(commitTxid));
    else if (phase === "taken" || phase === "publish-pending-taken" || phase === "taken-after") emit(takenBeforePublishLine(rec.ticker, `${rec.commit?.txid}:${phase === "taken" ? "before" : "after"}`));
    else if (phase === "expired" && timing) emit(reservationExpiredLine(timing.expiresAt, commitTxid));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one line per phase change
  }, [phase, commitTxid]);

  // Registered: the reservation has done its job — clear it, keep the result on screen.
  useEffect(() => {
    if (phase !== "registered" || !rec || !address) return;
    // The registry can list the name before this page's tx-status poll saw the block.
    if (!Number.isInteger(rec.reveal.height) && Number.isInteger(row?.deploy_block)) emit(deployConfirmedLine(rec.ticker, row.deploy_block, rec.reveal.txid));
    setFinished({ ticker: rec.ticker, verdict: "registered", revealTxid: rec.reveal.txid, height: rec.reveal.height ?? row?.deploy_block ?? null, resumed: false });
    forgetTx(address, rec.reveal.txid);
    clearDeployRecord(address);
    setRec(null);
    settledRef.current?.();
  }, [phase, rec, row, address, emit]);

  // ---- actions --------------------------------------------------------------------------------
  const busy = !!op;

  /** Step 1: reserve `ticker` with a COMMIT at `feeRate` sat/vB. */
  const reserve = useCallback(
    async (t, feeRate) => {
      if (!address || busy) return;
      const open = loadDeployRecord(address);
      if (open && !isStaleDraft(open)) {
        setError({ kind: "reserve", message: "A reservation is already open for this address — publish or abandon it first." });
        return;
      }
      const startedAt = Date.now();
      setError(null);
      setFinished(null);
      setOp({ kind: "reserve", phase: "building", ticker: t, startedAt });
      let utxoRes = null;
      let signedTxid = null;
      let salt = null;
      try {
        if (!isUsableFeeRate(feeRate)) throw new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.");
        // Re-check at the moment of the click, not from the last poll.
        const [h, existing] = await Promise.all([indexer.health(), indexer.token(t)]);
        const fresh = syncStateOf(h);
        if (activationState(h?.tip_height ?? null).locked) throw new Error(activationNotice(h?.tip_height ?? null, "Reserving a ticker"));
        if (!fresh.synced) throw new Error(syncRetryText(fresh, `${t}'s availability`, "Reserve"));
        if (existing) throw new Error(`${t} is already created (tx ${existing.deploy_txid.slice(0, 12)}…) — pick another name.`);
        const onWait = (info) => setOp((o) => (o && o.phase === "building" ? { ...o, waitNote: seedWaitNote(info) } : o));
        const [list, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(address, { onWait }), indexer.tokenUtxos(address)]);
        utxoRes = list;
        salt = newSalt();
        // The builder computes H from the REVEAL payload and the script of
        // the carrier it builds (this address): H binds the committer (§2.1).
        const built = buildCommitPsbt({
          address,
          pubkeyHex,
          utxos: utxoRes.utxos,
          tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), address),
          feeRateSatVb: feeRate,
          ticker: t,
          salt,
          minInputSats: minFeeInputSats(utxoRes.assetSafe),
        });
        const { hash, carrierScript } = built;
        // Sign-time guard: one OP_RETURN, COMMIT|<this hash>, vout0 = the
        // carrier that hash was made for, the protocol lock time.
        expectPsbtPayload(built.psbtHex, { op: "COMMIT", hash, vout0Script: carrierScript, lockTime: PROTOCOL_LOCKTIME });
        // The salt (with the carrier script, the rest of what H covers) is
        // stored BEFORE the wallet signs: once a COMMIT is out, the salt is
        // the only proof of which ticker it reserves. `start` refuses while
        // another reservation (another tab's) is open.
        const draft = startDeployRecord(address, { ticker: t, salt, carrierScript });
        if (draft.hash !== hash) throw new Error("The saved reservation does not reproduce the sealed code of step 1 — nothing was sent.");
        setRec(draft);
        const info = { feeSats: built.feeSats, feeRateSatVb: built.feeRateSatVb, vsize: built.estimatedVsize, inputCount: built.inputIndexes.length, inputs: built.inputs, assetSafe: utxoRes.assetSafe, utxoSource: utxoRes.source };
        const signing = { kind: "reserve", phase: "signing", ticker: t, startedAt, ...info };
        setOp(signing);
        emit(reserveBuildLine({ startedAt, ...info }));
        emit(signLine(providerName, startedAt));
        const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
        signedTxid = rawTxSummary(extractRawTxHex(signed)).txid;
        const step = { txid: signedTxid, psbt: built.psbtHex, signedAt: Date.now(), sentAt: null, height: null, feeSats: built.feeSats, feeRateSatVb: built.feeRateSatVb, vsize: built.estimatedVsize, changeVout: built.changeVout, inputs: built.inputs };
        // Only broadcast when the stored draft is still THIS one (audits
        // LENS-3 / LENS-4): if it was discarded or replaced while the wallet
        // window was open, the salt of this COMMIT would exist nowhere.
        const claimed = claimDeployRecord(
          address,
          (r) => r.ticker === t && r.salt === salt && !r.commit,
          (r) => ({ ...r, carrierSats: DUST_SATS, commit: step }),
        );
        if (!claimed) throw new Error("This reservation was discarded or changed in another tab or window while you were signing — nothing was sent. Check the Create page and try again.");
        setRec(claimed);
        setOp({ ...signing, phase: "broadcasting" });
        emit(broadcastingLine(startedAt));
        await wallet.broadcastSignedPsbt(signed, { kind: "other" });
        setRec(claimDeployRecord(address, (r) => r.commit?.txid === signedTxid, (r) => ({ ...r, commit: { ...r.commit, sentAt: Date.now() } })) ?? loadDeployRecord(address));
        emit(acceptedLine(signedTxid));
        const tipNow = tipRef.current;
        emit(reserveMempoolLine(Number.isInteger(tipNow) ? tipNow + 1 : null, signedTxid));
        setOp(null);
      } catch (e) {
        // Nothing reached the network (declined, build error, refused by
        // both relays) → forget the reservation; a broadcast whose fate is
        // unknown (e.landed === null) stays for the resume check.
        // Only OUR record is ever cleared (matched by its salt — another
        // tab's reservation of the same ticker is left alone).
        if (!(signedTxid && e?.landed === null)) {
          const cur = loadDeployRecord(address);
          if (salt && cur && cur.salt === salt && !cur.commit?.sentAt) clearDeployRecord(address);
        }
        setRec(loadDeployRecord(address));
        const message = e?.code === "busy" ? e.message : fundingMessage(e, utxoRes, { action: "this reservation" }) ?? friendlyError(e);
        emit(errorLine(message, startedAt));
        setError({ kind: "reserve", message });
        setOp(null);
      }
    },
    [address, pubkeyHex, providerName, busy, emit],
  );

  /** Step 2: publish the reserved ticker (the REVEAL) at `feeRate` sat/vB. */
  const publish = useCallback(
    async (feeRate) => {
      const r = address ? loadDeployRecord(address) : null;
      if (!r || !r.commit || !Number.isInteger(r.commit.height) || r.reveal || busy) return;
      const t = r.ticker;
      const startedAt = Date.now();
      setError(null);
      setOp({ kind: "publish", phase: "building", ticker: t, startedAt });
      let utxoRes = null;
      let signedTxid = null;
      try {
        if (!isUsableFeeRate(feeRate)) throw new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.");
        // Re-check right before the reveal: the indexer is synced, the name
        // is still free, and the reservation is recorded, open and in its window.
        const [h, existing, c] = await Promise.all([indexer.health(), indexer.token(t), indexer.commit(r.commit.txid)]);
        const fresh = syncStateOf(h);
        if (!fresh.synced) throw new Error(syncRetryText(fresh, `${t}'s availability`, "Publish"));
        if (existing) {
          setTokenInfo({ ticker: t, row: existing, asOf: fresh.indexed, error: null });
          throw new Error(`${t} was created by someone else before you published — this reservation can no longer claim it. You can abandon it; its ${DUST_SATS}-sat output stays in your wallet.`);
        }
        if (!c) throw new Error("The indexer has not recorded your reservation yet — nothing was sent. Try again in a minute.");
        setCommitInfo({ txid: r.commit.txid, data: c, error: null });
        if (c.status !== "open") throw new Error(`Your reservation is ${commitStatusText(c.status)} — nothing was sent.`);
        // The recorded COMMIT must be the one this record's ticker + salt +
        // carrier script reveal, reserved by this address (audit LENS-4) —
        // else the publish would pay the fee and register nothing (or
        // someone else).
        const mismatch = commitMismatch(c, r, address, { addressScript: carrierScriptHex(address) });
        if (mismatch) throw new Error(`${mismatch} — nothing was sent. Abandon this reservation and reserve again.`);
        const tm = revealTiming(c.height, h.tip_height);
        if (!tm || tm.expired) throw new Error("Your reservation has expired — nothing was sent.");
        if (!tm.ready) throw new Error(`Publishing opens at block #${tm.revealFrom.toLocaleString("en-US")} — nothing was sent.`);
        const onWait = (info) => setOp((o) => (o && o.phase === "building" ? { ...o, waitNote: seedWaitNote(info) } : o));
        const [list, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(address, { onWait }), indexer.tokenUtxos(address)]);
        utxoRes = list;
        const carrier = { txid: r.commit.txid, vout: COMMIT_CARRIER_VOUT, sats: r.carrierSats ?? DUST_SATS };
        const listed = (utxoRes.utxos || []).find((u) => u.txid === carrier.txid && u.vout === carrier.vout);
        if (listed && Number.isInteger(Number(listed.sats))) carrier.sats = Number(listed.sats);
        const built = buildRevealPsbt({
          address,
          pubkeyHex,
          utxos: utxoRes.utxos,
          tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), address),
          feeRateSatVb: feeRate,
          ticker: t,
          salt: r.salt,
          carrier,
          minInputSats: minFeeInputSats(utxoRes.assetSafe),
        });
        // Sign-time guard: DEPLOY|<ticker>|<this salt>, input 0 = the carrier, the lock time.
        expectPsbtPayload(built.psbtHex, { op: "DEPLOY", ticker: t, salt: r.salt, input0: carrier, lockTime: PROTOCOL_LOCKTIME });
        const info = { feeSats: built.feeSats, feeRateSatVb: built.feeRateSatVb, vsize: built.estimatedVsize, inputCount: built.inputIndexes.length, inputs: built.inputs, assetSafe: utxoRes.assetSafe, utxoSource: utxoRes.source };
        const signing = { kind: "publish", phase: "signing", ticker: t, startedAt, ...info };
        setOp(signing);
        emit(publishBuildLine({ startedAt, ...info }, t));
        emit(signLine(providerName, startedAt));
        const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
        signedTxid = rawTxSummary(extractRawTxHex(signed)).txid;
        const step = { txid: signedTxid, psbt: built.psbtHex, signedAt: Date.now(), sentAt: null, height: null, feeSats: built.feeSats, feeRateSatVb: built.feeRateSatVb, vsize: built.estimatedVsize, changeVout: built.changeVout, inputs: built.inputs };
        const claimed = claimDeployRecord(
          address,
          (x) => x.salt === r.salt && x.commit?.txid === r.commit.txid && !x.reveal,
          (x) => ({ ...x, reveal: step }),
        );
        if (!claimed) throw new Error("This reservation was changed in another tab or window while you were signing — nothing was sent.");
        setRec(claimed);
        setOp({ ...signing, phase: "broadcasting" });
        emit(broadcastingLine(startedAt));
        await wallet.broadcastSignedPsbt(signed, { kind: "deploy", ticker: t });
        setRec(updateDeployRecord(address, (x) => ({ ...x, reveal: { ...x.reveal, sentAt: Date.now() } })));
        emit(acceptedLine(signedTxid));
        const tipNow = tipRef.current;
        emit(deployMempoolLine(t, Number.isInteger(tipNow) ? tipNow + 1 : null, signedTxid));
        setOp(null);
      } catch (e) {
        if (!(signedTxid && e?.landed === null)) {
          const cur = loadDeployRecord(address);
          if (cur?.reveal && !cur.reveal.sentAt) updateDeployRecord(address, (x) => ({ ...x, reveal: null }));
        }
        setRec(loadDeployRecord(address));
        const message = fundingMessage(e, utxoRes, { action: "this publish" }) ?? friendlyError(e);
        emit(errorLine(message, startedAt));
        setError({ kind: "publish", message });
        setOp(null);
      }
    },
    [address, pubkeyHex, providerName, busy, emit],
  );

  /** The replacement a Speed up of `step` ("commit" | "reveal") at `feeRate` would sign, or `{ error }`. Pure preview. */
  const speedUpQuote = useCallback(
    (step, feeRate) => {
      const s = rec?.[step];
      if (!s || !s.psbt || !s.sentAt || Number.isInteger(s.height)) return null;
      try {
        return buildSpeedUpPsbt({ psbtHex: s.psbt, changeVout: s.changeVout, feeRateSatVb: feeRate, incrementalRelayFee });
      } catch (e) {
        return { error: String(e.message || e), code: e.code || null };
      }
    },
    [rec, incrementalRelayFee],
  );

  /** Replace the pending `step` ("commit" | "reveal") with a higher-fee copy (same inputs and outputs). */
  const speedUp = useCallback(
    async (step, feeRate) => {
      const r = address ? loadDeployRecord(address) : null;
      const s = r?.[step];
      if (!r || !s || !s.psbt || !s.sentAt || Number.isInteger(s.height) || busy) return;
      const what = step === "commit" ? "COMMIT" : "DEPLOY";
      const startedAt = Date.now();
      setError(null);
      setOp({ kind: "speedup", step, phase: "building", ticker: r.ticker, startedAt });
      try {
        const st = await indexer.txStatus(s.txid);
        if (st.confirmed) {
          persist((x) => (x[step]?.txid === s.txid ? { ...x, [step]: { ...x[step], height: st.block_height } } : x));
          throw new Error("It has just confirmed — no need to speed it up.");
        }
        const q = buildSpeedUpPsbt({ psbtHex: s.psbt, changeVout: s.changeVout, feeRateSatVb: feeRate, incrementalRelayFee });
        const carrier = { txid: r.commit.txid, vout: COMMIT_CARRIER_VOUT };
        expectPsbtPayload(q.psbtHex, step === "commit" ? { op: "COMMIT", hash: r.hash, vout0Script: r.carrierScript, lockTime: PROTOCOL_LOCKTIME } : { op: "DEPLOY", ticker: r.ticker, salt: r.salt, input0: carrier, lockTime: PROTOCOL_LOCKTIME });
        setOp({ kind: "speedup", step, phase: "signing", ticker: r.ticker, startedAt, feeSats: q.feeSats, feeRateSatVb: q.feeRateSatVb, oldFeeSats: q.oldFeeSats });
        emit(signLine(providerName, startedAt));
        const signed = await wallet.signPsbt(q.psbtHex, { inputIndexes: q.inputIndexes, address });
        const newTxid = rawTxSummary(extractRawTxHex(signed)).txid;
        setOp({ kind: "speedup", step, phase: "broadcasting", ticker: r.ticker, startedAt, feeSats: q.feeSats, feeRateSatVb: q.feeRateSatVb, oldFeeSats: q.oldFeeSats });
        emit(broadcastingLine(startedAt));
        await wallet.broadcastSignedPsbt(signed, step === "commit" ? { kind: "other" } : { kind: "deploy", ticker: r.ticker });
        // The replacement spends the same inputs: the old record's guard is redundant now.
        forgetTx(address, s.txid);
        persist((x) => ({
          ...x,
          [step]: { ...x[step], txid: newTxid, psbt: q.psbtHex, sentAt: Date.now(), height: null, unseenAt: null, feeSats: q.feeSats, feeRateSatVb: q.feeRateSatVb, vsize: q.vsize, replaces: [...(x[step].replaces || []), s.txid] },
        }));
        emit(speedUpLine(what, { oldFeeSats: q.oldFeeSats, feeSats: q.feeSats, feeRateSatVb: q.feeRateSatVb, txid: newTxid }));
        setOp(null);
      } catch (e) {
        const message = friendlyError(e);
        emit(errorLine(`speed up: ${message}`, startedAt));
        setError({ kind: "speedup", step, message });
        setOp(null);
      }
    },
    [address, busy, incrementalRelayFee, persist, providerName, emit],
  );

  /** Forget the reservation (the COMMIT's 546-sat output stays in the wallet; a pending COMMIT may still confirm). */
  const abandon = useCallback(() => {
    if (!address || busy) return;
    const r = loadDeployRecord(address);
    if (r) emit(abandonedLine(r.ticker, r.commit?.txid ?? r.createdAt));
    // Its transactions no longer guard their inputs: a new reservation may use them.
    for (const t of [...stepVersions(r?.commit), ...stepVersions(r?.reveal), ...(r?.droppedReveals || [])]) forgetTx(address, t);
    clearDeployRecord(address);
    setRec(null);
    setError(null);
    setFinished(null);
  }, [address, busy, emit]);

  /** Close a reservation whose result is final (ignored or refused publish): forget it without an "abandoned" line. */
  const finish = useCallback(() => {
    if (!address || busy) return;
    const r = loadDeployRecord(address);
    if (r?.reveal) forgetTx(address, r.reveal.txid);
    clearDeployRecord(address);
    setRec(null);
    setError(null);
  }, [address, busy]);

  /** Clear a finished result (and any error). */
  const dismiss = useCallback(() => {
    setFinished(null);
    setError(null);
  }, []);

  /** Re-read /commits now (after a Publish click found it unrecorded). */
  const refreshCommit = useCallback(() => setCommitPollKey((k) => k + 1), []);

  return useMemo(
    () => ({
      rec,
      phase,
      op,
      busy,
      error,
      finished,
      timing,
      commitInfo: commitData,
      commitInfoError: commitInfo.txid === commitTxid ? commitInfo.error : null,
      row,
      rowError: tokenInfo.ticker === ticker ? tokenInfo.error : null,
      commitStatus,
      revealStatus,
      storageBackend: deployRecordBackend(),
      reserve,
      publish,
      speedUp,
      speedUpQuote,
      abandon,
      finish,
      dismiss,
      refreshCommit,
    }),
    [rec, phase, op, busy, error, finished, timing, commitData, commitInfo, commitTxid, row, tokenInfo, ticker, commitStatus, revealStatus, reserve, publish, speedUp, speedUpQuote, abandon, finish, dismiss, refreshCommit],
  );
}
