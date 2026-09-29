# LUCKY-20 Protocol Specification — v1

**Version 1** — in force from block 969,600 (`ACTIVATION_HEIGHT`, §1).

LUCKY-20 is a token protocol on Bitcoin L1, published by **LuckyProtocol**.
Its operations are OP_RETURN payloads and its tokens are bound to UTXOs.
Anyone can create a token (a ticker with a fixed supply of 21,000,000),
and anyone can mine it. The amount each MINE credits is decided by the
hash of the block that confirms it.

This document is the canonical wire specification. The reference indexer
and the reference web app implement exactly this document. Where code
and this document disagree, this document is authoritative.

## 0. Design principles

- **No player choice.** A MINE tx carries a ticker and nothing else. Its
  yield is a pure, public, deterministic function of the confirming
  block's hash (§3). The miner chooses nothing and pays nothing beyond
  the fees, and every valid MINE credits tokens while supply remains.
- **Open mint.** There is no per-address limit and no allocation. Each
  ticker is capped at 21,000,000 tokens, and every MINE pays the 546-sat
  protocol fee whether or not supply remains (pay-per-mine). The yield
  varies from block to block (the same kind of variance real mining
  has), but nothing limits who may mine or how much. A large miner can
  exhaust a ticker's supply quickly — about 80,000 MINEs empty it (§3) —
  so the reference client shows the remaining supply, and every
  participant can see how close the cap is. Mining starts in the block
  after a ticker's DEPLOY: a MINE in the DEPLOY's own block does not count,
  so nobody — the deployer included — mines in the block that makes a
  ticker public (§2.2).
- **UTXO-bound tokens.** Tokens are bound to UTXOs, residual tokens are
  routed by vout index, the protocol fee outputs are enforced by
  consensus, and the supply of each ticker is fixed.
- **Default routing.** A tx that spends a token UTXO without a LUCKY-20
  payload moves the tokens to its first non-OP_RETURN output (Runes-style
  default routing, §4) instead of destroying them. A burn on such a spend
  would protect nobody and would cost ordinary users their tokens on a
  plain wallet sweep.

## 1. Constants

| Name | Value | Notes |
|---|---|---|
| `PROTOCOL_PREFIX` | `LUCKY-20` | The standard's name, field 0 of every payload (cf. brc-20's `p`). A push whose field 0 is anything other than `LUCKY-20` — e.g. `LUCKYPROTOCOL` — is not a LUCKY-20 payload; the activation-height gate applies on top. |
| `ACTIVATION_HEIGHT` | **969_600** | Txs in earlier blocks are ignored. |
| `REQUIRED_TOKEN_SUPPLY` | 21_000_000 | Implicit on every DEPLOY, not user-settable. |
| `DUST_SATS` | 546 | Token-carrier output value **by wallet convention** — consensus accepts any non-OP_RETURN output as a carrier whatever its value, 0 sats included (§4 rule 5). |
| `PROJECT_FEE_ADDRESS` | `bc1phk23psaqmq4rlsjeet79xpt65n9v2hvrv97ezc6c4rpld4s2shwqa9qx9n` | Fixed; the protocol fee outputs of §2.1–§2.3 pay it. |
| `DEPLOY_PROTOCOL_FEE_SATS` | 5_460 | Exact-amount output required on DEPLOY (the REVEAL, §2.1). A COMMIT pays no protocol fee. |
| `MINE_PROTOCOL_FEE_SATS` | 546 | Exact-amount output required on MINE. |
| `SEND_PROTOCOL_FEE_SATS` | 546 | Exact-amount output required on SEND. |
| `MAX_OUT_IDX` | 255 | |
| `MIN_COMMIT_AGE` | 1 | A REVEAL is valid only at a height ≥ its COMMIT's height + 1, i.e. the COMMIT confirmed in an earlier block (§2.1). |
| `MAX_COMMIT_AGE` | 2_016 | A REVEAL is valid only at a height ≤ its COMMIT's height + 2,016 (two weeks); after that the COMMIT is expired (§2.1). |
| `FINAL_DEPTH` | 6 | Confirmations after which a block's effects are final (§3.1). A block has 1 confirmation while it is the newest indexed block and one more for each block on top of it, so it is final once 5 blocks are on top of it. A token's market opens once the block that minted it out has 6 (§7.4). |
| Ticker grammar | `[A-Z0-9]{1,8}` | The first valid registration of a ticker is final on the chain Bitcoin keeps (§2.1, §3.1). |

## 2. Payload encoding

The payload is the data push of an OP_RETURN output. ASCII,
`|`-separated, ≤ 80 bytes. Field 0 is always `LUCKY-20`. Field 1, the
opcode, is exactly one of `COMMIT`, `DEPLOY`, `MINE`, `SEND`
(case-sensitive, §2.1–§2.3); a push with any other opcode does not parse.
Any parse failure = not a protocol tx (the tx is then a plain BTC spend:
any token inputs route to the **default output**, §4 rule 3).

**A coinbase transaction is never a protocol tx.** Its outputs are not
searched for a payload, whatever they carry: a miner cannot MINE, SEND,
COMMIT or DEPLOY from its own coinbase. (A coinbase spends no token UTXO,
so it moves no tokens either.)

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

### 2.1 DEPLOY — commit, then reveal

A ticker is registered in two transactions, so that nobody watching the
mempool can copy it: a **COMMIT** that hides the ticker behind a salted
hash, then — in a later block — a **REVEAL** that shows the ticker and
proves, by spending the COMMIT's first output, that it comes from the
committer. The hash also covers the script of that first output, so it
binds the committer: a copy of it is useless to anyone else.

**COMMIT — `LUCKY-20|COMMIT|<H>`.** `H` is exactly 64 lowercase hex
characters:

```
H = SHA-256( P ‖ S )
    P = the UTF-8 bytes of the exact REVEAL payload string (below)
    S = the raw scriptPubKey bytes of this COMMIT's vout0 (the commit carrier)
```

`‖` is plain byte concatenation: the bytes of `P`, then the bytes of `S`,
with no separator and no length prefix. `S` is the output script itself,
without the length byte that precedes it in a serialized transaction (34
bytes `5120…` for a P2TR carrier, 22 bytes `0014…` for P2WPKH). The same
payload under another carrier script gives another `H`. The COMMIT payload
is exactly 80 bytes. An `H` in upper case or of another length, an empty
`H` or a further field does not parse.

- `vout0` is the **commit carrier**. It must exist, must not be an
  OP_RETURN output and must have a standard address (P2PKH, P2SH, P2WPKH,
  P2WSH, P2TR or any future witness program — the same test as the
  default output, §4 rule 3); otherwise the COMMIT is recorded `invalid`
  (`invalid_reason`: `carrier_missing` | `carrier_op_return` |
  `carrier_no_address`) and can never be revealed. The carrier's value is
  never read — any value, 0 sats included, is a carrier (§4 rule 5); the
  reference carrier is 546 sats to the committer's own address.
- **Several COMMITs may carry the same `H`, and none of them affects
  another.** Each is recorded on its own merits (the carrier checks
  above) and each can only be revealed through its own carrier, whose
  script is part of `H` (rule 2 below). `H` is public from the moment a
  COMMIT is in the mempool, but a copy of it is useless: to reveal it
  through his own carrier, the copier would need a payload `P` with
  SHA-256(`P` ‖ his own carrier script) = `H`. That is not feasible: `H`
  was computed with the owner's script, and finding another input with
  the same SHA-256 is out of reach. The owner's carrier is not his to
  spend either. (A copy whose carrier pays the owner's own address has
  the owner's script: only the owner can spend that carrier, and a
  REVEAL through it names the owner.)
