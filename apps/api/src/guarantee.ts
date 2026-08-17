/// The one claim the whole pitch rests on, probed live.
///
/// `SettlementEscrow._grantRole` reverts on `COMPLIANCE_ROLE`. Not "the role is
/// not granted" — it *cannot* be granted, by any admin, ever. The README invites
/// a reader to check this with `cast call`; this serves the same probe to
/// someone who would rather click than install Foundry.
///
/// Two calls, because one proves nothing:
///
///   1. `grantRole(COMPLIANCE_ROLE, compliance)` **as the escrow's own admin**,
///      which must revert with `ComplianceRoleForbiddenHere()`.
///   2. `grantRole(ORACLE_ROLE, compliance)` from the same caller, which must
///      succeed. Without this control, a revert could just as well mean the
///      caller lacks authority, the address is wrong, or the ABI is malformed.
///
/// Both are `eth_call`. Nothing is sent, nothing is signed, and the second one's
/// success is a simulation — the oracle role is *not* actually granted to the
/// compliance key on chain, which is what check `escrow.compliance.oracle` in
/// the role graph independently confirms.

import { COMPLIANCE_ROLE_FORBIDDEN_SELECTOR, ACCESS_CONTROL_ABI, ROLES } from "./abi.ts";
import type { ChainContext } from "./chain.ts";

export interface GuaranteeProbe {
  readonly what: string;
  readonly call: string;
  readonly caller: string;
  readonly outcome: "reverted" | "succeeded";
  readonly expected: "reverted" | "succeeded";
  readonly holds: boolean;
  /// The revert selector, when there was one. `0xa3dd6e91` is
  /// `ComplianceRoleForbiddenHere()`.
  readonly selector?: string;
  readonly selectorMatches?: boolean;
}

export interface GuaranteeResult {
  readonly holds: boolean;
  readonly escrow: string;
  readonly compliance: string;
  readonly expectedSelector: string;
  readonly probes: readonly GuaranteeProbe[];
  readonly reproduce: readonly string[];
}

async function probe(
  context: ChainContext,
  role: "COMPLIANCE_ROLE" | "ORACLE_ROLE",
  expected: "reverted" | "succeeded",
  what: string,
): Promise<GuaranteeProbe> {
  const d = context.deployment;
  const base = {
    what,
    call: `grantRole(${role}, ${d.compliance})`,
    caller: `${d.admin} (the escrow's own ADMIN_ROLE holder)`,
    expected,
  };

  try {
    await context.client.simulateContract({
      address: d.settlementEscrow,
      abi: ACCESS_CONTROL_ABI,
      functionName: "grantRole",
      args: [ROLES[role], d.compliance],
      account: d.admin,
    });
    return { ...base, outcome: "succeeded", holds: expected === "succeeded" };
  } catch (error) {
    // The selector is dug out of the message rather than matched on a viem
    // error class: the contract's custom error is not in the ABI slice above,
    // so viem surfaces it as raw data. Reporting the four bytes is better than
    // reporting "it reverted" — a revert for the wrong reason is not evidence.
    const message = error instanceof Error ? error.message : String(error);
    const found = /0x[0-9a-f]{8}/i.exec(message)?.[0]?.toLowerCase();
    const selectorMatches = found === COMPLIANCE_ROLE_FORBIDDEN_SELECTOR;

    return {
      ...base,
      outcome: "reverted",
      holds: expected === "reverted" && selectorMatches,
      ...(found === undefined ? {} : { selector: found, selectorMatches }),
    };
  }
}

export async function checkGuarantee(context: ChainContext): Promise<GuaranteeResult> {
  const d = context.deployment;

  const probes = [
    await probe(
      context,
      "COMPLIANCE_ROLE",
      "reverted",
      "the escrow refuses COMPLIANCE_ROLE even to its own admin",
    ),
    await probe(
      context,
      "ORACLE_ROLE",
      "succeeded",
      "control: the same caller can grant a different role, so the revert above is about the role",
    ),
  ];

  return {
    holds: probes.every((p) => p.holds),
    escrow: d.settlementEscrow,
    compliance: d.compliance,
    expectedSelector: COMPLIANCE_ROLE_FORBIDDEN_SELECTOR,
    probes,
    reproduce: [
      `cast call ${d.settlementEscrow} 'grantRole(bytes32,address)' ${ROLES.COMPLIANCE_ROLE} ${d.compliance} --from ${d.admin} --rpc-url ${context.chain.defaultRpc}`,
      `cast call ${d.settlementEscrow} 'grantRole(bytes32,address)' ${ROLES.ORACLE_ROLE} ${d.compliance} --from ${d.admin} --rpc-url ${context.chain.defaultRpc}`,
    ],
  };
}
