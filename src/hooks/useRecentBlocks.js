import { useEffect, useMemo, useRef, useState } from "react";
import * as indexer from "../lib/indexer.js";
import { bucketOfHash } from "../lib/yield.js";

/**
 * The last `count` blocks up to `ceiling` (indexed_height first, so
 * blockInfo never 404s on unstored heights), oldest → newest.
 *
 * Cache by height; on every ceiling change refetch only the heights not yet
 * cached PLUS the ceiling itself as a reorg probe. A cached hash that
 * differs from a fresh read clears the whole cache and refetches. A 404 /
 * null / rejected read is stored as `{ missing: true }` — never fabricated.
 *
 * `fallbackRows` (minesFeed items) is used only when `ceiling` is null:
 * heights come from `block_height`, hashes from `block_hash`.
 */
export function useRecentBlocks({ ceiling, count = 16, fallbackRows = null }) {
  const cacheRef = useRef(new Map());
  const seenRef = useRef(new Set());
  const newRef = useRef(new Set());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (ceiling === null || ceiling === undefined) return undefined;
    const ctrl = new AbortController();
    let alive = true;
    const cache = cacheRef.current;

    // One /blocks/recent read covers the whole window; heights it does not
    // return (indexer predates the route, or lags the tip) fall back to
    // per-height /block-info reads.
    const fetchHeights = async (heights) => {
      if (heights.length === 0) return false;
      let reorg = false;
      const byHeight = new Map();
      try {
        const res = await indexer.recentBlocks(Math.min(32, count + 8), ctrl.signal);
        if (res) for (const b of res.blocks) byHeight.set(b.height, b.hash);
      } catch (e) {
        if (e && e.name === "AbortError") return false;
        /* fall through to per-height reads */
      }
      if (!alive || ctrl.signal.aborted) return false;
      const rest = [];
      for (const h of heights) {
        const hash = byHeight.get(h);
        if (hash) {
          const prev = cache.get(h);
          if (prev && prev.hash && prev.hash !== hash) reorg = true;
          cache.set(h, { hash, time: cache.get(h)?.time ?? null });
        } else {
          rest.push(h);
        }
      }
      if (rest.length === 0) return reorg;
      const results = await Promise.allSettled(rest.map((h) => indexer.blockInfo(h, ctrl.signal)));
      if (!alive || ctrl.signal.aborted) return false;
      results.forEach((r, i) => {
        const h = rest[i];
        if (r.status === "fulfilled" && r.value && r.value.hash) {
          const prev = cache.get(h);
          if (prev && prev.hash && prev.hash !== r.value.hash) reorg = true;
          cache.set(h, { hash: r.value.hash, time: r.value.time ?? null });
        } else if (r.status === "fulfilled" || !(r.reason && r.reason.name === "AbortError")) {
          cache.set(h, { missing: true });
        }
      });
      return reorg;
    };

    (async () => {
      const wanted = [];
      for (let h = ceiling - count + 1; h <= ceiling; h++) if (h >= 0) wanted.push(h);
      // Prune heights that fell off the window so the cache stays bounded.
      for (const h of [...cache.keys()]) if (h < ceiling - count + 1 || h > ceiling) cache.delete(h);
      // Only blocks that arrive AFTER the first fill get the "new" entrance;
      // animating all sixteen on every page load read as the tape flashing.
      const firstFill = cache.size === 0;
      if (!firstFill) for (const h of wanted) if (!cache.has(h)) newRef.current.add(h);
      const need = wanted.filter((h) => !cache.has(h) || h === ceiling);
      if (need.length === 0) return;
      const reorg = await fetchHeights(need);
      if (!alive) return;
      if (reorg) {
        cache.clear();
        await fetchHeights(wanted);
        if (!alive) return;
      }
      setVersion((v) => v + 1);
    })();

    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [ceiling, count]);

  // Heights first seen this render carry `isNew` for one paint; the class
  // is dropped 300 ms later (the only timer here, and it only clears a flag).
  useEffect(() => {
    if (newRef.current.size === 0) return undefined;
    const id = setTimeout(() => {
      for (const h of newRef.current) seenRef.current.add(h);
      newRef.current.clear();
      setVersion((v) => v + 1);
    }, 300);
    return () => clearTimeout(id);
  }, [version]);

  return useMemo(() => {
    const cache = cacheRef.current;
    const tiles = [];
    const tally = { high: 0, mid: 0, base: 0 };
    let loaded = false;

    if (ceiling !== null && ceiling !== undefined) {
      for (let h = ceiling - count + 1; h <= ceiling; h++) {
        if (h < 0) continue;
        const c = cache.get(h);
        if (!c) {
          tiles.push({ height: h, hash: null, time: null, missing: false, pending: true, isNew: false });
          continue;
        }
        loaded = true;
        if (c.missing) {
          tiles.push({ height: h, hash: null, time: null, missing: true, pending: false, isNew: false });
        } else {
          const b = bucketOfHash(c.hash);
          if (b) tally[b.id] += 1;
          tiles.push({ height: h, hash: c.hash, time: c.time, missing: false, pending: false, isNew: newRef.current.has(h) && !seenRef.current.has(h) });
        }
      }
    } else if (Array.isArray(fallbackRows)) {
      const byHeight = new Map();
      for (const r of fallbackRows) if (r && r.block_hash && !byHeight.has(r.block_height)) byHeight.set(r.block_height, r.block_hash);
      const heights = [...byHeight.keys()].sort((a, b) => a - b).slice(-count);
      for (const h of heights) {
        const hash = byHeight.get(h);
        const b = bucketOfHash(hash);
        if (b) tally[b.id] += 1;
        tiles.push({ height: h, hash, time: null, missing: false, pending: false, isNew: false });
      }
      loaded = tiles.length > 0;
    }
    return { tiles, tally, loaded };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cache reads keyed by version
  }, [ceiling, count, fallbackRows, version]);
}
