# HS classification benchmark

A corpus for measuring the compliance engine, rather than asserting that it
works. Every competitor will claim their model classifies goods correctly;
almost none will publish a number, a method, and a way to check it.

**Status: scored, twice.** The engine was measured in two configurations over
the same corpus, and both results are published with every individual outcome so
they can be recomputed rather than trusted:
[`data/results-claude-sonnet-5-ungrounded.json`](data/results-claude-sonnet-5-ungrounded.json)
and [`data/results-claude-sonnet-5-grounded.json`](data/results-claude-sonnet-5-grounded.json).

## Results — `claude-sonnet-5`

Compared on the **253 rows both configurations scored**:

| | Ungrounded | Grounded |
|---|---|---|
| Top-1 accuracy | 36.8% | **47.4%** |
| Accuracy of what it **approved** | 79% | **89%** |
| Approvals issued | 14 | 19 |

Grounding **fixed 40 rows and broke 13** — a net gain of 27, not a strict
improvement. It is reported that way because the regressions are real: reading
the published text sometimes talks the engine out of an answer it had right.

**Top-1 accuracy of 47% is the honest headline, and it is low.** Every row is a
case an importer paid to have ruled on precisely because the answer was not
obvious, so this is far harder than an average parcel. It is reported first
anyway, because a benchmark that leads with its flattering figure is marketing.

### The calibration curve is the result that matters

| Stated confidence | Observed — ungrounded | Observed — grounded |
|---|---|---|
| 0.4–0.5 | 21.3% | 20.0% |
| 0.5–0.6 | 27.6% | 27.1% |
| 0.6–0.7 | 39.0% | 44.0% |
| 0.7–0.8 | 48.3% | 43.9% |
| 0.8–0.9 | 70.8% | **80.6%** |
| 0.9–1.0 | 83.3% | **92.6%** |

Ungrounded, the engine was **overconfident by fifteen to twenty-five points at
every level**. Grounded, it is close to calibrated where it counts: at 0.9–1.0 it
states 92.0% and delivers **92.6%**.

**What that says about the threshold — the point of measuring.** The engine
approves at 0.85 domestic and 0.9 cross-border. Before grounding, no cut point
gave both safety and throughput: even the top bin topped out at 83%, so roughly
one approval in six was a misclassification. After grounding, ≥0.9 yields 92.6%
correct — about one in twelve.

So the measurement now says **leave `CROSS_BORDER_CONFIDENCE_THRESHOLD` at 0.9**.
The earlier reading of the ungrounded curve said raise it; that recommendation
does not survive the new data. Any change to a threshold changes
`ENGINE_VERSION`, because a decision is only reproducible if the rule that
produced it is pinned.

### What grounding is

The first pass classifies from memory. Measured against these rulings it names
the correct **chapter** 80.6% of the time and the correct **subheading** only
36.8% — it knows roughly where goods belong and loses precision drilling down. So
a second pass gives it the published heading text for the chapters it named and
asks it to choose by reading rather than by recall.

**The shortlist is the ceiling.** The engine can only pick from the candidates it
is shown, so if the correct subheading is not among them, no amount of careful
reading will find it. That makes the shortlist worth measuring *first* — and
measuring it needs no model calls at all, so it costs nothing.

Two ways of building the shortlist were measured before either was built on:

| How the shortlist is built | How often it contains the right answer |
|---|---|
| Matching words in the description against the tariff text | **22.3%** |
| The chapters the first pass itself named | **80.6%** |

Word-matching is worse than doing nothing — the engine unaided already reaches
36.8%, so a shortlist right only 22.3% of the time would drag it down. Tariff
wording is legalistic and shares little vocabulary with how a shipper describes
goods: "angled flange plated base" against "lamps and lighting fittings, parts
thereof". It was measured and discarded rather than shipped.

Grounding captures roughly a third of the headroom to the 80.6% ceiling. The
remaining loss is the engine picking the wrong subheading *within* the right
chapter.

### Coverage of these runs

