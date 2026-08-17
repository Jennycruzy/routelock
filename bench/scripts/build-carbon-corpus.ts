/// Builds the carbon quality corpus — step 4 of `docs/carbon-benchmark-design.md`.
///
/// One row per purchasable project whose methodology carries an ICVCM
/// determination. Every field is a live response: the project metadata from
/// Carbonmark's `/carbonProjects`, the vintages and liquidity from `/prices`,
/// and the label from the ICVCM table built in step 1.
///
/// ⛔ **Read §9 of the design before using anything scored from this file.** The
/// corpus is Carbonmark's REST catalogue, not the six-class Klima x402 inventory
/// the deployed adapter retires from — whose methodology strings are sectoral
/// scopes that join to no ICVCM decision at all. This measures the engine, which
/// is provider-agnostic. It does not describe the live retirement path.
///
///   pnpm --filter @routelock/bench build:carbon-corpus

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECOGNISED_REGISTRIES } from "@routelock/compliance";
import {
  fetchProjects,
  fetchPrices,
  purchasableProjectKeys,
  normaliseMethodologyId,
  type CarbonmarkPrice,
} from "../src/carbonmark.ts";
import type { CarbonCorpusRow, IcvcmLabel } from "../src/carbon-metrics.ts";

const DATA = join(import.meta.dirname, "..", "data");
const OUT = join(DATA, "carbon-corpus.jsonl");

/// Held constant, and not part of the ground truth. The engine refuses on
/// insufficient liquidity before the model is asked, so a request larger than
/// some project's supply would silently drop rows from the corpus for a reason
/// that has nothing to do with methodology quality. The smallest retirement the
/// live adapter has actually performed is 0.001 t, so that is the figure used.
const TONNES_REQUESTED = 0.001;

/// Words that would hand the model its own label. The methodology's *name* is
/// the question and is allowed through; a determination about it is not.
const LEAKS = ["icvcm", "ccp-approved", "ccp approved", "core carbon", "does not meet"];

function assertNoLeak(row: CarbonCorpusRow): void {
  const text = [row.name, row.category, ...row.methodologies].join(" ").toLowerCase();
  for (const leak of LEAKS) {
    if (text.includes(leak)) {
      throw new Error(`${row.carbonClass} states its own label ("${leak}") in its input text`);
    }
  }
}

interface DecisionFile {
  readonly rows: readonly {
    readonly methodology: string;
    readonly methodologyId: string | null;
    readonly versions: string | null;
    readonly decision: string | null;
    readonly decisionDocumentUrl: string | null;
  }[];
}

async function main(): Promise<void> {
  const decisions = JSON.parse(
    readFileSync(join(DATA, "icvcm-decisions.json"), "utf8"),
  ) as DecisionFile;

  // Same lookup rule as the join count: one decision per identifier, and the
  // three version-ambiguous identifiers excluded rather than guessed at.
  const byId = new Map<string, IcvcmLabel[]>();
  for (const row of decisions.rows) {
    if (!row.methodologyId || !row.decision) continue;
    const key = normaliseMethodologyId(row.methodologyId);
    byId.set(key, [
      ...(byId.get(key) ?? []),
      {
        methodologyId: row.methodologyId,
        icvcmMethodology: row.methodology,
        icvcmVersions: row.versions,
        decision: row.decision,
        decisionDocumentUrl: row.decisionDocumentUrl,
      },
    ]);
  }
  const lookup = new Map<string, IcvcmLabel>();
  for (const [key, labels] of byId) {
    const first = labels[0];
    if (!first) continue;
    if (new Set(labels.map((label) => label.decision)).size > 1) continue;
    lookup.set(key, first);
  }

  const prices = await fetchPrices();
  const purchasable = purchasableProjectKeys(prices);

  const byProject = new Map<string, CarbonmarkPrice[]>();
  for (const price of prices) {
    const key = price.listing?.creditId?.projectId ?? price.pool?.creditId?.projectId;
    if (!key) continue;
    byProject.set(key, [...(byProject.get(key) ?? []), price]);
  }
  const vintagesOf = (key: string): number[] => {
    const seen = new Set<number>();
    for (const price of byProject.get(key) ?? []) {
      const vintage =
        (price.listing?.creditId as { vintage?: number } | undefined)?.vintage ??
        (price.pool?.creditId as { vintage?: number } | undefined)?.vintage;
      if (typeof vintage === "number") seen.add(vintage);
    }
    return [...seen].sort((a, b) => a - b);
  };
  const liquidityOf = (key: string): number =>
    (byProject.get(key) ?? []).reduce(
      (total, price) => total + (price.liquidSupply ?? price.supply ?? 0),
      0,
    );

  const thisYear = new Date().getUTCFullYear();
  const rows: CarbonCorpusRow[] = [];

  for (const registry of RECOGNISED_REGISTRIES) {
    for (const project of await fetchProjects(registry)) {
      if (!purchasable.has(project.key)) continue;

      const methodologies = project.methodologies ?? [];
      const labels = methodologies
        .map((methodology) => lookup.get(normaliseMethodologyId(methodology.id)))
        .filter((label): label is IcvcmLabel => label !== undefined);
      const label = labels[0];
      if (!label) continue;

      // A project can carry two methodologies that ICVCM ruled on differently.
      // None do today; if one appears, it is dropped rather than scored against
      // whichever label happened to sort first.
      if (new Set(labels.map((l) => l.decision)).size > 1) continue;

      const vintages = vintagesOf(project.key);
      const oldestVintage = vintages[0] ?? 0;

      const row: CarbonCorpusRow = {
        carbonClass: project.key,
        name: project.name,
        category: methodologies[0]?.category ?? null,
        country: project.country,
        // As the registry writes them: identifier and name together, which is
        // what a provider passing real methodology metadata would supply.
        methodologies: methodologies.map((methodology) =>
          methodology.name ? `${methodology.id} — ${methodology.name}` : methodology.id,
        ),
        registries: [project.registry],
        projectIds: [project.projectID],
        vintages,
        oldestVintage,
        oldestVintageAgeYears: oldestVintage === 0 ? 0 : thisYear - oldestVintage,
        isRegistered: true,
        liquidityTonnes: liquidityOf(project.key),
        insufficientLiquidity: false,
        identityUnknown: false,
        tonnesRequested: TONNES_REQUESTED,
        label,
        sourceUrl: project.url,
      };

      assertNoLeak(row);
      rows.push(row);
    }
  }

  rows.sort((a, b) => a.carbonClass.localeCompare(b.carbonClass));
  writeFileSync(OUT, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const byDecision: Record<string, number> = {};
  for (const row of rows) {
    byDecision[row.label.decision] = (byDecision[row.label.decision] ?? 0) + 1;
  }
  console.log(`${rows.length} rows -> ${OUT}`);
  console.log(`  by ICVCM decision: ${JSON.stringify(byDecision)}`);
  console.log(
    `  distinct determinations: ${new Set(rows.map((row) => row.label.icvcmMethodology)).size}`,
  );
  console.log(`  tonnes requested, held constant: ${TONNES_REQUESTED}`);
}

await main();
