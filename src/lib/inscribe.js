// On-chain token avatars (PROTOCOL-v3.md §8): ord-style inscription envelope,
// ephemeral commit key, commit / reveal construction and the reveal's
// script-path signature.
//
// The flow (§8.5), and the ONLY key this app ever holds:
//
//   1. compressAvatar(file)            → ≤ 10,240-byte WebP (PNG fallback), 256×256
//   2. generateEphemeralKey()          → 32 random bytes, kept in localStorage
//                                        ('lp.avatar.<TICKER>', AES-GCM-encrypted — see
//                                        RECORD ENCRYPTION) until the reveal confirms
//   3. buildEnvelopeScript(...)        → <xonly> OP_CHECKSIG OP_FALSE OP_IF … OP_ENDIF   (§8.2)
//      commitPayment(priv, leaf)       → P2TR(internal = ephemeral, tree = [leaf])
//      commitAmountFor(...)            → 546 + the reveal's input0 cost (see FEE SPLIT)
//      → the wallet pays that amount to the commit address (buildPayPsbt, a plain send)
//   4. buildRevealPsbt(...)            → input0 = commit output (script path), input1.. =
//                                        deployer UTXOs (§4-filtered), outputs per §8.1
//      wallet.signPsbt(walletInputIndexes, autoFinalized)      ← SIGNING ORDER, step 1
//      signRevealEphemeral(psbt, priv) → input0 tapScriptSig + finalized             ← step 2
//      finalizeReveal(psbt)            → raw tx hex (every input finalized)          ← step 3
//
// SIGNING ORDER — wallet first, app last (tested in test/inscribe.test.js
// against the mock provider, which really signs with @scure/btc-signer):
//   * BIP341's sighash commits to every input's prevout (amount + script),
//     and btc-signer keeps `witnessUtxo` on finalized inputs (it is in
//     PSBTInputFinalKeys), so input0 can still be signed after the wallet
//     has finalized its own inputs.
//   * Doing the wallet first means nothing is signed by the app until the
//     user has approved in the wallet; a declined signature leaves no
//     half-signed PSBT around.
//   * The wallet only ever sees a standard "foreign taproot input with
//     tapLeafScript" (the same shape marketplaces use), never a finalized
//     1–16 KB witness it has to carry through its own PSBT library.
//   The reverse order (ephemeral first) also extracts a valid tx with
//   btc-signer; it is simply not the one we ship.
//
// KEY-PATH GUARD: with internal key == ephemeral key (as §8.5 specifies), a
// key-path spend of the commit output is ALSO possible, and btc-signer's
// signIdx produces both a tapKeySig and a tapScriptSig; finalizeIdx prefers
// the key path, which would spend the commit WITHOUT revealing the image.
// signRevealEphemeral therefore strips tapKeySig before finalizing and
// finalizeReveal re-parses input0's witness to assert the envelope is there.
//
// FEE SPLIT (commit vs reveal):
//   commitAmount = DUST_SATS (546, the inscribed sat → reveal vout0)
//                + ceil(feeRate × input0Vsize)
//   where input0Vsize = 41 vB (outpoint + empty scriptSig + sequence) + the
//   script-path witness (sig 64 + leaf script + 33-byte control block) / 4.
//   So the commit pays for exactly the bytes the image adds; the deployer
//   input pays the remainder — the 546-sat protocol fee output, tx
//   overhead, its own input weight and the address outputs (about the cost
//   of a MINE) — and absorbs any fee-rate difference between commit and
//   reveal time. Both halves are itemized in the UI.
//
// RECORD ENCRYPTION (audit L-13): the recovery record holds the ephemeral
// private key and the image bytes. It is stored encrypted with AES-GCM-256
// under a key derived (HKDF-SHA256) from the wallet's signature of a FIXED
// domain string (AVATAR_KEY_DOMAIN) — nothing secret is ever written in
// clear, and nothing but the wallet that created the record can open it.
//   * The signature is `signMessage(AVATAR_KEY_DOMAIN, "ecdsa")` (RFC 6979
//     → deterministic for a given key). useAvatar signs TWICE when a record
//     is first created and refuses to proceed if the two differ, because a
//     non-deterministic signer could never re-derive the key.
//   * The derived key lives in memory for the session (per address). A
//     record from an earlier session shows as 'locked' until the user
//     unlocks it with one signature (no transaction, no fee).
//   * The only plaintext fallback is the mock provider (VITE_MOCK=1), which
//     has no signMessage; a real provider without signMessage cannot start
//     an inscription. Plaintext records written before this change still
//     load (and stay plaintext until they complete).
//   * Blob format: { v: 1, enc: "aes-gcm", ticker, iv: base64(12), ct: base64 }.
//
// DEPLOY WITH AVATAR (owner decision 2026-09-26, §2.1 + §8): the avatar is
// chosen on the Create page and inscribed TOGETHER with the DEPLOY. The
// same commit / reveal machinery is reused with a different reveal:
//
//   buildDeployRevealPsbt(...)        → input0 = commit (script path), inputs 1.. = the
//                                        wallet's fee inputs (§4-filtered), vout0 546 →
//                                        deployer, vout1 5,460 → PROJECT_FEE_ADDRESS,
//                                        vout2 OP_RETURN LUCKY-20|DEPLOY|T, vout3 change
//   signRevealEphemeral / finalizeReveal are payload-agnostic and shared.
//   The recovery record is the same shape with `kind: "deploy"` (+ the wallet
//   `address`), stored under 'lp.deploy.<TICKER>' with the same encryption.
//
// Everything above `compressAvatar` is pure and runs in Node
// (test/inscribe.test.js, test/deploy.inscribe.test.js).

import * as btc from "@scure/btc-signer";
import { hex, base64 } from "@scure/base";
import { pubSchnorr } from "@scure/btc-signer/utils.js";
import {
  DUST_SATS,
  PROJECT_FEE_ADDRESS,
  AVATAR_PROTOCOL_FEE_SATS,
  DEPLOY_PROTOCOL_FEE_SATS,
  buildAvatarPayload,
  buildDeployPayload,
  validateTicker,
} from "./payloads.js";
import {
  MAX_FEE_RATE_SAT_VB,
  NETWORK,
  VSIZE_TX_OVERHEAD,
  checkedFeeRate,
  decodeAddress,
  filterSpendable,
  inputVsize,
  isOpReturnScript,
  isP2tr,
  makeOpReturnScript,
  noSpendableError,
  outputVsize,
  selectInputs,
  xOnlyFromCompressedHex,
} from "./psbt.js";

// ---- §8.2 limits -------------------------------------------------------------------------

export const AVATAR_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_AVATAR_BYTES = 16_384;    // consensus for this protocol
export const TARGET_AVATAR_BYTES = 10_240; // reference-client target
export const AVATAR_SIDE_PX = 256;
export const MAX_CHUNK_BYTES = 520;        // MAX_SCRIPT_ELEMENT_SIZE
export const REVEAL_SIGNING_ORDER = "wallet-first";

const OP_0 = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_1 = 0x51;
const OP_16 = 0x60;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_CHECKSIG = 0xac;

