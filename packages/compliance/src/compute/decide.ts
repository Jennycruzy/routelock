/// Deterministic compute-policy decision rules.

import { Verdict } from "../types.ts";
import type { ComputeGround, ComputePolicyProposal, ComputePolicyRequest, ComputeDecision } from "./types.ts";

export const COMPUTE_ENGINE_VERSION = "compliance-0.2.0/akash-policy-v1";
/** Chosen starting bar; no compute calibration corpus exists yet. */
export const COMPUTE_CONFIDENCE_THRESHOLD = 0.85;

export function decideCompute(
  proposal: ComputePolicyProposal,
): { readonly verdict: Verdict; readonly ground: ComputeGround } {
  if (proposal.policyConflicts.length > 0) {
    return {
      verdict: Verdict.Refused,
      ground: { kind: "policy_conflict", conflicts: proposal.policyConflicts },
    };
  }
  if (proposal.missingInformation.length > 0) {
    return {
      verdict: Verdict.NeedsInformation,
      ground: { kind: "missing_information", questions: proposal.missingInformation },
    };
  }
  if (
    !Number.isFinite(proposal.confidence) ||
    proposal.confidence < COMPUTE_CONFIDENCE_THRESHOLD
  ) {
    return {
      verdict: Verdict.NeedsInformation,
      ground: {
        kind: "low_confidence",
        confidence: proposal.confidence,
        threshold: COMPUTE_CONFIDENCE_THRESHOLD,
      },
    };
  }
  return { verdict: Verdict.Approved, ground: { kind: "approved" } };
}

export function buildComputeDecision(
  request: ComputePolicyRequest,
  proposal: ComputePolicyProposal,
  model: string,
): ComputeDecision {
  const { verdict, ground } = decideCompute(proposal);
  return {
    engineVersion: COMPUTE_ENGINE_VERSION,
    model,
    request,
    proposal,
    verdict,
    ground,
  };
}
