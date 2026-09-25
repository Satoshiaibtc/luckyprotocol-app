import { useCallback, useEffect, useRef, useState } from "react";
import { hex, base64 } from "@scure/base";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { buildPayPsbt, expectPsbtPayload, minFeeInputSats, outpointKey } from "../lib/psbt.js";
import { withPending } from "../lib/pending.js";
import {
  adoptExistingCommit,
  buildEnvelopeScript,
  buildRevealPsbt,
  buildSweepPsbt,
  bytesToDataUrl,
  classifyCommitState,
  classifyNodeRejection,
  clearAvatarRecord,
  commitAmountFor,
  commitPayment,
  compressAvatar,
  ephemeralXonly,
  finalizeReveal,
  generateEphemeralKey,
  loadAvatarRecord,
  unlockAvatarRecord,
  deriveRecordKey,
  signatureToBytes,
  AVATAR_KEY_DOMAIN,
  retryOn503,
  revealRebuildReason,
  signRevealEphemeral,
  signSweep,
  writeAvatarRecord,
} from "../lib/inscribe.js";
import { friendlyError } from "./useWallet.js";

const STATUS_POLL_MS = 15_000;
const RECONCILE_MAX_ATTEMPTS = 8;
const SEEDING_NOTE = "indexer is scanning the commit address…";
const NO_FEE_RATE = "No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.";
const STALE_INPUT_ERROR =
  "The node refused the reveal because one of the wallet inputs it used was already spent (the UTXO list was stale) while the commit output is still unspent. Those inputs are set aside for this session — try again to build with other inputs.";
const EARLIER_REVEAL_NOTE = "The node still holds the earlier reveal in its mempool, so the rebuilt one was not accepted — waiting on the earlier one.";

export const IDLE_AVATAR = { phase: "idle" };
export const AVATAR_BUSY = new Set([
  "compressing",
  "commit-checking",
  "commit-building",
  "commit-signing",
  "commit-broadcast",
  "reveal-building",
  "reveal-signing",
  "reveal-broadcast",
  "pending",
]);
/** Phases a stored record owns: no picker, no main button — every action lives in the notice / status line. */
export const AVATAR_RECORD_PHASES = new Set(["locked", "resumable", "invalid-record", "commit-unpaid", "commit-unverified", "commit-spent"]);

const NO_SIGN_MESSAGE = "This wallet cannot sign messages, so the recovery record (which holds a private key) cannot be stored encrypted — the inscription was not started. Use UniSat or OKX Wallet.";
const NON_DETERMINISTIC = "The wallet produced two different signatures for the same message, so a key derived from it could not be re-derived later; the recovery record cannot be protected and the inscription was not started.";

const outpointOf = (o) => `${o.txid}:${o.vout}`;
/** Prior commits minus the ones already proven spent / swept. */
function withoutPrior(list, txid, vout) {
  return (list || []).filter((o) => !(o.txid === txid && o.vout === vout));
}

const rawMessage = (e) => String(e?.message || e || "unknown error");
/** True once the reveal is confirmed AND the indexer applied it (the record is only kept for prior commits). */
const s_isApplied = (s) => s.phase === "confirmed" && s.reconcile === "done";

function previewOf(rec) {
  const bytes = base64.decode(rec.bytesBase64);
  return { bytes, contentType: rec.contentType, sizeBytes: bytes.length, dataUrl: bytesToDataUrl(bytes, rec.contentType), width: null, height: null, quality: null };
}

/** Panel state for whatever 'lp.avatar.<TICKER>' holds: nothing → idle, encrypted → locked, unreadable → invalid-record, else resumable. */
function stateFromStorage(ticker) {
  const { status, record } = loadAvatarRecord(ticker);
  if (status === "encrypted") return { phase: "locked" };
  if (status === "corrupt") return { phase: "invalid-record" };
  if (status === "ok") return { phase: "resumable", record, preview: previewOf(record) };
  return IDLE_AVATAR;
}

