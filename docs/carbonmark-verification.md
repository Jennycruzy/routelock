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

## The sandbox key performs real, on-chain retirements

**Settled 14 August 2026.** The build spec worried that a sandbox key would
return a synthetic certificate, and that presenting one as real would be
disqualifying. The opposite is true, and it was established by retiring 0.01 t
and then verifying the result **independently of Carbonmark**.

| | |
|---|---|
| Credit | `VCS-817` (Verra), vintage 2016, `C3T-VCS-817-2016` |
| Quantity | 0.01 t |
| Cost | **$0.10**, on the monthly invoice |
| Polygon transaction | `0xa36425668718644597fbae4e525426937e5179dd7ed7d8ee7619fc3c129594a9` |
| Block | 55,853,988, status **SUCCESS**, 34 logs |
| Certificate | `app.carbonmark.com/retirements/id/137-0xab5b7b5849784279280188b556af3c179f31dc5b-50` |
| Beneficiary | `RouteLock`, retirement index 50 |

The transaction was confirmed by calling `eth_getTransactionReceipt` on a public
Polygon RPC with no credentials, and the certificate page returns `200` with no
authentication. Neither check goes through Carbonmark, which is the point: the
proof does not depend on trusting the party that issued it.

**Consequence: the X Layer demo does not depend on production access.** A real
retirement with a real public certificate is already achievable with the key in
hand. Production access remains worth pursuing, but it is no longer the gate it
was assumed to be.

**Not all public RPCs will confirm it.** Of four tried, one returned the
transaction, one returned "not found", and two rejected the request for
credentials. A single synced node returning the transaction is proof it exists;
absence from a lagging or pruning node is not evidence against it. `drpc.org`
answered; `publicnode` and `1rpc` did not.

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
