import { useEffect, useRef, useState } from "react";
import { hex, base64 } from "@scure/base";
import * as btc from "@scure/btc-signer";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { ACTIVATION_HEIGHT, TICKER_RE } from "../lib/payloads.js";
import { buildPayPsbt, expectPsbtPayload, extractRawTxHex, minFeeInputSats, outpointKey } from "../lib/psbt.js";
import { addPendingTokenOutpoints, withPending } from "../lib/pending.js";
import {
  AVATAR_KEY_DOMAIN, buildDeployRevealPsbt, buildEnvelopeScript, buildSweepPsbt,
  bytesToDataUrl, clearDeployRecord, commitAmountFor, commitPayment, compressAvatar,
  deriveRecordKey, ephemeralXonly, finalizeReveal, generateEphemeralKey, loadDeployRecord,
  signatureToBytes, signRevealEphemeral, signSweep, unlockDeployRecord, writeDeployRecord,
  classifyNodeRejection, assertRevealWalletResult,
} from "../lib/inscribe.js";

const IDLE = { phase: "idle" };
const TX_OPTIONS = { allowUnknownInputs: true, allowUnknownOutputs: true };

function restored(ticker) {
  if (!TICKER_RE.test(ticker)) return IDLE;
  const saved = loadDeployRecord(ticker);
  if (saved.status === "encrypted") return { phase: "locked" };
  if (saved.status === "corrupt") return { phase: "invalid-record" };
  return saved.record ? fromRecord(saved.record) : IDLE;
}

function fromRecord(record) {
  const bytes = base64.decode(record.bytesBase64);
  return { phase: "resumable", record, preview: { bytes, contentType: record.contentType, sizeBytes: bytes.length, dataUrl: bytesToDataUrl(bytes, record.contentType) } };
}

