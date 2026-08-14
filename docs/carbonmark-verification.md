# Carbonmark — verified live

Every figure here came from calling the API on **14 August 2026**, not from
reading documentation. Where it contradicts the build spec, the API wins and the
contradiction is recorded rather than quietly reconciled.

## Base URL and authentication

| Finding | Result |
|---|---|
| `api.sandbox.carbonmark.com` | **Does not resolve.** There is no separate sandbox host. |
| `api.carbonmark.com` | Live and answering. |
| Key prefix in use | `cm_api_sandbox…`, 51 characters |

**`/prices` is completely public.** It returns `200` with no `Authorization`
header at all, and `200` with a deliberately invalid key, both with the same
payload. A successful call to it proves nothing about a key's validity, and it
must never be used as a credential check.

**`/orders` is the endpoint that authenticates.** It returned `200` with the
sandbox key and `401` with an invalid one. That difference is the only
confirmation obtained that the key works, and it is what a credential check
should call.

`/users/me` returns `401` for both valid and invalid keys, so it is not usable
as a check either.

## Market data, from 723 live price entries

| Signal | Measured |
|---|---|
| Entries returned | 723 |
| **With liquid supply** | **61** |
| Purchase price | min $0.10, median **$3.78**, max $982.59 |
| `minFillAmount` | 0.001 tonnes |
| Vintages | 2008–2025, 18 distinct |
| Registries | VCS 578, CMARK 42, ICR 40, TVER 35, ECO 2, PUR 1 |

The median price of **$3.78 confirms the build spec's estimate exactly**, and
`minFillAmount` of 0.001 t confirms that a fractional retirement costs well under
a cent. Roughly 20 demo retirements at 0.01 t remain affordable at under a
dollar total.

### Only 61 of 723 listings are actually purchasable

The rest report zero liquid supply. Any class chosen for a demo must come from
that liquid subset, and the subset is checked at the time of the demo rather than
assumed from this snapshot — supply moves.

### The build spec's ERC-1155 claim is wrong for the majority

Spec §4.2 states credits are "ERC-1155 on Polygon (chain 137), **not** ERC-20"
and warns against letting ERC-20 assumptions leak into the code. Measured across
all 723 entries:

| `tokenStandard` | Count |
|---|---|
| `erc20` | 658 |
| `erc1155` | 40 |
| absent | 25 |

The 40 ERC-1155 entries are exactly the 40 ICR listings. The spec's example class
in §3.1 is `CARBON-ICR112-V2019-1T` — an ICR credit — so the claim appears to be
a correct observation about ICR generalised to the whole market.

This changes nothing structural, because **the adapter never holds a credit**; it
calls an API and the registry custodies the asset. It does mean neither the code
nor the README may state that credits are ERC-1155, because for 94% of what is
listed that is false.

## What this data gives the compliance corpus

`creditId` carries `projectId` and `vintage` on every listing, so two of the five
quality signals in spec §5.1 — vintage age and registry — are available directly
from this endpoint with no key and no inference. Verra (VCS) dominates at 578 of
723, which matters for ground truth: Verra is the registry with the most
published suspensions and investigations to draw labels from.

## How to re-verify

```bash
set -a && . ./.env && set +a

# proves the key works — 200 with a valid key, 401 without
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $CARBONMARK_API_KEY" \
  https://api.carbonmark.com/orders

# public; proves nothing about the key
curl -s -o /dev/null -w '%{http_code}\n' https://api.carbonmark.com/prices
```