const ascii = (s) => new TextEncoder().encode(s);

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Minimal-encoding data push (BIP62): direct / PUSHDATA1 / PUSHDATA2. */
export function pushBytes(data) {
  const n = data.length;
  if (n < OP_PUSHDATA1) return concat([new Uint8Array([n]), data]);
  if (n <= 0xff) return concat([new Uint8Array([OP_PUSHDATA1, n]), data]);
  if (n <= 0xffff) return concat([new Uint8Array([OP_PUSHDATA2, n & 0xff, n >> 8]), data]);
  throw new Error("push too large");
}

export function isAvatarContentType(ct) {
  return AVATAR_CONTENT_TYPES.includes(String(ct || "").toLowerCase());
}

/**
 * Leaf script per §8.2 (the standard ord envelope, ord's tag encodings):
 *
 *   <xonly:32> OP_CHECKSIG
 *   OP_FALSE OP_IF
 *     push("ord")
 *     OP_PUSHBYTES_1 0x01  push(<content-type>)
 *     OP_0                 push(<chunk ≤ 520>) …
 *   OP_ENDIF
 */
export function buildEnvelopeScript(xonlyPubkey, contentType, bytes) {
  if (!(xonlyPubkey instanceof Uint8Array) || xonlyPubkey.length !== 32) {
    throw new Error("envelope: xonlyPubkey must be 32 bytes");
  }
  if (!isAvatarContentType(contentType)) {
    throw new Error(`envelope: content type "${contentType}" is not one of ${AVATAR_CONTENT_TYPES.join(", ")}`);
  }
  if (!(bytes instanceof Uint8Array) || bytes.length < 1) throw new Error("envelope: body is empty");
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error(`envelope: body ${bytes.length.toLocaleString("en-US")} bytes exceeds the ${MAX_AVATAR_BYTES.toLocaleString("en-US")}-byte limit`);
  }
  const parts = [
    pushBytes(xonlyPubkey),
    new Uint8Array([OP_CHECKSIG, OP_0, OP_IF]),
    pushBytes(ascii("ord")),
    pushBytes(new Uint8Array([0x01])),
    pushBytes(ascii(String(contentType).toLowerCase())),
    new Uint8Array([OP_0]),
  ];
  for (let i = 0; i < bytes.length; i += MAX_CHUNK_BYTES) parts.push(pushBytes(bytes.subarray(i, i + MAX_CHUNK_BYTES)));
  parts.push(new Uint8Array([OP_ENDIF]));
  return concat(parts);
}

/** Tokenize a script into [{ op, data? }] — data pushes carry `data`, OP_N carries `num`. */
export function tokenizeScript(script) {
  const out = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    let len = null;
    if (op > 0 && op < OP_PUSHDATA1) len = op;
    else if (op === OP_PUSHDATA1) { len = script[i]; i += 1; }
    else if (op === OP_PUSHDATA2) { len = script[i] | (script[i + 1] << 8); i += 2; }
    else if (op === OP_PUSHDATA4) { len = (script[i] | (script[i + 1] << 8) | (script[i + 2] << 16) | (script[i + 3] << 24)) >>> 0; i += 4; }
    if (len !== null) {
      if (i + len > script.length) throw new Error("script: truncated push");
      out.push({ op, data: script.subarray(i, i + len) });
      i += len;
    } else if (op === OP_0) {
      out.push({ op, data: new Uint8Array(0) });
    } else if (op >= OP_1 && op <= OP_16) {
      out.push({ op, num: op - OP_1 + 1 });
    } else {
      out.push({ op });
    }
  }
  return out;
}

/** Numeric value of a tag push: OP_0 / empty → 0, OP_1..16 → n, 1-byte push → that byte; else null. */
function tagValue(tok) {
  if (tok.num !== undefined) return tok.num;
  if (tok.data) {
    if (tok.data.length === 0) return 0;
    if (tok.data.length === 1) return tok.data[0];
  }
  return null;
}

/**
 * Parse the FIRST envelope in a leaf script (§8.2) → `{ contentType, bytes }`
 * or null. Mirrors the indexer: anything before OP_FALSE OP_IF is ignored;
 * tag 1 = content type; tag 0 starts the body (every following push is a
 * body chunk); other tags skip one push. Limits are NOT enforced here —
 * see checkEnvelopeLimits.
 */
export function parseEnvelopeScript(script) {
  let toks;
  try {
    toks = tokenizeScript(script);
  } catch {
    return null;
  }
  for (let i = 0; i + 1 < toks.length; i++) {
    if (!(toks[i].op === OP_0 && toks[i + 1].op === OP_IF)) continue;
    let j = i + 2;
    if (!(toks[j] && toks[j].data && toks[j].data.length === 3 && new TextDecoder().decode(toks[j].data) === "ord")) return null;
    j += 1;
    let contentType = null;
    const chunks = [];
    let inBody = false;
    for (; j < toks.length; j++) {
      const t = toks[j];
      if (t.op === OP_ENDIF) break;
      if (inBody) {
        if (!t.data) return null;
        chunks.push(t.data);
        continue;
      }
      const tag = tagValue(t);
      if (tag === null) return null;
      if (tag === 0) { inBody = true; continue; }
      const v = toks[j + 1];
      if (!v || !v.data) return null;
      if (tag === 1) contentType = new TextDecoder().decode(v.data).toLowerCase();
      j += 1;
    }
    if (toks[j]?.op !== OP_ENDIF) return null;
    return { contentType, bytes: concat(chunks) };
  }
  return null;
}

/** §8.2 limits: content type in the allow-list and 1 ≤ body ≤ 16,384 bytes. */
export function checkEnvelopeLimits(env) {
  if (!env) return false;
  return isAvatarContentType(env.contentType) && env.bytes.length >= 1 && env.bytes.length <= MAX_AVATAR_BYTES;
}

/**
 * Envelope from a reveal input's witness stack `[sig, leafScript, controlBlock]`
 * (ord convention: the script is the second-to-last item; a 0x50 annex, if
 * any, is stripped). → `{ contentType, bytes }` | null.
 */
export function parseEnvelopeFromWitness(witness) {
  if (!Array.isArray(witness) || witness.length < 2) return null;
  let items = witness;
  const last = items[items.length - 1];
  if (last && last.length && last[0] === 0x50 && items.length >= 3) items = items.slice(0, -1);
  if (items.length < 2) return null;
  return parseEnvelopeScript(items[items.length - 2]);
}

// ---- ephemeral key + commit address ---------------------------------------------------------

/**
 * 32 random bytes from the browser CSPRNG, retried until they are a valid
 * secp256k1 scalar (pubSchnorr throws on 0 / ≥ n). Never leaves the page
 * except into localStorage until the reveal confirms (§8.5 step 2).
 */
export function generateEphemeralKey() {
  const rng = globalThis.crypto;
  if (!rng || typeof rng.getRandomValues !== "function") throw new Error("No secure random source in this browser");
  for (let attempt = 0; attempt < 16; attempt++) {
    const priv = new Uint8Array(32);
    rng.getRandomValues(priv);
    try {
      pubSchnorr(priv); // validates the scalar
      return priv;
    } catch {
      /* astronomically rare: retry */
    }
  }
  throw new Error("Could not generate a valid key");
}

