/// Builds the ICVCM decision table — step 1 of `docs/carbon-benchmark-design.md`.
///
/// One row per methodology as ICVCM publishes it: category, programme,
/// methodology and version, decision, and the URL of the document the decision
/// was published in. Nothing is summarised, ranked or reworded here. The point
/// of the file is that a reader can open any row's URL and see the same label.
///
/// This costs no inference. It is the input to step 2 — counting how many
/// methodologies that are actually for sale carry an ICVCM decision — which is
/// the number that decides whether the benchmark is measurable at all.
///
///   pnpm --filter @routelock/bench build:icvcm

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchAssessmentStatus,
  parseAssessmentStatus,
  DOCUMENTED_DECISIONS,
  type IcvcmDecision,
  type IcvcmRow,
} from "../src/icvcm.ts";

const OUT = join(import.meta.dirname, "..", "data", "icvcm-decisions.json");

function tally<T extends string>(values: readonly (T | null)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? "(under assessment)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

async function main(): Promise<void> {
  const page = await fetchAssessmentStatus();
  const table = parseAssessmentStatus(page);

  if (table.rows.length === 0) {
    throw new Error("the methodology table parsed to zero rows — not writing it");
  }

  // Sorted so that re-running produces a diff only where ICVCM has changed
  // something, rather than wherever the page reordered itself.
  const rows = [...table.rows].sort(
    (a, b) =>
      a.programme.localeCompare(b.programme) ||
      a.methodology.localeCompare(b.methodology),
  );

  const decided = rows.filter((row): row is IcvcmRow & { decision: IcvcmDecision } =>
    row.decision !== null,
  );
  const documented = decided.filter((row) => row.decisionDocumentUrl !== null);

  // Every decision that is supposed to publish a report must have produced a
  // URL. If one has not, the parse is wrong or the page has changed shape, and
  // writing the file anyway would put an uncitable label into the corpus.
  const missing = decided.filter(
    (row) => DOCUMENTED_DECISIONS.includes(row.decision) && !row.decisionDocumentUrl,
  );
  const firstMissing = missing[0];
  if (firstMissing) {
    throw new Error(
      `${missing.length} documented decision(s) carry no document URL, ` +
        `first: ${firstMissing.programme} / ${firstMissing.methodology}`,
    );
  }

  const file = {
    source: {
      url: table.sourceUrl,
      authority:
        "Integrity Council for the Voluntary Carbon Market — Core Carbon Principles assessment status",
      tableLastUpdated: table.tableLastUpdated,
      fetchedAt: new Date().toISOString(),
    },
    /// Stated rather than left to be inferred from a missing field: ICVCM
    /// publishes one date for the whole table and none per row. The decision
    /// documents are dated inside the PDFs; this file does not claim a date it
    /// has not read.
    decisionDates: "not published per row; see tableLastUpdated and each decisionDocumentUrl",
    counts: {
      rows: rows.length,
      decided: decided.length,
      underAssessment: rows.length - decided.length,
      withDecisionDocument: documented.length,
      withMethodologyId: rows.filter((row) => row.methodologyId !== null).length,
      byDecision: tally(rows.map((row) => row.decision)),
      byProgramme: tally(rows.map((row) => row.programme)),
    },
    rows,
  };

  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);

  console.log(`${rows.length} methodology rows -> ${OUT}`);
  console.log(`  table last updated: ${table.tableLastUpdated}`);
  console.log(`  decided: ${decided.length}, of which documented: ${documented.length}`);
  console.log(`  under assessment: ${rows.length - decided.length}`);
  console.log(`  carry a joinable identifier: ${file.counts.withMethodologyId}`);
  for (const [decision, count] of Object.entries(file.counts.byDecision)) {
    console.log(`    ${decision}: ${count}`);
  }
}

await main();
