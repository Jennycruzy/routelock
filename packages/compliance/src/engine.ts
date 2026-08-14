/// The compliance engine.
///
/// Three steps, in this order and no other: ask the model, apply the rule, hash
/// the record. The engine never calls the carrier, never mints, never touches
/// the escrow — its entire authority on-chain is `recordDecision`, and
/// `SettlementEscrow` refuses to grant it any role at all.

import { propose, withRetry, type ModelClientOptions } from "./anthropic.ts";
import { ground } from "./ground.ts";
import { buildDecision } from "./decide.ts";
import { canonicalJson, decisionHash } from "./hash.ts";
import type { ClassificationRequest, Decision } from "./types.ts";

/// Pinned alongside every decision.
///
/// A decision is only reproducible if both the model and the rule that read it
/// are known, so this string names the engine's own version and the HS revision
/// it classifies against. It changes whenever the threshold, the schema, or the
/// prompt changes — not only when the code does.
export const ENGINE_VERSION = "compliance-0.2.0/hs-2022+grounded";

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
  #grounding: boolean;

  /// `grounding` is on by default and exists so the two passes can be measured
  /// against each other on the same corpus. Turning it off is how the
  /// before-and-after figures in `bench/README.md` were produced; it is not a
  /// degraded mode for production.
  constructor(config: EngineConfig, options?: { grounding?: boolean }) {
    this.#options = { apiKey: config.apiKey, model: config.model };
    this.#grounding = options?.grounding ?? true;
  }

  get grounding(): boolean {
    return this.#grounding;
  }

  get model(): string {
    return this.#options.model;
  }

  async classify(request: ClassificationRequest): Promise<Ruling> {
    const first = await withRetry(() => propose(request, this.#options));

    // Second pass: re-decide the subheading against the published nomenclature
    // for the chapters the first pass named. Skipped when the first pass raised
    // a purpose flag — those are refusals that no amount of tariff text
    // changes, and spending a call on them is waste.
    let proposal = first;
    if (this.#grounding && first.purposeFlags.length === 0) {
      const grounded = await withRetry(() =>
        ground(request, first, this.#options),
      );
      if (grounded !== null && grounded.hs6 !== null) {
        proposal = {
          ...first,
          hs6: grounded.hs6,
          confidence: grounded.confidence,
          rationale: grounded.rationale,
        };
      }
    }

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