export function ephemeralXonly(ephemeralPriv) {
  if (!(ephemeralPriv instanceof Uint8Array) || ephemeralPriv.length !== 32) throw new Error("ephemeral key must be 32 bytes");
  return pubSchnorr(ephemeralPriv);
}

/**
 * The commit P2TR payment: internal key = ephemeral x-only, tree = [leaf].
 * Returns btc-signer's payment object — `address`, `script`,
 * `tapInternalKey`, `tapMerkleRoot`, `tapLeafScript` are what the reveal's
 * input0 needs. Deterministic for a fixed key + leaf.
 */
export function commitPayment(ephemeralPriv, leafScript) {
  const xonly = ephemeralXonly(ephemeralPriv);
  const toks = tokenizeScript(leafScript);
  if (!(toks[0]?.data && toks[0].data.length === 32 && hex.encode(toks[0].data) === hex.encode(xonly) && toks[1]?.op === OP_CHECKSIG)) {
    throw new Error("leaf script does not start with this key's <xonly> OP_CHECKSIG");
  }
  // allowUnknownOutputs=true: the envelope leaf is not a script btc-signer classifies.
  return btc.p2tr(xonly, { script: leafScript }, NETWORK, true);
}

export function commitAddress(ephemeralPriv, leafScript) {
  return commitPayment(ephemeralPriv, leafScript).address;
}

// ---- reveal size / fee model ------------------------------------------------------------------

const compactSizeLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);

/** vB of the reveal's input0: 41 base + (count + sig + leaf + control block) witness bytes / 4. */
export function revealInput0Vsize(leafScriptLen) {
  const witnessBytes = 1 + (1 + 64) + (compactSizeLen(leafScriptLen) + leafScriptLen) + (1 + 33);
  return 41 + witnessBytes / 4;
}

/** Leaf script length for a body of `bodyLen` bytes with `contentType` (without building it). */
export function envelopeScriptLen(contentType, bodyLen) {
  const ct = ascii(String(contentType || "image/webp")).length;
  let n = 33 + 3 + 4 + 2 + (1 + ct) + 1; // <xonly> CHECKSIG FALSE IF | "ord" | 1 | ct | OP_0
  for (let i = 0; i < bodyLen; i += MAX_CHUNK_BYTES) {
    const c = Math.min(MAX_CHUNK_BYTES, bodyLen - i);
    n += (c < OP_PUSHDATA1 ? 1 : c <= 0xff ? 2 : 3) + c;
  }
  return n + 1; // ENDIF
}

/**
 * Fee model for the reveal at `feeRateSatVb`:
 *   input0Vsize / input0FeeSats     — what the commit funds (see FEE SPLIT)
 *   remainderVsize / remainderFeeSats — what the deployer input pays
 *   totalVsize / totalFeeSats
 * `inputType` is the deployer's ('tr' | 'wpkh'); `walletInputCount` defaults to 1.
 */
