/// Rule on every class in live inventory, and report what the engine does.
///
/// This is how you find out what the gate actually says *before* standing in
/// front of someone and asking it live. It calls the model once per class that
/// needs one — and skips the call entirely where the deterministic facts
/// already settle the case, which is both cheaper and the honest thing to do.
///
///   pnpm --filter @routelock/compliance rule:inventory
///
/// Costs roughly one cent per class that reaches the model. Bounded by the
/// inference budget either way.

import { CarbonmarkX402Adapter, RetirementLedger, capsFromEnv as retirementCaps } from "@routelock/carbon";
import { getChain } from "@routelock/chain";

import { InferenceBudget } from "../src/carbon/budget.ts";
import { budgetCapsFromEnv } from "../src/index.ts";
import { decideCarbon, deterministicGround, unassessedProposal } from "../src/carbon/decide.ts";
import { proposeCarbonQuality } from "../src/carbon/propose.ts";
import { Verdict, VERDICT_NAMES } from "../src/types.ts";
import type { CarbonProposal, CarbonQualityRequest } from "../src/carbon/types.ts";

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ROUTELOCK_LLM_MODEL;
  if (!apiKey || !model) throw new Error("ANTHROPIC_API_KEY and ROUTELOCK_LLM_MODEL must be set");

  const budget = new InferenceBudget(
    process.env.ROUTELOCK_INFERENCE_LEDGER ?? "data/inference-calls.jsonl",
    budgetCapsFromEnv(),
  );
  console.log(`model   ${model}`);
  console.log(`budget  ${budget.summary()}\n`);

  const chain = getChain(process.env.ROUTELOCK_CHAIN ?? "xlayer_testnet");
  const adapter = new CarbonmarkX402Adapter(chain, {
    ledger: new RetirementLedger("data/retirements.jsonl", retirementCaps()),
    sign: async () => {
      throw new Error("this script rules; it does not retire");
    },
  });

  const tonnes = Number(process.env.ROUTELOCK_SMOKE_TONNES ?? 0.001);
  const classes = await adapter.discover();
  console.log(`${classes.length} classes in live inventory\n`);

  const rows: string[] = [];
  const startSpend = budget.spentUsd;

  for (const c of classes) {
    const label = c.name ?? "(unidentified)";
    const price = c.priceUsdcPerTonne;
    console.log(`${"─".repeat(70)}`);
    console.log(`${label}  ${price === null ? "no price" : `$${price}/t`}`);

    const facts = await adapter.assess({
      entitlementTokenId: "inventory-scan",
      classId: "0x00",
      carbonClass: c.carbonClassId,
      tonnes,
      from: "0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6",
      beneficiaryAddress: "0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6",
      beneficiaryString: "RouteLock inventory scan",
      retirementMessage: "assessment only",
    });

    const request: CarbonQualityRequest = {
      carbonClass: facts.carbonClass, name: facts.name, category: facts.category,
      country: facts.country, methodologies: facts.methodologies, registries: facts.registries,
      projectIds: facts.projectIds, vintages: facts.vintages, oldestVintage: facts.oldestVintage,
      oldestVintageAgeYears: facts.oldestVintageAgeYears, isRegistered: facts.isRegistered,
      liquidityTonnes: facts.liquidityTonnes, insufficientLiquidity: facts.insufficientLiquidity,
      identityUnknown: facts.identityUnknown, tonnesRequested: tonnes,
    };

    console.log(`  registries ${JSON.stringify(request.registries)}  isRegistered ${request.isRegistered}`);

    // Skip the model where the facts already decide. Not an optimisation
    // bolted on afterwards — a decision the engine is entitled to make.
    // ROUTELOCK_FACTS_ONLY inspects the deterministic layer without spending
    // anything, which is how you debug a threshold without paying to.
    const factsOnly = process.env.ROUTELOCK_FACTS_ONLY === "1";
    const shortCircuit = deterministicGround(request);
    let proposal: CarbonProposal;
    let asked = false;

    if (shortCircuit !== null || factsOnly) {
      proposal = unassessedProposal(
        shortCircuit !== null ? `the facts alone settle this (${shortCircuit.kind})` : "facts-only mode",
      );
      if (shortCircuit !== null) console.log(`  no model call — ${shortCircuit.kind} is decided by the facts`);
      else console.log(`  no model call — facts-only mode`);
    } else {
      proposal = (await proposeCarbonQuality(request, { apiKey, model, budget })).proposal;
      asked = true;
      console.log(`  vintages ${request.vintages.join(", ")}`);
      console.log(`  methodology ${proposal.methodologyStrength}, permanence ${proposal.permanenceRisk} risk`);
      console.log(`  confidence  ${proposal.confidence}`);
      if (proposal.integrityFlags.length > 0) console.log(`  flags       ${proposal.integrityFlags.join(", ")}`);
      for (const f of proposal.adverseFindings.slice(0, 2)) console.log(`  finding     ${f.slice(0, 150)}`);
    }

    const { verdict, ground } = decideCarbon(request, proposal);
    // In facts-only mode with no short-circuit, the verdict comes from a
    // proposal nobody made — say so, rather than printing `low_confidence` as
    // though the model rated it low.
    const artefact = factsOnly && shortCircuit === null;
    console.log(
      `  → ${VERDICT_NAMES[verdict]} (${artefact ? "not assessed — facts-only mode" : ground.kind})` +
        `${asked ? "" : "  [free]"}`,
    );

    const all = tonnes * (price ?? 0) + 0.01 + 0.0177;
    rows.push(
      `${VERDICT_NAMES[verdict].padEnd(18)} ${ground.kind.padEnd(22)} ` +
        `${(price === null ? "—" : `$${price.toFixed(3)}/t`).padStart(12)} ` +
        `${verdict === Verdict.Approved ? `~$${all.toFixed(3)} to retire ${tonnes}t` : ""}  ${label}`,
    );
  }

  console.log(`\n${"═".repeat(70)}\nSUMMARY\n${"═".repeat(70)}`);
  for (const r of rows) console.log(r);
  console.log(
    `\ninference for this scan: $${(budget.spentUsd - startSpend).toFixed(4)}   ledger: ${budget.summary()}`,
  );
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
