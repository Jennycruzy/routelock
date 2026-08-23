# RouteLock Agent

**AI-gated, collateral-backed service entitlements for verifiable real-world work.**

[Live application](https://routelock.site) · [X Layer carbon lane](https://routelock.site/) · [BOT Chain compute lane](https://routelock.site/botchain/)

RouteLock turns a provider's promise to perform a service into a transferable
on-chain entitlement. Provider collateral protects the obligation, an AI-assisted
compliance engine evaluates each request, and escrow releases payment only after
verifiable fulfilment evidence has been recorded.

| Network | Product | What is live | Public proof |
|---|---|---|---|
| **X Layer mainnet (196)** | Carbon retirement | Permissionless offers, USD₮0 collateral and escrow, AI-assisted approval, fulfilment receipts, and optional Aave V3 yield | [Retirement certificate](https://app.carbonmark.com/retirements/id/8453-0xdb7451c298d6f57b58874bd1f7e7c447863ed1e1190c98cc45478c9aae285f0d-0) |
| **BOT Chain mainnet (677)** | Decentralized compute | USDT-backed compute entitlement, AI policy decision, real Akash lease, provider evidence, and proof-gated settlement | [Akash workload](https://f55mg7h4k5a0f4li7ne2ljrjj8.ingress.boogle.cloud/) · [Settlement](https://scan.botchain.ai/tx/0x9cfb98f4c5ae1db9bf318ab3a0cd631385d4da40c43067eeaab595880c288cab) |

> **Status — completed:** carbon retirement is active on X Layer and compute
> fulfilment is active on BOT Chain. Both lanes have completed a real external
> fulfilment; neither proof is simulated.

## The problem

Most on-chain marketplaces can prove that payment moved, but not that an
off-chain service was eligible, correctly performed, or independently
verifiable. Buyers must trust a provider before delivery, while providers lack
a reusable way to collateralize and sell future service capacity.

RouteLock closes that gap:

1. A provider publishes a priced service class and backs it with stablecoin collateral.
2. A buyer requests a service and funds an entitlement.
3. The compliance engine evaluates live policy and structured evidence. It can
   return `APPROVED`, `NEEDS_INFORMATION`, or `REFUSED`.
4. Approved work is performed by the external provider.
5. An oracle records provider evidence and the public fulfilment reference.
6. Escrow releases payment only after the proof gate is satisfied.

The AI proposes and explains a decision; deterministic policy produces the
final verdict. The AI cannot mint entitlements, move collateral, or release
buyer funds.

## Why this is an RWA protocol

The real-world asset is the provider's collateral-backed obligation to perform
a specific service. The NFT represents the right to receive that service—not a
wrapped carbon credit or a speculative claim. It is transferable before
activation, locked during fulfilment, and discharged only when provider
evidence is recorded.

The contracts are vertical-agnostic. Chain configuration binds each production
lane to its intended adapter, so configuration cannot silently turn BOT Chain
into a carbon lane or X Layer into a compute lane.

## X Layer: carbon retirement

### What is deployed

X Layer is RouteLock's carbon-retirement settlement and audit layer:

- permissionless provider registration and offer creation;
- ERC-721 service entitlements;
- provider collateral and buyer payment in USD₮0;
- AI-assisted eligibility decisions and on-chain decision commitments;
- proof-gated escrow settlement and soulbound fulfilment receipts; and
- an Aave V3 strategy for eligible idle provider collateral, with solvency and
  emergency-unwind controls.

The carbon credit is retired through Klima/Carbonmark's x402 flow on Base
mainnet. That external transaction is the provider's cost of fulfilment; buyer
escrow remains on X Layer. RouteLock verifies and records the resulting public
certificate without bridging or wrapping the credit.

### Verified fulfilment

RouteLock completed two real 0.001-tonne retirements, including a mainnet
retirement against entitlement 1:

- [X Layer mainnet retirement certificate](https://app.carbonmark.com/retirements/id/8453-0xdb7451c298d6f57b58874bd1f7e7c447863ed1e1190c98cc45478c9aae285f0d-0)
- [X Layer testnet retirement certificate](https://app.carbonmark.com/retirements/id/8453-0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2-0)

The current mainnet deployment is strategy-aware and permissionless for
providers. Historical proofs remain independently verifiable even though they
predate this fresh Aave-enabled factory.

### X Layer mainnet contracts

Deployment record: [`deployments/xlayer_mainnet.json`](deployments/xlayer_mainnet.json)

| Contract | Address |
|---|---|
| `ServiceEntitlement` | [`0x105B…2293`](https://www.oklink.com/xlayer/address/0x105BAF5638fD84a1CADfF695498288BE20362293) |
| `SettlementEscrow` | [`0x8e7b…030d`](https://www.oklink.com/xlayer/address/0x8e7bB4133F73ae04e006116f0Fc7479A4Fe9030d) |
| `EntitlementFactory` | [`0x31D6…26ba`](https://www.oklink.com/xlayer/address/0x31D6803f22b5447cd862bF3f108160f7aDb326ba) |
| `ActivationRegistry` | [`0xaA25…Cd2`](https://www.oklink.com/xlayer/address/0xaA251a902B699935DfE0e6F784C6dB49043fcCd2) |
| `FulfilmentReceipt` | [`0xc239…98B`](https://www.oklink.com/xlayer/address/0xc239e685365592694ab7309bd96B0B1DB22b998B) |
| `AaveYieldAdapter` | [`0x7869…8143`](https://www.oklink.com/xlayer/address/0x78694f4DE40B6E443f70F0E1E204833Be6D28143) |

Settlement asset: USD₮0 (`0x779Ded0c9e1022225f8E0630b35a9b54bE713736`, 6 decimals).

## BOT Chain: decentralized compute

### What is deployed

BOT Chain is RouteLock's production compute lane. Its Akash adapter:

- evaluates a submitted workload against the live acceptable-use policy;
- lets a buyer configure and review a workload, purchase its entitlement, and
  track the resulting request from the customer interface;
- creates an Akash deployment from an operator-supplied SDL;
- selects and accepts a live provider bid;
- waits for the named service and verifies its public ingress;
- commits the AI decision and provider response on BOT Chain; and
- releases USDT only after provider evidence exists.

### Verified fulfilment

The production run completed a real Akash workload and proof-gated settlement:

| Evidence | Value |
|---|---|
| Entitlement | `1` — `Activated`, decision `APPROVED` |
| Service class | `compute-hello-world-mainnet-1787324033` |
| Decision hash | `0xd16f0c5b65f44cd5dcbec5c2a645981b8184fd959864963df6986f809f86d38f` |
| Current Akash lease | `1787507697713:1:1:akash1k94uya5rhrtj9rfw850az9aq2d6vdpjmtnlgd0#web` |
| Current provider proof | [Public Akash ingress](https://f55mg7h4k5a0f4li7ne2ljrjj8.ingress.boogle.cloud/) |
| On-chain proof | [BOT Chain settlement](https://scan.botchain.ai/tx/0x9cfb98f4c5ae1db9bf318ab3a0cd631385d4da40c43067eeaab595880c288cab) |

Provider evidence was committed before `releaseToIssuer`. The completed record
belongs to the production fulfilment deployment; the current permissionless
factory below is the canonical marketplace deployment.

### BOT Chain mainnet contracts

Deployment record: [`deployments/botchain_mainnet.json`](deployments/botchain_mainnet.json)

| Contract | Address |
|---|---|
| `ServiceEntitlement` | [`0x45Ec…961`](https://scan.botchain.ai/address/0x45Ec523069FDDe1B297b91Aa5dEE308A8F32a961) |
| `SettlementEscrow` | [`0xB7E5…Ab2`](https://scan.botchain.ai/address/0xB7E5613b401cb559BA0051FddB04f8aa524DBAb2) |
| `EntitlementFactory` | [`0x8e57…44Eb`](https://scan.botchain.ai/address/0x8e573b489E4B4b95F4B401AF4e004C0B067A44Eb) |
| `ActivationRegistry` | [`0xAAf0…DA7`](https://scan.botchain.ai/address/0xAAf0653A5643949F4361b23836567005eFB69DA7) |
| `FulfilmentReceipt` | [`0x9005…D39`](https://scan.botchain.ai/address/0x900509A9682D6C754A8392709fCfa9552Aa50D39) |

Settlement asset: USDT (`0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C`, 6 decimals).

BOT Chain testnet (968) remains historical deployment and contract-smoke
evidence. It is not the production compute lane; its earlier carbon-shaped
smoke run is not counted as a supported carbon fulfilment.

## Protocol architecture

```text
Provider                 RouteLock Agent                  Buyer
   │                            │                           │
   ├─ publish offer ───────────►│                           │
   ├─ lock collateral ─────────►│◄──── fund entitlement ────┤
   │                            ├─ evaluate policy/evidence │
   │◄──── approved work ────────┤                           │
   ├─ perform external service  │                           │
   ├─ submit provider proof ───►│                           │
   │                            ├─ verify + record proof    │
   │◄──── release payment ──────┤──── fulfilment receipt ──►│
```

### Contract responsibilities

| Component | Responsibility |
|---|---|
| `ServiceEntitlement` | ERC-721 lifecycle and transfer lock during fulfilment |
| `EntitlementFactory` | Provider registration, service classes, supply, and purchase |
| `SettlementEscrow` | Collateral, buyer funds, solvency, settlement, and recovery |
| `ActivationRegistry` | Activation, decision commitments, and provider evidence |
| `FulfilmentReceipt` | Soulbound completion receipt |
| `AaveYieldAdapter` | X Layer-only movement and accounting of eligible idle collateral |

### Trust boundaries

- **Compliance cannot move money.** Escrow rejects `COMPLIANCE_ROLE` by construction.
- **The oracle cannot manufacture approval.** Compliance and oracle roles are separated.
- **The model cannot fulfil work.** Fulfilment accepts only an `Approved<TOrder>`
  produced by the compliance package.
- **Insufficient evidence stops the flow.** There is no mock or silent fallback.
- **Collateral remains solvent.** Strategy withdrawals cannot leave active
  promises under-backed.

## Repository structure

```text
apps/api/                 Chain-aware API and application server
apps/web/                 X Layer and BOT Chain interfaces
packages/contracts/       Solidity contracts, deployments, and tests
packages/compliance/      Deterministic policy and AI-assisted decisions
packages/carbon/          Carbon retirement adapters
packages/compute/         Live Akash adapter
packages/attest/          End-to-end attestation and recovery scripts
packages/chain/           Verified network configuration
packages/fulfilment/      Shared typed fulfilment interface
deployments/              Deployment manifests
docs/                     Verification records and technical notes
```

## Run locally

Requires Node.js 20+, pnpm, and Foundry.

```bash
pnpm install
pnpm --filter @routelock/api start
```

Run the independent BOT Chain build:

```bash
ROUTELOCK_CHAIN=botchain_mainnet \
ROUTELOCK_API_PORT=8789 \
ROUTELOCK_WEB_INDEX=botchain/index.html \
ROUTELOCK_COMPUTE_PROOF_URL=https://f55mg7h4k5a0f4li7ne2ljrjj8.ingress.boogle.cloud/ \
pnpm --filter @routelock/api start
```

Copy [`.env.example`](.env.example) for provider-backed or signing flows.
Read-only chain state and public proofs do not require buyer private keys.

## Test and verify

```bash
pnpm -r test
pnpm verify:chains

cd packages/contracts
forge test
```

`verify:chains` checks RPC chain IDs and settlement-token metadata for all four
configured networks. Deployment broadcasts are retained under
`packages/contracts/broadcast/Deploy.s.sol/`.

- [`docs/adapters.md`](docs/adapters.md) — adapter status and fulfilment evidence
- [`docs/chain-verification.md`](docs/chain-verification.md) — network checks
- [`docs/carbonmark-verification.md`](docs/carbonmark-verification.md) — retirement validation
- [`docs/adapter-mapping.md`](docs/adapter-mapping.md) — adapter-to-contract mapping
- [`HANDOFF.md`](HANDOFF.md) — detailed operational and historical record

## Current limitations

- Delivery/Shipbubble is a reference implementation and is not deployed.
- The fresh X Layer factory requires a provider to create and back an offer
  before checkout; no provider collateral has yet been supplied to Aave.
- Testnets are retained for verification and history, not presented as
  additional production products.

## License

No license has been declared for this repository.
