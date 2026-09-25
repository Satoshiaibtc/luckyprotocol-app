import { useCallback, useEffect, useRef, useState } from "react";
import { hex, base64 } from "@scure/base";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { buildPayPsbt, outpointKey } from "../lib/psbt.js";
import { withPending } from "../lib/pending.js";
import {
  buildEnvelopeScript,
  buildRevealPsbt,
  bytesToDataUrl,
  clearAvatarRecord,
  commitAmountFor,
  commitPayment,
  compressAvatar,
  ephemeralXonly,
  finalizeReveal,
  generateEphemeralKey,
  readAvatarRecord,
  signRevealEphemeral,
  writeAvatarRecord,
} from "../lib/inscribe.js";
import { friendlyError } from "./useWallet.js";

const STATUS_POLL_MS = 15_000;
const RECONCILE_MAX_ATTEMPTS = 8;

export const IDLE_AVATAR = { phase: "idle" };
export const AVATAR_BUSY = new Set([
  "compressing",
  "commit-building",
  "commit-signing",
  "commit-broadcast",
  "reveal-building",
  "reveal-signing",
  "reveal-broadcast",
  "pending",
]);

function previewOf(rec) {
  const bytes = base64.decode(rec.bytesBase64);
  return { bytes, contentType: rec.contentType, sizeBytes: bytes.length, dataUrl: bytesToDataUrl(bytes, rec.contentType), width: null, height: null, quality: null };
}

/**
 * The §8.5 avatar flow (two transactions, one throw-away key):
 *
 *   idle → compressing → compressed (preview)
 *        → commit-building → commit-signing → commit-broadcast
 *        → reveal-building → reveal-signing → reveal-broadcast
 *        → pending → confirmed (+ reconcile with /tokens/:ticker)   ↘ error
 *   resumable (a 'lp.avatar.<TICKER>' record exists) → resume() re-enters above
 *
 * The recovery record is written the moment the ephemeral key exists and
 * cleared only when the reveal is confirmed AND the indexer reports
 * `avatar_txid == revealTxid`. `walletState` must be the token's deployer.
 */
