# Chain verification evidence

Every value in `packages/chain/src/chains.ts` was confirmed by querying the
network itself on **13 August 2026**. A chain ID or token address copied from a
documentation page is an unverified claim; this file records the responses that
turned those claims into facts.

Reproduce at any time with `pnpm verify:chains`.

## Chain IDs — `eth_chainId`

```
https://testrpc.xlayer.tech   ->  {"jsonrpc":"2.0","result":"0x7a0","id":1}    =  1952
https://rpc.xlayer.tech       ->  {"jsonrpc":"2.0","result":"0xc4","id":1}     =   196
https://rpc.bohr.life         ->  {"jsonrpc":"2.0","id":1,"result":"0x3c8"}    =   968
https://rpc.botchain.ai       ->  {"jsonrpc":"2.0","id":1,"result":"0x2a5"}    =   677
```

All four RPCs returned a non-zero head block in the same session, so they are
live and serving, not merely resolving.

## Settlement tokens — `symbol()` / `decimals()` / `eth_getCode`

Spec §7.2 flagged BOT Chain's stablecoin situation as the critical day-1 unknown,
with a `NativeSettlement` contract variant as the fallback if none existed.

**A stablecoin exists.** BDEX's published contract addresses list USDT on both
BOT networks, and both were confirmed by direct contract call:

| Network | Address | `symbol()` | `decimals()` | bytecode |
|---|---|---|---|---|
| BOT Chain mainnet | `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C` | `USDT` | 6 | 12,378 bytes |
| BOT Chain testnet | `0x75edC9335175Fc0552D51D48439F229c10420fe3` | `USDT` | 6 | 12,378 bytes |

**Consequence: the `NativeSettlement` variant is not required.** `settlementToken`
is configured to these addresses and no contract rewrite is needed. Settlement is
nonetheless modelled as a discriminated union (`erc20 | native | unresolved`) so
that a later move to native BOT — for instance if the gas-support grant makes BOT
the more sensible unit — remains a config change.

X Layer mainnet, confirmed the same way:

