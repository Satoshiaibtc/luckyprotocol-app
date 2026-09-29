// Plain-language funding errors — pure, tested in test/flows.test.js.
//
// The builders (src/lib/psbt.js, src/lib/swap.js) throw precise developer
// text: "no spendable BTC at bc1p… — every UTXO is either ≤ 546 sats or
// token-bearing", "insufficient funds: need 13,446 sats, have 12,000
// spendable (1 UTXO)". Both are true but miss the most common reason on a
// fresh wallet — the BTC is there and simply has not confirmed yet (fee
// inputs are confirmed outputs only) — and neither says what to do next.
// `fundingMessage` turns them into one sentence with the cause and the next
// step; anything that is not a funding error is left to the caller (null).

const fmt = (n) => Number(n).toLocaleString("en-US");

/** Is `e` a builder's "nothing to spend" / "not enough" error? */
export function isFundingError(e) {
  if (!e) return false;
  if (e.code === "no-spendable" || e.code === "insufficient" || e.code === "too-many-inputs") return true;
  return /insufficient funds|no spendable BTC|no usable fee input/.test(String(e.message || e));
}

/**
 * `utxoRes` is the wallet.getBitcoinUtxos result the build used (or null):
 * `waitingSats` = plain BTC that exists but was held back only because it is
 * not confirmed / not indexed yet.
 * `action` names the transaction ("this MINE", "this DEPLOY", "this fill").
 * → string | null (null: not a funding error).
 */
export function fundingMessage(e, utxoRes = null, { action = "this transaction" } = {}) {
  if (!isFundingError(e)) return null;
  const waiting = Number(utxoRes?.waitingSats) || 0;
  const notUsed = "Unconfirmed outputs and token carriers are not used.";
  const waitingNote = waiting > 0 ? ` ${fmt(waiting)} sats in this wallet have not confirmed yet — they can be used once a block confirms them.` : "";

  if (e.code === "too-many-inputs") {
    // The value is there, spread over too many small outputs: more BTC would not help.
    return (
      `This wallet's confirmed BTC is spread over many small outputs: ${action} would need more than ${fmt(e.maxInputs || 200)} of them at this fee rate. ` +
      "Combine them in your wallet (send them to yourself in one transaction), or pick a lower fee rate."
    );
  }
  if (e.code === "insufficient" && Number.isFinite(e.needSats) && Number.isFinite(e.haveSats)) {
    return (
      `Not enough confirmed BTC for ${action}: it needs ${fmt(e.needSats)} sats (outputs + network fee) and ${fmt(e.haveSats)} sats can be used.${waitingNote} ` +
      `${notUsed} Wait for pending transactions to confirm, pick a lower fee rate, or add BTC.`
    );
  }
  if (e.code === "insufficient" || /insufficient funds/.test(String(e.message || e))) {
    return `Not enough confirmed BTC for ${action}.${waitingNote} ${notUsed} Wait for pending transactions to confirm, pick a lower fee rate, or add BTC.`;
  }
  // Nothing spendable at all.
  if (waiting > 0) {
    return `Your ${fmt(waiting)} sats have not confirmed yet — ${action} can only spend confirmed BTC. Try again after the next block confirms them; nothing was sent.`;
  }
  return `No usable BTC for ${action}. ${notUsed} Send plain BTC to this address, then try again.`;
}
