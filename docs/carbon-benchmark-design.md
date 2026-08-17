# Carbon quality benchmark — design, and what it can honestly measure

**Status: executed end to end, 17 August 2026.** Ground truth built (§9), the join
counted before anything was bought (§9), and 15 rows scored for 15 model calls
(§10). §3.2 was **stopped by the count** — purchasable inventory holds no
CCP-Approved methodology, so there is nothing to measure a false-positive rate on.
What did come out: the engine never rated a rejected methodology `strong`, and
**never once named the authority behind the finding it disclosed**.

Written 17 August 2026, from reading the engine's own source and verifying every
data source live.

The HS benchmark's standard is the bar this has to clear: every label is a
published determination by an independent authority, every row carries a
`sourceUrl` that opens it, and nothing is annotated by a person on this project or
by a model. See [`bench/README.md`](../bench/README.md).

---

## 1. The stated goal cannot be delivered as written, and here is why

Build spec v2 asks for a carbon benchmark whose **calibration curve derives the
confidence threshold** rather than picking it, mirroring what the HS corpus did
for the 0.9 cross-border bar.

That cannot be done, and the reason is in the engine's own source rather than in
any shortage of data.

`CARBON_CONFIDENCE_THRESHOLD` gates one specific question, stated in both
[`decide.ts`](../packages/compliance/src/carbon/decide.ts) and the prompt:
confidence that the credit **is what it claims to be and carries no integrity
defect** — explicitly *not* that it is a good credit. The prompt goes further and
instructs the model not to lower that number for quality concerns.

A calibration curve needs both outcomes to occur in the corpus. Listed
marketplace inventory has essentially no negative examples of *that* question: a
credit tokenised and offered for sale is, almost without exception, the credit it
says it is. The base rate is close to 1, so a curve over listed inventory would
report near-perfect calibration while measuring nothing — the same failure shape
as a benchmark whose inputs contain their own answers.

Manufacturing negatives would mean writing them here, which the corpus standard
forbids.

**So the deliverable changes: the threshold stays picked and stays labelled as
picked.** `decide.ts` already documents it that way, in detail, and that
documentation should not be quietly upgraded. What the benchmark can do instead is
measure three other things, all decision-relevant and none currently measured by
anybody in this market.

*This is the same error the code has already made once and caught: transplanting
the calibrated 0.9 from HS classification onto a different question produced the
appearance of rigour and a gate that refused every class in live inventory.
Deriving a number from a curve that measures the wrong thing would repeat it.*

---

## 2. What the engine actually decides, read from source

Necessary before choosing what to measure, because two of the model's four
substantive outputs do not affect the verdict at all.

| Model output | Effect on the verdict |
|---|---|
| `integrityFlags` | **Refused**, outright, before confidence is consulted |
| `confidence` | `NeedsInformation` below 0.7 — the last check, not the main one |
| `methodologyStrength` | **None.** Disclosed and hashed on chain |
| `permanenceRisk` | **None.** Disclosed and hashed on chain |
| `adverseFindings` | **None.** Disclosed and hashed on chain |
| `openQuestions` | **None.** Disclosed and hashed on chain |

Plus three checks that need no model at all (`deterministicGround`): unknown
identity, no recognised registry, insufficient liquidity — and a vintage older
than 10 years, which refers rather than refuses.

**The prompt leaks no answer — but it does name the methodology, and this
paragraph said otherwise until 17 August.**

⛔ **Correction.** The original text here claimed `buildCarbonPrompt` passes "no
named methodologies". It does:
[`propose.ts:144`](../packages/compliance/src/carbon/propose.ts) renders
`Methodologies:   …`, and has since the carbon engine was written on 16 August —
a day before this document asserted otherwise. The claim was wrong when written,
not overtaken by a change.

The conclusion survives, for a different reason than the one first given. Naming
the methodology states the **question**, not the answer: the model is told which
methodology the credits were issued under and must supply its own judgement of
that methodology's strength. Nothing in the prompt carries ICVCM's determination,
a quality hint, or a list of weak categories. So the benchmark is still not
circular — but §3.1 measures whether the model **knows what an authority has said
about a methodology it has been named**, which is a knowledge task, and not
whether it can infer the methodology from a project description, which is what
the wrong version of this paragraph implied.

Everything else the prompt passes: name, category, country, registries, project
ids, vintages, oldest vintage and age, liquidity and requested tonnage. No buyer,
no wallet, no price.

---

## 3. What can be measured

### 3.1 Does the model identify a methodology an authority has rejected?

**Measures** `methodologyStrength`, against ICVCM's published CCP determination
for that methodology.

