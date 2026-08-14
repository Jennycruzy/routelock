/// The compliance engine.
///
/// Three steps, in this order and no other: ask the model, apply the rule, hash
/// the record. The engine never calls the carrier, never mints, never touches
/// the escrow — its entire authority on-chain is `recordDecision`, and
/// `SettlementEscrow` refuses to grant it any role at all.

import { propose, type ModelClientOptions } from "./anthropic.ts";
import { buildDecision } from "./decide.ts";
import { canonicalJson, decisionHash } from "./hash.ts";
import type { ClassificationRequest, Decision } from "./types.ts";

/// Pinned alongside every decision.
///
/// A decision is only reproducible if both the model and the rule that read it
/// are known, so this string names the engine's own version and the HS revision
/// it classifies against. It changes whenever the threshold, the schema, or the
/// prompt changes — not only when the code does.
export const ENGINE_VERSION = "compliance-0.1.0/hs-2022";

export interface EngineConfig {
  readonly apiKey: string;
  readonly model: string;
}

export interface Ruling {
  readonly decision: Decision;
  /// Exactly what was hashed. Published so a verifier need not re-derive it.
  readonly canonical: string;
  /// `bytes32` for `ActivationRegistry.recordDecision`.
  readonly hash: `0x${string}`;
}

/// Read engine configuration from the environment, refusing to run without it.
///
/// There is deliberately no default and no fallback provider. An engine that
/// silently degrades to something other than real inference is the failure this
/// project treats as disqualifying.
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const provider = env["ROUTELOCK_LLM_PROVIDER"] ?? "anthropic";
  if (provider !== "anthropic") {
    throw new Error(
      `ROUTELOCK_LLM_PROVIDER="${provider}" is not implemented. ` +
        `Only "anthropic" is supported; there is no offline mode.`,
    );
  }

  const apiKey = env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. The compliance engine performs real " +
        "inference or it does not run.",
    );
  }

  const model = env["ROUTELOCK_LLM_MODEL"];
  if (model === undefined || model === "") {
    throw new Error(
      "ROUTELOCK_LLM_MODEL is not set. The model is pinned rather than " +
        "defaulted so that a published result always names what produced it.",
    );
  }

  return { apiKey, model };
}

export class ComplianceEngine {
  #options: ModelClientOptions;

  constructor(config: EngineConfig) {
    this.#options = { apiKey: config.apiKey, model: config.model };
  }

  get model(): string {
    return this.#options.model;
  }

  async classify(request: ClassificationRequest): Promise<Ruling> {
    const proposal = await propose(request, this.#options);
    const decision = buildDecision(
      request,
      proposal,
      ENGINE_VERSION,
      this.#options.model,
    );
    return {
      decision,
      canonical: canonicalJson(decision),
      hash: decisionHash(decision),
    };
  }
}
