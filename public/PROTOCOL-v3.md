# LuckyProtocol Protocol — v3 (cohort `genesis-v3`)

Canonical wire spec for **LuckyProtocol**, the v3 successor to LUCKYPROTOCOL v2.
Both the Rust indexer (branch `v3-luckyprotocol`) and the web app
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
| `PROTOCOL_PREFIX` | `LUCKYPROTOCOL` | Clean on-chain break from v2's `LUCKYPROTOCOL`; v2/v3 indexers are mutually invisible. |
| `ACTIVATION_HEIGHT` | **969_500** | **PLACEHOLDER** — finalize at launch; MUST be > tip at deploy (tip was 968,518 on 2026-09-25). Txs in earlier blocks are ignored. |
| `SNAPSHOT_VERSION` | 12 | Fresh state; v2 snapshots are refused. |
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
Field 0 is always `LUCKYPROTOCOL`. Any parse failure = not a protocol tx (the
tx is then treated as a plain BTC spend → strict-burn applies to any
token inputs).

### 2.1 DEPLOY — `LUCKYPROTOCOL|DEPLOY|<TICKER>`

Registers `<TICKER>` with supply 21,000,000. Ignored (recorded as
`applied:false`) if the ticker already exists.

Consensus fee rule: the tx MUST have at least one output paying **exactly
5,460 sats** to `PROJECT_FEE_ADDRESS`.

Reference layout: `vout0` 546 → deployer (proof), `vout1` 5,460 → fee,
`vout2` OP_RETURN, `vout3+` change.

### 2.2 MINE — `LUCKYPROTOCOL|MINE|<TICKER>`

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

### 2.3 SEND — `LUCKYPROTOCOL|SEND|<TICKER>|<AMT>|<TO_OUT>|<CHANGE_OUT>`

Unchanged from v2. `AMT` is a canonical unsigned integer (whole tokens,
1 ≤ AMT ≤ 21,000,000). Moves `AMT` from the tx's input pool to
`vout[TO_OUT]`; residual pool → `vout[CHANGE_OUT]`. If the pool holds
< AMT, the SEND is `applied:false` and the whole pool routes to
`CHANGE_OUT`. Fee rule: exactly 546 sats to `PROJECT_FEE_ADDRESS`.

Reference layout: `vout0` 546 → recipient, `vout1` 546 → fee, `vout2`
OP_RETURN, `vout3` change (residual). **`vout3` must exist** — a builder
must never drop it as sub-dust.

## 3. Yield function (the settlement rule)

```
yield(block_hash) :=
  let d = last hex char of lowercase(block_hash)
  d == 'f'        → 500
  d in 'a'..='e'  → 100
  d in '0'..='9'  → 21
```

`block_hash` is the hash of the block that **confirms the MINE tx**.
Credit = `min(yield, remaining_supply)`; when remaining supply is 0 the
MINE records `cap_exhausted:true` and credits 0.

Expected yield per MINE = (500 + 5·100 + 10·21) / 16 = **75.625**;
21,000,000 / 75.625 ≈ 277,700 MINEs to exhaust a ticker.

Golden vectors (shared byte-identical by indexer and web; both test
suites assert them):

| last hex char | yield |
|---|---|
| `0` `5` `9` | 21 |
| `a` `e` | 100 |
| `f` | 500 |
| `F` (uppercase input) | 500 |

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
| `GET /` | `{ network, indexed_height, tip_height, token_count, mine_count, last_progress_at, stalled, ... }` |
| `GET /balances/:addr` | `{ address, balances: { TICKER: amount } }` |
| `GET /utxos/:addr` | `{ address, utxos: [{ txid, vout, balances: {TICKER: amt} }] }` (token UTXOs only) |
| `GET /btc-utxos/:addr` | `{ address, scanned_at_height, utxos: [{ txid, vout, sats, confirmed, block_height }] }` — first query 503 while seeding; includes pending mempool outputs with `confirmed:false` |
| `GET /mines/:addr` | `{ address, mines: [MineView] }` (sender == addr, newest first) |
| `GET /mines?limit&offset&ticker` | `{ total, offset, limit, items: [MineView] }` global feed |
| `GET /mines/by-txid/:txid` | `MineView` or 404 |
| `GET /tokens?limit&offset` | `{ total, offset, limit, items: [{ ticker, supply, minted, deployer, deploy_txid, deploy_block }] }` |
| `GET /tokens/:ticker` | one registry entry (+ `holders` count) |
| `GET /tokens/:ticker/holders?limit&offset` | `{ ticker, total, limit, offset, holders: [{ address, balance }] }` |
| `GET /transfers/:addr` | `{ address, transfers: [TransferView] }` |
| `GET /tx-status/:txid` | `{ txid, confirmed, block_height, block_hash, block_time }` (`confirmed:false` when unknown) |
| `GET /block-info/:height` | `{ height, hash, time }` |
| `GET /fees` | `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee }` sat/vB |
| `POST /broadcast` | body = raw tx hex (text/plain) → txid text; 400 + reason on node rejection |

`MineView`:

```json
{ "txid": "...", "block_height": 969600, "block_hash": "...", "sender": "bc1...",
  "ticker": "LUCKY", "status": "settled" | "invalid",
  "yield_smallest": 100, "cap_exhausted": false }
```

## 6. Web wallet contract (UniSat)

The web app holds no keys. It builds an unsigned PSBT and hands it to
`window.unisat.signPsbt`, then `window.unisat.pushPsbt`. Inputs come from
`unisat.getBitcoinUtxos()` when available (UniSat's own asset-safe UTXO
list), else the indexer's `/btc-utxos/:addr` confirmed set — in both
cases filtered by the builder obligation in §4. For P2TR (bc1p) inputs
the PSBT must carry `tapInternalKey` (x-only form of `unisat.getPublicKey()`);
for P2WPKH (bc1q) a `witnessUtxo` suffices. The fee output and dust
outputs are exact amounts from §1; the change output is appended last
and must be ≥ 546 sats or the build must fail (never silently dropped
for SEND).