| Network | Address | `symbol()` | `decimals()` |
|---|---|---|---|
| X Layer mainnet | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` | `USD₮0` | 6 |
| X Layer mainnet | `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` | `USDT` | 6 |
| X Layer mainnet | `0x74b7F16337b8972027F6196A17a631aC6dE26d22` | `USDC` | 6 |

⛔ **USD₮0 is the settlement token, corrected 2026-08-17.** The row above it,
`0x1E4a5963…`, was configured until then "for consistency with BOT Chain" — a
reason about naming, not about the chain. It is X Layer's legacy bridged USDT,
being phased out in favour of USD₮0. Both are live, both are 6-decimal ERC-20s,
and both answer `symbol()` plausibly, so every structural check in this repo
passed on the wrong one. See §"Which USDT" below.

## X Layer testnet chain ID: 1952, not 195

Third-party listings (thirdweb among them) still give X Layer testnet as chain ID
**195**. That value is stale — it predates X Layer's migration to the OP Stack.
Both of OKX's own testnet endpoints report **1952**:

```
https://testrpc.xlayer.tech      ->  "0x7a0"  = 1952
https://xlayertestrpc.okx.com    ->  "0x7a0"  = 1952
```

`195` is `0xc3`, which neither endpoint returns. Configuring 195 would produce
signature-verification failures on every transaction, so `verify:chains` asserts
the chain ID against the live RPC on every run specifically to catch this class
of stale-documentation error.

## X Layer testnet settlement: USD₮0, found via the faucet contract

Settlement on X Layer testnet is **USD₮0** at
`0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c` — verified `symbol()` = `USD₮0`,
`decimals()` = 6, `totalSupply` = 1,000,000,000,000. It is the omnichain USDT
deployment and, critically, **it is one of the tokens the X Layer testnet faucet
actually dispenses**, so demo and judge wallets can genuinely be funded with it.

### How it was found, and why the obvious guesses all failed

The mainnet token addresses do not carry over to testnet. Every address that
circulates in search results for "X Layer testnet USDT" was probed directly and
none of them is a token on chain 1952:

| Address probed | Source of the claim | Result on chain 1952 |
|---|---|---|
| `0x74b7F16337b8972027F6196A17a631aC6dE26d22` | X Layer mainnet USDC | real `USD Coin` contract, but `totalSupply` is **0** — unspendable |
| `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` | X Layer mainnet USDT | no contract code |
| `0x382bB369d343125BfB2117af9c149795C6C65C50` | search result claiming "X Layer testnet USDT" | no contract code — this is the **OKT Chain** USDT address |
| `0x4ae46a509f6b1d9056937ba4500cb143933d2dc8` | X Layer mainnet USDG | no contract code |

The real addresses came from the **faucet contract** at
`0xf6d088123a3c17e6047ae9338b8cf072ad448907`. That address is not a token —
every ERC-20 view call on it reverts, because it is an EIP-1967 proxy
(implementation `0xf879f2e23693dc92da2582f5bcb8495fe96835e5`) whose bytecode
contains faucet error strings such as `Receiver must be EOA`, `...in cooldown
period`, and `...insufficient token balance`.

Scanning its outbound ERC-20 `Transfer` logs over the last 40,000 blocks (in
100-block windows — this RPC caps `eth_getLogs` ranges at 100) revealed the three
tokens it hands out:

| Address | `name()` | `symbol()` | Decimals | Total supply |
|---|---|---|---|---|
| `0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c` | `USD₮0` | `USD₮0` | 6 | 1,000,000,000,000 |
| `0xcb8bf24c6ce16ad21d707c9505421a17f2bec79d` | `USDC_TEST` | `USDC_TEST` | 6 | 2,000,000,000,100 |
| `0xa78e2baabaf5c4f36b7fc394725deb68d332eec1` | `Global Dollar` | `USDG` | 6 | 10,101,000 |

USD₮0 was chosen as the testnet analogue of the USDT used on the other three
targets. All four targets therefore settle in a 6-decimal USD stablecoin, which
keeps `pricePerUnit` arithmetic identical everywhere.

**Lesson worth keeping:** the faucet contract is the authoritative source for
which testnet tokens are obtainable. A token that exists but cannot be acquired —
like the zero-supply USDC above — is useless for a demo, and that is not visible
from an address listing alone.

### The faucet cannot be claimed from a script

Established 16 August by decoding a real dispensation,
`0xecd8af0edf6455549447083af655ff0e8c378dff9545996799f5abe8f5cb7bf2`.

The faucet is **operator-driven, not user-callable**. A single privileged EOA
(`0x49ca9591c98920f517b6b8838956cda94f03c025`) calls selector `0xc5c9b941` with a
**batch** of requests — ten in the transaction examined — and each carries a
sequential request id (`0x13616b2`, `0x13616b3`, …) assigned by an off-chain
queue. Those ids are issued by OKX's backend when a request is made through the
faucet web page. There is no path from holding an address to producing a valid
id, so the claim must be made through the UI, which is account-gated.

Do not waste time probing for a public `claim()`: none of the conventional
faucet signatures appears in the implementation's selector table, and the
bytecode's error strings (`Receiver must be EOA`, cooldown, insufficient
balance) belong to the operator path.

**Amount per claim, read from the logs:** 10 units of a 6-decimal token, or
0.2 OKB for the native claim. The token index in the event is `0` native,
`1` USD₮0, `2` USDC_TEST, `3` USDG.

Ten USD₮0 is enough for a demonstration class, but it is the ceiling per claim,
so class pricing and collateral must be sized against it rather than assumed.

### The binding constraint is the cooldown, not the balance

Established 16 August, after a claim appeared to succeed in the UI and never
arrived on chain.

**A second claim on an address that claimed recently does not land, and the UI
does not clearly say so.** The address held 1 USD₮0, a claim was made, and the
balance did not move. Diagnosis, in the order worth repeating:

1. **Rule out the node first.** Query two independent RPCs (`testrpc.xlayer.tech`
   and `xlayertestrpc.okx.com`) and compare their head blocks. If they agree at
   the same height, the balance is real and this is not the load-balancer
   staleness problem that `send()` retries around.
2. **Check all three tokens, not just the expected one** — a claim aimed at the
   wrong entry in the faucet's token list lands somewhere, just not where it was
   wanted. Here USDC_TEST and USDG were both zero, so that was not it.
3. **Confirm the faucet is alive** by scanning its outbound `Transfer` logs for
   *anyone*. It had dispensed 10 USD₮0 to an unrelated address 3.8 hours earlier,
   which rules out an outage and points back at the requesting address.
4. **Scan inbound transfers to the address over 24h**, filtering on the `to`
   topic. Exactly one dispensation appeared — 10 USD₮0, 5h36m earlier, tx
   `0x0a7a4926b85b527d0ff2c6d3441fa0c894c3a285f2fc1de095c528dd5cdb2fca`. The
   arithmetic then closed exactly: 10 − 3 − 3 − 3 = 1, three e2e runs at 3 USD₮0
   each. Every unit was accounted for by the single claim, so no second
   dispensation had ever occurred.

A trap worth naming, because it cost a scan: filtering those logs by grepping for
the address matches it in the **`from`** topic too, which surfaces the address's
own outbound spends and reads as a false positive. Filter on topic index 2
explicitly — `cast logs <TRANSFER> "" <padded-to-address>` accepts an empty
topic1, and the only error a too-wide range raises is the 100-block cap.

The cooldown duration is **not established**; the contract carries an
`...in cooldown period` error string but the window is enforced off-chain by
OKX's queue. 24h is the assumption, untested.

**Consequence for the e2e rehearsal:** do not plan around re-claiming. The run's
cost is arbitrary on testnet, so `packages/attest/scripts/e2e.ts` takes
`ROUTELOCK_PRICE`, `ROUTELOCK_COLLATERAL` and `ROUTELOCK_PAYOUT` and a run
scaled 10× down costs 0.3 USD₮0 instead of 3. The escrow's only requirement is
that collateral covers the obligation after the mint
(`SettlementEscrow.sol:143`), which uniform scaling preserves — so the scaled run
exercises exactly the same path.

**But those figures are fixed at `createClass`, not at run time.** Reusing an
existing class label via `ROUTELOCK_CLASS_LABEL` means the on-chain price
governs the mint and the env vars silently do not apply. Scaled runs need a
fresh label.

For completeness, on X Layer **mainnet** there is a token named `TestUSDT`
(symbol `USDT`, 6 dp, 1,000,000 supply) at
`0x83bf0bacd31f9c2ae93da3a863a4f210f7b9bce1`. It is somebody's test token
deployed to mainnet, not an official bridged asset.

## Other network facts confirmed

- **BOT Chain testnet faucet:** `https://faucet.bohr.life/en/basic` — 10 tBOT per
  address per 24 hours, tBOT has no real-world value.
