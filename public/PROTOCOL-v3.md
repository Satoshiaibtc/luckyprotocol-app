# LuckyProtocol Protocol — v3 / **LUCKY-20** (cohort `genesis-v3`)

Canonical wire spec for **LuckyProtocol**, the v3 successor to LUCKYPROTOCOL v2.
Both the Rust indexer (branch `v3`) and the web app
(`luckyprotocol-app`) implement exactly this document. Where code and spec
disagree, the spec wins.

## 0. What changed from v2 (and why)

v2 was a casino: a MINE tx carried a tier + a player pick, and settlement
compared the pick to the confirming block hash. v3 **removes the pick
entirely**. A MINE tx carries no player choice; its yield is a pure,
public, deterministic function of the confirming block's hash. Every valid
MINE yields something. There is no lose state and nothing to wager on —
it is a fair mint with variable yield (the same kind of variance real
mining has). This is a mechanical change, not a cosmetic one.

Everything else that made v2 a sound UTXO token protocol is kept: tokens
are bound to UTXOs, strict-burn on raw spends, residual routing by vout
index, consensus-enforced protocol fee outputs, fixed 21M supply.

## 1. Constants

| Name | Value | Notes |
|---|---|---|
| `PROTOCOL_PREFIX` | `LUCKY-20` | The standard's name, field 0 of every payload (cf. brc-20's `p`). Distinct from v2's `LUCKYPROTOCOL`, so v2 history can never parse as LUCKY-20; the activation-height gate applies on top. |
| `ACTIVATION_HEIGHT` | **968_750** | FINAL (set 2026-09-25 at tip 968,539). Txs in earlier blocks are ignored. |
| `SNAPSHOT_VERSION` | 13 | Fresh state; v2 snapshots are refused. (12 = v3 before §7 trading; never deployed.) |
| `REQUIRED_TOKEN_SUPPLY` | 21_000_000 | Implicit on every DEPLOY, not user-settable. |
| `DUST_SATS` | 546 | Token-carrier output value. |
| `PROJECT_FEE_ADDRESS` | `bc1pyefhtnuz2gw04fsynlsseeh847cqy20dw7yt6fnavm9fgnewcr7q88gqf3` | Same as v2. |
| `DEPLOY_PROTOCOL_FEE_SATS` | 5_460 | Exact-amount output required on DEPLOY. |
| `MINE_PROTOCOL_FEE_SATS` | 546 | Exact-amount output required on MINE. |
| `SEND_PROTOCOL_FEE_SATS` | 546 | Exact-amount output required on SEND. |
| `MAX_OUT_IDX` | 255 | |
| Ticker grammar | `[A-Z0-9]{1,8}` | First-write-wins per ticker. |

## 2. Payload encoding

One OP_RETURN output per protocol tx. ASCII, `|`-separated, ≤ 80 bytes.
Field 0 is always `LUCKY-20`. Any parse failure = not a protocol tx (the
tx is then treated as a plain BTC spend → strict-burn applies to any
token inputs).

### 2.1 DEPLOY — `LUCKY-20|DEPLOY|<TICKER>`

Registers `<TICKER>` with supply 21,000,000. Ignored (recorded as
`applied:false`) if the ticker already exists.

Consensus fee rule: the tx MUST have at least one output paying **exactly
5,460 sats** to `PROJECT_FEE_ADDRESS`.

Reference layout: `vout0` 546 → deployer (proof), `vout1` 5,460 → fee,
`vout2` OP_RETURN, `vout3+` change.

### 2.2 MINE — `LUCKY-20|MINE|<TICKER>`

`win_out_idx = 0` and `change_out_idx = 0` are **implicit** (not
encoded). The yield is credited to `vout0`; any residual token input pool
also routes to `vout0`.

Consensus fee rule: at least one output paying **exactly 546 sats** to
`PROJECT_FEE_ADDRESS`.

Validity: ticker must be deployed at apply time; `vout0` must exist and
must not be an OP_RETURN. Invalid → recorded with `status:"invalid"`,
yield 0, no state change (token inputs still route/burn per §4).

