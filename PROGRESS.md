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

### DEPLOYED — X Layer testnet, 13 August 2026

**Live at chain 1952, block 38195716.** First of the two required deployments;
X Layer's eligibility gate is testnet **before** mainnet, and the broadcast
record under `packages/contracts/broadcast/Deploy.s.sol/1952/` is the timestamp
evidence, so it is tracked in git rather than ignored.

| Contract | Address |
|---|---|
| `ServiceEntitlement` | `0x8A9A92a5Cd3c1eF2D2F0b5cD67E33e73949C992b` |
| `SettlementEscrow` | `0x58eba10730Fd1ee4E5b24AaAa7caE154cbC69C83` |
| `EntitlementFactory` | `0x366544F805e10e7320779d138Cca57FA0E4c5cdf` |
| `ActivationRegistry` | `0x38D8a1e9bC45378E4019320ECa4fc5431BeF40Bb` |
| `FulfilmentReceipt` | `0x83Ee9a4d2A3f0851DDD022A114663524694571C4` |

14 transactions, 7,178,201 gas, **0.0001436 OKB** at 0.02 gwei — well under the
0.000376 estimate, which assumed 0.04. Deployer balance after: 0.39978 OKB.
Explorer: `https://www.oklink.com/xlayer-test`.

Verified **from the chain, not from the script's own output**:

- Bytecode present at all five addresses (4,615–7,222 bytes); `name()`/`symbol()`
  answer as `RouteLock Entitlement`/`RLE` and `RouteLock Fulfilment Receipt`/`RLFR`.
- Cross-references resolve: `entitlement.classes()`, `factory.entitlement()`,
  `factory.escrow()`, `registry.entitlement()` all point where they should.
- Full role graph reads `true` for the nine intended grants.
- The negative half reads `false` for all five: compliance holds no role on the
  escrow, and no registry role on the entitlement.
- **The live guarantee holds.** Simulating `escrow.grantRole(COMPLIANCE_ROLE,
  compliance)` *as the admin* reverts with `0xa3dd6e91`, which is exactly
  `ComplianceRoleForbiddenHere()`. A control granting `ORACLE_ROLE` on the same
  contract from the same caller succeeds — so the revert is specific to the
  compliance role, not a malformed call. The AI cannot be given power over money
  on this deployment by anyone, including its own admin.
- Settlement token reads `USD₮0`, 6 decimals, at
  `0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c`.

### Blocked on a human

Full list with detail in `HANDOFF.md` §4. In short: GitHub push credential is
**dead (HTTP 401)** and the repo will be supplied by the owner, no Shipbubble
account or keys yet, X account not created, BOT Chain forms not filed, no funded
deployer wallets.

*Superseded — see day 2. The push credential and the testnet wallets are
resolved.*

---

## Day 2 — 14 August 2026

### Resolved since day 1

- **The repo is pushed and public** at `github.com/Jennycruzy/routelock`. The
  HTTP 401 blocker is gone. `main` and `origin/main` are level, the working tree
  is clean, every commit is authored `Jennycruzy`, and a grep of the last 20
  messages for AI-attribution strings returns nothing.
- **BOT Chain testnet is funded** — 10 tBOT from one faucet claim, against a
  ~0.21 tBOT deploy. Day 1's "both BOT Chain networks 0" no longer holds, and
  the BOT Chain testnet deploy is unblocked.

Deployer balances, live 14 August:

| Target | Balance | Enough to deploy? |
|---|---|---|
| X Layer testnet | 0.3998 OKB | yes — already deployed |
| X Layer mainnet | 0.00045 OKB | no |
| BOT Chain testnet | 10 tBOT | yes, ~47× over |
| BOT Chain mainnet | 0 | no |

### Re-verified, not taken on trust

- All five X Layer testnet contracts still hold bytecode at their recorded
  addresses (4,615–14,447 bytes).
- `totalMinted()` and `totalReceipts()` both return **0**, which is what the
  README claims and invites a reader to check.
- The README's published `cast call` challenge reproduces exactly: granting
  `COMPLIANCE_ROLE` on the escrow *as its own admin* reverts `0xa3dd6e91`
  (`ComplianceRoleForbiddenHere()`), while `ORACLE_ROLE` from the same caller
  succeeds. The guarantee the pitch rests on holds on the live deployment.