// Store signed bytes BEFORE handing them to a relay. Retrying after an
// ambiguous network failure reuses the same txid, never another payment.
export function useDeployAvatar({ wallet: account, ticker, feeRateSatVb, onSettled }) {
  const [flow, setFlow] = useState(IDLE);
  const [busy, setBusy] = useState(false);
  const scope = useRef(null);
  const running = useRef(false);
  const keyRef = useRef(null);
  const recordRef = useRef(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const address = account.status === "connected" ? account.address : null;
  const identity = `${account.provider}:${address}:${ticker}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;

  useEffect(() => {
    const session = {};
    scope.current = session;
    running.current = false;
    keyRef.current = null;
    const next = restored(ticker);
    recordRef.current = next.record || null;
    setFlow(next);
    setBusy(false);
    return () => { if (scope.current === session) scope.current = null; };
  }, [identity, ticker]);

  const act = async (fn) => {
    if (running.current || !address) return;
    running.current = true;
    setBusy(true);
    const session = scope.current;
    const check = () => {
      if (!session || scope.current !== session || currentIdentity.current !== identity) throw new Error("Wallet or ticker changed. Resume with the original wallet.");
    };
    const update = (fields) => { check(); setFlow((s) => ({ ...s, ...fields, error: null })); };
    const persist = async (record) => {
      check();
      await writeDeployRecord(record, keyRef.current);
      check();
      recordRef.current = record;
      update({ record });
      return record;
    };
    try {
      // Same-origin tabs share recovery records. Never let two tabs pay
      // for, or overwrite the signed stages of, the same creation.
      if (!globalThis.navigator?.locks) throw new Error("This browser cannot safely lock creation recovery. Use an up-to-date browser.");
      await navigator.locks.request(`lp.deploy.${ticker}`, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("This creation is active in another tab. Finish or close that tab first.");
        check();
        if (recordRef.current) {
          const saved = await unlockDeployRecord(ticker, keyRef.current);
          check();
          if (saved.status !== "ok" || ["ephemeralPrivHex", "commitRawHex", "revealRawHex", "reclaimRawHex"].some((k) => saved.record[k] !== recordRef.current[k])) {
            throw new Error("The recovery record changed in another tab. Reload before continuing.");
          }
        }
        await fn({ check, update, persist });
      });
    }
    catch (e) { if (scope.current === session && currentIdentity.current === identity) setFlow((s) => ({ ...s, phase: "error", error: String(e.message || e) })); }
    finally { if (scope.current === session) { running.current = false; setBusy(false); } }
  };

  const ensureKey = async (check, verify = false) => {
    if (wallet.isMockWallet()) return null;
    if (keyRef.current) return keyRef.current;
    if (!wallet.canSignMessage()) throw new Error("This wallet cannot encrypt the recovery record. Use UniSat or OKX Wallet.");
    const first = await wallet.signMessage(AVATAR_KEY_DOMAIN);
    check();
    if (verify) {
      const second = await wallet.signMessage(AVATAR_KEY_DOMAIN);
      check();
      if (first !== second) throw new Error("Wallet signatures are not repeatable; recovery could not be guaranteed. No payment was made.");
    }
    const key = await deriveRecordKey(signatureToBytes(first), address);
    check();
    keyRef.current = key;
    return key;
  };

  const inputs = async () => {
    const [u, tokens] = await Promise.all([wallet.getBitcoinUtxos(address), indexer.tokenUtxos(address)]);
    return { ...u, tokenOutpoints: withPending(tokens, address) };
  };

  const requireAvailable = async (check) => {
    const [health, token] = await Promise.all([indexer.health(), indexer.token(ticker)]);
    check();
    if (health.tip_height == null || health.tip_height < ACTIVATION_HEIGHT || health.indexed_height == null || health.indexed_height < health.tip_height || health.stalled) {
      throw new Error("Creation is paused until the indexer is synced and the protocol is active.");
    }
    if (token) throw new Error(`${ticker} has already been registered. Reclaim the avatar payment instead of creating another transaction.`);
  };

  const relay = async (rawHex, txid, check) => {
    check();
    try {
      const result = await wallet.broadcastRawTx(rawHex);
      if (result !== txid) throw new Error("Relay returned an unexpected transaction ID. The signed transaction is saved for recovery.");
    } catch (e) {
      if (classifyNodeRejection(e) !== "already-known") throw e;
    }
    check();
  };

  const continueRecord = async (rec, ctx) => {
    const { check, update, persist } = ctx;
    if (rec.address !== address) throw new Error("Connect the wallet that started this token creation.");
    if (rec.reclaimTxid) {
      await relay(rec.reclaimRawHex, rec.reclaimTxid, check);
      update({ phase: "reclaim-pending" });
      return;
    }
    if (rec.revealTxid) {
      // An already signed DEPLOY may have confirmed; polling decides the
      // outcome before a retry, including a competing registration.
      update({ phase: "pending" });
      return;
    }
    await requireAvailable(check);
    if (!rec.commitRawHex) {
      update({ phase: "commit-building" });
      // Register before the payment enters the node's mempool.
      await indexer.btcUtxos(rec.commitAddress).catch((e) => { if (e.status !== 503 && !/503/.test(e.message)) throw e; });
      const u = await inputs();
      check();
      const built = buildPayPsbt({ address, pubkeyHex: account.pubkeyHex, utxos: u.utxos, tokenOutpoints: u.tokenOutpoints, feeRateSatVb, toAddress: rec.commitAddress, amountSats: rec.commitAmount, minInputSats: minFeeInputSats(u.assetSafe) });
      expectPsbtPayload(built.psbtHex, { op: null });
      await requireAvailable(check);
      update({ phase: "commit-signing" });
      const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
      check();
      assertRevealWalletResult(built.psbtHex, signed);
      const raw = extractRawTxHex(signed);
      const tx = btc.Transaction.fromRaw(hex.decode(raw), TX_OPTIONS);
      rec = await persist({ ...rec, commitRawHex: raw, commitTxid: tx.id, commitVout: 0, commitSats: rec.commitAmount, commitInputs: built.inputs, commitChange: built.changeOmitted ? null : { vout: built.changeVout, sats: built.changeSats }, commitAttemptedAt: Date.now() });
    }
    update({ phase: "commit-broadcast" });
    await relay(rec.commitRawHex, rec.commitTxid, check);
    addPendingTokenOutpoints(rec.commitInputs, address);
    await requireAvailable(check);
    update({ phase: "reveal-building" });
    const u = await inputs();
    check();
    const spent = new Set(rec.commitInputs.map(outpointKey));
    const utxos = u.utxos.filter((o) => !spent.has(outpointKey(o)));
    if (rec.commitChange && !utxos.some((o) => o.txid === rec.commitTxid && o.vout === rec.commitChange.vout)) {
      utxos.push({ txid: rec.commitTxid, ...rec.commitChange });
    }
    const priv = hex.decode(rec.ephemeralPrivHex);
    const built = buildDeployRevealPsbt({ commit: { txid: rec.commitTxid, vout: rec.commitVout, sats: rec.commitSats }, ephemeralPriv: priv, leafScript: hex.decode(rec.leafScriptHex), deployerAddress: address, deployerPubkeyHex: account.pubkeyHex, utxos, tokenOutpoints: u.tokenOutpoints, feeRateSatVb, ticker, minInputSats: minFeeInputSats(u.assetSafe) });
    expectPsbtPayload(built.psbtHex, { op: "DEPLOY", ticker });
    await requireAvailable(check);
    update({ phase: "reveal-signing" });
    const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.walletInputIndexes, address });
    check();
    assertRevealWalletResult(built.psbtHex, signed);
    const reveal = finalizeReveal(signRevealEphemeral(signed, priv));
    rec = await persist({ ...rec, revealRawHex: reveal.rawHex, revealTxid: reveal.txid, revealBroadcastAt: Date.now() });
    await requireAvailable(check);
    update({ phase: "reveal-broadcast" });
    await relay(rec.revealRawHex, rec.revealTxid, check);
    addPendingTokenOutpoints(built.inputs, address);
    update({ phase: "pending" });
  };

  const pickFile = (file) => act(async ({ check, update }) => {
    if (recordRef.current || loadDeployRecord(ticker).status !== "absent") throw new Error("Resume or reclaim the saved creation first.");
    update({ phase: "compressing" });
    const image = await compressAvatar(file);
    check();
    update({ phase: "ready", preview: { ...image, sizeBytes: image.bytes.length, dataUrl: bytesToDataUrl(image.bytes, image.contentType) } });
  });

  const start = () => act(async (ctx) => {
    if (!flow.preview || recordRef.current || loadDeployRecord(ticker).status !== "absent") throw new Error("An unfinished creation already exists. Resume it first.");
    await requireAvailable(ctx.check);
    ctx.update({ phase: "securing" });
    await ensureKey(ctx.check, true);
    if (loadDeployRecord(ticker).status !== "absent") throw new Error("Another creation was saved while the wallet was open. Reload to recover it.");
    const priv = generateEphemeralKey();
    const leaf = buildEnvelopeScript(ephemeralXonly(priv), flow.preview.contentType, flow.preview.bytes);
    const rec = await ctx.persist({ kind: "deploy", address, ticker, ephemeralPrivHex: hex.encode(priv), leafScriptHex: hex.encode(leaf), contentType: flow.preview.contentType, bytesBase64: base64.encode(flow.preview.bytes), commitAddress: commitPayment(priv, leaf).address, commitAmount: commitAmountFor({ leafScriptLen: leaf.length, feeRateSatVb }), commitInputs: [], createdAt: Date.now(), feeRateSatVb });
    await continueRecord(rec, ctx);
  });

  const unlock = () => act(async ({ check, update }) => {
    const key = await ensureKey(check);
    const saved = await unlockDeployRecord(ticker, key);
    check();
    if (saved.status !== "ok" || saved.record.address !== address) throw new Error("This wallet cannot open the saved creation. Connect the original account.");
    recordRef.current = saved.record;
    update(fromRecord(saved.record));
  });

  const resume = () => act((ctx) => continueRecord(recordRef.current, ctx));
  const retryBroadcast = () => act(async ({ check, update }) => {
    const rec = recordRef.current;
    await requireAvailable(check);
    await relay(rec.revealRawHex, rec.revealTxid, check);
    update({ phase: "pending" });
  });

  const reclaim = () => act(async ({ check, update, persist }) => {
    let rec = recordRef.current;
    if (!rec || rec.address !== address || !rec.commitTxid) throw new Error("No saved avatar payment to reclaim.");
    if (rec.reclaimTxid) {
      await relay(rec.reclaimRawHex, rec.reclaimTxid, check);
    } else {
      // Refuse a conflicting sweep while a reveal is in the mempool or
      // confirmed. An unavailable status is an error, not permission.
      if (rec.revealTxid) {
        const s = await indexer.txStatus(rec.revealTxid);
        check();
        if (s.seen !== false || s.confirmed || s.in_mempool) throw new Error("The creation transaction is already known to the node. Wait for its result before reclaiming.");
      }
      await relay(rec.commitRawHex, rec.commitTxid, check);
      const built = buildSweepPsbt({ commit: { txid: rec.commitTxid, vout: rec.commitVout, sats: rec.commitSats }, ephemeralPriv: hex.decode(rec.ephemeralPrivHex), leafScript: hex.decode(rec.leafScriptHex), toAddress: address, feeRateSatVb });
      const sweep = signSweep(built.psbtHex, hex.decode(rec.ephemeralPrivHex));
      rec = await persist({ ...rec, reclaimRawHex: sweep.rawHex, reclaimTxid: sweep.txid });
      await relay(rec.reclaimRawHex, rec.reclaimTxid, check);
    }
    update({ phase: "reclaim-pending" });
  });

  const discard = () => {
    if (running.current || recordRef.current?.commitRawHex) return;
    clearDeployRecord(ticker);
    recordRef.current = null;
    setFlow(IDLE);
  };

  useEffect(() => {
    const rec = flow.record;
    if (!rec || !["pending", "reclaim-pending"].includes(flow.phase)) return undefined;
    let alive = true;
    let timer;
    const poll = async () => {
      try {
        const txid = flow.phase === "reclaim-pending" ? rec.reclaimTxid : rec.revealTxid;
        const status = await indexer.txStatus(txid);
        if (!alive) return;
        if (status.confirmed) {
          const token = flow.phase === "pending" ? await indexer.token(ticker) : null;
          if (!alive) return;
          if (flow.phase === "pending" && !token) {
            setFlow((s) => ({ ...s, note: "Confirmed; waiting for the token registry." }));
          } else {
            const ours = token?.deploy_txid === rec.revealTxid && token?.deployer === rec.address;
            clearDeployRecord(ticker);
            recordRef.current = null;
            setFlow((s) => ({ ...s, phase: rec.reclaimTxid ? "reclaimed" : ours ? "confirmed" : "name-taken", avatarApplied: ours && token.avatar_txid === rec.revealTxid, note: null, record: null }));
            settledRef.current?.();
            return;
          }
        } else {
          setFlow((s) => ({ ...s, unseen: status.seen === false, note: null }));
        }
      } catch (e) { if (alive) setFlow((s) => ({ ...s, note: String(e.message || e) })); }
      if (alive) timer = setTimeout(poll, 15_000);
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [flow.phase, flow.record, ticker]);

  return { flow, busy, pickFile, start, unlock, resume, reclaim, retryBroadcast, discard, hasSaved: !!flow.record || ["locked", "invalid-record"].includes(flow.phase) || (TICKER_RE.test(ticker) && loadDeployRecord(ticker).status !== "absent") };
}
