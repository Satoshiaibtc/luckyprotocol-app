// Trustless token trading — PSBT swap construction (PROTOCOL-v3.md §7).
//
// A listing is a one-input / one-output PSBT signed by the seller with
// SIGHASH_SINGLE | SIGHASH_ANYONECANPAY (0x83): the signature commits to
// input0 (their token UTXO) and output0 (price_sats back to themselves) and
// to nothing else, so a buyer can append their own inputs and the outputs
// that turn the tx into a valid SEND (§7.2) without touching the seller's
// signature. Nobody custodies anything; settlement is the Bitcoin network.
//
//   buildListingPsbt  — seller side, unsigned 1-in/1-out PSBT (§7.1)
//   verifyListing     — buyer side, §7.2 checks 1, 2, 4, 5 (3 is a live read)
//   buildFillPsbt     — buyer side, listing + inputs 1..n + SEND outputs (§7.2)
//   finalizeFill      — after UniSat signs the buyer's inputs: finalize input0
//                       from the seller's signature, extract the raw tx
//   decodeRawTx       — parse a raw tx (mock indexer + display)
//
// The app holds no keys: every signature comes from UniSat (or, in mock
// mode, from the simulated wallet's public-seed key).

import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
  DUST_SATS,
  PROJECT_FEE_ADDRESS,
  SEND_PROTOCOL_FEE_SATS,
  REQUIRED_TOKEN_SUPPLY,
  TICKER_RE,
  buildSendPayload,
  parsePayload,
  payloadToString,
} from "./payloads.js";
import {
  NETWORK,
  decodeAddress,
  xOnlyFromCompressedHex,
  filterSpendable,
  selectInputs,
  estimateVsize,
  inputVsize,
  checkedFeeRate,
  makeOpReturnScript,
  outpointKey,
} from "./psbt.js";

/** SIGHASH_SINGLE | SIGHASH_ANYONECANPAY — the only sighash a listing may use. */
export const LISTING_SIGHASH = 0x83;
export const MIN_PRICE_SATS = DUST_SATS;            // §7.1 price_sats ≥ 546
export const MAX_PRICE_SATS = 21e14;                 // §7.4
/**
 * Fill layout (§7.2): vout1 = buyer token slot (TO_OUT), vout4 = buyer
 * change (CHANGE_OUT, mandatory ≥ 546 — it doubles as the residual slot).
 * The two MUST differ: equal indices do not parse (§2.3) and the indexer
 * would strict-burn the seller's tokens.
 */
export const FILL_TO_OUT = 1;
export const FILL_CHANGE_OUT = 4;

const TXID_RE = /^[0-9a-f]{64}$/i;

const PSBT_OPTS = { allowUnknownOutputs: true };

function loadPsbt(psbtHex) {
  if (typeof psbtHex !== "string" || !/^[0-9a-f]+$/i.test(psbtHex) || psbtHex.length % 2 !== 0) {
    throw new Error("PSBT must be an even-length hex string");
  }
  return btc.Transaction.fromPSBT(hex.decode(psbtHex), PSBT_OPTS);
}

function scriptAddress(script) {
  try {
    return btc.Address(NETWORK).encode(btc.OutScript.decode(script));
  } catch {
    return null;
  }
}

function scriptType(script) {
  try {
    return btc.OutScript.decode(script).type; // 'tr' | 'wpkh' | ...
  } catch {
    return "unknown";
  }
}

function equalBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function checkOutpoint(txid, vout) {
  if (!TXID_RE.test(String(txid || ""))) throw new Error(`invalid txid "${txid}"`);
  if (!Number.isInteger(vout) || vout < 0 || vout > 1e6) throw new Error(`invalid vout ${vout}`);
}

// ---- §7.1 listing -----------------------------------------------------------------------

/**
 * Seller side. Exactly one input (the token-bearing UTXO at its REAL
 * on-chain value, `sighashType` 0x83, `tapInternalKey` for P2TR) and one
 * output paying `priceSats` to the same script. LockTime 0 (§7.1).
 *
 * The seller then signs input 0 with UniSat:
 *   signPsbt(hex, { autoFinalized: false,
 *                   toSignInputs: [{ index: 0, address, sighashTypes: [0x83] }] })
 *
 * @returns {{ psbtHex: string, inputIndexes: number[], sighashType: number, unitPrice: number }}
 */
