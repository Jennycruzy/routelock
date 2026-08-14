/// Exercises the Carbonmark adapter against the real API.
///
/// Everything here is free: credential verification, listing discovery and
/// quoting cost nothing and consume nothing. **It deliberately stops before
/// `fulfil()`**, which retires a credit, spends money, and cannot be undone.
///
///   pnpm --filter @routelock/carbon smoke

import { getChain } from "@routelock/chain";
import { CarbonmarkAdapter } from "../src/index.ts";

const TONNES = 0.01;

async function main(): Promise<void> {
  const chain = getChain(process.env.ROUTELOCK_CHAIN ?? "xlayer_testnet");
  const adapter = new CarbonmarkAdapter(chain, process.env.CARBONMARK_API_KEY);

  console.log(`chain    ${chain.name} (${chain.env})`);
  console.log(`adapter  ${adapter.name} — ${adapter.vertical}, ${adapter.status}`);
  console.log(`live     ${adapter.live}`);

  // Calls /orders, not /prices. /prices is public and answers 200 for a key
  // that does not exist, so it can never confirm a credential.
  await adapter.client.verifyCredentials();
  console.log("\ncredentials verified against /orders");

  const all = await adapter.client.listings();
  const purchasable = await adapter.client.purchasable(TONNES);
  console.log(
    `\nlistings ${all.length} total, ${purchasable.length} purchasable at ${TONNES}t`,
  );

  const cheapest = purchasable[0];
  if (cheapest === undefined) {
    console.log("nothing purchasable right now — nothing further to exercise");
    return;
  }

  console.log(
    `cheapest ${cheapest.credit.projectId || "(pool)"} ` +
      `${cheapest.credit.registry} vintage ${cheapest.credit.vintage || "n/a"} ` +
      `$${cheapest.purchasePrice}/t, liquid ${cheapest.liquidSupply}t`,
  );

  const order = {
    sourceId: cheapest.sourceId,
    tonnes: TONNES,
    beneficiaryName: "RouteLock",
    retirementMessage: "RouteLock adapter smoke test",
  };

  const facts = await adapter.assess(order);
  console.log("\nassess (no model, no judgement):");
  console.log(`  registry          ${facts.registry}`);
  console.log(`  vintage           ${facts.vintage || "n/a"}`);
  console.log(`  vintage age       ${facts.vintageAgeYears} years`);
  console.log(`  liquid supply     ${facts.liquidSupply}t`);
  console.log(`  insufficient      ${facts.insufficientSupply}`);
  console.log(`  registry unknown  ${facts.registryUnknown}`);

  const quotes = await adapter.quote(order);
  const quote = quotes[0];
  console.log(`\nquote    $${quote?.total} for ${TONNES}t (ref ${quote?.ref})`);

  console.log(
    "\nStopping here. fulfil() retires a credit — it spends money and cannot " +
      "be undone, so it is never run from a smoke test.",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