- **BOT Chain explorers:** testnet `https://scan.bohr.life`, mainnet
  `https://scan.botchain.ai`.
- **BOT Chain block time:** ≈0.75s, EVM-equivalent, Parlia consensus.
- **X Layer gas token:** OKB. X Layer is an OP Stack L2 with a 7-day challenge
  period.
- **`eth_getLogs` is disabled on BOT Chain's public mainnet RPC.** The event
  indexer in `packages/chain` must not depend on it there — use WebSocket
  subscriptions or a third-party endpoint. This is a real constraint on the
  indexer design, worth knowing before it is written rather than after.

## Yield venues, verified 2026-08-17

Added because "Aave is on X Layer" and "RouteLock can float its collateral into
Aave on X Layer" turned out to be different claims, and only the first one is
true.

Aave V3 launched on X Layer on 30 March 2026. Every address below was read off
the chain rather than off the announcement, and the addresses themselves came
from `bgd-labs/aave-address-book` rather than from a search result.

```
$ cast call 0xdFf435BCcf782f11187D3a4454d96702eD78e092 'getPool()(address)' --rpc-url https://rpc.xlayer.tech
0xE3F3Caefdd7180F884c01E57f65Df979Af84f116          # provider agrees with the configured pool

$ cast call 0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297 'symbol()(string)' --rpc-url https://rpc.xlayer.tech
"aXlrUSDT0"

$ cast call 0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297 'UNDERLYING_ASSET_ADDRESS()(address)' --rpc-url https://rpc.xlayer.tech
0x779Ded0c9e1022225f8E0630b35a9b54bE713736          # NOT RouteLock's settlement token

$ cast call 0x779Ded0c9e1022225f8E0630b35a9b54bE713736 'symbol()(string)' --rpc-url https://rpc.xlayer.tech
"USD₮0"                                             # supply 113,309,004,080,663

$ cast call 0x1E4a5963aBFD975d8c9021ce480b42188849D41d 'symbol()(string)' --rpc-url https://rpc.xlayer.tech
"USDT"                                              # supply 3,829,200,805,666 — what RouteLock settles in

$ cast call 0xE3F3Caefdd7180F884c01E57f65Df979Af84f116 'getReservesList()(address[])' --rpc-url https://rpc.xlayer.tech
[0x779Ded0c…, 0x4ae46a50…, 0xb7C00000…, 0xe538905c…, 0xE7B00000…,
 0x50500000…, 0xAFeab3B8…, 0x14a68610…, 0xDe653901…]                # 0x1E4a5963… is not in it
```

