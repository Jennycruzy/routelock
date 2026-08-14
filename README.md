# RouteLock

> RouteLock turns a service provider's real contractual commitment into a
> transferable, escrow-backed on-chain entitlement, and gates its redemption
> behind an AI compliance engine that classifies goods, determines regulatory
> eligibility, and **refuses to proceed when its confidence is insufficient** —
> so nothing moves on a guessed declaration.

**Status: day 2 of 8. This README describes what is built, and says plainly what
is not.** Nothing below is simulated. Where a feature does not exist yet, it is
listed as not existing rather than demonstrated with fake data.

---

## The real-world asset

The asset is **a service provider's contractual obligation to perform a specific
piece of work**, on stated terms, within a stated window. That obligation already
exists off-chain as an ordinary commercial commitment; it is illiquid, bilateral,
and unenforceable by anyone but its original counterparty. RouteLock makes it a
transferable, collateral-backed instrument.

**What the token is a claim on.** One `ServiceEntitlement` (ERC-721) represents
one unit of a *class*, issued by one registered issuer, under terms whose signed
document is committed on-chain as `termsHash`. Holding the token is holding that
issuer's obligation to perform one unit of that class.

**The contracts do not know what the service is.** This is worth stating
precisely, because it is the difference between a product and a demo. A class —
`ServiceSpec` in [`RouteLockTypes.sol`](packages/contracts/src/RouteLockTypes.sol) —
carries an issuer, a terms hash, a settlement token, a price, a payout
obligation, an expiry, and a supply cap. There is **no origin field, no
destination, no weight, no carrier, and no parcel** anywhere in the contract set.
The class is identified by `classId`, an opaque `keccak256` of whatever human
label the issuer chose.

So the generality is not a roadmap item. The five contracts already deployed at
the addresses below would back a pallet-month of bonded warehousing, a cold-chain
window, an hour of machine time, or a freight slot **without a redeploy and
without a line changed** — a different label, a different terms document, and a
different off-chain adapter. What varies between verticals is the adapter that
proves fulfilment; what stays fixed is collateralised issuance, escrowed
settlement, and a compliance gate that can refuse.

**Why it is an asset and not a voucher.** Two things back it, and both are
enforced by the contracts rather than promised in prose:

- **Collateral precedes issuance.** The issuer must post `payoutObligation` per
  unit into `SettlementEscrow` *before* any entitlement of that class can be
  minted. `EntitlementFactory.mint` reverts with `InsufficientCollateral` if
  backing does not cover the obligation after the mint, so an uncollateralized
  entitlement is not merely discouraged — it is unreachable. Collateral can be
  withdrawn only down to, never below, outstanding obligations.
- **The buyer's payment is escrowed, not paid.** Funds go from the buyer into
  `SettlementEscrow` at purchase and are released to the issuer only against
  proof of performance from the provider's own system, recorded by the backend
  oracle — for the delivery adapter, a real carrier label.
  **Compliance approving an activation releases nothing.** If the work is
  refused, remedied, or the entitlement expires, the buyer is refunded.

So the holder has a claim that is economically backed if honoured *and* if
defaulted on, which is what distinguishes it from a prepaid credit.

**Why it is transferable.** Before consignment data is bound to it, the token is
generic — it names a class and a service level, nothing about any person. It can
be resold, gifted, or held as inventory by a broker. The moment a counterparty's
details are attached, transfers lock permanently: moving it afterwards would
either leak those details to whoever received the token, or let work a provider
has already accepted be redirected.

## The first adapter, and why it is this one

An entitlement is only worth what the obligation behind it is worth, so the
primitive has to be proven against a provider who can actually be held to it.
The first adapter is **delivery**, fulfilled through Shipbubble, and the first
class is a parcel lane between **Port Harcourt and Lagos**.

That lane is a deliberate choice, not a default, and the reasoning is the part
worth reading:

- **The counterparty is real on it.** Shipbubble genuinely serves that corridor
  with live rates and real labels. An entitlement written against a lane no
  carrier actually runs would be a simulation with extra steps — the obligation
  has to be one somebody is contractually on the hook for.
- **It has a genuine classification problem.** Carriers refuse goods. Deciding
  whether a described item is acceptable, restricted, or prohibited is a real
  decision with a real cost of being wrong, which is precisely what the
  compliance engine has to be measured against. HS nomenclature gives that
  decision a standard vocabulary rather than a bespoke one, and the same
  vocabulary extends to cross-border lanes later without rework.
- **It is domestic, so the failure modes are ours.** No customs broker sits
  between the model's decision and the outcome, absorbing or masking its errors.
  When the engine refuses, the refusal is the system's own and is measurable as
  such.

**The lane is a parameter, not the product.** Grep the contract set for it: it
occurs in non-test Solidity exactly once, in a comment, as an example of what a
`classId` might be a hash of (`RouteLockTypes.sol:33`). Every other occurrence
is a test fixture. Nothing in the deployed bytecode knows the corridor exists.
A second issuer, a second corridor, a second country, or a second vertical
entirely requires no contract change — which is the claim the rest of this
README is built to let you check rather than take on trust.

### What is not yet true of the asset

This section exists because the claim above is the part most worth being
sceptical of, and the honest position today is narrower than the design.

- **No issuer agreement exists.** Whether Shipbubble permits platform or
  third-party shipment creation through their API has not been confirmed in
  writing. That written confirmation is the foundation of the RWA claim, and it
  has not been obtained.
- **No real carrier commitment is bound to the deployment yet.** The live
  contracts on X Layer testnet currently hold **zero registered issuers, zero
  classes, zero entitlements, and zero fulfilment receipts** — verifiable by
  calling `totalMinted()` and `totalReceipts()` on the addresses below. The
  machinery is real and live; nothing has been issued through it.
