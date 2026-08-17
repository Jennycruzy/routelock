/// Runs the carbon compliance engine over the corpus — step 5 of
/// `docs/carbon-benchmark-design.md`. **Spends real money**, one model call per
/// row, under the same inference budget every other path uses.
///
///   pnpm --filter @routelock/bench score:carbon
///   pnpm --filter @routelock/bench score:carbon --limit 5
///
/// Results are written to `data/results-carbon-<model>.json` with every
/// individual outcome, so the published figures can be recomputed rather than
/// taken on trust.
///
/// ⛔ **Three things that must travel with any figure from this file**, all
/// established before it was run and all recorded in §9 of the design:
///
///   1. The 15 rows rest on **two distinct determinations**, one of which covers
///      13 of them. Results are reported per determination, never as one
///      accuracy over 15.
///   2. **No row is CCP-Approved.** Every scorable credit sits on a methodology
///      ICVCM rejected, so there is no positive control: §3.2 has nothing to
///      measure, and a model that answered "weak" to everything would score full
///      marks on §3.1. Any strength figure has to be read with that stated.
///   3. The corpus is Carbonmark's REST catalogue. The **deployed** x402
///      inventory names sectoral scopes rather than methodologies and joins to
///      no ICVCM decision at all, so nothing here describes the live path.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv } from "@routelock/chain";
import {
  decideCarbon,
  deterministicGround,
  proposeCarbonQuality,
  InferenceBudget,
  ledgerPath,
  budgetCapsFromEnv,
  VERDICT_NAMES,
  CARBON_ENGINE_VERSION,
  type CarbonQualityRequest,
} from "@routelock/compliance";
import {
  scoreStrength,
  scoreDisclosure,
  byDetermination,
  type CarbonCorpusRow,
  type ScoredCarbonRow,
} from "../src/carbon-metrics.ts";

