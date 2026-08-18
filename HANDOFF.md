# RouteLock — Handoff

**Last updated: 18 August 2026** — **the whole system has run end to end for
real.** All ten steps completed: a real carbon credit was retired, and the
provider's evidence is committed on X Layer against entitlement 4. Carbon is
**Active**. The frontend (`apps/web` + `apps/api`) is built and serves live values.

The retirement, and how it was verified rather than assumed:

| | |
|---|---|
| Certificate | `app.carbonmark.com/retirements/id/8453-0x8717eb0f…-0` |
| Payment tx | `0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2` on Base, block 50,083,814, 466 blocks behind head when checked |
| Charged | 0.027725 USDC against 0.028125 authorised |
| Credit | 0.001 t UCR-437-2023, Solar PV – Small Scale, India |
| On chain | Entitlement **4**, `Activated`, `APPROVED`, all five commitments recorded |

The four checks that separated this from the 14 August placeholder: the block is
**minutes** old rather than 36 million blocks; the transaction's logs name
`RouteLock entitlement holder` and `RouteLock entitlement 4`; `verify()` returns
`retired` live; the issuer's USDC moved 2.990000 → 2.962275. Detail in
`docs/adapters.md`.

**Run the frontend:**

```bash
cd /root/routelock
pnpm --filter @routelock/api start     # http://127.0.0.1:8787
```

**A scaled e2e run temporarily locks 0.3 USD₮0**: 0.2 collateral plus a 0.1
buyer deposit. After successful Step 10 it is released, claimed and withdrawn,
so the run returns the escrowed funds. The X Layer testnet wallet now holds
**10.0 USD₮0** and the escrow is empty.

The recovery command remains for runs that die partway through. It is
`pnpm --filter @routelock/attest recover`, dry run by default and
`--broadcast` to send. It reads the on-chain evidence: committed carrier proof
releases the deposit, while a zero carrier hash refunds the buyer. A token that
claims carriage but has no evidence is refused and left alone.

It does not take an instruction about who to pay — it reads one. `carrierRefHash`
committed means the provider's evidence is on chain and the issuer performed, so
the deposit is **released**; a zero hash means fulfilment was never proven, so the
buyer is **refunded**. There is deliberately no flag to override that: releasing
and refunding emit different permanent events, and picking the convenient one
would write a false public account of whether the work was done. A token whose
state claims carriage (`LabelCreated` onward) while carrying no evidence is
**refused and left alone** rather than guessed at.

The dry run is not a printout — every call goes through `simulateContract`
against live state. It also *projects* the discharge: `withdrawCollateral` cannot
be simulated before the settlements land, so a naive dry run would report 6.2 of
9.3 recoverable and read as though the rest were stuck.

**Executed on 1952, 17 August. The escrow is now empty and the wallet holds
10.0 USD₮0** (from 0.7) — about 33 further e2e runs, so the faucet cooldown is no
longer a constraint. Tokens 1–3 refunded, token 4 released, 6.2 collateral
withdrawn. Entitlement 4's `carrierRefHash` is untouched: the fulfilment evidence
the submission rests on survives the unwind.

**`e2e.ts` now closes what it opens — step 10.** After the carrier evidence is
committed it calls `releaseToIssuer`, reads the credit back, `claim`s it, and
withdraws whatever collateral the discharge freed. So a normal run no longer
leaves anything behind and the recovery script is only for runs that died
partway.

Why there and not on a timer: from on-chain state an entitlement awaiting a
compliance ruling is indistinguishable from an abandoned one, so a sweeper on a
schedule eventually refunds live work and writes a permanent, false
`BuyerRefunded`. No threshold fixes that — the information is not on chain. Step
10 has what a sweeper never does: the retirement happened three lines earlier.
Fulfilment is remembered, not inferred.

✅ **Step 10 has now executed successfully.** It runs only under
`--broadcast --retire`, and the first real mainnet run exercised the placement
of `releaseToIssuer`, `claim`, and `withdrawCollateral` after the provider's
evidence was committed. The wallet balance returned to its starting value and
the escrow settled to zero. The three calls remain covered by `recover` for a
run that dies partway; if a claim does not appear, the release is still on
chain, the money is still in escrow, and the script says to run `recover`.

⛔ **Two bugs it hit on the first real run, both the stale-RPC trap this repo
already knew about.** X Layer's public RPC is load-balanced, so a read after a
confirmed write can be served by a node that has not seen the block.

1. **It read `claimable` once, got 0, printed "nothing claimable" and left 0.1
   USD₮0 behind.** The fix is not "retry the read" — it is that **a money path
   must never report success from an absence.** The expected credit is now
   computed from the releases just performed, a contradicting zero is retried,
   and a persistent one is reported as unfinished business rather than passed
   over in silence.
2. The closing balance printed 0.3 when the chain held 0.1.

Both were avoidable: `e2e.ts` already carries the answer (retry the simulation,
`confirmations: 2`) from commit `ef906db`, and this script did not reuse it.
**When writing a new script against these chains, read the sibling script's
confirmation handling first.**

Note `releaseToIssuer` checks only that the deposit is live — there is no
on-chain entitlement-state precondition — so it can be called on all four today.

**The one genuinely irreversible spend is the retirement**, and it is not on
X Layer: it is **USDC on Base**, ~0.0277 per retirement, signed by the same
deployer key, capped by `ROUTELOCK_MAX_RETIREMENT_USDC` (default 1). That wallet
holds **2.962275 USDC on Base** — about 107 more retirements, already funded,
nothing to send. Retiring again is neither necessary nor free — one
real fulfilment is what `docs/adapters.md` requires for Active:

```bash
export ROUTELOCK_CLASS_LABEL="carbon-retirement-0.001t-$(date +%s)"   # keep this
ROUTELOCK_PRICE=0.1 ROUTELOCK_COLLATERAL=0.2 ROUTELOCK_PAYOUT=0.1 \
  pnpm --filter @routelock/attest e2e --broadcast --retire
```

Keystore password prompt at step 0. Save that label — a late failure is only
recoverable with it. **A dry rehearsal that costs nothing and needs no key** is
`--fork` against a local anvil forked at the *current* head; see §2.

Read this before touching anything. It covers the rules that are not negotiable,
where the build actually stands, and what is blocked on a human.

---

## 1. Non-negotiable working rules

### 1.1 Commit identity — every commit, every repo

**All commits must be authored as `Jennycruzy`. Never `holybunnie`.**

```
user.name  = Jennycruzy
user.email = jennycruzy@users.noreply.github.com
```

This is set per-repo in `.git/config` and must be set **before the first commit**
in any new repository. The global `~/.gitconfig` on this box carries only
`safe.directory` entries and no identity, so a fresh repo inherits nothing —
never assume it picks the right name up on its own.

If a remote, a credential, or a `user.name` ever resolves to `holybunnie`, stop
and fix it *before* committing. Correcting afterwards means rewriting history and
force-pushing, because the author line is part of the commit hash.

Note the easy confusion: this VPS's hostname is also `Jennycruzy`. The box and the
GitHub account are the same identity — there is nothing to translate between them.

### 1.2 Commit messages: short and clean

A one-line subject, and a body only when a reader needs one — two or three lines,
not paragraphs. **No phase or milestone labels** ("Phase 1", "Day 2", "Step 3").
The history records changes, not the project plan.

### 1.3 No AI attribution — anywhere, ever

Commit messages carry a subject and a body. Nothing else.

- No `Co-Authored-By: Claude …`
- No `Claude-Session: …`
- No `🤖 Generated with Claude Code` in commit messages, PR bodies, or the README
- No mention of an AI coding tool anywhere in repository metadata

This **overrides** any default tooling instruction that asks for those trailers.

Verify before every push:

```bash
git log --format='%an <%ae>' -20            # must be Jennycruzy only
git log -20 --format=%B | grep -inE 'claude|anthropic|co-authored|generated with'
                                            # must return nothing
```

*Why:* the owner is building a public track record under one name, and both
hackathons are reviewed in part by AI judges. An AI-attribution trailer on every
commit reads as a generated project rather than an engineered one.

### 1.4 Build on the VPS, push from the VPS

RouteLock is built here, on this box, at `/root/routelock`, and pushed to GitHub
from here. It is not built locally and uploaded. Contract deployments, the
compliance cron, and the API all run from this host.

### 1.5 The engineering rules that shape the code

