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

## The test-mode key retires nothing — spec §4.3 was right

**Established 14 August 2026 by submitting a real order and then checking what
came back.** The order completed. It retired nothing.

| Field | Returned | What it actually is |
|---|---|---|
| `status` | `COMPLETED` | the *order* completed |
| `transaction_hash` | `0xa36425…94a9` | a real Polygon tx in block **55,853,988** |
| block timestamp | **2024-04-15** | over two years before the order |
| `beneficiary_name` | **`Developer Tester`** | not the requested `RouteLock` |
| amount on that retirement | 0.123 t | not the 0.01 t ordered |

Carbonmark states it plainly in the retirement record itself:

> *"This is a placeholder retirement for TEST MODE API retirements. This is a
> real retirement, but was already pre-retired at the time you submitted your
> test order to the Carbonmark API. **Every retirement using a TEST MODE
> credential will link to this same placeholder retirement page. Do not deliver
> this to customers, as the environmental benefit has already been claimed.**"*

**The certificate URL must never be shown to a judge.** It is one shared page
that every test-mode user in the world links to, describing someone else's 2024
retirement.

Nothing was charged and no credit was retired, so the experiment cost nothing
but is not evidence of a working retirement.

### How this was nearly missed

The order returned `status: COMPLETED`, a real transaction hash, a real
certificate URL, and an on-chain receipt reading `SUCCESS` with 34 logs. Every
individual signal looked like success, and the transaction is genuinely on
Polygon mainnet — it simply is not *this* order's transaction.

**The block number was the tell.** The chain head was ~92,017,000 while the
transaction sat in block 55,853,988; a transaction created minutes ago cannot be
36 million blocks old. **Check that a transaction's block is recent, not merely
that the transaction exists.**

The general form of the check is stronger and is what the code now enforces:
compare what came back against what was asked for. The placeholder names a
different beneficiary and a different quantity, so a receipt that does not
describe the request is not evidence for the request — whatever else about it
looks real.

`CarbonmarkAdapter.fulfil()` throws when the beneficiary does not match, because
a `Receipt` is what gets hashed into `carrierRefHash` and published as proof.

**Consequence: production access is the gate for a real retirement**, as
originally assumed. Everything upstream of it — listings, supply, assessment,
quoting — is fully exercised against real data with the test key.

### A note on verifying Polygon transactions

Of four public RPCs tried, one returned the transaction, one returned "not
found", and two rejected the request for credentials. A single synced node
returning it proves existence; absence from a lagging or pruning node proves
nothing. `drpc.org` answered; `publicnode` and `1rpc` did not.

### Retirement is asynchronous

`POST /orders` returns as soon as the order is **accepted**, with
`transaction_hash` and `view_retirement_url` still empty. The on-chain
retirement lands a second or two later — accepted at 18:10:56, completed at
18:10:57 on the run above.

Code must poll until the transaction hash appears. Returning the POST response
directly yields a receipt with no proof in it, which is exactly the
unverifiable claim this project refuses to publish.

### There is no usable order id

`GET /orders/{id}` takes a **numeric** id, and no order response ever contains
one. The endpoint therefore cannot be called for an order this code created.
Orders are matched instead on the `quote.uuid` they consumed, or on the
retirement transaction hash.

### The production key format, from the spec's own examples

`openapi.json` documents authorisation examples of the form
`Bearer cm_api_d286bc5a-9980-43b7-9507-7fc013fecca8` — `cm_api_` followed by a
UUID, with **no environment marker**. The sandbox key in use is
`cm_api_sandbox…`, so the two are distinguishable, but only by the absence of
`sandbox` rather than by a positive production prefix.

The pairing guard therefore keeps `livePrefix: null` until a real production key
exists to read the format from. An example in documentation is not evidence
about a key that has never been seen, and guessing here would defeat the guard.

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
