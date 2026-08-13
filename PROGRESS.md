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

- **BOT Chain faucet located:** `https://faucet.bohr.life/en/basic`, 10 tBOT per
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

### Contracts — written and compiling, partially tested

All five contracts from spec §4 exist and compile under Solidity 0.8.28 with
OpenZeppelin 5.6.1 (pulled through pnpm, so there are no git submodules to
clone).

| Contract | What it does |
|---|---|
| `RouteLockTypes.sol` | `EntitlementState`, `ServiceSpec`, `Roles`, `IEntitlementClasses` |
| `ServiceEntitlement.sol` | ERC-721, the lifecycle state machine, the transfer lock |
| `EntitlementFactory.sol` | issuer registry, classes, purchase, supply invariants |
| `SettlementEscrow.sol` | collateral, buyer deposits, release, refund, claim |
| `ActivationRegistry.sol` | parcel/decision/carrier hashes, the `Verdict` record |
| `FulfilmentReceipt.sol` | soulbound proof of delivery, issuer-only, no counterparty |

Two design decisions worth not re-litigating:

- **`SettlementEscrow._grantRole` reverts on `COMPLIANCE_ROLE`.** The compliance
  service is not merely ungranted authority over funds — the role cannot be
  granted in that contract at all, by any admin, ever. This is the structural
  form of "the AI never moves money", and it is asserted by
  `test_escrowRefusesToGrantComplianceRole`.
- **`Verdict` is an enum, not a bool.** `Approved` / `NeedsInformation` /
  `Refused` are all committed on-chain with the same decision hash treatment, so
  the on-chain record is not a biased log of successes.

**159 tests passing, 0 failing.** Coverage as measured:

| File | % Branches | % Lines |
|---|---|---|
| `ServiceEntitlement.sol` | 100% | 100% |
| `EntitlementFactory.sol` | 100% | 100% |
| `SettlementEscrow.sol` | 100% | 100% |
| `ActivationRegistry.sol` | 100% | 100% |
| `FulfilmentReceipt.sol` | 100% | 100% |

The spec's target — 100% branch coverage on state transitions and access
control — **is met**. Every contract also reaches 100% on lines, statements and
functions.

Three things found while closing the gaps, worth not rediscovering:

- The escrow's uncovered branches were not the "zero-amount and already-settled
  edges" an earlier note guessed at. They were the guards the factory happens to
  validate *first*: duplicate class registration, zero issuer/token, and
  unknown-class withdrawal. They are tested by pranking as the factory address,
  because the contract holding the money must not depend on its caller having
  checked — a second factory could be wired to it later.
- `ActivationRegistry.publishTracking`'s `NoActivation` guard is unreachable
  through a single registry, since delivery implies submission. It is covered by
  wiring a *second* registry to the same entitlement, which is exactly the
  situation the guard exists for.
- A zero-price class is reachable: the factory does not require a non-zero
  price, and price and payout obligation are independent. A free entitlement
  still carries a real obligation and still cannot be minted uncollateralized.

### Deployment script — written, tested, simulated against two live chains

`script/Deploy.s.sol` performs the exact wiring in `test/RouteLockBase.t.sol`.
What it refuses to do is the substance of it:

- **Settlement token comes from the chain, not the environment.** The address is
  selected by `block.chainid` from the four verified values, so a typo in a shell
  variable cannot point a deployment at the wrong token. An unrecognised chain id
  reverts — including **195**, the stale X Layer testnet id that directories
  still publish.
- **The token is read before it is trusted**: no code at the address, or a
  `decimals()` other than 6, aborts the deploy. The codelength check is explicit
  because a high-level call to a codeless address reverts *without data*, which
  `try/catch` cannot turn into a named error.
- **The role graph is asserted after wiring**, including the negative half — that
  compliance holds nothing on the escrow and that the escrow still rejects
  `COMPLIANCE_ROLE` outright.
- **A dry run records nothing.** Simulation produces the same addresses a
  broadcast would, at contracts that do not exist; writing them would leave a
  file in `deployments/` indistinguishable from a real deployment. Only
  `--broadcast` writes `deployments/<chain>.json`.