/**
 * The §8.5 avatar flow (two transactions, one throw-away key):
 *
 *   idle → compressing → compressed (preview)
 *        → commit-building → commit-signing → commit-broadcast
 *        → reveal-building → reveal-signing → reveal-broadcast
 *        → pending → confirmed (+ reconcile with /tokens/:ticker)          ↘ error
 *   resumable (a 'lp.avatar.<TICKER>' record exists) → resume() re-enters above:
 *        no commitTxid, commitAttemptedAt set → commit-checking → (adopt) reveal | commit-unpaid
 *        commitTxid, no revealTxid            → reveal straight away; the node decides
 *        revealTxid                           → pending (rebuildReveal after 30 min / never seen)
 *   commit-unverified  the node refused the reveal for an input reason but nothing proves the
 *                      commit is spent (an unconfirmed commit is invisible to the indexer's
 *                      confirmed-UTXO listing): non-terminal — Retry reveal / Check again /
 *                      (confirmed) Pay commit again, which keeps the earlier commit as a
 *                      `priorCommits` entry that can be swept later (audit M-7)
 *   commit-spent   the commit tx is CONFIRMED and the confirmed listing lacks its output
 *                  (terminal: watch the token, pay again, discard)
 *   invalid-record the stored record failed its bounds (discard only)
 *
 * Every phase has a way out: the busy phases resolve or fail into `error`
 * (Resume / Rebuild / Reset), and every non-busy phase carries Resume,
 * Pay commit again, Rebuild reveal or Discard.
 *
 * The recovery record is written the moment the ephemeral key exists,
 * stamped `commitAttemptedAt` BEFORE the wallet signs the commit (so a
 * broadcast that went out but reported failure is found again rather than
 * paid twice), and cleared only when the reveal is confirmed AND the
 * indexer reports `avatar_txid == revealTxid`. `walletState` must be the
 * token's deployer.
 */
