# Adapters

Three verticals, one unchanged contract set. An adapter is where a generic
service obligation becomes a specific one; the contracts below it do not change
when the vertical does.

This table is the authoritative status record. **It states what is true today,
not what is planned.** A status moves to Active only once that adapter has
performed a real fulfilment on the named chain.

| Adapter | Chain | Status | Fulfilment proof |
|---|---|---|---|
| `carbonmark-x402` | X Layer **testnet and mainnet** | **Active** since 17 August 2026. Two real retirements: 0.001 t UCR-437-2023 against entitlement 4 on testnet (0.027725 USDC net), and 0.001 t Solar PV – Small Scale against entitlement 1 on **mainnet** (0.027858 USDC net, 0.028259 gross less 0.000401 change). | [testnet](https://app.carbonmark.com/retirements/id/8453-0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2-0) · [mainnet](https://app.carbonmark.com/retirements/id/8453-0xdb7451c298d6f57b58874bd1f7e7c447863ed1e1190c98cc45478c9aae285f0d-0) |
| `carbonmark` (REST) | X Layer | **Superseded.** Retained, not shipped — Carbonmark's REST API is KYB-gated and a test-mode key retires nothing. | Public certificate URL |
| `akash` | **BOT Chain testnet (968)** | **In development.** Live Console API adapter, policy assessment and lease polling are implemented and the real policy path has been exercised; no lease has been created because the final Anthropic credit gate is blocked. | On-chain lease + ingress URL |
| `shipbubble` | none | **Reference implementation. Not deployed.** Retained to demonstrate the contract set carries no vertical. | Carrier label + tracking |

## Chain lanes for the judge

RouteLock keeps the provider lanes separate so a chain's meaning cannot be
changed by an environment variable:

- **X Layer** is the active carbon-retirement lane. Carbonmark proofs and the
  RouteLock entitlement, escrow and compliance record are checked there.
- **BOT Chain testnet 968** is the compute-assets lane. Its generic contracts
  are deployed and funded. `AkashAdapter` is wired to Akash's live Console API,
  but the adapter remains In development until a real operator SDL produces a
  live lease and a public ingress URL.

An earlier BOT run used the carbon-shaped e2e script to exercise generic
registration, escrow, compliance and recovery. That run is historical smoke
evidence only. It is not counted as a BOT carbon deployment or as compute
evidence. The runtime now rejects carbon adapters on BOT before any transaction
can be sent.

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

**Chain placement for carbon.** The carbon entitlement, collateral, escrow,
compliance decision and audit trail are on **X Layer**. BOT Chain testnet 968
also has the unchanged generic contracts, but it is reserved for compute and
the carbon adapter is rejected there. Nothing is bridged, and no credit is
wrapped. The issuer's payment to the supplier crosses on Base because that is
where the supplier's rails are; it is a cost of goods, not a settlement layer,
and the carbon buyer's escrowed funds never leave X Layer.

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

Each chain declares the verticals it may load, and a boot assertion throws if a
chain is configured with an adapter outside its allow-list. An X Layer
deployment cannot load the compute adapter, and a BOT Chain deployment cannot
load the carbon adapter, regardless of what an environment variable says. The
carbon e2e script is therefore X Layer-only; a BOT compute run will use a
separate compute adapter and script.

This sits alongside the existing boot-time guard that pairs testnet chains with
sandbox provider credentials and mainnet chains with live ones. Both throw at
process start, before any route is registered. There is no mock fallback in
either.

## Compute lane: live Akash path

The compute implementation is deliberately live-only. `packages/compute` uses
the Akash Console API to create a deployment from the operator-supplied SDL,
read real bids, accept one lease, poll the deployment until the named service is
ready, probe the returned ingress URL, and re-check that proof later. It does
not contain a recorded bid, a default image, a provider address, or a fake
ingress URL.

The compute e2e is a separate command and refuses to run without `--broadcast`:

```bash
pnpm --filter @routelock/attest compute:e2e --broadcast
```

Before it writes BOT Chain state, it verifies the live RPC chain id and USDT
metadata, the deployment addresses, oracle/compliance role separation and the
real acceptable-use policy URL. It requires the SDL, workload description,
service name, Akash API key, economics, polling limits and interactive
keystore account names in `.env`; see [`.env.example`](../.env.example).

The current local workload is `hello-world.yaml`, using the real public Akash
Hello World image pinned to digest
`sha256:2872578146c16a510f182e62bc1132ec38af4f70a38841c4642e76ae75da5bb1`.
The Console terms page is client-rendered; the adapter follows its same-origin
terms asset and retains both the canonical policy URL and the fetched source URL
as evidence. A non-approval exits before signer unlock, BOT transactions or
Akash deployment creation.

The Console API flow is the provider's documented sequence: create deployment,
read bids, accept a lease, then poll deployment status. See Akash's [Console API
getting started](https://akash.network/docs/api-documentation/console-api/getting-started/)
and [API reference](https://akash.network/docs/api-documentation/console-api/api-reference/).