- A COMMIT pays **no protocol fee**.
- A COMMIT carries no routing index: token inputs go to the **default
  output** (§4 rule 3) — in the reference layout, the carrier.
- The indexer records `{ H, carrier = commit_txid:0, carrier script,
  commit height, tx index, committer }`; the **committer** is the
  carrier's address and the **carrier script** is `S` above, kept for rule
  2 of the REVEAL. The carrier script is kept for an `open` COMMIT only:
  an `invalid` COMMIT keeps none, since rule 1 refuses its REVEAL before
  rule 2 would read it (an open carrier has an address, so its script is
  a standard one of at most 42 bytes). Like every tx, a COMMIT below
  `ACTIVATION_HEIGHT` is not processed and is never recorded.

Reference COMMIT layout: `vout0` 546 → committer (the carrier), `vout1`
OP_RETURN `LUCKY-20|COMMIT|<H>`, `vout2+` change.

**REVEAL — `LUCKY-20|DEPLOY|<TICKER>|<SALT>`.** `SALT` is exactly 32
lowercase hex characters (16 random bytes). A fourth field that is not
exactly that, or a fifth field, does not parse. The REVEAL registers
`<TICKER>` with supply 21,000,000 iff ALL of the following hold. They are
checked in this order; the first rule that fails is recorded as the
DEPLOY's machine-readable `reason` and the DEPLOY is `applied:false`:

| # | Rule | `reason` when it fails |
|---|---|---|
| 1 | input 0 spends the carrier (`commit_txid:0`) of a recorded COMMIT that is not `invalid` | `no_commit` (input 0 spends no recorded carrier) · `commit_invalid` (its COMMIT is recorded `invalid`) |
| 2 | that COMMIT's `H` == SHA-256( the exact bytes of this payload ‖ the scriptPubKey of the carrier that input 0 spends, i.e. the recorded `vout0` script of that COMMIT ) | `hash_mismatch` |
| 3 | commit height ≥ `ACTIVATION_HEIGHT` | `commit_before_activation` (such a COMMIT is never recorded, so rule 1 answers `no_commit` first) |
| 4 | reveal height ≥ commit height + `MIN_COMMIT_AGE` (1) — the COMMIT confirmed in an **earlier** block | `commit_too_recent` |
| 5 | reveal height ≤ commit height + `MAX_COMMIT_AGE` (2,016) | `commit_expired` |
| 6 | an output pays **exactly 5,460 sats** to `PROJECT_FEE_ADDRESS` | `fee_missing` |
| 7 | the ticker is not registered yet | `ticker_taken` |

The three-field form `LUCKY-20|DEPLOY|<TICKER>` parses (it is
recorded as a DEPLOY row) but is **always** `applied:false` with reason
`commit_required`, whatever else the tx holds.

**The first valid reveal registers the ticker, by block order `(height, tx index)`.** Two
valid REVEALs of one ticker in one block: the lower tx index registers it
and the other is `ticker_taken`. Nothing else gives priority — not the
age of the COMMIT, not its tx index.

**A commit is single-use.** Any tx that spends a recorded carrier
consumes its COMMIT: a REVEAL (applied or not) or any other spend.
Its record then shows `revealed` with the spending tx (a COMMIT that had
already expired stays `expired`, with the spend recorded).
A COMMIT whose carrier is still unspent once block commit height +
`MAX_COMMIT_AGE` is processed is `expired`. Closed records — `revealed`,
`expired`, `invalid` — are kept for 2,016 blocks after they close (at the
spend height, the last reveal height, or the commit height respectively)
and then dropped; a REVEAL that spends the carrier of a dropped record
fails with `no_commit` (it could not have applied anyway). Commit records
are chain state: they are part of the snapshot and are reverted with it
on a reorg, like every balance.