- **159 tests passing, 0 failing.**

### README rewritten

The asset section opened by defining RouteLock as a Port Harcourt → Lagos
parcel, which framed a general primitive as one domestic lane and read as
provincial. The contracts were never that narrow: `ServiceSpec` has no origin,
destination, weight, carrier, or parcel field — a class is an opaque `classId`
plus commercial terms.

It now leads with the primitive, states that the contracts do not know what the
service is, and introduces delivery as a chosen first adapter with its reasoning
(the carrier genuinely serves the lane; the lane has a real classification
problem to measure the engine against; being domestic means the model's failures
are ours to measure rather than absorbed by a customs broker).

Two factual defects fixed while in there:

- The README gave the deployment block as 38195716 while the address file it
  links to says 38195693. Both are real — the receipts mined at the former, the
  latter was the head when the script began — so both are now stated, with the
  receipts named as authoritative.
- A drafted claim that the lane appears "in exactly one place" was **false**: it
  is in four test files as well as the one source comment. Corrected before
  commit. Worth noting as a pattern — a checkable claim in a README that invites
  checking has to actually be checked.

### Benchmark corpus built — two jurisdictions

`bench/` is now a workspace package, `@routelock/bench`. **354 rows, 185 HS-6
subheadings, 57 chapters**, from two independent customs authorities: 176 US CBP
CROSS rulings and 178 UK HMRC Advance Tariff Rulings. Each row is an authority's
binding determination with a citable reference, not an annotation written here.
33 tests, typecheck clean.

Two sources because the route is chosen by whoever is shipping — a single-country
corpus measures how well a model reproduces *that country's* reading of the
nomenclature rather than the nomenclature. **14 subheadings were reached
independently by both authorities**, which is the corpus's own evidence that the
HS-6 label travels.

Two traps in the UK source specifically:

- **ATaR accepts a `searchTerm` parameter and ignores it.** "laptop", "banana"
  and an empty string return byte-identical first pages. A term-based collector
  looks like it is sampling by commodity while silently gathering the same 25
  rulings — the first attempt yielded exactly 25 UK candidates across 52 terms.
  Paging is real, so the collector strides across the result set instead.
- **ATaR needs no cut but still needs the leak guard.** HMRC publishes the goods
  description as its own field, separate from `Justification`, which carries the
  reasoning and names the heading. Structure does the cutting; the guard still
  runs because a human-written description can name a heading anyway.

This was buildable because a corpus needs no inference; only scoring it does.
There are no accuracy numbers anywhere in the repo and there must not be until a
real model has run against it.

Three things worth not rediscovering:

- **The letters state their own answer twice** — the `TARIFF NO.:` header and
  the "applicable subheading" conclusion — so extraction is a cutting problem,
  and a bad cut produces a benchmark that reports near-perfect accuracy while
  measuring nothing. 149 of 472 usable rulings were dropped as contaminated.
  The filter is deliberately over-eager: rows are cheap, a corrupted measurement
  is not.
- **`\bHTSUS\b` does not match `HTSUSA`**, because the trailing `A` defeats the
  word boundary. One row reached the first corpus carrying "Chapter 95 of the
  HTSUSA", disclosing its own answer's first two digits. Found by auditing the
  output independently rather than trusting the extractor — worth repeating on
  any future corpus change.
- **HTS chapters 98 and 99 are US-only** and carry no international HS meaning,
  so rulings landing there are excluded rather than truncated to a code that
  looks valid.

The honest limitation to keep stating: the ground truth is US practice. HS-6 is
shared by WCO members, but where national interpretation diverges these rulings
reflect CBP, not Nigeria Customs.

### Engine scored — and the measurement changed the design

Two configurations over the same corpus. On the 253 rows both covered:

| | From memory | Grounded |
|---|---|---|
| Top-1 accuracy | 36.8% | **47.4%** |
| Accuracy when approved | 79% | **89%** |
| Approvals issued | 14 | 19 |

Grounding fixed 40 rows and broke 13 — a net gain of 27, recorded that way
because the regressions are real.