This is disclosure rather than gate, and it is worth measuring anyway: the value
is committed on chain in the evidence set and shown to the buyer, so its accuracy
is a real product property. It also answers a live policy question — whether
`methodologyStrength` *should* be blocking. If the model reliably recognises a
CCP-rejected methodology as weak from registry metadata alone, that option exists.
If it does not, that is equally a finding, and an argument for leaving the gate
where it is.

### 3.2 Does the model raise integrity flags on credits that have none?

**Measures** the false-positive rate of the one check with teeth, on projects
whose methodology is CCP-**Approved** and whose registry record is in good
standing.

This is the costly error direction for a live system: an integrity flag refuses
outright, and a refusal that fires on a sound credit is a purchase blocked for no
reason. The HS benchmark's refusal-precision section is the model to follow.

### 3.3 Does the disclosure name the finding a buyer could look up?

**Measures** whether `adverseFindings` surfaces the ICVCM determination — or the
published controversy behind it — for methodologies where one exists, rather than
returning an empty array.

The schema tells the model these are published on chain and do not block, so
thoroughness costs it nothing. Whether that instruction works is measurable.

---

## 4. Ground truth — verified reachable, 17 August 2026

### ICVCM Core Carbon Principles assessment status

<https://icvcm.org/assessment-status/>

An independent body's published, dated, methodology-level determination, with a
per-decision assessment report or board decision PDF behind each row. Decision
categories: **CCP-Approved**, **Does Not Meet**, **Remedial Action**,
**Withdrawn**, **Very Unlikely To Meet**, **Under Assessment**. 44 methodologies
were CCP-Approved as of that page's last update, across ACR, Gold Standard, Verra
VCS, Climate Action Reserve, Isometric and Puro.earth.