Neither run scored all 354 rows — the inference account ran out of credit part
way through each. Failures are recorded in the results files rather than
dropped.

| Run | Rows scored | Not scored |
|---|---|---|
| Ungrounded | 331 | 23 |
| Grounded | 253 | 101 |

The grounded run's 101 unscored rows fall disproportionately on the US half (75
US scored against 178 UK), so the per-authority split — 44.0% US, 48.9% UK — is
directionally sound but rests on fewer US rows than the corpus holds.

Re-running is cheap and resumable: **every row is saved the moment it finishes**,
so a re-run pays only for the rows still missing. A run that dies — an exhausted
account, a dropped connection — costs nothing already paid for. The
"credit balance too low" error is a `400` and is deliberately never retried,
because retrying it cannot succeed and would burn the rest of the run; temporary
errors (429, 529, 5xx) do retry with backoff.

```bash
pnpm --filter @routelock/bench score                     # resumes; scores what is missing
pnpm --filter @routelock/bench score --grounding false   # the ungrounded baseline
pnpm --filter @routelock/bench score --limit 40          # a stratified sample
```

## What is in it

**354 rows from two independent customs authorities** — 176 United States, 178
United Kingdom — covering 185 distinct HS-6 subheadings across 57 chapters.
Each row pairs a description of goods with the subheading an authority assigned
to them:

```json
{
  "description": "The merchandise consists of 5 different cookware sets: ...",
  "hs6": "732394",
  "hs6Formatted": "7323.94",
  "nationalCodes": ["7323.94.0020"],
  "jurisdiction": "US",
  "reference": "810712",
  "rulingDate": "1995-06-01",
  "sourceUrl": "https://rulings.cbp.gov/ruling/810712"
}
```

Data lives in [`data/corpus.jsonl`](data/corpus.jsonl), with build statistics —
including every exclusion and its reason — in
[`data/corpus-stats.json`](data/corpus-stats.json).

## Where the labels come from

Two independent customs authorities, because RouteLock is a cross-border product
whose route is chosen by whoever is shipping. A corpus from one country measures
how well a model reproduces *that country's* reading of the nomenclature; a
corpus from two measures something closer to the nomenclature itself.