From §1.2 of the specification, restated because they get tested under time pressure:

1. **No mocks, no stubs, no fake data.** Every value shown to a user or written
   on-chain comes from a real contract call, a real carrier API response, or a
   real model inference. If it cannot be built for real it is *not built*, and
   the README says so. A missing feature is honest; a simulated one presented as
   working is disqualifying.
2. **Deterministic code controls money.** The model proposes a classification.
   It never mints, activates, releases escrow, or calls the carrier.
3. **Refusal is a success path.** `NEEDS_INFORMATION` and `REFUSED` get equal
   test coverage, equal on-chain commitment, equal UI prominence.
4. **No PII on-chain.** Hashes only. Assume every on-chain byte is public forever.
5. **Environment pairing is enforced at boot**, not by discipline — see §3 below.
6. **Tests are not optional.**
7. **Commit continuously.** Small, frequent commits from day one. A single large
   dump on the final day reads as copied or rushed.
8. **When blocked, stop and report.** Never invent a workaround that produces
   plausible-looking output.

---

## 2. Where the build actually stands

Day 6 of 8. Deadlines: **X Layer Aug 21 23:59 UTC** (submit Aug 19),
**BOT Chain Aug 22 23:59 UTC+8** (submit Aug 20).

### Done and verified

- Monorepo scaffolded at `/root/routelock`, pnpm workspaces, git initialised with
  the correct identity.
- **Pushed and public** at `github.com/Jennycruzy/routelock`. The dead-PAT
  blocker recorded here on 13 August is resolved; every commit on `main` is
  authored `Jennycruzy` and carries no AI attribution.
- **All four chain targets verified live over RPC** — not copied from a docs page.
  `pnpm verify:chains` re-checks every value against the networks themselves.
- **§7.2's critical unknown is resolved: USDT exists on BOT Chain**, on both
  mainnet and testnet, 6 decimals, confirmed by calling `symbol()` and
  `decimals()` on the contracts. This means settlement is ERC-20 everywhere and
  **the `NativeSettlement` variant is not needed**. Settlement still sits behind
  a discriminated union so that remains a config change rather than a rewrite.
- Boot-time environment pairing guard implemented with 13 passing tests.

### Verified chain configuration

| Target | Chain ID | RPC | Settlement |
|---|---|---|---|
| X Layer testnet | 1952 (`0x7a0`) | `https://testrpc.xlayer.tech` | USD₮0 `0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c` (6 dp) |
| X Layer mainnet | 196 (`0xc4`) | `https://rpc.xlayer.tech` | USD₮0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` (6 dp) |
| BOT Chain testnet | 968 (`0x3c8`) | `https://rpc.bohr.life` | USDT `0x75edC9335175Fc0552D51D48439F229c10420fe3` (6 dp) |
| BOT Chain mainnet | 677 (`0x2a5`) | `https://rpc.botchain.ai` | USDT `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C` (6 dp) |

**The same faucet also dispenses tUSDT**, resolved 2026-08-17 — so BOT testnet
issuance is *not* blocked on acquiring a stablecoin, and none needs buying. The
token it hands out is the configured `0x75edC933…`; its distributor
`0xf534f5c4…` is an EOA holding 9.99e9 tUSDT and does **not** hold `MINTER_ROLE`,
so it is a pre-funded hot wallet rather than a mint. `mint(address,uint256)`
exists on the token but is `MINTER_ROLE`-gated — simulating it from both project
addresses reverts `AccessControlUnauthorizedAccount`, so there is no
self-service path and the CAPTCHA means a human has to claim it.

BOT Chain testnet faucet: `https://faucet.bohr.life/en/basic` — 10 tBOT per address
per 24h. Testnet explorer `https://scan.bohr.life`, mainnet `https://scan.botchain.ai`.

The URL BOT Chain's own docs give, `https://faucet.botchain.ai/basic`, returns
**503** as of 2026-08-13 — the whole `faucet.botchain.ai` host is down. The
working mirror is on the testnet domain (`bohr.life`, same as the RPC and the
explorer). It is CAPTCHA-gated, so claiming cannot be scripted.

### Contracts — complete, 159 tests passing, 100% branch coverage

All five contracts from spec §4 exist under `packages/contracts/src`. Solidity
0.8.28, OpenZeppelin 5.6.1 via pnpm rather than git submodules, so a clone needs
only `pnpm install` and `forge build`.

**The spec's coverage target is met**: 100% branches, lines, statements and
functions on all five contracts. Every state transition and every access-control
edge is exercised, in both the succeeding and the reverting direction.

Three things not to undo when picking this back up:

- `SettlementEscrow._grantRole` **reverts** on `COMPLIANCE_ROLE`. The compliance
  service cannot be granted authority over funds by any admin at any point. This
  is deliberate and is the structural form of "the AI never moves money".
- `Verdict` is a three-way enum (`Approved` / `NeedsInformation` / `Refused`),
  not a bool, so refusals are committed on-chain with the same treatment as
  approvals. The test suite mirrors this — refusal and needs-information paths
  are written out separately rather than parameterised, so a regression names
  the verdict it broke.
- The deploy script asserts the role graph *including its negative half* and
  re-attempts the forbidden `COMPLIANCE_ROLE` grant on every deployment. That
  assertion failing means the central guarantee has been lost; it is not noise.

### DEPLOYED — X Layer mainnet (196), 17 August 2026

**X Layer's qualification requirement is met**: deployed on testnet, then
launched on mainnet. The broadcast record at
`packages/contracts/broadcast/Deploy.s.sol/196/` is the evidence for both halves
of the sequence. Do not delete or rewrite it.

| Contract | Address |
|---|---|
| `ServiceEntitlement` | `0x9DDFA913D42E52826100BDd0978Fd8a150Fc478a` |
| `SettlementEscrow` | `0x573fCA3A981218d1C148a63D9B27Bf1ef5867171` |
| `EntitlementFactory` | `0x87A78Cf1e419B9C707bA2848001DB2B3889afAf3` |
| `ActivationRegistry` | `0x9BedF0917d6E3e6f0A66F93a4086c381f7D3A3D6` |
| `FulfilmentReceipt` | `0x89e02FF1045727Bb557Bd4Eec6085dcaBa78945f` |

Block 68,234,300. Cost **0.0001436 OKB** (7,178,141 gas at 0.02 gwei) — within
0.05% of the figure estimated from the testnet run. Settlement is **USD₮0**
`0x779Ded0c…`.

**`ADMIN` and `ORACLE` are separate keys here, and that is the point.** The
oracle is `0x25CE528149563c217167b9cE148604FEbeCC151e`, a key created for this
deployment and nothing else. Verified from the chain rather than from the deploy
script's own assertions:

| Checked live on 196 | Result |
|---|---|
| `ORACLE_ROLE` → `0x25CE…` on entitlement, escrow, registry, receipt | **true** on all four |
| `ORACLE_ROLE` → the admin key | **false** on all four — the separation is real |
| `ADMIN_ROLE` → `0x69eb…` on all five | true |
| `COMPLIANCE_ROLE` → `0xA30D…` on the registry | true |
| Compliance holds anything on the escrow | **false** — both `COMPLIANCE_ROLE` and `ORACLE_ROLE` |
| `escrow.grantRole(COMPLIANCE_ROLE, …)` called as admin | **reverts `0xa3dd6e91`** = `ComplianceRoleForbiddenHere()` |
| Inter-contract wiring (classes, entitlement, escrow, registry) | all four resolve to the right addresses |

**A full end-to-end run completed on mainnet the same day.** `totalMinted()` is
**1**: entitlement 1, `Activated`, `APPROVED`, with a real carbon credit retired
against it and the provider's evidence committed back.

