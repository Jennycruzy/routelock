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
| X Layer mainnet | `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` | `USDT` | 6 |
| X Layer mainnet | `0x74b7F16337b8972027F6196A17a631aC6dE26d22` | `USDC` | 6 |

USDT is configured as the settlement token for consistency with BOT Chain.

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

## Unresolved: X Layer testnet settlement token

**No spendable stablecoin was found on X Layer testnet.** Every candidate was
probed directly against `testrpc.xlayer.tech`:

| Address probed | Source of the claim | Result on chain 1952 |
|---|---|---|
| `0x74b7F16337b8972027F6196A17a631aC6dE26d22` | X Layer mainnet USDC | **`USD Coin` / `USDC` / 6 dp — but `totalSupply` is 0** |
| `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` | X Layer mainnet USDT | no contract code |
| `0x382bB369d343125BfB2117af9c149795C6C65C50` | search result claiming "X Layer testnet USDT" | no contract code — this is the **OKT Chain** USDT address |
| `0x4ae46a509f6b1d9056937ba4500cb143933d2dc8` | X Layer mainnet USDG | no contract code |

The USDC contract is real but has never had a single token minted, so no account
can hold or spend it. It is not usable as settlement in its current state.

For completeness, on X Layer **mainnet** there is a token named `TestUSDT`
(symbol `USDT`, 6 dp, 1,000,000 supply) at
`0x83bf0bacd31f9c2ae93da3a863a4f210f7b9bce1`. It is somebody's test token
deployed to mainnet, not an official bridged asset, and it is not on testnet.

The X Layer faucet advertises "OKB, USDG, and more", but the USDG it dispenses is
not at the mainnet USDG address, so its testnet address is still unknown.

Two acceptable resolutions before the testnet deploy:

1. Claim from the faucet, read the **actual token contract address** out of the
   receiving wallet or the transaction on OKLink, and configure that.
2. Deploy a RouteLock test ERC-20 and state plainly in the README that testnet
   settlement uses a project-deployed test token with no value.

Either is honest. Guessing an address is not — and as the table above shows, the
addresses circulating in search results for "X Layer testnet USDT" belong to a
different chain entirely.

## Other network facts confirmed

- **BOT Chain testnet faucet:** `https://faucet.botchain.ai/basic` — 10 tBOT per
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
