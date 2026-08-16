# RouteLock

> RouteLock turns a service provider's real contractual commitment into a
> transferable, escrow-backed on-chain entitlement, and gates its redemption
> behind an AI compliance engine that classifies the work, determines
> eligibility, and **refuses to proceed when its confidence is insufficient** —
> so nothing moves on a guessed declaration.

**Status: 16 August 2026.** This README describes what is built and says plainly
what is not. Nothing below is simulated. Where a feature does not exist, it is
listed as absent rather than demonstrated with fake data, and every status claim
is one you can check against a live chain or a public API rather than take on
trust.

---

## One contract set, three adapters

This is the whole architectural claim, and it is the thing to check first.

**The contracts do not know what service is being sold.** A class —
`ServiceSpec` in [`RouteLockTypes.sol`](packages/contracts/src/RouteLockTypes.sol) —
carries an issuer, a terms hash, a settlement token, a price, a payout
obligation, an expiry, and a supply cap. There is **no origin field, no
destination, no weight, no carrier, no parcel, no tonnage and no server**
anywhere in the contract set. A class is identified by `classId`, an opaque
`keccak256` of whatever label the issuer chose.

So what varies between verticals is the **adapter** that proves fulfilment. What
stays fixed is collateralised issuance, escrowed settlement, and a compliance
gate that can refuse. Three adapters sit above one unchanged contract set:

| Adapter | Vertical | Chain | Status | Fulfilment proof |
|---|---|---|---|---|
| `carbonmark-x402` | Carbon retirement | X Layer | **In development.** Code complete and exercised against the live endpoint. No retirement performed. | Public Carbonmark certificate URL |
| `shipbubble` | Delivery | none | **Reference implementation.** Built against the real API, deliberately not deployed. | Carrier label + tracking number |
| `akash` | Compute leasing | BOT Chain | **Not started.** Begins after X Layer is submitted. | On-chain lease + ingress URL |

The five contracts already deployed at the addresses below would back a
pallet-month of bonded warehousing, a cold-chain window, or a freight slot
**without a redeploy and without a line changed** — a different label, a
different terms document, a different adapter.

[`docs/adapters.md`](docs/adapters.md) is the authoritative status record and
defines the vocabulary above. A status moves to **Active** only once that adapter
has performed a real fulfilment on the named chain. None has yet.

### Why the vertical is a parameter, and how to verify that

Grep the contract set for the delivery corridor it was first designed against.
It occurs in non-test Solidity **exactly once**, in a comment, as an example of
what a `classId` might be a hash of (`RouteLockTypes.sol:33`). Every other
occurrence is a test fixture. Nothing in the deployed bytecode knows any
corridor, cargo or credit exists.

The delivery adapter is retained rather than deleted precisely because it is the
evidence: it proves the contracts predate the vertical now running on them.
Three adapters against one unchanged contract set is a stronger claim than two.
The field-by-field mapping from each vertical onto the same registry is in
[`docs/adapter-mapping.md`](docs/adapter-mapping.md).

---

## The real-world asset

The asset is **a service provider's contractual obligation to perform a specific
piece of work**, on stated terms, within a stated window. That obligation already
exists off-chain as an ordinary commercial commitment; it is illiquid, bilateral,
and unenforceable by anyone but its original counterparty. RouteLock makes it a
transferable, collateral-backed instrument.

**What the token is a claim on.** One `ServiceEntitlement` (ERC-721) represents
one unit of a class, issued by one registered issuer, under terms whose signed
document is committed on-chain as `termsHash`. Holding the token is holding that
issuer's obligation to perform one unit of that class.

**Why it is an asset and not a voucher.** Two things back it, and both are
enforced by the contracts rather than promised in prose:

- **Collateral precedes issuance.** The issuer must post `payoutObligation` per
  unit into `SettlementEscrow` *before* any entitlement of that class can be
  minted. `EntitlementFactory.mint` reverts with `InsufficientCollateral` if
  backing does not cover the obligation after the mint, so an uncollateralised
  entitlement is not merely discouraged — it is unreachable. Collateral can be
  withdrawn only down to, never below, outstanding obligations.
