/// The decision audit trail, replayable by anyone.
///
/// `ActivationRegistry` stores five `bytes32`, an engine version, two timestamps,
/// an attempt count and a verdict. No plaintext, no PII — the contracts hold
/// commitments, and this endpoint is what makes those commitments legible
/// without asking anyone to trust this server: every field it returns can be
/// re-read with one `cast call`, and the command to do it is in the response.
///
/// A verdict of `NEEDS_INFORMATION` or `REFUSED` reads exactly as `APPROVED`
/// does. That is the point of storing the verdict as an enum rather than a bool:
/// the on-chain record is not a log of successes.

import { VERDICT_NAMES } from "@routelock/compliance";
import type { Verdict } from "@routelock/compliance";
import {
  ACTIVATION_REGISTRY_ABI,
  ENTITLEMENT_STATE_NAMES,
  SERVICE_ENTITLEMENT_ABI,
} from "@routelock/attest";
import type { EntitlementState } from "@routelock/attest";

import type { ChainContext } from "./chain.ts";

const UNRECORDED = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface ReplayResponse {
  readonly tokenId: string;
  readonly exists: boolean;
  readonly owner: string | null;
  readonly state: string;
  readonly stateOrdinal: number;
  readonly verdict: string;
  readonly verdictOrdinal: number;
  readonly engineVersion: string;
  readonly attempt: number;
  readonly submittedAt: string | null;
  readonly activatedAt: string | null;
  readonly commitments: readonly {
    readonly field: string;
    readonly value: string;
    readonly recorded: boolean;
    readonly means: string;
  }[];
  readonly reproduce: readonly string[];
  readonly explorer: string;
}

/// What each commitment is a commitment *to*. Held here rather than in the
/// contract, because the contract deliberately does not know: the field names
/// date from the delivery adapter and the values are opaque `bytes32` it writes
/// and reads without inspection. `docs/adapter-mapping.md` is authoritative.
const MEANS: Readonly<Record<string, string>> = {
  parcelHash: "the work specification the holder bound — for carbon, the class, tonnage and beneficiary",
  documentsHash: "the evidence set the engine was given: registries, vintages, methodologies",
  decisionHash: "the canonical decision record, model and rule included",
  carrierRefHash: "the provider's own reference for the fulfilment — the retirement certificate",
  carrierRawHash: "the provider's verbatim response, hashed so a later edit is detectable",
};

export async function replay(context: ChainContext, tokenId: bigint): Promise<ReplayResponse> {
  const d = context.deployment;

  const [raw, state, owner] = await Promise.all([
    context.client.readContract({
      address: d.activationRegistry,
      abi: ACTIVATION_REGISTRY_ABI,
      functionName: "activations",
      args: [tokenId],
    }),
    context.client.readContract({
      address: d.serviceEntitlement,
      abi: SERVICE_ENTITLEMENT_ABI,
      functionName: "stateOf",
      args: [tokenId],
    }),
    // An unminted token has no owner and `ownerOf` reverts rather than returning
    // zero, so the absence is caught here instead of failing the whole request.
    context.client
      .readContract({
        address: d.serviceEntitlement,
        abi: SERVICE_ENTITLEMENT_ABI,
        functionName: "ownerOf",
        args: [tokenId],
      })
      .catch(() => null),
  ]);

  const [parcelHash, documentsHash, decisionHash, carrierRefHash, carrierRawHash, engineVersion, submittedAt, activatedAt, attempt, verdict] = raw;

  const commitments = (
    [
      ["parcelHash", parcelHash],
      ["documentsHash", documentsHash],
      ["decisionHash", decisionHash],
      ["carrierRefHash", carrierRefHash],
      ["carrierRawHash", carrierRawHash],
    ] as const
  ).map(([field, value]) => ({
    field,
    value,
    recorded: value !== UNRECORDED,
    means: MEANS[field] ?? "",
  }));

  return {
    tokenId: tokenId.toString(),
    exists: owner !== null,
    owner,
    state: ENTITLEMENT_STATE_NAMES[state as EntitlementState] ?? `unrecognised (${state})`,
    stateOrdinal: Number(state),
    verdict: VERDICT_NAMES[verdict as Verdict] ?? `unrecognised (${verdict})`,
    verdictOrdinal: Number(verdict),
    engineVersion,
    attempt: Number(attempt),
    submittedAt: submittedAt === 0n ? null : new Date(Number(submittedAt) * 1000).toISOString(),
    activatedAt: activatedAt === 0n ? null : new Date(Number(activatedAt) * 1000).toISOString(),
    commitments,
    reproduce: [
      `cast call ${d.activationRegistry} 'activations(uint256)(bytes32,bytes32,bytes32,bytes32,bytes32,string,uint64,uint64,uint32,uint8)' ${tokenId} --rpc-url ${context.chain.defaultRpc}`,
      `cast call ${d.serviceEntitlement} 'stateOf(uint256)(uint8)' ${tokenId} --rpc-url ${context.chain.defaultRpc}`,
    ],
    explorer: `${context.chain.explorer}/address/${d.activationRegistry}`,
  };
}
