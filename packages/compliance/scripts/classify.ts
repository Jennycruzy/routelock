/// Rule on one consignment, against the real model.
///
///   pnpm --filter @routelock/compliance classify \
///     --goods "Bluetooth over-ear headphones, retail packed" \
///     --from NG --to GB --value 25000 --weight 0.4
///
/// Prints the verdict, the ground it rests on, and the hash that would be
/// committed on-chain — together with the exact bytes that were hashed, so the
/// commitment can be checked rather than trusted.

import { ComplianceEngine, configFromEnv } from "../src/engine.ts";
import { VERDICT_NAMES, type ClassificationRequest } from "../src/types.ts";

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const request: ClassificationRequest = {
    description: arg("goods"),
    originCountry: arg("from", "NG").toUpperCase(),
    destinationCountry: arg("to", "GB").toUpperCase(),
    declaredValue: Number(arg("value", "25000")),
    currency: arg("currency", "NGN"),
    weightKg: Number(arg("weight", "0.4")),
  };

  const engine = new ComplianceEngine(configFromEnv());
  const { decision, canonical, hash } = await engine.classify(request);
  const { proposal, ground } = decision;

  const lane =
    `${request.originCountry} → ${request.destinationCountry}` +
    (decision.crossBorder ? "  (cross-border)" : "  (domestic)");

  process.stdout.write(
    `\n${request.description}\n${lane}\n\n` +
      `  verdict     ${VERDICT_NAMES[decision.verdict]}\n` +
      `  hs6         ${proposal.hs6 ?? "—"}\n` +
      `  confidence  ${proposal.confidence}\n` +
      `  ground      ${ground.kind}\n`,
  );

  if (ground.kind === "missing_information") {
    for (const q of ground.questions) process.stdout.write(`              · ${q}\n`);
  }
  if (ground.kind === "carrier_policy") {
    process.stdout.write(`              "${ground.clause}" — ${ground.detail}\n`);
  }
  if (ground.kind === "purpose_flag") {
    process.stdout.write(`              ${ground.flags.join(", ")}\n`);
  }
  if (ground.kind === "low_confidence") {
    process.stdout.write(
      `              ${ground.confidence} < ${ground.threshold} required\n`,
    );
  }

  process.stdout.write(
    `\n  rationale   ${proposal.rationale}\n` +
      `\n  engine      ${decision.engineVersion}\n` +
      `  model       ${decision.model}\n` +
      `  decisionHash ${hash}\n` +
      `\n  canonical bytes (this is what the hash commits to):\n  ${canonical}\n`,
  );
}

await main();