- **The buyer's payment is escrowed, not paid.** Funds go from the buyer into
  `SettlementEscrow` at purchase and are released to the issuer only against
  proof of performance from the provider's own system, recorded by the backend
  oracle. **Compliance approving an activation releases nothing.** If the work is
  refused, remedied, or the entitlement expires, the buyer is refunded.

So the holder has a claim that is economically backed if honoured *and* if
defaulted on, which is what distinguishes it from a prepaid credit.

**Why it is transferable.** Before counterparty data is bound to it, the token is
generic — it names a class and a service level, nothing about any person. It can
be resold, gifted, or held as inventory by a broker. The moment a counterparty's
details are attached, transfers lock permanently: moving it afterwards would
either leak those details to whoever received the token, or let work a provider
has already accepted be redirected.

### What is not yet true of the asset

This section exists because the claim above is the part most worth being
sceptical of, and the honest position today is narrower than the design.

- **No obligation has been issued through the deployment.** The live contracts on
  X Layer testnet hold **zero registered issuers, zero classes, zero
  entitlements, and zero fulfilment receipts** — confirmed 16 August by calling
  `totalMinted()` and `totalReceipts()` on the addresses below, both of which
  return `0`. The machinery is real and live; nothing has been issued through it.
- **No fulfilment has been performed by any adapter.** No carbon credit has been
  retired, no shipment purchased, no lease taken.
- **No issuer agreement exists in writing** for any of the three verticals.

Until those are resolved, RouteLock is a working, deployed settlement and
compliance layer for a real-world service obligation — not yet a tokenised one.

---

## The three adapters in detail

### Carbon retirement — leads on X Layer

The obligation tokenised here is **not the credit**. The credit is already a
real-world asset custodied in a registry. It is the *obligation to retire one*,
which is the part that is currently unenforceable: offsets sold at checkout are
paid for immediately and retired later, in bulk, if at all.

`CarbonmarkX402Adapter` retires through **Klima's x402 endpoint**, settling on
Base mainnet while the obligation, the collateral, the escrow and the compliance
record stay on X Layer. Nothing is bridged and no credit is wrapped or tokenised.
A judge inspects X Layer state and then clicks a third-party certificate — which
is stronger evidence than a self-contained system where every claim traces back
to this project's own database.

Exercised against the live endpoint on 16 August: **six credit classes in
inventory**, priced from $0.067/t to $947/t, with registry, project ids, vintages
and methodology read live rather than cached. A 0.001 t retirement prices at
**0.028136 USDC** all-in. Reproduce it with `pnpm --filter @routelock/carbon
smoke:x402` — the script performs discovery, quoting and authorisation-building,
all of which are free, and **refuses to sign**, because the call after a
signature burns a credit irreversibly.

That irreversibility is the justification for the refusal gate rather than a
caveat attached to it: the cost of a wrong approval is unrecoverable and the cost
of a wrong refusal is a delayed purchase.

Two guards exist because of it. A spend cap (1 USDC per retirement, 5 USDC per
rolling 24 hours) and a durable ledger written *before* the request rather than
after it, so a crash mid-flight cannot produce a silent double retirement. And a
test-chain deployment cannot spend at all: `assertKeylessSpendAllowed` throws
unless `ROUTELOCK_X402_ALLOW_LIVE_RETIREMENT` is deliberately set, because there
is no sandbox in which a retirement can be rehearsed.

**A second carbon adapter is retained deliberately.** `CarbonmarkAdapter`
implements Carbonmark's standard REST API, which is KYB-gated. It is kept because
it holds a finding worth publishing: a test-mode retirement returns
`status: COMPLETED`, a real Polygon transaction hash, a real certificate URL and
an on-chain receipt reading SUCCESS — and **retires nothing**. The transaction is
a shared placeholder from April 2024, beneficiary "Developer Tester". The tell
was the block number: the chain head was ~92,017,000 while the transaction sat in
block 55,853,988. *Check that a transaction's block is recent, not merely that the
transaction exists.* `fulfil()` now throws when the beneficiary returned is not
the one requested, because a receipt that does not describe the request is not
evidence for the request. Full detail in
[`docs/carbonmark-verification.md`](docs/carbonmark-verification.md).

