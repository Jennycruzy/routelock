/// The compliance engine.
///
/// Three steps, in this order and no other: ask the model, apply the rule, hash
/// the record. The engine never calls the carrier, never mints, never touches
/// the escrow — its entire authority on-chain is `recordDecision`, and
/// `SettlementEscrow` refuses to grant it any role at all.

import { propose, withRetry, type ModelClientOptions } from "./anthropic.ts";
import { ground } from "./ground.ts";
import { buildDecision } from "./decide.ts";
import { InferenceBudget, InferenceBudgetExceeded } from "./carbon/budget.ts";
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
  #budget: InferenceBudget | undefined;

  /// `grounding` is on by default and exists so the two passes can be measured
  /// against each other on the same corpus. Turning it off is how the
  /// before-and-after figures in `bench/README.md` were produced; it is not a
  /// degraded mode for production.
  ///
  /// `budget` is optional here and **mandatory for anything a stranger can
  /// reach.** The benchmark deliberately runs without one: it is a supervised
  /// job whose whole purpose is to spend hundreds of calls, and a 25-call cap
  /// would only teach the operator to raise the cap. An HTTP endpoint is the
  /// opposite — nobody is watching it — so `apps/api` refuses to start without
  /// one. The carbon path has worked this way since it was written; this brings
  /// the HS path level with it.
  constructor(
    config: EngineConfig,
    options?: { grounding?: boolean; budget?: InferenceBudget },
  ) {
    const budget = options?.budget;
    this.#budget = budget;
    // The sink is omitted rather than set to undefined: `exactOptionalPropertyTypes`
    // distinguishes the two, and an absent budget should leave no trace here.
    this.#options = budget === undefined
      ? { apiKey: config.apiKey, model: config.model }
      : {
          apiKey: config.apiKey,
          model: config.model,
          // Recorded as the API reports it, so the ledger holds what was
          // actually charged rather than what this side expected to be charged.
          onUsage: (usage) => {
            budget.record({
              model: usage.model,
              purpose: usage.purpose,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            });
          },
        };
    this.#grounding = options?.grounding ?? true;
  }

  /// The ledger this engine spends against, if it has one. Exposed so a caller
  /// can report the remaining budget without reaching into the engine.
  get budget(): InferenceBudget | undefined {
    return this.#budget;
  }

  get grounding(): boolean {
    return this.#grounding;
  }

  get model(): string {
    return this.#options.model;
  }

  async classify(request: ClassificationRequest): Promise<Ruling> {
    // A grounded ruling costs two calls, so two must be affordable before the
    // first one is made. Checking for one would let a ruling start, spend, and
    // then be unable to finish as the version string it records claims it did —
    // `ENGINE_VERSION` says `+grounded`, and a decision hash that misdescribes
    // what produced it is worse than a refusal.
    this.#assertAffordable(this.#grounding ? 2 : 1);
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

  /// Refuse unless the ledger can afford the whole ruling.
  ///
  /// `assertCallAllowed` answers "is there room for one more", which is the
  /// right question for a single call and the wrong one for a two-pass ruling.
  #assertAffordable(calls: number): void {
    const budget = this.#budget;
    if (budget === undefined) return;

    budget.assertCallAllowed();
    if (budget.callsRemaining < calls) {
      throw new InferenceBudgetExceeded(
        budget.callsUsed,
        budget.callsUsed + budget.callsRemaining,
        calls,
      );
    }
  }
}
