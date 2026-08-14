# Adapters

Three verticals, one unchanged contract set. An adapter is where a generic
service obligation becomes a specific one; the contracts below it do not change
when the vertical does.

This table is the authoritative status record. **It states what is true today,
not what is planned.** A status moves to Active only once that adapter has
performed a real fulfilment on the named chain.

| Adapter | Chain | Status | Fulfilment proof |
|---|---|---|---|
| `carbonmark` | X Layer | **In development.** Not deployed. No retirement performed. | Public certificate URL |
| `akash` | BOT Chain | **Not started.** Begins after X Layer is submitted. | On-chain lease + ingress URL |
| `shipbubble` | none | **Reference implementation. Not deployed.** Retained to demonstrate the contract set carries no vertical. | Carrier label + tracking |

## Status vocabulary

| Status | Means |
|---|---|
| **Active** | Deployed on the named chain and has completed at least one real fulfilment, with a public proof URL that a third party can check without trusting this project. |
| **In development** | Code exists. No real fulfilment has been performed. Nothing in the UI or README may present it as working. |
| **Not started** | No implementation. |
| **Reference implementation** | Built and exercised against the provider's real API, deliberately not deployed. Present as evidence of vertical-agnosticism. |

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