Reference layout: `vout0` 546 → miner (yield slot), `vout1` 546 → fee,
`vout2` OP_RETURN, `vout3+` change.

### 2.3 SEND — `LUCKY-20|SEND|<TICKER>|<AMT>|<TO_OUT>|<CHANGE_OUT>`

Unchanged from v2. `AMT` is a canonical unsigned integer (whole tokens,
1 ≤ AMT ≤ 21,000,000); `TO_OUT` and `CHANGE_OUT` are decimal `[0..255]`
and MUST differ (equal indices do not parse). Moves `AMT` from the tx's
input pool to `vout[TO_OUT]`; residual pool → `vout[CHANGE_OUT]`. If the pool holds
< AMT, the SEND is `applied:false` and the whole pool routes to
`CHANGE_OUT`. Fee rule: exactly 546 sats to `PROJECT_FEE_ADDRESS`.

Reference layout: `vout0` 546 → recipient, `vout1` 546 → fee, `vout2`
OP_RETURN, `vout3` change (residual). **`vout3` must exist** — a builder
must never drop it as sub-dust.

## 3. Yield function (the settlement rule)

```
yield(block_hash) :=
  let d = last hex char of lowercase(block_hash)
  d == 'f'        → 1000   (1 of 16)
  d in 'c'..='e'  → 500    (3 of 16)
  d in '7'..='b'  → 200    (5 of 16)
  d in '0'..='6'  → 100    (7 of 16)
```

`block_hash` is the hash of the block that **confirms the MINE tx**.
Credit = `min(yield, remaining_supply)`; when remaining supply is 0 the
MINE records `cap_exhausted:true` and credits 0.

The probabilities climb in a 1 / 3 / 5 / 7 staircase as the tier drops
(6.25% / 18.75% / 31.25% / 43.75%). Expected yield per MINE =
(1000 + 3·500 + 5·200 + 7·100) / 16 = **262.5**; 21,000,000 / 262.5 =
**80,000** MINEs exhaust a ticker exactly. Every tier and the
supply are multiples of 100, so the MINE that crosses the cap is credited a
multiple of 100 (`min(tier, remaining)`); later MINEs in that block credit 0.

Golden vectors (shared byte-identical by indexer and web; both test
suites assert them):

| last hex char | yield |
|---|---|
| `0` `6` | 100 |
| `7` `b` | 200 |
| `c` `e` | 500 |
| `f` | 1000 |
| `F` (uppercase input) | 1000 |

## 4. Token routing rules (unchanged from v2)

1. **Input pool**: for every tx (protocol or not), tokens on spent
   token-bearing UTXOs are gathered into a per-ticker input pool.
2. **Protocol tx**: MINE routes pool + yield to `vout0`; SEND routes per
   §2.3; DEPLOY has no routing (pool burns — a builder must never fund a
   DEPLOY with token UTXOs).
3. **Strict-burn**: pool tokens not routed by a valid rule are destroyed.
   A non-protocol tx that spends a token UTXO burns those tokens.
4. Tokens can never be assigned to an OP_RETURN output.

Builder obligation (web): **never select a token-bearing UTXO as a fee
input**. Practical rule: exclude every UTXO with value ≤ 546 sats (all
LuckyProtocol token carriers are 546-sat outputs; this also shields most
inscription UTXOs) AND exclude every outpoint the indexer's
`/utxos/:addr` reports as token-bearing.

## 5. Indexer HTTP API (v3)

All JSON. CORS open. Base: the operator's indexer origin.

