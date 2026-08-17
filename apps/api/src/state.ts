/// What the deployment holds right now.
///
/// Every field is a live read. Nothing here is cached, remembered, or copied
/// from the deployment record except the addresses themselves — and even the
/// settlement token's symbol and decimals are read from the token rather than
/// from the file that named it, because the file is what a deploy *wrote* and
/// the chain is what is *true*.

import { ERC20_ABI, FULFILMENT_RECEIPT_ABI } from "./abi.ts";
import { SERVICE_ENTITLEMENT_ABI } from "@routelock/attest";
import type { ChainContext } from "./chain.ts";
import { readRoleGraph } from "./roles.ts";
import type { RoleCheck } from "./roles.ts";

export interface StateReport {
  readonly chain: { readonly key: string; readonly name: string; readonly id: number; readonly env: string };
  readonly block: string;
  readonly readAt: string;
  readonly rpc: string;
  readonly explorer: string;
  readonly deployedAtBlock: number;
  readonly deployedAt: string;
  readonly contracts: readonly {
    readonly name: string;
    readonly address: string;
    readonly bytecodeBytes: number;
  }[];
  readonly settlement: {
    readonly address: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly escrowHolds: string;
  };
  readonly totals: { readonly minted: string; readonly receipts: string };
  readonly roles: {
    readonly allHold: boolean;
    readonly positive: number;
    readonly negative: number;
    readonly checks: readonly RoleCheck[];
  };
}

export async function readState(context: ChainContext): Promise<StateReport> {
  const d = context.deployment;
  const client = context.client;

  const named = [
    { name: "ServiceEntitlement", address: d.serviceEntitlement },
    { name: "SettlementEscrow", address: d.settlementEscrow },
    { name: "EntitlementFactory", address: d.entitlementFactory },
    { name: "ActivationRegistry", address: d.activationRegistry },
    { name: "FulfilmentReceipt", address: d.fulfilmentReceipt },
  ] as const;

  const [block, contracts, symbol, decimals, escrowHolds, minted, receipts, roles] =
    await Promise.all([
      client.getBlockNumber(),
      // Bytecode length, because "the address is in a JSON file" is not evidence
      // that anything was deployed there. A codeless address reads as 0 here.
      Promise.all(
        named.map(async (c) => ({
          name: c.name,
          address: c.address,
          bytecodeBytes: ((await client.getCode({ address: c.address })) ?? "0x").slice(2).length / 2,
        })),
      ),
      client.readContract({ address: d.settlementToken, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address: d.settlementToken, abi: ERC20_ABI, functionName: "decimals" }),
      client.readContract({
        address: d.settlementToken, abi: ERC20_ABI, functionName: "balanceOf", args: [d.settlementEscrow],
      }),
      client.readContract({
        address: d.serviceEntitlement, abi: SERVICE_ENTITLEMENT_ABI, functionName: "totalMinted",
      }),
      client.readContract({
        address: d.fulfilmentReceipt, abi: FULFILMENT_RECEIPT_ABI, functionName: "totalReceipts",
      }),
      readRoleGraph(context),
    ]);

  return {
    chain: { key: d.chain, name: context.chain.name, id: d.chainId, env: context.chain.env },
    block: block.toString(),
    readAt: new Date().toISOString(),
    rpc: context.rpc,
    explorer: context.chain.explorer,
    deployedAtBlock: d.deployedAtBlock,
    deployedAt: new Date(d.deployedAt * 1000).toISOString(),
    contracts,
    settlement: {
      address: d.settlementToken,
      symbol,
      decimals,
      escrowHolds: formatUnits(escrowHolds, decimals),
    },
    totals: { minted: minted.toString(), receipts: receipts.toString() },
    roles: {
      allHold: roles.every((r) => r.holds),
      positive: roles.filter((r) => r.expected).length,
      negative: roles.filter((r) => !r.expected).length,
      checks: roles,
    },
  };
}

/// Enough of `formatUnits` for a display string, without pulling the whole
/// helper in for one call. Kept exact: the value is money.
function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