export function estimateRevealFee({ envelopeBytes, contentType = "image/webp", leafScriptLen, feeRateSatVb, inputType = "tr", deployerAddress, walletInputCount = 1, withChange = true, ticker = "AVATAR" }) {
  const rate = checkedFeeRate(feeRateSatVb);
  const leafLen = Number.isInteger(leafScriptLen) ? leafScriptLen : envelopeScriptLen(contentType, envelopeBytes);
  const type = deployerAddress ? (isP2tr(deployerAddress) ? "tr" : "wpkh") : inputType;
  const outAddr = deployerAddress || (type === "tr" ? PROJECT_FEE_ADDRESS : "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  let payloadLen = 0;
  try {
    payloadLen = makeOpReturnScript(buildAvatarPayload(ticker)).length;
  } catch {
    payloadLen = 9 + 27;
  }
  const input0Vsize = revealInput0Vsize(leafLen);
  let remainder = VSIZE_TX_OVERHEAD + walletInputCount * inputVsize(type) + outputVsize(outAddr) + outputVsize(PROJECT_FEE_ADDRESS) + 9 + payloadLen;
  if (withChange) remainder += outputVsize(outAddr);
  const input0FeeSats = Math.ceil(input0Vsize * rate);
  const remainderFeeSats = Math.ceil(remainder * rate);
  return {
    leafScriptLen: leafLen,
    input0Vsize,
    remainderVsize: remainder,
    totalVsize: Math.ceil(input0Vsize + remainder),
    input0FeeSats,
    remainderFeeSats,
    totalFeeSats: input0FeeSats + remainderFeeSats,
    feeRateSatVb: rate,
  };
}

/** Sats the wallet sends to the commit address: 546 (inscribed sat) + the reveal's input0 cost. */
export function commitAmountFor({ leafScriptLen, feeRateSatVb }) {
  const rate = checkedFeeRate(feeRateSatVb);
  return DUST_SATS + Math.ceil(revealInput0Vsize(leafScriptLen) * rate);
}

/** Slack on top of the fee-cap bound below, so a record written at exactly the cap still parses. */
export const COMMIT_AMOUNT_MARGIN_SATS = 1_000;

/**
 * Largest commitAmount a record may carry for a leaf of `leafScriptLen`
 * bytes: what commitAmountFor yields at the MAX_FEE_RATE_SAT_VB safety cap,
 * plus a small margin. Anything above it cannot have come from this app.
 */
export function maxCommitAmountFor(leafScriptLen) {
  return DUST_SATS + Math.ceil(revealInput0Vsize(leafScriptLen) * MAX_FEE_RATE_SAT_VB) + COMMIT_AMOUNT_MARGIN_SATS;
}

// ---- reveal PSBT ----------------------------------------------------------------------------------

/**
 * Unsigned reveal PSBT (§8.1 / §8.5 step 4).
 *
 *   input0     commit output — script path (tapLeafScript + tapMerkleRoot + tapInternalKey)
 *   input1..n  deployer UTXOs (filterSpendable: > 546 sats, not token-bearing) — at least ONE,
 *              even when the commit alone could cover the outputs: that input is the §8.3
 *              authorization
 *   vout0      546 → deployer (the inscribed sat)
 *   vout1      546 → PROJECT_FEE_ADDRESS
 *   vout2      OP_RETURN LUCKY-20|AVATAR|<T>
 *   vout3      change → deployer (folded into the fee when < 546; AVATAR routes no tokens)
 *
 * → { psbtHex, walletInputIndexes, feeSats, changeSats, changeOmitted, estimatedVsize, inputs }
 */
export function buildRevealPsbt({ commit, ephemeralPriv, leafScript, deployerAddress, deployerPubkeyHex, utxos, tokenOutpoints, feeRateSatVb, ticker, minInputSats = 0 }) {
  return buildImageRevealPsbt({ commit, ephemeralPriv, leafScript, deployerAddress, deployerPubkeyHex, utxos, tokenOutpoints, feeRateSatVb, ticker, minInputSats }, false);
}

export function buildDeployRevealPsbt(options) {
  return buildImageRevealPsbt(options, true);
}

/** A wallet signs the requested transaction; it must not replace its inputs or outputs. */
export function assertRevealWalletResult(unsignedHex, signedHex) {
  const before = btc.Transaction.fromPSBT(hex.decode(unsignedHex), PSBT_OPTS);
  const after = btc.Transaction.fromPSBT(hex.decode(signedHex), PSBT_OPTS);
  if (before.id !== after.id) throw new Error("Wallet changed the transaction while signing; broadcast cancelled.");
  for (let i = 0; i < before.inputsLength; i++) {
    const expected = before.getInput(i).witnessUtxo;
    const actual = after.getInput(i).witnessUtxo;
    if (!expected || !actual || expected.amount !== actual.amount || hex.encode(expected.script) !== hex.encode(actual.script)) {
      throw new Error("Wallet changed an input value or script; broadcast cancelled.");
    }
  }
}

function buildImageRevealPsbt({ commit, ephemeralPriv, leafScript, deployerAddress, deployerPubkeyHex, utxos, tokenOutpoints, feeRateSatVb, ticker, minInputSats = 0 }, deploy) {
  validateTicker(ticker);
  if (!commit || typeof commit.txid !== "string" || !/^[0-9a-f]{64}$/i.test(commit.txid) || !Number.isInteger(commit.vout) || !Number.isInteger(Number(commit.sats)) || Number(commit.sats) < DUST_SATS) {
    throw new Error("reveal: commit outpoint { txid, vout, sats } is required");
  }
  const pay = commitPayment(ephemeralPriv, leafScript);
  const { type, script } = decodeAddress(deployerAddress);
  const tapInternalKey = type === "tr" ? xOnlyFromCompressedHex(deployerPubkeyHex) : null;
  const satVb = checkedFeeRate(feeRateSatVb);
  const commitSats = Number(commit.sats);

  const spendable = filterSpendable(utxos, tokenOutpoints, { minSats: minInputSats }).filter((u) => !(u.txid.toLowerCase() === commit.txid.toLowerCase() && u.vout === commit.vout));
  if (spendable.length === 0) {
    if (minInputSats > DUST_SATS) throw noSpendableError(deployerAddress, minInputSats);
    throw new Error(`no spendable BTC at ${deployerAddress} for the reveal — a deployer-owned input is required (§8.3)`);
  }

  const outputs = [
    { address: deployerAddress, value: DUST_SATS },                       // vout0 inscribed sat
    { address: PROJECT_FEE_ADDRESS, value: deploy ? DEPLOY_PROTOCOL_FEE_SATS : AVATAR_PROTOCOL_FEE_SATS },
  ];
  const opReturnScript = makeOpReturnScript(deploy ? buildDeployPayload(ticker) : buildAvatarPayload(ticker));
  const fixedOutValue = outputs.reduce((s, o) => s + o.value, 0);
  const input0Vsize = revealInput0Vsize(leafScript.length);

  const vsizeFor = (n, withChange) => {
    let v = VSIZE_TX_OVERHEAD + input0Vsize + n * inputVsize(type) + 9 + opReturnScript.length;
    for (const o of outputs) v += outputVsize(o.address);
    if (withChange) v += outputVsize(deployerAddress);
    return v;
  };
  const attempt = (withChange) => {
    let selected, total;
    let fee = 0;
    for (let pass = 0; pass < 4; pass++) {
      const need = fixedOutValue + fee + (withChange ? DUST_SATS : 0) - commitSats;
      // target ≥ 1 sat so selectInputs always picks at least one deployer UTXO (authorization)
      ({ selected, total } = selectInputs({ utxos: spendable, target: Math.max(1, need), excludeKeys: [] }));
      const newFee = Math.ceil(vsizeFor(selected.length, withChange)) * satVb;
      if (newFee === fee) break;
      fee = newFee;
    }
    return { selected, total, fee, vsize: vsizeFor(selected.length, withChange) };
  };

  let sel;
  let changeOmitted = false;
  try {
    sel = attempt(true);
  } catch (e) {
    if (!/insufficient funds/.test(String(e.message))) throw e;
    sel = attempt(false);
    changeOmitted = true;
  }
  const { selected, total, fee } = sel;
  const change = commitSats + total - fixedOutValue - fee;
  if (change < 0) throw new Error(`insufficient funds after fee (${fee.toLocaleString("en-US")} sats)`);
  if (!changeOmitted && change < DUST_SATS) changeOmitted = true;
  const finalFee = changeOmitted ? fee + change : fee;

  const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.addInput({
    txid: commit.txid.toLowerCase(),
    index: commit.vout,
    witnessUtxo: { script: pay.script, amount: BigInt(commitSats) },
    tapInternalKey: pay.tapInternalKey,
    tapMerkleRoot: pay.tapMerkleRoot,
    tapLeafScript: pay.tapLeafScript,
  });
  const walletInputIndexes = [];
  for (const u of selected) {
    const input = { txid: u.txid, index: u.vout, witnessUtxo: { script, amount: BigInt(u.sats) } };
    if (tapInternalKey) input.tapInternalKey = tapInternalKey;
    walletInputIndexes.push(tx.addInput(input));
  }
  for (const o of outputs) tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
  tx.addOutput({ script: opReturnScript, amount: 0n });
  if (!changeOmitted) tx.addOutputAddress(deployerAddress, BigInt(change), NETWORK);

  return {
    psbtHex: hex.encode(tx.toPSBT()),
    walletInputIndexes,
    feeSats: finalFee,
    changeSats: changeOmitted ? 0 : change,
    changeOmitted,
    estimatedVsize: Math.ceil(sel.vsize),
    feeRateSatVb: satVb,
    inputs: selected.map((u) => ({ txid: u.txid, vout: u.vout, sats: Number(u.sats) })),
    commitAddress: pay.address,
  };
}

const PSBT_OPTS = { allowUnknownInputs: true, allowUnknownOutputs: true };

/**
 * Script-path-sign input0 with the ephemeral key and finalize it (step 2 of
 * the signing order). The wallet's inputs may already be finalized. The
 * key-path signature btc-signer also produces is removed first (KEY-PATH
 * GUARD above). → PSBT hex.
 */
export function signRevealEphemeral(psbtHex, ephemeralPriv) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), PSBT_OPTS);
  const in0 = tx.getInput(0);
  if (in0.finalScriptWitness) throw new Error("reveal: input0 is already finalized");
  if (!in0.tapLeafScript || !in0.tapLeafScript.length) throw new Error("reveal: input0 has no tapLeafScript — not a reveal PSBT");
  tx.signIdx(ephemeralPriv, 0);
  tx.updateInput(0, { tapKeySig: undefined }, true);
  tx.finalizeIdx(0);
  const w = tx.getInput(0).finalScriptWitness;
  if (!w || w.length !== 3 || !checkEnvelopeLimits(parseEnvelopeFromWitness(w))) {
    throw new Error("reveal: input0 did not finalize as a script-path spend");
  }
  return hex.encode(tx.toPSBT());
}

/**
 * Finalize whatever is still open (a wallet that ignored autoFinalized) and
 * extract the raw tx (step 3). Refuses a tx whose input0 witness does not
 * carry a within-limits envelope. → { rawHex, txid, vsize, envelope }
 */
export function finalizeReveal(signedPsbtHex) {
  const tx = btc.Transaction.fromPSBT(hex.decode(signedPsbtHex), PSBT_OPTS);
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    if (!inp.finalScriptWitness && !inp.finalScriptSig) tx.finalizeIdx(i);
  }
  const w = tx.getInput(0).finalScriptWitness;
  const envelope = parseEnvelopeFromWitness(w || []);
  if (!checkEnvelopeLimits(envelope)) throw new Error("reveal: input0 witness carries no valid envelope");
  const raw = tx.extract();
  return { rawHex: hex.encode(raw), txid: tx.id, vsize: tx.vsize, envelope };
}