| Route | Returns |
|---|---|
| `GET /` (alias `GET /health`) | `{ network, indexed_height, tip_height, token_count, mine_count, last_progress_at, stalled, ... }` |
| `GET /balances/:addr` | `{ address, balances: { TICKER: amount } }` |
| `GET /utxos/:addr` | `{ address, utxos: [{ txid, vout, balances: {TICKER: amt} }] }` (token UTXOs only) |
| `GET /btc-utxos/:addr` | `{ address, scanned_at_height, utxos: [{ txid, vout, sats, confirmed, block_height }] }` — first query 503 while seeding; includes pending mempool outputs with `confirmed:false` |
| `GET /mines/:addr` | `{ address, mines: [MineView] }` (sender == addr, newest first) |
| `GET /mines?limit&offset&ticker` | `{ total, offset, limit, items: [MineView] }` global feed |
| `GET /mines/by-txid/:txid` | `MineView` or 404 |
| `GET /tokens?limit&offset` | `{ total, offset, limit, items: [{ ticker, supply, minted, deployer, deploy_txid, deploy_block, avatar_txid, avatar_content_type, … }] }` |
| `GET /tokens/:ticker` | one registry entry (+ `holders` count) |
| `GET /tokens/:ticker/holders?limit&offset` | `{ ticker, total, limit, offset, holders: [{ address, balance }] }` |
| `GET /transfers/:addr` | `{ address, transfers: [TransferView] }` |
| `GET /tx-status/:txid` | `{ txid, confirmed, block_height, block_hash, block_time }` (`confirmed:false` when unknown) |
| `GET /block-info/:height` | `{ height, hash, time }` |
| `GET /blocks/recent?limit` | `{ tip_height, blocks: [{ height, hash }] }` — last N (≤ 32, default 16) block hashes newest first; feeds the yield-digit history board |
| `GET /fees` | `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee }` sat/vB |
| `POST /broadcast` | body = raw tx hex (text/plain) → txid text; 400 + reason on node rejection |
| `POST /orders` | JSON `{ psbt, ticker, amount, price_sats }` → `OrderView` (201) — see §7.4 |
| `GET /orders?ticker&status&limit&offset` | `{ total, offset, limit, items: [OrderView] }` — open orders sorted by unit price asc; `psbt` omitted |
| `GET /orders/:id` | `OrderView` incl. `psbt` (id = `txid:vout` of the listed UTXO) or 404 |
| `GET /orders/by-address/:addr` | `{ address, orders: [OrderView] }` — every status, newest first, `psbt` omitted |
| `GET /trades?ticker&limit&offset` | `{ total, offset, limit, items: [TradeView] }` newest first |
| `GET /trades/:addr` | `{ address, trades: [TradeView] }` where addr is buyer or seller |

`/tokens` items (and `/tokens/:ticker`) additionally carry per-ticker stats:
`mine_count`, `trade_count`, `volume_sats` (lifetime BTC volume of fills),
`open_orders`, `floor_unit_price` (lowest open ask in sats per whole token,
float, `null` when no asks) and `last_trade` (`TradeView` or `null`).

`MineView`:

```json
{ "txid": "...", "block_height": 969600, "block_hash": "...", "sender": "bc1...",
  "ticker": "LUCKY", "status": "settled" | "invalid",
  "yield_smallest": 100, "cap_exhausted": false }
```

## 6. Web wallet contract (UniSat, OKX Wallet)

The web app holds no keys. It builds an unsigned PSBT and hands it to the
connected wallet's `signPsbt`, then `pushPsbt`/`pushTx`. Supported
providers: `window.unisat` (UniSat extension and the UniSat app's
browser) and `window.okxwallet.bitcoin` (OKX Wallet extension and the OKX
app's DApp browser; UniSat-compatible API — `connect()` returns
`{ address, publicKey }`, `pushTx` takes a raw hex string). Inputs come
from `unisat.getBitcoinUtxos()` when available (UniSat's own asset-safe
UTXO list), else the indexer's `/btc-utxos/:addr` confirmed set — OKX
Wallet exposes no asset-safe list, so the app warns OKX users to use an
address that holds no Ordinals/Runes. In every case inputs are filtered
by the builder obligation in §4. For P2TR (bc1p) inputs
the PSBT must carry `tapInternalKey` (x-only form of `unisat.getPublicKey()`);
for P2WPKH (bc1q) a `witnessUtxo` suffices. The fee output and dust
outputs are exact amounts from §1; the change output is appended last
and must be ≥ 546 sats or the build must fail (never silently dropped
for SEND).

## 7. Trading — off-chain order book, on-chain atomic settlement