- Admin handover is built: deploy with the deployer as admin (the wiring calls
  are admin-gated), then grant to `ROUTELOCK_ADMIN` and renounce, grants before
  renounces so a part-way failure leaves the contracts administrable.

Simulated clean against **X Layer testnet (1952)** and **BOT Chain testnet
(968)** on 2026-08-13 — both real settlement tokens answered `decimals() = 6`
over live RPC. Estimated deploy cost: ~10.48M gas (~0.00042 OKB at 0.04 gwei).
No broadcast has been made: there is no funded deployer key on this box.

### Deployer and role keys — set up 2026-08-13

| Role | Address | Where the key lives |
|---|---|---|
| Deployer + `ADMIN` + `ORACLE` | `0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6` | Foundry keystore, `routelock-deployer`, encrypted |
| `COMPLIANCE` | `0xA30D83117470c884fB3C35532d2a49Bc65B0922a` | `.env`, plaintext, `0600`, gitignored |

Balances checked live: **X Layer testnet 0.3999 OKB** (deploy costs 0.000376,
so ~1,000× headroom), X Layer mainnet 0.00045 OKB, **both BOT Chain networks 0**.
BOT Chain testnet gas is **20 gwei — 1,000× X Layer's 0.02** — so a deploy there
costs ~0.21 tBOT rather than a rounding error. One 10 tBOT faucet claim still
covers ~47 deploys.

Two things about this arrangement worth knowing:

- **`ADMIN` and `ORACLE` deliberately share one key, as a testnet shortcut.**
  Re-point before mainnet. The oracle signs unattended from this box, so a box
  compromise currently also reaches role administration. Note the deployer
  address is not a fresh key — it had 397 mainnet transactions before this
  project.
- **`COMPLIANCE` must never equal `ORACLE`,** and the deploy script enforces it.
  Setting all three roles to one address was tried first and correctly aborted
  with `WiringAssertionFailed("escrow.compliance.oracle")`: the oracle role on
  the escrow is what releases funds, so sharing it with compliance would hand
  the AI authority over money and void the guarantee the design rests on. The
  compliance key is therefore fresh, disposable, and used for nothing else —
  and `ADMIN` can revoke its role without a redeploy.

The compliance key is plaintext because the compliance cron runs unattended and
cannot answer a keystore password prompt. It needs no gas until it starts
calling `recordDecision`.

### Blocked on a human

Full list with detail in `HANDOFF.md` §4. In short: GitHub push credential is
**dead (HTTP 401)** and the repo will be supplied by the owner, no Shipbubble
account or keys yet, X account not created, BOT Chain forms not filed, no funded
deployer wallets.

### Next — resume here

The on-chain half is finished and tested. **Everything remaining is blocked on a
credential this box does not have** — see `HANDOFF.md` §4. Listed in the order
they unblock work:

1. **Deploy to X Layer testnet, then BOT Chain testnet** — the script is ready
   and simulated; it needs a funded deployer key. X Layer's eligibility gate
   requires testnet **before** mainnet with provable timestamps, so the broadcast
   records under `packages/contracts/broadcast/` are evidence and stay tracked in
   git (only `dry-run/` is ignored).

2. `CarrierAdapter` interface + `ShipbubbleAdapter` against the **free**
   endpoints only — address validation and rate quotes, PHC→LOS. Blocked on a
   sandbox key.

3. Locate and document the Shipbubble cancellation endpoint and its refund
   behaviour **before** any live purchase.

4. **Compliance engine** (`packages/compliance`) — blocked on an inference
   credential. There is no LLM API key on this box and none in the repo. The
   package is empty; nothing has been stubbed, because a compliance engine that
   cannot perform real inference is exactly the kind of simulated feature §1.2
   forbids.

5. **Benchmark** (`bench/`) — 200–300 real product descriptions with ground-truth
   HS codes, reporting top-1 accuracy, refusal precision, and a calibration
   curve. Depends on (4). This is the differentiator; the contingency order is to
   shrink it, never drop it.

Empty and untouched: `packages/{compliance,carrier,attest}`, `apps/{web,api}`,
`bench/`. Nothing in them is stubbed or scaffolded with placeholder behaviour.
