// The mock indexer's settlement rules (VITE_MOCK=1) — the §2 / §4.1 / §7.5
// decisions of PROTOCOL.md in one pure function, so a mock-mode browser
// check shows what the real indexer would do. Plain
// data in, plain data out; tested in test/views.test.js.
//
// Deployer attribution is the commit-reveal rule (§2.1): the deployer is
// the address of the COMMIT carrier that the REVEAL spends as input 0 —
// no signature-shape heuristics. Consensus itself is asserted by the
// indexer's own tests and the shared vector files, never by this file.

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

/** SIGHASH_SINGLE | SIGHASH_ANYONECANPAY — the sighash of every listing signature. */
export const LISTING_SIGHASH_BYTE = 0x83;

/**
 * The script type of the output an address pays, as far as the listing
 * rules care: "tr" (P2TR, a 32-byte v1 program), "wpkh" (P2WPKH, a
 * 20-byte v0 program), or null for anything else.
 */
export function listedScriptType(address) {
  const a = String(address || "");
  if (/^bc1p[02-9ac-hj-np-z]{58}$/.test(a)) return "tr";
  if (/^bc1q[02-9ac-hj-np-z]{38}$/.test(a)) return "wpkh";
  return null;
}

/**
 * The sighash byte an input's witness (hex elements, `decodeRawTx`
 * `witnesses[i]`) was signed with, read from its signature the way the
 * indexer reads it from the block, for the script type of the output it
 * spends (`prevoutType`, listedScriptType):
 *   "tr" (key path) — one element once an annex (a last element starting
 *     0x50, when there are at least two) is set aside: a 64-byte
 *     signature is SIGHASH_DEFAULT (0x00), a 65-byte one ends with its
 *     sighash byte;
 *   "wpkh" — two elements, a DER signature of 9–73 bytes first: its last
 *     byte.
 * Null for any other shape or script type. Without `prevoutType` the
 * type is guessed from the witness shape (a 33-byte second element reads
 * as a P2WPKH key).
 */
export function inputSighash(witness, prevoutType) {
  const w = Array.isArray(witness) ? witness.map((x) => String(x || "").toLowerCase()) : [];
  const bytes = (h) => h.length / 2;
  const type = prevoutType === undefined ? (w.length === 2 && bytes(w[1]) === 33 && !w[1].startsWith("50") ? "wpkh" : "tr") : prevoutType;
  if (type === "tr") {
    const annex = w.length >= 2 && w[w.length - 1].startsWith("50");
    if (w.length - (annex ? 1 : 0) !== 1) return null;
    if (bytes(w[0]) === 64) return 0x00;
    if (bytes(w[0]) === 65) return parseInt(w[0].slice(-2), 16);
    return null;
  }
  if (type === "wpkh") {
    if (w.length !== 2 || bytes(w[0]) < 9 || bytes(w[0]) > 73) return null;
    return parseInt(w[0].slice(-2), 16);
  }
  return null;
}

/**
 * §7.5 (as the indexer decides it) for a listed outpoint spent as input
 * `inputIdx` of decoded tx `d` (`swap.decodeRawTx` shape, with
 * `witnesses`) under routing `decision` (routeDecision):
 *
 *   A FILL only when that input is signed SIGHASH_SINGLE|ANYONECANPAY
 *   (0x83) — the seller's listing signature — AND the output at the same
 *   index (SIGHASH_SINGLE pairs them) pays the seller ≥ price_sats. Any
 *   other spend — a withdrawal, split or send, signed with the default
 *   sighash, whatever it pays — cancels the order.
 *
 *   The buyer is the address of the output the listing's tokens landed on
 *   after routing: an applied SEND of the order's ticker → its TO_OUT;
 *   otherwise (a SEND without the fee, another payload, none) the residual
 *   target. Tokens landing on the seller's own address make a self-trade;
 *   burned tokens (no address) leave the buyer null. The protocol fee is
 *   not required: a whole-UTXO sale moves the tokens either way.
 *
 * → { filled, buyer, selfTrade, priceSats } (`priceSats` = what the paired output pays)
 */
export function settleListingSpend(d, decision, order, inputIdx) {
  const outputs = d.outputs || [];
  // The listed output pays the seller's own script, so its type is the
  // seller address's (a listing is only ever P2TR or P2WPKH; an address the
  // rule cannot type leaves it to the witness shape).
  const sighash = inputSighash((d.witnesses || [])[inputIdx], listedScriptType(order.seller) ?? undefined);
  const pay = outputs[inputIdx];
  const paid = sighash === LISTING_SIGHASH_BYTE && !!pay && !isOpReturnOut(pay) && pay.address === order.seller && pay.sats >= order.price_sats;
  if (!paid) return { filled: false, buyer: null, selfTrade: false, priceSats: null };
  const landVout = decision && decision.send && decision.send.ticker === order.ticker ? decision.send.vout : decision ? decision.residualVout : null;
  const land = Number.isInteger(landVout) ? outputs[landVout] : null;
  const buyer = land && !isOpReturnOut(land) && land.address ? land.address : null;
  return { filled: true, buyer, selfTrade: !!buyer && buyer === order.seller, priceSats: pay.sats };
}

/** Does this spend of a listed outpoint fill the order (settleListingSpend)? */
export function isFillOf(d, decision, order, inputIdx) {
  return settleListingSpend(d, decision, order, inputIdx).filled;
}