Bitcoin L1 has no bonding curve and no contract that can hold tokens, so
trading is a **partially-signed-transaction swap**: a seller signs a
listing that is only valid if it pays them; a buyer completes it into a
SEND. Nobody — not the indexer, not the site — ever custodies BTC or
tokens. The indexer only stores and serves the signed listings, records
fills it sees on-chain, and derives price history from them. The swap
pattern is the same one Ordinals marketplaces use (`SIGHASH_SINGLE |
SIGHASH_ANYONECANPAY`), applied to a token-bearing UTXO.

### 7.1 Listing = one signed input, one signed output

A listing is a PSBT with **exactly one input and exactly one output**:

- `input0` — the seller's token-bearing UTXO. The listing sells the
  **entire balance** of one ticker on that UTXO (the "whole-UTXO rule");
  a UTXO carrying more than one ticker cannot be listed. To sell a
  partial amount the seller first splits with a SEND-to-self (§2.3,
  `vout0` = 546 sats carrying `AMT`, `vout3` = residual) and lists the
  new `vout0`. The input carries `witnessUtxo` (real script + real value
  — 546 for a fresh carrier, more for a SEND change output), the PSBT
  `sighashType` field = `0x83`, and `tapInternalKey` for P2TR.
- `output0` — `price_sats` to **the same script as `input0`** (the seller
  pays themself). `price_sats ≥ 546`.

The seller signs `input0` with **`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`
(0x83)** and does NOT finalize (UniSat: `signPsbt(hex, { autoFinalized:
false, toSignInputs: [{ index: 0, address, sighashTypes: [0x83] }] })`).
That signature commits to `input0` and `output0` only, so any number of
inputs/outputs may be appended without invalidating it — but the seller
can only ever lose the UTXO in a tx that pays `output0` in full.
`nLockTime` is committed too: listings and fills use locktime 0.

Unit price = `price_sats / amount` (sats per whole token). `price_sats`
is the total for the whole listing.

### 7.2 Fill = the listing completed into a SEND

The buyer appends inputs `1..n` (their BTC, filtered per §4) and the
outputs that make the tx a valid SEND:

| vout | value | to | note |
|---|---|---|---|
| 0 | `price_sats` | seller | from the listing, untouched |
| 1 | 546 | buyer | token slot |
| 2 | 546 | `PROJECT_FEE_ADDRESS` | SEND consensus fee |
| 3 | 0 | OP_RETURN `LUCKYPROTOCOL\|SEND\|<TICKER>\|<AMT>\|1\|4` | `TO_OUT = 1`, `CHANGE_OUT = 4` |
| 4 | change | buyer | **mandatory, ≥ 546 sats** — same rule as §2.3's `vout3`: the build must fail rather than fold it into the fee |

`CHANGE_OUT` must differ from `TO_OUT` (§2.3 grammar), so the buyer's
change output doubles as the residual slot: any residual of the input
pool routes to the buyer at `vout4`. The buyer
signs inputs `1..n` (UniSat, `autoFinalized: true`), then the app
finalizes `input0` from the seller's signature, extracts the raw tx and
broadcasts it. If two buyers race, exactly one tx confirms; the other is
rejected by the mempool as a double-spend and that buyer loses nothing.

**Buyer-side verification (mandatory, client-side, before signing):**
1. the listing PSBT has exactly 1 input + 1 output;
2. `input0.sighashType == 0x83` and a signature is present
   (`tapKeySig` for P2TR, `partialSig` for P2WPKH);
3. `GET /orders/:id` is still `open` and `GET /utxos/:seller` still
   lists the outpoint with `{ TICKER: amount }`;
4. `output0.value == price_sats` and `output0.script == input0.script`;
5. `witnessUtxo.amount == carrier_sats` reported by the indexer.

### 7.3 Cancel = spend the UTXO

A signed listing is a bearer instrument: anyone who saved the PSBT can
still fill it, so an off-chain "cancel" is meaningless. The only real
cancel is to **move the tokens on-chain** (a SEND-to-self of that UTXO,
§2.3). Re-listing the same outpoint at a new price replaces the order in
the book but does NOT invalidate the earlier signed PSBT; the UI must say
so. The indexer records whatever actually confirms (§7.5).

