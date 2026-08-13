# PROGRESS

Running state of the build. Updated at the end of every session. This file
reflects reality — including what is broken and what is untouched.

---

## Day 1 — 13 August 2026

### Completed

- **Monorepo scaffolded** at `/root/routelock`. pnpm workspaces, `apps/{web,api}`,
  `packages/{contracts,compliance,carrier,chain,attest}`, `bench/`, `deployments/`,
  `docs/`. Git initialised on `main` with the `Jennycruzy` identity set before the
  first commit.

- **All four chain targets verified live over RPC**, not read off a docs page:

  | Target | Chain ID | Head block at verification | Settlement |
  |---|---|---|---|
  | X Layer testnet | 1952 | 38,167,907 | unresolved |
  | X Layer mainnet | 196 | 67,857,709 | USDT, 6 dp |
  | BOT Chain testnet | 968 | 19,721,998 | USDT, 6 dp |
  | BOT Chain mainnet | 677 | 19,524,042 | USDT, 6 dp |

- **Spec §7.2 resolved — BOT Chain has USDT.** Confirmed by calling `symbol()` and
  `decimals()` on the token contracts on both BOT networks (`USDT`, 6 decimals,
  identical 12,378-byte bytecode). Consequence: **the `NativeSettlement` variant
  is not required.** Settlement is still modelled as a discriminated union so
  that switching to native BOT stays a config change rather than a rewrite.

- **BOT Chain faucet located:** `https://faucet.botchain.ai/basic`, 10 tBOT per
  address per 24 hours. Testnet explorer `https://scan.bohr.life`.

- **Environment pairing guard implemented** (`packages/chain/src/chains.ts`) —
  spec §1.2.5. Throws at process start on any testnet/live-key mismatch, on an
  absent key, and on an unrecognised key prefix.

- **`pnpm verify:chains`** re-verifies every configured value against the live
  networks. Intended to run before every deploy and in CI.

- **13 tests passing** in `@routelock/chain`, covering every branch of the pairing
  guard including all four refusal paths.

### Known non-passing check (intended)

`pnpm verify:chains` exits 1 on X Layer testnet settlement: `UNRESOLVED`. No
stablecoin has been confirmed on that network. `requireSettlementToken()` throws
rather than returning a placeholder. This stays failing until a real token is
chosen — a guessed address would be worse than a red check.

### Blocked on a human

Full list with detail in `HANDOFF.md` §4. In short: GitHub push credential is
**dead (HTTP 401)**, no Shipbubble account or keys yet, X account not created,
BOT Chain forms not filed, X Layer testnet token undecided, no funded deployer
wallets.

### Next

1. Contracts skeleton: `ServiceEntitlement` written generic from the start, not
   `DeliveryEntitlementNFT` (spec §4.1).
2. `CarrierAdapter` interface + `ShipbubbleAdapter` against the **free** endpoints
   only — address validation and rate quotes, PHC→LOS. Blocked on a sandbox key.
3. Locate and document the Shipbubble cancellation endpoint and its refund
   behaviour **before** any live purchase.
4. Resolve the X Layer testnet settlement token ahead of the day-2 deploy.
