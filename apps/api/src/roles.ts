/// The role graph, re-checked live.
///
/// `Deploy.s.sol` asserts every one of these immediately after wiring, and
/// reverts the deployment if any disagrees. Serving the same list from a live
/// read turns that one-time assertion into something a stranger can repeat: the
/// claim is not "we checked at deploy time", it is "check it now".
///
/// The negative half is the half that matters. Nine positive grants prove the
/// system is wired; four absences and one refusal prove the compliance engine
/// cannot reach the money.

import type { Address } from "viem";
import { ACCESS_CONTROL_ABI, ROLES } from "./abi.ts";
import type { ChainContext } from "./chain.ts";

export interface RoleCheck {
  /// The name `Deploy.s.sol` uses for this assertion, so a failure here can be
  /// matched against the deploy's own vocabulary.
  readonly what: string;
  readonly contract: string;
  readonly contractAddress: Address;
  readonly role: keyof typeof ROLES;
  readonly account: Address;
  /// What the deployment asserts. `false` means the grant must be absent.
  readonly expected: boolean;
  readonly actual: boolean;
  readonly holds: boolean;
}

export async function readRoleGraph(context: ChainContext): Promise<readonly RoleCheck[]> {
  const d = context.deployment;

  const intended: readonly Omit<RoleCheck, "actual" | "holds">[] = [
    // Positive: the grants the system needs to function.
    { what: "entitlement.factory", contract: "ServiceEntitlement", contractAddress: d.serviceEntitlement, role: "FACTORY_ROLE", account: d.entitlementFactory, expected: true },
    { what: "entitlement.registry", contract: "ServiceEntitlement", contractAddress: d.serviceEntitlement, role: "REGISTRY_ROLE", account: d.activationRegistry, expected: true },
    { what: "entitlement.oracle", contract: "ServiceEntitlement", contractAddress: d.serviceEntitlement, role: "ORACLE_ROLE", account: d.oracle, expected: true },
    { what: "escrow.factory", contract: "SettlementEscrow", contractAddress: d.settlementEscrow, role: "FACTORY_ROLE", account: d.entitlementFactory, expected: true },
    { what: "escrow.oracle", contract: "SettlementEscrow", contractAddress: d.settlementEscrow, role: "ORACLE_ROLE", account: d.oracle, expected: true },
    { what: "registry.compliance", contract: "ActivationRegistry", contractAddress: d.activationRegistry, role: "COMPLIANCE_ROLE", account: d.compliance, expected: true },
    { what: "registry.oracle", contract: "ActivationRegistry", contractAddress: d.activationRegistry, role: "ORACLE_ROLE", account: d.oracle, expected: true },
    { what: "receipt.oracle", contract: "FulfilmentReceipt", contractAddress: d.fulfilmentReceipt, role: "ORACLE_ROLE", account: d.oracle, expected: true },
    { what: "entitlement.admin", contract: "ServiceEntitlement", contractAddress: d.serviceEntitlement, role: "ADMIN_ROLE", account: d.admin, expected: true },
    { what: "escrow.admin", contract: "SettlementEscrow", contractAddress: d.settlementEscrow, role: "ADMIN_ROLE", account: d.admin, expected: true },
    { what: "factory.admin", contract: "EntitlementFactory", contractAddress: d.entitlementFactory, role: "ADMIN_ROLE", account: d.admin, expected: true },
    { what: "registry.admin", contract: "ActivationRegistry", contractAddress: d.activationRegistry, role: "ADMIN_ROLE", account: d.admin, expected: true },
    { what: "receipt.admin", contract: "FulfilmentReceipt", contractAddress: d.fulfilmentReceipt, role: "ADMIN_ROLE", account: d.admin, expected: true },

    // Negative: what the compliance engine must not hold. An empty list here
    // would make the positive list meaningless — every system can show the
    // roles it granted.
    { what: "escrow.compliance.absent", contract: "SettlementEscrow", contractAddress: d.settlementEscrow, role: "COMPLIANCE_ROLE", account: d.compliance, expected: false },
    { what: "escrow.compliance.oracle", contract: "SettlementEscrow", contractAddress: d.settlementEscrow, role: "ORACLE_ROLE", account: d.compliance, expected: false },
    { what: "escrow.compliance.factory", contract: "SettlementEscrow", contractAddress: d.settlementEscrow, role: "FACTORY_ROLE", account: d.compliance, expected: false },
    { what: "entitlement.compliance", contract: "ServiceEntitlement", contractAddress: d.serviceEntitlement, role: "REGISTRY_ROLE", account: d.compliance, expected: false },
  ];

  return Promise.all(
    intended.map(async (check): Promise<RoleCheck> => {
      const actual = await context.client.readContract({
        address: check.contractAddress,
        abi: ACCESS_CONTROL_ABI,
        functionName: "hasRole",
        args: [ROLES[check.role], check.account],
      });
      return { ...check, actual, holds: actual === check.expected };
    }),
  );
}
