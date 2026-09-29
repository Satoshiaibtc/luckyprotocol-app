import { useId, useMemo, useState } from "react";
import { MAX_FEE_RATE_SAT_VB, speedUpFloorRate } from "../lib/psbt.js";
import { clampCustomFee, needsHighFeeAck } from "../lib/feechoice.js";
import { fmtInt } from "../lib/format.js";

/**
 * "Speed up" for a pending send of the listing flows (a withdrawal or a
 * split, useSendToSelf): the same transaction with a higher fee taken from
 * its BTC change (replace-by-fee — every input it spends signals it). The
 * suggested rate is the Fast estimate, or the lowest rate a replacement may
 * use when that is higher; a rate of the user's own above the high-fee
 * threshold is confirmed before it can be signed. `send` is the hook's
 * return value; `note` says why speed matters for this transaction.
 */
export default function SpeedUpSend({ send, fees, note = null }) {
  const inputId = useId();
  const { chain } = send;
  const [open, setOpen] = useState(false);
  const [customText, setCustomText] = useState("");
  const [ackRate, setAckRate] = useState(null);
  const psbt = chain.psbt;
  const floor = useMemo(() => {
    try {
      return psbt ? speedUpFloorRate(psbt, fees?.incrementalrelayfee ?? undefined) : null;
    } catch {
      return null;
    }
  }, [psbt, fees?.incrementalrelayfee]);
  if ((chain.phase !== "pending" && chain.phase !== "unseen") || !psbt) return null;
  const fast = Number(fees?.fastestFee) || 0;
  const suggested = floor ? Math.max(fast, floor) : null;
  const custom = customText.trim() === "" ? null : clampCustomFee(customText);
  const rate = custom ? custom.value : suggested;
  const high = rate !== null && rate > (floor ?? 0) && needsHighFeeAck(rate, fees);
  const quote = open && rate ? send.speedUpQuote(rate) : null;
  const working = !!chain.speeding;
  const close = () => {
    setOpen(false);
    setCustomText("");
    setAckRate(null);
  };
  const rateInput = (
    <span className="cr-speedup-rate">
      <label htmlFor={inputId}>Rate</label>
      <input
        id={inputId}
        className={`input mono${custom?.error ? " invalid" : ""}`}
        type="text"
        inputMode="decimal"
        placeholder={suggested ? String(suggested) : "sat/vB"}
        value={customText}
        onChange={(e) => setCustomText(e.target.value)}
        disabled={working}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!custom?.error}
      />
      <span className="unit">sat/vB · 1–{MAX_FEE_RATE_SAT_VB.toLocaleString("en-US")}</span>
    </span>
  );
  return (
    <div className="cr-speedup">
      {!open ? (
        <>
          {note && <span className="muted">{note}</span>}
          <button className="btn btn-sm" type="button" onClick={() => setOpen(true)} disabled={working}>
            Speed up
          </button>
        </>
      ) : quote && !quote.error ? (
        <>
          <span>
            New fee <span className="mono">{fmtInt(quote.feeSats)} sats</span> @ {quote.feeRateSatVb} sat/vB (now {fmtInt(quote.oldFeeSats)} sats @ {quote.oldFeeRateSatVb} sat/vB). The extra fee comes from
            your change; everything else stays the same. Leave the rate empty for the suggested {suggested} sat/vB, or enter your own.
          </span>
          {rateInput}
          {high && ackRate !== rate && (
            <span className="err" role="alert">
              {rate.toLocaleString("en-US")} sat/vB is high{fast ? ` — the fastest estimate is ${fast} sat/vB` : ""}. A typo here costs real sats.{" "}
              <button className="btn btn-sm" type="button" onClick={() => setAckRate(rate)} disabled={working}>
                Use {rate.toLocaleString("en-US")} sat/vB
              </button>
            </span>
          )}
          <span className="cr-speedup-actions">
            <button
              className="btn btn-sm btn-primary"
              type="button"
              disabled={working || (high && ackRate !== rate)}
              onClick={async () => {
                await send.speedUp(rate);
                close();
              }}
            >
              {working ? (chain.speeding === "signing" ? "Confirm in wallet…" : "Working…") : "Sign faster version"}
            </button>
            <button className="btn btn-sm" type="button" onClick={close} disabled={working}>
              Close
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="err">{custom?.error || quote?.error || "No fee estimate to speed up with right now."}</span>
          {floor && rateInput}
          <button className="btn btn-sm" type="button" onClick={close}>
            Close
          </button>
        </>
      )}
      {chain.speedError && !open && <span className="err">{chain.speedError}</span>}
    </div>
  );
}
