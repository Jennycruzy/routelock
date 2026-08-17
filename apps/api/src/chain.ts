/// The API's view of the chain: read-only, and structurally so.
///
/// **This process holds no key and constructs no wallet.** Every value it
/// serves comes from `eth_call` or `eth_getLogs` against a real deployment, and
/// every state change in RouteLock is made by an operator at a terminal, never
/// by an HTTP request. A judge driving the frontend is reading a chain, not
/// asking a server to sign for them.
///
/// That is not a convention to be remembered — `no-signing.test.ts` reads this
/// package's own source and fails if a signing import appears anywhere in it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPublicClient, http } from "viem";
import type { Address, PublicClient } from "viem";
import { getChain, repoRoot } from "@routelock/chain";
import type { ChainConfig } from "@routelock/chain";

/// The address file a broadcast deploy wrote. Not a config file a human edits:
/// its provenance is `forge script --broadcast`, which is what makes it
/// evidence rather than an assertion.
export interface Deployment {
  readonly chain: string;
  readonly chainId: number;
  readonly activationRegistry: Address;
  readonly entitlementFactory: Address;
  readonly serviceEntitlement: Address;
  readonly settlementEscrow: Address;
  readonly fulfilmentReceipt: Address;
  readonly settlementToken: Address;
  readonly settlementSymbol: string;
  readonly admin: Address;
  readonly oracle: Address;
  readonly compliance: Address;
  readonly deployedAt: number;
  readonly deployedAtBlock: number;
}

export interface ChainContext {
  readonly chain: ChainConfig;
  readonly deployment: Deployment;
  readonly client: PublicClient;
  readonly rpc: string;
}

export function loadChainContext(chainKey: string): ChainContext {
  const chain = getChain(chainKey);
  const path = resolve(repoRoot(), "deployments", `${chainKey}.json`);

  let deployment: Deployment;
  try {
    deployment = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  } catch {
    throw new Error(
      `no deployment record at ${path}. The API serves a deployed system or it ` +
        `does not start — there is no placeholder mode, because a page showing ` +
        `addresses nobody deployed is the exact failure this project treats as ` +
        `disqualifying.`,
    );
  }

  const rpc = process.env[chain.rpcEnvVar] ?? chain.defaultRpc;
  const viemChain = {
    id: deployment.chainId,
    name: chain.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  } as const;

  return {
    chain,
    deployment,
    rpc,
    client: createPublicClient({ chain: viemChain, transport: http(rpc) }),
  };
}

/// Confirm at startup that the RPC really is the chain the deployment claims.
///
/// Cheap, and it catches the failure mode that produces a confident wrong
/// answer: an RPC pointed at another network answers every read with plausible
/// zeros rather than an error.
export async function assertChainMatches(context: ChainContext): Promise<void> {
  const live = await context.client.getChainId();
  if (live !== context.deployment.chainId) {
    throw new Error(
      `${context.rpc} is chain ${live}, but the deployment record is for ` +
        `${context.deployment.chainId}. Refusing to serve reads from the wrong ` +
        `network — they would look exactly like real ones.`,
    );
  }
}