// ---- recovery record ('lp.avatar.<TICKER>') --------------------------------------------------------

export const AVATAR_RECORD_PREFIX = "lp.avatar.";
export const avatarRecordKey = (ticker) => `${AVATAR_RECORD_PREFIX}${String(ticker).toUpperCase()}`;

const TXID_RE = /^[0-9a-f]{64}$/;

/** Longest base64 text a ≤ 16,384-byte body can need (4 chars per 3 bytes, padded). */
export const MAX_AVATAR_BASE64_LEN = Math.ceil(MAX_AVATAR_BYTES / 3) * 4;
/** Ceiling for a stored commit output value (21 M BTC in sats) — any real UTXO is below it. */
const MAX_COMMIT_SATS = 21_000_000 * 100_000_000;

const posIntOrNull = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);

/**
 * Validate a stored record (JSON-parsed). Malformed or out-of-bounds → null.
 *
 * Bounds (a record is only ever written by this app, so anything outside
 * them is corruption or tampering, not a legitimate state):
 *   * contentType   — the §8.2 allow-list
 *   * bytesBase64   — decodes to 1 … 16,384 bytes (§8.2 body size)
 *   * leafScriptHex — must equal the envelope rebuilt from key + image
 *   * commitAmount  — 546 ≤ n ≤ maxCommitAmountFor(leaf) (fee-cap bound)
 *   * commitSats    — 546 ≤ n ≤ 21 M BTC (the adopted output's real value)
 */
export function parseAvatarRecord(raw) {
  let r = raw;
  if (typeof raw === "string") {
    try {
      r = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!r || typeof r !== "object") return null;
  if (r.kind != null && r.kind !== "deploy") return null;
  if (r.kind === "deploy") {
    try { decodeAddress(r.address); } catch { return null; }
  }
  const ticker = String(r.ticker || "");
  try {
    validateTicker(ticker);
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(String(r.ephemeralPrivHex || ""))) return null;
  if (!/^[0-9a-f]+$/.test(String(r.leafScriptHex || "")) || String(r.leafScriptHex).length % 2 !== 0) return null;
  if (!isAvatarContentType(r.contentType)) return null;
  if (typeof r.bytesBase64 !== "string" || !r.bytesBase64 || r.bytesBase64.length > MAX_AVATAR_BASE64_LEN) return null;
  let bytes;
  try {
    bytes = base64.decode(r.bytesBase64);
  } catch {
    return null;
  }
  if (bytes.length < 1 || bytes.length > MAX_AVATAR_BYTES) return null;
  if (typeof r.commitAddress !== "string" || !r.commitAddress.startsWith("bc1p")) return null;
  const commitAmount = Number(r.commitAmount);
  if (!Number.isInteger(commitAmount) || commitAmount < DUST_SATS) return null;
  const txidOrNull = (v) => (TXID_RE.test(String(v || "").toLowerCase()) ? String(v).toLowerCase() : null);
  const commitSats = Number.isInteger(r.commitSats) && r.commitSats >= DUST_SATS && r.commitSats <= MAX_COMMIT_SATS ? r.commitSats : null;
  const rec = {
    ...(r.kind === "deploy" ? { kind: "deploy", address: r.address } : {}),
    ticker,
    ephemeralPrivHex: String(r.ephemeralPrivHex).toLowerCase(),
    leafScriptHex: String(r.leafScriptHex).toLowerCase(),
    contentType: String(r.contentType).toLowerCase(),
    bytesBase64: r.bytesBase64,
    commitAddress: r.commitAddress,
    commitAmount,
    commitTxid: txidOrNull(r.commitTxid),
    commitVout: Number.isInteger(r.commitVout) ? r.commitVout : null,
    commitSats,
    commitChange: r.commitChange && Number.isInteger(r.commitChange.vout) && Number.isInteger(r.commitChange.sats) ? { vout: r.commitChange.vout, sats: r.commitChange.sats } : null,
    commitInputs: Array.isArray(r.commitInputs) ? r.commitInputs.filter((o) => o && TXID_RE.test(String(o.txid || "")) && Number.isInteger(o.vout)).map((o) => ({ txid: String(o.txid).toLowerCase(), vout: o.vout })) : [],
    commitAttemptedAt: posIntOrNull(r.commitAttemptedAt, 1e13),
    revealTxid: txidOrNull(r.revealTxid),
    revealBroadcastAt: posIntOrNull(r.revealBroadcastAt, 1e13),
    feeRateSatVb: Number.isInteger(r.feeRateSatVb) ? r.feeRateSatVb : null,
    createdAt: Number.isInteger(r.createdAt) ? r.createdAt : Date.now(),
    // Commit outputs paid earlier for this record that were never proven
    // spent (a "Pay commit again" after an unverifiable rejection). They are
    // spendable with the same ephemeral key — see buildSweepPsbt — so the
    // record must outlive the reveal while any of them remains.
    priorCommits: Array.isArray(r.priorCommits)
      ? r.priorCommits
        .filter((o) => o && TXID_RE.test(String(o.txid || "").toLowerCase()) && Number.isInteger(o.vout) && Number.isInteger(o.sats) && o.sats >= DUST_SATS && o.sats <= MAX_COMMIT_SATS)
        .map((o) => ({ txid: String(o.txid).toLowerCase(), vout: o.vout, sats: o.sats }))
      : [],
  };
  // The stored leaf must be the envelope for the stored key + image.
  let leafLen;
  try {
    const rebuilt = buildEnvelopeScript(ephemeralXonly(hex.decode(rec.ephemeralPrivHex)), rec.contentType, bytes);
    if (hex.encode(rebuilt) !== rec.leafScriptHex) return null;
    leafLen = rebuilt.length;
  } catch {
    return null;
  }
  // Upper bound from the verified leaf: more than the fee cap could ever ask for is corrupt.
  if (commitAmount > maxCommitAmountFor(leafLen)) return null;
  if (commitPayment(hex.decode(rec.ephemeralPrivHex), hex.decode(rec.leafScriptHex)).address !== rec.commitAddress) return null;
  if (r.kind === "deploy") {
    const stages = {};
    for (const stage of ["commit", "reveal", "reclaim"]) {
      const rawHex = r[`${stage}RawHex`];
      if (!!rawHex !== !!r[`${stage}Txid`]) return null;
      if (rawHex != null) {
        if (typeof rawHex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(rawHex) || rawHex.length > 100_000) return null;
        try {
          const tx = btc.Transaction.fromRaw(hex.decode(rawHex), PSBT_OPTS);
          if (tx.id !== r[`${stage}Txid`]) return null;
          stages[stage] = tx;
        } catch { return null; }
        rec[`${stage}RawHex`] = rawHex;
      }
    }
    try {
      if (stages.commit) {
        const output = stages.commit.getOutput(rec.commitVout);
        if (rec.commitVout !== 0 || output.amount !== BigInt(rec.commitSats) || rec.commitSats !== rec.commitAmount || hex.encode(output.script) !== hex.encode(decodeAddress(rec.commitAddress).script)) return null;
        const inputs = Array.from({ length: stages.commit.inputsLength }, (_, i) => stages.commit.getInput(i));
        if (rec.commitInputs.length !== inputs.length || inputs.some((input, i) => hex.encode(input.txid) !== rec.commitInputs[i].txid || input.index !== rec.commitInputs[i].vout)) return null;
        if (r.commitChange) {
          const change = stages.commit.getOutput(rec.commitChange?.vout);
          if (rec.commitChange?.vout !== 1 || change.amount !== BigInt(rec.commitChange.sats) || hex.encode(change.script) !== hex.encode(decodeAddress(rec.address).script)) return null;
        }
      }
      for (const stage of ["reveal", "reclaim"]) {
        if (!stages[stage]) continue;
        const input = stages[stage].getInput(0);
        if (!stages.commit || hex.encode(input.txid) !== rec.commitTxid || input.index !== rec.commitVout) return null;
      }
    } catch { return null; }
    rec.reclaimTxid = txidOrNull(r.reclaimTxid);
  }
  return rec;
}

export function serializeAvatarRecord(rec) {
  return JSON.stringify(rec);
}

// ---- record encryption (WebCrypto; pure, tested in Node) -------------------------------------------

/** The fixed message the wallet signs to derive the record key. Never varies per ticker or session. */
export const AVATAR_KEY_DOMAIN = "LuckyProtocol avatar recovery key v1 — signing this derives the key that protects your avatar record in this browser. It is not a transaction and costs nothing.";
export const AVATAR_RECORD_ENC_VERSION = 1;
const HKDF_SALT = ascii("lp.avatar.record.v1");

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error("WebCrypto is not available in this browser");
  return c.subtle;
}

