/// Counts the join between what is purchasable and what ICVCM has ruled on —
/// step 2 of `docs/carbon-benchmark-design.md`.
///
/// The design says this out loud and it is worth repeating at the top of the
/// script that implements it: *if too few listed methodologies carry an ICVCM
/// decision, say so and stop*. This number decides whether §3 is measurable. It
/// is established before any inference is bought, not after.
///
/// The universe is narrower than "everything Carbonmark lists", for two reasons
/// that come from the engine rather than from the marketplace:
///
///   - `deterministicGround` refuses a class whose registry is not in
///     `RECOGNISED_REGISTRIES` **before the model is asked**. A row from an
///     unrecognised registry cannot measure the model, because the model never
///     sees it.
///   - The same function refuses on insufficient liquidity. A project with
///     nothing for sale is refused the same way.
///
/// So the benchmark-eligible universe is: purchasable, on a recognised registry,
/// and carrying a methodology identifier that joins to an ICVCM decision.
///
///   pnpm --filter @routelock/bench count:join

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECOGNISED_REGISTRIES } from "@routelock/compliance";
import {
  fetchProjects,
  fetchPrices,
  purchasableProjectKeys,
  normaliseMethodologyId,
  type CarbonmarkProject,
} from "../src/carbonmark.ts";
import { DOCUMENTED_DECISIONS, type IcvcmDecision } from "../src/icvcm.ts";

const DATA = join(import.meta.dirname, "..", "data");
const DECISIONS = join(DATA, "icvcm-decisions.json");
const OUT = join(DATA, "icvcm-join-count.json");

interface DecisionRow {
  readonly programme: string;
  readonly methodology: string;
  readonly methodologyId: string | null;
  readonly versions: string | null;
  readonly decision: IcvcmDecision | null;
  readonly decisionDocumentUrl: string | null;
}

interface DecisionFile {
  readonly source: { readonly url: string; readonly tableLastUpdated: string | null };
  readonly rows: readonly DecisionRow[];
}

interface JoinedDecision {
  readonly decision: IcvcmDecision;
  readonly documentUrl: string | null;
  readonly icvcmMethodology: string;
  readonly icvcmVersions: string | null;
}

