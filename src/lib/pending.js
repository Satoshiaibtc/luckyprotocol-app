// Client-side registry of outpoints that WILL carry tokens once a tx we just
// broadcast confirms (MINE vout0, SEND-to-self vout0 + vout3, fill vout1 +
// vout4).
//
// The §4 builder obligation excludes ≤546-sat outputs and everything the
// indexer's /utxos/:addr reports — but the indexer only reports token
// outpoints after the tx confirms. If a wallet's UTXO source handed us an
// unconfirmed carrier as a fee input before the indexer knows about it, the
// next tx would be a plain spend of that carrier and default routing would
// move its tokens to that tx's first output. This set closes that window.

const TTL_MS = 24 * 60 * 60 * 1000;
const PENDING = new Map(); // "txid:vout" → addedAt

export function addPendingTokenOutpoints(list) {
  const now = Date.now();
  for (const o of list || []) {
    if (!o || typeof o.txid !== "string" || !Number.isInteger(o.vout)) continue;
    PENDING.set(`${o.txid.toLowerCase()}:${o.vout}`, now);
  }
}

export function pendingTokenOutpoints() {
  const now = Date.now();
  const out = [];
  for (const [k, at] of PENDING) {
    if (now - at > TTL_MS) { PENDING.delete(k); continue; }
    const [txid, vout] = k.split(":");
    out.push({ txid, vout: Number(vout) });
  }
  return out;
}

/** Merge indexer-reported token outpoints with the pending set. */
export function withPending(tokenOutpoints) {
  const seen = new Set();
  const out = [];
  for (const o of [...(tokenOutpoints || []), ...pendingTokenOutpoints()]) {
    const k = `${o.txid}:${o.vout}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ txid: o.txid, vout: o.vout });
  }
  return out;
}