/**
 * Signature text from a provider's `signMessage` → bytes. UniSat / OKX
 * return base64; hex is accepted too.
 */
export function signatureToBytes(sig) {
  const s = String(sig || "").trim();
  if (!s) throw new Error("empty signature");
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0 && s.length >= 128) return hex.decode(s.toLowerCase());
  return base64.decode(s);
}

/**
 * AES-GCM-256 record key from the wallet's signature of AVATAR_KEY_DOMAIN:
 * HKDF-SHA256(ikm = signature bytes, salt = "lp.avatar.record.v1", info = address).
 * Non-extractable; lives in memory only.
 */
export async function deriveRecordKey(signatureBytes, address) {
  if (!(signatureBytes instanceof Uint8Array) || signatureBytes.length < 32) throw new Error("record key: signature must be at least 32 bytes");
  if (typeof address !== "string" || !address) throw new Error("record key: address is required");
  const s = subtle();
  const ikm = await s.importKey("raw", signatureBytes, "HKDF", false, ["deriveKey"]);
  return s.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: ascii(address) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** True when a stored string is an encrypted record blob (as opposed to a legacy plaintext record). */
export function isEncryptedRecord(raw) {
  if (typeof raw !== "string") return false;
  try {
    const b = JSON.parse(raw);
    return !!b && typeof b === "object" && b.v === AVATAR_RECORD_ENC_VERSION && b.enc === "aes-gcm" && typeof b.iv === "string" && typeof b.ct === "string";
  } catch {
    return false;
  }
}

/** → the JSON blob string to store. */
export async function encryptAvatarRecord(rec, key) {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const plain = ascii(serializeAvatarRecord(rec));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, plain));
  return JSON.stringify({ v: AVATAR_RECORD_ENC_VERSION, enc: "aes-gcm", ticker: String(rec.ticker).toUpperCase(), iv: base64.encode(iv), ct: base64.encode(ct) });
}

/**
 * Decrypt a blob and parse the record. → `{ status: 'ok', record }`,
 * `{ status: 'wrong-key' }` (AES-GCM authentication failed: another wallet
 * account, or a tampered blob) or `{ status: 'corrupt' }` (decrypted but
 * fails parseAvatarRecord's bounds).
 */
export async function decryptAvatarRecord(raw, key) {
  let b;
  try {
    b = JSON.parse(raw);
  } catch {
    return { status: "corrupt", record: null };
  }
  if (!isEncryptedRecord(raw)) return { status: "corrupt", record: null };
  let plain;
  try {
    plain = await subtle().decrypt({ name: "AES-GCM", iv: base64.decode(b.iv) }, key, base64.decode(b.ct));
  } catch {
    return { status: "wrong-key", record: null };
  }
  const record = parseAvatarRecord(new TextDecoder().decode(new Uint8Array(plain)));
  return record ? { status: "ok", record } : { status: "corrupt", record: null };
}

function storage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
export function readAvatarRecord(ticker) {
  return loadAvatarRecord(ticker).record;
}
/**
 * Like readAvatarRecord but tells "nothing stored" apart from "stored but
 * unusable": → `{ status: 'absent' | 'ok' | 'encrypted' | 'corrupt', record, raw }`.
 * 'encrypted' means a blob is present and needs the wallet-derived key
 * (unlockAvatarRecord). A corrupt record must be surfaced (it may still be
 * the only copy of a funded key's bytes — the user decides to discard it),
 * never silently ignored. 'ok' is a legacy plaintext record.
 */
export function loadAvatarRecord(ticker) {
  const s = storage();
  if (!s) return { status: "absent", record: null, raw: null };
  let raw = null;
  try {
    raw = s.getItem(avatarRecordKey(ticker));
  } catch {
    return { status: "absent", record: null, raw: null };
  }
  if (raw === null || raw === undefined) return { status: "absent", record: null, raw: null };
  if (isEncryptedRecord(raw)) return { status: "encrypted", record: null, raw };
  let record = null;
  try {
    record = parseAvatarRecord(raw);
  } catch {
    record = null;
  }
  return record ? { status: "ok", record, raw } : { status: "corrupt", record: null, raw };
}
/** Decrypt the stored blob for `ticker` with `key` → `{ status: 'absent'|'ok'|'wrong-key'|'corrupt', record }`. */
export async function unlockAvatarRecord(ticker, key) {
  const l = loadAvatarRecord(ticker);
  if (l.status !== "encrypted") return { status: l.status, record: l.record };
  return decryptAvatarRecord(l.raw, key);
}
/**
 * Persist a record: encrypted under `key` when one is given, plaintext
 * otherwise (mock provider / legacy record only). → Promise<boolean>.
 */
export async function writeAvatarRecord(rec, key = null) {
  const s = storage();
  if (!s) return false;
  try {
    const text = key ? await encryptAvatarRecord(rec, key) : serializeAvatarRecord(rec);
    s.setItem(avatarRecordKey(rec.ticker), text);
    return true;
  } catch {
    return false;
  }
}
export function clearAvatarRecord(ticker) {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(avatarRecordKey(ticker));
  } catch {
    /* ignore */
  }
}

export const deployRecordKey = (ticker) => `lp.deploy.${validateTicker(ticker)}`;

export function savedDeployTickers() {
  try {
    const s = storage();
    const tickers = [];
    for (let i = 0; i < (s?.length || 0); i++) {
      const match = /^lp\.deploy\.([A-Z0-9]{1,8})$/.exec(s.key(i));
      if (match) tickers.push(match[1]);
    }
    return tickers.sort();
  } catch { return []; }
}