export function useAvatar({ wallet: walletState, ticker, tokenInfo, feeRateSatVb, onSettled }) {
  const [av, setAv] = useState(IDLE_AVATAR);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const runningRef = useRef(false);

  const connected = walletState.status === "connected";
  const address = connected ? walletState.address : null;
  const pubkeyHex = connected ? walletState.pubkeyHex : null;
  const isDeployer = !!address && !!tokenInfo && tokenInfo.deployer === address;

  // Wallet / ticker change: drop in-flight UI state, re-read the record.
  useEffect(() => {
    if (!isDeployer) {
      setAv(IDLE_AVATAR);
      return;
    }
    const rec = readAvatarRecord(ticker);
    setAv(rec ? { phase: "resumable", record: rec, preview: previewOf(rec) } : IDLE_AVATAR);
  }, [address, ticker, isDeployer]);

  const fail = useCallback((e, extra = {}) => {
    runningRef.current = false;
    setAv((s) => ({ ...s, phase: "error", error: friendlyError(e), ...extra }));
  }, []);

  /** Step 1: decode + resize + compress; no key, no tx. */
  const pickFile = useCallback(async (file) => {
    if (!file) return;
    setAv((s) => ({ ...s, phase: "compressing", fileError: null, error: null }));
    try {
      const out = await compressAvatar(file);
      setAv((s) => ({
        ...s,
        phase: "compressed",
        fileError: null,
        preview: { ...out, sizeBytes: out.bytes.length, dataUrl: bytesToDataUrl(out.bytes, out.contentType) },
      }));
    } catch (e) {
      setAv((s) => ({ ...s, phase: s.preview && s.record ? "resumable" : s.preview ? "compressed" : "idle", fileError: friendlyError(e) }));
    }
  }, []);

  const fetchInputs = useCallback(async () => {
    const [utxoRes, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(address), indexer.tokenUtxos(address)]);
    return { utxoRes, tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout }))) };
  }, [address]);

  /** Commit: a plain payment of `commitAmount` to the commit address. Returns the updated record. */
  const runCommit = useCallback(
    async (rec) => {
      setAv((s) => ({ ...s, phase: "commit-building", record: rec, error: null }));
      const { utxoRes, tokenOutpoints } = await fetchInputs();
      const built = buildPayPsbt({
        address,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints,
        feeRateSatVb,
        toAddress: rec.commitAddress,
        amountSats: rec.commitAmount,
      });
      setAv((s) => ({ ...s, phase: "commit-signing", commitFeeSats: built.feeSats, commitFeeRate: built.feeRateSatVb, utxoSource: utxoRes.source }));
      const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
      setAv((s) => ({ ...s, phase: "commit-broadcast" }));
      const txid = await wallet.broadcastSignedPsbt(signed);
      const next = {
        ...rec,
        commitTxid: txid,
        commitVout: 0,
        commitChange: built.changeOmitted ? null : { vout: built.changeVout, sats: built.changeSats },
        commitInputs: built.inputs.map(({ txid: t, vout }) => ({ txid: t, vout })),
      };
      writeAvatarRecord(next);
      setAv((s) => ({ ...s, record: next, commitTxid: txid, commitAt: Date.now() }));
      return next;
    },
    [address, pubkeyHex, feeRateSatVb, fetchInputs],
  );

  /** Reveal: wallet signs its inputs first, the app signs input0 last, then broadcast. */
  const runReveal = useCallback(
    async (rec) => {
      setAv((s) => ({ ...s, phase: "reveal-building", record: rec, error: null }));
      const { utxoRes, tokenOutpoints } = await fetchInputs();
      // The wallet's UTXO list may still show what the commit spent (and may
      // not yet show the commit's change): drop the former, add the latter.
      const spent = new Set(rec.commitInputs.map(outpointKey));
      const utxos = utxoRes.utxos.filter((u) => !spent.has(outpointKey(u)));
      if (rec.commitChange && !utxos.some((u) => u.txid === rec.commitTxid && u.vout === rec.commitChange.vout)) {
        utxos.push({ txid: rec.commitTxid, vout: rec.commitChange.vout, sats: rec.commitChange.sats });
      }
      const ephemeralPriv = hex.decode(rec.ephemeralPrivHex);
      const leafScript = hex.decode(rec.leafScriptHex);
      const built = buildRevealPsbt({
        commit: { txid: rec.commitTxid, vout: rec.commitVout, sats: rec.commitAmount },
        ephemeralPriv,
        leafScript,
        deployerAddress: address,
        deployerPubkeyHex: pubkeyHex,
        utxos,
        tokenOutpoints,
        feeRateSatVb,
        ticker,
      });
      setAv((s) => ({ ...s, phase: "reveal-signing", revealFeeSats: built.feeSats, revealFeeRate: built.feeRateSatVb, revealInputCount: built.walletInputIndexes.length, utxoSource: utxoRes.source }));
      // 1. wallet: its inputs only, finalized
      const walletSigned = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.walletInputIndexes, address });
      // 2. app: input0 via the script path with the throw-away key
      const appSigned = signRevealEphemeral(walletSigned, ephemeralPriv);
      // 3. extract + broadcast
      const { rawHex } = finalizeReveal(appSigned);
      setAv((s) => ({ ...s, phase: "reveal-broadcast" }));
      const txid = await wallet.broadcastRawTx(rawHex);
      const next = { ...rec, revealTxid: txid };
      writeAvatarRecord(next);
      setAv((s) => ({ ...s, phase: "pending", record: next, revealTxid: txid, broadcastAt: Date.now(), pollError: null }));
      return next;
    },
    [address, pubkeyHex, feeRateSatVb, ticker, fetchInputs],
  );

  /** From a compressed preview: new ephemeral key → record → commit → reveal. */
  const start = useCallback(async () => {
    if (!isDeployer || !av.preview || runningRef.current) return;
    if (!Number.isInteger(feeRateSatVb) || feeRateSatVb < 1) {
      fail(new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB."));
      return;
    }
    runningRef.current = true;
    try {
      const priv = generateEphemeralKey();
      const leaf = buildEnvelopeScript(ephemeralXonly(priv), av.preview.contentType, av.preview.bytes);
      const pay = commitPayment(priv, leaf);
      const rec = {
        ticker,
        ephemeralPrivHex: hex.encode(priv),
        leafScriptHex: hex.encode(leaf),
        contentType: av.preview.contentType,
        bytesBase64: base64.encode(av.preview.bytes),
        commitAddress: pay.address,
        commitAmount: commitAmountFor({ leafScriptLen: leaf.length, feeRateSatVb }),
        commitTxid: null,
        commitVout: null,
        commitChange: null,
        commitInputs: [],
        revealTxid: null,
        feeRateSatVb,
        createdAt: Date.now(),
      };
      if (!writeAvatarRecord(rec)) {
        throw new Error("This browser blocks localStorage — the recovery key could not be saved, so the inscription was not started.");
      }
      const afterCommit = await runCommit(rec);
      await runReveal(afterCommit);
      runningRef.current = false;
    } catch (e) {
      fail(e);
    }
  }, [isDeployer, av.preview, feeRateSatVb, ticker, runCommit, runReveal, fail]);

  /** Re-enter the flow from the stored record. */
  const resume = useCallback(async () => {
    const rec = av.record || readAvatarRecord(ticker);
    if (!isDeployer || !rec || runningRef.current) return;
    runningRef.current = true;
    try {
      if (rec.revealTxid) {
        setAv((s) => ({ ...s, phase: "pending", record: rec, revealTxid: rec.revealTxid, commitTxid: rec.commitTxid, pollError: null }));
        runningRef.current = false;
        return;
      }
      if (!rec.commitTxid) {
        if (!Number.isInteger(feeRateSatVb) || feeRateSatVb < 1) throw new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.");
        await runReveal(await runCommit(rec));
        runningRef.current = false;
        return;
      }
      // Commit paid, reveal not recorded: is the commit output still unspent?
      setAv((s) => ({ ...s, phase: "reveal-building", record: rec, commitTxid: rec.commitTxid, error: null }));
      const rows = await indexer.btcUtxos(rec.commitAddress);
      const present = rows.some((u) => u.txid === rec.commitTxid && u.vout === rec.commitVout);
      if (present) {
        if (!Number.isInteger(feeRateSatVb) || feeRateSatVb < 1) throw new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.");
        await runReveal(rec);
      } else {
        // Already spent (a reveal went out before the record could note its
        // txid): watch the token row for an avatar change instead.
        setAv((s) => ({ ...s, phase: "pending", record: rec, revealTxid: null, commitTxid: rec.commitTxid, watchFrom: tokenInfo?.avatar_txid ?? null, pollError: null }));
      }
      runningRef.current = false;
    } catch (e) {
      fail(e);
    }
  }, [av.record, isDeployer, ticker, feeRateSatVb, tokenInfo?.avatar_txid, runCommit, runReveal, fail]);

  /** Forget the record. If the commit was paid, its sats stay at the commit address unspent. */
  const discard = useCallback(() => {
    clearAvatarRecord(ticker);
    runningRef.current = false;
    setAv(IDLE_AVATAR);
  }, [ticker]);

  /** Back to idle without touching the record (it comes back as "resumable" if one exists). */
  const reset = useCallback(() => {
    runningRef.current = false;
    const rec = readAvatarRecord(ticker);
    setAv(rec ? { phase: "resumable", record: rec, preview: previewOf(rec) } : IDLE_AVATAR);
  }, [ticker]);

  // Pending with a known reveal txid → poll /tx-status.
  useEffect(() => {
    if (av.phase !== "pending" || !av.revealTxid) return undefined;
    let alive = true;
    const txid = av.revealTxid;
    const check = async () => {
      try {
        const s = await indexer.txStatus(txid);
        if (!alive) return;
        if (s.confirmed && s.block_hash) {
          setAv((m) => ({ ...m, phase: "confirmed", blockHeight: s.block_height, blockHash: s.block_hash, reconcile: "pending", pollError: null }));
          settledRef.current?.();
        } else {
          setAv((m) => ({ ...m, pollError: null, lastChecked: Date.now() }));
        }
      } catch (e) {
        if (alive) setAv((m) => ({ ...m, pollError: friendlyError(e) }));
      }
    };
    check();
    const id = setInterval(check, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [av.phase, av.revealTxid]);

  // Pending WITHOUT a reveal txid (commit spent before the record knew) →
  // watch the token row until its avatar changes.
  useEffect(() => {
    if (av.phase !== "pending" || av.revealTxid) return undefined;
    let alive = true;
    const from = av.watchFrom ?? null;
    const check = async () => {
      try {
        const row = await indexer.token(ticker);
        if (!alive) return;
        if (row && row.avatar_txid && row.avatar_txid !== from) {
          clearAvatarRecord(ticker);
          setAv((m) => ({ ...m, phase: "confirmed", revealTxid: row.avatar_txid, reconcile: "done", indexed: row, pollError: null }));
          settledRef.current?.();
        } else {
          setAv((m) => ({ ...m, pollError: null, lastChecked: Date.now() }));
        }
      } catch (e) {
        if (alive) setAv((m) => ({ ...m, pollError: friendlyError(e) }));
      }
    };
    check();
    const id = setInterval(check, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [av.phase, av.revealTxid, av.watchFrom, ticker]);

  // Confirmed → reconcile with /tokens/:ticker (avatar_txid must equal our reveal), then clear the record.
  useEffect(() => {
    if (av.phase !== "confirmed" || av.reconcile !== "pending" || !av.revealTxid) return undefined;
    let alive = true;
    let attempts = 0;
    const txid = av.revealTxid;
    const check = async () => {
      attempts += 1;
      try {
        const row = await indexer.token(ticker);
        if (!alive) return;
        if (row && row.avatar_txid === txid) {
          clearAvatarRecord(ticker);
          setAv((m) => ({ ...m, reconcile: "done", indexed: row }));
          settledRef.current?.();
          return;
        }
      } catch {
        /* transient — retry on next tick */
      }
      if (alive && attempts >= RECONCILE_MAX_ATTEMPTS) setAv((m) => ({ ...m, reconcile: "timeout" }));
    };
    check();
    const id = setInterval(() => {
      if (attempts < RECONCILE_MAX_ATTEMPTS) check();
    }, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [av.phase, av.reconcile, av.revealTxid, ticker]);

  return { avatar: av, isDeployer, pickFile, start, resume, discard, reset, busy: AVATAR_BUSY.has(av.phase) };
}
