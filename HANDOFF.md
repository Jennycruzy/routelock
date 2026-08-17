# RouteLock — Handoff

**Last updated: 17 August 2026** — **the whole system has run end to end for
real.** All nine steps completed: a real carbon credit was retired, and the
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

**Another full e2e run costs 0.3 USD₮0** against the 0.7 remaining, so two more
fit without a faucet claim. Retiring again is neither necessary nor free — one
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

Day 5 of 8. Deadlines: **X Layer Aug 21 23:59 UTC** (submit Aug 19),
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

**All nine steps have now completed on the real chain**, on 17 August, producing
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
2. **Separate `ADMIN` from `ORACLE`** before mainnet — **now enforced in code, so
   this can no longer be forgotten.** `Deploy.s.sol` refuses a mainnet deploy
   (196, 677) where `ROUTELOCK_ADMIN == ROUTELOCK_ORACLE`, as a precondition
   checked *before* `startBroadcast` rather than an assertion discovered after
   the gas is spent. `oracle != compliance` and `admin != compliance` are
   refused on every chain, testnet included. Five tests in `Deploy.t.sol`.

   Testnet 1952 still runs them on one key, deliberately and now explicitly
   permitted — `test_adminMayShareTheOracleKeyOnTestnet` names it as a shortcut
   rather than leaving it as an accident.

   **What is still open, and it needs a human:** the mainnet deploy needs a
   *second* keystore key for the oracle, and `packages/attest/scripts/e2e.ts`
   signs as issuer, buyer, admin **and** oracle from one unlocked account
   (`e2e.ts:307`). Splitting the roles for real means a second keystore entry, a
   second interactive password prompt, and moving every `ORACLE_ROLE` call
   (`recordLabel`, `recordPickup`, `recordDelivery`, `recordCarrier`,
   `releaseToIssuer`, `refundBuyer`, `mintReceipt`) onto the oracle wallet.
   Nothing on chain has been rotated — the live 1952 deployment is untouched.
3. **X Layer mainnet deploy**, after testnet, sequence provable. **Gas is
   affordable now** — 0.02 gwei, ~0.000144 OKB against 0.000450 held. What is
   missing is **USDT on mainnet** (0, so no real issuance) and **OKB on the
   compliance key** (0, so no `recordDecision`). A mainnet deploy with no issuance
   satisfies the eligibility sequence but proves less than the testnet run does.
4. **Submit X Layer.** Only then start BOT Chain: testnet deploy (funded, needs a
   human at the keystore prompt), `AkashAdapter`, mainnet, submit.
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
6. **Float `YieldAdapter`** into Aave V3 on X Layer, with a Foundry `invariant_`
   test on the solvency property. Extend `verify:chains` to assert the Aave pool,
   the USD₮0 reserve and the aToken live, before wiring anything.

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

3. **Inference credit**, for the carbon quality benchmark. Not for the parked HS
   rows.

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

6. **Mainnet funding — and this entry was wrong until 17 August.** It listed
   X Layer mainnet gas as blocking. It is not: gas there is **0.02 gwei**
   (20,000,001 wei, read live), the testnet deploy cost 7,178,201 gas ≈ 0.000144
   OKB, and the deployer holds **0.000450 OKB** — about 3× headroom. *The mainnet
   deploy can be broadcast today.*

   What is actually missing, and what each thing blocks:

   | Missing | Blocks |
   |---|---|
   | **USDT on X Layer mainnet** (holds 0) | any real mainnet issuance — collateral and price both settle in it |
   | **OKB on the compliance key on mainnet** (holds 0) | `recordDecision` on mainnet, so the audit trail cannot be written there |
   | **BOT Chain mainnet gas** (holds 0) | the BOT Chain mainnet deploy |

   So a mainnet deployment that satisfies X Layer's testnet-then-mainnet sequence
   is available now, while a mainnet deployment that *demonstrates* anything is
   not. Do not conflate the two in the submission.

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
pnpm test                                   # 326 across the workspace
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