### 7.4 Indexer order book

`POST /orders` body `{ psbt: <hex>, ticker, amount, price_sats }`. The
indexer accepts the listing only if ALL of the following hold, else 400
(or 409 when the outpoint is spent / has a pending spend):

- PSBT decodes; exactly 1 input, 1 output; `nLockTime == 0`;
- `input0` outpoint is in `utxo_balances` with balances exactly
  `{ ticker: amount }` (single ticker, whole balance);
- `gettxout(txid, vout)` (mempool-aware) returns the output; its value
  and scriptPubKey equal the PSBT's `witnessUtxo`;
- `output0.script == witnessUtxo.script` and `output0.value ==
  price_sats ≥ 546`; `price_sats ≤ 21e14`; `1 ≤ amount ≤ 21_000_000`;
- `input0.sighashType == 0x83`, and the signature **verifies** against
  the prevout: P2TR key-path → Schnorr over
  `taproot_key_spend_signature_hash(0, Prevouts::One, SinglePlusAnyoneCanPay)`
  with the witness-program x-only key; P2WPKH → ECDSA over
  `p2wpkh_signature_hash(..., SinglePlusAnyoneCanPay)` with the
  `partial_sigs` key whose hash160 is the witness program. Other script
  types are rejected;
- per-address open-order cap 50, global cap 10,000 (oldest closed orders
  evicted first).

Order identity is the outpoint (`id = "txid:vout"`); a re-POST for an
open outpoint replaces it (`replaced: true` in the response). Orders are
runtime data persisted to `orders.json` next to the snapshot (atomic
write on every change) — they are NOT part of the chain-derived snapshot.

`OrderView`:

```json
{ "id": "txid:vout", "ticker": "LUCKY", "amount": 1200, "price_sats": 60000,
  "unit_price": 50.0, "seller": "bc1p...", "carrier_sats": 546,
  "status": "open" | "filled" | "cancelled",
  "created_at": 1790000000, "updated_at": 1790000000,
  "spent_txid": null | "…", "spent_block": null | 969700,
  "buyer": null | "bc1q...", "psbt": "…hex… (only on GET /orders/:id)" }
```

### 7.5 Fill detection and trade history

In `apply_tx`, after the payload is applied, every spent outpoint that
matches an order is settled:

- the tx is a SEND for the order's ticker with `applied == true`, its
  `vout0` pays **≥ `price_sats`** to the seller's script, and `TO_OUT`
  routes to a non-OP_RETURN vout → order `filled`; a `TradeView` is
  recorded with `price_sats` = the actual `vout0` value and `buyer` =
  the address of `vout[TO_OUT]`;
- any other spend → order `cancelled` (`spent_txid` set).

`TradeView` (chain-derived; lives in the snapshot and is rolled back with
it on reorg):

```json
{ "txid": "…", "block_height": 969700, "block_hash": "…", "block_time": 1790000000,
  "ticker": "LUCKY", "amount": 1200, "price_sats": 60000, "unit_price": 50.0,
  "seller": "bc1p...", "buyer": "bc1q...", "order_id": "txid:vout" }
```

On `restore_from_snapshot` (reorg or restart) every non-open order whose
outpoint is present again in `utxo_balances` reverts to `open`.

### 7.6 What this is not (trading)

There is no bonding curve, no pooled liquidity, no market maker and no
custody. Prices are whatever sellers ask and buyers pay, settled by the
Bitcoin network. The indexer can hide or lose orders (availability), but
it cannot move anyone's funds (safety).

## 8. Token avatars — `LUCKY-20|AVATAR|<TICKER>` (on-chain image)

A token's avatar is an **Ordinals-style inscription** carried by an AVATAR
tx, so it lives on Bitcoin, is verifiable by any indexer, and shows up in
the deployer's wallet like any other inscription. Nothing is uploaded to
a server.

### 8.1 Payload and layout