/// Builds the lookup, and refuses the ambiguous cases rather than picking one.
///
/// Three identifiers carry two opposite decisions at different versions —
/// VM0042, VM0044 and VM0051 are each Withdrawn at their earlier version and
/// CCP-Approved at their later one. Carbonmark's project metadata names the
/// methodology but not the version it was issued under, so the join cannot tell
/// which decision applies. Those identifiers are excluded and counted as
/// unjoinable, which is the honest outcome: a coin flip between "approved" and
/// "withdrawn" is not ground truth.
function buildLookup(rows: readonly DecisionRow[]): {
  readonly lookup: ReadonlyMap<string, JoinedDecision>;
  readonly ambiguous: readonly string[];
} {
  const byId = new Map<string, DecisionRow[]>();
  for (const row of rows) {
    if (!row.methodologyId || !row.decision) continue;
    const key = normaliseMethodologyId(row.methodologyId);
    byId.set(key, [...(byId.get(key) ?? []), row]);
  }

  const lookup = new Map<string, JoinedDecision>();
  const ambiguous: string[] = [];
  for (const [key, matches] of byId) {
    const distinct = new Set(matches.map((row) => row.decision));
    if (distinct.size > 1) {
      ambiguous.push(`${key} (${[...distinct].join(" / ")})`);
      continue;
    }
    const first = matches[0];
    if (!first?.decision) continue;
    lookup.set(key, {
      decision: first.decision,
      documentUrl: first.decisionDocumentUrl,
      icvcmMethodology: first.methodology,
      icvcmVersions: first.versions,
    });
  }
  return { lookup, ambiguous: ambiguous.sort() };
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

async function main(): Promise<void> {
  const decisions = JSON.parse(readFileSync(DECISIONS, "utf8")) as DecisionFile;
  const { lookup, ambiguous } = buildLookup(decisions.rows);

  const prices = await fetchPrices();
  const purchasable = purchasableProjectKeys(prices);

  const projects: CarbonmarkProject[] = [];
  for (const registry of RECOGNISED_REGISTRIES) {
    projects.push(...(await fetchProjects(registry)));
  }

  const eligible = projects.filter((project) => purchasable.has(project.key));

  interface Pair {
    readonly projectKey: string;
    readonly projectName: string;
    readonly registry: string;
    readonly country: string | null;
    readonly sourceUrl: string | null;
    readonly methodologyId: string;
    readonly joined: JoinedDecision | null;
  }

  const pairs: Pair[] = [];
  for (const project of eligible) {
    for (const methodology of project.methodologies ?? []) {
      pairs.push({
        projectKey: project.key,
        projectName: project.name,
        registry: project.registry,
        country: project.country,
        sourceUrl: project.url,
        methodologyId: methodology.id,
        joined: lookup.get(normaliseMethodologyId(methodology.id)) ?? null,
      });
    }
  }

  const matched = pairs.filter((pair) => pair.joined !== null);
  const documented = matched.filter((pair) =>
    DOCUMENTED_DECISIONS.includes(pair.joined!.decision),
  );

  // Per §3.1 and §3.2 these two arms are counted separately, because they need
  // different rows: identifying a rejected methodology needs negatives, and
  // measuring false integrity flags needs sound credits.
  const negatives = matched.filter((pair) =>
    ["Does not meet", "Very Unlikely To Meet"].includes(pair.joined!.decision),
  );
  const approved = matched.filter((pair) => pair.joined!.decision === "CCP-Approved");

  // The same join over the whole catalogue, purchasability ignored.
  //
  // Not a second candidate corpus — those rows are refused on liquidity before
  // the model is asked, so they cannot measure it. It is here to answer the one
  // question that follows a thin result: would relaxing the purchasability
  // filter give a thicker one? It would not, and the number says so rather than
  // leaving it to be assumed either way.
  const wholeCatalogue = projects.flatMap((project) =>
    (project.methodologies ?? [])
      .map((methodology) => lookup.get(normaliseMethodologyId(methodology.id)))
      .filter((joined): joined is JoinedDecision => joined !== undefined),
  );

  const report = {
    builtAt: new Date().toISOString(),
    inputs: {
      icvcm: {
        url: decisions.source.url,
        tableLastUpdated: decisions.source.tableLastUpdated,
        decidedMethodologiesWithIdentifier: lookup.size,
        excludedAsVersionAmbiguous: ambiguous,
      },
      carbonmark: {
        registriesRequested: RECOGNISED_REGISTRIES,
        projectsReturned: projects.length,
        priceRows: prices.length,
        purchasableProjectKeys: purchasable.size,
      },
    },
    universe: {
      purchasableOnRecognisedRegistry: eligible.length,
      byRegistry: tally(eligible.map((project) => project.registry)),
      projectMethodologyPairs: pairs.length,
    },
    join: {
      matched: matched.length,
      unmatched: pairs.length - matched.length,
      matchedWithDecisionDocument: documented.length,
      byDecision: tally(matched.map((pair) => pair.joined!.decision)),
      byMethodology: tally(matched.map((pair) => pair.methodologyId)),
      unmatchedMethodologies: tally(
        pairs.filter((pair) => !pair.joined).map((pair) => pair.methodologyId),
      ),
    },
    measurableArms: {
      "3.1 rejected methodology recognised": negatives.length,
      "3.2 false integrity flags on sound credits": approved.length,
      "3.3 disclosure names the finding": documented.length,
      /// The rows above are not independent labels. A methodology carries one
      /// determination however many projects use it, so this is the number of
      /// distinct questions the corpus would actually ask.
      distinctDeterminations: new Set(
        matched.map((pair) => pair.joined!.icvcmMethodology),
      ).size,
    },
    ifPurchasabilityWereIgnored: {
      matched: wholeCatalogue.length,
      byDecision: tally(wholeCatalogue.map((joined) => joined.decision)),
      distinctDeterminations: new Set(
        wholeCatalogue.map((joined) => joined.icvcmMethodology),
      ).size,
    },
    pairs,
  };

  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`purchasable on a recognised registry: ${eligible.length} projects`);
  console.log(`  by registry: ${JSON.stringify(report.universe.byRegistry)}`);
  console.log(`project/methodology pairs: ${pairs.length}`);
  console.log(`  joined to an ICVCM decision: ${matched.length}`);
  console.log(`  of those, carrying a decision document: ${documented.length}`);
  console.log(`  by decision: ${JSON.stringify(report.join.byDecision)}`);
  console.log(`  by methodology: ${JSON.stringify(report.join.byMethodology)}`);
  console.log(`unjoined methodologies: ${JSON.stringify(report.join.unmatchedMethodologies)}`);
  console.log(`version-ambiguous, excluded: ${ambiguous.join(", ") || "none"}`);
  console.log("");
  console.log("measurable rows per arm of §3:");
  for (const [arm, count] of Object.entries(report.measurableArms)) {
    console.log(`  ${arm}: ${count}`);
  }
  console.log(
    `if purchasability were ignored: ${wholeCatalogue.length} rows, ` +
      `${report.ifPurchasabilityWereIgnored.distinctDeterminations} determinations, ` +
      `${JSON.stringify(report.ifPurchasabilityWereIgnored.byDecision)}`,
  );
  console.log(`\n-> ${OUT}`);
}

await main();
