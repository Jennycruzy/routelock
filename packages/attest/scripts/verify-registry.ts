/// Reads the deployed `ActivationRegistry` on X Layer and checks this package
/// can actually talk to it.
///
/// The unit tests stub the chain, which proves the refusals fire but proves
/// nothing about whether `abi.ts` matches the bytecode that is really deployed.
/// A hand-written ABI that is subtly wrong fails here and nowhere else.
///
/// Reads only. Sends no transaction and needs no key.
///
///   pnpm --filter @routelock/attest verify:registry

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import type { Address } from "viem";
import { getChain } from "@routelock/chain";

import { ActivationRegistryClient } from "../src/registry.ts";
import { ENTITLEMENT_STATE_NAMES, SERVICE_ENTITLEMENT_ABI } from "../src/abi.ts";

interface Deployment {
  readonly activationRegistry: Address;
  readonly serviceEntitlement: Address;
  readonly chainId: number;
}

async function main(): Promise<void> {
  const chainKey = process.env.ROUTELOCK_CHAIN ?? "xlayer_testnet";
  const chain = getChain(chainKey);

  const deployment = JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../deployments/${chainKey}.json`, import.meta.url)),
      "utf8",
    ),
  ) as Deployment;

  const rpc = process.env[chain.rpcEnvVar] ?? chain.defaultRpc;
  const publicClient = createPublicClient({ transport: http(rpc) });

  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== deployment.chainId) {
    throw new Error(
      `${rpc} reports chain ${liveChainId} but the deployment file is for ` +
        `${deployment.chainId} — refusing to read the wrong chain`,
    );
  }

  console.log(`chain       ${chain.name} (${liveChainId})`);
  console.log(`registry    ${deployment.activationRegistry}`);
  console.log(`entitlement ${deployment.serviceEntitlement}`);

  const client = new ActivationRegistryClient(publicClient, {
    registry: deployment.activationRegistry,
    entitlement: deployment.serviceEntitlement,
  });

  // The pairing check is private and runs on write. Exercise the same read
  // here so a mismatch is caught by a script that spends nothing.
  const bound = await publicClient.readContract({
    address: deployment.activationRegistry,
    abi: [
      {
        type: "function",
        name: "entitlement",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
      },
    ] as const,
    functionName: "entitlement",
  });
  const paired = bound.toLowerCase() === deployment.serviceEntitlement.toLowerCase();
  console.log(`\npairing     registry.entitlement() -> ${bound}`);
  console.log(`            ${paired ? "MATCHES the deployment file" : "MISMATCH"}`);
  if (!paired) throw new Error("registry is not bound to the deployed entitlement");

  const totalMinted = await publicClient.readContract({
    address: deployment.serviceEntitlement,
    abi: SERVICE_ENTITLEMENT_ABI,
    functionName: "totalMinted",
  });
  console.log(`\ntotalMinted ${totalMinted}`);

  // Token 1 need not exist. Reading an absent activation must return the
  // contract's own empty value, which is what proves "unrecorded" is a real
  // state rather than something this package invents.
  const activation = await client.read(1n);
  console.log(`\nactivation for token 1 (expected empty on a fresh deployment)`);
  console.log(`  parcelHash     ${activation.parcelHash}`);
  console.log(`  documentsHash  ${activation.documentsHash}`);
  console.log(`  decisionHash   ${activation.decisionHash}`);
  console.log(`  carrierRefHash ${activation.carrierRefHash}`);
  console.log(`  carrierRawHash ${activation.carrierRawHash}`);
  console.log(`  engineVersion  ${activation.engineVersion === "" ? "(empty)" : activation.engineVersion}`);
  console.log(`  submittedAt    ${activation.submittedAt}`);
  console.log(`  attempt        ${activation.attempt}`);
  console.log(`  verdict        ${activation.verdict} (None)`);

  if (totalMinted === 0n) {
    console.log(
      `\nNothing has been issued through this deployment yet, which is what ` +
        `the README states. The ABI decodes the real contract correctly.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
