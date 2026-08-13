# RouteLock

> RouteLock turns a service provider's real contractual commitment into a
> transferable, escrow-backed on-chain entitlement, and gates its redemption
> behind an AI compliance engine that classifies goods, determines regulatory
> eligibility, and **refuses to proceed when its confidence is insufficient** —
> so nothing moves on a guessed declaration.

**Status: day 1 of 8. This README describes what is built, and says plainly what
is not.** Nothing below is simulated. Where a feature does not exist yet, it is
listed as not existing rather than demonstrated with fake data.

---

## What works today

- **Four-target chain configuration, verified against the live networks.** Chain
  IDs, RPC liveness, and settlement token `symbol()`/`decimals()` are confirmed
  by querying each chain directly — see [`docs/chain-verification.md`](docs/chain-verification.md)
  for the raw responses. Re-runnable with `pnpm verify:chains`.

- **A boot-time guard that makes environment pairing structural.** A testnet
  deployment cannot hold a live carrier key and a mainnet deployment cannot show
  a sandbox result: the process throws at start rather than running misconfigured.
  There is no mock-carrier fallback, deliberately.

| Chain environment | Carrier credentials | Money |
|---|---|---|
| X Layer / BOT Chain **testnet** | Shipbubble **sandbox** key | none |
| X Layer / BOT Chain **mainnet** | Shipbubble **live** key | real |

## What is not built yet

Contracts, compliance engine, carrier adapter, attestation and replay endpoint,
frontend, and the classification benchmark. See [`PROGRESS.md`](PROGRESS.md).

## Known unresolved

**X Layer testnet has no confirmed settlement token.** `pnpm verify:chains`
reports this as a failing check and `requireSettlementToken()` throws when asked
for it. That is intended: a placeholder or zero address would let an unverified
value reach a deployment. It will be resolved — with a real token, or with a
project-deployed test ERC-20 labelled as such — before the testnet deploy.

## Verified networks

| Target | Chain ID | Settlement |
|---|---|---|
| X Layer testnet | 1952 | unresolved (see above) |
| X Layer mainnet | 196 | USDT `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` |
| BOT Chain testnet | 968 | USDT `0x75edC9335175Fc0552D51D48439F229c10420fe3` |
| BOT Chain mainnet | 677 | USDT `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C` |

## Development

```bash
pnpm install
pnpm verify:chains    # re-verify all four chains against live RPC
pnpm test             # run the suite
```

Requires Node 20+, pnpm, and Foundry.