export function buildListingPsbt({ address, pubkeyHex, tokenUtxo, priceSats, amount }) {
  const { type, script } = decodeAddress(address);
  if (!tokenUtxo || typeof tokenUtxo !== "object") throw new Error("tokenUtxo is required");
  checkOutpoint(tokenUtxo.txid, tokenUtxo.vout);
  const sats = Number(tokenUtxo.sats);
  if (!Number.isInteger(sats) || sats < DUST_SATS) {
    throw new Error(`token UTXO ${tokenUtxo.txid}:${tokenUtxo.vout} needs its real BTC value (≥ ${DUST_SATS} sats) — refresh UTXOs`);
  }
  const price = Number(priceSats);
  if (!Number.isInteger(price) || price < MIN_PRICE_SATS) {
    throw new Error(`price must be a whole number of sats ≥ ${MIN_PRICE_SATS}`);
  }
  if (price > MAX_PRICE_SATS) throw new Error("price exceeds the 21e14-sat cap");
  if (amount !== undefined) {
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt < 1 || amt > REQUIRED_TOKEN_SUPPLY) {
      throw new Error("amount must be a whole number of tokens in [1, 21,000,000]");
    }
  }

  const tx = new btc.Transaction({ lockTime: 0, allowUnknownOutputs: false });
  const input = {
    txid: String(tokenUtxo.txid).toLowerCase(),
    index: tokenUtxo.vout,
    witnessUtxo: { script, amount: BigInt(sats) },
    sighashType: LISTING_SIGHASH,
  };
  if (type === "tr") input.tapInternalKey = xOnlyFromCompressedHex(pubkeyHex);
  tx.addInput(input);
  tx.addOutput({ script, amount: BigInt(price) });

  return {
    psbtHex: hex.encode(tx.toPSBT()),
    inputIndexes: [0],
    sighashType: LISTING_SIGHASH,
    unitPrice: amount ? price / Number(amount) : null,
  };
}

// ---- §7.2 buyer-side verification --------------------------------------------------------

/**
 * Decode a listing PSBT into the fields the checks need. Throws if the
 * bytes are not a PSBT at all.
 */
export function parseListing(psbtHex) {
  const tx = loadPsbt(psbtHex);
  const inputs = [];
  for (let i = 0; i < tx.inputsLength; i++) inputs.push(tx.getInput(i));
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i++) outputs.push(tx.getOutput(i));
  const in0 = inputs[0] || null;
  const out0 = outputs[0] || null;
  const inScript = in0?.witnessUtxo?.script || null;
  return {
    tx,
    inputCount: inputs.length,
    outputCount: outputs.length,
    lockTime: tx.lockTime,
    input0: in0
      ? {
        txid: in0.txid ? hex.encode(in0.txid) : null,
        vout: in0.index ?? null,
        sighashType: in0.sighashType ?? null,
        witnessUtxo: in0.witnessUtxo ? { script: in0.witnessUtxo.script, amount: in0.witnessUtxo.amount } : null,
        tapKeySig: in0.tapKeySig || null,
        partialSig: in0.partialSig || null,
        tapInternalKey: in0.tapInternalKey || null,
        scriptType: inScript ? scriptType(inScript) : "unknown",
        address: inScript ? scriptAddress(inScript) : null,
        status: tx.inputsLength ? tx.inputStatus(0) : "unsigned",
      }
      : null,
    output0: out0
      ? { script: out0.script, amount: out0.amount, address: out0.script ? scriptAddress(out0.script) : null }
      : null,
  };
}

/**
 * §7.2 mandatory buyer-side checks 1, 2, 4, 5 against the indexer's
 * OrderView. Check 3 (order still open + seller still holds the outpoint)
 * is a live indexer read the caller performs and appends.
 *
 * @returns {{ ok: boolean, checks: Array<{ id, label, ok, detail }> }}
 */