⛔ **The conclusion drawn from this on 17 August was wrong, and the readings
above were not.** Every `cast` output on this page is accurate. What was wrong
was the thing they were compared against: `chains.ts` named `0x1E4a5963…` as
X Layer mainnet settlement, so "our token is absent from Aave's reserves" was
true of a token RouteLock should never have been settling in.

The corrected position: **Aave's X Layer reserve and RouteLock's settlement token
are the same asset, USD₮0.** A yield adapter needs no swap and no settlement
change. What it still lacks is an environment — see below.

## Which USDT: the config named the wrong one

Two live 6-decimal stablecoins on chain 196 both present as Tether:

| | `0x1E4a5963…` | `0x779Ded0c…` |
|---|---|---|
| `name()` | `Tether USD` | `USD₮0` |
| `symbol()` | `USDT` | `USD₮0` |
| `decimals()` | 6 | 6 |
| `totalSupply()` | 3,829,200,805,666 | **113,309,004,080,663** (30x) |
| Transfers, 10 sampled 100-block windows | 324 | **6,175** (19x) |
| In Aave's reserve list | no | **yes** |
| Standard | legacy bridged, being phased out | LayerZero OFT, canonical |

X Layer **testnet** already settled in USD₮0 — the 1952 faucet dispenses it — so
the two environments disagreed with each other for four days and nothing caught
it.

**Why every existing check passed on the wrong token.** `_assertSettlementToken`
in `Deploy.s.sol` asserts a contract exists and answers `decimals() == 6`. Both
do. `verify:chains` compared `symbol()` against the configured symbol — and the
configured symbol was `USDT`, which the legacy token duly returned. A check that
compares a config against itself confirms consistency, never correctness.

Corrected 2026-08-17. A test now names the legacy address and fails if it
reappears as any chain's settlement token, because nothing structural can catch
it: it is a real, live, correctly-behaved ERC-20 that simply is not the one the
chain uses.

## Aave on X Layer: live on mainnet, absent on testnet

On X Layer **testnet** the pool and provider both return `0x` — Aave is not
deployed there at all, so there is no environment in which a yield adapter could
be rehearsed before touching mainnet. That, not the asset, is what still blocks
it.

### The general lesson, worth more than the specific addresses

Two lessons, and the second one cost a wrong conclusion:

1. A protocol being deployed on a chain says nothing about whether *your* asset
   is listed on it. Ask the chain about the specific pair, not the protocol.
2. **When a live reading disagrees with the config, the config is a suspect too.**
   The instinct here was to treat `chains.ts` as ground truth and conclude
   something about Aave. The disagreement was real; the party at fault was
   assumed rather than established.

`verify:chains` now performs this check on every run, including the
`settlesInVenueAsset` claim, which is cross-checked against the two addresses it
describes rather than believed.
