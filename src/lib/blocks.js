export const MAX_BLOCK_WEIGHT = 4_000_000;

/**
 * The one `/blocks/recent` limit the block tape asks for, whatever the
 * screen size: every visitor then shares one URL (one cached answer) and
 * the tape keeps the last `count` blocks of it — never more than the 20
 * visibleBlockCount allows.
 */
export const RECENT_BLOCKS_LIMIT = 32;

/** Missing capacity is unknown, never an empty block. */
export function blockStats(raw) {
  const weight = raw?.weight;
  const txCount = raw?.tx_count;
  return {
    weight: Number.isSafeInteger(weight) && weight > 0 && weight <= MAX_BLOCK_WEIGHT ? weight : null,
    tx_count: Number.isSafeInteger(txCount) && txCount > 0 && txCount <= 1_000_000 ? txCount : null,
  };
}

export function blockFullness(weight) {
  const valid = blockStats({ weight }).weight;
  return valid === null ? null : (100 * valid) / MAX_BLOCK_WEIGHT;
}

/** Reserve one next-block slot; each tile needs 54px plus the 3px CSS gap. */
export function visibleBlockCount(width) {
  return Math.max(2, Math.min(20, Math.floor((Math.max(0, width) + 3) / 57) - 1));
}