const DATA = join(import.meta.dirname, "..", "data");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  // One parser, anchored at the repo root — the same loader the API and the
  // end-to-end script use, so a run cannot pick up a different environment
  // depending on which directory it was launched from.
  loadDotEnv();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ROUTELOCK_LLM_MODEL;
  if (!apiKey || !model) {
    throw new Error("ANTHROPIC_API_KEY and ROUTELOCK_LLM_MODEL must be set");
  }

  const corpus = readFileSync(join(DATA, "carbon-corpus.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CarbonCorpusRow);

  const limit = Number(arg("limit") ?? corpus.length);
  const rows = corpus.slice(0, limit);

  const budget = new InferenceBudget(
    process.env.ROUTELOCK_INFERENCE_LEDGER ?? "data/inference-calls.jsonl",
    budgetCapsFromEnv(),
  );

  // Refuse before spending anything rather than stopping halfway through with a
  // partial corpus scored and paid for. The HS path learned this the expensive
  // way: a run that cannot afford to finish should not start.
  if (budget.callsRemaining < rows.length) {
    throw new Error(
      `this run needs ${rows.length} calls and the budget has ${budget.callsRemaining} — ` +
        `raise ROUTELOCK_MAX_MODEL_CALLS deliberately, or pass --limit`,
    );
  }

  console.log(`model   ${model}`);
  console.log(`engine  ${CARBON_ENGINE_VERSION}`);
  console.log(`budget  ${budget.summary()}`);
  console.log(`rows    ${rows.length} over ${new Set(rows.map((r) => r.label.icvcmMethodology)).size} determinations\n`);

  const scored: (ScoredCarbonRow & { determination: string })[] = [];
  const skipped: { carbonClass: string; reason: string }[] = [];

  for (const [index, row] of rows.entries()) {
    const request: CarbonQualityRequest = {
      carbonClass: row.carbonClass,
      name: row.name,
      category: row.category,
      country: row.country,
      methodologies: row.methodologies,
      registries: row.registries,
      projectIds: row.projectIds,
      vintages: row.vintages,
      oldestVintage: row.oldestVintage,
      oldestVintageAgeYears: row.oldestVintageAgeYears,
      isRegistered: row.isRegistered,
      liquidityTonnes: row.liquidityTonnes,
      insufficientLiquidity: row.insufficientLiquidity,
      identityUnknown: row.identityUnknown,
      tonnesRequested: row.tonnesRequested,
    };

    // The engine is entitled to settle a case without a model, and a row it
    // settles measures nothing about the model. Recorded as skipped rather than
    // scored with a proposal nobody produced.
    const ground = deterministicGround(request);
    if (ground !== null) {
      skipped.push({ carbonClass: row.carbonClass, reason: ground.kind });
      console.log(`${index + 1}/${rows.length} ${row.carbonClass} — no model call (${ground.kind})`);
      continue;
    }

    const { proposal } = await proposeCarbonQuality(request, { apiKey, model, budget });
    const { verdict } = decideCarbon(request, proposal);

    const outcome = scoreStrength(row.label.decision, proposal.methodologyStrength);
    const disclosure = scoreDisclosure(proposal.adverseFindings);

    scored.push({
      carbonClass: row.carbonClass,
      sourceUrl: row.sourceUrl,
      methodologyId: row.label.methodologyId,
      decision: row.label.decision,
      decisionDocumentUrl: row.label.decisionDocumentUrl,
      strength: proposal.methodologyStrength,
      strengthOutcome: outcome,
      integrityFlags: proposal.integrityFlags,
      confidence: proposal.confidence,
      disclosure,
      adverseFindings: proposal.adverseFindings,
      verdict: VERDICT_NAMES[verdict],
      determination: row.label.icvcmMethodology,
    });

    console.log(
      `${index + 1}/${rows.length} ${row.carbonClass.padEnd(10)} ` +
        `${row.label.decision.padEnd(22)} -> ${proposal.methodologyStrength.padEnd(8)} ` +
        `${outcome.padEnd(9)} conf ${proposal.confidence} ${VERDICT_NAMES[verdict]}` +
        `${disclosure.namesAuthority ? " [cites authority]" : ""}` +
        `${proposal.integrityFlags.length > 0 ? ` [${proposal.integrityFlags.join(",")}]` : ""}`,
    );
  }

  const determinations = byDetermination(scored);
  const approvedRows = scored.filter((row) => row.decision === "CCP-Approved");

  const results = {
    model,
    engineVersion: CARBON_ENGINE_VERSION,
    scoredAt: new Date().toISOString(),
    corpus: {
      rows: scored.length,
      skipped,
      determinations: determinations.length,
      source: "bench/data/carbon-corpus.jsonl",
      groundTruth: "bench/data/icvcm-decisions.json",
    },
    caveats: [
      "Results are per determination. The row count is not the sample size: one determination covers most of the rows.",
      "There is no positive control. Every scorable row sits on a methodology ICVCM rejected, so a model answering 'weak' to everything would score full marks on the strength arm, and §3.2 has nothing to measure at all.",
      "The corpus is Carbonmark's REST catalogue, not the deployed x402 inventory, whose methodology strings join to no ICVCM decision.",
      "methodologyStrength and adverseFindings are disclosure and do not gate a retirement. Only integrityFlags do.",
      "namesAuthority and namesConcern are keyword matches over the findings text, which is published in full alongside so the judgement can be checked.",
    ],
    byDetermination: determinations,
    integrityFlagsOnApprovedMethodology: {
      rows: approvedRows.length,
      flagged: approvedRows.filter((row) => row.integrityFlags.length > 0).length,
    },
    rows: scored,
  };

  const out = join(DATA, `results-carbon-${model}.json`);
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);

  console.log(`\nper determination (rows are not sample size):`);
  for (const d of determinations) {
    console.log(
      `  ${d.determination.slice(0, 52).padEnd(54)} ${d.decision.padEnd(22)} ` +
        `n=${String(d.rows).padStart(2)}  correct ${d.correct}  partial ${d.partial}  ` +
        `wrong ${d.incorrect}  cites authority ${d.namesAuthority}  names a concern ${d.namesConcern}`,
    );
  }
  console.log(
    `\n§3.2, one observation: ${results.integrityFlagsOnApprovedMethodology.flagged} of ` +
      `${results.integrityFlagsOnApprovedMethodology.rows} CCP-Approved rows drew an integrity flag`,
  );
  console.log(`budget  ${budget.summary()}`);
  console.log(`-> ${out}`);
}

await main();
