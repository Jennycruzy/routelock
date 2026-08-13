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
  | X Layer testnet | 1952 | 38,167,907 | USD₮0, 6 dp |
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

- **X Layer testnet settlement resolved: USD₮0** at
  `0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c`, 6 dp, non-zero supply, and
  **dispensed by the testnet faucet** so demo wallets can actually be funded.

  Worth recording how this was found, because the obvious approach fails: none of
  the mainnet token addresses carry over to testnet, and the addresses circulating
  in search results for "X Layer testnet USDT" belong to other chains. The
  authoritative source is the faucet contract at
  `0xf6d088123a3c17e6047ae9338b8cf072ad448907` — itself not a token but an
  EIP-1967 proxy, which is why every ERC-20 call on it reverts. Scanning its
  outbound `Transfer` logs gave the three real tokens it dispenses: USD₮0,
  USDC_TEST, and USDG. A token that exists but cannot be acquired — such as the
  zero-supply USDC on that chain — is useless for a demo, and an address listing
  alone will not tell you that.

- **All four targets settle in a 6-decimal USD stablecoin**, so `pricePerUnit`
  arithmetic is identical across every deployment. Asserted by a test.

- **16 tests passing** in `@routelock/chain`; `pnpm verify:chains` passes clean on
  all four networks.

### Blocked on a human

Full list with detail in `HANDOFF.md` §4. In short: GitHub push credential is
**dead (HTTP 401)** and the repo will be supplied by the owner, no Shipbubble
account or keys yet, X account not created, BOT Chain forms not filed, no funded
deployer wallets.

### Next

1. Contracts skeleton: `ServiceEntitlement` written generic from the start, not
   `DeliveryEntitlementNFT` (spec §4.1).
2. `CarrierAdapter` interface + `ShipbubbleAdapter` against the **free** endpoints
   only — address validation and rate quotes, PHC→LOS. Blocked on a sandbox key.
3. Locate and document the Shipbubble cancellation endpoint and its refund
   behaviour **before** any live purchase.
