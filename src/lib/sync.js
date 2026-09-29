// How far the indexer is behind the chain tip, and whether
// its node itself can be trusted to be current. Pure, no React; tested in
// test/views.test.js, test/flows.test.js and test/network.test.js.
//
// The indexer answers from the state it has APPLIED. During a cold scan
// (a snapshot-version bump, a refused or corrupt snapshot, a reorg
// rebuild) and for the seconds after every block, that state is older than
// the chain: a ticker deployed in an unapplied block reads as free, and a
// token's `minted` is stale. Every write flow that depends on "not taken"
// or "supply left" checks this first.
//
// "Synced" also needs the node to be current: a node that lost its peers
// or stopped receiving blocks reports tip == indexed and looks synced to
// itself. The indexer flags that as `stalled` (no completed poll for a
// while, no peers for ten minutes, a node tip stuck below the indexed
// height); a full rebuild as `rebuilding`; and the app compares the node's
// tip with an independent one (src/lib/network.js) — `networkLag` blocks.

/** Blocks of indexer lag that also raise the site-wide warning (a lag of a block or two is normal for a few seconds). */
export const SYNC_WARN_LAG = 3;
/** A tip block older than this is mentioned (never a pause: Bitcoin sometimes goes an hour without a block). */
export const OLD_TIP_WARN_S = 90 * 60;

/**
 * `{ indexed, tip, lag, stalled, rebuilding, noPeers, networkLag, synced,
 * trustUnseen }` from a /health read — `lag` is null while either height is
 * unknown, and while the node's tip reads BELOW the indexed height (the
 * indexer reports a tip of 0 until it has read its node after a restart:
 * how far behind it is, is not known yet); `networkLag` is the confirmed
 * number of blocks the node trails the second source (0 when not behind or
 * unknown, see network.js). `synced` is true only when both heights are
 * known and equal, nothing is stalled or rebuilding, and the node is not
 * behind the network.
 * `trustUnseen`: an unknown txid ("not in the node's mempool") says
 * something only while synced AND the node has peers — otherwise a tx the
 * rest of the network holds may simply not have reached it.
 */
export function syncStateOf(health, { networkLag = 0 } = {}) {
  const indexed = Number.isInteger(health?.indexed_height) ? health.indexed_height : null;
  const tip = Number.isInteger(health?.tip_height) ? health.tip_height : null;
  const lag = indexed !== null && tip !== null && tip >= indexed ? tip - indexed : null;
  const stalled = !!health?.stalled;
  const rebuilding = !!health?.rebuilding;
  const noPeers = health?.node_peers === 0;
  const behind = Number.isInteger(networkLag) && networkLag > 0 ? networkLag : 0;
  const synced = lag === 0 && !stalled && !rebuilding && behind === 0;
  return { indexed, tip, lag, stalled, rebuilding, noPeers, networkLag: behind, synced, trustUnseen: synced && !noPeers };
}

/**
 * The chain height to show and to compare with the network: the node's tip
 * as the indexer last read it, never below the height the indexer has
 * applied (its tip reads 0 for a moment after a restart). null while
 * neither is known.
 */
export function chainTipOf(health) {
  const known = [health?.tip_height, health?.indexed_height].filter(Number.isInteger);
  const top = known.length ? Math.max(...known) : 0;
  return top > 0 ? top : null;
}

const n2 = (n) => n.toLocaleString("en-US");
const blocks = (n) => `${n2(n)} block${n === 1 ? "" : "s"}`;

/** Why the state is not usable, as a clause ("the indexer is rebuilding …"), or null when synced. */
function notSyncedReason(sync) {
  if (!sync || sync.synced) return null;
  if (sync.rebuilding) return "the indexer is rebuilding its state from the chain";
  if (sync.stalled && sync.noPeers) return "the indexer's Bitcoin node has no peers";
  if (sync.stalled) return "the indexer has stopped making progress";
  if (sync.networkLag > 0) return `our Bitcoin node is ${blocks(sync.networkLag)} behind the network`;
  if (sync.lag === null) return null;
  return `the indexer is ${blocks(sync.lag)} behind the chain tip (#${n2(sync.indexed)} of #${n2(sync.tip)})`;
}

/**
 * The error for a click that found the indexer behind at the moment of the
 * click (the idle hint above did not see it yet): says that nothing was
 * sent and what to do — press again — instead of promising an automatic
 * resume the flow does not have. null when synced.
 */
export function syncRetryText(sync, subject, action = "Create") {
  if (!sync || sync.synced) return null;
  const reason = notSyncedReason(sync) ?? "the indexer has not reported how far it has indexed";
  return `Nothing was sent: ${reason}, so ${subject} could be out of date. Press ${action} again once it has caught up.`;
}

/** One sentence for a page that pauses while the indexer is not synced, or null when it is. */
export function syncPauseText(sync, what) {
  if (!sync || sync.synced) return null;
  if (sync.rebuilding) return `The indexer is rebuilding its state from the chain, so ${what} would rely on incomplete state — paused until it finishes.`;
  if (sync.stalled && sync.noPeers) return `The indexer's Bitcoin node has no peers, so ${what} would rely on stale state — paused until it reconnects.`;
  if (sync.stalled) return `The indexer has stopped making progress, so ${what} would rely on stale state — paused until it recovers.`;
  if (sync.networkLag > 0) return `Our Bitcoin node is ${blocks(sync.networkLag)} behind the network, so ${what} would rely on stale state — paused until it catches up.`;
  if (sync.lag === null) return `The indexer has not reported how far it has indexed yet — ${what} is paused until it does.`;
  return `The indexer is ${blocks(sync.lag)} behind the chain tip (#${n2(sync.indexed)} of #${n2(sync.tip)}), so ${what} would rely on stale state — paused until it catches up.`;
}

/**
 * The site-wide warning under the top bar, or null: our data is behind or
 * may be stale (a rebuild, a stalled indexer, a node without peers or
 * behind the network, a lag of SYNC_WARN_LAG blocks or more), or — as a
 * mention only — the tip block is unusually old (`tipTime` unix s, `now` ms).
 */
export function syncWarningText(sync, { tipTime = null, now = Date.now() } = {}) {
  if (!sync) return null;
  if (sync.rebuilding) return "The indexer is rebuilding its state from the chain: balances, tokens and listings may be incomplete until it finishes. Creating, mining, sending, listing and buying are paused.";
  if (sync.stalled && sync.noPeers) return "The indexer's Bitcoin node has no peers, so what you see may be out of date. Creating, mining, sending, listing and buying are paused until it reconnects.";
  if (sync.stalled) return "The indexer has stopped making progress, so what you see may be out of date. Creating, mining, sending, listing and buying are paused until it recovers.";
  if (sync.networkLag > 0) {
    return `Our Bitcoin node is ${blocks(sync.networkLag)} behind the network, so what you see may be out of date. Creating, mining, sending, listing and buying are paused until it catches up.`;
  }
  if (sync.noPeers) return "The indexer's Bitcoin node has no peers right now: new blocks and transactions may reach it late.";
  if (Number.isInteger(sync.lag) && sync.lag >= SYNC_WARN_LAG) return `The indexer is catching up: ${blocks(sync.lag)} behind the chain tip. Creating, mining, sending, listing and buying resume when it has caught up.`;
  if (sync.synced && Number.isInteger(tipTime) && now / 1000 - tipTime > OLD_TIP_WARN_S) {
    const min = Math.floor((now / 1000 - tipTime) / 60);
    return `No new block for about ${n2(min)} minutes. Bitcoin sometimes goes that long, but our node may also be behind.`;
  }
  return null;
}