Payload: `LUCKY-20|AVATAR|<TICKER>` (exactly three fields; ticker
grammar as §1).

Reference layout (same shape as MINE):

| vout | value | to | note |
|---|---|---|---|
| 0 | 546 | deployer | the inscribed sat lands here |
| 1 | 546 | `PROJECT_FEE_ADDRESS` | consensus fee, exact amount |
| 2 | 0 | OP_RETURN payload | |
| 3+ | change | deployer | optional |

Inputs: `input0` spends a **commit output** — a P2TR output whose script
tree holds the inscription envelope (§8.2); it is spent via the script
path, revealing the image in the witness. The reference client keys that
leaf with a throw-away key generated in the browser, so any wallet can
fund the commit with a plain payment and the app signs the reveal itself.
**At least one other input must be a UTXO controlled by the token's
`deployer` address** — that is the authorization: the wallet signs that
input (key path) and pays the network fee from it.

### 8.2 Envelope

The reveal input's tapscript is the standard ord envelope:

```
OP_FALSE OP_IF
  push "ord"
  push 0x01  push <content-type>
  push 0x00  push <body chunk> [push <body chunk> …]
OP_ENDIF
```

preceded by `<leaf-key> OP_CHECKSIG` (any prefix before `OP_FALSE OP_IF`
is ignored). Body chunks are concatenated. Only the FIRST envelope in
the tx (lowest input index, first envelope in that input's script) is
considered.

Limits (consensus for this protocol, checked by every indexer):

| Rule | Value |
|---|---|
| `content-type` | exactly one of `image/png`, `image/jpeg`, `image/webp`, `image/gif` |
| body size | 1 ≤ bytes ≤ **16,384** |
| reference client target | 256×256, WebP, ≤ 10,240 bytes (client-side compression) |

### 8.3 Validity and effect

An AVATAR tx is **applied** iff: the ticker is deployed; some input's
prevout address equals `tokens[ticker].deployer`; the exact 546-sat
protocol fee output is present; an envelope per §8.2 is found and within
limits; `vout0` exists and is not an OP_RETURN. Otherwise it is recorded
with `applied:false` and changes nothing (token inputs, if any, still
route per §4 — but a builder must never spend token UTXOs in an AVATAR
tx).

Effect: `tokens[ticker].avatar = { content_type, bytes, txid, block_height }`.
**Latest applied AVATAR wins** — the deployer may replace the image. The
avatar is chain-derived state (snapshot; rolled back on reorg). Images are
permanent on-chain; the UI must say so before inscribing.

### 8.4 API

| Route | Returns |
|---|---|
| `GET /tokens/:ticker/avatar` | the image bytes with its `Content-Type`, `ETag: "<txid>"`, `Cache-Control: public, max-age=300`; 404 when the token has no avatar |
| `/tokens` items, `/tokens/:ticker` | gain `avatar_txid` (`string | null`) and `avatar_content_type` |
| `GET /avatars/:addr` | `{ address, avatars: [AvatarView] }` — AVATAR txs sent by this address (audit) |

`AvatarView`: `{ txid, block_height, block_hash, sender, ticker, applied, content_type, bytes_len }`.

### 8.5 Reference client flow (web)

1. Pick an image → canvas resize to 256×256 → encode WebP, lowering
   quality until ≤ 10,240 bytes (reject if it cannot get under 16,384).
2. Generate an ephemeral secp256k1 key in the browser; persist it in
   localStorage until the reveal is confirmed (recovery on reload).
3. Build the commit P2TR address (internal key = ephemeral key, leaf =
   `<ephemeral-xonly> OP_CHECKSIG` + envelope). Ask the wallet to send
   `546 + reveal_fee_share` sats to it (a plain payment).
4. Build the reveal PSBT: `input0` = commit output (script path, signed
   locally with the ephemeral key), `input1` = a deployer UTXO (fee +
   authorization; filtered per §4), outputs per §8.1. Wallet signs
   `input1` only (`toSignInputs: [{ index: 1, address }]`); the app
   finalizes `input0`, extracts and broadcasts.