**Calibration is the finding.** From memory the engine ran fifteen to
twenty-five points overconfident at every confidence level. Grounded, at 0.9–1.0
it states 92.0% and delivers 92.6%. So the cross-border threshold stays at 0.9 —
an earlier reading of the ungrounded curve said raise it, and that conclusion did
not survive the new data.

Worth not rediscovering:

- **Word-matching is the wrong way to shortlist candidate codes — do not rebuild
  it.** The plan was to hand the engine a shortlist of candidate subheadings to
  choose from instead of recalling one from memory, built by matching words in
  the goods description against words in the official tariff text. Measured, the
  correct code was in that shortlist only **22.3%** of the time, against the
  engine's own **36.8%** unaided — it would have made things worse. Tariff
  wording is legalistic and shares little vocabulary with how a shipper writes
  ("angled flange plated base" versus "lamps and lighting fittings, parts
  thereof").

  The reusable lesson is *how* that was caught: **checking a shortlist needs no
  model calls**, so it took a minute and cost nothing, before anything was built
  on top of it. Measure the shortlist before building what consumes it.
- **The first pass names the right chapter 80.6% of the time** but the right
  subheading only 36.8% — it knows roughly *where* goods belong and loses
  accuracy narrowing down. That gap is both why grounding works and its ceiling.
- **Both scoring runs died the same way: the Anthropic account ran out of
  credit** — 23 rows of finished work lost the first time, none the second.
  Three changes made between them, each worth keeping:

  1. **Save every row the moment it finishes.** The first run wrote results only
     at the end, so dying meant losing everything it had already paid for.
  2. **Never retry a `400`.** "Your credit balance is too low" comes back as a
     `400`; retrying it cannot succeed and just burns the rest of the run.
     Genuinely temporary errors — 429, 529, any 5xx — do retry with backoff.
  3. **One results file per configuration.** Both runs first wrote to the same
     filename, so the grounded run overwrote the ungrounded results and
     destroyed the "before" half of the comparison. It was recovered from git
     history, and the files are now `-grounded.json` and `-ungrounded.json`.

### Next — resume here

1. **Deploy to BOT Chain testnet.** `./scripts/deploy.sh botchain_testnet
   --broadcast`. Funded and ready; needs a human at the terminal only because
   the keystore password prompt is interactive. Afterwards re-run the
   `COMPLIANCE_ROLE` revert check against the new deployment — it is the one
   assertion worth repeating on every chain.

2. **Compliance engine** (`packages/compliance`) — blocked on an inference
   credential. There is no LLM API key on this box and none in the repo. The
   package is empty; nothing has been stubbed, because a compliance engine that
   cannot perform real inference is exactly the kind of simulated feature §1.2
   forbids. With the chain work done this is the largest piece of unbuilt scope.

3. `CarrierAdapter` interface + `ShipbubbleAdapter` against the **free**
   endpoints only — address validation and rate quotes, PHC→LOS. Blocked on a
   sandbox key.

4. Locate and document the Shipbubble cancellation endpoint and its refund
   behaviour **before** any live purchase.

5. **Finish the last 101 benchmark rows.** Blocked only on inference credit —
   `pnpm --filter @routelock/bench score` resumes from the checkpoint and pays
   for nothing already scored. Then refresh the figures in `bench/README.md` and
   the root `README.md`, which currently state the 253-row numbers explicitly.

Empty and untouched: `packages/{compliance,carrier,attest}`, `apps/{web,api}`.
Nothing in them is stubbed or scaffolded with placeholder behaviour.

---

## Build spec v2 — 14 August 2026

**The Next list above is superseded**, including its claim that the compliance
package is empty — it was written before that package existed and both the
engine and the carrier adapter shipped later the same day.

### The change

Delivery moved from first adapter to **third**, and to a reference
implementation that is deliberately not deployed. The binding constraint is
remote verifiability: a judge in another timezone cannot verify a parcel moving
in Nigeria. Carbon retirement leads on X Layer and compute leasing follows on
BOT Chain, both of which produce a public proof URL a stranger can check in
under two minutes.

The contracts do not change, and that is the point. Swapping the adapter proves
the claim the README already makes — that the five deployed contracts carry no
vertical — rather than asserting it.

### Completed

- **`docs/adapters.md`** — the authoritative status table, with a defined bar
  for "Active": deployed *and* one real fulfilment with a public proof URL.
  Carbon is recorded as **in development**, not active, because no retirement
  has happened yet.

- **`docs/adapter-mapping.md`** — how the registry's five hashes map onto each
  vertical, and why the delivery-era field names are kept rather than renamed.
  Renaming would force a redeploy and destroy the evidence that the contracts
  predate the vertical now running on them.

- **Vertical leakage measured, not asserted.** Grepping the contract sources for
  delivery vocabulary returns hits in `ActivationRegistry` only;
  `ServiceEntitlement`, `EntitlementFactory`, `SettlementEscrow` and
  `FulfilmentReceipt` have none. Every hit is a *name* — field, event, function
  or comment. None is a type the contract interprets, a parameter it parses, or
  a branch in its logic; the values are opaque `bytes32` written and read
  without inspection.

- **`packages/fulfilment`** — the shared `FulfilmentAdapter` port. A
  zero-dependency leaf on purpose: `@routelock/compliance` already depends on
  `@routelock/carrier`, so a port importing compliance would close a cycle.

- **The approval gate is structural.** `fulfil()` takes `Approved<TOrder>`,
  obtainable only from `approve()` in the compliance package, which returns
  `null` for every verdict other than `Approved` — `NeedsInformation` included,
  since that is a request for facts and never a soft yes. Confirmed by probe:
  `tsc` rejects both a bare order and a hand-forged object carrying every
  visible field.

- **Delivery presented through the port.** The two layers are now named for what
  they are: `ShipbubbleClient` speaks Shipbubble's API, `ShipbubbleAdapter` is
  the single adapter above it. No test logic changed — the rename was
  mechanical and the suite stayed green throughout.

- **Suite:** 133 TypeScript tests passing across five packages, up from 118. The
  159 Solidity tests are untouched; no contract was modified.

### Deliberately parked

The HS benchmark stays at 253 of 354 rows. Delivery no longer ships, so HS
accuracy gates nothing, and the inference credit belongs to the carbon quality
benchmark instead. Both READMEs already disclose the 253-row basis explicitly,
so nothing overstates what was measured. The checkpoint is kept — deleting it
would make the already-paid rows cost money again.

### Blocked on a human

1. **Carbonmark production access form**, with the third-party platform question
   in the same submission. Needs a business email on a domain. This is the only
   thing standing between the build and a real retirement certificate.
2. **Carbonmark sandbox key** — instant, and enough to build the adapter against.
3. **Dedicated X account** posting daily, submission post mentioning
   **@XLayerOfficial**. A hard eligibility gate that disqualifies regardless of
   build quality, and days have already passed without a post.
4. **BOT Chain gas support form** and project submission form.
5. **Inference credit**, for the carbon benchmark rather than the HS remainder.

---

## Carbon adapter — 14 August 2026

### Completed

- **`packages/carbon`** implements the shared port: `CarbonmarkClient` speaks the
  API, `CarbonmarkAdapter` is the single adapter above it. Same two-layer naming
  as delivery.

- **Carbonmark verified live**, not read off documentation
  (`docs/carbonmark-verification.md`). An OpenAPI 3.1 spec at
  `api.carbonmark.com/openapi.json` supplied the ordering contract, so `/quotes`
  and `/orders` are built from the published schema rather than guesswork.

- **The pairing guard now covers Carbonmark.** `assertProviderPairing` is
  generic over a `ProviderKeyScheme`; `assertEnvironmentPairing` delegates to it
  and its wording is unchanged, so no existing test moved.

- **Suite: 145 tests**, up from 118 at the start of the day. Contracts untouched.

### The retirement that wasn't

A real order was submitted, at 0.01 t, deliberately and with permission. It
returned `status: COMPLETED`, a real Polygon transaction hash, a real
certificate URL, and an on-chain receipt reading SUCCESS with 34 logs.

**It retired nothing.** The transaction is Carbonmark's shared test-mode
placeholder: a genuine retirement from **April 2024**, beneficiary "Developer
Tester", 0.123 t, that every test-mode order links to. Their own record on that
page says not to deliver it to customers because the environmental benefit was
already claimed.

Nothing was charged. Spec §4.3 was right and the earlier reading here — that the
danger was a real, billable retirement rather than a synthetic one — was wrong.

**The tell was the block number.** The chain head was ~92,017,000 while the
transaction sat in block 55,853,988; a transaction created minutes ago cannot be
36 million blocks old. Every other signal looked like success. *Check that a
transaction's block is recent, not merely that the transaction exists.*

The code enforces the general form rather than a match on that one page:
`fulfil()` throws when the beneficiary returned is not the one requested,
because a receipt that does not describe the request is not evidence for the
request. A `Receipt` is what gets hashed into `carrierRefHash` and published, so
committing a placeholder would be fabricated evidence.

### Three API traps now in code and docs

1. **`/prices` is public** — 200 with no key and with an invalid key. It can
   never confirm a credential. `/orders` is the check; it 401s on a bad key.
2. **Retirement is asynchronous.** `POST /orders` returns before the transaction
   hash exists. The client polls and throws rather than returning a receipt with
   no proof in it.
3. **`GET /orders/{id}` is unusable** — it takes a numeric id that no order
   response contains. Orders are matched on quote uuid or transaction hash.

### Blocked

**Carbonmark production access is now the critical path to the X Layer demo.**
Everything upstream of the retirement is done and exercised against real data.

---

## End-to-end rehearsal — 16 August 2026

`packages/attest` exists and `scripts/e2e.ts` runs the whole system in one pass:
register issuer → create class → post collateral → mint → assess → rule →
commit the decision on X Layer → retire a real credit → record the receipt.
Dry run by default; `--broadcast` sends, and the retirement carries a second
independent gate on top of that.

**Steps 1–4 are proven on the real chain.** Steps 5–9 have not completed end to
end yet. Step 8 — the EIP-3009 signature and the irreversible burn — has never
executed.

### Two bugs found by running it for real

**A write was read back before it settled.** `submitParcel` returned as soon as
the transaction was broadcast, so `recordDecision` read the state on the next
line and saw the pre-transaction value. The token was moving to `PendingReview`;
the read simply got there first. `send()` now waits for two confirmations, and
state preconditions retry for a few seconds before refusing. A genuinely wrong
state still fails, just later and correctly.

**`classId` was declared inside a block and read outside it.** A resume flag was
added by wrapping steps 1–4 in `if (resumeToken === undefined) { … }` without
checking which `const` declarations were read further down. `classId` is built
in step 2 and used in step 5, so the run died with `classId is not defined` —
on *every* path, not an edge case, and only after four real transactions had
been broadcast and 3 USD₮0 spent.

**The reason nothing caught it is the part worth keeping.**
`packages/attest/tsconfig.json` had `"include": ["src/**/*.ts"]`. `scripts/` was
never typechecked, so `tsc` never looked at the one file in the package that
spends money, and a clean `pnpm -r typecheck` meant nothing about it. Every
other package with a `scripts/` directory already included it; attest was the
only exception. Now aligned — and the fix immediately surfaced a real
`encodeFunctionData` call whose `abi: … as never` had collapsed the whole
argument to `never`.

*Generalisation: a "0 errors" result is only as wide as the `include` globs. When
a check passes on code that obviously has a defect, suspect the check's scope
before suspecting the defect.*

### Funding is cooldown-bound, and the run is now cheap enough not to care

A faucet claim appeared to succeed and never landed. Full diagnosis in
`docs/chain-verification.md` — the short version is that the address had claimed
5h36m earlier, the faucet was demonstrably alive for other addresses, and the
balance arithmetic closed exactly against a single dispensation, so no second
claim had occurred. The cooldown window is enforced off-chain and its length is
unverified.

`e2e.ts` therefore takes `ROUTELOCK_PRICE`, `ROUTELOCK_COLLATERAL` and
`ROUTELOCK_PAYOUT`, defaulting to the previous 1/2/1. A 10× scaled run costs
0.3 USD₮0 rather than 3 and exercises an identical path, because the escrow only
requires collateral to cover the obligation after the mint. The script now
prints the run cost at step 0 and refuses at startup if collateral cannot cover
the obligation, rather than discovering it at the mint.

### Known limitations, not yet addressed

- **A dry run cannot get past step 2 on a fresh label.** `createClass` is
  simulated but never sent, so step 3 posts collateral to a class that does not
  exist and reverts with `UnknownClass`. Inherent to simulating a stateful
  sequence; worth knowing before treating a dry-run failure as a real defect.
- **`ESCROW_ABI` in `e2e.ts` omits the contract's custom errors**, so that revert
  prints as an undecodable `0x693b1355` rather than by name. Cheap to fix and it
  would have saved a lookup.
- **Token 3 is stranded.** It was minted before the `classId` failure and never
  reached `submitParcel`, so `ROUTELOCK_RESUME_TOKEN` cannot recover it — the
  resume path reads the on-chain parcel hash and refuses on a zero. Its 3 USD₮0
  sits in escrow.

---

## Day 5 — 17 August 2026

### A real credit was retired. Carbon is Active.

The full nine-step run completed for the first time, scaled to the balance
(0.1 / 0.2 / 0.1 USD₮0). **Step 8 had never executed before today.**

| | |
|---|---|
| Entitlement | **4** on X Layer testnet — `Activated`, verdict `APPROVED`, all five commitments recorded |
| Credit | UCR-437-2023, Solar PV – Small Scale, India |
| Amount / charged | 0.001 t / **0.027725 USDC** on Base, against 0.028125 authorised |
| Payment tx | `0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2`, block 50,083,814, mined 08:56:15 UTC |
| Certificate | `app.carbonmark.com/retirements/id/8453-0x8717eb0f…-0` |

**Verified rather than assumed, using exactly the checks that caught the fake one
on 14 August:**

- **Block distance.** 50,083,814 against a head of 50,084,280 — 466 blocks, about
  fifteen minutes. The placeholder that fooled the earlier run sat 36 million
  blocks in the past. *The block being recent is the check; the transaction
  existing is not.*
- **The logs name this project.** Decoding the transaction's 22 logs yields
  `RouteLock entitlement holder`, `RouteLock entitlement 4` and `UCR-437-2023` —
  not the shared `Developer Tester` beneficiary.
- **The provider still confirms it.** `adapter.verify()` returns
  `state: "retired"`, `found: true`, `live: true`.
- **The money left.** Issuer's Base USDC 2.990000 → 2.962275.

Status updated in `docs/adapters.md`, `README.md` and the adapter's own source
header, which all previously said no retirement had been performed.

### Frontend built — `apps/web` + `apps/api`

Both directories were empty at the start of the day. The API is `node:http` and
viem, no framework; the page is one HTML file, one stylesheet and one script,
with no build step.

Endpoints, all serving live values: `/api/state` (addresses, bytecode lengths,
totals, the 17-check role graph), `/api/guarantee` (the `COMPLIANCE_ROLE` refusal
probed live, with a control call), `/api/fulfilment` (the retirement, re-verified
per request), `/api/carbon/inventory`, `/api/rule/hs`, `/api/rule/carbon`,
`/api/replay/:tokenId`, `/api/budget`.

Three decisions worth not re-litigating:

- **The API holds no key and signs nothing**, and that is asserted structurally:
  `no-signing.test.ts` reads the package's own source and fails if
  `createWalletClient`, `privateKeyToAccount`, `writeContract`,
  `COMPLIANCE_PRIVATE_KEY` or nine other symbols appear in code. A grep, not a
  runtime check, because a runtime check can only fail once the dangerous code
  exists and runs.
- **A refusal returns 200.** `NEEDS_INFORMATION` and `REFUSED` are outcomes, so
  the only 4xx are a malformed request and — as `402` — an exhausted budget. The
  three verdict cards on the page are deliberately identical in size and weight;
  only the accent colour differs.
- **The served endpoints spend from their own ledger**, `data/served-inference.jsonl`,
  capped separately from the operator's 25. A visitor cannot drain the budget the
  e2e run needs, and the e2e run cannot be starved by a visitor.

### The HS path was spending without a cap

Found while wiring the ruling endpoint: `InferenceBudget` guarded the carbon path
only. `ComplianceEngine.classify` made one or two model calls with nothing
counting them — fine while its only caller was a supervised benchmark, not fine
behind an HTTP endpoint on an account that has run out of credit twice.

`propose` and `ground` now report the token counts **the API itself returns**, and
the engine records them. Three details that are the substance of it:

- **Usage is reported before the response is parsed.** A 200 whose content is
  unusable has still been charged; recording only successful parses would let a
  run pay repeatedly while the ledger insisted nothing had happened.
- **The grounding pass records even when its answer is discarded.** It throws away
  codes the model invented rather than chose, and those calls cost money anyway.
- **A grounded ruling refuses unless it can afford *both* passes.** Checking for
  one call would let a ruling spend, then fail to ground, and record a decision
  whose `engineVersion` still says `+grounded`. A decision hash that misdescribes
  what produced it is worse than a refusal.

`InferenceBudgetExceeded` now carries `callsNeeded`, so "exhausted" and "cannot
afford the whole ruling" read differently. The benchmark stays deliberately
unbudgeted: a 25-call cap in front of a job whose purpose is hundreds of calls
would only teach the operator to raise caps.

**Known inaccuracy, not introduced today and not yet fixed:** when `ground()`
returns `null` because a non-200 came back or no candidate chapters were named,
the decision still records `ENGINE_VERSION` = `…+grounded`. The benchmark works
around it by recording a separate `grounding` boolean. Fixing it properly changes
decision hashes, so it is not a mid-submission change.

### `.env` loading moved to `@routelock/chain`

Two entry points now need it — the e2e script and the API — so
`packages/attest/scripts/env.ts` is a re-export and there is one parser rather
than two that can drift.

### Suite

**334 TypeScript tests across eight packages, 0 failing** (compliance 125, attest
57, carbon 45, bench 44, carrier 31, chain 28, api 2, fulfilment 2). **159
Solidity tests, 0 failing.** No contract was modified.

*A first count here said 290 across seven — it silently omitted `bench`, whose 44
tests do not live under `packages/`. Worth the note because a test count is the
kind of number a README states and nobody rechecks.*

### Also confirmed today

- **X Layer mainnet gas is affordable now**, and `HANDOFF.md` §4.6 was wrong to
  list it as blocking. Gas is 0.02 gwei (20,000,001 wei) and the testnet deploy
  cost 7,178,201 gas ≈ 0.000144 OKB against a balance of 0.000450 — roughly 3×
  headroom. What is genuinely missing on mainnet: **0 USDT** (so no real
  issuance) and **0 OKB on the compliance key** (so no `recordDecision`).
- **A stale `anvil` fork was still running from the previous session**, forked at
  a 12-hour-old block. A rehearsal against it would have read state that no
  longer matched the chain. Killed and re-forked at the current head before use —
  *check the fork's block height, not merely that a fork is answering.*
- The forked-chain rehearsal now passes steps 1–7 in one pass, which the previous
  session's notes recorded as unproven.

### Carbon benchmark — designed, not built, no inference spent

Full design in [`docs/carbon-benchmark-design.md`](docs/carbon-benchmark-design.md).
Paused here deliberately, with every data source verified live and the corpus not
yet started.

**The brief changes on one point:** v2 asked for the confidence threshold to be
*derived* from a calibration curve. It cannot be. That threshold gates "is the
credit what it claims to be and free of integrity defects", and listed inventory
has essentially no negative examples of that question — a curve over it would
report near-perfect calibration while measuring nothing. **0.7 stays picked, and
stays labelled picked**, which is what `decide.ts` already says at length. Deriving
a number from a curve measuring the wrong question would repeat the exact error the
code caught once already, when the calibrated HS 0.9 was transplanted onto carbon
and refused every class in inventory.

**Checked first, because everything else depended on it:** `buildCarbonPrompt`
leaks nothing — no named methodologies, no quality hints — so scoring the model on
methodology quality is not circular.

**Ground truth, verified reachable:** ICVCM's CCP assessment status — a published,
dated, methodology-level determination by an independent body, with a decision PDF
per row. It scores `methodologyStrength` and `adverseFindings`, which are
**disclosure and do not gate**; §3 of the design argues why that is still worth
measuring, including that it answers whether they *should* gate.

**⛔ Two traps found while verifying, both recorded:**

- **`/carbonProjects` default ordering is unrepresentative.** First 200 rows are
  150 JCS / 44 PUR / 6 VCS, while what is purchasable is ~80% VCS. `JCS` is not in
  `RECOGNISED_REGISTRIES`, so those rows refuse deterministically *before the model
  is asked* — a corpus built from the first N would measure nothing. Same shape as
  the ATaR `searchTerm` trap.
- **"Does Not Meet CCP" is not "withdrawn".** A methodology can fail an ICVCM
  assessment and stay active at its registry. Only registry withdrawal may score
  the `withdrawn_methodology` integrity flag; conflating them would mark the engine
  wrong for being right.

### Carbon benchmark — steps 1 and 2 executed, and step 2 stopped an arm

Ground truth built and committed, still no inference spent. Both rebuildable:
`pnpm --filter @routelock/bench build:icvcm` and `… count:join`, writing
`bench/data/icvcm-decisions.json` and `bench/data/icvcm-join-count.json`.

**Step 1 — the ICVCM decision table.** 181 methodology rows parsed off
`icvcm.org/assessment-status`, which dates itself 4th August 2026: 47
CCP-Approved, 22 Does not meet, 14 Withdrawn, 11 Very Unlikely To Meet, 2
Remedial Action, and **85 still under assessment**. Only **71 of the 96
decisions publish a document** — `Very Unlikely To Meet` and `Withdrawn` are
stated with nothing behind them, so those rows cannot clear the corpus standard.
The page publishes **no per-row decision date**, only one date for the table, and
the file says so in a field rather than letting a PDF's upload path be mistaken
for one.

**Step 2 — the join, counted, which is what step 2 is for.** Benchmark-eligible
inventory is *purchasable in `/prices`, on a registry in
`RECOGNISED_REGISTRIES`* — both narrowings come from `deterministicGround`
refusing before the model is asked, not from the marketplace. That is **52
projects**, 55 project/methodology pairs, **40 joined** to an ICVCM decision, 38
with a document.

**⛔ The number that stops §3.2: exactly one of those 40 rows is CCP-Approved.**
Measuring false integrity flags on sound credits needs sound credits, and
purchasable inventory has one. A false-positive rate over n=1 is not a rate.
§3.1 and §3.3 survive but shrink honestly: the 40 rows sit on **five distinct
determinations**, and `ACM0002` alone is 27 of them — reporting "accuracy over 40
rows" would report three negative determinations thirty-seven times and call the
repetition sample size.

**Relaxing purchasability does not rescue it, and the counterfactual is in the
report rather than assumed:** over the whole 268-project recognised-registry
catalogue the join gives 157 rows but still **9 determinations** and still **3**
CCP-Approved projects — and those rows are refused on liquidity before the model
sees them anyway. **The binding constraint is inventory composition, not ground
truth**: ICVCM has ruled on 96 methodologies, while what is tokenised for sale is
overwhelmingly grid-connected renewable electricity, which ICVCM rejected in
August 2024.

**Two traps the live page confirmed, both now enforced in code:**

- **`Withdrawn` means withdrawn from the ICVCM assessment**, by the submitting
  programme — not registry withdrawal, and never evidence for the engine's
  `withdrawn_methodology` flag. It carries no document either.
- **Decisions are version-scoped and three of them disagree across versions.**
  VM0042, VM0044 and VM0051 are each `Withdrawn` at their earlier version and
  `CCP-Approved` at their later one, while Carbonmark's metadata never names the
  version a project was issued under. The join excludes those three and counts
  them as excluded rather than picking a side.

Also worth keeping: identifiers are read **only from the start of the ICVCM
cell**. `VMR0017 - … (ACM0002 revision)` is CCP-Approved while `ACM0002` is Does
not meet, so a substring match would have credited the engine for the wrong
answer on 27 projects.
