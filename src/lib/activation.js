// Activation gate + countdown (spec §1: protocol transactions in blocks
// below ACTIVATION_HEIGHT are ignored). Pure, no React; tested in
// test/journeys.test.js.
//
// Create and Mine unlock one block EARLY — at tip ACTIVATION_HEIGHT − 1
// (969,599) — because every DEPLOY, MINE and SEND this app builds carries
// nLockTime = PROTOCOL_LOCKTIME (969,599):
// a node will not put such a transaction in any block below 969,600, so
// nothing sent through the app can confirm too early and be ignored. An
// UNKNOWN tip still counts as locked (fail closed: a gate that cannot see
// the tip must not open). This module puts that rule and its wording in
// one place, so every page counts the same way and says "1 block", not
// "1 blocks".

import { ACTIVATION_HEIGHT, PROTOCOL_LOCKTIME } from "./payloads.js";

/** Average block interval used for the rough time estimate. */
export const BLOCK_MINUTES = 10;

/**
 * The tip at which Create and Mine unlock: ACTIVATION_HEIGHT − 1. From
 * this tip on, the next block is ACTIVATION_HEIGHT, the first one the
 * lock time of the app's transactions allows.
 */
export const UNLOCK_HEIGHT = PROTOCOL_LOCKTIME;

const at = (h) => `#${h.toLocaleString("en-US")}`;

/**
 * `{ locked, unknown, blocksLeft, active, blocksToActivation }` for a tip
 * height (null / undefined = unknown; so is 0 — what an indexer that has
 * not read its node yet reports, never a real tip).
 *
 *   locked              tip < UNLOCK_HEIGHT (or unknown) — Create and Mine stay off
 *   blocksLeft          blocks until the gate opens (tip reaches UNLOCK_HEIGHT); null while unknown
 *   active              tip ≥ ACTIVATION_HEIGHT (the protocol itself is live)
 *   blocksToActivation  blocks until ACTIVATION_HEIGHT is mined; null while unknown
 */
export function activationState(tip) {
  if (!Number.isInteger(tip) || tip <= 0) return { locked: true, unknown: true, blocksLeft: null, active: false, blocksToActivation: null };
  return {
    locked: tip < UNLOCK_HEIGHT,
    unknown: false,
    blocksLeft: Math.max(0, UNLOCK_HEIGHT - tip),
    active: tip >= ACTIVATION_HEIGHT,
    blocksToActivation: Math.max(0, ACTIVATION_HEIGHT - tip),
  };
}

/** "1 block" / "462 blocks". */
export function blocksText(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return `${v.toLocaleString("en-US")} block${v === 1 ? "" : "s"}`;
}

/** Rough wall-clock time for `n` blocks at ~10 minutes each: "about 3 days" / "about 5 hours" / "about 40 minutes". */
export function blocksEtaText(n) {
  const minutes = Math.max(0, Math.floor(Number(n) || 0)) * BLOCK_MINUTES;
  if (minutes < 90) return `about ${Math.max(BLOCK_MINUTES, minutes)} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} hours`;
  const days = Math.round(minutes / 1440);
  return `about ${days} day${days === 1 ? "" : "s"}`;
}

/** "462 blocks from now (about 3 days)". */
export function countdownText(n) {
  return `${blocksText(n)} from now (${blocksEtaText(n)})`;
}

/**
 * The lock notice of a write action ("Creating a ticker", "Mining") while
 * the gate is closed, or null once it is open.
 */
export function activationNotice(tip, what) {
  const s = activationState(tip);
  if (!s.locked) return null;
  if (s.unknown) {
    return `The indexer has not reported the chain tip yet, so it cannot be confirmed that block ${at(UNLOCK_HEIGHT)} has been reached. ${what} stays locked until it does.`;
  }
  return (
    `LUCKY-20 starts at block ${at(ACTIVATION_HEIGHT)}. ${what} opens when block ${at(UNLOCK_HEIGHT)} is mined — ${countdownText(s.blocksLeft)}. ` +
    `The app gives every transaction a lock time, so none can be confirmed before block ${at(ACTIVATION_HEIGHT)}.`
  );
}

/**
 * The site-wide line shown under the top bar until the protocol is live —
 * null when the tip is unknown (the gates still fail closed and each page
 * says so) or once the tip has reached ACTIVATION_HEIGHT.
 */
export function activationBannerText(tip) {
  const s = activationState(tip);
  if (s.unknown || s.active) return null;
  if (!s.locked) {
    return (
      `LUCKY-20 starts with the next block, #${ACTIVATION_HEIGHT.toLocaleString("en-US")}. Create and Mine are open: ` +
      `every transaction the app sends has a lock time, so it can only be confirmed in block #${ACTIVATION_HEIGHT.toLocaleString("en-US")} or later.`
    );
  }
  return (
    `LUCKY-20 starts at block ${at(ACTIVATION_HEIGHT)}. Create and Mine open at block ${at(UNLOCK_HEIGHT)}, ${countdownText(s.blocksLeft)}; ` +
    `a LUCKY-20 transaction confirmed before block ${at(ACTIVATION_HEIGHT)} is ignored and only costs fees.`
  );
}

/** Short idle hint for a locked action button ("Locked until block #969,599 (see above)."). */
export function lockedHint() {
  return `Locked until block ${at(UNLOCK_HEIGHT)} (see above).`;
}
