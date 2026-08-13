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

## Unresolved

**X Layer testnet has no confirmed settlement token.** Nothing has been
configured for it. `requireSettlementToken()` throws when asked for it and
`verify:chains` reports it as a failing check, rather than defaulting to a zero
address or a guessed one.

Two acceptable resolutions before the day-2 testnet deploy:

1. Locate an OKX-published test USDT on X Layer testnet and configure it.
2. Deploy a RouteLock test ERC-20 and state plainly in the README that testnet
   settlement uses a project-deployed test token with no value.

Either is honest. Guessing an address is not.

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
