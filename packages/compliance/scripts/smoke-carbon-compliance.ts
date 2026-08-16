/// One real carbon-quality ruling, against a real credit class.
///
/// This is the only script in the repo that spends inference credit, and it
/// spends it once per run: a single call, capped by the budget, with the
/// measured cost printed at the end. Nothing is stubbed — if the endpoint or
/// the model is unavailable this fails, which is the correct result.
///
///   pnpm --filter @routelock/compliance smoke:carbon
///
/// Set ROUTELOCK_MAX_MODEL_CALLS to raise the ceiling deliberately. The
/// default refuses to run a corpus by accident.

import { CarbonmarkX402Adapter, RetirementLedger, capsFromEnv as retirementCaps } from "@routelock/carbon";
import { getChain } from "@routelock/chain";

import { budgetCapsFromEnv, InferenceBudget } from "../src/index.ts";
import { decideCarbon } from "../src/carbon/decide.ts";
import { proposeCarbonQuality } from "../src/carbon/propose.ts";
import { VERDICT_NAMES } from "../src/types.ts";
import type { CarbonQualityRequest } from "../src/carbon/types.ts";

const LEDGER = process.env.ROUTELOCK_INFERENCE_LEDGER ?? "data/inference-calls.jsonl";

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ROUTELOCK_LLM_MODEL;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  if (!model) throw new Error("ROUTELOCK_LLM_MODEL is not set — the model is pinned, not guessed");

  const budget = new InferenceBudget(LEDGER, budgetCapsFromEnv());
  console.log(`model    ${model}`);
  console.log(`budget   ${budget.summary()}`);

  // Real inventory, read live. Discovery and assessment are free.
  const chain = getChain(process.env.ROUTELOCK_CHAIN ?? "xlayer_testnet");
  const adapter = new CarbonmarkX402Adapter(chain, {
    ledger: new RetirementLedger("data/retirements.jsonl", retirementCaps()),
    sign: async () => {
      throw new Error("this script never signs — it rules, it does not retire");
    },
  });

  const classes = await adapter.discover();
  const candidate = classes.find((c) => c.priceUsdcPerTonne !== null && c.name !== null);
  if (candidate === undefined) {
    console.log("\nnothing identifiable in live inventory — nothing to rule on");
    return;
  }

  const tonnes = Number(process.env.ROUTELOCK_SMOKE_TONNES ?? 0.001);
  const facts = await adapter.assess({
    entitlementTokenId: "smoke",
    classId: "0x00",
    carbonClass: candidate.carbonClassId,
    tonnes,
    from: "0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6",
    beneficiaryAddress: "0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6",
    beneficiaryString: "RouteLock smoke run",
    retirementMessage: "assessment only — not retired",
  });

  const request: CarbonQualityRequest = {
    carbonClass: facts.carbonClass,
    name: facts.name,
    category: facts.category,
    country: facts.country,
    methodologies: facts.methodologies,
    registries: facts.registries,
    projectIds: facts.projectIds,
    vintages: facts.vintages,
    oldestVintage: facts.oldestVintage,
    oldestVintageAgeYears: facts.oldestVintageAgeYears,
    isRegistered: facts.isRegistered,
    liquidityTonnes: facts.liquidityTonnes,
    insufficientLiquidity: facts.insufficientLiquidity,
    identityUnknown: facts.identityUnknown,
    tonnesRequested: tonnes,
  };

  console.log(`\nassessing ${request.name} (${request.registries.join(", ") || "no registry"})`);
  console.log(`  vintages ${request.vintages.join(", ")} — oldest ${request.oldestVintageAgeYears}y`);
  console.log(`  liquidity ${request.liquidityTonnes.toFixed(2)}t for ${tonnes}t requested`);

  const before = budget.spentUsd;
  const { proposal, inputTokens, outputTokens } = await proposeCarbonQuality(request, {
    apiKey,
    model,
    budget,
  });

  console.log(`\nproposal (the model's evidence — not a verdict)`);
  console.log(`  methodology   ${proposal.methodologyStrength}`);
  console.log(`  permanence    ${proposal.permanenceRisk} risk`);
  console.log(`  confidence    ${proposal.confidence}`);
  console.log(`  integrity     ${proposal.integrityFlags.join(", ") || "no flags"}`);
  console.log(`  open qs       ${proposal.openQuestions.join(" | ") || "none"}`);
  for (const f of proposal.adverseFindings) console.log(`  finding       ${f}`);
  console.log(`  rationale     ${proposal.rationale}`);

  // The deterministic half. No model runs here.
  const { verdict, ground } = decideCarbon(request, proposal);
  console.log(`\nVERDICT   ${VERDICT_NAMES[verdict]}`);
  console.log(`  ground  ${ground.kind}`);

  const spent = budget.spentUsd - before;
  console.log(`\ncost of this ruling`);
  console.log(`  tokens  ${inputTokens} in, ${outputTokens} out`);
  console.log(`  cost    $${spent.toFixed(5)} (estimated at published list rates)`);
  console.log(`  ledger  ${budget.summary()}`);
  console.log(`\nNothing was retired. No credit was burned.`);
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
