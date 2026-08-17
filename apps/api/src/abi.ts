/// The extra reads this API makes, beyond what `@routelock/attest` already
/// publishes.
///
/// `ACTIVATION_REGISTRY_ABI` and `SERVICE_ENTITLEMENT_ABI` come from that
/// package and are not repeated here. What is here is the slice needed to serve
/// the *negative* half of the pitch: the role graph, and the escrow's refusal to
/// ever grant `COMPLIANCE_ROLE`.

import { keccak256, toHex } from "viem";

/// Mirrors `Roles` in `RouteLockTypes.sol`, computed the same way the contract
/// computes it rather than pasted as a literal — a mistyped role hash reads as
/// "the role is not held", which is indistinguishable from a real answer.
export const ROLES = {
  ISSUER_ROLE: keccak256(toHex("ISSUER_ROLE")),
  ORACLE_ROLE: keccak256(toHex("ORACLE_ROLE")),
  COMPLIANCE_ROLE: keccak256(toHex("COMPLIANCE_ROLE")),
  ADMIN_ROLE: keccak256(toHex("ADMIN_ROLE")),
  FACTORY_ROLE: keccak256(toHex("FACTORY_ROLE")),
  REGISTRY_ROLE: keccak256(toHex("REGISTRY_ROLE")),
} as const;

/// `ComplianceRoleForbiddenHere()`, the selector the escrow reverts with.
///
/// Published so the frontend can name what it saw rather than showing a raw
/// four bytes. Derived, not pasted, for the same reason as the role hashes.
export const COMPLIANCE_ROLE_FORBIDDEN_SELECTOR = keccak256(
  toHex("ComplianceRoleForbiddenHere()"),
).slice(0, 10);

export const ACCESS_CONTROL_ABI = [
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [],
  },
] as const;

export const FULFILMENT_RECEIPT_ABI = [
  {
    type: "function",
    name: "totalReceipts",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