| | |
|---|---|
| Certificate | [`8453-0xdb7451c2…-0`](https://app.carbonmark.com/retirements/id/8453-0xdb7451c298d6f57b58874bd1f7e7c447863ed1e1190c98cc45478c9aae285f0d-0) |
| Payment | Base block **50,107,511**, **64 blocks** behind head when checked |
| Charged | **0.028259 USDC gross, 0.000401 refunded as change, 0.027858 net** |
| Credit | 0.001 t Solar PV – Small Scale, UCR |
| Decision | `0x0a0121d3…`, engine `compliance-0.2.0/carbon-registry-v1`, verdict `Approved` |
| Carrier evidence | `0x855be16b…` committed on X Layer mainnet |

The 64-block figure is the check that matters: it is the same test that exposed
the 14 August placeholder, where a "retirement" sat 36 million blocks behind head.

⛔ **Read the charge figure carefully.** The run prints `charged 0.028259`, which
is what left the issuer's wallet. The x402 router then refunded **0.000401** of
unused change in the same transaction, so the net cost was **0.027858**. Both
numbers are true and they are not interchangeable — the balance moves by the net,
the authorisation covers the gross. The testnet run shows the same pattern
(0.028125 gross, 400 refunded).

**Step 10 executed for the first time here, and it worked.** The proof is a number
that did not move: the wallet held **1.359272 USD₮0 before the run and 1.359272
after**. 0.3 went into escrow and 0.3 came back — release, claim, withdraw
collateral — leaving the escrow at **0** and deposit 1 marked settled. A mainnet
run now costs nothing but gas and the credit.

### DEPLOYED — BOT Chain testnet (968), 18 August 2026

The testnet deployment is live and independently verified at chain 968. The
deployment record is [`deployments/botchain_testnet.json`](deployments/botchain_testnet.json)
and the broadcast transactions are under
`packages/contracts/broadcast/Deploy.s.sol/968/`.

| Contract | Address |
|---|---|
| `ServiceEntitlement` | `0x16DBdF87A9A99891eb2B89557527269B81a991D4` |
| `SettlementEscrow` | `0x5caeCb1fD4101b49f921E826ea8a7a390D42FA43` |
| `EntitlementFactory` | `0xA336656FA1DAcBB99d3C02a45fF8382a17263FD8` |
| `ActivationRegistry` | `0xC9bF75F4c0950bC5c53538A12Dc172C13a274dBe` |
| `FulfilmentReceipt` | `0xC47c81B384cb20D23B18dA760C8E5f4587Ab7997` |

The five creates mined in blocks **20273858–20273861**. Total deployment cost
was **0.14356402 tBOT** (7,178,201 gas at 20 gwei). Settlement is USDT
`0x75edC9335175Fc0552D51D48439F229c10420fe3`, 6 decimals.

Live verification passed: all five addresses have bytecode, factory/registry
wiring resolves to the deployed addresses, the admin/factory/registry/oracle/
compliance roles are correct, and an admin simulation of
`grantRole(COMPLIANCE_ROLE, …)` still reverts `0xa3dd6e91`
(`ComplianceRoleForbiddenHere()`).

### Deployed — X Layer testnet (1952), 13 August 2026

Live at block 38195716. Addresses in `deployments/xlayer_testnet.json`; the
broadcast record with tx hashes and timestamps is tracked at
`packages/contracts/broadcast/Deploy.s.sol/1952/` and is the evidence for X
Layer's testnet-before-mainnet requirement. Do not delete or rewrite it.

Verified independently from the chain, not from the deploy script's own output —
including a live simulation proving `SettlementEscrow` still reverts
`grantRole(COMPLIANCE_ROLE, …)` with `ComplianceRoleForbiddenHere()` when called
by the admin, while the same call for `ORACLE_ROLE` succeeds. Re-run that check
after any redeploy; it is the one assertion the whole pitch rests on.

Remaining chain work: complete an approved 968 run, then deploy BOT Chain
mainnet. X Layer and the BOT Chain testnet deployment/recovery are complete.

**BOT Chain testnet deployed 18 August** — the deployer paid 0.14356402 tBOT
from the claimed balance. The separate oracle wallet was funded after deployment
and the 968 e2e run is now unblocked.

Balances, checked live after recovery: deployer **9.33758978 tBOT / 0.3 tUSDT**,
compliance **9.99621108 tBOT / 999.7 tUSDT**, oracle **0.49809922 tBOT / 0 tUSDT**.
BOT mainnet holds **0 BOT** on all three keys.

Funding receipts: 0.3 tUSDT from compliance to deployer in block **20275741**
(`0xd7f03ff5aecfda17ca7c2a418896529406d2bb7300f591250849d86a0ac77bb3`), and
0.5 tBOT from deployer to oracle in block **20276020**
(`0x922c80288b2951c23fb957ed5b35cab97a02d6c6826a514771e49fca1a24560e`).

### BOT e2e rehearsal — first run, 18 August 2026

The first real 968 run completed the non-approval branch successfully. It used
class label `carbon-retirement-0.001t-1787042816`, class id
`0x9027c2d5238ba706afb54fa1e3f312eac7ee4993bbc42ce45773b55fd86fcace`, and
minted token **1**. The live model returned `NEEDS_INFORMATION` with
`low_confidence` at **0.62**; compliance committed decision hash
`0xead68579d76cb0f462f4f20e3ed4eecdb86dbbfb3d446d3ccb4574b659931a3a`.

This is a completed refusal/information-needed outcome, not a failed run. It
exercised registration, class creation, collateral, minting, work submission,
and the separate compliance signer. Because the decision was not `Approved`,
the script correctly did not retire a credit, call the oracle, or settle the
escrow.

Immediately after the run, token 1 was `Available`, its deposit was unsettled,
the escrow held **0.3 USDT** (**0.1** buyer deposit plus **0.2** collateral),
and the deployer held **0 tUSDT**. The funds were safe pending recovery. The
recovery decision is deterministic: no carrier evidence means refund token 1,
then withdraw the freed 0.2 collateral.

For this deployment the two recovery writes use the two separate signers:

```bash
ROUTELOCK_CHAIN=botchain_testnet \
  pnpm --filter @routelock/attest recover --broadcast
```

The recovery tool now handles split keys: it prompts for the deployer key for
collateral/claims and the oracle key for settlement. Its dry run was verified
against this live state and plans exactly one 0.1 USDT refund plus a 0.2 USDT
collateral withdrawal.

Recovery was then broadcast successfully: `refundBuyer(1)` in block **20277908**
(`0xebc84dbfb6e0422a16c48f3f73e12c975586266ae32b6082192698a362f67537`) and
`withdrawCollateral` in block **20277914**
(`0x684a566d6e2b4ec0131e2466ded376ab52e4135506e1f879162a365070fd253c`). The
escrow now holds **0 USDT**, token 1's deposit is settled, and the class has
zero outstanding obligation and collateral.

### Deploy again with

`packages/contracts/script/Deploy.s.sol`, driven by `scripts/deploy.sh`, with
`test/Deploy.t.sol` exercising it under `forge test` so the deploy path is not
first tried against a real chain.

```bash
cd /root/routelock
./scripts/deploy.sh xlayer_testnet               # simulate, writes nothing
./scripts/deploy.sh botchain_testnet --broadcast # deploy for real
```

Use the wrapper rather than calling `forge script` directly. The raw invocation
is long enough to wrap in a terminal, and a wrapped command becomes a different
command — that is how the first attempt at this failed. It also verifies over RPC
that the endpoint really is the chain named before anything is signed, refuses
when `ORACLE` and `COMPLIANCE` share an address, and makes a mainnet deploy
require typing the chain name by hand. Roles and RPCs come from `.env`; anything
already in the environment overrides it.

The deployer key is read from the Foundry keystore (`--account
routelock-deployer`) and prompts for its password, so it never appears in shell
history or a process listing. **The password prompt is interactive, so the
broadcast must be run by a human in a terminal.**

The settlement token is chosen by `block.chainid` from the four verified
addresses, never read from the environment — a shell typo cannot repoint a
deployment. An unrecognised chain id aborts, **including 195**, the stale X Layer
testnet id. A dry run deliberately writes no address file, because simulated
addresses in `deployments/` would be indistinguishable from a real deployment.

Broadcast records under `packages/contracts/broadcast/` are **tracked in git** —
they carry the tx hashes and timestamps that evidence X Layer's
testnet-before-mainnet requirement. Only `dry-run/` subdirectories are ignored.

### Credentials — both live as of 14 August

`SHIPBUBBLE_API_KEY` (sandbox, `sb_sandbox…`) and `ANTHROPIC_API_KEY` are in
`/root/routelock/.env`, both verified against their real APIs. The day-1 guess
that the carrier key would carry an `sb_sandbox` prefix turned out to be
correct, so `assertEnvironmentPairing` needed no change.

`ROUTELOCK_LLM_PROVIDER=anthropic`, `ROUTELOCK_LLM_MODEL=claude-sonnet-5`.

### Carrier adapter — built, exercised against the real API

`packages/carrier`. A generic `CarrierAdapter` port with `ShipbubbleAdapter`
behind it; 24 tests. `pnpm --filter @routelock/carrier smoke` quotes three lanes
(NG→NG, NG→GB, NG→HK) against the live sandbox and consumes no quota.

**Four findings that constrain what can honestly be demoed:**

1. **Sandbox couriers are test fixtures** — "Bubble Express", "Richard Express",
   "Millie Express". Their prices respond to weight but **not to destination**:
   Lagos, London and Hong Kong return byte-identical figures. Sandbox proves the
   integration works and proves nothing about what a cross-border shipment
   costs. Every `Quote` carries a `live` flag derived from the chain so a
   sandbox number can never be displayed as a real one.
2. **Real coverage is unknowable from sandbox.** The per-courier coverage
   endpoint 404s for the test couriers, so whether Shipbubble serves any given
   country still needs the live key or a written answer from support.
3. **Cancellation is narrow.** Only *scheduled* shipments can be cancelled, and
   only while the processing date has not passed; afterwards the carrier answers
   "Shipment label already processed". Refund behaviour is undocumented and
   unconfirmed. **Treat a live purchase as spent, not reversible**, and book a
   far-future pickup date to keep the window open.
4. **Category ids are account-specific.** The sandbox returns entirely different
   ids from Shipbubble's published example, so the adapter matches by name and
   resolves ids at runtime. A hardcoded id would work here and mis-route in
   production.

**Routing and refusal are separate modules, deliberately.** `categories.ts` maps
all 96 real HS chapters to a routing bucket and refuses nothing. `policy.ts`
holds carrier acceptance, quoting Shipbubble's published "Prohibited products"
clause with a dated source URL, and every refusal names the clause it came from.

The first version of this was wrong and is worth not repeating: the refusal list
was written from general knowledge with no source, and was wrong **in both
directions** — it permitted prescription pharmaceuticals and alcohol, which the
policy forbids, and refused petroleum, chemicals, fertiliser and artworks, which
the policy never mentions. Note also that **chapter 22 splits at the heading**:
2201-2202 are water and soft drinks, 2203-2208 are alcoholic. Refusing the
chapter blocks bottled water; permitting it ships whisky.

### Compliance engine — built, ruling against the real model

`packages/compliance`, 35 tests. `pnpm --filter @routelock/compliance classify
--goods "…" --from NG --to GB` rules on one consignment and prints the verdict,
its ground, the decision hash, and the exact bytes hashed.

**The structural rule: the model proposes, deterministic code decides.** The
model returns a `Proposal` — candidate HS-6, stated confidence, what it is
missing, purpose flags. It has **no verdict field**, so its opinion of the
outcome has no path to the chain; a test asserts that shape so it cannot widen.
`decide()` is a pure function with no network and no model in it. Together with
the escrow refusing `COMPLIANCE_ROLE`, the AI can neither move money nor choose
the outcome.

Verified live: whisky was classified correctly and confidently by the model
(`220830`, 0.95) and **refused anyway** by the carrier-policy rule. "a box of
stuff" returned no classification, confidence 0, and four usable questions.

Three things not to undo:

- **Check order is part of the rule.** Purpose flags outrank carrier policy,
  which outranks missing information, which outranks confidence. A prohibited
  item described vaguely by an unsure model could exit three ways; it must exit
  by the most serious, or the record reads "we needed more information" about
  goods that are simply refused.
- **Cross-border faces a higher confidence bar** (0.9 against 0.85), derived
  from the two country codes and never configured. **0.85 is a starting
  position, not a tuned constant** — replacing it with a measured one is what
  the benchmark is for, and changing it must change `ENGINE_VERSION`.
- **`decide()` re-checks the confidence range itself.** `parseProposal` already
  clamps model output, but `decide` gates money and must not trust its caller: a
  confidence of `2` would otherwise clear a threshold of `0.9`. Found by a test.

The decision hash commits to a canonical JSON — keys sorted at every depth,
array order preserved, confidence rounded to 3dp *before* hashing. The CLI
prints the bytes next to the hash so the commitment can be checked rather than
trusted.

### The HS benchmark is parked at 253 of 354 rows — deliberately

The grounded scoring run died at row 253 of 354 when the inference account ran
out of credit. **This is no longer the next action.** Delivery is now a
reference implementation rather than a deployed adapter, so HS classification
accuracy gates nothing that ships, and the remaining credit belongs to the
carbon quality benchmark instead.

Both READMEs already state the 253-row figures and say so explicitly, so nothing
in the repository overstates what was measured. Leave that disclosure standing.

Finishing it stays cheap and worthwhile whenever there is credit to spare — one
command, ~101 rows, roughly $0.85:

```bash
cd /root/routelock && set -a && . ./.env && set +a
pnpm --filter @routelock/bench score
```

It resumes from a checkpoint and pays only for the ~101 missing rows (roughly
$0.85 at the introductory rate). Do **not** delete
`bench/data/.checkpoint-claude-sonnet-5-grounded.jsonl` — it is what makes the
253 already-paid-for rows free. It is gitignored, so it exists only on this box.

Afterwards, update the figures in `bench/README.md` and the root `README.md`;
both currently state the 253-row numbers and say so explicitly.

**Three protections are in place because each was learned the hard way. Do not
remove them.**

1. **Every row is saved the moment it finishes.** An earlier run wrote results
   only at the very end, so when it died it threw away all the finished work.
   Now a crash costs only the rows not yet reached.
2. **A `400` error is never retried.** "Your credit balance is too low" arrives
   as a `400`, and retrying it can never succeed — it just burns the rest of the
   run against a dead account. Errors that *are* temporary (429 rate limit, 529
   overloaded, any 5xx) do retry, with backoff.
3. **Each configuration writes its own results file.** Both runs originally
   wrote to one shared filename, so the grounded run overwrote the ungrounded
   results and destroyed the "before" half of the comparison. It had to be
   recovered from git history. Grounded and ungrounded now write
   `results-<model>-grounded.json` and `-ungrounded.json`.

### Compliance engine — measured, and the measurement changed the design

Scored over the corpus in two configurations. On the 253 rows both runs covered:

| | From memory | Grounded |
|---|---|---|
| Top-1 accuracy | 36.8% | **47.4%** |
| Accuracy when approved | 79% | **89%** |
| | | 40 fixed, 13 broken |

**The calibration curve is the finding.** Classifying from memory the engine was
overconfident by fifteen to twenty-five points at every level; grounded, at
0.9–1.0 it states 92.0% and delivers 92.6%.

Consequence: **leave `CROSS_BORDER_CONFIDENCE_THRESHOLD` at 0.9.** An earlier
reading of the ungrounded curve concluded the threshold was too permissive and
should be raised — that recommendation does not survive the grounded data, and
the docs were corrected rather than left standing.

Three things not to rediscover:

- **Do not rebuild word-matching as the way to shortlist candidate codes.** The
  idea was to hand the engine a shortlist to choose from rather than have it
  recall a code from memory, and the obvious way to build that shortlist is to
  match words in the goods description against words in the official tariff
  text. It does not work: **the correct code was in the shortlist only 22.3% of
  the time**, while the engine on its own already reaches 36.8% — so the
  shortlist would have made it worse. Tariff wording is legalistic and shares
  little vocabulary with how a shipper describes goods ("angled flange plated
  base" against "lamps and lighting fittings, parts thereof").

  The way this was found is the reusable part: **checking a shortlist costs no
  model calls at all**, so it was measured in a minute, before anything was
  built on top of it and before a penny of inference was spent. Measure the
  shortlist before building what consumes it.
- **The first pass names the right chapter 80.6% of the time and the right
  subheading 36.8%.** In other words the engine knows roughly *where* goods
  belong and loses accuracy narrowing down. That gap is why grounding works —
  and it is also its ceiling, because the second pass can only choose within the
  chapters the first pass named.
- **The nomenclature cache is committed** (`packages/compliance/data/nomenclature/`,
  2,092 subheadings from the USITC HTS export). Fetching it needs no model and no
  key; runs are reproducible offline.

### Benchmark corpus — built and scored

`bench/` holds 258 rows drawn from CBP CROSS binding rulings, 133 HS-6
subheadings across 35 chapters, each citing the ruling it came from. 26 tests.

Building it needed no inference; **scoring it does**, so there are no accuracy
figures in this repository and none may be added until a real model has been run.
The trap that matters is in `bench/README.md`: a ruling states its own answer in
its header and its conclusion, so a careless extraction yields a benchmark that
reports near-perfect accuracy while measuring nothing.

### Adapters — one shared port, three verticals

`packages/fulfilment` holds `FulfilmentAdapter`, the port every vertical
implements. It is a zero-dependency leaf on purpose: `@routelock/compliance`
already depends on `@routelock/carrier`, so a port importing compliance would
close a dependency cycle.

Two things in that package are load-bearing and should not be softened:

- **`fulfil()` takes `Approved<TOrder>`, not a bare order.** The only way to
  obtain one is `approve()` in the compliance package, which returns `null` for
  every verdict other than `Approved`. Fulfilling unapproved work is therefore a
  *compile error*, not a runtime check that a future call site could forget —
  the TypeScript counterpart of `SettlementEscrow` refusing `COMPLIANCE_ROLE`.
  Verified by probe: both a bare order and a hand-forged object carrying every
  visible field are rejected by `tsc`.
- **`cancel` is deliberately absent from the port**, because a retired carbon
  credit cannot be un-retired. Adapters expose cancellation shaped to what their
  provider actually supports, and `reversible` says which can.

Delivery names the two layers for what they are: `ShipbubbleClient` speaks
Shipbubble's API, and `ShipbubbleAdapter` is the single adapter above it. Status
lives in `docs/adapters.md` and is mirrored in the adapter's own fields, so the
two move together.

### Carbon — ACTIVE. One real retirement, 17 August 2026

The heading of this section said "blocked on production access" until 17 August.
It was never resolved and did not need to be: the keyless x402 path retired a
real credit without a key or an account. Evidence and the four verification
checks are at the top of this file and in `docs/adapters.md`.

The REST notes below are retained because the finding is worth keeping and the
adapter is still in the tree as `Superseded`.

`packages/carbon` implements the shared port. Everything upstream of the
retirement itself is exercised against real data with the test key: credential
verification, listing discovery, supply filtering, assessment and quoting.
`pnpm --filter @routelock/carbon smoke` runs the lot and deliberately stops
before spending.

**The finding that matters, and the one not to re-learn the hard way: a
test-mode key retires nothing.** Submitting a real order on 14 August returned
`status: COMPLETED`, a real Polygon transaction hash, a real certificate URL, and
an on-chain receipt reading SUCCESS with 34 logs. All of it looked like success.
It was Carbonmark's **shared placeholder** — a genuine retirement from **April
2024**, beneficiary "Developer Tester", 0.123 t, that every test-mode order in
the world links to. Their own record on that page says not to deliver it to
customers because the benefit was already claimed.

**Never show that certificate URL to a judge.**

The tell was the block number: the chain head was ~92,017,000 while the
transaction sat in block 55,853,988. A transaction created minutes ago cannot be
36 million blocks old. **Check that a transaction's block is recent, not just
that the transaction exists.**

The code now enforces the general form of that check rather than a match on one
known page: `fulfil()` throws when the returned beneficiary is not the one asked
for, because a receipt that does not describe the request is not evidence for
the request. A `Receipt` is what gets hashed into `carrierRefHash` and published
as proof, so committing a placeholder on-chain would be fabricated evidence.

Other Carbonmark facts worth keeping (full detail in
`docs/carbonmark-verification.md`):

- **`/prices` is public.** It answers 200 with no key and with an invalid key.
  It can never confirm a credential. **`/orders` is the check** — 401 on a bad
  key.
- **No sandbox host.** `api.sandbox.carbonmark.com` does not resolve; both
  environments answer on `api.carbonmark.com`, so the key prefix is the only
  separator. That is why `livePrefix` stays `null` until a real production key
  exists to read the format from — no key can boot a mainnet adapter today.
- **Retirement is asynchronous.** `POST /orders` returns before the transaction
  hash exists; the client polls.
- **`GET /orders/{id}` is unusable** — it takes a numeric id that no order
  response contains. Orders are matched on quote uuid or transaction hash.
- Only **61 of 723** listings had liquid supply. Read it live; supply moved from
  18,993 t to 0.056 t on one listing within minutes.

### End-to-end rehearsal — built, steps 1–4 proven on chain

`packages/attest/scripts/e2e.ts` runs the whole system in one pass: register
issuer → create class → post collateral → mint → assess → rule → commit the
decision on X Layer under the compliance key → retire a real credit → record the
provider's receipt. **Dry run by default**; `--broadcast` sends, and the
retirement carries a second independent gate
(`ROUTELOCK_X402_ALLOW_LIVE_RETIREMENT`) because a testnet obligation discharged
with a real credit is irreversible.

Two signers, deliberately different keys: the deployer (issuer/buyer/admin/oracle,
from the Foundry keystore) and the compliance service from
`COMPLIANCE_PRIVATE_KEY`. The escrow structurally refuses the compliance key any
authority over funds, so it can open the activation gate and can never move
money. **Running them as one key would erase the property the whole pitch rests
on** — do not "simplify" this.

| | address | holds (checked 16 Aug) |
|---|---|---|
| deployer / role | `0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6` | 1 USD₮0, 0.3997 OKB on X Layer; **2.99 USDC on Base** |
| compliance | `0xA30D83117470c884fB3C35532d2a49Bc65B0922a` | 0 USD₮0, 0.2 OKB |

**Step 8 is funded and the old README claim that it was not is wrong.** The
retirement pays ~0.03 USDC on Base via EIP-3009, which **needs no ETH** — the
Base ETH balance is 0 and that is fine. `ROUTELOCK_MAX_RETIREMENT_USDC` caps a
single signature, default 1 USDC.

Note the deliberate asymmetry in `e2e.ts`: the adapter built at step 5 for
assessment takes a `sign` that throws, so the code path that reads inventory
physically cannot spend. Step 8 constructs a *second* adapter with a real signer
under an explicit ceiling. **That throwing stub is not a TODO — do not "fix" it.**

**All ten steps have now completed on the real chain**, on 17 August, producing
entitlement 4 and the retirement recorded at the top of this file. Step 8 — the
EIP-3009 signature and the irreversible burn — executed for the first and so far
only time.

**A rehearsal that costs nothing is `--fork`**: a local anvil forked from the
chain, where accounts are impersonated so no key and no gas are needed, and step 8
refuses by design because the credit and the USDC on Base are real either way.
Fork the chain at the **current** head — a fork left running from a previous
session serves state that has since moved, and every read against it looks
perfectly valid.

**Run cost is now configurable and defaults unchanged.** `ROUTELOCK_PRICE`,
`ROUTELOCK_COLLATERAL` and `ROUTELOCK_PAYOUT` default to 1/2/1 USD₮0. A 10×
scaled run costs 0.3 and exercises an identical path — the escrow only requires
collateral to cover the obligation after the mint. **These are fixed at
`createClass`, so reusing a class label via `ROUTELOCK_CLASS_LABEL` means the
on-chain price governs and the env vars silently do not apply.** Scaled runs need
a fresh label.

`ROUTELOCK_RESUME_TOKEN` resumes a token already submitted for review, and
**requires `ROUTELOCK_CLASS_LABEL`** — without the original label the run
computes a different `classId` and would bind the decision to the wrong class.
It only works on a token that reached `submitParcel`; the resume path reads the
on-chain parcel hash and refuses on a zero.

**Token 3 is stranded** — minted, never submitted, 3 USD₮0 locked in escrow. Not
recoverable by resume.

### Frontend — built 17 August, serving live values

`apps/api` is `node:http` + viem, no framework. `apps/web` is one HTML file, one
stylesheet and one script, no build step. Start it with
`pnpm --filter @routelock/api start`.

| Endpoint | Serves |
|---|---|
| `GET /api/state` | addresses, bytecode lengths, totals, settlement token read from the token, and the **17-check role graph** — the same assertions `Deploy.s.sol` makes |
| `GET /api/guarantee` | the `COMPLIANCE_ROLE` refusal probed live, **plus a control call** that must succeed |
| `GET /api/fulfilment` | the retirement, re-verified against the provider per request, with the block distance published |
| `GET /api/carbon/inventory` | live Klima x402 inventory — free, keyless |
| `POST /api/rule/hs` | real HS ruling on the visitor's own description, any lane |
| `POST /api/rule/carbon` | real carbon-quality ruling on a class from live inventory |
| `GET /api/replay/:tokenId` | the on-chain audit trail, with the `cast` command to re-read it |
| `GET /api/budget` | served-ledger spend and the three thresholds |

Three things not to undo:

- **The API holds no key and signs nothing.** `no-signing.test.ts` reads the
  package's own source and fails if any of twelve signing symbols appears in
  code. If an endpoint ever needs to write, that is an operator script, not a
  route.
- **A refusal is a 200.** The only 4xx are a malformed request and `402` for an
  exhausted budget. The three verdict cards are identical in size and weight.
- **Served endpoints spend from `data/served-inference.jsonl`**, capped separately
  from the operator's 25 (`ROUTELOCK_SERVED_MAX_CALLS`, default 40) and rate
  limited per address (`ROUTELOCK_RULE_LIMIT`, default 5/hour).

### Not started

The compute adapter (`AkashAdapter`). Nothing is stubbed or scaffolded.

### Resume here — in this order

X Layer is finished completely before BOT Chain is started.

1. **Carbon quality benchmark — DONE, all five steps plus the citation fix.**
   **Nothing here is pending. There is no carbon task left, and the budget could
   not fund one anyway: 69 of 70 calls are used, $0.79 of the $1 soft limit.**
   Read [`docs/carbon-benchmark-design.md`](docs/carbon-benchmark-design.md)
   §9–§11.

   **The citation fix is applied and published.** `buildCarbonPrompt` now
   requires every adverse finding to name its source. Re-scored for 15 calls,
   $0.184; before/after in §11 and in
   `bench/data/disclosure-citation-comparison.json`.

   | | Before | After |
   |---|---|---|
   | Findings carrying a named source | 4 of 46 | **23 of 31** |
   | Rows naming ICVCM or the CCPs | 0 of 15 | **0 of 15** |

   So the *traceability* defect is fixed and the defect **as §10 named it is
   not**. The engine cites Öko-Institut, Verra, Berkeley and the European
   Commission fluently, and still never cites the one authority holding a dated
   determination on the methodology in front of it.

   ⛔ **Do not close that last gap by naming ICVCM in the prompt.** It would buy
   the number by destroying its meaning — `namesAuthority` would become a test of
   whether the model can copy a word out of its instructions. `propose.test.ts`
   **fails if the prompt ever contains `icvcm`, `ccp`, `core carbon` or
   `integrity council`.** That test is the point, not an obstacle to route
   around; if a future edit wants to lift the number, the answer is no.

   Two things worth carrying out of this:

   - **Re-scoring is free and must stay free.** Result files carry their findings
     verbatim, so `pnpm --filter @routelock/bench rescore:disclosure` recomputes
     the whole disclosure arm with no model calls. Re-running the model to change
     an instrument also confounds the new metric with fresh sampling noise.
   - **Findings per row fell 3.07 → 2.07**, and the vague ones are what went (11
     unattributed gestures → 1). Intended direction, but unproven: a prompt that
     suppressed real concerns by demanding paperwork for them would look
     identical in that table.

   ⛔ n=15, one sampling draw per arm, and `SOURCE_TERMS` is post-hoc — written
   after reading the outputs, applied identically to both arms, not
   pre-registered. It describes a change; it does not prove one.

   The ICVCM decision table is built and committed (181 rows,
   `bench/data/icvcm-decisions.json`), and the join is counted
   (`bench/data/icvcm-join-count.json`). **Purchasable inventory on a recognised
   registry is 18 projects; 16 pairs join to an ICVCM decision; all 16 are on
   methodologies ICVCM rejected and none is CCP-Approved.** So §3.2 has no rows
   at all, and §3.1 has no positive control. Ignoring purchasability does not fix
   it: 157 rows, still 9 determinations, still 3 approved projects, all refused
   on liquidity before the model is asked. The constraint is what is tokenised
   for sale, not the ground truth.

   **Steps 4 and 5 are done too** — 15 rows scored for 15 calls. The engine never
   rated a rejected methodology `strong`, in either run. **Mind which file you
   read:** `results-carbon-claude-sonnet-5-uncited.json` is the pre-fix run that
   §10's figures describe, and `results-carbon-claude-sonnet-5.json` is the run
   after the prompt change.

   ⛔ **Two limits that must travel with any figure:** no positive control, and
   the corpus is Carbonmark's REST catalogue while the deployed x402 inventory
   names sectoral scopes that join to no ICVCM decision at all.

   Still true and still binding: **the threshold cannot be derived from a
   calibration curve** — 0.7 stays picked and stays labelled picked, for the
   reason in §1, which none of the above touches.

   ⛔ **One figure in this file was wrong and is corrected here:** an earlier
   note said "51 VCS projects with supply". `hasSupply` and a `/prices` row both
   overstate it — 678 of 753 price rows hold **zero** supply. The real
   purchasable universe is **28 projects, 18 on a recognised registry**. Trust
   `bench/data/icvcm-join-count.json`, which is rebuildable, over any number
   quoted in prose. The HS benchmark's parked 101 rows stay parked.
2. **Separate `ADMIN` from `ORACLE`** before mainnet — **done and verified on
   mainnet.** `Deploy.s.sol` refuses a mainnet deploy
   (196, 677) where `ROUTELOCK_ADMIN == ROUTELOCK_ORACLE`, as a precondition
   checked *before* `startBroadcast` rather than an assertion discovered after
   the gas is spent. `oracle != compliance` and `admin != compliance` are
   refused on every chain, testnet included. Five tests in `Deploy.t.sol`.

   Testnet 1952 still runs them on one key, deliberately and now explicitly
   permitted — `test_adminMayShareTheOracleKeyOnTestnet` names it as a shortcut
   rather than leaving it as an accident.

   Mainnet uses the dedicated `routelock-oracle` keystore account; the testnet
   1952 deployment still deliberately shares the admin/oracle key.
3. **X Layer mainnet deploy and e2e**, including Step 10 settlement, are done.
4. **Submit X Layer** — the code is done; see §7 for what remains, which is not code.

   **Then BOT Chain mainnet. §8 is the runbook; testnet 968 is deployed and
   verified.**
5. **Secondary market listing contract — BUILT.** `EntitlementMarket.sol`, 23
   tests, 100% branches. **Not deployed anywhere**, deliberately: it is written
   and proven, and putting it on chain is a separate decision.

   It is **additive and holds no role on anything**, which is what let it be
   added without reopening the deployed five — `test_theMarketHoldsNoRoleAnywhere`
   fails if that ever stops being true. It takes no custody either: the seller
   keeps the token and grants an ERC-721 approval.

   The design point worth not undoing: **`buy()` re-checks the entitlement state
   at execution, not only at listing.** A token listed while `Available` can be
   submitted, approved and activated before a buyer arrives, so a listing is a
   standing offer that its own lifecycle can invalidate. Checking only at listing
   time would carry a stale permission and let the payment leg run before the
   ERC-721 transfer reverted. `test_aListingGoesStaleWhenTheTokenIsBoundAfterwards`
   is that property.

   Also covered: `expectedPrice` on `buy` so a relist cannot fill a pending
   purchase at a new number, a seller who has moved the token, a revoked
   approval, and a settlement token that calls back mid-transfer.
6. **`YieldAdapter` — buildable, and blocked on an environment rather than an
   asset.** `verify:chains` now probes the venue on all four chains.

   | | |
   |---|---|
   | Aave V3 on X Layer mainnet | **live** — pool `0xE3F3Caef…`, provider `0xdFf435BC…`, `getPool()` agrees |
   | Its stablecoin reserve | **USD₮0** `0x779Ded0c…`, aToken `aXlrUSDT0` |
   | RouteLock's mainnet settlement | **USD₮0** `0x779Ded0c…` — the same asset |
   | Aave V3 on X Layer **testnet** | **not deployed** — pool and provider return `0x` at 1952 |

   ⛔ **This entry said "do not build this" for part of 17 August, and that was
   wrong.** The claim rested on mainnet settling in `0x1E4a5963…`, which was a
   config error, not a fact about Aave — see the correction below. No swap is
   needed and no settlement change is outstanding; both were done.

   **What actually blocks it: there is nowhere to rehearse.** Aave is mainnet-only
   on X Layer, and the deployer holds 0 USD₮0 there. Building a yield adapter
   whose first execution is on mainnet, with real money, against a protocol this
   project has never called, two days before a deadline, is the kind of thing
   §1.5.1 exists to prevent. The options are a mainnet fork rehearsal (`--fork`
   against anvil at current head, which the e2e path already supports and which
   costs nothing) or leaving it.

   The Foundry `invariant_` test on the solvency property stays wanted and now has
   something to attach to.

   What is committed: `yieldVenue` on every chain in `chains.ts` (a discriminated
   union, so "no venue" and "a venue" are different shapes and `none` must carry a
   reason), the live probe in `verify:chains`, and five tests.

### ⛔ Correction, 17 August: mainnet settled in the wrong token

**`ROUTELOCK` mainnet settlement was `0x1E4a5963…` ("Tether USD", `USDT`) and is
now `0x779Ded0c…` (`USD₮0`).** The first is X Layer's legacy bridged USDT, being
phased out; the second is the canonical LayerZero-OFT token the chain actually
uses. Measured, not argued: **30x the supply** (113.3M vs 3.8M), **19x the
transfer activity** over ten sampled 100-block windows, and it is the asset Aave
lists. X Layer *testnet* already settled in USD₮0, so the two environments
disagreed with each other for four days.

**Why nothing caught it.** `_assertSettlementToken` proves a contract exists and
answers `decimals() == 6` — both tokens do. `verify:chains` compared `symbol()`
against the configured symbol, and the configured symbol was `USDT`, which the
legacy token returns. A check that compares a config against itself confirms
consistency, never correctness. A test now names the legacy address and fails if
it reappears anywhere as a settlement token, because nothing structural can catch
it: it is a real, live, correctly-behaved ERC-20 that is simply the wrong one.

**The reasoning error worth not repeating:** a live on-chain reading disagreed
with the config, and the config was treated as ground truth, producing a
confident wrong conclusion about Aave. When a reading and a config disagree,
**the config is a suspect too.**

⛔ **Anything funded or acquired for mainnet must be USD₮0 `0x779Ded0c…`.** The
legacy USDT is not settlement anywhere and buying it would be money spent on the
wrong asset.

`ClassShares` remains wanted and remains last.

**Done and struck from this list:** Carbonmark production access (routed around
entirely — the keyless x402 path made KYB irrelevant), the `CarbonmarkAdapter`
REST path (superseded, retained for the evidence it carries), wiring
`ActivationRegistry` (done, and exercised by a real fulfilment), and the frontend.

---

## 3. The guard that prevents accidental spending

`packages/chain/src/chains.ts` implements spec §1.2.5. It throws at process
start, before any route is registered:

| Provider | Chain env | Required key | Consequence of mismatch |
|---|---|---|---|
| Shipbubble | testnet | `sb_sandbox…` | a live key on testnet throws — this is how real shipments get bought by accident |
| Shipbubble | mainnet | `sb_prod…` | a sandbox key on mainnet throws — a mainnet deploy must never show a sandbox result |
| Carbonmark | testnet | `cm_api_sandbox…` | as above, for retirements |
| Carbonmark | mainnet | **none accepted yet** | `livePrefix` is `null`, so *no* key boots a mainnet carbon adapter |

An **absent** key throws too. There is no mock-carrier fallback, deliberately.
An **unrecognised** key prefix throws rather than guessing which environment it
belongs to.

Carbonmark's `livePrefix` is deliberately `null` because no production key has
been seen. `openapi.json` shows examples shaped `cm_api_<uuid>` with no
environment marker, but an example in documentation is not evidence about a key
nobody holds, and guessing would defeat the guard — Carbonmark has no separate
sandbox host, so the prefix is the only thing distinguishing the environments.
**When the production key arrives, read its prefix and set `livePrefix` from the
key itself.**

`requireSettlementToken()` throws on an unresolved settlement rather than
returning a zero or placeholder address. All four targets now resolve, so
`verify:chains` passes clean — but keep that refusal path intact. It is what
stops an unverified token address reaching a deployment.

---

## 4. Blocked — needs a human

These cannot be resolved from this box and are listed in the order they block work.

1. ~~**Carbonmark production access.**~~ **No longer blocking anything, and it
   never has to be resolved.** The keyless Klima x402 path performed a real
   retirement on 17 August without a key, an account or an onboarding queue, so
   KYB review is off the critical path entirely. The question about retiring on
   behalf of third parties becomes live again only if the REST adapter is ever
   shipped, which `docs/adapters.md` records as Superseded.

2. **Dedicated X account** must be created and posting daily from day 1, with the
   submission post mentioning **@XLayerOfficial**. This is a hard eligibility
   gate; failing it disqualifies the submission regardless of build quality.
   Day 1 has already passed without a post.

3. ~~**Inference credit**, for the carbon quality benchmark.~~ **Done.** The
   carbon benchmark and citation rescore used 69 of 70 calls; the parked HS
   rows remain deliberately unfinished.

   **X Layer testnet USD₮0 is *not* on this list, and should not be treated as
   blocking.** The faucet has a per-address cooldown enforced off-chain by OKX's
   queue; a second claim inside the window does not land and the UI does not
   clearly say so. The response is not to wait for it — scale the run down with
   `ROUTELOCK_PRICE` / `ROUTELOCK_COLLATERAL` / `ROUTELOCK_PAYOUT` and use the
   balance already held. Diagnosis method in `docs/chain-verification.md`, under
   "The binding constraint is the cooldown, not the balance".

4. **BOT Chain gas support form** (1 BOT per eligible project) and their project
   submission form — both were to be filed day 1 and have not been.

5. **Shipbubble is no longer blocking anything.** Delivery is a reference
   implementation that is not deployed, so the LIVE key and the
   third-party-platform question are both moot for this submission. Left
   recorded because the questions become live again if delivery is ever shipped:
   only 5 free live shipments exist, and cancellation is **scheduled shipments
   only, before the processing date, refund behaviour unconfirmed.**

6. **X Layer mainnet funding and deployment are done.** The remaining funding
   items are on the BOT mainnet path:

   | Missing | Blocks |
   |---|---|
   | **BOT Chain mainnet gas** (holds 0) | the 677 deployment |
   | **BOT gas-support and project forms** | the mainnet funding request and submission |

   BOT testnet deployment, funding, and recovery are complete. The first 968
   e2e branch is recorded; an approved run is the next technical step. The next
   deployment blocker is mainnet gas for 677.

---

## 5. Commands

```bash
cd /root/routelock

pnpm install
pnpm verify:chains                          # re-check all four chains against live RPC
pnpm --filter @routelock/chain test         # environment-pairing + config tests

cd packages/contracts
forge build
forge test                                  # 159 passing
forge coverage --report summary             # 100% branches on all five contracts

git log --format='%an <%ae>' -20            # identity check before any push
```

`pnpm verify:chains` passes clean on all four targets as of 2026-08-13. If it
starts failing, trust it over the config — it is asking the chain, and the config
is only a record of a previous answer.

```bash
pnpm --filter @routelock/carrier smoke      # quote 3 lanes, free, no quota used
pnpm --filter @routelock/compliance classify --goods "…" --from NG --to GB
pnpm --filter @routelock/bench build:corpus # rebuild from both rulings databases
pnpm test                                   # 334 across eight packages
```

### End to end

```bash
pnpm --filter @routelock/attest e2e                      # simulate, spend nothing
pnpm --filter @routelock/attest e2e --broadcast --retire  # real, irreversible
```

A dry run cannot get past step 2 on a fresh label: `createClass` is simulated but
never sent, so step 3 posts collateral to a class that does not exist and reverts
`UnknownClass` (`0x693b1355` — `ESCROW_ABI` omits the custom errors, so it prints
undecoded). That is inherent to simulating a stateful sequence, not a defect.

Check funding without spending the keystore password — the balance gate at step 0
throws before anything is sent, so a short balance costs nothing but the prompt:

```bash
export PATH="$PATH:/root/.foundry/bin"
cast call --rpc-url https://testrpc.xlayer.tech \
  0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c \
  'balanceOf(address)(uint256)' 0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6
```

**`pnpm -r typecheck` is only as wide as each package's `include` globs.** It
read clean for days while `packages/attest/scripts/` — the only code that spends
money — was outside them. All six packages with a `scripts/` directory now
include it. If a check passes on code that plainly has a defect, suspect the
check's scope first.

---

## 6. Where the prize money actually is

Researched 14 August from the sponsors' own pages, not from the original brief.

**X Layer BuildX AI Season** — three tiers:

| Grant | Amount | Unlock |
|---|---|---|
| Hackathon | 30K / 15K / 5K USDT | judged on merit |
| Liquidity | 50K USDT | best project in the AI-RWA track |
| Launch | up to 200K USDT | **$10M cumulative OKX DEX volume by 31 Aug** |

**The Launch Grant is not reachable and should not be planned around.** It needs
ten million dollars of DEX volume within ten days of submission, which requires a
liquid fungible token. RouteLock mints ERC-721s. Realistic target is the 30K plus
the 50K.

Judging criteria, verbatim: *application of AI, innovation, product completeness,
user value, integration with X Layer, growth potential, contribution to the X
Layer ecosystem.*

**BOT Chain** Builder Challenge #1 paid **up to 5,000 USDT total**. If #2 is
proportional, BOT Chain deserves a deploy and a submission, not a redesign. Its
criteria were depth of chain integration, product completeness, innovation, demo
and documentation quality, and on-chain deployment and verification.

### Honest competitive position

A known competing entry: an AI agent monitoring OKX x-RWA backing and redemption
conditions for xBETH, auto-protecting Aave positions collateralised by it. It is
strong on ecosystem integration — built inside OKX's own product — and has an
obvious user with urgent pain. It is likely weak on AI depth: monitoring a
backing ratio and firing an action is a keeper bot, and it is derivative of a
product it does not control.

Where RouteLock wins: **depth and measurability of the AI.** Classification
against the full nomenclature, refusal when confidence is insufficient, and a
published number measured against 354 real government rulings from two
authorities. Nobody measures a threshold check. Also, RouteLock brings a new
asset class on-chain rather than defending value already there.

Where RouteLock loses: product completeness while components are missing, and
liquidity/ecosystem contribution — an ERC-721 for one specific parcel generates
none.

### The positioning change worth making

Lead with **the compliance oracle**, not the tokenized parcel. Same contracts,
same engine, same benchmark — but framed as infrastructure any cross-border
tokenized-goods protocol can call, rather than an app that ships parcels. It
answers "who is the user" (other protocols), "growth potential" (every
cross-border RWA) and "ecosystem contribution" (composable infrastructure), which
are the three criteria the current framing scores worst on. `ActivationRegistry`
already records verdicts on-chain; making them explicitly queryable by
third-party contracts is a small change with a large positioning payoff.

### Why `ClassShares` is last, not dropped

The owner has decided it gets built, and a testnet redeploy is genuinely cheap
(~0.00014 OKB), so "already deployed" was never a real argument against it. The
argument is opportunity cost only. The design insight behind it is sound and is
the project's own: entitlements are **interchangeable within a class until
consignment data binds them** — which is the definition of fungible — so a
fungible per-class token over unbound entitlements is economically honest rather
than a gimmick. Build it as an **additive wrapper** holding `Available`
entitlements and issuing shares, so the five deployed contracts and their 159
tests are untouched and the work is droppable if time runs short.

---

## 7. X Layer — what is left, and none of it is code

**Both deployment requirements are met.** Testnet 13 August, mainnet 17 August,
broadcast records for both under `packages/contracts/broadcast/Deploy.s.sol/`.
Mainnet is not a bare deploy: entitlement 1 is `Activated` with a real credit
retired against it and the escrow settled back to zero.

X Layer's stated conditions, from their own post:

| Condition | State |
|---|---|
| Build AI into the product | done — the compliance engine rules on every activation |
| Deploy on X Layer testnet, then launch on mainnet | **done, both** |
| Maintain a dedicated X account, active | ⛔ **NOT DONE** |
| Submission post mentioning **@XLayerOfficial** | ⛔ **NOT DONE** |

⛔ **The X account is the only thing standing between this build and a valid
submission.** It is a hard eligibility gate: failing it disqualifies regardless
of build quality, and no amount of further engineering substitutes for it.
Deadline 21 August 23:59 UTC.

---

## 8. BOT Chain runbook

Deadline **22 August 23:59 UTC+8**. BOT testnet 968 is deployed and verified;
the remaining chain work is an approved 968 e2e run, followed by mainnet 677. The contracts are
chain-agnostic and already carry BOT Chain's verified settlement token, so this
is a deploy-and-run job rather than a build.

### 8.1 Funding and current balances, measured 2026-08-18

| Address | tBOT (968) | tUSDT (968) | BOT (677) |
|---|---|---|---|
| deployer `0x69eb1bAA…54f6` | **9.33758978** | **0.3** | 0 |
| compliance `0xA30D8311…922a` | **9.99621108** | **999.7** | 0 |
| oracle `0x25CE5281…151e` | **0.49809922** | 0 | 0 |

✅ **Funding is complete for the BOT e2e run.**

The tUSDT transfer was sent from the compliance key to the deployer in block
**20275741**:
`0xd7f03ff5aecfda17ca7c2a418896529406d2bb7300f591250849d86a0ac77bb3`.
The tBOT transfer was sent from the deployer to the separate oracle in block
**20276020**:
`0x922c80288b2951c23fb957ed5b35cab97a02d6c6826a514771e49fca1a24560e`.

### 8.2 Gas is 1000× X Layer — do not reuse the OKB intuitions

BOT gas price is **20 gwei**; X Layer is 0.02 gwei. Same 7,178,141-gas deploy:

| | X Layer | BOT Chain |
|---|---|---|
| full deploy | 0.000144 OKB | **0.1436 BOT** |
| e2e oracle calls, per run | 0.000012 | **0.0117 BOT** |
| one `recordDecision` | 0.000003 | **0.00275 BOT** |

The deployer's 9.33758978 tBOT covers roughly 60 testnet deploys, so testnet is
comfortable. **Mainnet holds zero on all three keys.**

### 8.3 Order of work

1. **968 is deployed and verified.** The addresses are in
   `deployments/botchain_testnet.json`; the broadcast record is under
   `packages/contracts/broadcast/Deploy.s.sol/968/`. Commit both records.
2. **Verify the role graph from the chain**, not from the script's assertions —
   the same checks §2 records for 196: `ORACLE_ROLE` on the oracle and *not* the
   admin, compliance holding nothing on the escrow, and
   `escrow.grantRole(COMPLIANCE_ROLE, …)` reverting `0xa3dd6e91`
   (`ComplianceRoleForbiddenHere()`).
3. **Rerun e2e on 968** for an approved path. Funding and recovery are complete;
   the deployer holds the restored 0.3 tUSDT. Use
   `ROUTELOCK_CHAIN=botchain_testnet`, scaled to the balance:
   ```
   export ROUTELOCK_CLASS_LABEL="carbon-retirement-0.001t-$(date +%s)"
   ROUTELOCK_CHAIN=botchain_testnet ROUTELOCK_PRICE=0.1 \
     ROUTELOCK_COLLATERAL=0.2 ROUTELOCK_PAYOUT=0.1 \
     pnpm --filter @routelock/attest e2e --broadcast --retire
   ```
   ⛔ **`--retire` burns a real credit paid in USDC on Base, whatever chain the
   entitlement is on.** The retirement is not on BOT Chain; only the obligation
   is. Budget ~0.028 USDC per run against the deployer's Base balance, and note
   `assertKeylessSpendAllowed` **requires an explicit opt-in on a test chain** —
   `--retire` sets it. Running without `--retire` proves everything up to the
   signature and burns nothing, which is the right first attempt.
4. **Mainnet 677**, once gas support lands. `ADMIN != ORACLE` is enforced there,
   so the oracle needs its own BOT for gas.
5. **Apply for BOT Chain mainnet gas support and file the project submission
   form**, then submit with the X account post tagging BOT Chain as their rules
   require.

### 8.4 What will not work, and why

- **`AkashAdapter` is still not built.** It is the third vertical and it is
  absent, not partial. If BOT Chain needs a differentiated story, the honest one
  is the same carbon adapter on a second chain, not a compute adapter that does
  not exist.
- **The x402 retirement path is chain-agnostic and unaffected by BOT Chain** —
  it settles on Base. Nothing about the carbon adapter needs porting.
- **Aave has no BOT Chain deployment**, so `yieldVenue` is `none` on both 968 and
  677 and `verify:chains` says so on every run.
