/// Re-scores the disclosure arm over results already on disk. **Spends nothing.**
///
///   pnpm --filter @routelock/bench rescore:disclosure
///
/// The scoring rules in `../src/carbon-metrics.ts` are pure functions over the
/// findings text, and every result file carries `adverseFindings` verbatim for
/// exactly this reason: a change to how disclosure is measured must never
/// require paying for the model's answers a second time. Re-running the model
/// would also confound the two changes — a new instrument and fresh sampling
/// noise — and leave no way to tell which moved the number.
///
/// It compares two runs of the same corpus and the same model, differing only
/// in the prompt:
///
///   `-uncited`  the 17 August run, before `buildCarbonPrompt` asked for
///               attribution
///   (no suffix) the run after
///
/// ⛔ **What this comparison is not.** n=15, one model, one sampling draw each,
/// no positive control, and `SOURCE_TERMS` was written after reading the outputs
/// — see the block comment on it. Two runs differing in one variable is an
/// observation, not a controlled experiment: nothing here separates the prompt
/// change from ordinary run-to-run variation, because the same prompt was never
/// sampled twice.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scoreDisclosure } from "../src/carbon-metrics.ts";

const DATA = join(import.meta.dirname, "..", "data");

interface ResultsFile {
  readonly model: string;
  readonly rows: readonly {
    readonly carbonClass: string;
    readonly adverseFindings: readonly string[];
  }[];
}

function load(name: string): ResultsFile {
  return JSON.parse(readFileSync(join(DATA, name), "utf8")) as ResultsFile;
}

function summarise(file: ResultsFile) {
  const scores = file.rows.map((row) => scoreDisclosure(row.adverseFindings));
  const findings = scores.reduce((sum, s) => sum + s.findingCount, 0);

  return {
    rows: scores.length,
    findings,
    findingsPerRow: Number((findings / scores.length).toFixed(2)),
    rowsNamingAuthority: scores.filter((s) => s.namesAuthority).length,
    rowsNamingSource: scores.filter((s) => s.namesSource).length,
    rowsNamingConcern: scores.filter((s) => s.namesConcern).length,
    findingsWithSource: scores.reduce((sum, s) => sum + s.findingsWithSource, 0),
  };
}

const before = load("results-carbon-claude-sonnet-5-uncited.json");
const after = load("results-carbon-claude-sonnet-5.json");

const comparison = {
  scoredAt: new Date().toISOString(),
  model: after.model,
  corpus: "bench/data/carbon-corpus.jsonl",
  change: "buildCarbonPrompt requires each adverse finding to name its source",
  caveats: [
    "n=15, one sampling draw per arm. The same prompt was never run twice, so run-to-run variation is not separated from the prompt change.",
    "SOURCE_TERMS was written after reading the outputs. Post-hoc instrument, applied identically to both arms; it describes a change rather than testing a prediction.",
    "namesAuthority is unchanged at 0. The engine cites other bodies, never ICVCM, so the specific defect named in the design's §10 is not fixed.",
    "Vague attributions ('academic studies', 'NGO analyses') are deliberately excluded from namesSource — they name nothing a buyer can open.",
    "Disclosure does not gate a retirement. Only integrityFlags do.",
  ],
  before: summarise(before),
  after: summarise(after),
};

const out = join(DATA, "disclosure-citation-comparison.json");
writeFileSync(out, `${JSON.stringify(comparison, null, 2)}\n`);

const row = (label: string, get: (s: ReturnType<typeof summarise>) => number): string =>
  `  ${label.padEnd(30)} ${String(get(comparison.before)).padStart(6)} -> ${String(get(comparison.after)).padStart(6)}`;

console.log(`disclosure re-score, ${comparison.model}, no model calls\n`);
console.log(row("rows naming ICVCM/CCP", (s) => s.rowsNamingAuthority));
console.log(row("rows naming any source", (s) => s.rowsNamingSource));
console.log(row("rows naming a concern", (s) => s.rowsNamingConcern));
console.log(row("findings total", (s) => s.findings));
console.log(row("findings with a named source", (s) => s.findingsWithSource));
console.log(row("findings per row", (s) => s.findingsPerRow));
console.log(`\n-> ${out}`);