### Delivery — reference implementation, not deployed

`ShipbubbleAdapter`, built against the real API and exercised on live sandbox
quotes across three lanes (NG→NG, NG→GB, NG→HK) without consuming shipment quota.
It is **not deployed**, and that is a deliberate choice rather than an
incompletion: a judge in another timezone cannot verify a parcel moving in
Nigeria, so delivery cannot carry the demo. It is retained as the evidence
described above — that the contract set carries no vertical.

Carrier refusals are sourced from the carrier's own published prohibited-items
policy, never from the model's memory of one.

### Compute leasing — not started

`AkashAdapter`, for BOT Chain. Work begins only after X Layer is submitted.

---

## The compliance engine

The engine classifies work against HS nomenclature and returns one of three
verdicts. `Verdict` is a three-way enum — `Approved` / `NeedsInformation` /
`Refused` — not a bool, so **refusals are committed on-chain with the same
treatment as approvals**, and the test suite writes the refusal and
needs-information paths out separately rather than parameterising them, so a
regression names the verdict it broke.

**The model proposes; deterministic code decides.** The LLM never mints, never
activates, never releases escrow and never calls a provider. This is structural,
not procedural: `SettlementEscrow` **reverts** any attempt to grant
`COMPLIANCE_ROLE`, so the compliance service cannot be given authority over funds
by any admin at any point. There is a test asserting it, the deploy script
re-attempts the forbidden grant on every deployment, and you can simulate it
yourself against the live contract — see [Deployments](#deployments).

### Measured, with the numbers published

The benchmark draws on **354 rulings from two independent customs authorities** —
176 from US CBP and 178 from UK HMRC — covering 185 HS-6 subheadings across 57
chapters, every row citing the binding ruling it came from.

Scored with `claude-sonnet-5` in two configurations over the same 253 rows:
classifying from memory, and grounded in the published nomenclature.

| | From memory | Grounded |
|---|---|---|
| Top-1 accuracy | 36.8% | **47.4%** |
| Accuracy of what it **approved** | 79% | **89%** |

47% is low and is stated first anyway: every row is a case an importer paid to
have ruled on *because* the answer was not obvious.

The result that matters is calibration. Classifying from memory, the engine ran
**fifteen to twenty-five points overconfident** at every level. Grounded, at
0.9–1.0 confidence it states 92.0% and delivers **92.6%** — which is what makes a
refusal threshold meaningful, and it says the current 0.9 cross-border bar is set
where it should be.

The run covers **253 of the 354 rows** and the basis is stated wherever the
figures appear. Method, both calibration curves, the strategy that was measured
and discarded, and the coverage limits are in
[`bench/README.md`](bench/README.md); every individual outcome is in
[`bench/data/`](bench/data/) so the figures can be recomputed rather than trusted.

---

## What works today

- **The contract set, with 159 passing tests at 100% branch coverage** — lines,
  statements and functions too, on all five contracts. `ServiceEntitlement`
  (ERC-721 lifecycle plus the transfer lock), `EntitlementFactory` (issuers,
  classes, collateral-backed purchase), `SettlementEscrow`, `ActivationRegistry`,
  and a soulbound `FulfilmentReceipt`.

- **190 further tests across six TypeScript packages** — chain configuration,
  the fulfilment port, both carbon adapters, the carrier adapter, the compliance
  engine, and the benchmark scorer.

- **Four-target chain configuration, verified against the live networks.** Chain
  IDs, RPC liveness, and settlement token `symbol()`/`decimals()` are confirmed by
  querying each chain directly — see
  [`docs/chain-verification.md`](docs/chain-verification.md) for the raw
  responses. Re-runnable with `pnpm verify:chains`.

- **A compile-time gate on fulfilment.** `fulfil()` accepts only
  `Approved<TOrder>`, a type obtainable solely from `approve()` in the compliance
  package. Fulfilling unapproved work is a **compile error**, not a runtime check
  that could be skipped.

- **Boot-time guards that make environment pairing structural.** The process
  throws at start rather than running misconfigured. There is no mock fallback,
  deliberately, and an absent or unrecognised credential throws rather than
  guessing which environment it belongs to.

| Provider | Chain environment | Required credential |
|---|---|---|
| Shipbubble | testnet | sandbox key (`sb_sandbox…`) |
| Shipbubble | mainnet | live key (`sb_prod…`) |
| Carbonmark REST | testnet | sandbox key (`cm_api_sandbox…`) |
| Carbonmark REST | mainnet | **none accepted** — no production key has been seen, so no key boots a mainnet REST carbon adapter |
| Klima x402 | test chains | **refuses to spend** unless explicitly opted in; the endpoint is Base mainnet only and has no sandbox |

- **A deployment script that refuses more than it accepts.** It picks the
  settlement token from the chain id rather than the environment, reads
  `decimals()` before trusting the token, aborts on any chain id it has not
  verified — **including 195**, the stale X Layer testnet id — refuses when
  `ORACLE` and `COMPLIANCE` share an address, and asserts the whole role graph
  including its negative half before recording a single address. A dry run
  verifies everything and writes nothing, so a simulation cannot leave behind a
  file that reads as a real deployment.

## Deployments

### X Layer testnet — live

Chain 1952, deployed 13 August 2026 at 20:55 UTC. The deployment transactions
mined at block **38195716**; `deployedAtBlock` in the address file records
**38195693**, the head at the moment the script began. Both are recorded because
they are different facts, and the receipts under `broadcast/` are the
authoritative ones. Addresses:
[`deployments/xlayer_testnet.json`](deployments/xlayer_testnet.json).
Transaction records:
[`packages/contracts/broadcast/Deploy.s.sol/1952/`](packages/contracts/broadcast/Deploy.s.sol/1952/).

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

Holds 0.00045 OKB. Deploys after the testnet sequence is complete, which is the
order X Layer's eligibility rules require.

### BOT Chain testnet — not deployed

Not blocked: the deployer holds 10 tBOT from the faucet against a ~0.21 tBOT
deploy cost, because BOT Chain gas is 20 gwei against X Layer's 0.02 — roughly 47
deploys of headroom from a single claim. Deferred because X Layer is finished
first.

### BOT Chain mainnet — not deployed

Holds 0.

## Not finished yet

Stated as absent rather than stubbed:

- **No fulfilment has been performed by any adapter.** The carbon adapter is
  funded-blocked: the issuer address holds **0 USDC on Base** against the
  ~0.03 USDC a 0.001 t retirement costs.
- **The attestation package and public replay endpoint** (`packages/attest`) —
  empty, nothing scaffolded.
- **The frontend** (`apps/web`, `apps/api`) — empty, nothing scaffolded.
- **`ActivationRegistry` is deployed but not yet wired** to the adapters.
- **The compute adapter** — not started.
- **`ADMIN` and `ORACLE` share one key**, as a testnet shortcut. They are
  separated before any mainnet deploy.

See [`PROGRESS.md`](PROGRESS.md) and [`HANDOFF.md`](HANDOFF.md).

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

Carbon retirement settles on **Base mainnet** (8453), in USDC
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Nothing is deployed there — it is
where the third-party retirement executes.

Note that X Layer testnet is chain ID **1952**, not the 195 still listed by
several third-party chain directories — that value predates X Layer's migration
to the OP Stack. Both of OKX's own testnet RPCs report 1952, and `verify:chains`
asserts it on every run so a stale value cannot reach a deploy.

## Development

```bash
pnpm install
pnpm verify:chains    # re-verify all four chains against live RPC
pnpm -r test          # 190 tests across six packages

cd packages/contracts && forge test    # 159 tests
```

Exercise the carbon adapter against the live endpoint, for free, with no
possibility of spending:

```bash
pnpm --filter @routelock/carbon smoke:x402
```

Deploying:

```bash
./scripts/deploy.sh xlayer_testnet               # simulate, writes nothing
./scripts/deploy.sh botchain_testnet --broadcast # deploy for real
```

Requires Node 20+, pnpm, and Foundry.
