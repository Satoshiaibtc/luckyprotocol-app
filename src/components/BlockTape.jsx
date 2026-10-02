import { useCallback, useRef, useState } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { useRecentBlocks } from "../hooks/useRecentBlocks.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import { mineYield, yieldDigit, bucketOfHash } from "../lib/yield.js";
import { blockUrl, fmtInt } from "../lib/format.js";
import { blockFullness, visibleBlockCount } from "../lib/blocks.js";
import Panel from "./hud/Panel.jsx";
import { ledFromPoll } from "./hud/Led.jsx";
import RingGauge from "./hud/RingGauge.jsx";
import DigitChip from "./DigitChip.jsx";

// Phones: two complete blocks, then the next block as the third tile.
const MOBILE_COUNT = 2;

/**
 * A bounded row, oldest to newest. Fill height is actual block weight
 * divided by the consensus capacity; pending blocks have no projected fill.
 */
export default function BlockTape() {
  const { health } = useApp();
  const mobile = useIsMobile();
  const ceiling = health.data?.indexed_height ?? health.data?.tip_height ?? null;
  const healthDown = !!health.error && !health.data;
  // Health unavailable → fall back to the heights the mine feed knows about.
  const feed = usePoll(healthDown ? (s) => indexer.minesFeed({ limit: 40 }, s) : null, 30_000, [healthDown]);
  // Desktop tile count. Seeded from the viewport so the first paint is not
  // the 3-tile phone count; measured precisely by the callback ref below,
  // which runs whenever the desktop <ol> (re)mounts — including after the
  // error branch unmounted it — and disconnects on unmount, so the observer
  // never watches a detached element.
  const observer = useRef(null);
  const [fit, setFit] = useState(() => (typeof window === "undefined" ? MOBILE_COUNT : visibleBlockCount(window.innerWidth)));
  const trackRef = useCallback((el) => {
    if (observer.current) {
      observer.current.disconnect();
      observer.current = null;
    }
    if (!el) return;
    const update = () => setFit(visibleBlockCount(el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(update);
    observer.current.observe(el);
  }, []);
  const COUNT = mobile ? MOBILE_COUNT : fit;

  const { tiles, loaded } = useRecentBlocks({ ceiling, count: COUNT, fallbackRows: healthDown ? feed.data?.items || null : null });

  const led = healthDown ? ledFromPoll(feed) : loaded ? "ok" : ledFromPoll(health);
  const title = healthDown ? "Recent mined blocks" : `Block tape · last ${COUNT} blocks`;
  const nextHeight = ceiling !== null ? ceiling + 1 : tiles.length ? tiles[tiles.length - 1].height + 1 : null;

  const error = (healthDown && feed.error && !feed.data) || (loaded && tiles.length === 0);
  const rows = loaded ? tiles : Array.from({ length: COUNT }, (_, i) => ({ height: `ph-${i}`, pending: true }));

  // The probability board's one discoverable entry: the panel head on
  // desktop, the tape foot on phones (the head is too tight at 360px).
  const boardLink = (
    <a className="panel-link" href="#/probability" title="Probability board — the record of block-hash last digits">
      Probability →
    </a>
  );

  return (
    <Panel title={title} led={led} right={mobile ? undefined : boardLink} aria-label="Recent blocks">
      {error ? (
        <>
          <div className="empty">Block data unavailable — the indexer did not return recent blocks.</div>
          {mobile && <div className="tape-foot">{boardLink}</div>}
        </>
      ) : mobile ? (
        <>
          <ol className="tape tape-grid" aria-label={`Last ${COUNT} blocks, oldest to newest`} aria-busy={!loaded}>
            {rows.map((t) => (
              <li key={t.height}>
                <Tile t={t} />
              </li>
            ))}
            <NextTile h={nextHeight} />
          </ol>
          <div className="tape-foot">{boardLink}</div>
        </>
      ) : (
        <ol className="tape" ref={trackRef} aria-label={`Last ${COUNT} blocks, oldest to newest`} aria-busy={!loaded}>
          {rows.map((t) => (
            <li key={t.height}>
              <Tile t={t} narrow />
            </li>
          ))}
          <NextTile h={nextHeight} />
        </ol>
      )}
    </Panel>
  );
}

/** The block the chain has not produced yet: the last tile of the tape. */
function NextTile({ h }) {
  return (
    <li className="tile-next" aria-label="Next block, awaiting">
      <Height h={h} />
      <RingGauge size={28} sweeping />
      <span className="label">awaiting</span>
    </li>
  );
}

function Height({ h }) {
  if (h === null || h === undefined) return <span className="h">—</span>;
  return (
    <span className="h" title={`#${fmtInt(h)}`}>
      #{fmtInt(h)}
    </span>
  );
}

/**
 * One block. `narrow` (the ~54 px desktop strip): the fullness reads
 * "70% full" in a smaller face; the phone grid has room for "70.0% full".
 * Never a bare percentage under the yield — on a phone (no hover title) it
 * read as a chance for that yield.
 */
function Tile({ t, narrow = false }) {
  if (t.pending) {
    return (
      <span className="ch chamfer tile tile-ph tier-none" aria-hidden="true">
        <span className="ch-in chamfer" />
      </span>
    );
  }
  if (t.missing) {
    return (
      <span className="tile tile-missing tier-none chamfer" title={`Block #${fmtInt(t.height)} · not available from the indexer`}>
        <span className="ch-in">
          <Height h={t.height} />
          <span className="q">?</span>
          <span className="y" />
        </span>
      </span>
    );
  }
  const d = yieldDigit(t.hash);
  const b = bucketOfHash(t.hash);
  const fullness = blockFullness(t.weight);
  const fillLabel = fullness === null ? "Capacity unavailable" : `${fullness.toFixed(1)}% full`;
  const txLabel = t.tx_count === null || t.tx_count === undefined ? "Transactions unavailable" : `${fmtInt(t.tx_count)} txs`;
  const title = `Block #${fmtInt(t.height)} · ${fillLabel} · ${txLabel} · last digit ${d} → ${mineYield(t.hash)} per mine`;
  return (
    <a
      href={blockUrl(t.height)}
      target="_blank"
      rel="noopener noreferrer"
      className={`ch chamfer tile tier-${b ? b.id : "none"}${t.isNew ? " is-new" : ""}`}
      title={title}
      aria-label={title}
    >
      <span className="ch-in chamfer">
        {fullness !== null && <span className="tile-fill" style={{ height: `${fullness}%` }} aria-hidden="true" />}
        <Height h={t.height} />
        <span className="mid">
          <DigitChip digit={d} bare title={title} />
          <span className="y">{mineYield(t.hash)} / mine</span>
        </span>
        <span className="tile-stats">
          <span className={`tile-fullness${narrow ? " narrow" : ""}`}>{fullness === null ? "N/A" : narrow ? `${Math.round(fullness)}% full` : `${fullness.toFixed(1)}% full`}</span>
        </span>
      </span>
    </a>
  );
}
