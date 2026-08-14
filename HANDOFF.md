# RouteLock — Handoff

**Last updated: 14 August 2026** — carrier adapter and compliance engine built,
benchmark scored in two configurations. **Paused mid-run: the Anthropic account
is out of credit and 101 benchmark rows are unscored.** Top up, then see
§2 "RESUME HERE" — one command finishes it.

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

### RESUME HERE — 101 benchmark rows unscored, blocked on credit

The grounded scoring run died at row 253 of 354 because the Anthropic account
ran out of credit. **Top up, then run one command:**

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

### Not started

Attestation package and the frontend. `packages/attest` and `apps/{web,api}` are
empty — nothing in them is stubbed or scaffolded with placeholder behaviour.

### Resume here — in this order

1. **Finish the last 101 benchmark rows** — one command, resumes from the
   checkpoint, needs only a topped-up account. See "RESUME HERE" above.
2. **Frontend a judge can drive from any location.** Own origin, own
   destination, own goods description; see the verdict, the reason, and the
   on-chain record. Two of the seven judging criteria are product completeness
   and user value, and this is how both are won. The owner is explicit that
   **no route may be hardcoded** — Hong Kong and everywhere else stay available.
3. **BOT Chain testnet deploy** — funded, ready, needs a human at the keystore
   prompt. Re-run the `COMPLIANCE_ROLE` revert check afterwards.
4. **Separate `ADMIN` from `ORACLE`** before mainnet — the owner has agreed.
   They share one key today, so a box compromise reaches role administration.
5. **Mainnet deploys**, both chains. Hard eligibility gate for X Layer, which
   requires testnet *before* mainnet.
6. **`ClassShares` wrapper** — a fungible per-class token over unbound
   entitlements. The owner wants this built; see §6 for why it is last.

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

1. **The Shipbubble LIVE key.** The sandbox key is in and working; the live one
   is not. It is what proves a real lane, real coverage and a real price —
   sandbox can prove none of those (see §2). Only 5 free live shipments exist,
   and cancellation is now documented: **scheduled shipments only, before the
   processing date, refund behaviour unconfirmed.** Treat each purchase as
   spent.

2. **Ask Shipbubble support, in writing:** is platform / third-party shipment
   creation via their API permitted, and is there a partner tier? A written yes
   is the closest achievable substitute for an issuer agreement and is the
   foundation of the RWA claim (spec §11). Ask in the same message **which
   countries the live account can actually ship to** — the sandbox cannot answer
   it, and the answer decides which lanes can be demoed.

3. **Dedicated X account** must be created and posting daily from day 1, with the
   submission post mentioning **@XLayerOfficial**. This is a hard eligibility
   gate; failing it disqualifies the submission regardless of build quality.
   Day 1 has already passed without a post.

4. **BOT Chain gas support form** (1 BOT per eligible project) and their project
   submission form — both were to be filed day 1 and have not been.

5. **Mainnet gas, for both mainnets.** Testnet funding is done (see §2). What
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

```bash
pnpm --filter @routelock/carrier smoke      # quote 3 lanes, free, no quota used
pnpm --filter @routelock/compliance classify --goods "…" --from NG --to GB
pnpm --filter @routelock/bench build:corpus # rebuild from both rulings databases
pnpm test                                   # 267 across the workspace
```

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
