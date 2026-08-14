export { ComplianceEngine, configFromEnv, ENGINE_VERSION } from "./engine.ts";
export type { EngineConfig, Ruling } from "./engine.ts";
export {
  decide,
  buildDecision,
  thresholdFor,
  CONFIDENCE_THRESHOLD,
  CROSS_BORDER_CONFIDENCE_THRESHOLD,
} from "./decide.ts";
export { canonicalJson, decisionHash, roundConfidence } from "./hash.ts";
export { propose, parseProposal, buildPrompt, ComplianceModelError } from "./anthropic.ts";
export { Verdict, VERDICT_NAMES } from "./types.ts";
export type {
  ClassificationRequest,
  Proposal,
  Decision,
  DecisionGround,
  PurposeFlag,
} from "./types.ts";
