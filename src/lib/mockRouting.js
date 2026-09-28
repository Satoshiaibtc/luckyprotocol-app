// The mock indexer's settlement rules (VITE_MOCK=1) — the §2 / §4.1 / §7.5
// decisions of PROTOCOL.md in one pure function, so a mock-mode browser
// check shows what the real indexer would do (audit consensus-7). Plain
// data in, plain data out; tested in test/views.test.js.
//
// Deployer attribution is the commit-reveal rule (§2.1): the deployer is
// the address of the COMMIT carrier that the REVEAL spends as input 0 —
// no signature-shape heuristics. Consensus itself is asserted by the
// indexer's Rust tests and the shared vector files, never by this file.

import {
  ACTIVATION_HEIGHT,
  DEPLOY_PROTOCOL_FEE_SATS,
  MAX_COMMIT_AGE,
  MIN_COMMIT_AGE,
  MINE_PROTOCOL_FEE_SATS,
  PROJECT_FEE_ADDRESS,
  SEND_PROTOCOL_FEE_SATS,
  commitHashOf,
} from "./payloads.js";

/** An OP_RETURN output: its scriptPubKey starts with 0x6a (§2), whatever follows. */
export const isOpReturnOut = (o) => !!o && typeof o.script === "string" && o.script.toLowerCase().startsWith("6a");

/** A real, non-OP_RETURN output at `idx`, or null. */
function usableOut(outputs, idx) {
  const o = Number.isInteger(idx) ? outputs[idx] : undefined;
  return o && !isOpReturnOut(o) ? o : null;
}

/**
 * §4 rule 3: the lowest-index non-OP_RETURN output, if it encodes an
 * address; null (= burn) when the tx has none or the first one is
 * address-less (P2PK, bare multisig, non-standard) — no skipping ahead.
 */
export function defaultOutIdx(outputs) {
  const o = (outputs || []).find((x) => !isOpReturnOut(x));
  return o && o.address ? o.vout : null;
}

const hasExactFee = (outputs, sats) => (outputs || []).some((o) => o.address === PROJECT_FEE_ADDRESS && o.sats === sats);

/**
 * The routing decision for one decoded tx (`swap.decodeRawTx` shape) given
 * its per-ticker input `pool` and `isDeployed(ticker)`:
 *
 *   { op, valid, applied, yieldVout, send: { vout, ticker, amount } | null, residualVout }
 *
 * `residualVout` null = the residual pool burns. MINE: `valid` iff the
 * ticker is deployed in an EARLIER block than `height` (`deployBlockOf`),
 * the exact 546-sat fee output exists and vout0 is a real non-OP_RETURN
 * output — else `reason` names the first rule it failed (§2.2:
 * not_deployed, deploy_same_block, fee_missing, vout0_unusable); the pool
 * → vout0 whether valid or not, burning only when vout0 is missing / an
 * OP_RETURN (§2.2, no fall-back). SEND:
 * `applied` iff pool ≥ AMT, the fee output exists and vout[TO_OUT] is a
 * real non-OP_RETURN output; the rest → CHANGE_OUT, else the default
 * output (§2.3). COMMIT: `valid` iff vout0 exists, is not an OP_RETURN
 * and has an address (its value is never read — 0 sats is a carrier too);
 * `commit` names what to record, with vout0's script (`carrier_script`,
 * the script H binds); another COMMIT with the same hash changes nothing;
 * the pool → the default output. DEPLOY (the REVEAL): `applied` iff
 * revealRejection finds nothing (`reason` otherwise, `deployer` = the
 * committer when applied); the pool → the default output. No payload
 * (incl. the withdrawn AVATAR op, §8) → the default output.
 *
 * `commitAt(outpoint)` → the recorded COMMIT whose carrier is that
 * outpoint and that is still unspent ({ hash, carrier_script, height,
 * committer, status: "open" | "invalid" }) or null; `height` is the block
 * the tx confirms in.
 */
