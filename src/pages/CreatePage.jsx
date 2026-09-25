import { useEffect, useMemo, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as wallet from "../lib/wallet.js";
import { useTxStatus } from "../hooks/useTxStatus.js";
import { friendlyError } from "../hooks/useWallet.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { buildDeployPsbt, estimateDeployFeeSats, expectPsbtPayload, minFeeInputSats } from "../lib/psbt.js";
import { withPending } from "../lib/pending.js";
import { missingFeeHint } from "../lib/feechoice.js";
import { ACTIVATION_HEIGHT, DEPLOY_PROTOCOL_FEE_SATS, DUST_SATS, PROJECT_FEE_ADDRESS, REQUIRED_TOKEN_SUPPLY, TICKER_RE } from "../lib/payloads.js";
import { BUCKETS, EXPECTED_YIELD } from "../lib/yield.js";
import { fmtDec, fmtInt, fmtSats } from "../lib/format.js";
import TokenCard from "../components/TokenCard.jsx";
import TxProgress, { ConnectPrompt } from "../components/TxProgress.jsx";
import FeeSelector from "../components/FeeSelector.jsx";
import UtxoSafetyNotice from "../components/UtxoSafetyNotice.jsx";
import Panel from "../components/hud/Panel.jsx";
import Led from "../components/hud/Led.jsx";
import CreateAvatarFields from "../components/CreateAvatarFields.jsx";
import { useDeployAvatar } from "../hooks/useDeployAvatar.js";
import { savedDeployTickers } from "../lib/inscribe.js";

const IDLE = { phase: "idle" };
const AVAIL_LED = { idle: "idle", checking: "busy", free: "ok", taken: "err", error: "err" };

export default function CreatePage({ params, navigate }) {
  const { wallet: walletState, address, pubkeyHex, fee, indexerOk, health, refreshAll } = useApp();
  const connected = walletState.status === "connected";
  // A DEPLOY below the activation height is ignored by the indexer (fees
  // lost). An UNKNOWN tip counts as pre-activation: the gate must fail
  // closed, never open (audit L-12).
  const tipNow = health.data?.tip_height ?? null;
  const tipUnknown = tipNow === null;
  const preActivation = tipUnknown || tipNow < ACTIVATION_HEIGHT;
  const [ticker, setTicker] = useState(() => String(params.ticker || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8));
  const valid = TICKER_RE.test(ticker);

  // Live availability: /tokens/:ticker → null (404) means free.
  const [avail, setAvail] = useState({ ticker: "", state: "idle" }); // idle | checking | free | taken | error
  useEffect(() => {
    if (!valid) {
      setAvail({ ticker, state: "idle" });
      return undefined;
    }
    let alive = true;
    setAvail({ ticker, state: "checking" });
    const id = setTimeout(async () => {
      try {
        const row = await indexer.token(ticker);
        if (alive) setAvail({ ticker, state: row ? "taken" : "free", row });
      } catch (e) {
        if (alive) setAvail({ ticker, state: "error", error: friendlyError(e) });
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [ticker, valid]);

  const feeRate = fee.satVb;
  const creation = useDeployAvatar({ wallet: walletState, ticker, feeRateSatVb: feeRate, onSettled: refreshAll });
  const avatarFlow = creation.flow;
  const feeEstimate = useMemo(() => {
    if (!feeRate || !valid) return null;
    try {
      return estimateDeployFeeSats({ address: address || PROJECT_FEE_ADDRESS, ticker, feeRateSatVb: feeRate });
    } catch {
      return null;
    }
  }, [feeRate, valid, address, ticker]);

  const [flow, setFlow] = useState(IDLE);
  useEffect(() => {
    setFlow(IDLE);
  }, [address]);
  const status = useTxStatus(flow.phase === "pending" || flow.phase === "confirmed" ? flow.txid : null, {
    onConfirmed: () => {
      setFlow((f) => ({ ...f, phase: "confirmed" }));
      refreshAll();
    },
  });
  const busy = creation.busy || ["pending", "reclaim-pending"].includes(avatarFlow.phase) || ["building", "signing", "broadcasting", "pending"].includes(flow.phase);

  // Confirmed → hop to the token page once the indexer lists it (it polls anyway).
  useEffect(() => {
    if (flow.phase !== "confirmed") return undefined;
    const id = setTimeout(() => navigate(tokenHref(flow.ticker)), 1800);
    return () => clearTimeout(id);
  }, [flow.phase, flow.ticker, navigate]);

  const create = async () => {
    if (!connected || !valid || avail.ticker !== ticker || avail.state !== "free" || busy || !indexerOk || preActivation || creation.hasSaved) return;
    if (avatarFlow.preview) { await creation.start(); return; }
    const t = ticker;
    setFlow({ phase: "building", ticker: t });
    try {
      if (!Number.isInteger(feeRate) || feeRate < 1) {
        throw new Error("No fee rate — the indexer has no estimate; pick Custom and enter a sat/vB.");
      }
      const [utxoRes, tokenRows] = await Promise.all([wallet.getBitcoinUtxos(address), indexer.tokenUtxos(address)]);
      // A DEPLOY routes nothing (§4.2): a token UTXO spent as a fee input
      // would have its tokens default-routed to vout0 — the §4 filter is
      // applied here exactly as for MINE.
      const built = buildDeployPsbt({
        address,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout })), address),
        feeRateSatVb: feeRate,
        ticker: t,
        minInputSats: minFeeInputSats(utxoRes.assetSafe), // M-8
      });
      setFlow({
        phase: "signing",
        ticker: t,
        feeSats: built.feeSats,
        feeRateSatVb: built.feeRateSatVb,
        inputs: built.inputs,
        assetSafe: utxoRes.assetSafe,
        detail: `${built.inputIndexes.length} input${built.inputIndexes.length === 1 ? "" : "s"}${utxoRes.source === "indexer" ? " · inputs from indexer" : ""}`,
      });
      // Sign-time guard: exactly one OP_RETURN, and it is DEPLOY|<this ticker>.
      expectPsbtPayload(built.psbtHex, { op: "DEPLOY", ticker: t });
      const signed = await wallet.signPsbt(built.psbtHex, { inputIndexes: built.inputIndexes, address });
      setFlow((f) => ({ ...f, phase: "broadcasting" }));
      const txid = await wallet.broadcastSignedPsbt(signed);
      setFlow((f) => ({ ...f, phase: "pending", txid }));
    } catch (e) {
      setFlow((f) => ({ ...f, phase: "error", error: friendlyError(e) }));
    }
  };

  const preview = {
    ticker: valid ? ticker : "TICKER",
    supply: REQUIRED_TOKEN_SUPPLY,
    minted: 0,
    deployer: address || "bc1p…you",
    deploy_txid: "0".repeat(64),
    deploy_block: health.data?.tip_height ? health.data.tip_height + 1 : 0,
    holders: 0,
    mine_count: 0,
  };

  const yieldsLine = `${BUCKETS.map((b) => b.yield).join(" / ")} by the confirming block's last hex digit (${BUCKETS.map((b) => b.label).join(" / ")}) · expected ${fmtDec(EXPECTED_YIELD)}`;

  return (
    <main className="page create-page">
      <div className="create-layout">
        <Panel title="Deploy // new ticker" led={ledFor(avail.state)} right={<span className="label">DEPLOY · §2.1</span>} aria-label="Deploy a new ticker">
          {savedDeployTickers().length > 0 && <div className="notice">
            <span className="label">Saved creations</span>
            <div className="actions create-avatar-actions">{savedDeployTickers().map((saved) => <button key={saved} type="button" className="btn btn-sm" disabled={busy} onClick={() => setTicker(saved)}>Resume {saved}</button>)}</div>
          </div>}
          <label className="field">
            <span className="label">Ticker</span>
            <span className="ticker-field">
              <input
                className="input mono ticker-input"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                placeholder="TICKER"
                maxLength={8}
                autoComplete="off"
                spellCheck={false}
                disabled={busy || creation.hasSaved}
                aria-describedby="ticker-help"
              />
              <Led state={ledFor(avail.state)} />
            </span>
            <span id="ticker-help" className={`field-help${avail.state === "taken" ? " err" : avail.state === "free" ? " ok" : ""}`}>
              {!ticker
                ? "1–8 characters, A–Z and 0–9. The first deploy claims the name forever."
                : !valid
                  ? "Tickers are 1–8 characters, A–Z and 0–9."
                  : avail.state === "checking"
                    ? "Checking availability…"
                    : avail.state === "free"
                      ? `${ticker} is available.`
                      : avail.state === "taken"
                        ? (
                          <>
                            {ticker} is already deployed — <a href={tokenHref(ticker)}>open it</a>.
                          </>
                        )
                        : avail.state === "error"
                          ? `Could not check availability: ${avail.error}`
                          : ""}
            </span>
          </label>

          <CreateAvatarFields creation={creation} ticker={ticker} address={address} feeRate={feeRate} disabled={!valid || !connected || busy} />

          <dl className="facts">
            <div>
              <dt>Supply</dt>
              <dd>{fmtInt(REQUIRED_TOKEN_SUPPLY)} — fixed</dd>
            </div>
            <div>
              <dt>Yield per mine</dt>
              <dd>{yieldsLine}</dd>
            </div>
            <div>
              <dt>Deployer allocation</dt>
              <dd>none — you mine like everyone else</dd>
            </div>
            <div>
              <dt>Protocol fee</dt>
              <dd>{fmtSats(DEPLOY_PROTOCOL_FEE_SATS)}</dd>
            </div>
            <div>
              <dt>Proof output</dt>
              <dd>{fmtSats(DUST_SATS)} back to you</dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>
                {avatarFlow.preview ? "See avatar transaction estimate above" : feeEstimate ? `≈ ${fmtSats(feeEstimate.feeSats)}` : "—"}
                {feeRate ? <span className="muted"> @ {feeRate} sat/vB</span> : null}
              </dd>
            </div>
          </dl>

          <FeeSelector fee={fee} disabled={busy} />
          <UtxoSafetyNotice />

          {preActivation && (
            <div className="notice">
              {tipUnknown
                ? `The indexer has not reported the chain tip yet, so it cannot be confirmed that block #${fmtInt(ACTIVATION_HEIGHT)} has been reached. Token creation stays locked until it does — a DEPLOY sent before activation is ignored and only costs fees.`
                : `The protocol activates at block #${fmtInt(ACTIVATION_HEIGHT)} — ${fmtInt(ACTIVATION_HEIGHT - tipNow)} blocks from now. Token creation opens then; a transaction sent earlier is ignored and only costs fees.`}
            </div>
          )}
          {connected && !preActivation && valid && avail.state === "free" && (
            <p className="fineprint">
              First DEPLOY to confirm claims {ticker}. Availability is checked against confirmed state only: a competing DEPLOY for {ticker} that is already in the mempool,
              or one that pays a higher fee and confirms first, takes the name — yours is then ignored, and the {fmtSats(DEPLOY_PROTOCOL_FEE_SATS)} protocol fee plus the network fee
              are still paid.
            </p>
          )}
          {!connected ? (
            <ConnectPrompt action="create a token" />
          ) : (
            <button className="btn btn-primary btn-lg" type="button" onClick={create} disabled={!valid || avail.ticker !== ticker || avail.state !== "free" || busy || creation.hasSaved || !indexerOk || preActivation || !feeRate || flow.phase === "confirmed" || avatarFlow.phase === "confirmed"}>
              {flow.phase === "confirmed" || avatarFlow.phase === "confirmed" ? `Created ${ticker}` : busy ? "Working…" : `Create ${valid ? ticker : "token"}`}
            </button>
          )}
          <TxProgress
            flow={flow}
            status={status}
            onReset={() => setFlow(IDLE)}
            idleText={connected ? missingFeeHint(fee.choice, feeRate, "deploy") || undefined : undefined}
            labels={{
              building: "Building the DEPLOY — fee inputs never include token-bearing UTXOs.",
              signing: `Awaiting signature — confirm in ${walletState.providerName || "your wallet"}. If a competing DEPLOY for ${flow.ticker || ticker} confirms first, this one is ignored and the ${fmtSats(DEPLOY_PROTOCOL_FEE_SATS)} protocol fee + network fee are still paid.`,
              pending: `DEPLOY broadcast. Pending confirmation — checking every 15 s. A competing DEPLOY for ${flow.ticker || ticker} that confirms first takes the name; the fees are paid either way.`,
              confirmed: `${flow.ticker} is deployed. Opening its page…`,
            }}
          />
        </Panel>

        <aside className="create-preview">
          <span className="label">Preview</span>
          <TokenCard token={preview} preview avatarPreview={avatarFlow.preview?.dataUrl} />
          <p className="fineprint">
            {avatarFlow.preview ? "Your image will be included in the token creation transaction." : "Without an image, your token uses an identicon derived from its ticker."}
          </p>
        </aside>
      </div>
    </main>
  );
}

function ledFor(state) {
  return AVAIL_LED[state] || "idle";
}