**Deployer attribution (consensus — every indexer reports it as the
token's `deployer`, wherever it shows the token or its DEPLOY):**
`tokens[ticker].deployer` is the **committer** — the address of the commit
carrier that the registering REVEAL spent as its input 0. No witness is
read for it. Spending the carrier needs a signature of that address's key,
but not necessarily a signature over the REVEAL: a `SIGHASH_SINGLE |
SIGHASH_ANYONECANPAY` (0x83) signature — the signature of every §7 listing
— covers input 0 and output 0 only, so whoever holds one for a carrier can
append a REVEAL payload and the fee output and name the carrier's owner as
the deployer of a ticker that owner never chose. The COMMIT's author picks
the carrier's address, so this needs no cooperation beyond such a
signature. The reference order book therefore never lists the carrier of
an `open` COMMIT, nor of an `expired` one while its last reveal block
(commit height + `MAX_COMMIT_AGE`) has fewer than `FINAL_DEPTH` (6)
confirmations: a reorganization that replaces that block reopens the
COMMIT (§3.1, §7.4). A wallet should sign an output it received from a
COMMIT only with `SIGHASH_ALL` / `SIGHASH_DEFAULT` until that COMMIT is
closed, and after an expiry only once that last reveal block is final. A
DEPLOY row that is not applied names the committer of the carrier its
input 0 spent, or no one when input 0 spent no recorded carrier.

Reference REVEAL layout: `input0` = the commit carrier, then funding
inputs; `vout0` 546 → deployer (proof), `vout1` 5,460 → fee, `vout2`
OP_RETURN, `vout3+` change. The carrier is a 546-sat output, so the §4
fee-input filter never selects it: the builder adds it explicitly as
input 0.

A REVEAL carries no routing index. Any token inputs — a carrier spent as
funding by mistake, or tokens that default routing put on the commit
carrier — route to the **default output** (§4 rule 3): in the reference
layout `vout0`, the 546-sat proof output the deployer's own wallet
controls, so the tokens are merged there and stay spendable.

Test vectors (`H` of a REVEAL payload `P` under a carrier script `S`):

| exact REVEAL payload `P` | carrier scriptPubKey `S` (hex) | `H` = SHA-256(`P` ‖ `S`) |
|---|---|---|
| `LUCKY-20\|DEPLOY\|LUCKY\|000102030405060708090a0b0c0d0e0f` | `51200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20` | `1ac55b4c608ed7c39eb3dbcecaf04c41222d5b3c37b6343477c9a91d4a6f33fc` |
| `LUCKY-20\|DEPLOY\|A\|ffffffffffffffffffffffffffffffff` | `0014aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | `23a7e7701311711134d6030a759630a39356203ad6306a246affe3a2fc4341b3` |
| `LUCKY-20\|DEPLOY\|ZZZZ9999\|0123456789abcdef0123456789abcdef` | `5120bd9510c3a0d82a3fc259cafc53057aa4cac55d83617d916358a8c3f6d60a85dc` | `b96eda80c8d519579fa3c882e590f8cbbc3d7d0fb6a6deeb8aa4abed78781a64` |
| `LUCKY-20\|DEPLOY\|LUCKY\|000102030405060708090a0b0c0d0e0f` | `0014bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` | `740566381d71cf04e3ce2d5ffe62c03e65b13becf27bf963cd40e385d2e2bdf4` |

The last row is the first payload under another script: the same
payload, another `H`. That is why a copied `H` is useless.

Why two steps: a DEPLOY that names its ticker in the clear can be copied
from the mempool and confirmed first by anyone paying a higher fee. A
COMMIT shows only `H`, a hash of the salted payload and of the
committer's carrier script. A REVEAL is valid only through a COMMIT of its
`H` confirmed in an earlier block, only when it spends that COMMIT's own
carrier as input 0 (rule 1), and only when that carrier's script is the
one `H` covers (rule 2):

- a copy of someone's `H` in the copier's own COMMIT — confirmed before
  or after the owner's COMMIT, in any block order — can never register
  anything: the copier's carrier has another script, and he does not
  even know the ticker and salt. The owner's COMMIT is not affected in
  any way and stays `open`;
- someone who learns the ticker and salt from a REVEAL in the mempool can
  copy that REVEAL, but from his own inputs it is `no_commit` (it does not
  spend the owner's carrier) and through his own carrier holding the
  owner's `H` it is `hash_mismatch`. He can commit an `H` of his own for
  that payload, but it must first confirm in a block of its own; by then a
  REVEAL sent with a fast fee has normally confirmed, and his later
  REVEAL is `ticker_taken`.

So a wallet checks the indexer's record of its COMMIT right before
publishing: the COMMIT must be `open`, its recorded `H` must be the `H` of
the payload it is about to send under its own carrier script, and its
committer its own address; an `invalid` COMMIT is never published — the
wallet reserves again with a new salt. It publishes the REVEAL with a fast
fee, keeps it replaceable (RBF) so it can be sped up, checks that the
ticker is still free, and builds it as a version-2 transaction whose
input 0 has `nSequence` = 1, a BIP-68 relative lock of one block: no
chain, not even one rebuilt by a reorganization (§3.1), can then confirm
it in the COMMIT's own block, where it would fail `commit_too_recent`
(rule 4), use the COMMIT up and leave the ticker public. Nodes refuse
such a REVEAL until its COMMIT has confirmed and drop it when a
reorganization puts the COMMIT back in the mempool; the wallet then
publishes it again, with the same salt, once the COMMIT confirms again.
The reference client publishes only once its COMMIT has 2 confirmations,
and stops offering the REVEAL when fewer than 6 blocks of the
2,016-block window remain.

### 2.2 MINE — `LUCKY-20|MINE|<TICKER>`

The yield output index and the change output index are both `0` and
**implicit** (not encoded). The yield is credited to `vout0`; any residual token input pool
— **every ticker in it**, not only `<TICKER>` — also routes to `vout0`.

Consensus fee rule: at least one output paying **exactly 546 sats** to
`PROJECT_FEE_ADDRESS`.

Validity — the rules are checked in this order, and the first one that
fails is recorded as the MINE's `reason`:

1. the ticker is registered at apply time — else `not_deployed`;
2. the ticker was registered in an EARLIER block: the MINE's height is
   greater than the ticker's DEPLOY height — else `deploy_same_block`. A
   MINE in the DEPLOY's own block does not count, whether it comes before
   or after the REVEAL in that block (one the block lists before the
   REVEAL already fails rule 1 and is `not_deployed`): nobody, the
   deployer included, mines in the block that makes the ticker public
   (§0);
3. an output pays exactly 546 sats to `PROJECT_FEE_ADDRESS` — else
   `fee_missing`;
4. `vout0` exists and is not an OP_RETURN — else `vout0_unusable`.

Invalid → recorded with `status:"invalid"` and its `reason`, yield 0,
nothing minted.

A wallet offers MINE once the ticker's DEPLOY has 2 confirmations. A
MINE sent at its first confirmation can, after a one-block
reorganization (§3.1), confirm before the DEPLOY or in the DEPLOY's own
block (`not_deployed` or `deploy_same_block`), and it pays its fees
either way.

**Residual routing is independent of validity:** for EVERY parseable
MINE — valid or `invalid` (undeployed ticker, ticker deployed in the same
block, missing fee) — any token
input pool routes to `vout0`, exactly as a SEND's residual routes to
`CHANGE_OUT` whether or not the SEND is `applied`. Only when `vout0`
itself is missing or an OP_RETURN does the residual burn (§4) — there is
no fall-back to the default output for a MINE. An implementation that
burns the residual of an invalid MINE, or that burns the other tickers
in the pool, diverges. The normative table is §4.1.

Reference layout: `vout0` 546 → miner (yield output), `vout1` 546 → fee,
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
| 3 | 546 | sender | `CHANGE_OUT` — the **residual output, always present** (even when the residual is 0) |
| 4 | change | sender | BTC change, **optional** — dropped when sub-dust; it never carries tokens |

The residual output is a separate 546-sat output so that tokens never
ride on a large BTC change output: a wallet that later
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

`block_hash` is the hash of the block that **confirms the MINE tx**, in
its standard **display form**: the double-SHA256 of the block's 80-byte
header, **byte-reversed** — exactly the string `getblockhash`,
`getblockheader` and every block explorer print (it starts with the
proof-of-work zeros). Hashing the header and hex-encoding the digest
WITHOUT reversing it gives the internal byte order, whose last hex
character is almost always `0` (the zeros are at that end) — an
implementation that reads it credits 100 for nearly every MINE and
diverges. The real-header vectors below pin the order.
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
"Later" is block order (§5): with 700 tokens left and three valid MINEs of
the ticker in one block whose hash ends in `c` (tier 500), the first MINE
the block lists is credited 500, the second 200 — that block is the
`minted_out_height` — and the third 0 with `cap_exhausted:true`. The
Bitcoin miner who builds the block sets that order (usually by feerate),
so near the cap an earlier broadcast does not mean an earlier place.

**`minted` and "minted out".** The registry's `minted` is the
**cumulative credited yield** — the sum of every settled
MINE's `yield_smallest` — and **no burn lowers it**. A token is **minted
out** (100%) the moment `minted == supply`; the height of the MINE whose
credit completed it is recorded once as `minted_out_height`. Tokens that
are later burned by the routing rules (§4), sent to an unspendable output
or otherwise destroyed do **not** lower `minted` and do not reopen the mint:
minted out is judged on `minted` alone — never on circulating balances or
holder counts — so no burn or unspendable output undoes it. Like all protocol
state, `minted`, "minted out" and `minted_out_height` follow the chain: a
reorg that disconnects credited MINEs takes them back with their blocks,
and a token whose crossing MINE is disconnected is minting again until the
new chain crosses (§7.4). Minted out is the condition under which a
token's market opens, once the block that completed the supply has 6
confirmations (§7.4).

Golden vectors:

| last hex char | yield |
|---|---|
| `0` `6` | 100 |
| `7` `b` | 200 |
| `c` `e` | 500 |
| `f` | 1000 |
| `F` (uppercase input) | 1000 |

Real mainnet blocks (the display hash recomputed from each block's
header):

| height | display `block_hash` | yield |
|---|---|---|
| 0 | `000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f` | 1000 |
| 1 | `00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048` | 200 |
| 2 | `000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd` | 500 |
| 4 | `000000004ebadb55ee9096c9a2f8880e09da59c0d68b1c228da88e48844a1485` | 100 |

### 3.1 Reorganizations and finality

LUCKY-20 state is a function of the chain Bitcoin keeps, the best chain.
Now and then Bitcoin replaces its newest blocks with a competing branch (a
reorganization). An indexer then takes back every effect of the blocks
that left the chain — credits, balances, registrations, commit records,
fills — and applies the blocks of the new branch by the same rules, in
their order (§5). Nothing carries over from a disconnected block:

- a MINE that confirms again in another block is credited from **that**
  block's hash (§3): its tier can change, and near the cap its credit can
  change or become 0, because the new block may hold other MINEs or list
  them in another order;
- `minted` and "minted out" follow (§3): a reorganization can lower
  `minted`, and a token whose crossing MINE is disconnected is minting
  again until the new chain crosses;
- registrations, SENDs and fills follow the block order of the new chain
  (§2.1, §7.5), and a transaction that does not confirm again has no
  effect at all.

A block's effects are **final** once it has `FINAL_DEPTH` (6)
confirmations; a reorganization that deep is not expected on Bitcoin outside
a failure of the network itself. Until then every result in it is
provisional: the reference
client shows a MINE's credit, a registration, a fill or a withdrawal with
its confirmation count (for example "1/6 confirmations") until it is final,
keeps checking it meanwhile, and explains a changed result as a
reorganization. A wallet should treat a result as settled at 6
confirmations, about an hour. A token's market opens only when the block
that minted it out is final (§7.4), so a reorganization shallower than
that can no longer change the amount any listing sells.

## 4. Token routing rules

1. **Input pool**: for every tx (protocol or not), tokens on spent
   token-bearing UTXOs are gathered into a per-ticker input pool.
2. **Protocol tx**: MINE routes the pool (every ticker) + yield to
   `vout0`, burning it only when `vout0` is missing or an OP_RETURN; SEND
   routes per §2.3 (only `<TICKER>` moves; the residual of every ticker
   goes to `CHANGE_OUT`, falling back to the default output when
   `CHANGE_OUT` is unusable); COMMIT and DEPLOY carry no routing index,
   so their token inputs go to the default output (rule 3).
   **Per-ticker note:** a tx may spend UTXOs of several
   tickers; there is no multi-ticker burn. The routing decision is made
   once per tx and applied to every ticker in the pool — only a SEND's
   `AMT` is ticker-specific.
3. **Default routing**: a tx
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
   exactly 546 sats — any non-OP_RETURN output is a valid carrier
   **whatever its value, 0 sats included** (a 0-sat output is
   non-standard but valid in a block), and indexers must credit whatever
   index the rules name regardless of its value; a COMMIT carrier (§2.1)
   is judged the same way. The 546-sat carrier (`DUST_SATS`) is a
   **wallet convention** (Bitcoin Core's standardness dust floor for
   P2WPKH / P2TR, and the value the §2 / §7 reference layouts use for
   every token output) that keeps carriers cheap, uniform and easy to
   filter out of fee selection. Settlement is index-agnostic; nothing
   in the rules depends on how many outputs a tx has beyond the indices
   they name.

### 4.1 Routing table (normative)

Where the **residual input pool** goes — every ticker the tx's inputs
carried, after a SEND's `AMT` has been taken out — for every kind of tx
at or above `ACTIVATION_HEIGHT` (earlier txs are not processed at all).
"Default output" = the lowest-index non-OP_RETURN output (rule 3).
Rules 1–5 above and §2.1–§2.3 are explanatory; where they and this
table could be read differently, the table is authoritative.

| Payload | Case | `<TICKER>` named by the payload | Every other ticker in the pool |
|---|---|---|---|
| `MINE\|T` | valid (settled; includes `cap_exhausted`) | yield + residual → `vout0` | → `vout0` |
| `MINE\|T` | invalid: undeployed ticker, ticker deployed in this same block, or no exact 546-sat fee output | residual → `vout0` (no yield) | → `vout0` |
| `MINE\|T` | `vout0` missing or an OP_RETURN (also invalid) | **burn** | **burn** |
| `SEND\|T\|AMT\|TO\|CH` | applied: pool ≥ `AMT`, fee output present, `vout[TO]` real and not OP_RETURN | `AMT` → `vout[TO]`, residual → `vout[CH]` | → `vout[CH]` |
| `SEND\|T\|AMT\|TO\|CH` | not applied: pool < `AMT`, no fee output, or `vout[TO]` missing / OP_RETURN | whole pool → `vout[CH]` | → `vout[CH]` |
| `SEND\|T\|AMT\|TO\|CH` | `vout[CH]` missing or an OP_RETURN (applied or not — when applied `AMT` still goes to `vout[TO]`) | residual → default output | → default output |
| `COMMIT\|H` | recorded `open` or `invalid` | → default output | → default output |
| `DEPLOY\|T\|SALT` (REVEAL) | applied or not (any `reason`, §2.1) | → default output | → default output |
| `DEPLOY\|T` (three-field form) | always `applied:false` (`commit_required`) | → default output | → default output |
| none | no OP_RETURN, an unparseable push, another protocol's payload, or a `LUCKY-20` push that does not parse (a five-field SEND, a bad ticker, a DEPLOY salt that is not 32 lowercase hex, a COMMIT hash that is not 64 lowercase hex, an opcode other than `COMMIT` / `DEPLOY` / `MINE` / `SEND` such as `AVATAR`, §8, …) | → default output | → default output |
| any row that says "default output" | the tx has no non-OP_RETURN output, or its lowest-index one is address-less (P2PK, bare multisig, non-standard) | **burn** | **burn** |

**Per-ticker note:** there is no multi-ticker rule. A tx may
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
inscription UTXOs) AND exclude every outpoint the indexer reports as
token-bearing. A UTXO list that is not
asset-safe (§6) additionally excludes every output of **10,000 sats or
less** — ord's default postage, the most likely size of an Ordinals or
Runes carrier — and is selected **largest-first**, so a postage-sized
output above that floor is a last resort rather than the first pick. Default routing makes an
accidental spend recoverable only when the first output is the wallet's
own; it merges the tokens onto whatever that output is. Concretely, a
546-sat carrier spent as a fee input lands its tokens on: `vout0` of a
COMMIT (the commit carrier) or of a DEPLOY (the 546-sat proof output the
wallet controls — merged, still spendable); `vout0` of a MINE (the miner's yield output,
by §2.2); `CHANGE_OUT` of a SEND or fill (the sender's / buyer's residual
output); and the **payee** of any plain payment. Never the project fee
output: it is never the lowest-index output in a reference layout.

## 5. Indexer interface

An indexer applies §2–§4 and §7 to the chain and keeps the state they
define: token balances per UTXO, the token registry with its `minted`
count (§3), the commit records (§2.1), the order book and the trade
history (§7).

**Block order.** Transactions apply in chain order: block by block, and
inside a block in the order the block lists them (position 0 is the
coinbase, never a protocol tx, §2). Every transaction sees the state that
every earlier one left — balances, `minted`, the registry, the commit
records, the order book — so which of two MINEs receives the last tokens
of a ticker (§3) and which of two REVEALs registers a ticker (§2.1) are
decided by that order and by nothing else. An implementation that reorders
a block's transactions (by txid, by fee, …) diverges. After a
reorganization the new blocks apply in their own order (§3.1).

How an indexer makes that state available is not part of the protocol.
The reference indexer's HTTP interface serves the reference web app only;
it is not published and may change without a revision of this document.

Nothing in this document depends on that interface. Every rule is stated
in terms of Bitcoin transactions and the state derived from them, so an
independent implementation can reproduce every balance, registration and
settlement from the chain alone and compare (§7.6). Where this document
names a field of that state (`minted`, `minted_out_height`, a commit's
`status`, an order's `pending_fee_sats`, …), it names the state, not a
wire format.

## 6. Web wallet contract (UniSat, OKX Wallet)

The web app holds no keys. It builds an unsigned PSBT and hands it to the
connected wallet's `signPsbt`, then `pushPsbt`/`pushTx`. Supported
providers: `window.unisat` (UniSat extension and the UniSat app's
browser) and `window.okxwallet.bitcoin` (OKX Wallet extension and the OKX
app's DApp browser; UniSat-compatible API — `connect()` returns
`{ address, publicKey }`, `pushTx` takes a raw hex string). Inputs come
from `unisat.getBitcoinUtxos()` when available (UniSat's own asset-safe
UTXO list), else the indexer's confirmed BTC UTXO set for the address —
OKX
Wallet exposes no asset-safe list, so the app warns OKX users to use an
address that holds no Ordinals/Runes. In every case inputs are filtered
by the builder obligation in §4 — a 546-sat carrier must never be a fee
input, because default routing would hand its tokens to the tx's first
output (§4 lists where that is for each opcode) — and a list that is not
asset-safe gets the 10,000-sat floor and largest-first selection of §4.
The indexer's confirmed set changes only when a block is applied, so
the reference client also excludes the inputs of its own broadcasts
until they confirm or leave the mempool: re-spending one would replace
the earlier transaction (full-RBF) — e.g. a listing withdrawal (§7.3)
undone by the next MINE. For P2TR (bc1p) inputs
the PSBT must carry `tapInternalKey` (x-only form of `unisat.getPublicKey()`);
for P2WPKH (bc1q) a `witnessUtxo` suffices. The fee output and the
546-sat token outputs (recipient, residual) are exact amounts from §1 and
are always emitted — a SEND's residual output (`vout3`) and a fill's
(`vout4`) exist even when the residual is 0. The BTC change output is
appended last and is optional: when it would be sub-dust the builder
drops it and lets the difference go to the network fee. It never
carries tokens, so dropping it costs no tokens.

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
  — at least 546: 546 for a fresh carrier, more for a SEND change
  output), the PSBT `sighashType` field = `0x83`, and, for P2TR,
  optionally `tapInternalKey` (kept only when it tweaks to the output
  key, §7.4).
- `output0` — `price_sats` to **the same script as `input0`** (the seller
  pays themself). `price_sats ≥ 546` **and `price_sats ≥
  witnessUtxo.value`** (the carrier's own BTC value).

The seller signs `input0` with **`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`
(0x83)** and does NOT finalize (UniSat: `signPsbt(hex, { autoFinalized:
false, toSignInputs: [{ index: 0, address, sighashTypes: [0x83] }] })`).
That signature commits to `input0` and `output0` only, so any number of
inputs/outputs may be appended without invalidating it — the seller
gives up the UTXO only in a tx that pays `output0` in full. **Every sat on
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
| 1 | 546 | buyer | token output (`TO_OUT`) |
| 2 | 546 | `PROJECT_FEE_ADDRESS` | SEND consensus fee |
| 3 | 0 | OP_RETURN `LUCKY-20\|SEND\|<TICKER>\|<AMT>\|1\|4` | `TO_OUT = 1`, `CHANGE_OUT = 4` (§1 prefix — a fill built with any other prefix is not a SEND: default routing (§4 rule 3) sends the tokens to `vout0`, i.e. back to the seller, who keeps the price as well) |
| 4 | 546 | buyer | **residual output, always present** (`CHANGE_OUT`) — same rule as §2.3's `vout3`: the build must never drop it |
| 5 | change | buyer | BTC change, **optional** — dropped when sub-dust; never carries tokens |

`CHANGE_OUT` must differ from `TO_OUT` (§2.3 grammar); the residual output
is a separate 546-sat output so that any residual of the input pool
(the listed carrier is the only token input a well-formed fill has, so
normally 0 — but every ticker of every token input the buyer may have
added by mistake) lands on a 546-sat carrier the buyer controls, not on
the buyer's BTC change. The buyer
signs inputs `1..n` (UniSat, `autoFinalized: true`), then the app
finalizes `input0` from the seller's signature, extracts the raw tx and
broadcasts it. If two buyers race, exactly one tx can confirm. Nodes relay
replacements by fee (full-RBF): the later fill replaces the earlier one in
the mempool when it pays enough more (BIP125 rules 3 and 4) and is refused
otherwise. The buyer whose fill does not confirm spends nothing, but a fill
that was accepted can still leave the mempool, replaced — a client shows
it as replaced, not as filled, and nothing is filled until a fill
confirms.

**Buyer-side verification (mandatory, client-side, before signing):**
1. the listing PSBT has exactly 1 input + 1 output;
2. `input0.sighashType == 0x83` and a signature is present
   (`tapKeySig` for P2TR, `partialSig` for P2WPKH);
3. the indexer still shows the order `open` (not `filling`, §7.3), the
   ticker's market is open (§7.4: the block that minted it out has 6
   confirmations — the indexer can still hand out a listing of a ticker
   whose market is closed, for example after the state went back to an
   earlier height), and the indexer still lists the outpoint among the
   seller's token UTXOs with
   `{ TICKER: amount }` — **and the outpoint is re-checked against a
   second source** the indexer does not control (the creating tx from
   the wallet's own node or an explorer: its output script and value
   must match `witnessUtxo`,
   and its `OP_RETURN` re-parsed — a MINE carrier is `vout0`, and
   `amount` must be exactly what §3 credits it: the yield recomputed from
   the confirming block hash, or — only when that block is the token's
   `minted_out_height` (the MINE that crossed the supply cap) — the
   partial credit `min(yield, remaining)`, a positive multiple of 100
   below the yield; any other amount is a disagreement. A SEND carrier is
   either its `TO_OUT` (then `AMT` must equal `amount`) or its
   `CHANGE_OUT` residual output (§2.3 / §4.1 — the amount on a residual
   output depends on the inputs, so only the output index is checked); any other
   vout, another opcode, or no LUCKY-20 payload at all is a
   disagreement). The client fails closed when the two disagree (§7.6).
   The second source sees scripts, values and payloads, never token
   state, so it cannot confirm an amount the creating tx does not state:
   a partial credit (its `remaining` is registry state) or a residual
   output (its amount depends on the inputs); and whether a SEND applied is
   always the indexer's statement (§7.6). When the second source cannot
   confirm the amount, the client shows **"amount not independently
   verified"** and signs only after an extra explicit confirmation from
   the buyer. A carrier the indexer reports with 0 tokens of the ticker
   is never buyable (the order book refuses `amount` 0, §7.4, and the
   client re-checks that the indexer's amount is > 0 before signing);
4. `output0.value == price_sats` and `output0.script == input0.script`;
5. `witnessUtxo.amount ==` the carrier value (`carrier_sats`) the indexer
   reports for the order.

### 7.3 Cancel = spend the UTXO

A signed listing is a bearer instrument: anyone who saved the PSBT can
still fill it, so an off-chain "cancel" is meaningless. The only real
cancel is to **move the tokens on-chain** (a SEND-to-self of that UTXO,
§2.3), signed by the seller's wallet with its ordinary signature type —
any type but the listing's `0x83`; such a spend is never a fill (§7.5).
Re-listing the same outpoint at a LOWER price replaces the order in the
book but does NOT invalidate the earlier signed PSBT; the UI must say
so. A HIGHER price is refused as long as a cheaper signed listing of the
outpoint can be filled — while it is live, and after the book dropped it
(its listing floor, §7.4): the seller withdraws first — spends the
outpoint — and lists the new carrier. The indexer records whatever actually confirms (§7.5).

**`filling` — a spend is in the mempool.** On every poll
tick the indexer asks the node which live listings' outpoints are spent
by a mempool tx (`gettxspendingprevout`, batched) and, for each such tx,
its fees and size (`getmempoolentry`, re-read every tick). The order then
shows `status: "filling"` with `pending_spend_txid`, `pending_fee_sats`,
`pending_vsize` and `pending_feerate` (sat/vB, two decimals) — whether
the pending tx is a fill or the seller's own cancel. `pending_fee_sats`
is the **descendant-package fee** (`getmempoolentry.fees.descendant`:
the pending tx's fee plus every in-mempool descendant of it — a child
spending the fill's BTC change, or a pinning attacker's children), because
BIP125 rule 3 makes a replacement pay for everything it evicts, not only
the conflicting tx; `pending_feerate` is the pending tx's OWN feerate
(`fees.base / vsize`, what rule 6 compares). A child attached later moves
`pending_fee_sats` without changing `pending_spend_txid`. A `filling`
order:

- is NOT `open`: the book's open asks, and every figure derived from
  them (the open-order count, the floor price, the listed amount),
  exclude it, and a new listing of its outpoint is refused (a buyer must
  not be handed a listing that is already being taken);
- reverts to `open` (fields cleared) when the spend leaves the mempool
  without confirming — evicted, or replaced by a tx that no longer
  touches the outpoint; a replacement that still spends it just refreshes
  the fields with the new txid / fee;
- becomes `filled` or `cancelled` through §7.5 when the spend confirms,
  exactly as an `open` order would — the confirmed tx decides, whatever
  the mempool said;
- is kept past its TTL (§7.4) and is the last thing the global cap evicts,
  so its trade record cannot be dropped while the spend is pending;
- keeps its `updated_at` / `expires_at`: mempool observations are not
  seller actions and never refresh the TTL.

A buyer's fill that pays a fee too low for the current market can sit in
the mempool for up to two weeks (default mempool expiry), and while it
does another fill of that listing replaces it only by paying for
everything it evicts plus the incremental relay fee (BIP125 rules 3
and 4) — the seller's tokens are pinned. This is inherent to
SINGLE|ANYONECANPAY listings (Ordinals markets have it too); the
`pending_*` fields exist so the seller can get out. **Cancel fee
guidance:** the cancel (a SEND-to-self of the outpoint, §2.3) is a BIP125
replacement of the pending tx and is only relayed when it pays

- a feerate ≥ `pending_feerate + incrementalrelayfee` (sat/vB; the
  node's incremental relay fee), and
- an absolute fee ≥ `pending_fee_sats + cancel_vsize × incrementalrelayfee`
  sats (BIP125 rule 3/4 — the replacement must pay the fees of everything
  it evicts, the pending tx AND its descendants, plus the bandwidth of the
  replacement itself),

so the reference client sizes a cancel at
`max(halfHourFee × cancel_vsize, pending_fee_sats + cancel_vsize ×
(pending_feerate + incrementalrelayfee))` sats and shows the number; the
node's `insufficient fee, rejecting replacement` is the message to map
when it is still too low. Because a pending fill's absolute fee can be
large (a ~99 kvB tx at 1 sat/vB is ~100,000 sats), short-lived listings
and re-listing rather than leaving asks up for the full 14 days limit the
exposure. A pinning fill costs its sender something only if it confirms:
then the attacker pays the listed price plus that fee and receives the
tokens. If the seller's cancel replaces it, or it is evicted or expires,
the attacker pays nothing and the seller has paid for the replacement —
pinning is a nearly free way to delay a seller, which is one more reason
for short-lived listings.

The race runs the other way too: a cancel waiting in the mempool is
itself replaceable. Whoever saved the signed listing can replace the
cancel with a fill of it that pays more (full-RBF, the same BIP125
rules), and the order then shows that fill's `pending_spend_txid`. The
transaction that confirms decides (§7.5); if the fill does, the seller is
paid the listed price. A higher cancel fee only raises what such a fill
must pay; it cannot rule it out. A seller who sees their cancel replaced
can cancel again at a higher fee (the guidance above).

### 7.4 Indexer order book

A listing is submitted to the indexer as the signed PSBT together with
its `ticker`, `amount` and `price_sats`. The indexer accepts it only if
ALL of the following hold; otherwise the listing is refused and the book
is unchanged:

- **the token's market is open** — the token is minted out, `minted ==
  supply` (§3), and the block of the MINE that completed the supply
  (`minted_out_height`) has at least **6 confirmations**: the market opens
  when the indexed chain reaches height `minted_out_height + 5`. A listing
  for a ticker whose market is not open is refused before the PSBT is even
  parsed, and while it is not open the book shows none of the ticker's
  listings. Rationale: the market opens when minting is complete — while
  supply can still be mined at the fee, a listing would price something
  anyone can mint instead, and it would let a deployer sell into a
  distribution that is not finished — and once the blocks that completed
  it are deep enough that a reorg is unlikely to change the amounts the
  listings sell (a reorg can change the yield of every MINE it moves).
  The gate is judged on the cumulative `minted`, so once a token's market
  is open it does not close again: later burns or unspendable outputs do
  not count, and a reorganization would have to replace at least
  `FINAL_DEPTH` (6) blocks to take back the MINE that minted it out
  (§3.1). The gate is re-checked when the order is inserted all the same.
  A client can hide the market until it opens;
- PSBT decodes; exactly 1 input, 1 output; `nLockTime == 0`;
- **the listing can be filled at all** — the seller's
  `0x83` signature commits to the tx version and to input 0's
  `nSequence`, so a fill inherits both:
  - unsigned tx `nVersion` is 1 or 2 — a listing with any other version
    can never be filled;
  - input 0 `nSequence` has the BIP-68 disable flag set (`≥ 0x80000000`
    — this includes `0xfffffffd`, `0xfffffffe` and `0xffffffff`); any
    other value sets a relative timelock that keeps the listing from
    being filled;
- `input0` outpoint is in `utxo_balances` with balances exactly
  `{ ticker: amount }` (single ticker, whole balance);
- `gettxout(txid, vout)` (mempool-aware) returns the output — an
  outpoint that is spent, or has a pending spend (including one the book
  already shows as `filling`, §7.3), is refused; its value and
  scriptPubKey equal the PSBT's `witnessUtxo`;
- `output0.script == witnessUtxo.script` and `output0.value ==
  price_sats ≥ 546`; **`price_sats ≥ witnessUtxo.value`** (BTC above
  price on the carrier goes to the buyer, §7.1); **`price_sats ≤ amount ×
  1e8`** (at most 1 BTC per whole token); `1 ≤ amount ≤ 21_000_000`;
- **`witnessUtxo.value ≥ 546`** — the listed output holds at least 546
  sats; a smaller one is refused ("listed output holds fewer than 546
  sats; send the tokens to a 546-sat carrier first"). A buyer-side client
  that builds only standard 546-sat carriers could not fill it, so it
  would sit in the book as a floor nobody using such a client can take;
- **price band**: when the ticker has at least one other
  `open` ask, the new ask's unit price must be **≤ 100 × the current best
  (lowest) open ask**; a higher one is refused. The comparison is exact
  (`price_sats × best.amount ≤ 100 × best.price_sats × amount`, in
  integers), so an ask at exactly 100× is accepted. A new listing of the
  same outpoint is measured against the other asks only, and a ticker
  with no other open ask has no band (only the absolute 1 BTC/token cap
  applies). The band applies to every ask, one priced at its carrier's
  own value (the least price §7.1 allows) included — exempting it would
  let a seller fill their own one-token listing from a second address and
  print a trade at any unit price. A carrier whose whole balance is too
  small to be listed inside the band is listed after combining carriers
  (a SEND to self): at a best ask of `b` sats per token, a carrier listed
  at `p` sats needs at least `⌈p / (100 × b)⌉` tokens. While a far
  cheaper ask is open, such a small listing would not sell anyway;
- `input0.sighashType == 0x83`, and the signature **verifies** against
  the prevout: P2TR key-path → Schnorr over the BIP-341 key-spend
  signature hash of input 0 for sighash type 0x83 (`SIGHASH_SINGLE |
  SIGHASH_ANYONECANPAY`: it commits to input 0's own prevout and to
  output 0) with the witness-program x-only key; P2WPKH → ECDSA over the
  BIP-143 signature hash of input 0 for the same type, with the
  `partialSig` key whose hash160 is the witness program. Other script
  types are rejected;
- **the seller address has fewer than 10 open orders** (the per-seller
  cap, below); a listing that replaces an open listing of the same
  outpoint is exempt;
- **not a reserved output**: the outpoint is not the
  carrier (`txid:0`) of a COMMIT whose record is `open`, or `expired`
  while its last reveal block has fewer than `FINAL_DEPTH` (6)
  confirmations (§2.1). A listing's 0x83 signature covers input 0 and
  output 0 only, so a buyer could complete it into that COMMIT's REVEAL
  and publish the ticker with the seller named as its creator (§2.1
  deployer attribution); the seller first moves the output with a SEND to
  self, or publishes the ticker;
- **one outpoint, the cheapest signed listing**: when
  the book holds an `open` listing of the same outpoint at a LOWER unit
  price, the new listing is refused — the cheaper PSBT stays valid until
  the outpoint is spent, so hiding it behind a higher ask would mislead
  buyers and the seller. The same price renews
  the listing; a lower price replaces it. To raise a price the seller
  withdraws first (spends the outpoint, §7.3) and lists the new carrier.
  **Listing floor**: a live listing that leaves the book
  while its outpoint is unspent — expired by the TTL or evicted by a cap,
  below — still counts. The book remembers its unit price, its seller
  and its carrier's value as the outpoint's listing floor (the lowest
  such price) and refuses a pricier listing of the outpoint the same
  way; a listing at or below the floor is accepted and replaces it. The
  signed PSBT of a floor still fills at its price: a fill of it is
  recorded as a trade (§7.5), and the seller's own list of orders shows
  every floor whose outpoint the seller still holds as `expired`, so the
  seller can withdraw it (spend the outpoint, §7.3). A floor stops
  applying once the outpoint is spent and is dropped when that spend is
  12 blocks deep (`REORG_HORIZON` — a reorg that restores the outpoint
  before then finds it in place); at most 20,000 floors are kept — past
  that, floors of spent outpoints are dropped first, then the oldest.

**Capacity and lifetime (never a permanent "book full"):**

- **TTL**: an open order expires **14 days after `updated_at`** and is
  dropped from the book (the order's `expires_at`); its price stays the
  outpoint's listing floor (above), because its PSBT can still be filled
  — and a fill of it is still recorded (§7.5). Re-submitting the same
  PSBT refreshes it for free — it replaces the entry and counts against no
  cap; at the **same `price_sats`** it keeps its `created_at`, i.e. its
  place among equal-priced asks (the book is ordered `unit_price` asc,
  `created_at` asc), while a lower re-price (the only kind accepted for a
  live listing, below) is a new ask (`created_at` = now) that queues
  behind the others at that price. A client should re-submit open
  listings it still wants shown. A
  `filling` order is exempt while its spend is pending (§7.3); it expires
  on the next tick after reverting to `open`.
- **Global cap 50,000** orders (any status): when full, the oldest closed
  (filled / cancelled) orders are evicted first, then the **open order
  with the oldest `updated_at`**, and only after every open one a
  `filling` order. A listing is a bearer PSBT the seller can re-submit at
  any time, so eviction destroys nothing in the book (a rebuild cannot
  re-derive an evicted order's fill, §7.5); an evicted live listing
  leaves its listing floor.
- **Per-ticker cap 7,500 open orders**: the book keeps a ticker's 7,500
  best asks. A new ask that undercuts the worst (highest unit price)
  evicts it (leaving its listing floor); one that does not is refused
  with the price it must beat. A listing that replaces an open listing
  of the same outpoint is neither refused nor evicts another ask.
- **Per-seller cap 10 open orders**: a seller address that already has
  10 open listings cannot add another until one of them fills, is
  withdrawn or expires (re-pricing an existing listing is not a new one).
  A `filling` order is not an open one, so an address can briefly hold
  more than 10 open listings when a fill leaves the mempool unconfirmed
  (§7.3); it can still renew or re-price each of them, and it adds a
  new one once it is below 10 again.

Order identity is the outpoint (`id = "txid:vout"`); a new listing of an
open outpoint at the same or a lower price replaces it, a higher one is
refused (above). Orders are
runtime data the indexer keeps outside the chain-derived snapshot — they
are NOT part of it. While the book cannot be persisted a new listing is
refused, since a listing held only in memory would vanish with a restart.
In a persisted book the `filling` status, the `pending_*` fields and the
listing floors (`floors: [{ id, ticker, amount, price_sats, dropped_at,
gone_since, seller, carrier_sats }]`) are optional, and so are a floor's
`gone_since`, `seller` and `carrier_sats`.

**Canonical listing.** The book stores and serves an accepted listing
in canonical form, rebuilt from what it verified: the unsigned tx; for
input 0 the `witnessUtxo`, the `sighashType` field `0x83` and the one
signature that verified — for P2WPKH the `partialSig` of the
witness-program key, for P2TR the `tapKeySig` plus the `tapInternalKey`
only when it tweaks (with no script tree) to the output key; nothing
else. Anything else the submitted PSBT carried (other partial
signatures, a `nonWitnessUtxo`, derivation paths, unknown or
proprietary fields, bytes after the PSBT) is dropped, not refused: it
changes nothing the signature commits to, but a buyer-side parser could
refuse it, which would leave a listing in the book that such a buyer
cannot fill.

An order holds its `id`, `ticker`, `amount`, `price_sats`, `unit_price`
(`price_sats / amount`), `seller`, `carrier_sats` (the listed output's
value), `status` (`open` | `filling` | `filled` | `cancelled`),
`created_at`, `updated_at` and `expires_at`, the settling spend once it
confirms (`spent_txid`, `spent_block`, and the `buyer` of a fill), the
four `pending_*` fields of §7.3 and the signed PSBT. The four `pending_*`
fields are set only while `status` is `filling` (§7.3) and are `null`
otherwise.

### 7.5 Fill detection and trade history

When a tx is applied (§5), after its payload has been applied and its
input pool routed (§4), every spent outpoint that matches a live (`open`
or `filling`) order is settled. Let `i` be the index of the listed
outpoint among the tx's inputs — `SIGHASH_SINGLE` pairs input `i` with
output `i`, so the seller's signature commits to `vout[i]`, which is
`vout0` only in the reference layout (§7.2, listing at `input0`). Only
the listing's own signature makes a fill; the seller's wallet signs a
withdraw, a split or a send with its ordinary signature type:

- input `i` is signed with **`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`
  (0x83)** — a P2TR key-path Schnorr signature of 65 bytes whose last
  byte is `0x83`, or a P2WPKH witness whose first element (the DER
  signature) ends in `0x83` — and `vout[i]` pays **≥ `price_sats`** to
  the seller's script → order `filled`. A trade is recorded with
  `price_sats` = the actual `vout[i]` value and `buyer` = the address of
  the output that received the listing's tokens: `vout[TO_OUT]` when
  the tx is a SEND of the order's ticker with `applied == true`,
  otherwise the output the tx's residual routed to (§4.1 — a SEND
  without its fee, a SEND of another ticker, another payload, or none).
  `buyer` is null when the tokens burned or landed on an output that has
  no address;
- any other spend → order `cancelled` (`spent_txid` set). This includes
  every spend whose input `i` carries another signature type (a 64-byte
  P2TR signature is `SIGHASH_DEFAULT`), whatever the amounts: a
  withdraw, split or send of a listed carrier is never a trade, even
  when an output at index `i` pays the seller the asked price or more.

A tx that spends several listed outpoints settles each of them this way,
each judged at its own index — a fill of two listings at inputs 0 and 1
paying their sellers at `vout0` and `vout1` records two trades.

A fill does not need the SEND fee. Routing moves the listing's tokens
whatever the payload (§4), so a buyer who leaves out the 546-sat fee
output — or the SEND itself — still receives the tokens, and the trade
is recorded all the same. On a whole-UTXO sale the fee cannot be
enforced; this is a known property of the market. The token rules are
unchanged: a SEND without its fee is still not applied (§2.3), and the
tokens follow its `CHANGE_OUT` like any residual.

A listing that left the book (its listing floor, §7.4) is settled the
same way when a spend of its outpoint is a fill: judged against the
floor's price like a live order, the trade is recorded with the floor's
seller and amount, `price_sats` = the actual `vout[i]` value and
`order_id` = the outpoint; any other spend records nothing. The floor
outlives a reorg like the order book does and is dropped only once the
spend is 12 blocks deep, so a replay within that depth records the fill
again.

Settlement is re-derivable. The order book outlives a cold rescan
and a full rebuild of the chain-derived state, while the trade log
does not, and the spend an order records may sit in a block the chain has
since left. So whenever the chain-derived state goes back to an earlier
height (a reorg, a restart, a rebuild), every order is judged again
against it (last paragraph): an order whose recorded spend lies above
that height forgets the spend, and the blocks that follow re-open it when
they re-create the outpoint with the listed balance and settle it by the
spend they contain — the same fill (its trade recorded again), another
buyer's fill, the seller's cancel, or none, and then the order stays
`open`. A trade is never recorded twice for one txid and order.
A rebuild re-derives only the fills of orders and listing floors the
book still holds. A fill whose floor was dropped (the spend 12 blocks
deep, or past the 20,000-floor cap) or whose filled order the global
cap has since evicted (§7.4) is not recorded again, so a rebuilt trade
log, and each ticker's trade count and volume, can be missing such
fills.

A trade (chain-derived; it lives in the snapshot and is rolled back with
it on reorg) holds the fill's `txid`, `block_height`, `block_hash` and
`block_time`, the `ticker`, `amount`, `price_sats`, `unit_price`,
`seller`, `buyer`, the `order_id` it settled and `self_trade`.

`self_trade` is true when `buyer == seller` — the listing's signature
took the outpoint and the tokens came back to the seller. Such fills are
recorded and listed like any other, but they do not count toward a
ticker's trade count or volume and never become its last trade — a wash
must not print a price.

On every restore (reorg, restart, or the empty state a full rebuild
starts from) every closed order whose outpoint is present again in
`utxo_balances` **carrying exactly `{ ticker: amount }`** — the whole-UTXO
balance the listing sells, not merely an entry under that key —
reverts to `open`; an order whose outpoint is not present and
whose fill the trade log holds (at or below the restored height) is
`filled` by that trade, with its `spent_txid`, `spent_block` and `buyer`
— the order book is saved apart from the chain-derived state and can be
older than it; otherwise a closed order whose recorded spend is above the
restored height and whose outpoint is not present becomes `cancelled`
with `spent_txid`, `spent_block` and `buyer` cleared, and a live order
whose outpoint is not present with that exact balance is `cancelled`
(`spent_txid: null`). An order cancelled with `spent_txid: null` is
re-opened only if the replay re-creates the outpoint with that exact
balance. A `filling` order whose outpoint is present stays `filling` until
the next tick re-checks the mempool.

An order the book cancels this way while its outpoint is still unspent —
the reorganization changed what the outpoint carries — is out of the book,
not out of reach: its signed PSBT still fills on-chain, now for whatever
the outpoint carries, until the seller spends the outpoint (§7.3). A
seller whose listing was cancelled by the book, not by a spend of their own,
moves the tokens to end it.

### 7.6 What this is not (trading)

There is no bonding curve, no pooled liquidity, no market maker and no
custody. Prices are whatever sellers ask and buyers pay, settled by the
Bitcoin network.

What the indexer can and cannot do, precisely: **a seller's funds cannot
be moved by the indexer.** A listing is valid only in a tx that pays
`output0` to the seller in full, and only the seller's key can sign it;
the indexer holds no key and can at most hide, drop or delay orders
(availability). **A buyer, however, relies on the indexer's statement
that `input0` still carries `{ ticker: amount }`.** A malicious or
compromised indexer — or anyone able to alter what it serves — could show
a buyer a listing whose outpoint no longer carries the tokens (or never
did): the buyer's fill would then pay `price_sats` to the seller and the
SEND would apply with an empty pool, moving nothing. Nothing in the
signed PSBT protects against that; only an independent view of the
outpoint does. That is why the reference client re-checks the outpoint
against a second source before signing (§7.2 step 3: the creating tx
from the wallet or another node / explorer, its output script and value,
and — for a MINE carrier — the yield recomputed from the confirming
block hash, or the §3 partial credit in the block that crossed the
cap; for a SEND carrier, that the vout is its `TO_OUT` or `CHANGE_OUT`),
fails closed when the sources disagree, and asks for an extra
confirmation when the second source cannot confirm the amount. Damage from such an attack is limited to the fills made
while it lasts; every single-indexer OP_RETURN meta-protocol shares this
property, which is also why the protocol is specified in full: anyone can
run an independent indexer and compare.

## 8. Token avatars

LUCKY-20 has **no token avatars**: no image, no avatar opcode, no avatar
fee, no avatar state. What a client shows as a token's picture is drawn
locally from public data (the reference client renders a deterministic
identicon from the ticker); it is not protocol state and no indexer
stores or serves it.

The following rules are normative for every implementation:

1. **`LUCKY-20|AVATAR|<TICKER>` is not a LUCKY-20 operation.** Its opcode
   is not one of `COMMIT`, `DEPLOY`, `MINE`, `SEND` (§2), so the push does not
   parse — whatever its field count — and is handled exactly like any
   other `LUCKY-20` push that does not parse. It is one of the "other
   OP_RETURN outputs" §2 ignores: it never becomes the protocol payload
   and never hides one, so a parseable `COMMIT` / `DEPLOY` / `MINE` / `SEND` push in
   another output of the same tx is still that tx's payload. A tx with no
   other parseable push is a plain BTC spend (§4.1 row "none"): nothing is
   recorded, no fee output is looked for, and its token inputs — every
   ticker — route to the **default output** (§4 rule 3), burning only
   when that output is missing or address-less.
2. **An inscription envelope in any input witness is ignored.** No
   operation reads input witnesses at all (deployer attribution, §2.1,
   is the committer's address). A DEPLOY whose input carries an `ord`
   envelope counts on its own merits exactly as if the envelope were
   absent: registration is decided by its OP_RETURN payload and the §2.1
   rules — a clear-text three-field DEPLOY is
   `commit_required` and never applies; the image is not validated,
   stored or served, and a malformed or oversized one changes nothing.
3. **No avatar state.** An indexer keeps and reports no avatar data: no
   avatar field on any token, no avatar count, no avatar to fetch.
