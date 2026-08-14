/// Run the compliance engine over the corpus and report what it actually does.
///
///   pnpm --filter @routelock/bench score              # every row
///   pnpm --filter @routelock/bench score --limit 40   # a sample
///
/// Every row costs one real model call. Results are written to
/// `data/results-<model>.json` with every individual outcome, so the published
/// figures can be recomputed by anyone rather than taken on trust.
///
/// **Held constant, and not part of the ground truth:** weight and declared
/// value. A customs ruling classifies goods, not consignments, so the corpus
/// carries no shipment facts. Holding them fixed keeps them from varying the
/// result; it does not pretend they are real. The lane is set from the row's own
/// authority — Nigeria to the country whose customs service issued the ruling —
/// so every row is scored as the cross-border decision it would really be.

import { createWriteStream, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ComplianceEngine,
  configFromEnv,
  VERDICT_NAMES,
  ENGINE_VERSION,
} from "@routelock/compliance";
import { computeMetrics, scoreRow, type ScoredRow } from "../src/metrics.ts";
import type { CorpusRow } from "../src/index.ts";

const CONCURRENCY = 4;
const HELD_CONSTANT = { weightKg: 1, declaredValue: 100000, currency: "NGN" };

const DESTINATION: Readonly<Record<string, string>> = { US: "US", UK: "GB" };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function pct(value: number | null): string {
  return value === null ? "  n/a" : `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const dataDir = join(import.meta.dirname, "..", "data");
  const corpus = readFileSync(join(dataDir, "corpus.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as CorpusRow);

  // A sample strides across the corpus rather than taking the front of it.
  // Rows are sorted by authority, so `slice(0, n)` returns one jurisdiction and
  // reports it as if it were the whole benchmark.
  const limit = Number(arg("limit") ?? corpus.length);
  const rows =
    limit >= corpus.length
      ? corpus
      : corpus.filter((_, i) => i % Math.ceil(corpus.length / limit) === 0);

  const grounding = arg("grounding") !== "false";
  const engine = new ComplianceEngine(configFromEnv(), { grounding });

  // Each configuration writes its own file. Overwriting a single results file
  // destroys the baseline a before-and-after comparison needs, and re-earning
  // it costs another full run.
  const suffix = grounding ? "grounded" : "ungrounded";
  const out = join(dataDir, `results-${engine.model}-${suffix}.json`);
  const checkpoint = join(dataDir, `.checkpoint-${engine.model}-${suffix}.jsonl`);

  // Resume from a checkpoint rather than re-paying for rows already scored.
  const alreadyScored = new Map<string, ScoredRow>();
  if (existsSync(checkpoint)) {
    for (const line of readFileSync(checkpoint, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as ScoredRow;
      alreadyScored.set(`${row.jurisdiction}:${row.reference}`, row);
    }
    process.stdout.write(
      `resuming: ${alreadyScored.size} rows already scored in ${checkpoint}\n`,
    );
  }

  const pending = rows.filter(
    (r) => !alreadyScored.has(`${r.jurisdiction}:${r.reference}`),
  );

  process.stdout.write(
    `Scoring ${pending.length} of ${rows.length} rows against ${engine.model}` +
      ` (grounding ${grounding ? "on" : "off"})\n\n`,
  );

  const scored: ScoredRow[] = [...alreadyScored.values()];
  const failures: string[] = [];
  let cursor = 0;
  let done = 0;

  // Append each row as it lands. A crash, a credit exhaustion, or a lost
  // connection then costs only the rows not yet reached.
  const checkpointStream = createWriteStream(checkpoint, { flags: "a" });

  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const row = pending[cursor++];
      if (row === undefined) return;
      try {
        const { decision } = await engine.classify({
          description: row.description,
          originCountry: "NG",
          destinationCountry: DESTINATION[row.jurisdiction] ?? "GB",
          ...HELD_CONSTANT,
        });
        const result = scoreRow(decision, row.hs6, row.reference, row.jurisdiction);
        scored.push(result);
        checkpointStream.write(JSON.stringify(result) + "\n");
      } catch (error) {
        failures.push(`${row.reference}: ${String(error).slice(0, 120)}`);
      }
      done++;
      if (done % 25 === 0) {
        process.stdout.write(
          `  ${done}/${pending.length}  (${failures.length} failed)\n`,
        );
      }
    }
  }

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = Math.round((Date.now() - startedAt) / 1000);

  scored.sort((a, b) => a.reference.localeCompare(b.reference));
  const metrics = computeMetrics(scored);

  process.stdout.write(
    `\ncompleted ${scored.length} rows in ${seconds}s` +
      `${failures.length > 0 ? `, ${failures.length} failed` : ""}\n\n` +
      `  top-1 accuracy (answered)   ${pct(metrics.top1AccuracyAnswered)}  ` +
      `${metrics.answered} rows\n` +
      `  top-1 accuracy (all rows)   ${pct(metrics.top1AccuracyAll)}\n` +
      `  accuracy when APPROVED      ${pct(metrics.approvedAccuracy)}  ` +
      `${metrics.approved} rows\n` +
      `  refusal precision           ${pct(metrics.refusalPrecision)}  ` +
      `${metrics.declinedForUncertainty} declined for uncertainty\n` +
      `  policy refusals             ${metrics.refusedByPolicy} ` +
      `(${metrics.policyRefusalsCorrectlyClassified} classified correctly anyway)\n` +
      `  mean calibration error      ${metrics.calibrationError?.toFixed(3) ?? "n/a"}\n\n`,
  );

  process.stdout.write("  confidence      n   stated   observed\n");
  for (const bin of metrics.calibration) {
    if (bin.count === 0) continue;
    process.stdout.write(
      `  ${bin.lower.toFixed(1)}–${bin.upper.toFixed(1)}  ` +
        `${String(bin.count).padStart(5)}   ` +
        `${pct(bin.meanConfidence)}    ${pct(bin.accuracy)}\n`,
    );
  }

  process.stdout.write("\n  by authority\n");
  for (const [j, v] of Object.entries(metrics.byJurisdiction)) {
    process.stdout.write(`  ${j}  ${String(v.rows).padStart(4)} rows   ${pct(v.accuracy)}\n`);
  }

  const verdicts: Record<string, number> = {};
  for (const r of scored) {
    const name = VERDICT_NAMES[r.verdict];
    verdicts[name] = (verdicts[name] ?? 0) + 1;
  }

  checkpointStream.end();
  writeFileSync(
    out,
    JSON.stringify(
      {
        scoredAt: new Date().toISOString(),
        model: engine.model,
        grounding,
        engineVersion: ENGINE_VERSION,
        heldConstant: HELD_CONSTANT,
        metrics,
        verdicts,
        failures,
        rows: scored,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`\nwritten to ${out}\n`);

  // The checkpoint has served its purpose once the results file is complete.
  // Left behind, it would silently suppress a later re-run of the same config.
  if (failures.length === 0) {
    unlinkSync(checkpoint);
    process.stdout.write("checkpoint cleared — run completed with no failures\n");
  } else {
    process.stdout.write(
      `checkpoint kept at ${checkpoint} — re-run to retry ${failures.length} failed rows\n`,
    );
  }
}

await main();
