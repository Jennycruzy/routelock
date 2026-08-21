/// Compute-policy compliance vocabulary.
///
/// The workload and policy are supplied by the live adapter. The model only
/// proposes an assessment; deterministic code below decides whether the
/// workload may proceed.

export interface ComputePolicyRequest {
  readonly workloadDescription: string;
  readonly serviceName: string;
  readonly sdl: string;
  /** Operator-supplied jurisdictional fact; the model must not infer it. */
  readonly deployerJurisdiction: string;
  /** Operator-supplied eligibility/lawful-use declaration; not a substitute for policy review. */
  readonly lawfulUseConfirmation: string;
  readonly acceptableUsePolicyUrl: string;
  readonly acceptableUsePolicy: string;
}

export interface ComputePolicyProposal {
  /** Direct conflicts with the retrieved policy, stated for a verifier. */
  readonly policyConflicts: readonly string[];
  /** Facts needed before a safe workload-permission decision. */
  readonly missingInformation: readonly string[];
  /** Model confidence that the workload is permissible under this policy. */
  readonly confidence: number;
  readonly rationale: string;
}

export type ComputeGround =
  | { readonly kind: "approved" }
  | { readonly kind: "policy_conflict"; readonly conflicts: readonly string[] }
  | { readonly kind: "missing_information"; readonly questions: readonly string[] }
  | { readonly kind: "low_confidence"; readonly confidence: number; readonly threshold: number };

export interface ComputeDecision {
  readonly engineVersion: string;
  readonly model: string;
  readonly request: ComputePolicyRequest;
  readonly proposal: ComputePolicyProposal;
  readonly verdict: import("../types.ts").Verdict;
  readonly ground: ComputeGround;
}
