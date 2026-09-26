# LuckyProtocol Protocol — v3 / **LUCKY-20** (cohort `genesis-v3`)

**Revision 2026-09-26** (activation height 969,300, SNAPSHOT_VERSION 15 —
see §9 for what changed).

Canonical wire spec for **LuckyProtocol**, the v3 successor to LUCKYPROTOCOL v2.
Both the Rust indexer (branch `v3`) and the web app
(`luckyprotocol-app`) implement exactly this document. Where code and spec
disagree, the spec wins.

## 0. What changed from v2 (and why)

v2 was a casino: a MINE tx carried a tier + a player pick, and settlement
compared the pick to the confirming block hash. v3 **removes the pick
entirely**. A MINE tx carries no player choice; its yield is a pure,
public, deterministic function of the confirming block's hash. Every valid
MINE yields something while supply remains. There is no lose state and
nothing to wager on. It is an **open mint**: no per-address limit, no
allocation, supply-capped at 21,000,000 per ticker, and every MINE pays
the 546-sat protocol fee whether or not supply remains (pay-per-mine).
The yield varies per block (the same kind of variance real mining has),
but nothing about who may mine or how much is rationed. A large miner
can exhaust a ticker's supply quickly — ~80,000 MINEs empty it (§3) —
and the UI shows the remaining supply so every participant sees how
close the cap is. This is a mechanical change, not a cosmetic one.

Everything else that made v2 a sound UTXO token protocol is kept: tokens
are bound to UTXOs, residual routing by vout index, consensus-enforced
protocol fee outputs, fixed 21M supply. One v2 rule is dropped: the
strict burn on raw spends. A tx that spends a token UTXO without a
LUCKY-20 payload now moves the tokens to its first non-OP_RETURN output
(Runes-style default routing, §4) instead of destroying them — the audit
(H-1) showed the burn protected nobody and cost ordinary users their
tokens on a plain wallet sweep.

## 1. Constants

| Name | Value | Notes |
|---|---|---|
| `PROTOCOL_PREFIX` | `LUCKY-20` | The standard's name, field 0 of every payload (cf. brc-20's `p`). Distinct from v2's `LUCKYPROTOCOL`, so v2 history can never parse as LUCKY-20; the activation-height gate applies on top. |
| `ACTIVATION_HEIGHT` | **969_300** | FINAL (re-set 2026-09-26 with the routing rules of this revision; the earlier candidate height was never activated). Txs in earlier blocks are ignored. |
| `SNAPSHOT_VERSION` | 15 | Fresh state; v2 snapshots are refused. (12 = v3 before §7 trading, 13 = strict-burn routing under the earlier candidate height, 14 = §4 default routing before the avatar could ride in the DEPLOY; these earlier v3 rules were not activated on mainnet, and a 14 snapshot must never be reused under the §2.1 embedded-avatar rule.) |
| `REQUIRED_TOKEN_SUPPLY` | 21_000_000 | Implicit on every DEPLOY, not user-settable. |
| `DUST_SATS` | 546 | Token-carrier output value **by wallet convention** — consensus accepts any output value ≥ 1 sat as a carrier (§4). |
| `PROJECT_FEE_ADDRESS` | `bc1pyefhtnuz2gw04fsynlsseeh847cqy20dw7yt6fnavm9fgnewcr7q88gqf3` | Same as v2. |
| `DEPLOY_PROTOCOL_FEE_SATS` | 5_460 | Exact-amount output required on DEPLOY. |
| `MINE_PROTOCOL_FEE_SATS` | 546 | Exact-amount output required on MINE. |
| `SEND_PROTOCOL_FEE_SATS` | 546 | Exact-amount output required on SEND. |
| `MAX_OUT_IDX` | 255 | |
| Ticker grammar | `[A-Z0-9]{1,8}` | First-write-wins per ticker. |

## 2. Payload encoding

The payload is the data push of an OP_RETURN output. ASCII,
`|`-separated, ≤ 80 bytes. Field 0 is always `LUCKY-20`. Any parse
failure = not a protocol tx (the tx is then a plain BTC spend: any token
inputs route to the **default output**, §4 rule 3).

**OP_RETURN outputs (consensus for this protocol):**

- An *OP_RETURN output* is any output whose `scriptPubKey` starts with
  the byte `0x6a` — decided from the script bytes, never from a node's
  script-type label (Bitcoin Core calls `OP_RETURN OP_NOP` "nonstandard",
  not "nulldata"; it is still an OP_RETURN output here).
