# RouteLock — Handoff

**Last updated: 14 August 2026**

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

Day 2 of 8. Deadlines: **X Layer Aug 21 23:59 UTC** (submit Aug 19),
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
| X Layer mainnet | 196 (`0xc4`) | `https://rpc.xlayer.tech` | USDT `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` (6 dp) |
| BOT Chain testnet | 968 (`0x3c8`) | `https://rpc.bohr.life` | USDT `0x75edC9335175Fc0552D51D48439F229c10420fe3` (6 dp) |
| BOT Chain mainnet | 677 (`0x2a5`) | `https://rpc.botchain.ai` | USDT `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C` (6 dp) |

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

Remaining: BOT Chain testnet, then both mainnets.

**BOT Chain testnet is funded and ready to deploy as of 14 August** — the
deployer holds 10 tBOT from one faucet claim, against a ~0.21 tBOT deploy cost
(gas there is 20 gwei, 1,000× X Layer's 0.02), so roughly 47 deploys of
headroom. This is the next action and needs a human only because the keystore
password prompt is interactive.

Deployer balances, checked live 14 August: X Layer testnet **0.3998 OKB**,
X Layer mainnet **0.00045 OKB**, BOT Chain testnet **10 tBOT**, BOT Chain
mainnet **0**.

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

### Benchmark corpus — built, unscored

`bench/` holds 258 rows drawn from CBP CROSS binding rulings, 133 HS-6
subheadings across 35 chapters, each citing the ruling it came from. 26 tests.

Building it needed no inference; **scoring it does**, so there are no accuracy
figures in this repository and none may be added until a real model has been run.
The trap that matters is in `bench/README.md`: a ruling states its own answer in
its header and its conclusion, so a careless extraction yields a benchmark that
reports near-perfect accuracy while measuring nothing.

### Not started

Compliance engine, carrier adapter, attestation package, frontend. All are
blocked on credentials — see §4. Nothing in them has been stubbed or scaffolded
with placeholder behaviour; the directories are empty. See `PROGRESS.md` for the
running state.

---

## 3. The guard that prevents accidental spending

`packages/chain/src/chains.ts` implements spec §1.2.5. It throws at process
start, before any route is registered:

| Chain env | Required carrier key | Consequence of mismatch |
|---|---|---|
| testnet | `sb_sandbox…` | a live key on testnet throws — this is how real shipments get bought by accident |
| mainnet | `sb_prod…` | a sandbox key on mainnet throws — a mainnet deploy must never show a sandbox result |

An **absent** key throws too. There is no mock-carrier fallback, deliberately.
An **unrecognised** key prefix throws rather than guessing which environment it
belongs to.

`requireSettlementToken()` throws on an unresolved settlement rather than
returning a zero or placeholder address. All four targets now resolve, so
`verify:chains` passes clean — but keep that refusal path intact. It is what
stops an unverified token address reaching a deployment.

---

## 4. Blocked — needs a human

These cannot be resolved from this box and are listed in the order they block work.

1. **No Shipbubble account or API keys.** Both the sandbox and live keys are
   needed. The sandbox key unblocks ~90% of the carrier adapter — address
   validation and rate quotes are free and do not consume shipment quota. Only
   5 free live shipments exist; the live key should not be used until the
   cancellation endpoint and its refund behaviour are documented.

2. **Ask Shipbubble support, in writing:** is platform / third-party shipment
   creation via their API permitted, and is there a partner tier? A written yes
   is the closest achievable substitute for an issuer agreement and is the
   foundation of the RWA claim (spec §11). Send this today — reply latency is
   the risk, not the asking.

3. **An inference credential for the compliance engine.** There is no LLM API key
   on this box and none in the repo, so `packages/compliance` cannot be started —
   the engine is the one component that cannot be written against anything but a
   real model, and the benchmark depends on it. This blocks the project's stated
   differentiator, and with the chain work finished it is now the single largest
   piece of unbuilt scope.

4. **Dedicated X account** must be created and posting daily from day 1, with the
   submission post mentioning **@XLayerOfficial**. This is a hard eligibility
   gate; failing it disqualifies the submission regardless of build quality.
   Day 1 has already passed without a post.

5. **BOT Chain gas support form** (1 BOT per eligible project) and their project
   submission form — both were to be filed day 1 and have not been.

6. **Mainnet gas, for both mainnets.** Testnet funding is done (see §2). What
   remains is X Layer mainnet, which holds 0.00045 OKB, and BOT Chain mainnet,
   which holds 0. Neither is needed until the mainnet deploys, but X Layer's
   eligibility gate requires mainnet *after* testnet, so this cannot be left to
   the final day.

   Also still open from the original setup: `ADMIN` and `ORACLE` currently share
   one key as a testnet shortcut. **Re-point them before mainnet.** The oracle
   signs unattended from this box, so as configured a box compromise also reaches
   role administration.

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