- **No shipment has been purchased.** Zero of the five available live shipments
  have been used, and the carrier adapter is not built.

Until those three are resolved, RouteLock is a working, deployed settlement and
compliance layer for a real-world service obligation — not yet a tokenized one.

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
| X Layer **testnet** | Shipbubble **sandbox** key | none |
| X Layer **mainnet** | Shipbubble **live** key | real |
| BOT Chain **testnet** | Shipbubble **sandbox** key | none |
| BOT Chain **mainnet** | Shipbubble **live** key | real |

- **The contract set, with 159 passing tests at 100% branch coverage.**
  `ServiceEntitlement` (ERC-721 lifecycle plus the transfer lock),
  `EntitlementFactory` (issuers, classes, collateral-backed purchase),
  `SettlementEscrow`, `ActivationRegistry`, and a soulbound `FulfilmentReceipt`.

  Two properties are enforced structurally rather than by convention:

  - `SettlementEscrow` **rejects** any attempt to grant `COMPLIANCE_ROLE`, so the
    compliance service cannot be given authority over funds by any admin at any
    point. The AI opening the activation gate and money being released are two
    separate events with two separate triggers.
  - Entitlements stop being transferable the moment counterparty data is bound
    to them, because transferring afterwards would either leak that party's
    details or let work a provider has already accepted be redirected.

- **A deployment script that refuses more than it accepts.** It picks the
  settlement token from the chain id rather than the environment, reads
  `decimals()` before trusting the token, aborts on any chain id it has not
  verified, and asserts the whole role graph — including that the escrow still
  rejects `COMPLIANCE_ROLE` — before recording a single address. A dry run
  verifies everything and writes nothing, so a simulation cannot leave behind a
  file that reads as a real deployment.

## Deployments

### X Layer testnet — live

Chain 1952, deployed 13 August 2026. The deployment transactions mined at block
**38195716**; `deployedAtBlock` in the address file records **38195693**, the
head at the moment the script began. Both are recorded because they are
different facts, and the receipts under `broadcast/` are the authoritative ones.
Addresses: [`deployments/xlayer_testnet.json`](deployments/xlayer_testnet.json).
Transaction records: [`packages/contracts/broadcast/Deploy.s.sol/1952/`](packages/contracts/broadcast/Deploy.s.sol/1952/).

| Contract | Address |
|---|---|
| `ServiceEntitlement` | `0x8A9A92a5Cd3c1eF2D2F0b5cD67E33e73949C992b` |
| `SettlementEscrow` | `0x58eba10730Fd1ee4E5b24AaAa7caE154cbC69C83` |
| `EntitlementFactory` | `0x366544F805e10e7320779d138Cca57FA0E4c5cdf` |
| `ActivationRegistry` | `0x38D8a1e9bC45378E4019320ECa4fc5431BeF40Bb` |
| `FulfilmentReceipt` | `0x83Ee9a4d2A3f0851DDD022A114663524694571C4` |

Settlement token: USD₮0 `0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c`, 6 decimals.

**Check the central guarantee yourself**, without trusting this README.
Simulating a grant of `COMPLIANCE_ROLE` on the escrow **as the contract's own
admin** reverts, while the same call for `ORACLE_ROLE` from the same caller
succeeds — so the refusal is specific to the compliance role, not a broken call:

```bash
cast call --rpc-url https://testrpc.xlayer.tech \
  --from 0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6 \
  0x58eba10730Fd1ee4E5b24AaAa7caE154cbC69C83 \
  'grantRole(bytes32,address)' \
  $(cast keccak COMPLIANCE_ROLE) \
  0xA30D83117470c884fB3C35532d2a49Bc65B0922a
# reverts: 0xa3dd6e91 == ComplianceRoleForbiddenHere()
```

### X Layer mainnet — not deployed

Deliberately. A mainnet contract set with no compliance engine and no carrier
adapter behind it would be an address, not a product.

### BOT Chain testnet — not deployed

The deployer wallet now holds 10 tBOT from the faucet, so this is no longer
blocked. A deploy costs ~0.21 tBOT there, because BOT Chain gas is 20 gwei
against X Layer's 0.02 — roughly 47 deploys of headroom from a single claim.

### BOT Chain mainnet — not deployed

## Not finished yet

**Not built at all:** the compliance engine, the carrier adapter, the attestation
and replay endpoint, and the frontend. These are blocked on credentials — a
Shipbubble sandbox key and an inference credential — and nothing has been stubbed
in their place, because a simulated feature presented as working would be worse
than an absent one. See [`PROGRESS.md`](PROGRESS.md).

**Built, but not yet measuring anything:** the classification benchmark corpus —
**354 rulings from two independent customs authorities**, 176 from US CBP and 178
from UK HMRC, covering 185 HS-6 subheadings across 57 chapters, every row citing
the binding ruling it came from. Two authorities rather than one because the
route is chosen by whoever is shipping: a single-country corpus measures how well
a model reproduces that country's reading of the nomenclature, not the
nomenclature. Building it needs no inference, so it was not blocked. **Scoring it
does**, so this repository contains no accuracy figures and will contain none
until a real model has been run against those rows. Method, exclusions and
limitations are in [`bench/README.md`](bench/README.md).

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

Deploying:

```bash
./scripts/deploy.sh xlayer_testnet               # simulate, writes nothing
./scripts/deploy.sh botchain_testnet --broadcast # deploy for real
```

Requires Node 20+, pnpm, and Foundry.