- The *protocol payload* is the **lowest-index** output of the exact
  form `OP_RETURN <single push>` (direct push, PUSHDATA1/2/4 all
  accepted; nothing after the push) whose push parses as a LUCKY-20
  payload. **Every other OP_RETURN output is ignored** — a wallet memo,
  a runestone or a malformed push, before or after the payload, neither
  invalidates the tx nor changes which output is the payload. There is
  no "more than one OP_RETURN ⇒ not a protocol tx" rule.
- **Tokens can never route to any `0x6a` output.** A payload index
  (`TO_OUT`, `CHANGE_OUT`, MINE's implicit `vout0`) that points at an
  OP_RETURN output is invalid exactly as if it pointed past the last
  vout (§4).

A builder should still emit exactly one OP_RETURN output; the rules
above exist so that every indexer agrees on txs built by other software.

### 2.1 DEPLOY — `LUCKY-20|DEPLOY|<TICKER>`

Registers `<TICKER>` with supply 21,000,000. Ignored (recorded as
`applied:false`) if the ticker already exists.

Consensus fee rule: the tx MUST have at least one output paying **exactly
5,460 sats** to `PROJECT_FEE_ADDRESS`.

**Deployer attribution (consensus — it decides who may set the avatar,
§8.3):** `tokens[ticker].deployer` is the address that contributed the
most prevout value, summed per address, among the inputs that **signed
the whole transaction** — a P2TR key-path witness (64-byte signature,
or 65 bytes ending in `0x00`/`0x01`) or a P2WPKH witness (DER signature
ending in `0x01`, 33-byte compressed key). Ties go to the lowest input
index. Inputs signed with an `ANYONECANPAY` (`0x80`) flag or a
`NONE`/`SINGLE` type — e.g. a bearer `0x83` listing (§7.1) that anyone
can splice into a tx — script-path, P2WSH and legacy inputs are
ignored. A DEPLOY with no qualifying input still registers the ticker,
but with an **empty deployer**: no AVATAR can ever be applied to it.

Reference layout: `vout0` 546 → deployer (proof), `vout1` 5,460 → fee,
`vout2` OP_RETURN, `vout3+` change.

**Embedded avatar:** a DEPLOY may carry the first inscription envelope
defined in §8.2 in an input's script-path witness. If the DEPLOY applies,
its attributed deployer is non-empty, and that envelope passes every §8.2
limit, the registry sets the avatar in the same transaction. No AVATAR
payload or extra 546-sat avatar fee is required. A missing or invalid
image does not invalidate the registration. A rejected/duplicate DEPLOY
cannot replace an existing token's avatar. When an envelope is found,
`/avatars/:addr` records an attempt with `op:"DEPLOY"` and the attributed
deployer as `sender`; the DEPLOY retains ownership of the tx lookup entry.

DEPLOY carries no routing index. Any token inputs (a carrier spent as
funding by mistake) route to the **default output** (§4 rule 3) — in the
reference layout that is `vout0`, the 546-sat proof output the deployer's
own wallet controls, so the tokens are merged there rather than lost.

### 2.2 MINE — `LUCKY-20|MINE|<TICKER>`

`win_out_idx = 0` and `change_out_idx = 0` are **implicit** (not
encoded). The yield is credited to `vout0`; any residual token input pool
— **every ticker in it**, not only `<TICKER>` — also routes to `vout0`.

Consensus fee rule: at least one output paying **exactly 546 sats** to
`PROJECT_FEE_ADDRESS`.

Validity: ticker must be deployed at apply time; the exact 546-sat fee
output must be present; `vout0` must exist and must not be an OP_RETURN.
Invalid → recorded with `status:"invalid"`, yield 0, nothing minted.

**Residual routing is independent of validity:** for EVERY parseable
MINE — valid or `invalid` (undeployed ticker, missing fee) — any token
input pool routes to `vout0`, exactly as a SEND's residual routes to
`CHANGE_OUT` whether or not the SEND is `applied`. Only when `vout0`
itself is missing or an OP_RETURN does the residual burn (§4) — there is
no fall-back to the default output for a MINE. An implementation that
burns the residual of an invalid MINE, or that burns the other tickers
in the pool, diverges. The normative table is §4.1.

Reference layout: `vout0` 546 → miner (yield slot), `vout1` 546 → fee,
`vout2` OP_RETURN, `vout3+` change.

### 2.3 SEND — `LUCKY-20|SEND|<TICKER>|<AMT>|<TO_OUT>|<CHANGE_OUT>`

`AMT` is a canonical unsigned integer (whole tokens,
1 ≤ AMT ≤ 21,000,000); `TO_OUT` and `CHANGE_OUT` are decimal `[0..255]`
and MUST differ (equal indices do not parse). Moves `AMT` of `<TICKER>`
— **only that ticker** — from the tx's input pool to `vout[TO_OUT]`; the
residual of `<TICKER>` **and the full balance of every other ticker in
the pool** → `vout[CHANGE_OUT]`. A SEND is `applied` iff the pool holds
≥ AMT of `<TICKER>`, `TO_OUT` is a real non-OP_RETURN vout and the fee
output is present; otherwise it is `applied:false`, nothing moves to
`TO_OUT`, and the whole pool (every ticker) routes to `CHANGE_OUT`. If
`CHANGE_OUT` is out of range or an OP_RETURN, the residual falls back to
the **default output** (§4 rule 3) and burns only when the tx has none.
Fee rule: exactly 546 sats to `PROJECT_FEE_ADDRESS`.

Because routing is per ticker, a UTXO that carries several tickers is
split by an ordinary SEND: `AMT` of one ticker to `TO_OUT`, everything
else to `CHANGE_OUT`. The normative table is §4.1.

Reference layout (the web app builds exactly this):

| vout | value | to | note |
|---|---|---|---|
| 0 | 546 | recipient | `TO_OUT` — carries `AMT` |
| 1 | 546 | `PROJECT_FEE_ADDRESS` | consensus fee, exact amount |
| 2 | 0 | OP_RETURN `LUCKY-20\|SEND\|<TICKER>\|<AMT>\|0\|3` | |
| 3 | 546 | sender | `CHANGE_OUT` — the **residual slot, always present** (even when the residual is 0) |
| 4 | change | sender | BTC change, **optional** — dropped when sub-dust; it never carries tokens |

The residual slot is a dedicated 546-sat output so that tokens never
ride on a large BTC change output (audit H-1 A): a wallet that later
spends the change as plain BTC cannot take the tokens with it. **`vout3`
must exist** — a builder must never drop it as sub-dust.

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
MINE records `cap_exhausted:true` and credits 0 — the protocol fee is
still paid (open mint, §0), so a wallet must show the remaining supply
before it builds a MINE.

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

## 4. Token routing rules

1. **Input pool**: for every tx (protocol or not), tokens on spent
   token-bearing UTXOs are gathered into a per-ticker input pool.
2. **Protocol tx**: MINE routes the pool (every ticker) + yield to
   `vout0`, burning it only when `vout0` is missing or an OP_RETURN; SEND
   routes per §2.3 (only `<TICKER>` moves; the residual of every ticker
   goes to `CHANGE_OUT`, falling back to the default output when
   `CHANGE_OUT` is unusable); DEPLOY and AVATAR carry no routing index, so
   their token inputs go to the default output (rule 3).
   **Per-ticker note (audit H-2):** a tx may spend UTXOs of several
   tickers; there is no multi-ticker burn. The routing decision is made
   once per tx and applied to every ticker in the pool — only a SEND's
   `AMT` is ticker-specific.
3. **Default routing** (replaces v2's strict burn — audit H-1): a tx
   that spends token UTXOs and carries **no parseable LUCKY-20 payload**
   (no OP_RETURN, an unparseable push, or another protocol's payload)
   moves its whole input pool — every ticker — to its **default output**:
   the lowest-index output that is not an OP_RETURN. The pool burns only
   when the tx has no such output. The default output must be one whose
   scriptPubKey encodes an address (P2PKH, P2SH, P2WPKH, P2WSH, P2TR, or
   any future witness program); if the first non-OP_RETURN output is an
   address-less script (P2PK, bare multisig, a non-standard script) the
   pool burns — rule 3 does not skip to the next output. Rationale: the
   indexer's balance view is keyed by address, not by scriptPubKey, and
   tokens on an unnamed script would be held by nobody the protocol can
   show. A plain wallet sweep of a carrier therefore keeps the tokens on
   the wallet's first output; a payment that spends a carrier hands the
   tokens to whoever `vout0` pays.
4. Tokens can never be assigned to an OP_RETURN output.
5. **Carrier value**: consensus does NOT require a token carrier to be
   exactly 546 sats — any non-OP_RETURN output of **≥ 1 sat** is a
   valid carrier, and indexers must credit whatever index the rules
   name regardless of its value. The 546-sat carrier (`DUST_SATS`) is a
   **wallet convention** (Bitcoin Core's standardness dust floor for
   P2WPKH / P2TR, and the value the §2 / §7 reference layouts use for
   every token slot) that keeps carriers cheap, uniform and easy to
   filter out of fee selection. Settlement is index-agnostic; nothing
   in the rules depends on how many outputs a tx has beyond the indices
   they name.

### 4.1 Routing table (normative)

Where the **residual input pool** goes — every ticker the tx's inputs
carried, after a SEND's `AMT` has been taken out — for every kind of tx
at or above `ACTIVATION_HEIGHT` (earlier txs are not processed at all).
"Default output" = the lowest-index non-OP_RETURN output (rule 3).
Rules 1–5 above and §2.1–§2.3 / §8.3 are explanatory; where they and
this table could be read differently, the table wins.

| Payload | Case | `<TICKER>` named by the payload | Every other ticker in the pool |
|---|---|---|---|
| `MINE\|T` | valid (settled; includes `cap_exhausted`) | yield + residual → `vout0` | → `vout0` |
| `MINE\|T` | invalid: undeployed ticker, or no exact 546-sat fee output | residual → `vout0` (no yield) | → `vout0` |
| `MINE\|T` | `vout0` missing or an OP_RETURN (also invalid) | **burn** | **burn** |
| `SEND\|T\|AMT\|TO\|CH` | applied: pool ≥ `AMT`, fee output present, `vout[TO]` real and not OP_RETURN | `AMT` → `vout[TO]`, residual → `vout[CH]` | → `vout[CH]` |
| `SEND\|T\|AMT\|TO\|CH` | not applied: pool < `AMT`, no fee output, or `vout[TO]` missing / OP_RETURN | whole pool → `vout[CH]` | → `vout[CH]` |
| `SEND\|T\|AMT\|TO\|CH` | `vout[CH]` missing or an OP_RETURN (applied or not — when applied `AMT` still goes to `vout[TO]`) | residual → default output | → default output |
| `DEPLOY\|T` | applied or not | → default output | → default output |
| `AVATAR\|T` | applied or not | → default output | → default output |
| none | no OP_RETURN, an unparseable push, another protocol's payload, or a `LUCKY-20` push that does not parse (a five-field SEND, a bad ticker, …) | → default output | → default output |
| any row that says "default output" | the tx has no non-OP_RETURN output, or its lowest-index one is address-less (P2PK, bare multisig, non-standard) | **burn** | **burn** |

**Per-ticker note (audit H-2):** there is no multi-ticker rule. A tx may
spend UTXOs of any number of tickers; the destination is decided once
per tx and applied to every ticker in the pool, and only a SEND's `AMT`
is ticker-specific. A mixed UTXO is therefore split by an ordinary SEND
(§2.3) and can never be stranded. Balances land on the named vout
whatever its BTC value (rule 5) and are keyed by that output's address;
every implementation must produce identical `utxo_balances` for every
row above.

Builder obligation (web): **never select a token-bearing UTXO as a fee
input**. Practical rule: exclude every UTXO with value ≤ 546 sats (all
LuckyProtocol token carriers are 546-sat outputs; this also shields most
inscription UTXOs) AND exclude every outpoint the indexer's
`/utxos/:addr` reports as token-bearing. Default routing makes an
accidental spend recoverable only when the first output is the wallet's
own; it merges the tokens onto whatever that output is. Concretely, a
546-sat carrier spent as a fee input lands its tokens on: `vout0` of a
DEPLOY or AVATAR (the 546-sat proof / inscription output the wallet
controls — merged, not lost); `vout0` of a MINE (the miner's yield slot,
by §2.2); `CHANGE_OUT` of a SEND or fill (the sender's / buyer's residual
slot); and the **payee** of any plain payment. Never the project fee
output: it is never the lowest-index output in a reference layout.

## 5. Indexer HTTP API (v3)

All JSON. CORS open. Base: the operator's indexer origin.

| Route | Returns |
|---|---|
| `GET /` (alias `GET /health`) | `{ network, indexed_height, tip_height, token_count, mine_count, last_progress_at, stalled, ... }` — counts and progress only; the node endpoint and recent error strings are on `GET /health/diag`, which answers only loopback clients whose request carries none of `CF-Connecting-IP`, `CF-Ray`, `X-Forwarded-For`, `X-Real-IP` (404 otherwise — the Cloudflare tunnel runs on the same host and connects from loopback) |
| `GET /balances/:addr` | `{ address, balances: { TICKER: amount } }` |
| `GET /utxos/:addr` | `{ address, utxos: [{ txid, vout, balances: {TICKER: amt} }] }` (token UTXOs only) |
| `GET /btc-utxos/:addr?limit&offset` | `{ address, scanned_at_height, utxos: [{ txid, vout, sats, confirmed, block_height }], total, limit, offset }` — `utxos` sorted by `sats` desc, paged (`limit` default 200, max 500); `Cache-Control: public, max-age=10`. `addr` must be a standard mainnet address (400 otherwise). First query 503 + `Retry-After` while seeding; 429 + `Retry-After` when every seed slot is busy (never queued); 422 when the address holds more than 5,000 UTXOs (consolidate first). Includes pending mempool outputs with `confirmed:false` |
| `GET /mines/:addr?limit&offset` | `{ address, mines: [MineView], total, limit, offset }` (sender == addr, newest first; `limit` default 50, max 200 — same for every per-address list below) |
| `GET /mines?limit&offset&ticker` | `{ total, offset, limit, items: [MineView] }` global feed |
| `GET /mines/by-txid/:txid` | `MineView` or 404 |
| `GET /tokens?limit&offset&deployer` | `{ total, offset, limit, items: [{ ticker, supply, minted, deployer, deploy_txid, deploy_block, avatar_txid, avatar_content_type, … }] }`; optional exact-address `deployer` filter applies before pagination, and `total` counts matching entries |
| `GET /tokens/:ticker` | one registry entry (+ `holders` count) |
| `GET /tokens/:ticker/holders?limit&offset` | `{ ticker, total, limit, offset, holders: [{ address, balance }] }` |
| `GET /transfers/:addr?limit&offset` | `{ address, transfers: [TransferView], total, limit, offset }` |
| `GET /tx-status/:txid` | `{ txid, confirmed, seen, in_mempool, block_height, block_hash, block_time }`. A txid the indexer has not observed at a watched address is looked up in the node's mempool: `seen:false` = the node has never seen it, `in_mempool:true` = pending; 502 when the node cannot be asked (never a guess); 400 for a non-txid. `Cache-Control: public, max-age=31536000, immutable` once the block is ≥ 12 below `indexed_height`, else `max-age=10` |
| `GET /block-info/:height` | `{ height, hash, time, weight, tx_count }` — `weight` / `tx_count` (Core `getblock`, cached by block hash) are served for heights within the most recent 32 blocks (the `/blocks/recent` window); an older height answers `null` (or a value that happens to remain in the hash-keyed cache) without asking the node for the block body. `null` is also returned when the block body is unavailable; missing capacity is null, never zero. Fullness is `weight / 4,000,000`. Caching as `/tx-status`, except that a height inside the 32-block window is only frozen `immutable` once its capacity is known — a transient `getblock` failure stays `max-age=10` and is retried |
| `GET /blocks/recent?limit` | `{ tip_height, blocks: [{ height, hash, time, weight, tx_count }] }` — last N (≤ 32, default 16) blocks newest first; feeds the block tape. `time`, `weight`, `tx_count` come from Core `getblock`, cached by block hash, and are served for exactly this window — the most recent 32 blocks are the only heights whose block body the indexer ever reads. `null` when the block body is unavailable or the RPC pool is full; missing capacity is null, never zero. Fullness is `weight / 4,000,000`, not a mempool congestion estimate |
| `GET /fees` | `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee }` sat/vB |
| `POST /broadcast` | body = raw tx hex (text/plain) → txid text; 400 + reason on node rejection. A tx with an OP_RETURN output whose push starts with the retired v2 prefix `LUCKYPROTOCOL\|` is refused with 400 + JSON `{ "error": "legacy LUCKYPROTOCOL payloads are no longer relayed; withdraw at luckybtc.org" }` before reaching the node; every other tx (sweeps without an OP_RETURN, LUCKY-20 payloads, foreign OP_RETURNs) is relayed |
| `POST /orders` | JSON `{ psbt, ticker, amount, price_sats }` → `OrderView` (201) — see §7.4 |
| `GET /orders?ticker&status&limit&offset` | `{ total, offset, limit, items: [OrderView] }` — open orders sorted by unit price asc; `psbt` omitted |
| `GET /orders/:id` | `OrderView` incl. `psbt` (id = `txid:vout` of the listed UTXO) or 404 |
| `GET /orders/by-address/:addr?limit&offset` | `{ address, orders: [OrderView], total, limit, offset }` — every status, newest first, `psbt` omitted |
| `GET /trades?ticker&limit&offset` | `{ total, offset, limit, items: [TradeView] }` newest first |
| `GET /trades/:addr?limit&offset` | `{ address, trades: [TradeView], total, limit, offset }` where addr is buyer or seller |

Routes that proxy bitcoind (`/tx-status`, `/block-info`, `/block-height`,
`/blocks/recent`, `/broadcast`, `POST /orders`) share a pool of 8 RPC
slots; when it is full they answer `503` + `Retry-After: 2` immediately.
The server handles at most 64 requests concurrently and cuts any request
off after 10 s (`408`).

`/tokens` items (and `/tokens/:ticker`) additionally carry per-ticker stats:
`mine_count`, `trade_count`, `volume_sats` (lifetime BTC volume of fills),
`open_orders`, `floor_unit_price` (lowest open ask in sats per whole token,
float, `null` when no asks) and `last_trade` (`TradeView` or `null`).
`trade_count`, `volume_sats` and `last_trade` **exclude self-trades**
(fills whose buyer script is the seller's, `TradeView.self_trade`).

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
by the builder obligation in §4 — a 546-sat carrier must never be a fee
input, because default routing would hand its tokens to the tx's first
output (§4 lists where that is for each opcode). For P2TR (bc1p) inputs
the PSBT must carry `tapInternalKey` (x-only form of `unisat.getPublicKey()`);
for P2WPKH (bc1q) a `witnessUtxo` suffices. The fee output and the
546-sat token slots (recipient, residual) are exact amounts from §1 and
are always emitted — a SEND's residual slot (`vout3`) and a fill's
(`vout4`) exist even when the residual is 0. The BTC change output is
appended last and is optional: when it would be sub-dust the builder
drops it and lets the difference go to the network fee. It never
carries tokens, so dropping it loses nothing.

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
  partial amount, or one ticker of a mixed UTXO, the seller first splits
  with a SEND-to-self (§2.3, `vout0` = 546 sats carrying `AMT` of that
  ticker, `vout3` = the residual of every ticker) and lists the new
  `vout0`. The input carries `witnessUtxo` (real script + real value
  — 546 for a fresh carrier, more for a SEND change output), the PSBT
  `sighashType` field = `0x83`, and `tapInternalKey` for P2TR.
- `output0` — `price_sats` to **the same script as `input0`** (the seller
  pays themself). `price_sats ≥ 546` **and `price_sats ≥
  witnessUtxo.value`** (the carrier's own BTC value).

The seller signs `input0` with **`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`
(0x83)** and does NOT finalize (UniSat: `signPsbt(hex, { autoFinalized:
false, toSignInputs: [{ index: 0, address, sighashTypes: [0x83] }] })`).
That signature commits to `input0` and `output0` only, so any number of
inputs/outputs may be appended without invalidating it — the seller
loses the UTXO only in a tx that pays `output0` in full. **Every sat on
the carrier above `price_sats` goes to the buyer** (it is simply extra
input value in the fill — it ends up in the buyer's BTC change, §7.2
`vout5`, or in the fee), which is why the ask must cover
the carrier's value: to sell only tokens, split them onto a fresh 546-sat
carrier first. `nLockTime` is committed too: listings and fills use
locktime 0.

Unit price = `price_sats / amount` (sats per whole token). `price_sats`
is the total for the whole listing.

### 7.2 Fill = the listing completed into a SEND

The buyer appends inputs `1..n` (their BTC, filtered per §4) and the
outputs that make the tx a valid SEND:

| vout | value | to | note |
|---|---|---|---|
| 0 | `price_sats` | seller | from the listing, untouched |
| 1 | 546 | buyer | token slot (`TO_OUT`) |
| 2 | 546 | `PROJECT_FEE_ADDRESS` | SEND consensus fee |
| 3 | 0 | OP_RETURN `LUCKY-20\|SEND\|<TICKER>\|<AMT>\|1\|4` | `TO_OUT = 1`, `CHANGE_OUT = 4` (§1 prefix — a fill built with any other prefix is not a SEND: default routing (§4 rule 3) sends the tokens to `vout0`, i.e. back to the seller, who keeps the price as well) |
| 4 | 546 | buyer | **residual slot, always present** (`CHANGE_OUT`) — same rule as §2.3's `vout3`: the build must never drop it |
| 5 | change | buyer | BTC change, **optional** — dropped when sub-dust; never carries tokens |

`CHANGE_OUT` must differ from `TO_OUT` (§2.3 grammar); the residual slot
is a dedicated 546-sat output so that any residual of the input pool
(the listed carrier is the only token input a well-formed fill has, so
normally 0 — but every ticker of every token input the buyer may have
added by mistake) lands on a 546-sat carrier the buyer controls, not on
the buyer's BTC change. The buyer
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
  price_sats ≥ 546`; **`price_sats ≥ witnessUtxo.value`** (BTC above
  price on the carrier goes to the buyer, §7.1); **`price_sats ≤ amount ×
  1e8`** (at most 1 BTC per whole token); `1 ≤ amount ≤ 21_000_000`;
- `input0.sighashType == 0x83`, and the signature **verifies** against
  the prevout: P2TR key-path → Schnorr over
  `taproot_key_spend_signature_hash(0, Prevouts::One, SinglePlusAnyoneCanPay)`
  with the witness-program x-only key; P2WPKH → ECDSA over
  `p2wpkh_signature_hash(..., SinglePlusAnyoneCanPay)` with the
  `partial_sigs` key whose hash160 is the witness program. Other script
  types are rejected;
- per-address open-order cap 50 (refused when exceeded).

**Capacity and lifetime (never a permanent "book full"):**

- **TTL**: an open order expires **14 days after `updated_at`** and is
  dropped from the book (`expires_at` in `OrderView`). Re-POSTing the same
  PSBT refreshes it for free — it replaces the entry and counts against no
  cap. The UI should re-POST open listings it still wants shown.
- **Global cap 10,000** orders (any status): when full, the oldest closed
  (filled / cancelled) orders are evicted first, then the **open order
  with the oldest `updated_at`**. A listing is a bearer PSBT the seller
  can re-POST at any time, so eviction never loses anything.
- **Per-ticker cap 1,500 open orders**: the book keeps a ticker's 1,500
  best asks. A new ask that undercuts the worst (highest unit price)
  evicts it; one that does not is refused with the price it must beat.

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
  "expires_at": 1791209600,
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
  "seller": "bc1p...", "buyer": "bc1q...", "order_id": "txid:vout",
  "self_trade": false }
```

`self_trade` is true when `buyer == seller` (the seller filled their own
listing). Such fills are recorded and listed like any other, but they do
not count toward `trade_count` / `volume_sats` and never become
`last_trade` — a 546-sat wash must not print a price.

On `restore_from_snapshot` (reorg or restart) every non-open order whose
outpoint is present again in `utxo_balances` reverts to `open`.

### 7.6 What this is not (trading)

There is no bonding curve, no pooled liquidity, no market maker and no
custody. Prices are whatever sellers ask and buyers pay, settled by the
Bitcoin network. The indexer can hide or lose orders (availability), but
it cannot move anyone's funds (safety).

## 8. Token avatars — `LUCKY-20|AVATAR|<TICKER>` (on-chain image)

A token's avatar is an **Ordinals-style inscription** carried by its
DEPLOY transaction at creation (§2.1), or an AVATAR transaction to replace
it later. It lives on Bitcoin and can be reconstructed by any indexer.
The reference layout places the inscribed sat in the deployer's wallet.
Nothing is uploaded to a server.

### 8.1 Replacement payload and layout

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
`deployer` address, signed over the whole transaction** (§8.3) — that is
the authorization: the wallet signs that input (P2TR key path, or
P2WPKH, with `SIGHASH_ALL`/`DEFAULT`) and pays the network fee from it.

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
| magic bytes | the concatenated body MUST start with the declared type's signature: PNG `89 50 4E 47`, JPEG `FF D8 FF`, WebP `RIFF ???? WEBP` (bytes 0–3 and 8–11), GIF `GIF8` (`GIF87a`/`GIF89a`). A mismatch is `applied:false` like any other limit violation. |
| reference client target (not consensus) | up to 128×128, WebP, target ≤ 4,096 bytes; reduce to 96 or 64 px if needed (client-side compression) |

### 8.3 Validity and effect

For an avatar embedded in DEPLOY, use the registration and image rules
in §2.1. The remaining rules below apply to the AVATAR replacement opcode.

An AVATAR tx is **applied** iff: the ticker is deployed with a non-empty
`deployer` (§2.1); **some input's prevout address equals
`tokens[ticker].deployer` AND that input's witness signed the whole
transaction**; the exact 546-sat protocol fee output is present; an
envelope per §8.2 is found and within limits; `vout0` exists and is not
an OP_RETURN. Otherwise it is recorded with `applied:false` and changes
nothing. AVATAR carries no routing index: token inputs, if any, go to
the default output (§4 rule 3 — `vout0`, the deployer's 546-sat
inscription slot in the reference layout), applied or not; a builder must
still never spend token UTXOs in an AVATAR tx.

**"Signed the whole transaction"** means the authorizing input's witness
is one of:

- P2TR key path: a single 64-byte Schnorr signature (`SIGHASH_DEFAULT`),
  or a 65-byte one whose last byte is `0x00` or `0x01` (a BIP-341 annex
  element, if present, is ignored);
- P2WPKH: `[<DER signature>, <33-byte compressed key>]` where the
  signature's last byte is `0x01` (`SIGHASH_ALL`).

A signature carrying the `ANYONECANPAY` flag (`0x80`) or a `NONE`/`SINGLE`
type (`0x02`/`0x03`) — in particular the bearer `0x83` listing signature
every seller publishes through `GET /orders/:id` (§7.3) — commits only
to part of the tx and does NOT authorize; neither do script-path
(tapscript), P2WSH or legacy (non-segwit) inputs. Without this rule
anyone holding one of a deployer's listings could splice it into an
AVATAR tx and replace that deployer's token images.

Effect: `tokens[ticker].avatar = { content_type, bytes, txid, block_height }`.
**Latest applied AVATAR wins** — the deployer may replace the image. The
avatar is chain-derived state (snapshot; rolled back on reorg). Images are
permanent on-chain; the UI must say so before inscribing.

### 8.4 API

| Route | Returns |
|---|---|
| `GET /tokens/:ticker/avatar` | the image bytes with its `Content-Type`, `ETag: "<txid>"`, `Cache-Control: public, max-age=300`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline; filename="avatar"`; 404 when the token has no avatar — or when the operator has denylisted it (a file named by `LUCKYPROTOCOL_AVATAR_DENYLIST`, one AVATAR txid or image SHA-256 per line, reloaded every 60 s; this affects distribution from that origin only, never consensus) |
| `/tokens` items, `/tokens/:ticker` | gain `avatar_txid` (`string | null`) and `avatar_content_type` |
| `GET /avatars/:addr?limit&offset` | `{ address, avatars: [AvatarView], total, limit, offset }` — avatar attempts attributed to this address (audit), newest first; `op` distinguishes `DEPLOY` from `AVATAR` |

`AvatarView`: `{ txid, block_height, block_hash, sender, ticker, applied, op, content_type, bytes_len }`.
`op` is `"DEPLOY"` when the envelope was embedded in the DEPLOY tx (§2.1,
§8.3) and `"AVATAR"` for an AVATAR tx; `txid` is that tx. Additive field:
rows written before it existed read as `"AVATAR"`.

### 8.5 Reference client flow (web)

The Create page offers an optional image; without it, DEPLOY stays a
single transaction. With an image, step 4 below is the DEPLOY itself
(§2.1 layout and 5,460-sat fee). Portfolio provides later image replacement
using AVATAR (§8.1 layout and 546-sat fee).

1. Pick an image → canvas resize to at most 128×128 without upscaling →
   encode WebP, lowering quality and then reducing to 96 or 64 px to target
   ≤ 4,096 bytes. PNG is the fallback when WebP encoding is unavailable.
   If the target cannot be met, use the smallest result within 16,384 bytes;
   reject if no result fits. These are client preferences, not consensus rules.
2. Generate an ephemeral secp256k1 key in the browser; encrypt the recovery
   record with a wallet-signature-derived AES-GCM key before paying.
   Real wallets without repeatable message signatures cannot start.
3. Build the commit P2TR address (internal key = ephemeral key, leaf =
   `<ephemeral-xonly> OP_CHECKSIG` + envelope). Ask the wallet to send
   `546 + reveal_fee_share` sats to it (a plain payment).
4. Build the reveal PSBT: `input0` = commit output (script path, signed
   locally with the ephemeral key), `input1` = a deployer UTXO (fee +
   authorization; filtered per §4), outputs per §2.1 for creation or
   §8.1 for replacement. Wallet signs every wallet-owned input; the app
   finalizes `input0`, extracts and broadcasts.

Creation records (`lp.deploy.<TICKER>`) save the signed commit and reveal
before each broadcast. A retry sends those exact bytes. Records are
retained until confirmation and registry reconciliation. If a competing
registration takes the name, the client can key-path sweep an unspent
commit to the original wallet, less network fees; it refuses that sweep
while its own reveal is known to the node. Replacement records remain
under `lp.avatar.<TICKER>`.

## 9. Changelog

- **2026-09-26** — avatar may be embedded in DEPLOY (§2.1 / §8), snapshot
  version 15; additive `AvatarView.op`; `/tokens` accepts an exact
  `deployer` filter before pagination, with `total` counting matches.

- **2026-09-26** — audit fixes, all before activation (nothing on chain
  changed): activation height **969,300**, `SNAPSHOT_VERSION` 14 (§1);
  **default routing** replaces strict burn (§4 rule 3, audit H-1);
  **per-ticker routing**, the multi-ticker burn is gone (§2.2, §2.3, §4,
  audit H-2); dedicated 546-sat residual slots in the SEND and fill
  layouts, carrier value ≥ 1 sat is consensus (§2.3, §4 rule 5, §6,
  §7.2, audit H-1 A); normative routing table (§4.1); §0 describes an
  open mint; `POST /broadcast` refuses v2 `LUCKYPROTOCOL|` payloads (§5,
  audit H-4); `GET /health/diag` answers only unproxied loopback
  requests (§5, audit L-7).
- **2026-09-25** — v3 / LUCKY-20 candidate: strict burn, multi-ticker
  burn, earlier activation height. Never activated.