export function loadDeployRecord(ticker) {
  let raw;
  try { raw = storage()?.getItem(deployRecordKey(ticker)); } catch { return { status: "corrupt" }; }
  if (!raw) return { status: "absent" };
  if (isEncryptedRecord(raw)) return { status: "encrypted", raw };
  const record = parseAvatarRecord(raw);
  return record?.kind === "deploy" && record.ticker === ticker ? { status: "ok", record } : { status: "corrupt" };
}

export async function unlockDeployRecord(ticker, key) {
  const stored = loadDeployRecord(ticker);
  const result = stored.status === "encrypted" ? await decryptAvatarRecord(stored.raw, key) : stored;
  if (result.status === "ok" && (result.record.kind !== "deploy" || result.record.ticker !== ticker)) return { status: "corrupt" };
  return result;
}

export async function writeDeployRecord(record, key) {
  if (record.kind !== "deploy" || !parseAvatarRecord(record)) throw new Error("Invalid creation recovery record");
  const s = storage();
  if (!s) throw new Error("Browser storage is unavailable; creation stopped before the next payment.");
  const raw = key ? await encryptAvatarRecord(record, key) : serializeAvatarRecord(record);
  s.setItem(deployRecordKey(record.ticker), raw);
  if (s.getItem(deployRecordKey(record.ticker)) !== raw) throw new Error("Recovery record could not be saved");
}

export function clearDeployRecord(ticker) {
  storage()?.removeItem(deployRecordKey(ticker));
}

/** `data:<ct>;base64,…` for a preview or the mock's avatar URL. */
export function bytesToDataUrl(bytes, contentType) {
  return `data:${contentType};base64,${base64.encode(bytes)}`;
}

// ---- abandoned-commit sweep (§8.5 key path) --------------------------------------------------------
//
// The commit output is P2TR with internal key == the ephemeral key (§8.5),
// so it can be spent on the KEY PATH — a 64-byte signature with the
// merkle-root tweak — without revealing the envelope. That is the only way
// to recover a commit that was paid but never revealed: the commit funds
// exactly its own envelope's weight once, so a script-path spend that
// carried the leaf again would cost more than the output holds.

/** vB of a sweep: overhead + one key-path P2TR input + one address output. */
export function sweepVsize(toAddress) {
  return VSIZE_TX_OVERHEAD + inputVsize("tr") + outputVsize(toAddress);
}

/**
 * Unsigned sweep of one commit output back to `toAddress` (the deployer):
 * input0 = the commit (key-path fields only: tapInternalKey +
 * tapMerkleRoot, NO tapLeafScript), vout0 = commit sats − fee. No
 * OP_RETURN — a plain spend the indexer ignores (the commit carries no
 * tokens). Throws when the output would be sub-dust at this fee rate.
 * → { psbtHex, feeSats, outSats, vsize, feeRateSatVb }
 */
export function buildSweepPsbt({ commit, ephemeralPriv, leafScript, toAddress, feeRateSatVb }) {
  if (!commit || typeof commit.txid !== "string" || !TXID_RE.test(commit.txid.toLowerCase()) || !Number.isInteger(commit.vout) || !Number.isInteger(Number(commit.sats)) || Number(commit.sats) < DUST_SATS) {
    throw new Error("sweep: commit outpoint { txid, vout, sats } is required");
  }
  decodeAddress(toAddress);
  const pay = commitPayment(ephemeralPriv, leafScript);
  const rate = checkedFeeRate(feeRateSatVb);
  const sats = Number(commit.sats);
  const vsize = sweepVsize(toAddress);
  const feeSats = Math.ceil(vsize * rate);
  const outSats = sats - feeSats;
  if (outSats < DUST_SATS) {
    throw new Error(
      `sweep: the commit output (${sats.toLocaleString("en-US")} sats) cannot pay a ${feeSats.toLocaleString("en-US")}-sat fee ` +
      `and still leave ≥ ${DUST_SATS} sats — lower the fee rate or leave it`,
    );
  }
  const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: false });
  tx.addInput({
    txid: commit.txid.toLowerCase(),
    index: commit.vout,
    witnessUtxo: { script: pay.script, amount: BigInt(sats) },
    tapInternalKey: pay.tapInternalKey,
    tapMerkleRoot: pay.tapMerkleRoot,
  });
  tx.addOutputAddress(toAddress, BigInt(outSats), NETWORK);
  return { psbtHex: hex.encode(tx.toPSBT()), feeSats, outSats, vsize: Math.ceil(vsize), feeRateSatVb: rate, commitAddress: pay.address };
}

/**
 * Key-path-sign input0 of a sweep with the ephemeral key, finalize and
 * extract. Asserts the witness is a single 64-byte Schnorr signature (a
 * key-path spend — the envelope stays private). → { rawHex, txid }
 */
export function signSweep(psbtHex, ephemeralPriv) {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), PSBT_OPTS);
  if (tx.inputsLength !== 1 || tx.outputsLength !== 1) throw new Error("sweep: expected exactly one input and one output");
  const in0 = tx.getInput(0);
  if (in0.finalScriptWitness) throw new Error("sweep: input0 is already finalized");
  if (in0.tapLeafScript && in0.tapLeafScript.length) throw new Error("sweep: input0 must not carry tapLeafScript (key path only)");
  if (isOpReturnScript(tx.getOutput(0).script)) throw new Error("sweep: output must be an address, not OP_RETURN");
  tx.signIdx(ephemeralPriv, 0);
  tx.finalizeIdx(0);
  const w = tx.getInput(0).finalScriptWitness;
  if (!w || w.length !== 1 || w[0].length !== 64) throw new Error("sweep: input0 did not finalize as a key-path spend");
  return { rawHex: hex.encode(tx.extract()), txid: tx.id };
}

/**
 * What a `/btc-utxos/:commitAddress` listing plus `/tx-status/:commitTxid`
 * say about a commit output after the node refused the reveal for an
 * input reason (audit M-7):
 *   'listed'     — the outpoint is listed unspent: the commit is fine, a WALLET input was stale
 *   'spent'      — the listing succeeded, lacks the outpoint, AND the commit tx is confirmed
 *                  (the block-apply pass saw it spent)
 *   'unverified' — anything else: the listing failed (503 / network), or it succeeded but
 *                  the commit is not confirmed, so "not listed" means only "not seen yet"
 *                  (an unconfirmed commit is invisible to the confirmed-UTXO listing)
 */
export function classifyCommitState({ listingOk, listed, commitStatus }) {
  if (listingOk && listed) return "listed";
  if (listingOk && !listed && commitStatus && commitStatus.confirmed === true) return "spent";
  return "unverified";
}

// ---- recovery decisions (pure; used by useAvatar, tested in test/inscribe.test.js) -----------------

/**
 * Duplicate-commit guard: given `/btc-utxos/:commitAddress` rows, pick an
 * output that can serve as the commit — `sats ≥ commitAmount`, confirmed or
 * not. Preference: confirmed first, then the least over-funded, then
 * txid:vout for determinism. `excludeKeys` drops outpoints already known to
 * be spent. → `{ txid, vout, sats, confirmed }` | null.
 */
