// The mock indexer's settlement rules (VITE_MOCK=1) — the §2 / §4.1 / §7.5
// decisions of PROTOCOL.md in pure functions, so a mock-mode browser check
// shows what the real indexer would do. Plain data in, plain data out;
// tested in test/flows.test.js.
//
// Deployer attribution is the whole-tx-signed rule of §2.1 (deployerOf):
// the address that contributed the most prevout value among the inputs
// signed 0x00 or 0x01. Inputs signed as a listing follow §4 rule 6
// (listingSignedInputs): their tokens move only through an applied SEND of
// their ticker, and otherwise go to the output their signature pays. Both
// read the signature type the way the indexer does (src/lib/sighash.js).
// Consensus itself is asserted by the indexer's own tests and the shared
// vector files, never by this file.

import {
  DEPLOY_PROTOCOL_FEE_SATS,
  MINE_PROTOCOL_FEE_SATS,
  PROJECT_FEE_ADDRESS,
  SEND_PROTOCOL_FEE_SATS,
  SEND_RESIDUAL_VOUT,
  SEND_TO_VOUT,
} from "./payloads.js";
import { LISTING_SIGHASH_BYTE, inputSighash, listedScriptType } from "./sighash.js";

export { LISTING_SIGHASH_BYTE, listedScriptType, inputSighash };

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

const outpointOf = (i) => `${i.txid}:${i.vout}`;

/**
 * The signature type (src/lib/sighash.js) of input `i` of decoded tx `d`,
 * for the script type of the output it spends — always a type, `null`
 * when the prevout is unknown or neither P2TR nor P2WPKH, never guessed
 * from the witness shape (consensus does not guess). `prevoutOf(outpoint)`
 * → `{ address, sats }` or null.
 */
function typeOfInput(d, i, prevoutOf) {
  const input = (d.inputs || [])[i];
  const pv = input ? prevoutOf(outpointOf(input)) : null;
  return inputSighash((d.witnesses || [])[i], listedScriptType(pv?.address) ?? null);
}

/**
 * §4 rule 6: the input indexes of `d` that are LISTING-SIGNED — signature
 * type 0x83 (SIGHASH_SINGLE|ANYONECANPAY) and a paired output `vout[i]`
 * that exists and is not an OP_RETURN. (A 0x83 input without a usable
 * `vout[i]` is an ordinary input: its signature binds no payment.)
 */
export function listingSignedInputs(d, prevoutOf = () => null) {
  const out = [];
  (d.inputs || []).forEach((_, i) => {
    if (typeOfInput(d, i, prevoutOf) === LISTING_SIGHASH_BYTE && usableOut(d.outputs || [], i)) out.push(i);
  });
  return out;
}

/**
 * §2.1 deployer: the address with the most prevout value, summed per
 * address, over the inputs whose signature type is 0x00 or 0x01 — the
 * inputs that signed the WHOLE transaction; ties → the address whose first
 * such input has the lower index; "" when no input qualifies. A listing's
 * 0x83 input, an ANYONECANPAY / NONE / SINGLE signature, a script-path or
 * P2WSH spend and an unknown prevout never count.
 */
export function deployerOf(d, prevoutOf = () => null) {
  const totals = new Map(); // address → { sum, first }
  (d.inputs || []).forEach((input, i) => {
    if (![0x00, 0x01].includes(typeOfInput(d, i, prevoutOf))) return;
    const pv = prevoutOf(outpointOf(input));
    if (!pv || !pv.address) return;
    const cur = totals.get(pv.address) || { sum: 0, first: i };
    cur.sum += Number(pv.sats) || 0;
    totals.set(pv.address, cur);
  });
  let best = "";
  let bestSum = -1;
  let bestFirst = Infinity;
  for (const [addr, { sum, first }] of totals) {
    if (sum > bestSum || (sum === bestSum && first < bestFirst)) {
      best = addr;
      bestSum = sum;
      bestFirst = first;
    }
  }
  return best;
}

