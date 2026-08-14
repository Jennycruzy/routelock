/// Exercises the Klima x402 adapter against the real endpoint.
///
/// Everything here is free: `discover`, `quote` and `prepare-auth` cost nothing
/// and move nothing. **It deliberately stops before signing**, because the next
/// call after a signature relays a retirement that permanently burns a credit.
///
/// Nothing in this script is recorded, replayed or stubbed. If the endpoint is
/// down, this fails — which is the correct result, not a reason for a fallback.
///
///   pnpm --filter @routelock/carbon smoke:x402
///
/// Reports the issuer's USDC balance on Base last, because that is the one
/// thing standing between this output and a real retirement.

import { FULFILMENT_CHAINS, getChain } from "@routelock/chain";
import {
  CarbonmarkX402Adapter,
  DEFAULT_CAPS,
  RetirementLedger,
  capsFromEnv,
  idempotencyKey,
} from "../src/index.ts";

const TONNES = Number(process.env.ROUTELOCK_SMOKE_TONNES ?? 0.001);
const ISSUER =
  process.env.ROUTELOCK_ISSUER_ADDRESS ??
  "0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6";

async function main(): Promise<void> {
  const chain = getChain(process.env.ROUTELOCK_CHAIN ?? "xlayer_testnet");
  const base = FULFILMENT_CHAINS.base_mainnet;
  const caps = capsFromEnv();

  const adapter = new CarbonmarkX402Adapter(chain, {
    ledger: new RetirementLedger(
      process.env.ROUTELOCK_RETIREMENT_LEDGER ?? "data/retirements.jsonl",
      caps,
    ),
    // Refuses rather than signs. This script must not be able to spend, even
    // if it is edited carelessly later.
    sign: async () => {
      throw new Error("the smoke run does not sign — it stops before spending");
    },
  });

  console.log(`obligation  ${chain.name} (${chain.env})`);
  console.log(`fulfilment  ${base.name} (${base.chainId})`);
  console.log(`adapter     ${adapter.name} — ${adapter.vertical}, ${adapter.status}`);
  console.log(`live        ${adapter.live}  (no sandbox exists; every retirement is real)`);
  console.log(`can spend   ${adapter.canSpend}`);
  console.log(
    `caps        ${caps.perRetirementUsdc} USDC per retirement, ` +
      `${caps.dailyUsdc} USDC per rolling 24h` +
      (caps.perRetirementUsdc === DEFAULT_CAPS.perRetirementUsdc ? " (defaults)" : ""),
  );

  const classes = await adapter.discover();
  console.log(`\ndiscover    ${classes.length} classes in live inventory`);
  for (const c of classes) {
    const price = c.priceUsdcPerTonne === null ? "no price" : `$${c.priceUsdcPerTonne}/t`;
    const liquidity = c.credits.reduce((sum, x) => sum + x.liquidityTonnes, 0);
    console.log(
      `  ${c.carbonClassId}  ${price.padStart(14)}  ` +
        `${(c.name ?? "(unidentified)").padEnd(34)} ` +
        `${c.credits.length} credits, ${liquidity.toFixed(2)}t`,
    );
    if (c.methodologies.length > 0) {
      console.log(`      methodology: ${c.methodologies.join("; ")}`);
    }
  }

  // The cheapest identified class with enough liquidity. Chosen live rather
  // than hardcoded: inventory moves, and one class in it has no identity at
  // all.
  const candidate = classes
    .filter((c) => c.priceUsdcPerTonne !== null && c.name !== null)
    .filter((c) => c.credits.reduce((s, x) => s + x.liquidityTonnes, 0) >= TONNES)
    .sort((a, b) => (a.priceUsdcPerTonne ?? 0) - (b.priceUsdcPerTonne ?? 0))[0];

  if (candidate === undefined) {
    console.log("\nnothing retirable at this size right now — nothing further to exercise");
    return;
  }

  const order = {
    entitlementTokenId: "smoke",
    classId: "0x00",
    carbonClass: candidate.carbonClassId,
    tonnes: TONNES,
    from: ISSUER,
    beneficiaryAddress: ISSUER,
    beneficiaryString: "RouteLock smoke run",
    retirementMessage: "verification only — not retired",
  };

  const facts = await adapter.assess(order);
  console.log(`\nassess      ${facts.name}`);
  console.log(`  registries       ${facts.registries.join(", ") || "none"}`);
  console.log(`  projects         ${facts.projectIds.slice(0, 6).join(", ") || "none"}`);
  console.log(`  vintages         ${facts.vintages.join(", ") || "none"}`);
  console.log(`  oldest vintage   ${facts.oldestVintage} (${facts.oldestVintageAgeYears}y old)`);
  console.log(`  methodology      ${facts.methodologies.join("; ") || "none stated"}`);
  console.log(`  liquidity        ${facts.liquidityTonnes.toFixed(3)}t`);
  console.log(`  identity known   ${!facts.identityUnknown}`);

  const [quote] = await adapter.quote(order);
  console.log(`\nquote       ${quote?.total} ${quote?.currency} for ${TONNES}t`);

  const prepared = await adapter.client.prepareAuth({
    carbonClass: order.carbonClass,
    tonnes: order.tonnes,
    inputToken: base.inputToken,
    from: order.from,
    beneficiaryAddress: order.beneficiaryAddress,
    beneficiaryString: order.beneficiaryString,
    retirementMessage: order.retirementMessage,
  });

  console.log(`\nprepare-auth`);
  console.log(`  ${prepared.quote.humanSummary}`);
  console.log(`  authorised   ${prepared.authValue} USDC total`);
  console.log(`    retirement ${prepared.quote.retirementPrice}`);
  console.log(`    fee        ${prepared.quote.fee}`);
  console.log(`    relay gas  ${prepared.executorGas}`);
  console.log(`  credit       ${prepared.quote.resolvedCredit.creditToken} ` +
    `vintage ${prepared.quote.resolvedCredit.vintage}`);
  console.log(`  nonce        ${prepared.nonce}`);
  console.log(`  expires      ${new Date(prepared.validBefore * 1000).toISOString()}`);
  console.log(`  key          ${idempotencyKey({ ...order })}`);
  console.log(`  within caps  ${prepared.authValue <= caps.perRetirementUsdc}`);

  // Everything above is free. Signing the payload above is what would spend.
  console.log(`\nSTOPPED before signing. Nothing was retired and nothing was charged.`);

  const balance = await usdcBalance(ISSUER);
  console.log(`\nissuer ${ISSUER}`);
  console.log(`  USDC on Base   ${balance}`);
  console.log(
    balance >= prepared.authValue
      ? `  funded for a retirement of ${TONNES}t`
      : `  NOT FUNDED — needs at least ${prepared.authValue} USDC on Base to retire ${TONNES}t. ` +
          `No ETH is required; the relay pays gas.`,
  );
}

/// Read the balance from Base itself rather than from any endpoint's report of
/// it. `balanceOf(address)` is `0x70a08231`.
async function usdcBalance(address: string): Promise<number> {
  const base = FULFILMENT_CHAINS.base_mainnet;
  const url = process.env[base.rpcEnvVar] ?? base.defaultRpc;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: base.inputToken, data: `0x70a08231${address.replace(/^0x/, "").padStart(64, "0")}` },
        "latest",
      ],
    }),
  });
  const body = (await response.json()) as { result?: string };
  return Number(BigInt(body.result ?? "0x0")) / 10 ** base.inputTokenDecimals;
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