export function useAvatar({ wallet: walletState, ticker, tokenInfo, feeRateSatVb, onSettled }) {
  const [av, setAv] = useState(IDLE_AVATAR);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const runningRef = useRef(false);
  // Wallet inputs a node refused as already spent (stale UTXO list): skipped for the rest of the session.
  const staleRef = useRef(new Set());
  // The wallet-derived AES key that protects the stored record (L-13); per address, memory only.
  const keyRef = useRef({ address: null, key: null });

  const connected = walletState.status === "connected";
  const address = connected ? walletState.address : null;
  const pubkeyHex = connected ? walletState.pubkeyHex : null;
  const isDeployer = !!address && !!tokenInfo && tokenInfo.deployer === address;

  // Wallet / ticker change: drop in-flight UI state, re-read the record.
  useEffect(() => {
    staleRef.current = new Set();
    if (keyRef.current.address !== address) keyRef.current = { address, key: null };
    if (!isDeployer) {
      setAv(IDLE_AVATAR);
      return;
    }
    setAv(stateFromStorage(ticker));
  }, [address, ticker, isDeployer]);

  /**
   * The record key for this address: cached for the session, else derived
   * from the wallet's signature of AVATAR_KEY_DOMAIN. `verify:true` (record
   * creation) signs twice and refuses a non-deterministic signer. The mock
   * provider has no signMessage and is the only plaintext fallback (null).
   */
  const ensureRecordKey = useCallback(
    async ({ verify = false } = {}) => {
      if (wallet.isMockWallet()) return null;
      if (!wallet.canSignMessage()) throw new Error(NO_SIGN_MESSAGE);
      if (keyRef.current.address === address && keyRef.current.key) return keyRef.current.key;
      setAv((s) => ({ ...s, note: "Sign the message in your wallet to derive the record key (no transaction, no fee)…" }));
      const sig1 = await wallet.signMessage(AVATAR_KEY_DOMAIN);
      if (verify) {
        const sig2 = await wallet.signMessage(AVATAR_KEY_DOMAIN);
        if (sig1 !== sig2) throw new Error(NON_DETERMINISTIC);
      }
      const key = await deriveRecordKey(signatureToBytes(sig1), address);
      keyRef.current = { address, key };
      setAv((s) => ({ ...s, note: null }));
      return key;
    },
    [address],
  );

  /** 'locked' → one wallet signature decrypts the stored record. */
  const unlock = useCallback(async () => {
    if (!isDeployer || runningRef.current) return;
    runningRef.current = true;
    try {
      const key = await ensureRecordKey();
      if (!key) {
        setAv({ phase: "locked", error: "This record was written by a real wallet and cannot be opened by the simulated wallet." });
        return;
      }
      const r = await unlockAvatarRecord(ticker, key);
      if (r.status === "ok") setAv({ phase: "resumable", record: r.record, preview: previewOf(r.record) });
      else if (r.status === "wrong-key") setAv({ phase: "locked", error: "That signature does not open this record. It was created by a different wallet account — connect the account that started the inscription." });
      else if (r.status === "absent") setAv(IDLE_AVATAR);
      else setAv({ phase: "invalid-record" });
    } catch (e) {
      setAv((s) => ({ ...s, phase: "locked", error: friendlyError(e), note: null }));
    } finally {
      runningRef.current = false;
    }
  }, [isDeployer, ticker, ensureRecordKey]);

  const needFeeRate = useCallback(() => {
    if (!Number.isInteger(feeRateSatVb) || feeRateSatVb < 1) throw new Error(NO_FEE_RATE);
  }, [feeRateSatVb]);

  // An error thrown while broadcasting is the node's / relay's own words,
  // never a declined signature — keep it verbatim (friendlyError would read
  // "rejecting replacement" as a wallet decline).
  const fail = useCallback((e, extra = {}) => {
    runningRef.current = false;
    setAv((s) => ({ ...s, phase: "error", error: /-broadcast$/.test(String(s.phase)) ? rawMessage(e) : friendlyError(e), note: null, ...extra }));
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
    const stale = staleRef.current;
    return {
      utxoRes: { ...utxoRes, utxos: utxoRes.utxos.filter((u) => !stale.has(outpointKey(u))) },
      tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), address),
    };
  }, [address]);

  /** `/btc-utxos/:commitAddress`, riding out the 503 the indexer answers while it seeds a new address. */
  const listCommitAddress = useCallback(
    (rec) =>
      retryOn503(() => indexer.btcUtxos(rec.commitAddress), {
        attempts: 3,
        delayMs: 2_000,
        onRetry: () => setAv((s) => ({ ...s, note: SEEDING_NOTE })),
      }),
    [],
  );

  /** Commit: a plain payment of `commitAmount` to the commit address. Returns the updated record. */
  const runCommit = useCallback(
    async (rec) => {
      setAv((s) => ({ ...s, phase: "commit-building", record: rec, error: null, note: null }));
      // Register the commit address with the indexer BEFORE the commit can
      // reach the mempool: the indexer's mempool tracker only records
      // outputs to addresses it already knows, so a query made after the
      // broadcast would list nothing until the commit confirms (M-7). The
      // first answer is a seeding 503 — fire and forget.
      indexer.btcUtxos(rec.commitAddress).catch(() => {});
      const { utxoRes, tokenOutpoints } = await fetchInputs();
      const built = buildPayPsbt({
        address,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints,
        feeRateSatVb,
        toAddress: rec.commitAddress,
        amountSats: rec.commitAmount,
        minInputSats: minFeeInputSats(utxoRes.assetSafe), // M-8
      });
      // Duplicate-commit guard, part 1: note the attempt BEFORE the wallet can
      // sign or broadcast anything, so a resume after a mid-flight failure
      // looks at the commit address instead of paying again.
      const attempted = { ...rec, commitAttemptedAt: Date.now() };
      if (!(await writeAvatarRecord(attempted, keyRef.current.key))) {
        throw new Error("This browser blocks localStorage — the recovery record could not be updated, so the commit was not signed.");
      }
      setAv((s) => ({ ...s, phase: "commit-signing", record: attempted, commitFeeSats: built.feeSats, commitFeeRate: built.feeRateSatVb, utxoSource: utxoRes.source, assetSafe: utxoRes.assetSafe, signingInputs: built.inputs }));
      // Sign-time guard: the commit is a plain payment — no OP_RETURN at all.
      expectPsbtPayload(built.psbtHex, { op: null });
      const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
      setAv((s) => ({ ...s, phase: "commit-broadcast" }));
      const txid = await wallet.broadcastSignedPsbt(signed);
      const next = {
        ...attempted,
        commitTxid: txid,
        commitVout: 0,
        commitSats: rec.commitAmount,
        commitChange: built.changeOmitted ? null : { vout: built.changeVout, sats: built.changeSats },
        commitInputs: built.inputs.map(({ txid: t, vout }) => ({ txid: t, vout })),
      };
      await writeAvatarRecord(next, keyRef.current.key);
      setAv((s) => ({ ...s, record: next, commitTxid: txid, commitAt: Date.now() }));
      return next;
    },
    [address, pubkeyHex, feeRateSatVb, fetchInputs],
  );

  /**
   * Duplicate-commit guard, part 2: an output already sitting at the commit
   * address (≥ commitAmount, confirmed or not) is adopted as the commit.
   * Returns the updated record, or null when nothing is there.
   */
  const adoptCommit = useCallback(
    async (rec, { excludeKeys = [] } = {}) => {
      setAv((s) => ({ ...s, phase: "commit-checking", record: rec, error: null, note: null }));
      const rows = await listCommitAddress(rec);
      const found = adoptExistingCommit(rows, rec.commitAmount, { excludeKeys });
      if (!found) return null;
      const next = { ...rec, commitTxid: found.txid, commitVout: found.vout, commitSats: found.sats, commitChange: null, commitInputs: [] };
      await writeAvatarRecord(next, keyRef.current.key);
      setAv((s) => ({ ...s, record: next, commitTxid: found.txid, note: null, adoptedCommit: true }));
      return next;
    },
    [listCommitAddress],
  );

  /** One look at the commit output: the confirmed-UTXO listing + the commit tx's own status. */
  const inspectCommit = useCallback(
    async (rec) => {
      let listingOk = false;
      let listed = false;
      try {
        const rows = await listCommitAddress(rec);
        listingOk = true;
        listed = rows.some((u) => u.txid === rec.commitTxid && u.vout === rec.commitVout);
      } catch {
        listingOk = false;
      }
      let cs = null;
      try {
        cs = rec.commitTxid ? await indexer.txStatus(rec.commitTxid) : null;
      } catch {
        cs = null;
      }
      const commitStatus = cs ? { confirmed: cs.confirmed, seen: cs.seen === true, inMempool: cs.in_mempool, blockHeight: cs.block_height } : null;
      return { listingOk, listed, commitStatus, verdict: classifyCommitState({ listingOk, listed, commitStatus }) };
    },
    [listCommitAddress],
  );

  /**
   * The node refused the reveal for an input reason. A UTXO listing alone
   * cannot say whether the commit is spent — an UNCONFIRMED commit is
   * invisible to the indexer's confirmed-UTXO listing — so (audit M-7):
   *   commit listed unspent        → a WALLET input was stale: set those aside, error with a retry
   *   rebuild + mempool conflict   → the earlier reveal is still in the mempool: keep waiting on it
   *   commit CONFIRMED and absent  → the block-apply pass saw it spent: 'commit-spent' (terminal)
   *   anything else (503, or absent while unconfirmed) → 'commit-unverified' (non-terminal:
   *                                  Retry reveal / Check again; never "pay again" by default)
   */
  const settleRejectedReveal = useCallback(
    async (rec, kind, usedInputs, err) => {
      const look = await inspectCommit(rec);
      if (look.verdict === "listed") {
        for (const i of usedInputs) staleRef.current.add(outpointKey(i));
        setAv((s) => ({ ...s, phase: "error", error: STALE_INPUT_ERROR, note: null }));
        return;
      }
      if (kind === "mempool-conflict" && rec.revealTxid) {
        setAv((s) => ({
          ...s,
          phase: "pending",
          record: rec,
          revealTxid: rec.revealTxid,
          broadcastAt: rec.revealBroadcastAt,
          rebuildAttemptAt: Date.now(),
          rebuildReason: null,
          note: EARLIER_REVEAL_NOTE,
          pollError: null,
        }));
        return;
      }
      const common = {
        record: rec,
        commitTxid: rec.commitTxid,
        revealTxid: rec.revealTxid,
        spendKind: kind === "mempool-conflict" ? "mempool" : "missing",
        nodeMessage: rawMessage(err).slice(0, 200),
        commitStatus: look.commitStatus,
        listing: look.listingOk ? "absent" : "unavailable",
        checkedAt: Date.now(),
        note: null,
        pollError: null,
      };
      if (look.verdict === "spent") {
        setAv((s) => ({ ...s, ...common, phase: "commit-spent", watchFrom: tokenInfo?.avatar_txid ?? null }));
        return;
      }
      setAv((s) => ({ ...s, ...common, phase: "commit-unverified" }));
    },
    [inspectCommit, tokenInfo?.avatar_txid],
  );

  /**
   * Reveal: wallet signs its inputs first, the app signs input0 last, then
   * broadcast. The commit is spent by txid:vout — no UTXO listing is needed;
   * the node's answer to the broadcast is what decides whether the commit
   * output still exists. `rebuild:true` re-reveals an already-broadcast
   * record with fresh inputs at the current fee rate.
   */
  const runReveal = useCallback(
    async (rec, { rebuild = false } = {}) => {
      setAv((s) => ({ ...s, phase: "reveal-building", record: rec, commitTxid: rec.commitTxid, error: null, note: null }));
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
        commit: { txid: rec.commitTxid, vout: rec.commitVout, sats: rec.commitSats ?? rec.commitAmount },
        ephemeralPriv,
        leafScript,
        deployerAddress: address,
        deployerPubkeyHex: pubkeyHex,
        utxos,
        tokenOutpoints,
        feeRateSatVb,
        ticker,
        minInputSats: minFeeInputSats(utxoRes.assetSafe), // M-8
      });
      setAv((s) => ({ ...s, phase: "reveal-signing", revealFeeSats: built.feeSats, revealFeeRate: built.feeRateSatVb, revealInputCount: built.walletInputIndexes.length, utxoSource: utxoRes.source, assetSafe: utxoRes.assetSafe, signingInputs: built.inputs }));
      // Sign-time guard (M-1): exactly one OP_RETURN and it is AVATAR|<this ticker>.
      expectPsbtPayload(built.psbtHex, { op: "AVATAR", ticker });
      // 1. wallet: its inputs only, finalized
      const walletSigned = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.walletInputIndexes, address });
      // 2. app: input0 via the script path with the throw-away key
      const appSigned = signRevealEphemeral(walletSigned, ephemeralPriv);
      // 3. extract + broadcast
      const { rawHex, txid: builtTxid } = finalizeReveal(appSigned);
      setAv((s) => ({ ...s, phase: "reveal-broadcast" }));
      let txid;
      try {
        txid = await wallet.broadcastRawTx(rawHex);
      } catch (e) {
        const kind = classifyNodeRejection(e);
        if (kind === "already-known") {
          txid = builtTxid; // byte-identical to a tx the node already holds: that IS our reveal
        } else if (kind === "missing-or-spent" || kind === "mempool-conflict") {
          await settleRejectedReveal(rec, kind, built.inputs, e);
          return null;
        } else {
          throw e;
        }
      }
      const unchanged = rebuild && txid === rec.revealTxid;
      const next = { ...rec, revealTxid: txid, revealBroadcastAt: unchanged && rec.revealBroadcastAt ? rec.revealBroadcastAt : Date.now() };
      await writeAvatarRecord(next, keyRef.current.key);
      setAv((s) => ({
        ...s,
        phase: "pending",
        record: next,
        revealTxid: txid,
        broadcastAt: next.revealBroadcastAt,
        rebuildAttemptAt: rebuild ? Date.now() : null,
        rebuildReason: null,
        seen: null,
        commitUnspent: null,
        note: unchanged ? "The rebuilt reveal is identical to the one the node already holds — its txid is unchanged." : rebuild ? "Reveal rebuilt and rebroadcast with fresh inputs." : null,
        pollError: null,
      }));
      return next;
    },
    [address, pubkeyHex, feeRateSatVb, ticker, fetchInputs, settleRejectedReveal],
  );

  /** From a compressed preview: new ephemeral key → record → commit → reveal. */
  const start = useCallback(async () => {
    if (!isDeployer || !av.preview || runningRef.current) return;
    if (!Number.isInteger(feeRateSatVb) || feeRateSatVb < 1) {
      fail(new Error(NO_FEE_RATE));
      return;
    }
    runningRef.current = true;
    try {
      // The record key first: nothing is generated or stored until the
      // record can be written encrypted (L-13).
      await ensureRecordKey({ verify: true });
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
        commitSats: null,
        commitChange: null,
        commitInputs: [],
        commitAttemptedAt: null,
        revealTxid: null,
        revealBroadcastAt: null,
        feeRateSatVb,
        createdAt: Date.now(),
      };
      if (!(await writeAvatarRecord(rec, keyRef.current.key))) {
        throw new Error("This browser blocks localStorage — the recovery key could not be saved, so the inscription was not started.");
      }
      const afterCommit = await runCommit(rec);
      await runReveal(afterCommit);
    } catch (e) {
      fail(e);
    } finally {
      runningRef.current = false;
    }
  }, [isDeployer, av.preview, feeRateSatVb, ticker, runCommit, runReveal, fail, ensureRecordKey]);

  /** Re-enter the flow from the stored record. */
  const resume = useCallback(async () => {
    const rec = av.record || loadAvatarRecord(ticker).record;
    if (!isDeployer || !rec || runningRef.current) return;
    runningRef.current = true;
    try {
      if (rec.revealTxid) {
        setAv((s) => ({
          ...s,
          phase: "pending",
          record: rec,
          revealTxid: rec.revealTxid,
          commitTxid: rec.commitTxid,
          broadcastAt: rec.revealBroadcastAt,
          rebuildAttemptAt: null,
          rebuildReason: null,
          seen: null,
          commitUnspent: null,
          note: null,
          pollError: null,
        }));
        return;
      }
      if (!rec.commitTxid) {
        if (rec.commitAttemptedAt) {
          // A commit was signed (and maybe broadcast) before: find it first, never pay blindly.
          const adopted = await adoptCommit(rec);
          if (!adopted) {
            setAv((s) => ({ ...s, phase: "commit-unpaid", record: rec, note: null, checkedAt: Date.now() }));
            return;
          }
          needFeeRate();
          await runReveal(adopted);
          return;
        }
        needFeeRate();
        await runReveal(await runCommit(rec));
        return;
      }
      // Commit known, reveal not: build and sign right away. A listing that
      // lacks the commit outpoint is inconclusive (the indexer may simply not
      // have seen the commit yet); runReveal lets the node decide.
      needFeeRate();
      await runReveal(rec);
    } catch (e) {
      fail(e);
    } finally {
      runningRef.current = false;
    }
  }, [av.record, isDeployer, ticker, needFeeRate, adoptCommit, runCommit, runReveal, fail]);

  /**
   * Explicit "Pay commit again" (never automatic): one more look at the
   * commit address — an unspent output there is adopted instead — then a
   * fresh commit payment, then the reveal. The earlier commit is excluded
   * from adoption ONLY when it is proven spent ('commit-spent'); otherwise
   * it stays eligible (it may confirm and list later) and, if a new commit
   * is paid, it is kept in `priorCommits` so it can be swept (M-7).
   */
  const payCommit = useCallback(async () => {
    const rec = av.record;
    if (!isDeployer || !rec || runningRef.current) return;
    runningRef.current = true;
    try {
      needFeeRate();
      const provenSpent = av.phase === "commit-spent";
      const excludeKeys = provenSpent && rec.commitTxid ? [`${rec.commitTxid}:${rec.commitVout}`] : [];
      const prior = rec.commitTxid && !provenSpent && Number.isInteger(rec.commitSats ?? rec.commitAmount)
        ? withoutPrior(rec.priorCommits, rec.commitTxid, rec.commitVout).concat([{ txid: rec.commitTxid, vout: rec.commitVout, sats: rec.commitSats ?? rec.commitAmount }])
        : rec.priorCommits || [];
      const base = { ...rec, commitTxid: null, commitVout: null, commitSats: null, commitChange: null, commitInputs: [], revealTxid: null, revealBroadcastAt: null, priorCommits: prior };
      const adopted = await adoptCommit(base, { excludeKeys });
      // Adopting the very commit we set aside means it was never abandoned.
      const withCommit = adopted
        ? { ...adopted, priorCommits: withoutPrior(adopted.priorCommits, adopted.commitTxid, adopted.commitVout) }
        : await runCommit(base);
      await writeAvatarRecord(withCommit, keyRef.current.key);
      await runReveal(withCommit);
    } catch (e) {
      fail(e);
    } finally {
      runningRef.current = false;
    }
  }, [av.record, av.phase, isDeployer, needFeeRate, adoptCommit, runCommit, runReveal, fail]);

  /** 'commit-unverified' → "Retry reveal": the same record, fresh inputs, the node decides again. */
  const retryReveal = useCallback(async () => {
    const rec = av.record;
    if (!isDeployer || !rec || !rec.commitTxid || runningRef.current) return;
    runningRef.current = true;
    try {
      needFeeRate();
      await runReveal(rec, { rebuild: !!rec.revealTxid });
    } catch (e) {
      fail(e);
    } finally {
      runningRef.current = false;
    }
  }, [av.record, isDeployer, needFeeRate, runReveal, fail]);

  /** 'commit-unverified' → "Check again": re-inspect the commit without broadcasting anything. */
  const checkCommit = useCallback(async () => {
    const rec = av.record;
    if (!isDeployer || !rec || !rec.commitTxid || runningRef.current) return;
    runningRef.current = true;
    setAv((s) => ({ ...s, phase: "commit-checking", record: rec, error: null, note: null }));
    try {
      const look = await inspectCommit(rec);
      const common = { record: rec, commitTxid: rec.commitTxid, revealTxid: rec.revealTxid, commitStatus: look.commitStatus, listing: look.listingOk ? (look.listed ? "listed" : "absent") : "unavailable", checkedAt: Date.now(), note: null, pollError: null };
      if (look.verdict === "spent") {
        setAv((s) => ({ ...s, ...common, phase: "commit-spent", spendKind: s.spendKind || "missing", watchFrom: tokenInfo?.avatar_txid ?? null }));
      } else {
        setAv((s) => ({ ...s, ...common, phase: "commit-unverified" }));
      }
    } catch (e) {
      fail(e);
    } finally {
      runningRef.current = false;
    }
  }, [av.record, isDeployer, inspectCommit, tokenInfo?.avatar_txid, fail]);

  /**
   * "Sweep abandoned commit": key-path-spend one `priorCommits` output back
   * to the deployer with the ephemeral key (no envelope, no OP_RETURN),
   * then drop it from the record. A node rejection that says the output is
   * gone also drops it (it was spent after all).
   */
  const sweepCommit = useCallback(
    async (outpoint) => {
      const rec = av.record;
      const target = rec && (rec.priorCommits || []).find((o) => outpointOf(o) === outpoint);
      if (!isDeployer || !rec || !target || runningRef.current) return;
      runningRef.current = true;
      setAv((s) => ({ ...s, sweep: { outpoint, phase: "building", error: null, txid: null } }));
      try {
        needFeeRate();
        const built = buildSweepPsbt({
          commit: target,
          ephemeralPriv: hex.decode(rec.ephemeralPrivHex),
          leafScript: hex.decode(rec.leafScriptHex),
          toAddress: address,
          feeRateSatVb,
        });
        const { rawHex, txid: builtTxid } = signSweep(built.psbtHex, hex.decode(rec.ephemeralPrivHex));
        setAv((s) => ({ ...s, sweep: { outpoint, phase: "broadcast", error: null, txid: null, feeSats: built.feeSats, outSats: built.outSats } }));
        let txid;
        let gone = false;
        try {
          txid = await wallet.broadcastRawTx(rawHex);
        } catch (e) {
          const kind = classifyNodeRejection(e);
          if (kind === "already-known") txid = builtTxid;
          else if (kind === "missing-or-spent") gone = true;
          else throw e;
        }
        const next = { ...rec, priorCommits: withoutPrior(rec.priorCommits, target.txid, target.vout) };
        await writeAvatarRecord(next, keyRef.current.key);
        setAv((s) => ({ ...s, record: next, sweepable: next.priorCommits, sweep: { outpoint, phase: gone ? "gone" : "done", error: null, txid: txid || null, feeSats: built.feeSats, outSats: built.outSats } }));
        // Nothing left to keep the record alive for (reveal applied earlier) → forget the key.
        if (next.priorCommits.length === 0 && s_isApplied(av)) clearAvatarRecord(ticker);
      } catch (e) {
        setAv((s) => ({ ...s, sweep: { outpoint, phase: "error", error: rawMessage(e), txid: null } }));
      } finally {
        runningRef.current = false;
      }
    },
    [av, isDeployer, address, feeRateSatVb, needFeeRate, ticker],
  );

  /**
   * Re-reveal: rebuild from the stored key / leaf / image bytes with fresh
   * deployer inputs at the current fee rate, re-sign (wallet first),
   * rebroadcast and replace revealTxid. A missing / spent-input rejection
   * ends in 'commit-spent'.
   */
  const rebuildReveal = useCallback(async () => {
    const rec = av.record;
    if (!isDeployer || !rec || !rec.commitTxid || runningRef.current) return;
    runningRef.current = true;
    try {
      needFeeRate();
      await runReveal(rec, { rebuild: true });
    } catch (e) {
      fail(e);
    } finally {
      runningRef.current = false;
    }
  }, [av.record, isDeployer, needFeeRate, runReveal, fail]);

  /** Forget the record. If the commit was paid, its sats stay at the commit address unspent. */
  const discard = useCallback(() => {
    clearAvatarRecord(ticker);
    runningRef.current = false;
    staleRef.current = new Set();
    setAv(IDLE_AVATAR);
  }, [ticker]);

  /** Back to the stored record's state without touching it (resumable / invalid-record / idle). */
  const reset = useCallback(() => {
    runningRef.current = false;
    setAv(stateFromStorage(ticker));
  }, [ticker]);

  // Pending with a known reveal txid → poll /tx-status; when the indexer has
  // never seen it, also ask whether the commit output is still unspent, and
  // work out whether "Rebuild reveal" should be offered.
  useEffect(() => {
    if (av.phase !== "pending" || !av.revealTxid) return undefined;
    let alive = true;
    const txid = av.revealTxid;
    const rec = av.record;
    const eligibility = (m, now, seen, commitUnspent) => revealRebuildReason({ now, broadcastAt: m.rebuildAttemptAt || m.broadcastAt || null, seen, commitUnspent });
    const check = async () => {
      try {
        const s = await indexer.txStatus(txid);
        if (!alive) return;
        if (s.confirmed && s.block_hash) {
          setAv((m) => ({ ...m, phase: "confirmed", blockHeight: s.block_height, blockHash: s.block_hash, reconcile: "pending", pollError: null, rebuildReason: null, note: null }));
          settledRef.current?.();
          return;
        }
        const seen = s.seen !== false;
        let commitUnspent = null;
        if (!seen && rec && rec.commitTxid) {
          try {
            const rows = await indexer.btcUtxos(rec.commitAddress);
            commitUnspent = rows.some((u) => u.txid === rec.commitTxid && u.vout === rec.commitVout);
          } catch {
            commitUnspent = null;
          }
        }
        if (!alive) return;
        const now = Date.now();
        setAv((m) => ({ ...m, pollError: null, lastChecked: now, seen, commitUnspent, rebuildReason: eligibility(m, now, seen, commitUnspent) }));
      } catch (e) {
        if (!alive) return;
        const now = Date.now();
        setAv((m) => ({ ...m, pollError: friendlyError(e), rebuildReason: eligibility(m, now, m.seen, m.commitUnspent) }));
      }
    };
    check();
    const id = setInterval(check, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [av.phase, av.revealTxid, av.record]);

  // Commit spent (per the node) → watch the token row for its avatar to
  // change (an earlier, unrecorded reveal may be confirming) and keep the
  // commit's own tx-status in view so the explanation can say whether the
  // commit ever landed.
  useEffect(() => {
    if (av.phase !== "commit-spent") return undefined;
    let alive = true;
    const from = av.watchFrom ?? null;
    const commitTxid = av.commitTxid;
    const check = async () => {
      try {
        const [row, cs] = await Promise.all([indexer.token(ticker), commitTxid ? indexer.txStatus(commitTxid) : Promise.resolve(null)]);
        if (!alive) return;
        if (row && row.avatar_txid && row.avatar_txid !== from) {
          const prior = (av.record && av.record.priorCommits) || [];
          if (prior.length === 0) clearAvatarRecord(ticker);
          setAv((m) => ({ ...m, phase: "confirmed", revealTxid: row.avatar_txid, reconcile: "done", indexed: row, sweepable: prior, pollError: null }));
          settledRef.current?.();
          return;
        }
        setAv((m) => ({
          ...m,
          pollError: null,
          lastChecked: Date.now(),
          commitStatus: cs ? { confirmed: cs.confirmed, seen: cs.seen !== false, blockHeight: cs.block_height } : null,
        }));
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
  }, [av.phase, av.watchFrom, av.commitTxid, av.record, ticker]);

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
          const prior = (av.record && av.record.priorCommits) || [];
          if (prior.length === 0) clearAvatarRecord(ticker);
          staleRef.current = new Set();
          setAv((m) => ({ ...m, reconcile: "done", indexed: row, sweepable: prior }));
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
  }, [av.phase, av.reconcile, av.revealTxid, av.record, ticker]);

  return { avatar: av, isDeployer, pickFile, start, unlock, resume, payCommit, retryReveal, checkCommit, sweepCommit, rebuildReveal, discard, reset, busy: AVATAR_BUSY.has(av.phase) || !!(av.sweep && (av.sweep.phase === "building" || av.sweep.phase === "broadcast")) };
}
