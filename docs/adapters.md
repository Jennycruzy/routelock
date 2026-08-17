# Adapters

Three verticals, one unchanged contract set. An adapter is where a generic
service obligation becomes a specific one; the contracts below it do not change
when the vertical does.

This table is the authoritative status record. **It states what is true today,
not what is planned.** A status moves to Active only once that adapter has
performed a real fulfilment on the named chain.

| Adapter | Chain | Status | Fulfilment proof |
|---|---|---|---|
| `carbonmark-x402` | X Layer | **Active** since 17 August 2026. One real retirement, 0.001 t of UCR-437-2023, charged 0.027725 USDC on Base, committed against entitlement 4 on X Layer. | [Public certificate](https://app.carbonmark.com/retirements/id/8453-0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2-0) |
| `carbonmark` (REST) | X Layer | **Superseded.** Retained, not shipped — Carbonmark's REST API is KYB-gated and a test-mode key retires nothing. | Public certificate URL |
| `akash` | — | **Not started.** No implementation. | On-chain lease + ingress URL |
| `shipbubble` | none | **Reference implementation. Not deployed.** Retained to demonstrate the contract set carries no vertical. | Carrier label + tracking |

## Two carbon adapters, and how access was obtained

**The access question comes first**, because it is what decides whether a
retirement is real or described.

Carbonmark's standard REST API is **KYB-gated**: corporate compliance review, a
signed API Services Agreement, then dashboard access before a live key exists.
That is a multi-week commercial process and cannot be cleared on a build
timeline. `CarbonmarkAdapter` implements it and is exercised as far as a
test-mode key allows, which is not far — see below.

`CarbonmarkX402Adapter` is the one that ships. **Klima's x402 endpoint needs no
API key, no account and no onboarding**: payment is authorised per request by an
EIP-3009 signature, and the retirements are genuine. Keyless access is the whole
reason an unonboarded project can retire a real credit, and it is why carbon
could lead when the other two verticals could not.

**Chain placement.** The entitlement, collateral, escrow, compliance decision and
audit trail are on **X Layer** — that is everything this project deploys.
Nothing of RouteLock is deployed on any other chain, nothing is bridged, and no
credit is wrapped. The issuer's payment to the supplier crosses on Base because
that is where the supplier's rails are; it is a cost of goods, not a settlement
layer, and the buyer's escrowed funds never leave X Layer.

The REST adapter is retained rather than deleted because it holds the finding
that a test-mode retirement returns a shared placeholder and retires nothing —
and because it is the evidence that the keyless route was chosen on merit. See
[carbonmark-verification.md](./carbonmark-verification.md).

The status vocabulary below gains one term for this: **Superseded** means built
and exercised, kept in the tree for the evidence it carries, and not on the path
to Active.

## What moved carbon to Active, 17 August 2026

Recorded here in the form a stranger can re-check, because the table above claims
a status and a claim needs its evidence next to it.

| | |
|---|---|
| Credit | UCR-437-2023, Solar PV – Small Scale, India, class `0x1ff9bd464155d32fd2f9d302008d38544c0ae371` |
| Amount | 0.001 t |
| Charged | 0.027725 USDC, against 0.028125 authorised |
| Payment transaction | [`0x8717eb0f…58d7b6d2`](https://basescan.org/tx/0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2) on Base, block 50,083,814, mined 08:56:15 UTC |
| Certificate | [app.carbonmark.com/retirements/id/8453-0x8717eb0f…-0](https://app.carbonmark.com/retirements/id/8453-0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2-0) |
| Obligation discharged | Entitlement **4** on X Layer testnet, `Activated`, verdict `APPROVED`, all five commitments recorded |

**The checks that were run before calling it real**, because the last time every
signal said success and nothing had been retired:

- **The block is recent.** 50,083,814 against a head of 50,084,280 at the time of
  checking — 466 blocks, about fifteen minutes. The placeholder that fooled an
  earlier run sat 36 million blocks in the past.
- **The retirement names this project.** The transaction's own logs carry
  `RouteLock entitlement holder` and `RouteLock entitlement 4`, not the shared
  `Developer Tester` beneficiary.
- **The provider still confirms it.** `adapter.verify()` returns
  `state: "retired"`, `found: true` against the live endpoint, not against a
  stored copy.
- **The money left.** The issuer's Base USDC went 2.990000 → 2.962275.

`GET /api/fulfilment` serves all of this re-verified at request time, including
the block distance, so the frontend cannot show a stale receipt as proof.

## Status vocabulary

| Status | Means |
|---|---|
| **Active** | Deployed on the named chain and has completed at least one real fulfilment, with a public proof URL that a third party can check without trusting this project. |
| **In development** | Code exists. No real fulfilment has been performed. Nothing in the UI or README may present it as working. |
| **Not started** | No implementation. |
| **Reference implementation** | Built and exercised against the provider's real API, deliberately not deployed. Present as evidence of vertical-agnosticism. |
| **Superseded** | Built and exercised, kept for the evidence it carries, not on the path to Active. |

Delivery is not deleted. Three adapters against one unchanged contract set is
stronger evidence of generality than two, and the delivery adapter is the one
that proves the contracts predate the vertical now running on them — see
[adapter-mapping.md](./adapter-mapping.md).

## Every adapter file carries a status header

The header repeats this table's status at the top of the source file, so the
status cannot drift out of sight of the code:

```typescript
/**
 * ShipbubbleAdapter — DELIVERY
 * Status:  REFERENCE IMPLEMENTATION. Not deployed on any chain.
 * Purpose: Demonstrates that the same FulfilmentAdapter interface and the same
 *          unchanged contract set back a physical-logistics obligation. Retained
 *          as evidence of vertical-agnosticism, not as a live integration.
 * See docs/adapters.md
 */
```

## Chain binding is enforced, not implied

Each chain declares the adapters it may load, and a boot assertion throws if a
chain is configured with an adapter outside its allow-list. An X Layer
deployment cannot load the compute adapter, and a BOT Chain deployment cannot
load the carbon adapter, regardless of what an environment variable says.

This sits alongside the existing boot-time guard that pairs testnet chains with
sandbox provider credentials and mainnet chains with live ones. Both throw at
process start, before any route is registered. There is no mock fallback in
either.