export function routeDecision(d, { pool = {}, isDeployed = () => false, deployBlockOf = () => null, commitAt = () => null, height = null } = {}) {
  const outputs = d.outputs || [];
  const p = d.payload;
  if (p && p.op === "COMMIT") {
    const v0 = outputs[0];
    const invalidReason = !v0 ? "carrier_missing" : isOpReturnOut(v0) ? "carrier_op_return" : !v0.address ? "carrier_no_address" : null;
    const valid = invalidReason === null;
    return {
      op: "COMMIT",
      valid,
      applied: valid,
      yieldVout: null,
      send: null,
      residualVout: defaultOutIdx(outputs),
      commit: {
        hash: p.hash,
        carrier: `${d.txid}:0`,
        carrier_script: v0 && typeof v0.script === "string" ? v0.script.toLowerCase() : "",
        committer: valid ? v0.address : null,
        status: valid ? "open" : "invalid",
        invalid_reason: invalidReason,
      },
    };
  }
  if (p && p.op === "MINE") {
    const v0 = usableOut(outputs, 0);
    const deployBlock = deployBlockOf(p.ticker);
    const reason = !isDeployed(p.ticker)
      ? "not_deployed"
      : Number.isInteger(deployBlock) && Number.isInteger(height) && height <= deployBlock
        ? "deploy_same_block"
        : !hasExactFee(outputs, MINE_PROTOCOL_FEE_SATS)
          ? "fee_missing"
          : !v0
            ? "vout0_unusable"
            : null;
    const valid = reason === null;
    return { op: "MINE", valid, applied: valid, reason, yieldVout: valid ? 0 : null, send: null, residualVout: v0 ? 0 : null };
  }
  if (p && p.op === "SEND") {
    const to = usableOut(outputs, p.toOutIdx);
    const have = pool[p.ticker] || 0;
    const applied = have >= p.amount && !!to && hasExactFee(outputs, SEND_PROTOCOL_FEE_SATS);
    const change = usableOut(outputs, p.changeOutIdx);
    return {
      op: "SEND",
      valid: applied,
      applied,
      yieldVout: null,
      send: applied ? { vout: p.toOutIdx, ticker: p.ticker, amount: p.amount } : null,
      residualVout: change ? p.changeOutIdx : defaultOutIdx(outputs),
    };
  }
  if (p && p.op === "DEPLOY") {
    const c = (d.inputs || []).length ? commitAt(`${d.inputs[0].txid}:${d.inputs[0].vout}`) : null;
    const reason = revealRejection(d, { isDeployed, commit: c, height });
    const applied = reason === null;
    return { op: "DEPLOY", valid: applied, applied, reason, deployer: applied ? c.committer : null, committer: c ? c.committer : null, yieldVout: null, send: null, residualVout: defaultOutIdx(outputs) };
  }
  return { op: null, valid: false, applied: false, yieldVout: null, send: null, residualVout: defaultOutIdx(outputs) };
}

/** H of a REVEAL payload under a carrier script (§2.1), or null when either is missing (never a match). */
function bindingHash(payloadText, carrierScript) {
  try {
    return typeof payloadText === "string" ? commitHashOf(payloadText, carrierScript) : null;
  } catch {
    return null;
  }
}

/** The seven REVEAL rules of §2.1, in order: the first one a DEPLOY fails, as a machine-readable reason. */
export const REVEAL_REASONS = ["commit_required", "no_commit", "commit_invalid", "hash_mismatch", "commit_before_activation", "commit_too_recent", "commit_expired", "fee_missing", "ticker_taken"];

/**
 * Why a DEPLOY payload does not apply, or null when it does (§2.1):
 *   commit_required           the old three-field DEPLOY (no salt) — never applied
 *   no_commit                 input 0 does not spend the carrier of a recorded COMMIT
 *   commit_invalid            …it does, but that COMMIT is recorded invalid
 *   hash_mismatch             that COMMIT's hash is not SHA-256(this payload ‖ its carrier's script)
 *   commit_before_activation  the COMMIT confirmed below ACTIVATION_HEIGHT
 *   commit_too_recent         reveal height < commit height + MIN_COMMIT_AGE
 *   commit_expired            reveal height > commit height + MAX_COMMIT_AGE
 *   fee_missing               no exact 5,460-sat output to PROJECT_FEE_ADDRESS
 *   ticker_taken              the ticker is already registered
 * `commit` = the recorded COMMIT input 0 spends ({ hash, carrier_script, height, committer, status }) or null.
 */
export function revealRejection(d, { isDeployed = () => false, commit = null, height = null } = {}) {
  const p = d.payload;
  if (!p || p.op !== "DEPLOY" || !p.salt) return "commit_required";
  if (!commit) return "no_commit";
  if (commit.status === "invalid") return "commit_invalid";
  if (bindingHash(d.payloadText, commit.carrier_script) !== commit.hash) return "hash_mismatch";
  if (!(commit.height >= ACTIVATION_HEIGHT)) return "commit_before_activation";
  if (!Number.isInteger(height) || height < commit.height + MIN_COMMIT_AGE) return "commit_too_recent";
  if (height > commit.height + MAX_COMMIT_AGE) return "commit_expired";
  if (!hasExactFee(d.outputs, DEPLOY_PROTOCOL_FEE_SATS)) return "fee_missing";
  if (isDeployed(p.ticker)) return "ticker_taken";
  return null;
}

/**
 * §7.5 (as the indexer implements it): a spend of a listed outpoint fills
 * the order when the tx is an APPLIED SEND of the order's ticker, and the
 * output at the SAME index as the listed input — SIGHASH_SINGLE pairs them
 * — pays ≥ price_sats to the seller. Anything else cancels it.
 */
export function isFillOf(d, decision, order, inputIdx) {
  if (!decision.applied || decision.op !== "SEND" || !decision.send || decision.send.ticker !== order.ticker) return false;
  const pay = (d.outputs || [])[inputIdx];
  return !!pay && !isOpReturnOut(pay) && pay.address === order.seller && pay.sats >= order.price_sats;
}
