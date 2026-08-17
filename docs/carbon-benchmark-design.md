# Carbon quality benchmark — design, and what it can honestly measure

**Status: design only. Nothing has been measured. No inference has been spent, and
there are no accuracy numbers in this document or anywhere in the repo.** Written
17 August 2026, from reading the engine's own source and verifying every data
source live.

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

**The prompt leaks nothing.** `buildCarbonPrompt` passes only name, category,
country, registries, project ids, vintages, oldest vintage and age, liquidity and
tonnage. No named methodologies, no quality hints, no list of weak categories. So
a methodology-quality benchmark is **not** circular — the model is not being told
the answer it is scored on. This was checked before anything else, because if it
had failed, nothing else in this document would be worth building.

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

1. **Build the ICVCM decision table** from `icvcm.org/assessment-status`, one row
   per methodology: identifier, programme, decision, decision date, and the URL of
   the decision document. No interpretation, no summarising.
2. **Count the join** between listed methodologies and that table. If too few
   listed methodologies carry an ICVCM decision, say so and stop — that number
   decides whether §3 is measurable at all.
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
