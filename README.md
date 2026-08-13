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

- **The contract set, compiling with 71 passing tests.** `ServiceEntitlement`
  (ERC-721 lifecycle plus the transfer lock), `EntitlementFactory` (issuers,
  classes, collateral-backed purchase), `SettlementEscrow`, `ActivationRegistry`,
  and a soulbound `FulfilmentReceipt`.

  Two properties are enforced structurally rather than by convention:

  - `SettlementEscrow` **rejects** any attempt to grant `COMPLIANCE_ROLE`, so the
    compliance service cannot be given authority over funds by any admin at any
    point. The AI opening the activation gate and money being released are two
    separate events with two separate triggers.
  - Entitlements stop being transferable the moment parcel data is bound to
    them, because transferring afterwards would either leak the consignee's
    details or let an accepted shipment be redirected.

## Not finished yet

**Contract test coverage is incomplete and the README will say so until it is
not.** `ActivationRegistry` is at 20% branch coverage and `FulfilmentReceipt` at
0% — neither has a dedicated test file. The spec's target of 100% on state
transitions and access control is not yet met.

Also not built: the compliance engine, carrier adapter, attestation and replay
endpoint, frontend, deployment scripts, and the classification benchmark. See
[`PROGRESS.md`](PROGRESS.md).

## Verified networks

All four targets settle in a 6-decimal USD stablecoin, so pricing arithmetic is
identical everywhere. Every row below is confirmed by live RPC, not copied from
a docs page.

| Target | Chain ID | Settlement |
|---|---|---|
| X Layer testnet | 1952 | USD₮0 `0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c` |
| X Layer mainnet | 196 | USDT `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` |
| BOT Chain testnet | 968 | USDT `0x75edC9335175Fc0552D51D48439F229c10420fe3` |
| BOT Chain mainnet | 677 | USDT `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C` |

Note that X Layer testnet is chain ID **1952**, not the 195 still listed by
several third-party chain directories — that value predates X Layer's migration
to the OP Stack. Both of OKX's own testnet RPCs report 1952, and
`verify:chains` asserts it on every run so a stale value cannot reach a deploy.

## Development

```bash
pnpm install
pnpm verify:chains    # re-verify all four chains against live RPC
pnpm test             # run the suite
```

Requires Node 20+, pnpm, and Foundry.