export function verifyListing({ psbtHex, order }) {
  const checks = [];
  const push = (id, label, ok, detail) => checks.push({ id, label, ok: !!ok, detail: detail || "" });

  if (!order || typeof order !== "object") {
    push("shape", "Listing has exactly 1 input and 1 output", false, "no order to verify against");
    return { ok: false, checks };
  }

  let L;
  try {
    L = parseListing(psbtHex);
  } catch (e) {
    push("shape", "Listing has exactly 1 input and 1 output", false, `PSBT does not decode: ${e.message || e}`);
    return { ok: false, checks };
  }

  // 1. shape: 1 input + 1 output, lockTime 0, outpoint == order id
  const [oTxid, oVoutStr] = String(order.id || "").split(":");
  const oVout = Number(oVoutStr);
  const shapeOk = L.inputCount === 1 && L.outputCount === 1 && L.lockTime === 0;
  const outpointOk =
    !!L.input0 && TXID_RE.test(oTxid || "") && L.input0.txid === oTxid.toLowerCase() && L.input0.vout === oVout;
  push(
    "shape",
    "Listing has exactly 1 input and 1 output",
    shapeOk && outpointOk,
    !shapeOk
      ? `${L.inputCount} input(s), ${L.outputCount} output(s), lockTime ${L.lockTime}`
      : !outpointOk
        ? `input0 is ${L.input0?.txid?.slice(0, 8)}…:${L.input0?.vout}, order is ${order.id}`
        : `${L.inputCount} in / ${L.outputCount} out · lockTime 0 · outpoint ${order.id}`,
  );

  // 2. sighash 0x83 + a signature present (tapKeySig for P2TR, partialSig for P2WPKH)
  let sigOk = false;
  let sigDetail = "no input";
  if (L.input0) {
    const st = L.input0.sighashType;
    if (st !== LISTING_SIGHASH) {
      sigDetail = st === null ? "sighashType field missing" : `sighashType 0x${Number(st).toString(16)} ≠ 0x83`;
    } else if (L.input0.scriptType === "tr") {
      const sig = L.input0.tapKeySig;
      if (!sig) sigDetail = "no tapKeySig on the P2TR input";
      else if (sig.length !== 65 || sig[64] !== LISTING_SIGHASH) sigDetail = `tapKeySig is ${sig.length} bytes / trailing 0x${(sig[sig.length - 1] || 0).toString(16)}, expected 65 bytes ending 0x83`;
      else { sigOk = true; sigDetail = "SINGLE|ANYONECANPAY · Schnorr key-path signature present"; }
    } else if (L.input0.scriptType === "wpkh") {
      const ps = L.input0.partialSig;
      if (!ps || ps.length === 0) sigDetail = "no partialSig on the P2WPKH input";
      else {
        const sig = ps[0][1];
        if (!sig || sig[sig.length - 1] !== LISTING_SIGHASH) sigDetail = "partialSig does not end with the 0x83 sighash byte";
        else { sigOk = true; sigDetail = "SINGLE|ANYONECANPAY · ECDSA signature present"; }
      }
    } else {
      sigDetail = `unsupported input script type "${L.input0.scriptType}" (P2TR / P2WPKH only)`;
    }
  }
  push("signature", "Seller signed input 0 with SINGLE|ANYONECANPAY (0x83)", sigOk, sigDetail);

  // 4. output0.value == price_sats and output0.script == input0.script (== seller)
  let outOk = false;
  let outDetail = "no output";
  if (L.output0 && L.input0?.witnessUtxo) {
    const price = BigInt(Math.max(0, Math.floor(Number(order.price_sats) || 0)));
    const valueOk = L.output0.amount === price;
    const scriptOk = equalBytes(L.output0.script, L.input0.witnessUtxo.script);
    const sellerOk = !order.seller || L.output0.address === order.seller;
    outOk = valueOk && scriptOk && sellerOk;
    outDetail = !valueOk
      ? `output pays ${L.output0.amount} sats, order says ${price}`
      : !scriptOk
        ? "output script differs from the listed UTXO's script"
        : !sellerOk
          ? `output pays ${L.output0.address}, order seller is ${order.seller}`
          : `${price} sats → ${L.output0.address}`;
  }
  push("output", "Output 0 pays exactly price_sats back to the seller's script", outOk, outDetail);

  // 5. witnessUtxo.amount == carrier_sats
  let carOk = false;
  let carDetail = "no witnessUtxo";
  if (L.input0?.witnessUtxo) {
    const carrier = BigInt(Math.max(0, Math.floor(Number(order.carrier_sats) || 0)));
    carOk = L.input0.witnessUtxo.amount === carrier && carrier >= BigInt(DUST_SATS);
    carDetail = carOk
      ? `carrier ${carrier} sats`
      : `witnessUtxo says ${L.input0.witnessUtxo.amount} sats, indexer says ${carrier}`;
  }
  push("carrier", "witnessUtxo value matches the indexer's carrier_sats", carOk, carDetail);

  return { ok: checks.every((c) => c.ok), checks };
}

// ---- §7.2 fill --------------------------------------------------------------------------

/**
 * Fee/vsize model for a fill: input0 is the seller's (type from its
 * script), inputs 1..n are the buyer's.
 */
function fillVsize({ sellerType, buyerType, buyerInputCount, outputAddresses, opReturnScriptLen }) {
  return (
    estimateVsize({ inputCount: buyerInputCount, inputType: buyerType, outputAddresses, opReturnScriptLen }) +
    inputVsize(sellerType)
  );
}

