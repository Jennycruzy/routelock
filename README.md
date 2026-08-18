# RouteLock

> RouteLock turns a service provider's real contractual commitment into a
> transferable, escrow-backed on-chain entitlement, and gates its redemption
> behind an AI compliance engine that classifies the work, determines
> eligibility, and **refuses to proceed when its confidence is insufficient** —
> so nothing moves on a guessed declaration.

**Status: 18 August 2026** — **live on X Layer mainnet**, and two real carbon
credits retired: one on testnet against entitlement 4, one on
[**mainnet**](https://app.carbonmark.com/retirements/id/8453-0xdb7451c298d6f57b58874bd1f7e7c447863ed1e1190c98cc45478c9aae285f0d-0)
against entitlement 1. Both have public certificates anyone can open, and both
were checked against the chain rather than trusted — the mainnet retirement was
**64 blocks** behind Base's head when verified. This README describes what is built and says plainly
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
| `carbonmark-x402` | Carbon retirement | X Layer **testnet + mainnet** | **Active** since 17 Aug 2026. Two real retirements, discharging entitlement 4 on testnet and entitlement 1 on mainnet. | [testnet](https://app.carbonmark.com/retirements/id/8453-0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2-0) · [mainnet](https://app.carbonmark.com/retirements/id/8453-0xdb7451c298d6f57b58874bd1f7e7c447863ed1e1190c98cc45478c9aae285f0d-0) |
| `shipbubble` | Delivery | none | **Reference implementation.** Built against the real API, deliberately not deployed. | Carrier label + tracking number |
| `akash` | Compute leasing | — | **Not started.** Named here because the port it will implement already exists, not because any of it is built. | On-chain lease + ingress URL |

The five contracts already deployed at the addresses below would back a
pallet-month of bonded warehousing, a cold-chain window, or a freight slot
**without a redeploy and without a line changed** — a different label, a
different terms document, a different adapter.

[`docs/adapters.md`](docs/adapters.md) is the authoritative status record and
defines the vocabulary above. A status moves to **Active** only once that adapter
has performed a real fulfilment on the named chain. **One of the three has** —
carbon, on 17 August. The other two rows are honest absences, not work in
progress.

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

### What is now true of the asset, and what is still not

This section exists because the claim above is the part most worth being
sceptical of. Two of its three limitations were resolved on 17 August; the
remaining one is stated rather than smoothed over.

**Resolved.** An obligation has been issued through the deployment and
discharged. `totalMinted()` returns **4** — check it yourself:

```bash
cast call 0x8A9A92a5Cd3c1eF2D2F0b5cD67E33e73949C992b 'totalMinted()(uint256)' \
  --rpc-url https://testrpc.xlayer.tech
```

Entitlement 4 was collateralised, purchased into escrow, bound to a work
specification, ruled on by the engine, committed on chain, fulfilled by a real
carbon retirement, and had the provider's own evidence committed back.

**And then it was unwound, which is the half that had never been exercised.** On
17 August all four entitlements were settled and the escrow emptied to **zero**,
paying each side what the chain said it was owed: entitlement 4 **released to the
issuer**, because the provider's evidence is committed against it; entitlements
1–3 **refunded to the buyer**, because no fulfilment was ever proven for them.
6.2 USD₮0 of collateral was returned once those settlements discharged the
obligations backing it.

That direction matters more than a balance sitting still. A collateral system
that can take money and has never given it back is an untested promise, and the
refunds are the evidence that a buyer whose work is not performed gets paid out
rather than written off. The unwind is reproducible —
`pnpm --filter @routelock/attest recover` — and it reads who to pay from
`carrierRefHash` rather than from a flag, so it cannot be pointed at the wrong
party. Check the escrow yourself:

```bash
cast call 0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c 'balanceOf(address)(uint256)' \
  0x58eba10730Fd1ee4E5b24AaAa7caE154cbC69C83 --rpc-url https://testrpc.xlayer.tech
```

**Still not true, and worth knowing:**

- **`FulfilmentReceipt` has never been minted** — `totalReceipts()` returns `0`.
  The audit trail lives in `ActivationRegistry`, which is where the retirement's
  evidence was written; the soulbound receipt contract is deployed, tested and
  unused. It is not required for a fulfilment and is not pretending to be.
- ~~**Testnet only.**~~ **No longer true, as of 17 August.** RouteLock is
  deployed on **X Layer mainnet** (196) and has completed a full end-to-end run
  there: entitlement 1, `Activated`, a real 0.001 t credit retired against it,
  and the provider's evidence committed back. Certificate
  [`8453-0xdb7451c2…-0`](https://app.carbonmark.com/retirements/id/8453-0xdb7451c298d6f57b58874bd1f7e7c447863ed1e1190c98cc45478c9aae285f0d-0).
  Addresses in [`deployments/xlayer_mainnet.json`](deployments/xlayer_mainnet.json).
  On mainnet **`ADMIN` and `ORACLE` are separate keys** — the oracle signs
  unattended, so it holds no authority over roles.
- **No issuer agreement exists in writing** for any of the three verticals. The
  issuer here is this project, which is honest but is not a counterparty
  relationship.

So RouteLock is a working, deployed settlement and compliance layer that has now
carried one real obligation end to end — on testnet, with real money spent at the
fulfilment leg, and with the proof at a third party rather than here.

---

## The three adapters in detail

### Carbon retirement — the entitlement X Layer settles

The obligation tokenised here is **not the credit**. The credit is already a
real-world asset custodied in a registry. It is the *obligation to retire one*,
which is the part that is currently unenforceable: offsets sold at checkout are
paid for immediately and retired later, in bulk, if at all. That obligation —
issued, collateralised, escrowed, adjudicated and audited — lives entirely on
X Layer.

#### How access to a real registry was obtained, without an onboarding queue

This is the first thing to explain, because it is the reason this adapter can
retire a real credit at all rather than describing one.

Carbonmark's standard REST API is **KYB-gated**: corporate compliance review, a
signed API Services Agreement, then dashboard access before a live key is
issued. That is a multi-week commercial process. It cannot be cleared on a build
timeline, and a project that waited for it would have nothing real to show.

The alternative used here is **Klima's x402 endpoint**, which needs **no API key,
no account and no onboarding**. Payment is authorised per request by signature —
an EIP-3009 authorisation the issuer signs — and the retirements it performs are
genuine, landing on a public certificate at the registry that issued the credit.
Keyless access is what makes an unonboarded project's retirement real instead of
simulated, and it is why this vertical could lead when delivery and compute could
not.

#### Where each leg runs, and what is deployed where

**Nothing of RouteLock is deployed on any chain other than X Layer.** Nothing is
bridged, and no credit is wrapped or tokenised.

| | Chain | What happens |
|---|---|---|
| The entitlement, collateral, escrow, compliance decision and audit trail | **X Layer** | Everything this project owns and deploys |
| The issuer paying their supplier for the credit | Base | An external provider's own payment rails, touched by one signature |

The second row is a **cost of goods**, not a settlement layer. A service provider
pays its suppliers wherever those suppliers bank; a courier in Port Harcourt has
costs in naira and is still paid by its customer in USDT. The buyer's money never
goes near Base — it sits in `SettlementEscrow` on X Layer and is released against
proof. What crosses to Base is the issuer's own ~0.028 USDC.

The payoff for choosing a supplier with a public registry is verification:
anyone can read X Layer state, then check the retirement certificate at the
registry itself. That is stronger than a self-contained system where every claim
traces back to this project's own database.

#### One real credit, retired — 17 August 2026

**0.001 t of UCR-437-2023** (Solar PV – Small Scale, India), charged **0.027725
USDC** on Base, discharging **entitlement 4** on X Layer testnet. The engine
ruled `APPROVED` — the verdict the chain records, against the 0.7 carbon
threshold — the decision was committed on chain by the compliance key, the credit
was retired, and the provider's own evidence was committed back:

**[Open the certificate ↗](https://app.carbonmark.com/retirements/id/8453-0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2-0)**
· [payment tx on Base](https://basescan.org/tx/0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2)
· `cast call 0x38D8a1e9bC45378E4019320ECa4fc5431BeF40Bb 'activations(uint256)(bytes32,bytes32,bytes32,bytes32,bytes32,string,uint64,uint64,uint32,uint8)' 4 --rpc-url https://testrpc.xlayer.tech`

Four things were checked before calling it real, because the last time every
signal said success and nothing had been retired: the transaction sits **466
blocks** behind the head rather than 36 million; its logs name `RouteLock
entitlement holder` and `RouteLock entitlement 4` rather than a shared
`Developer Tester`; `verify()` still returns `retired` against the live endpoint;
and the issuer's USDC went 2.990000 → 2.962275. Full evidence in
[`docs/adapters.md`](docs/adapters.md).

Inventory is read live, not cached — on 17 August, **six credit classes** priced
from $0.023/t to $284/t. Reproduce the free half with
`pnpm --filter @routelock/carbon smoke:x402`: discovery, quoting and
authorisation-building all cost nothing, and the script **refuses to sign**,
because the call after a signature burns a credit irreversibly.

That irreversibility is the justification for the refusal gate rather than a
caveat attached to it: the cost of a wrong approval is unrecoverable and the cost
of a wrong refusal is a delayed purchase.

Two guards exist because of it. A spend cap (1 USDC per retirement, 5 USDC per
rolling 24 hours) and a durable ledger written *before* the request rather than
after it, so a crash mid-flight cannot produce a silent double retirement. And a
test-chain deployment cannot spend at all: `assertKeylessSpendAllowed` throws
unless `ROUTELOCK_X402_ALLOW_LIVE_RETIREMENT` is deliberately set, because there
is no sandbox in which a retirement can be rehearsed.

#### The KYB-gated path is still in the tree, and why

`CarbonmarkAdapter` implements the REST API described above. It is retained
rather than deleted because it holds a finding worth publishing, and because it
is the evidence that the keyless route was chosen on merit rather than for
convenience: a test-mode retirement returns
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
incompletion. A delivery fulfilment is provable only to its counterparties: the
proof is a carrier label and a parcel that physically moves in one country, which
nobody else can independently check. Carbon retirement is the opposite — the
proof is a public certificate at the registry that issued the credit. For a
system whose entire argument is *don't trust us, check it*, the vertical that
leads has to be the one with third-party-verifiable fulfilment. Delivery is
retained as the evidence described above: that the contract set carries no
vertical.

Carrier refusals are sourced from the carrier's own published prohibited-items
policy, never from the model's memory of one.

### Compute leasing — not started

`AkashAdapter`. Nothing is built. It is named because the third vertical is what
makes the generality claim falsifiable rather than rhetorical: the
`FulfilmentAdapter` port it would implement already exists and is already
implemented twice, so the claim can be checked against the two that are built
rather than promised against the one that is not.

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

### The carbon engine, measured the same way — and what the measurement refused to support

Ground truth is the **ICVCM Core Carbon Principles assessment status**: 181
methodologies, an independent body's dated determination, most with a published
assessment report. It is parsed and committed at
[`bench/data/icvcm-decisions.json`](bench/data/icvcm-decisions.json).

**The count came before the spend, and it killed an arm.** Of everything
purchasable on a recognised registry — 18 projects with real supply — 16 join to
an ICVCM decision, and **all 16 are on methodologies ICVCM rejected**. There is no
CCP-Approved credit for sale to test the opposite direction on, so the
false-positive rate this benchmark was meant to report **is not reported, because
it cannot be measured**. That finding cost nothing to establish and is published
in place of the number it replaced.

What 15 model calls over the two surviving determinations did show:

| | `ACM0002` (n=13) | `AMS-I.D.` (n=2) |
|---|---|---|
| Rated the rejected methodology `strong` | **0** | **0** |
| Named a specific integrity concern | 13 | 2 |
| **Named ICVCM, CCP, or the determination** | **0** | **0** |

The engine never called a rejected methodology strong — the error that would
mislead a buyer. But **not one disclosure named the authority**, so a buyer
reading the on-chain evidence gets a real concern they cannot follow to the
document that supports it. That is a defect in RouteLock, found by measuring
RouteLock, and it is published here rather than fixed quietly before anyone saw
it.

### Fixing it, and the half that stayed broken

The prompt now requires every adverse finding to name the source behind it. Same
corpus, same model, 15 more calls:

| | Before | After |
|---|---|---|
| Findings carrying a named source | 4 of 46 | **23 of 31** |
| Rows naming ICVCM or the CCPs | 0 of 15 | **0 of 15** |

Nearly three-quarters of findings now point at something a buyer can open —
Öko-Institut's *How additional is the CDM?*, Verra's post-2015 hydro rule change,
a Berkeley review — against one in eleven before, and the engine now volunteers
when it is reasoning rather than citing. **The specific defect above is still not
fixed**: it cites other bodies fluently and never ICVCM.

It could be fixed in one word, by naming ICVCM in the prompt. **That is refused,
and a test enforces the refusal** — the prompt is barred from containing the
terms the benchmark scores on, because a metric that shares a vocabulary with the
instruction stops measuring what the model knows and starts measuring whether it
can copy. The number would go to 15 of 15 and mean nothing.

Three limits stated with the table, not beneath it: there is **no positive
control**, so this cannot show the engine discriminates, only that it did not err
in the costly direction; the corpus is Carbonmark's REST catalogue, while the
deployed x402 inventory names sectoral scopes that match no ICVCM decision at all
— so **none of this describes the live retirement path**; and the before/after is
**n=15 with one sampling draw per arm**, scored by a keyword list written after
the outputs were read, so it describes a change rather than proving one. Full
reasoning in
[`docs/carbon-benchmark-design.md`](docs/carbon-benchmark-design.md) §9–§11.

---

## What works today

- **The contract set, with 159 passing tests at 100% branch coverage** — lines,
  statements and functions too, on all five contracts. `ServiceEntitlement`
  (ERC-721 lifecycle plus the transfer lock), `EntitlementFactory` (issuers,
  classes, collateral-backed purchase), `SettlementEscrow`, `ActivationRegistry`,
  and a soulbound `FulfilmentReceipt`.

- **334 TypeScript tests across eight packages** — chain configuration, the
  fulfilment port, both carbon adapters, the carrier adapter, the compliance
  engine, the benchmark scorer, the API and benchmark utilities.

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

### X Layer mainnet — live

Deployed 17 August 2026 after the testnet sequence. The deployment and broadcast
record are in [`deployments/xlayer_mainnet.json`](deployments/xlayer_mainnet.json)
and [`packages/contracts/broadcast/Deploy.s.sol/196/`](packages/contracts/broadcast/Deploy.s.sol/196/).
It completed a real end-to-end carbon run: entitlement 1 is `Activated`, with
the compliance decision, fulfilment evidence and Step 10 settlement recorded.
`ADMIN` and `ORACLE` are separate keys on mainnet.

### BOT Chain testnet — live

Deployed 18 August 2026 on chain 968. The deployment record is
[`deployments/botchain_testnet.json`](deployments/botchain_testnet.json), with
broadcast transactions under
[`packages/contracts/broadcast/Deploy.s.sol/968/`](packages/contracts/broadcast/Deploy.s.sol/968/).
The five contracts are live at:

| Contract | Address |
|---|---|
| `ServiceEntitlement` | `0x16DBdF87A9A99891eb2B89557527269B81a991D4` |
| `SettlementEscrow` | `0x5caeCb1fD4101b49f921E826ea8a7a390D42FA43` |
| `EntitlementFactory` | `0xA336656FA1DAcBB99d3C02a45fF8382a17263FD8` |
| `ActivationRegistry` | `0xC9bF75F4c0950bC5c53538A12Dc172C13a274dBe` |
| `FulfilmentReceipt` | `0xC47c81B384cb20D23B18dA760C8E5f4587Ab7997` |

The deployment cost **0.14356402 tBOT**. Live verification confirms the
bytecode, wiring, role graph and `ComplianceRoleForbiddenHere()` escrow guard.

The BOT testnet wallets are now funded for the e2e run: the oracle holds **0.5
tBOT**, the deployer holds **0.3 tUSDT**, and compliance retains **999.7
tUSDT**. The native transfer is
`0x922c80288b2951c23fb957ed5b35cab97a02d6c6826a514771e49fca1a24560e` and the
tUSDT transfer is
`0xd7f03ff5aecfda17ca7c2a418896529406d2bb7300f591250849d86a0ac77bb3`.

The first BOT e2e run completed its non-approval branch on token **1**. The
live model returned `NEEDS_INFORMATION` (`low_confidence`, confidence 0.62),
and the compliance decision was committed with hash
`0xead68579d76cb0f462f4f20e3ed4eecdb86dbbfb3d446d3ccb4574b659931a3a`.
The run correctly stopped before retirement and oracle settlement. Token 1 is
reusable, while its 0.3 tUSDT remains safely in escrow until the recovery step.

### Other verified targets — not deployed

The chain layer resolves and verifies four targets in total (see
[Verified networks](#verified-networks)). X Layer and BOT testnet carry
deployments; BOT mainnet remains configured, RPC-verified and settlement-token-
verified so portability is a checkable property of the config rather than an
assertion in prose.

## Not finished yet

Stated as absent rather than stubbed:

- **Only one of the three adapters has fulfilled anything.** Carbon has, once —
  see above. Delivery is deliberately not deployed and compute is not built, so
  two of the three rows in the adapter table are honest absences rather than work
  in progress.
- **The BOT Chain testnet e2e has completed its first non-approval branch.** The
  current balances are deployer 9.35601598 tBOT / 0 tUSDT, compliance 10 tBOT /
  999.7 tUSDT, and oracle 0.5 tBOT; the deployer's 0.3 tUSDT is held by escrow
  for token 1. Recover that deposit and collateral, then rerun for an approved
  path before deploying BOT Chain mainnet.
- **The compute adapter** — not started.
- **The HS benchmark stands at 253 of 354 rows**, and the figures published here
  say so. The remaining rows are parked deliberately, not pending.
- **`ADMIN` and `ORACLE` share one key only on the existing testnet deployment**;
  mainnet uses a separate oracle key.

See [`PROGRESS.md`](PROGRESS.md) and [`HANDOFF.md`](HANDOFF.md).

## Verified networks

All four targets settle in a 6-decimal USD stablecoin, so pricing arithmetic is
identical everywhere. Every row below is confirmed by live RPC, not copied from
a docs page.

| Target | Chain ID | Settlement |
|---|---|---|
| X Layer testnet | 1952 | USD₮0 `0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c` |
| X Layer mainnet | 196 | USD₮0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` |
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
pnpm -r test          # 334 tests across eight packages

cd packages/contracts && forge test    # 159 tests
```

Run the frontend a judge can drive:

```bash
pnpm --filter @routelock/api start     # http://127.0.0.1:8787
```

It serves live chain state, the live `COMPLIANCE_ROLE` refusal probe, the
retirement and its certificate, the compliance engine on your own goods, and the
on-chain audit trail for any token. **It holds no key and signs nothing** — a
test reads the API's own source and fails if a signing symbol appears in it.
Model-backed endpoints are rate limited and spend from their own capped ledger,
separate from the operator's, and answer `402` when that cap is reached rather
than degrading quietly.

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