export function adoptExistingCommit(rows, commitAmount, { excludeKeys = [] } = {}) {
  const amount = Number(commitAmount);
  if (!Number.isInteger(amount) || amount < DUST_SATS) return null;
  const exclude = new Set(excludeKeys);
  const ok = (rows || []).filter((u) => u && TXID_RE.test(String(u.txid || "")) && Number.isInteger(u.vout) && Number.isInteger(u.sats) && u.sats >= amount && !exclude.has(`${u.txid}:${u.vout}`));
  if (ok.length === 0) return null;
  ok.sort((a, b) => {
    const ca = a.confirmed !== false ? 0 : 1;
    const cb = b.confirmed !== false ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if (a.sats !== b.sats) return a.sats - b.sats;
    if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
    return a.vout - b.vout;
  });
  const u = ok[0];
  return { txid: String(u.txid).toLowerCase(), vout: u.vout, sats: u.sats, confirmed: u.confirmed !== false };
}

/**
 * What a node's rejection of a broadcast means for the reveal:
 *   'already-known'    — this exact tx is already in the mempool / a block: success, same txid
 *   'mempool-conflict' — another unconfirmed tx spends one of our inputs (an earlier reveal, or a
 *                        stale wallet input)
 *   'missing-or-spent' — an input is not in the UTXO set: the commit was spent (or never landed),
 *                        or a wallet input is stale
 *   'other'            — fee / policy / transport problem; retryable as-is
 * Reads the message only, so it works for the wallet's "pushTx · indexer relay" combined errors.
 */
export function classifyNodeRejection(e) {
  const m = String(e?.message || e || "");
  if (/txn-already-in-mempool|txn-already-known|already in block chain|already.?in.?(the )?mempool|already known|transaction already exists/i.test(m)) return "already-known";
  if (/txn-mempool-conflict|mempool-conflict|insufficient fee, rejecting replacement|replacement|\bconflict/i.test(m)) return "mempool-conflict";
  if (/missingorspent|bad-txns-inputs|missing.?inputs|already.?spent|double.?spend|input.{0,20}\bspent|\bspent.{0,20}input/i.test(m)) return "missing-or-spent";
  return "other";
}

export const REVEAL_REBUILD_AFTER_MS = 30 * 60_000;
export const REVEAL_UNSEEN_GRACE_MS = 2 * 60_000;

/**
 * When the "Rebuild reveal" action is offered for a pending reveal:
 *   'stale'  — broadcast (or last rebuild attempt) more than 30 minutes ago, whatever tx-status says
 *   'unseen' — tx-status has never seen the txid AND the commit output is still listed unspent,
 *              once a short grace period (indexer lag right after broadcast) has passed
 *   null     — keep waiting
 * `broadcastAt` null/unknown (a record from before this field existed) counts as stale.
 */
export function revealRebuildReason({ now = Date.now(), broadcastAt, seen, commitUnspent }) {
  const age = Number.isInteger(broadcastAt) ? now - broadcastAt : Infinity;
  if (age > REVEAL_REBUILD_AFTER_MS) return "stale";
  if (seen === false && commitUnspent === true && age > REVEAL_UNSEEN_GRACE_MS) return "unseen";
  return null;
}

/** True for the indexer's 503 "scan seeding" answer on the first query of an address. */
export function isSeedingError(e) {
  return !!e && (e.status === 503 || /HTTP 503/.test(String(e.message || "")));
}

/**
 * Run `fn` and retry it (up to `attempts` calls in total, `delayMs` apart)
 * while it fails with a seeding 503; any other error is thrown at once.
 * `onRetry(attemptNumber)` fires before each wait.
 */
export async function retryOn503(fn, { attempts = 3, delayMs = 2_000, onRetry, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      if (!isSeedingError(e) || i === attempts) throw e;
      last = e;
      if (onRetry) onRetry(i);
      await wait(delayMs);
    }
  }
  throw last;
}

// ---- browser-only: image compression (§8.5 step 1) --------------------------------------------------

const DECODABLE_RE = /^image\/(png|jpe?g|webp|gif|bmp|avif)$/i;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("The file could not be decoded as an image."));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawCoverSquare(source, side) {
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  if (!sw || !sh) throw new Error("The image has no pixels.");
  const s = Math.min(sw, sh);
  const sx = Math.floor((sw - s) / 2);
  const sy = Math.floor((sh - s) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, s, s, 0, 0, side, side);
  return canvas;
}

function encodeCanvas(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Decode → cover-crop to a square → 256×256 → WebP, lowering quality from
 * 0.85 in 0.1 steps until ≤ 10,240 bytes. Browsers that cannot encode WebP
 * (toBlob answers with a PNG) fall back to PNG, also at 192 and 128 px.
 * Anything that cannot get ≤ 16,384 bytes is refused. SVG and non-images
 * are rejected up front.
 *
 * → { bytes, contentType, width, height, quality }
 */
export async function compressAvatar(file) {
  if (!file || typeof file !== "object" || typeof file.size !== "number") throw new Error("Pick an image file.");
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "");
  if (type === "image/svg+xml" || /\.svg$/i.test(name)) throw new Error("SVG is not supported — use a PNG, JPEG, WebP or GIF.");
  if (!DECODABLE_RE.test(type)) throw new Error("Not a supported image. Use a PNG, JPEG, WebP or GIF.");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("That file is larger than 40 MB — pick a smaller image.");
  if (typeof document === "undefined") throw new Error("Image compression needs a browser.");

  const source = await decodeImage(file);
  try {
    let fallback = null; // smallest ≤ MAX seen, in case nothing hits the target
    const consider = (out) => {
      if (out.bytes.length <= MAX_AVATAR_BYTES && (!fallback || out.bytes.length < fallback.bytes.length)) fallback = out;
      return out.bytes.length <= TARGET_AVATAR_BYTES;
    };

    // WebP at 256 px, quality 0.85 → 0.15.
    const canvas256 = drawCoverSquare(source, AVATAR_SIDE_PX);
    let webpSupported = true;
    for (let q = 0.85; q >= 0.15; q -= 0.1) {
      const quality = Number(q.toFixed(2));
      const blob = await encodeCanvas(canvas256, "image/webp", quality);
      if (!blob || blob.type !== "image/webp") {
        webpSupported = false;
        break;
      }
      const out = { bytes: await blobBytes(blob), contentType: "image/webp", width: AVATAR_SIDE_PX, height: AVATAR_SIDE_PX, quality };
      if (consider(out)) return out;
    }

    // No WebP encoder (or none of the WebP attempts fit at all): PNG at 256 / 192 / 128 px.
    if (!webpSupported || !fallback) {
      for (const side of [AVATAR_SIDE_PX, 192, 128]) {
        const canvas = side === AVATAR_SIDE_PX ? canvas256 : drawCoverSquare(source, side);
        const blob = await encodeCanvas(canvas, "image/png");
        if (!blob || blob.type !== "image/png") continue;
        const out = { bytes: await blobBytes(blob), contentType: "image/png", width: side, height: side, quality: null };
        if (consider(out)) return out;
      }
    }
    if (fallback) return fallback;
    throw new Error(`Could not get the image under ${MAX_AVATAR_BYTES.toLocaleString("en-US")} bytes — try a simpler image with fewer colors or less detail.`);
  } finally {
    if (typeof source.close === "function") source.close();
  }
}