/**
 * Display-only preview of a fill's cost before any UTXO is fetched: one
 * buyer input + the mandatory change output. Clamps the rate instead of throwing.
 */
export function estimateFillCost({ order, address, feeRateSatVb, inputCount = 1 }) {
  const buyerType = decodeAddress(address).type;
  const sellerType = order.seller && order.seller.startsWith("bc1p") ? "tr" : "wpkh";
  const payload = buildSendPayload({ ticker: order.ticker, amount: order.amount, toOutIdx: FILL_TO_OUT, changeOutIdx: FILL_CHANGE_OUT });
  const vsize = fillVsize({
    sellerType,
    buyerType,
    buyerInputCount: inputCount,
    outputAddresses: [order.seller || address, address, PROJECT_FEE_ADDRESS, address],
    opReturnScriptLen: makeOpReturnScript(payload).length,
  });
  const rate = Math.min(1_000, Math.max(1, Number(feeRateSatVb) || 1));
  const feeSats = Math.ceil(vsize * rate);
  const price = Number(order.price_sats) || 0;
  return {
    vsize: Math.ceil(vsize),
    feeSats,
    priceSats: price,
    totalSats: price + DUST_SATS + SEND_PROTOCOL_FEE_SATS + feeSats,
  };
}

/**
 * Buyer side. Takes the seller's signed listing and completes it into the
 * §7.2 SEND layout:
 *
 *   vout0  price_sats → seller        (from the listing — untouched)
 *   vout1  546        → buyer         (token slot; TO_OUT = 1)
 *   vout2  546        → PROJECT_FEE_ADDRESS
 *   vout3  OP_RETURN  LUCKYPROTOCOL|SEND|<T>|<AMT>|1|4
 *   vout4  change     → buyer         (CHANGE_OUT = 4; MANDATORY ≥ 546 —
 *                                      the payload commits it, so the build
 *                                      THROWS rather than fold it into the fee)
 *
 * Buyer inputs are filtered by the §4 builder obligation (≤546 sats and
 * every indexer-reported token outpoint are excluded). This is not just
 * hygiene: a token-bearing buyer input would make the input pool multi-
 * ticker and the indexer strict-burns anything a valid SEND does not route.
 *
 * @returns {{ psbtHex, inputIndexes: number[] (buyer's only), feeSats, totalSats, priceSats, changeSats }}
 */
