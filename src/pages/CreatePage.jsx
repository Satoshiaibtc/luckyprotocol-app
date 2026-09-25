import { useEffect, useMemo, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import * as unisat from "../lib/unisat.js";
import { useTxStatus } from "../hooks/useTxStatus.js";
import { friendlyError } from "../hooks/useWallet.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { buildDeployPsbt, estimateDeployFeeSats } from "../lib/psbt.js";
import { withPending } from "../lib/pending.js";
import { ACTIVATION_HEIGHT, DEPLOY_PROTOCOL_FEE_SATS, DUST_SATS, PROJECT_FEE_ADDRESS, REQUIRED_TOKEN_SUPPLY, TICKER_RE } from "../lib/payloads.js";
import { BUCKETS, EXPECTED_YIELD } from "../lib/yield.js";
import { fmtDec, fmtInt, fmtSats } from "../lib/format.js";
import TokenCard from "../components/TokenCard.jsx";
import TxProgress, { ConnectPrompt } from "../components/TxProgress.jsx";
import Panel from "../components/hud/Panel.jsx";
import Led from "../components/hud/Led.jsx";

const IDLE = { phase: "idle" };
const AVAIL_LED = { idle: "idle", checking: "busy", free: "ok", taken: "err", error: "err" };

export default function CreatePage({ params, navigate }) {
  const { wallet, address, pubkeyHex, fees, indexerOk, health, refreshAll } = useApp();
  const connected = wallet.status === "connected";
  // A DEPLOY below the activation height is ignored by the indexer (fees lost).
  const tipNow = health.data?.tip_height ?? null;
  const preActivation = tipNow !== null && tipNow < ACTIVATION_HEIGHT;
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

  const feeRate = fees.data?.halfHourFee ?? null;
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
  const busy = ["building", "signing", "broadcasting", "pending"].includes(flow.phase);

  // Confirmed → hop to the token page once the indexer lists it (it polls anyway).
  useEffect(() => {
    if (flow.phase !== "confirmed") return undefined;
    const id = setTimeout(() => navigate(tokenHref(flow.ticker)), 1800);
    return () => clearTimeout(id);
  }, [flow.phase, flow.ticker, navigate]);

  const create = async () => {
    if (!connected || !valid || avail.state !== "free") return;
    const t = ticker;
    setFlow({ phase: "building", ticker: t });
    try {
      const [feeInfo, utxoRes, tokenRows] = await Promise.all([
        fees.data ? Promise.resolve(fees.data) : indexer.fees(),
        unisat.getBitcoinUtxos(address),
        indexer.tokenUtxos(address),
      ]);
      // A DEPLOY funded with a token UTXO burns those tokens (§4.2) — the
      // §4 filter is applied here exactly as for MINE.
      const built = buildDeployPsbt({
        address,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints: withPending(tokenRows.map(({ txid, vout }) => ({ txid, vout }))),
        feeRateSatVb: feeInfo.halfHourFee,
        ticker: t,
      });
      setFlow({ phase: "signing", ticker: t, feeSats: built.feeSats, detail: `${built.inputIndexes.length} input${built.inputIndexes.length === 1 ? "" : "s"}` });
      const signed = await unisat.signPsbt(built.psbtHex, built.inputIndexes, address);
      setFlow((f) => ({ ...f, phase: "broadcasting" }));
      const txid = await unisat.broadcastSignedPsbt(signed);
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
                disabled={busy}
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
                {feeEstimate ? `≈ ${fmtSats(feeEstimate.feeSats)}` : "—"}
                {feeRate ? <span className="muted"> @ {feeRate} sat/vB</span> : null}
              </dd>
            </div>
          </dl>

          {preActivation && (
            <div className="notice">
              The protocol activates at block #{fmtInt(ACTIVATION_HEIGHT)} — {fmtInt(ACTIVATION_HEIGHT - tipNow)} blocks from now. Token creation
              opens then; a transaction sent earlier is ignored and only costs fees.
            </div>
          )}
          {!connected ? (
            <ConnectPrompt action="create a token" />
          ) : (
            <button className="btn btn-primary btn-lg" type="button" onClick={create} disabled={!valid || avail.state !== "free" || busy || !indexerOk || preActivation || flow.phase === "confirmed"}>
              {flow.phase === "confirmed" ? `Created ${flow.ticker}` : busy ? "Working…" : `Create ${valid ? ticker : "token"}`}
            </button>
          )}
          <TxProgress
            flow={flow}
            status={status}
            onReset={() => setFlow(IDLE)}
            labels={{
              building: "Building the DEPLOY — fee inputs never include token-bearing UTXOs.",
              pending: "DEPLOY broadcast. Pending confirmation — checking every 15 s.",
              confirmed: `${flow.ticker} is deployed. Opening its page…`,
            }}
          />
        </Panel>

        <aside className="create-preview">
          <span className="label">Preview</span>
          <TokenCard token={preview} preview />
          <p className="fineprint">
            The identicon is derived from the ticker&apos;s hash — no image upload, nothing to host. Every card on the board is drawn the same way.
          </p>
        </aside>
      </div>
    </main>
  );
}

function ledFor(state) {
  return AVAIL_LED[state] || "idle";
}
