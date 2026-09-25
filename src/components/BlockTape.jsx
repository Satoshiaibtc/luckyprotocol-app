import { useLayoutEffect, useRef } from "react";
import { useApp } from "../context.js";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "../hooks/usePoll.js";
import { useRecentBlocks } from "../hooks/useRecentBlocks.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import { BUCKETS, mineYield, yieldDigit, bucketOfHash } from "../lib/yield.js";
import { blockUrl, fmtInt } from "../lib/format.js";
import Panel from "./hud/Panel.jsx";
import { ledFromPoll } from "./hud/Led.jsx";
import RingGauge from "./hud/RingGauge.jsx";
import DigitChip from "./DigitChip.jsx";

const COUNT = 16;

/**
 * The last 16 blocks as a scrolling tape, oldest → newest, each tile
 * showing the height, the last hex digit and what a mine confirmed in that
 * block yielded. A sticky NEXT tile on the right stands for the block that
 * will decide pending mines.
 *
 * Phone (≤ 720px): the same 16 tiles as a 2 × 8 bead plate that fills the
 * width (row 1 = older eight, row 2 = newer eight, same oldest → newest
 * order), each tile showing the digit and the yield only; the NEXT tile
 * becomes a caption under the plate and the tally moves under it too.
 */
export default function BlockTape() {
  const { health } = useApp();
  const mobile = useIsMobile();
  const ceiling = health.data?.indexed_height ?? health.data?.tip_height ?? null;
  const healthDown = !!health.error && !health.data;
  // Health unavailable → fall back to the heights the mine feed knows about.
  const feed = usePoll(healthDown ? (s) => indexer.minesFeed({ limit: 40 }, s) : null, 30_000, [healthDown]);
  const { tiles, tally, loaded } = useRecentBlocks({ ceiling, count: COUNT, fallbackRows: healthDown ? feed.data?.items || null : null });

  const trackRef = useRef(null);
  const scrolledRef = useRef(false);
  useLayoutEffect(() => {
    if (mobile || !loaded || scrolledRef.current || !trackRef.current) return;
    scrolledRef.current = true;
    trackRef.current.scrollLeft = trackRef.current.scrollWidth;
  }, [loaded, mobile]);

  const led = healthDown ? ledFromPoll(feed) : loaded ? "ok" : ledFromPoll(health);
  const title = healthDown ? "Recent mined blocks" : `Block tape · last ${COUNT} blocks`;
  const nextHeight = ceiling !== null ? ceiling + 1 : tiles.length ? tiles[tiles.length - 1].height + 1 : null;

  const tallyNode = loaded ? (
    <span className="tally" aria-label={`Tally: ${BUCKETS.map((b) => `${tally[b.id]} blocks yielding ${b.yield}`).join(", ")}`}>
      {BUCKETS.map((b, i) => (
        <span key={b.id} className={`tier-${b.id}`}>
          {i > 0 ? " · " : ""}
          <span className="c">{tally[b.id]}</span> × {b.yield}
        </span>
      ))}
      <span className="model"> · model {BUCKETS.map((b) => b.count).join(" / ")}</span>
    </span>
  ) : null;

  const error = (healthDown && feed.error && !feed.data) || (loaded && tiles.length === 0);
  const rows = loaded ? tiles : Array.from({ length: COUNT }, (_, i) => ({ height: `ph-${i}`, pending: true }));

  return (
    <Panel title={title} led={led} right={mobile ? null : tallyNode} aria-label="Recent blocks">
      {error ? (
        <div className="empty">Block data unavailable — the indexer did not return recent blocks.</div>
      ) : mobile ? (
        <>
          <ol className="tape tape-grid" aria-label={`Last ${COUNT} blocks, oldest to newest`} aria-busy={!loaded}>
            {rows.map((t) => (
              <li key={t.height}>
                <Tile t={t} />
              </li>
            ))}
          </ol>
          <div className="tape-foot">
            <span className="tape-next" aria-label="Next block, awaiting">
              <RingGauge size={18} sweeping />
              <span className="mono">next {nextHeight !== null ? `#${fmtInt(nextHeight)}` : "—"}</span>
              <span className="label">awaiting</span>
            </span>
            {tallyNode}
          </div>
        </>
      ) : (
        <ol className="tape" ref={trackRef} aria-label={`Last ${COUNT} blocks, oldest to newest`} aria-busy={!loaded}>
          {rows.map((t) => (
            <li key={t.height}>
              <Tile t={t} />
            </li>
          ))}
          <li className="tile-next" aria-label="Next block, awaiting">
            <Height h={nextHeight} />
            <RingGauge size={36} sweeping />
            <span className="label">awaiting</span>
          </li>
        </ol>
      )}
      <p className="help">What a mine confirmed in each block would have yielded. The next block decides pending mines.</p>
    </Panel>
  );
}

/** `#969,795` on wide tiles; the last three digits (`…795`) on narrow ones. */
function Height({ h }) {
  if (h === null || h === undefined) return <span className="h">—</span>;
  return (
    <span className="h" title={`#${fmtInt(h)}`}>
      <span className="h-full">#{fmtInt(h)}</span>
      <span className="h-short">…{String(h).slice(-3)}</span>
    </span>
  );
}

function Tile({ t }) {
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
  const title = `Block #${fmtInt(t.height)} · last digit ${d} → ${mineYield(t.hash)} per mine`;
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
        <Height h={t.height} />
        <span className="mid">
          <span className="tail">…{t.hash.slice(-4, -1)}</span>
          <DigitChip digit={d} bare title={title} />
        </span>
        <span className="y">{mineYield(t.hash)}</span>
      </span>
    </a>
  );
}
