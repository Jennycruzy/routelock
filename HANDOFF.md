# RouteLock — Handoff

**Last updated: 13 August 2026**

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

Day 1 of 8. Deadlines: **X Layer Aug 21 23:59 UTC** (submit Aug 19),
**BOT Chain Aug 22 23:59 UTC+8** (submit Aug 20).

### Done and verified

- Monorepo scaffolded at `/root/routelock`, pnpm workspaces, git initialised with
  the correct identity.
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

BOT Chain testnet faucet: `https://faucet.botchain.ai/basic` — 10 tBOT per address
per 24h. Testnet explorer `https://scan.bohr.life`, mainnet `https://scan.botchain.ai`.

### Not started

Contracts, compliance engine, carrier adapter, attestation package, frontend,
benchmark. See `PROGRESS.md` for the running state.

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

1. **GitHub push credential is dead.** The only PAT on this box (embedded in
   `/root/adversa`'s remote URL) returns **HTTP 401** — expired or revoked. `gh`
   is not installed. Nothing can be pushed until a fresh credential exists.
   Needed: a PAT with `repo` scope on the `Jennycruzy` account, or an SSH deploy
   key added to it. Also confirm the target repo name (assumed `routelock`) and
   whether it should start private.

2. **No Shipbubble account or API keys.** Both the sandbox and live keys are
   needed. The sandbox key unblocks ~90% of the carrier adapter — address
   validation and rate quotes are free and do not consume shipment quota. Only
   5 free live shipments exist; the live key should not be used until the
   cancellation endpoint and its refund behaviour are documented.

3. **Ask Shipbubble support, in writing:** is platform / third-party shipment
   creation via their API permitted, and is there a partner tier? A written yes
   is the closest achievable substitute for an issuer agreement and is the
   foundation of the RWA claim (spec §11). Send this today — reply latency is
   the risk, not the asking.

4. **Dedicated X account** must be created and posting daily from day 1, with the
   submission post mentioning **@XLayerOfficial**. This is a hard eligibility
   gate; failing it disqualifies the submission regardless of build quality.

5. **BOT Chain gas support form** (1 BOT per eligible project) and their project
   submission form — both to be filed day 1.

6. **Deployer keys and a funded wallet** for each of the four targets. X Layer
   gas is OKB; BOT Chain gas is BOT with testnet tBOT from the faucet above.
   For X Layer testnet, the faucet at `0xf6d088123a3c17e6047ae9338b8cf072ad448907`
   dispenses USD₮0, USDC_TEST and USDG — fund the demo buyer wallet from it.

---

## 5. Commands

```bash
cd /root/routelock

pnpm install
pnpm verify:chains                          # re-check all four chains against live RPC
pnpm --filter @routelock/chain test         # environment-pairing + config tests
pnpm test                                   # everything

git log --format='%an <%ae>' -20            # identity check before any push
```

`pnpm verify:chains` passes clean on all four targets as of 2026-08-13. If it
starts failing, trust it over the config — it is asking the chain, and the config
is only a record of a previous answer.
