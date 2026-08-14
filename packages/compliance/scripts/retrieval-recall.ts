/// Measure the shortlist before spending anything on the model.
///
/// The grounded classifier can only be as good as its candidate set: if the
/// correct subheading is not in the shortlist, no amount of reading will find
/// it. Recall@k is therefore the ceiling on accuracy, and measuring it costs
/// nothing because retrieval involves no model at all.
///
///   pnpm --filter @routelock/compliance retrieval:recall

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAll, retrieve } from "../src/nomenclature.ts";

interface Row {
  readonly description: string;
  readonly hs6: string;
  readonly jurisdiction: string;
}

const corpusPath = join(
  import.meta.dirname, "..", "..", "..", "bench", "data", "corpus.jsonl",
);
const rows = readFileSync(corpusPath, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Row);

const nomenclature = await loadAll();
process.stdout.write(
  `${nomenclature.length} subheadings, ${rows.length} corpus rows\n\n`,
);

const KS = [1, 5, 10, 20, 40, 60, 100] as const;
const hits = new Map<number, number>(KS.map((k) => [k, 0]));
let noCandidates = 0;

for (const row of rows) {
  const ranked = retrieve(row.description, nomenclature, Math.max(...KS));
  if (ranked.length === 0) noCandidates++;
  for (const k of KS) {
    if (ranked.slice(0, k).some((s) => s.hs6 === row.hs6)) {
      hits.set(k, (hits.get(k) ?? 0) + 1);
    }
  }
}

process.stdout.write("  k     recall\n");
for (const k of KS) {
  const recall = (hits.get(k) ?? 0) / rows.length;
  process.stdout.write(
    `  ${String(k).padStart(3)}   ${(recall * 100).toFixed(1)}%\n`,
  );
}
process.stdout.write(`\n  rows with no candidates at all: ${noCandidates}\n`);
