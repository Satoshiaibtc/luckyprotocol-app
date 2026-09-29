import { useMemo } from "react";
import * as indexer from "../lib/indexer.js";
import { usePoll } from "./usePoll.js";

/**
 * The BTC value of each outpoint of `rows` (token carriers, `{ txid, vout }`):
 * GET /txouts, asked once per outpoint — an output's value never changes,
 * and indexer.outputValues keeps what it read. → usePoll state whose `data`
 * is `[{ txid, vout, sats }]` (an outpoint the node does not have unspent
 * is left out until it does).
 */
export function useOutputValues(rows, intervalMs, { paused = false } = {}) {
  const keys = useMemo(() => indexer.outpointKeys(rows || []).join(","), [rows]);
  return usePoll(keys ? (s) => indexer.outputValues(keys.split(","), s) : null, intervalMs, [keys], { paused });
}
