import { useCallback, useEffect, useRef, useState } from "react";
import { DIGIT_SPACE, bucketOf, bucketOfYield } from "../lib/yield.js";
import { formatTime, hashLine } from "../lib/minerlog.js";
import { blockUrl, fmtInt, shortTxid, txUrl } from "../lib/format.js";
import Led from "./hud/Led.jsx";
import YieldSpectrum from "./YieldSpectrum.jsx";

const PHASES = ["Build", "Sign", "Broadcast", "Confirm"];
const BUSY_PHASES = ["building", "signing", "broadcasting", "pending"];
const FOLLOW_SLACK_PX = 24;

/** How many phase LEDs are lit for a mine state (mirrors the retired phase track). */
export function litCount(mine) {
  switch (mine?.phase) {
    case "building":
      return 1;
    case "signing":
      return 2;
    case "broadcasting":
      return 3;
    case "pending":
    case "confirmed":
      return 4;
    case "error":
      return mine.txid ? 4 : mine.inputCount != null ? 2 : 1;
    default:
      return 0;
  }
}

function ledState(mine, i, lit) {
  if (i >= lit) return "idle";
  if (mine.phase === "error") return "err";
  if (mine.phase === "pending" && i === 3) return "busy";
  return "ok";
}

const tierClass = (t) => (t ? ` tier-${bucketOfYield(t)?.id ?? "none"}` : "");

function Line({ line, last }) {
  const cls = `ln ln-${line.kind}${tierClass(line.tier)}${line.yours ? " yours" : ""}`;
  let body;
  if (line.hash) {
    const { head, last: lastChar } = hashLine(line.hash);
    body = (
      <>
        {line.pre}
        <span className="hash" title={line.hash}>
          {head}
          {line.lit ? <b className="lit">{lastChar}</b> : lastChar}
        </span>
        {line.post}
      </>
    );
  } else if (line.sum) {
    body = (
      <>
        {line.text}
        {" "}
        <span className="sum">{line.sum}</span>
      </>
    );
  } else {
    body = line.text;
  }
  return (
    <li className={cls}>
      <span className="ts">[{formatTime(line.ts)}]</span>
      <span className="tx">
        {body}
        {last && <span className="mlog-cursor" aria-hidden="true" />}
      </span>
    </li>
  );
}

/**
 * The MINE // LOG terminal: a cpuminer-style event log that is also where
 * the settlement is revealed (the confirming block's hash with its last
 * character enlarged in tier colour, then the digit and the banner line).
 * Props: { lines, mine, ticker, onClear, litDigit } plus the generic knobs
 * the DEPLOY // LOG reuses: `title` ("Mine // log"), `phases` (the four LED
 * labels), `lit` (LEDs done; default litCount(mine)), `ledStates` (per-LED
 * override of the default derivation), `busy` (default from mine.phase),
 * `showDigits` (false hides the 16-digit chip row and renders `footer`
 * under the terminal instead).
 */
export default function MinerLog({
  lines,
  mine,
  ticker,
  onClear,
  litDigit = null,
  title = "Mine // log",
  phases = PHASES,
  lit: litProp,
  ledStates = null,
  busy: busyProp,
  showDigits = true,
  footer = null,
}) {
  const bodyRef = useRef(null);
  const [following, setFollowing] = useState(true);
  const lit = litProp ?? litCount(mine);
  const busy = busyProp ?? BUSY_PHASES.includes(mine?.phase);
  const slashAt = title.indexOf("//");
  const titleNode =
    slashAt < 0 ? (
      title
    ) : (
      <>
        {title.slice(0, slashAt)}
        <span className="slash">//</span>
        {title.slice(slashAt + 2)}
      </>
    );

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX);
  }, []);

  const jump = useCallback(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollowing(true);
  }, []);

  // Auto-scroll on new lines unless the reader scrolled up. Keyed on the
  // array identity (not its length): the buffer is capped, so the length
  // stops changing once it is full.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [lines, following]);

  const d = typeof litDigit === "string" ? litDigit.toLowerCase() : null;
  const b = d ? bucketOf(d) : null;
  const caption = b
    ? `confirming digit ${d} · ${fmtInt(b.yield)} ${ticker} · ${b.count} of ${DIGIT_SPACE}`
    : `${DIGIT_SPACE} possible digits · the confirming block decides`;

  return (
    <div className="mlog-wrap">
      <section className="ch chamfer mlog" aria-label={title.replace(/\s*\/\/\s*/, " ")}>
        <div className="ch-in chamfer">
          <div className="mlog-head">
            <span className="mlog-title">
              <Led state={mine?.phase === "error" ? "err" : busy ? "busy" : lines.length ? "ok" : "idle"} />
              {titleNode}
            </span>
            <div className="mlog-leds" role="group" aria-label={`Phases: ${phases.map((p, i) => `${p} ${i < lit ? "done" : "waiting"}`).join(", ")}`}>
              {phases.map((p, i) => (
                <span key={p} className={i < lit ? "done" : undefined}>
                  <Led state={ledStates ? ledStates[i] ?? "idle" : ledState(mine, i, lit)} />
                  {p}
                </span>
              ))}
            </div>
            <div className="mlog-right">
              <span className="cnt">
                {fmtInt(lines.length)} event{lines.length === 1 ? "" : "s"} · local time
              </span>
              <button className="btn btn-sm" type="button" onClick={onClear} disabled={busy || lines.length === 0}>
                Clear
              </button>
            </div>
          </div>
          <div className="mlog-screen" role="log" aria-live="polite" aria-relevant="additions">
            <ol className="mlog-body" ref={bodyRef} onScroll={onScroll} tabIndex={0}>
              {lines.length === 0 ? (
                <li className="ln ln-sys" aria-hidden="true">
                  <span className="ts">[--:--:--]</span>
                  <span className="tx">
                    ready · events are printed here as they happen
                    <span className="mlog-cursor" />
                  </span>
                </li>
              ) : (
                lines.map((l, i) => <Line key={l.key} line={l} last={i === lines.length - 1} />)
              )}
            </ol>
            {!following && lines.length > 0 && (
              <button className="mlog-follow" type="button" onClick={jump}>
                ↓ latest
              </button>
            )}
          </div>
        </div>
      </section>

      {showDigits ? (
        <div className={`mlog-chips${d ? " lit-one" : ""}`}>
          <YieldSpectrum compact litDigit={d} />
          <div className="chip-caption">
            <span className={b ? `tier-${b.id}` : undefined}>{b ? <b>{caption}</b> : caption}</span>
            {mine?.txid && (
              <span>
                tx{" "}
                <a href={txUrl(mine.txid)} target="_blank" rel="noopener noreferrer" className="mono" title={mine.txid}>
                  {shortTxid(mine.txid)}
                </a>
                {mine.phase === "confirmed" && mine.blockHeight ? (
                  <>
                    {" · block "}
                    <a href={blockUrl(mine.blockHeight)} target="_blank" rel="noopener noreferrer" className="mono">
                      #{fmtInt(mine.blockHeight)}
                    </a>
                    {mine.reconcile === "pending" ? " · indexer reconciling…" : ""}
                  </>
                ) : mine.phase === "pending" ? (
                  <>
                    {" · checking every 15 s"}
                    {mine.pollError ? ` · last check failed: ${mine.pollError}` : ""}
                  </>
                ) : null}
              </span>
            )}
          </div>
        </div>
      ) : (
        footer
      )}
    </div>
  );
}
