export { ComplianceEngine, configFromEnv, ENGINE_VERSION } from "./engine.ts";
export type { EngineConfig, Ruling } from "./engine.ts";
export {
  decide,
  buildDecision,
  thresholdFor,
  CONFIDENCE_THRESHOLD,
  CROSS_BORDER_CONFIDENCE_THRESHOLD,
} from "./decide.ts";
export { canonicalHash, canonicalJson, decisionHash, roundConfidence } from "./hash.ts";
export { approve, approveCommitted } from "./approve.ts";
export { propose, parseProposal, buildPrompt, withRetry, ComplianceModelError, reportUsage } from "./anthropic.ts";
export type { CallUsage, UsageSink, ModelClientOptions } from "./anthropic.ts";
export { Verdict, VERDICT_NAMES } from "./types.ts";
export type {
  ClassificationRequest,
  Proposal,
  Decision,
  DecisionGround,
  PurposeFlag,
} from "./types.ts";

/// Compute workloads are judged against the provider policy retrieved by the
/// Akash adapter. The model proposes; decideCompute applies the fixed rule.
export {
  buildComputeDecision,
  decideCompute,
  COMPUTE_CONFIDENCE_THRESHOLD,
  COMPUTE_ENGINE_VERSION,
  buildComputePolicyPrompt,
  parseComputePolicyProposal,
  proposeComputePolicy,
  proposeComputePolicyWithRetry,
} from "./compute/index.ts";
export type {
  ComputeDecision,
  ComputeGround,
  ComputePolicyProposal,
  ComputePolicyRequest,
} from "./compute/index.ts";

/// Carbon credit quality — the second vertical the engine rules on.
export { decideCarbon, deterministicGround, unassessedProposal, CARBON_ENGINE_VERSION, CARBON_CONFIDENCE_THRESHOLD, MAX_VINTAGE_AGE_YEARS, RECOGNISED_REGISTRIES } from "./carbon/decide.ts";
export { proposeCarbonQuality, proposeCarbonQualityWithRetry, parseCarbonProposal, buildCarbonPrompt } from "./carbon/propose.ts";
export type { CarbonModelOptions } from "./carbon/propose.ts";
export { InferenceBudget, InferenceBudgetExceeded, estimateCostUsd, ledgerPath, capsFromEnv as budgetCapsFromEnv, DEFAULT_CAPS as DEFAULT_BUDGET_CAPS } from "./carbon/budget.ts";
export type { BudgetCaps, CallRecord } from "./carbon/budget.ts";
export type { CarbonQualityRequest, CarbonProposal, CarbonDecision, CarbonGround, IntegrityFlag } from "./carbon/types.ts";