/**
 * The routing decision for one decoded tx (`swap.decodeRawTx` shape). The
 * per-ticker `pool` holds the ORDINARY inputs' balances; `listed` =
 * `[{ idx, balances }]` the listing-signed inputs (listingSignedInputs):
 *
 *   { op, valid, applied, reason, deployer?, yieldVout, send: { vout, ticker, amount } | null,
 *     residualVout, listedTo: [{ vout, balances }] }
 *
 * `residualVout` null = the residual pool burns. MINE: `valid` iff the
 * ticker is deployed in an EARLIER block than `height` (`deployBlockOf`),
 * the exact 546-sat fee output exists and vout0 is a real non-OP_RETURN
 * output — else `reason` names the first rule it failed (§2.2:
 * not_deployed, deploy_same_block, fee_missing, vout0_unusable); the pool
 * → vout0 whether valid or not, burning only when vout0 is missing / an
 * OP_RETURN (§2.2, no fall-back). SEND: `applied` iff the pool — the
 * listing-signed inputs' balance of the ticker included — holds ≥ AMT, the
 * exact 546-sat fee output exists and vout1 is a real non-OP_RETURN
 * output; AMT → vout1, the rest → vout2, else the default output (§2.3).
 * DEPLOY: `reason` fee_missing, then ticker_taken, null when it registers
 * the ticker; `deployer` = deployerOf; the pool → the default output. No
 * payload (incl. an `avatar` op, §8) → the default output.
 *
 * `listedTo`: every listing-signed input's balances that did not move with
 * an applied SEND of their ticker go to its own `vout[idx]` (§4 rule 6).
 */
export function routeDecision(d, { pool = {}, listed = [], isDeployed = () => false, deployBlockOf = () => null, height = null, prevoutOf = () => null } = {}) {
  const outputs = d.outputs || [];
  const p = d.payload;
  const listedTo = (moved = null) =>
    (listed || [])
      .map(({ idx, balances }) => {
        const rest = { ...(balances || {}) };
        if (moved) delete rest[moved];
        return { vout: idx, balances: rest };
      })
      .filter((e) => Object.values(e.balances).some((a) => a > 0));
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
    return { op: "MINE", valid, applied: valid, reason, yieldVout: valid ? 0 : null, send: null, residualVout: v0 ? 0 : null, listedTo: listedTo() };
  }
  if (p && p.op === "SEND") {
    const to = usableOut(outputs, SEND_TO_VOUT);
    const listedAmt = (listed || []).reduce((s, e) => s + (Number(e.balances?.[p.ticker]) || 0), 0);
    const have = (pool[p.ticker] || 0) + listedAmt;
    const applied = have >= p.amount && !!to && hasExactFee(outputs, SEND_PROTOCOL_FEE_SATS);
    return {
      op: "SEND",
      valid: applied,
      applied,
      reason: null,
      yieldVout: null,
      send: applied ? { vout: SEND_TO_VOUT, ticker: p.ticker, amount: p.amount } : null,
      residualVout: usableOut(outputs, SEND_RESIDUAL_VOUT) ? SEND_RESIDUAL_VOUT : defaultOutIdx(outputs),
      listedTo: listedTo(applied ? p.ticker : null),
    };
  }
  if (p && p.op === "DEPLOY") {
    const reason = !hasExactFee(outputs, DEPLOY_PROTOCOL_FEE_SATS) ? "fee_missing" : isDeployed(p.ticker) ? "ticker_taken" : null;
    const applied = reason === null;
    return { op: "DEPLOY", valid: applied, applied, reason, deployer: deployerOf(d, prevoutOf), yieldVout: null, send: null, residualVout: defaultOutIdx(outputs), listedTo: listedTo() };
  }
  return { op: null, valid: false, applied: false, reason: null, yieldVout: null, send: null, residualVout: defaultOutIdx(outputs), listedTo: listedTo() };
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
 *   The buyer is the address of vout1 when the tx is an applied SEND of
 *   the order's ticker; otherwise the listed tokens went to `vout[inputIdx]`
 *   (§4 rule 6), which pays the seller: a fill without the SEND fee (or
 *   with another payload, or none) is the seller's own trade. Tokens
 *   landing on the seller's address make a self-trade.
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
  const landVout = decision && decision.send && decision.send.ticker === order.ticker ? decision.send.vout : inputIdx;
  const land = outputs[landVout];
  const buyer = land && !isOpReturnOut(land) && land.address ? land.address : null;
  return { filled: true, buyer, selfTrade: !!buyer && buyer === order.seller, priceSats: pay.sats };
}

/** Does this spend of a listed outpoint fill the order (settleListingSpend)? */
export function isFillOf(d, decision, order, inputIdx) {
  return settleListingSpend(d, decision, order, inputIdx).filled;
}
