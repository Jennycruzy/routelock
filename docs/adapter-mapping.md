# Registry field mapping

`ActivationRegistry` stores five hashes per activation. Their names come from
delivery, the first vertical this system was written for.

**These field names are generic by accident of history and retained by choice.
The contracts were written for delivery and now back carbon retirement and
compute leasing without a single byte changed — which is the claim, demonstrated
rather than asserted.**

| Registry field | Delivery | Carbon retirement | Compute lease |
|---|---|---|---|
| `parcelHash` | parcel spec — weight, dimensions, declared value, canonical items | retirement request — beneficiary, quantity, credit class | workload spec — image, resources, duration |
| `documentsHash` | commercial invoice and shipping documents | retrieved evidence set — registry metadata and published adverse findings | provider acceptable-use policy set assessed against |
| `decisionHash` | HS classification decision | credit-quality decision | workload-permission decision |
| `carrierRefHash` | tracking number | Polygon retirement transaction hash | Akash lease ID (`dseq/gseq/oseq`) |
| `carrierRawHash` | raw carrier API response | raw Carbonmark API response | raw lease query response |

`parcelHash` is documented in the contract source as
`hash(weight, dims, declaredValue, itemsCanonical)`. That comment is delivery
vocabulary describing a field that is, in fact, an opaque commitment to whatever
the adapter considers the specification of the work. Adapters supply the
preimage; the contract never parses it.

## Why they are not renamed

Renaming them would require redeploying the contract set, which would destroy
the deployment history that evidences X Layer's testnet-before-mainnet
requirement — and, more importantly, would destroy the evidence itself. A
contract deployed on 13 August 2026, before any carbon work existed, that
backs a carbon retirement without modification is a stronger claim than any
wording could make.

**Do not rename these fields. Do not redeploy to rename them.**

## What the contracts do not know

`classId` is `keccak256` of a class string and is opaque on-chain. Nothing in
the five deployed contracts carries an origin, a destination, a weight, a
carrier, a parcel, a registry, a project key, a vintage, or a GPU class. The
vertical lives entirely in the adapter and in the compliance corpus.

This is checkable rather than assertable:

```bash
grep -riE 'parcel|carrier|origin|destination|weight|courier|shipment' \
  packages/contracts/src/*.sol
```

Run on 14 August 2026, this returns hits in **`ActivationRegistry` only**.
`ServiceEntitlement`, `EntitlementFactory`, `SettlementEscrow` and
`FulfilmentReceipt` contain no delivery vocabulary at all.

Within `ActivationRegistry`, every hit is a **name** — a struct field
(`parcelHash`), an event (`ParcelSubmitted`, `CarrierRecorded`), a function
(`submitParcel`, `recordCarrier`), or a comment explaining one. The ABI
therefore does carry delivery vocabulary, and that is left visible on purpose.

What matters is what is absent: no hit is a *type the contract interprets*, a
*parameter it parses*, or a *branch in its logic*. Every one of these values is
an opaque `bytes32` written and read without inspection. Delivery named these
fields; it never taught the contract anything about delivery. If a future change
makes any of them load-bearing in contract logic, this claim stops being true
and this document must stop making it.