| | Source | What a row is |
|---|---|---|
| **US** | [CBP CROSS](https://rulings.cbp.gov) | A binding classification ruling, published as a full letter |
| **UK** | [HMRC ATaR](https://www.tax.service.gov.uk/search-for-advance-tariff-rulings/search) | An Advance Tariff Ruling, published as structured fields |

Both are the same kind of instrument: an importer describes goods, a customs
officer determines the classification, and the decision is published with a
citable reference and is binding on the authority that issued it.

That makes each label an authority's determination rather than an annotator's
opinion, and it makes every row auditable — the `sourceUrl` on each row opens
the ruling it came from. No description or code in this corpus was written by a
person on this project or generated by a model.

**14 subheadings are covered by both authorities**, which is the corpus's own
evidence that the HS-6 label travels across borders rather than being a US
artefact.

Rebuild it with:

```bash
pnpm --filter @routelock/bench build:corpus
```

## National codes to HS

Both authorities classify to a 10-digit national code — the US to an HTS number,
the UK to a commodity code. Each is that country's extension of the international
6-digit **HS** nomenclature: the first six digits *are* the HS subheading and are
valid worldwide; digits 7-10 are national statistical detail.

The corpus truncates to six digits and keeps the full codes in `nationalCodes` so
the truncation is auditable. That truncation is the only transformation applied
to either authority's answer, and it is what makes the two sources directly
comparable.

Rulings landing in **chapters 98 and 99 are excluded**. Those are US-only
provisions — special classification and temporary rate modification — appended to
the HS by the United States and present in no other country's tariff, so they
carry no HS ground truth.

## The cut, and why it is the whole problem

A ruling letter states its own answer twice: in the `TARIFF NO.:` header, and
again in the "The applicable subheading ... will be 4202.92.9026" passage closing
the analysis. Everything between the salutation and that passage is the officer's
description of the goods, and that is the only part a classifier may see.

**A benchmark whose inputs contain their own answers measures nothing, while
reporting near-perfect accuracy.** So extraction refuses anything it cannot
certify: a row is dropped if the text carries a tariff-shaped code in any written
form, the answer's digits with any separator or none, a bare chapter reference,
or tariff vocabulary at all (`subheading`, `HTSUS`, `classifiable`) — the last
because a description of goods has no reason to discuss nomenclature, so its
presence means the cut landed inside the legal analysis.

**99 rulings were dropped for exactly this reason**, out of 162 rejections in
total. The filter is deliberately over-eager: dropping a good row costs one row
out of thousands available, while keeping a contaminated one corrupts the
measurement the corpus exists to produce.

UK rulings need no cut — HMRC publishes the goods description as its own field,
separate from the `Justification` field carrying the legal reasoning. The leak
guard still runs over them, because a description written by a person can still
name a heading, and that would be equally fatal.

One such row survived the first build — it kept "classifiable in Chapter 95 of
the HTSUSA", disclosing the first two digits of its own answer, because the guard
matched `\bHTSUS\b` and a trailing `A` defeats that word boundary. It is now a
test case, along with the answer written as `6205 20` and `6205-20`, which a
plain substring check does not see.

## Honest limitations

- **The ground truth is US and UK practice — not every jurisdiction.** WCO
  members share the HS-6 nomenclature, so the labels are internationally
  meaningful, and the 14 subheadings both authorities independently reached give
  some evidence of that. But where national interpretation diverges, these rows
  reflect how CBP and HMRC read the nomenclature. Neither is Nigeria Customs.
- **The corpus is skewed toward what gets litigated.** Rulings are requested when
  classification is *unclear*, so this is harder than an average parcel and
  accuracy here will understate real-world performance. That is the right
  direction to be wrong in, but it is not a random sample of trade.
- **Sampling differs by source, for reasons outside our control.** CROSS honours
  a search term, so US rows were collected across commodity terms. ATaR accepts
  a `searchTerm` parameter and **ignores it** — "laptop", "banana" and an empty
  string return byte-identical pages — so UK rows are sampled by striding across
  the paged result set instead. Chapter 39 (plastics) is the largest at 34 rows;
  no single subheading exceeds 4% of the corpus.
- **Some rows retain a procedural opening sentence** ("In your letter dated ...
  you requested a tariff classification ruling") where the pattern that strips it
  is defeated by an abbreviation. It is verbatim, carries no answer, and is
  uniform across rows, so it is left rather than risk a regex that eats into the
  description.
- **Descriptions vary in length** from 121 to 3,579 characters, median 697. Long
  rows describe several articles that were classified together.

## How refusal precision is counted

Two kinds of decline exist and they are **never pooled**:

- **Uncertainty** — no classification, low confidence, missing information. The
  engine saying "I might be wrong". This is what refusal precision measures: of
  these, how many would have been errors if approved.
- **Policy** — carrier policy or a purpose flag. Whisky is classified perfectly
  and refused anyway. Counting that as a good call would inflate the figure with
  cases that had nothing to do with uncertainty.

Of 331 rows, 306 were declined for uncertainty and 7 refused on policy — one of
which was correctly classified before being refused, which is the desired
behaviour rather than a failure.

Refusal precision is the figure that matters for RouteLock: a model that refuses
exactly when it would have been wrong is more useful than one that guesses at
higher raw accuracy.

## What is held constant

Weight and declared value are **not part of the ground truth** — a customs ruling
classifies goods, not consignments — so they are held fixed at 1 kg and 100,000
NGN. That keeps them from varying the result; it does not pretend they are real.

The lane is set from each row's own authority: Nigeria to the country whose
customs service issued the ruling. Every row is therefore scored as the
cross-border decision it would really be, at the higher 0.9 confidence bar.

```bash
pnpm --filter @routelock/bench test   # 33 tests: extraction, HS handling, ATaR parsing
```