export function buildFillPsbt({ listingPsbtHex, order, address, pubkeyHex, utxos, tokenOutpoints, feeRateSatVb }) {
  const v = verifyListing({ psbtHex: listingPsbtHex, order });
  if (!v.ok) {
    const bad = v.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join("; ");
    throw new Error(`listing failed verification — ${bad}`);
  }
  if (!TICKER_RE.test(String(order.ticker || ""))) throw new Error("order has an invalid ticker");

  const { type: buyerType, script: buyerScript } = decodeAddress(address);
  const tapInternalKey = buyerType === "tr" ? xOnlyFromCompressedHex(pubkeyHex) : null;

  const tx = loadPsbt(listingPsbtHex);
  const in0 = tx.getInput(0);
  const sellerScript = in0.witnessUtxo.script;
  const sellerType = scriptType(sellerScript);
  const sellerAddress = scriptAddress(sellerScript);
  const carrierSats = Number(in0.witnessUtxo.amount);
  const priceSats = Number(tx.getOutput(0).amount);
  const listedKey = `${hex.encode(in0.txid)}:${in0.index}`;

  // §4 filter, plus never re-spend the listed outpoint itself.
  const spendable = filterSpendable(utxos, tokenOutpoints).filter((u) => outpointKey(u) !== listedKey);
  if (spendable.length === 0) {
    throw new Error(`no spendable BTC at ${address} — every UTXO is either ≤ ${DUST_SATS} sats or token-bearing`);
  }
  const satVb = checkedFeeRate(feeRateSatVb);

  const payload = buildSendPayload({ ticker: order.ticker, amount: order.amount, toOutIdx: FILL_TO_OUT, changeOutIdx: FILL_CHANGE_OUT });
  const opReturnScript = makeOpReturnScript(payload);
  const fixedOutValue = priceSats + DUST_SATS + SEND_PROTOCOL_FEE_SATS;
  // vout4 (change) is committed by the payload, so it is part of the fixed
  // layout: the estimate always counts it and the target always carries the
  // dust headroom for it — exactly like buildSendPsbt's vout3.
  const outputAddresses = [sellerAddress || address, address, PROJECT_FEE_ADDRESS, address];

  let selected = [];
  let total = 0;
  let fee = 0;
  for (let pass = 0; pass < 3; pass++) {
    const target = fixedOutValue + fee + DUST_SATS - carrierSats;
    ({ selected, total } = selectInputs({ utxos: spendable, target: Math.max(1, target), excludeKeys: [] }));
    const vsize = fillVsize({
      sellerType,
      buyerType,
      buyerInputCount: selected.length,
      outputAddresses,
      opReturnScriptLen: opReturnScript.length,
    });
    const newFee = Math.ceil(vsize * satVb);
    if (newFee === fee) break;
    fee = newFee;
  }

  const change = carrierSats + total - fixedOutValue - fee;
  if (change < DUST_SATS) {
    throw new Error(
      `change output required (payload commits change_out_idx=${FILL_CHANGE_OUT} for residual tokens) ` +
      `but change is ${change} sat < dust ${DUST_SATS} — refusing to build`,
    );
  }

  const inputIndexes = [];
  for (const u of selected) {
    const input = { txid: u.txid, index: u.vout, witnessUtxo: { script: buyerScript, amount: BigInt(u.sats) } };
    if (tapInternalKey) input.tapInternalKey = tapInternalKey;
    inputIndexes.push(tx.addInput(input));
  }
  tx.addOutputAddress(address, BigInt(DUST_SATS), NETWORK);                          // vout1 token slot
  tx.addOutputAddress(PROJECT_FEE_ADDRESS, BigInt(SEND_PROTOCOL_FEE_SATS), NETWORK); // vout2 fee
  tx.addOutput({ script: opReturnScript, amount: 0n });                             // vout3 OP_RETURN
  tx.addOutputAddress(address, BigInt(change), NETWORK);                            // vout4 change — mandatory

  return {
    psbtHex: hex.encode(tx.toPSBT()),
    inputIndexes,
    feeSats: fee,
    priceSats,
    totalSats: priceSats + DUST_SATS + SEND_PROTOCOL_FEE_SATS + fee,
    changeSats: change,
    feeRateSatVb: satVb,
    seller: sellerAddress,
  };
}

/**
 * After UniSat signed (and finalized) the buyer's inputs: finalize input0
 * from the seller's SINGLE|ANYONECANPAY signature, assert every input is
 * finalized, and extract the raw transaction hex for broadcast.
 */
export function finalizeFill(signedPsbtHex) {
  const tx = loadPsbt(signedPsbtHex);
  if (tx.inputsLength < 2) throw new Error("fill has no buyer inputs");
  if (tx.inputStatus(0) !== "finalized") tx.finalizeIdx(0);
  for (let i = 0; i < tx.inputsLength; i++) {
    const st = tx.inputStatus(i);
    if (st !== "finalized") throw new Error(`input ${i} is ${st} — UniSat did not sign/finalize it`);
  }
  return hex.encode(tx.extract());
}

// ---- raw tx decoding (mock indexer + display) ----------------------------------------------

/**
 * Parse a raw signed tx into `{ txid, inputs: [{txid, vout}], outputs:
 * [{ vout, sats, script(hex), address|null }], payload|null }` where
 * `payload` is the parsed LuckyProtocol OP_RETURN (parsePayload) if any.
 */
export function decodeRawTx(rawHex) {
  if (typeof rawHex !== "string" || !/^[0-9a-f]+$/i.test(rawHex) || rawHex.length % 2 !== 0) {
    throw new Error("raw tx must be an even-length hex string");
  }
  const bytes = hex.decode(rawHex);
  const tx = btc.Transaction.fromRaw(bytes, { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const parsed = btc.RawTx.decode(bytes);
  const inputs = parsed.inputs.map((i) => ({ txid: hex.encode(i.txid), vout: i.index }));
  let payload = null;
  let payloadText = null;
  const outputs = parsed.outputs.map((o, vout) => {
    const script = o.script;
    let address = null;
    if (script[0] === 0x6a) {
      // OP_RETURN: direct push or PUSHDATA1
      const data = script[1] === 0x4c ? script.subarray(3) : script.subarray(2);
      const text = payloadToString(data);
      const p = parsePayload(text);
      if (p && payload === null) { payload = p; payloadText = text; }
    } else {
      address = scriptAddress(script);
    }
    return { vout, sats: Number(o.amount), script: hex.encode(script), address };
  });
  return { txid: tx.id, inputs, outputs, payload, payloadText };
}