*Read by machine in step 1 rather than by eye, the count is **47** CCP-Approved of
181 rows, and "Under Assessment" is the absence of a decision rather than one of
the categories — see [§9](#9-steps-1-and-2-executed--what-the-count-says). The
paragraph above is left as written, because it is what a reader of the page saw
before the table was parsed.*

Decisions confirmed present, and directly relevant to what is actually listed:

| Methodology | Decision |
|---|---|
| Grid-connected renewable energy, across multiple programmes | **Does Not Meet**, August 2024 |
| Gold Standard cookstoves / CDM AMS-II.G v1-13.1 | **Does Not Meet**, March 2025 |
| VCS VM0047 Afforestation/Reforestation v1.0–1.1 | CCP-Approved, December 2024 |
| ACR Landfill Gas Destruction v1.0–2.0 | CCP-Approved, June 2024 |

**⛔ The distinction that must not be blurred: "Does Not Meet CCP" is not
"withdrawn".** A methodology can fail an ICVCM assessment and remain a valid,
active methodology at its own registry, still issuing credits. The engine's
`withdrawn_methodology` integrity flag means the second thing. Labelling a
CCP-rejected-but-active methodology as `withdrawn_methodology` would mark the
engine **wrong for being right**, and would invent a defect the credit does not
have. Keep the two label axes separate:

- **Axis A — ICVCM CCP determination** → scores `methodologyStrength` and
  `adverseFindings` (§3.1, §3.3). Sourced and ready.
- **Axis B — registry methodology status** (active / withdrawn / deprecated by the
  issuing registry) → the only axis that may score
  `withdrawn_methodology`. **Not yet sourced.** Verra publishes methodology
  status; confirm it is fetchable and citable before writing any row on this axis.

### A second authority, not yet investigated

The HS corpus used two independent authorities deliberately, so the labels
measured the nomenclature rather than one country's reading of it. The carbon
analogue is **CORSIA eligibility** (ICAO's Technical Advisory Body
recommendations, adopted by the ICAO Council) — a separate body assessing
overlapping methodologies for a different purpose. Where ICVCM and CORSIA agree,
the label is much stronger than either alone. Worth one session's investigation
before scoring.

---

## 5. Input data — verified live, keyless, 17 August 2026

Both endpoints answer **200 with no API key**, which matters: the corpus must be
rebuildable by anyone checking it.

### `GET https://api.carbonmark.com/carbonProjects`

Carries everything the engine is shown, including the field ICVCM decisions key
on. Sample row:

```json
{ "key": "VCS-844", "projectID": "844",
  "name": "Madre De Dios Amazon REDD+ Project",
  "methodologies": [{ "id": "VM0007", "category": "Forestry",
                      "name": "REDD+ Methodology Framework (REDD+MF)" }],
  "registry": "VCS", "country": "Peru",
  "url": "https://registry.verra.org/app/projectDetail/VCS/844" }
```

`url` points at the issuing registry's own project page, so **every row gets a
`sourceUrl` that opens a primary record** — the same property that makes the HS
corpus auditable. Supports `registry`, `country`, `category`, `vintage`,
`minSupply`, `offset` and `limit`.

`registry=VCS&limit=250` returns **193 VCS projects, 29 distinct methodologies, 51
with purchasable supply** — enough for the 80–150 row target, concentrated in
exactly the methodologies ICVCM has ruled on:

| Methodology | Projects | What it is |
|---|---|---|
| `ACM0002` | 96 | Grid-connected renewable electricity — **ICVCM: Does Not Meet** |
| `AMS-ID` | 28 | Small-scale grid-connected renewables — same family |
| `AMS-IC` | 11 | Thermal energy for the user — same family |
| `VM0007` | 8 | REDD+ Methodology Framework |
| `AM0029` | 8 | Grid-connected natural gas power |
| `VM0010`, `VM0015`, `VM0009`, `VM0011` | 18 combined | Forestry and REDD |

### `GET https://api.carbonmark.com/prices`

**742 listings** on 17 August (723 on 16 August — it moves). Each carries
`creditId.projectId` (e.g. `VCS-191`), `creditId.vintage`, `supply` and
`liquidSupply`. This is what is actually *purchasable*, and it is the
cross-reference that keeps the corpus about credits a buyer could really choose.

---

## 6. Traps found while verifying, worth not rediscovering

- **⛔ `/carbonProjects` default ordering is not representative of what is for
  sale.** The first 200 rows are **150 JCS, 44 PUR, 6 VCS**, while `/prices` is
  dominated by VCS (578 of 723 on 16 August). Worse, `JCS` is not in
  `RECOGNISED_REGISTRIES`, so every JCS row would be refused by
  `deterministicGround` **before the model is asked** — a corpus built by taking
  the first N would spend nothing on inference and measure nothing either. Sample
  by explicit `registry=` filters, and cross-reference `/prices`.
  *Same shape as the ATaR `searchTerm` trap: an endpoint that answers happily
  while silently returning an unrepresentative slice.*

- **Methodology identifiers live in per-registry namespaces.** VCS projects carry
  CDM and VCS codes (`ACM0002`, `AMS-ID`, `VM0007`); JCS and Puro carry their own
  (`EN-R-002`, `C03000000`). ICVCM's decisions are written against the first kind.
  A join keyed on a bare string will silently miss, so the join has to be built and
  **counted** before it is trusted — how many listed methodologies actually match
  an ICVCM decision is a number to establish before scoring, not after.

- **Read supply live.** One listing moved from 18,993 t to 0.056 t within minutes
  (recorded in [carbonmark-verification.md](./carbonmark-verification.md)), and
  the listing count moved 723 → 742 in a day.

---

## 7. Remaining steps, in order

Everything up to step 4 costs **no inference**. That ordering is deliberate — the
HS benchmark's most useful lesson was that checking whether a measurement is
meaningful takes a minute and costs nothing, and must happen before building what
consumes it.

1. ~~**Build the ICVCM decision table**~~ **Done** — 181 rows in
   `bench/data/icvcm-decisions.json`, rebuilt by `pnpm --filter @routelock/bench
   build:icvcm`. The page publishes no per-row decision date; §9 says what stands
   in its place.
2. ~~**Count the join**~~ **Done, and it stopped one arm.** 40 joined rows over
   five distinct determinations, of which **one** is CCP-Approved — so §3.2 is not
   measurable and §3.1/§3.3 are five questions rather than forty. Numbers and
   verdict in §9; report in `bench/data/icvcm-join-count.json`.
3. **Investigate CORSIA/ICAO TAB** as the second authority, and **Verra
   methodology status** for axis B.
4. **Build the corpus**: real `/carbonProjects` metadata, cross-referenced against
   `/prices` for purchasability, each row carrying its registry `sourceUrl` and its
   authority label. Assert no row's input text names its own label — the HS
   corpus's leak guard, adapted.
5. **Only then score**, against a budget raised deliberately rather than by
   default, and report per-decision-category breakdowns rather than one number.

## 8. What must not appear in the write-up

- Any claim that the 0.7 threshold is measured or calibrated. It is picked, and
  §1 is why it stays picked.
- Any number described as accuracy before step 5 has actually run.
- `methodologyStrength` or `adverseFindings` described as gating a retirement.
  They are disclosure; `decide.ts` step 6 is explicit that this is deliberate.

---

## 9. Steps 1 and 2, executed — what the count says

Run on 17 August 2026. Both are reproducible and cost nothing:

```bash
pnpm --filter @routelock/bench build:icvcm   # step 1 -> bench/data/icvcm-decisions.json
pnpm --filter @routelock/bench count:join    # step 2 -> bench/data/icvcm-join-count.json
```

### Step 1 — the decision table is built

181 methodology rows parsed from the ICVCM assessment-status page, which states
its own date: **table last updated 4th August 2026**.

| | Rows |
|---|---|
| CCP-Approved | 47 |
| Does not meet | 22 |
| Withdrawn | 14 |
| Very Unlikely To Meet | 11 |
| Remedial Action | 2 |
| **Still under assessment** | **85** |

Three things the page turned out to say that the design had not:

- **85 of 181 rows carry no decision at all.** An undecided row is not a
  negative label, and the parser records `null` rather than anything else.
- **Only 71 of the 96 decisions publish a document.** `CCP-Approved`,
  `Does not meet` and `Remedial Action` each link an assessment report.
  `Very Unlikely To Meet` and `Withdrawn` are stated on the page with nothing
  behind them, so those 25 rows cannot clear the corpus standard of "every label
  opens a primary document".
- **There is no per-row decision date.** The page publishes one date for the
  whole table. `icvcm-decisions.json` says so in a field rather than leaving a
  reader to infer a date from a PDF's upload path.

⛔ **`Withdrawn` is withdrawn *from the ICVCM assessment*, by the programme that
submitted the methodology.** It is not registry withdrawal, it carries no
document, and it must never score the engine's `withdrawn_methodology` flag. This
is §4's axis A/B warning, confirmed against the live page.

⛔ **Decisions are version-scoped, and three of them disagree across versions:**
VM0042, VM0044 and VM0051 are each `Withdrawn` at their earlier version and
`CCP-Approved` at their later one. Carbonmark's project metadata names the
methodology but never the version it was issued under, so for those three the
join cannot tell which decision applies. The script excludes them and counts them
as excluded — a coin flip between "approved" and "withdrawn" is not ground truth.

### Step 2 — the join, counted

The universe is narrower than "everything listed", and both narrowings come from
`deterministicGround` rather than from the marketplace: a class on an unrecognised
registry and a class without supply are **both refused before the model is asked**,
so neither can measure the model. Benchmark-eligible therefore means *purchasable
in `/prices`, on a registry in `RECOGNISED_REGISTRIES`*.

⛔ **"Appears in `/prices`" is not "purchasable", and the first version of this
count got that wrong.** On 17 August, **678 of 753** price rows carried
`supply: 0` **and** `liquidSupply: 0` — priced, still published, holding nothing.
Counting them put purchasable projects at 68 when the real figure is 28, and it
filled a corpus with credits that `deterministicGround` then refused on liquidity
before the model was ever asked. Caught by building the corpus and noticing 24 of
39 rows would be skipped, including every non-negative label. The numbers below
are the corrected ones; supply is the test.

| | Count |
|---|---|
| Purchasable on a recognised registry | **18 projects** (all VCS) |
| Joined to an ICVCM decision | **16** pairs, all with a decision document |
| **Distinct determinations behind them** | **2** |

| Decision | Rows | Methodologies |
|---|---|---|
| Does not meet | 16 | `ACM0002` (13), `AMS-I.D.` (3) |
| Very Unlikely To Meet | 0 | — |
| **CCP-Approved** | **0** | — |

### ⛔ The corpus is not the live inventory, and the write-up must say so

Found while wiring step 4, and it is the sharpest limit on anything scored here.

The deployed carbon path is the **Klima x402 adapter**, and `discover` returns
**six classes** whose methodology strings are not methodology identifiers at all:

| Class | `methodologies` as the provider states it |
|---|---|
| Solar PV – Small Scale | `Energy Industries (renewable / non-renewable sources)` |
| Wind Energy – Small Scale | `Energy Industries (renewable / non-renewable sources)` |
| Regen Network – City Forest Credits | `Tree-Preservation-Protocol` |
| Ocean Alkalinity Enhancement | `LM_V1_Storage` |
| Biochar | `C03000000` |
| (unidentified) | none |

**None of them join to any ICVCM decision** — the first is a CDM *sectoral
scope* covering an entire industry rather than a methodology, and the rest are
provider-local names. So on the inventory RouteLock can actually retire from,
§3.1 is unanswerable by construction: the model is never shown a methodology
ICVCM has ruled on.

The corpus is therefore built from **Carbonmark's REST catalogue**, whose
projects are real, purchasable and carry real methodology codes — but which is
the catalogue of the *superseded* adapter, not the live one. That is a genuine
measurement of the engine, because the engine is provider-agnostic and rules on
`CarbonQualityRequest` whatever fills it. It is **not** a measurement of what the
deployed retirement path does today, and no figure from it may be presented as
one.

### The verdict, per arm of §3

**§3.2 — false integrity flags on sound credits — is not measurable. Stop.**
It needs credits whose methodology an authority has approved, and purchasable
inventory contains **none**. This is the outcome step 2 exists to produce, and it
is produced before any inference is bought rather than after.

**⛔ There is no positive control, and that limits §3.1 more than thinness does.**
Every scorable row sits on a methodology ICVCM rejected. A model that answered
`weak` to everything would score full marks. So the strength arm can show that
the engine does *not* call a rejected methodology strong — a real property, since
that is the error a buyer would be misled by — but it cannot show that the engine
discriminates. That distinction is stated wherever the figure appears.

**§3.3 survives intact**, because it needs no control: it asks whether a
disclosure names a finding that demonstrably exists, and every row has one.

**Per determination, never per row.** A methodology carries one determination
however many projects use it. Reporting "accuracy over 16 rows" would state one
judgement thirteen times and call the repetition sample size.

**Relaxing purchasability does not fix it, and the number is in the report rather
than assumed.** Over the whole recognised-registry catalogue — 268 projects — the
join gives 157 rows but still only **9 distinct determinations**, and still only
**3 CCP-Approved projects**. Those rows would also be refused on liquidity before
the model saw them.

**The binding constraint is inventory composition, not ground truth.** ICVCM has
ruled on 96 methodologies; what is tokenised and for sale is overwhelmingly
grid-connected renewable electricity, which ICVCM rejected in August 2024. The
corpus is thin because the market is concentrated, and no amount of additional
authority work changes that. Step 3's second authority (CORSIA/ICAO TAB) would add
determinations for the twelve unjoined methodologies; it cannot add approved
credits that nobody has tokenised.

**What this does not change:** the threshold still stays picked, for the reason in
§1, which is unrelated to any of the above.

---

## 10. Steps 4 and 5, executed — the result

Corpus: `bench/data/carbon-corpus.jsonl`, 15 projects, every one purchasable with
real supply, every one carrying its Verra registry page as `sourceUrl` and its
ICVCM decision document as the label's citation. Scored with `claude-sonnet-5`,
15 model calls, results and every individual outcome in
`bench/data/results-carbon-claude-sonnet-5.json`.

```bash
pnpm --filter @routelock/bench build:carbon-corpus
pnpm --filter @routelock/bench score:carbon     # spends 15 calls
```

| Determination | Decision | n | `strong` | `moderate` | `weak` | Names ICVCM | Names a concern |
|---|---|---|---|---|---|---|---|
| `ACM0002` Grid-connected electricity from renewable sources | Does not meet | 13 | 0 | 13 | 0 | **0** | 13 |
| `AMS-I.D.` Grid connected renewable electricity generation | Does not meet | 2 | 0 | 1 | 1 | **0** | 2 |

### What this says

**The engine never rated a CCP-rejected methodology `strong`** — 14 of 15
`moderate`, 1 `weak`, none `strong`. That is the error direction that would
mislead a buyer, and it did not occur. It is **not** evidence that the engine
discriminates: with no approved methodology in purchasable inventory there is no
positive control, and a constant answer would produce the same table.

**⛔ The disclosure never once named the authority. 0 of 15.** Every row produced
two to four adverse findings, and they are substantive — additionality of
grid-connected hydro under `ACM0002`, vintage age, sector-wide over-crediting.
None of them said *ICVCM*, *CCP*, or *Core Carbon Principles*, so a buyer reading
the on-chain disclosure has a concern they cannot follow to a document. There is
a published, dated determination for the exact methodology named in each of those
findings, and the disclosure does not point at it. **This is the actionable
finding of the whole exercise**: the prompt tells the model these findings are
published on chain and do not block, and it still does not cite the authority
that would make them checkable.

**Verdicts split 7 `APPROVED` / 8 `NEEDS_INFORMATION`** on confidence 0.62–0.82
against the picked 0.7 bar. Reported as observed behaviour, not as evidence the
bar is right — §1 stands.

### What must not be said about this table

- Not "the engine is accurate on carbon". Two determinations, one direction, no
  control.
- Not a false-positive rate for integrity flags. Zero approved rows were
  available to test one on.
- Not a statement about the deployed retirement path. See the live-inventory
  caveat above.
- `namesAuthority` and `namesConcern` are keyword matches. The findings text is
  published in full in the results file precisely so a reader can disagree with
  the scoring rather than take it.
