/// The rules that turn a model's assessment into a verdict.
///
/// **No model runs in this file.** `decideCarbon` is pure and total: same
/// inputs, same verdict, every time, with no network and no clock. That is what
/// makes the on-chain `decisionHash` meaningful — anyone holding the published
/// decision JSON can re-run these rules and get the same answer.
///
/// The division of labour matches the delivery path exactly. The model supplies
/// *evidence* — how strong the methodology is, what published findings exist,
/// how confident it is. This file decides what to do about that evidence, and
/// the deterministic facts outrank the model at every step: a class whose
/// identity cannot be established is refused information regardless of how
/// confident the model claims to be.
///
/// ## Every threshold here is chosen, not measured
///
/// The HS thresholds were derived from a calibration curve over 253 customs
/// rulings. **No equivalent corpus exists for carbon**, so every number below
/// was picked by judgement and is marked as such at its definition. Nothing in
/// the README, the UI, or a submission may describe them as measured until
/// there is a corpus to measure them against. Publishing a picked threshold as
/// a calibrated one would be exactly the kind of unearned claim the refusal
/// gate exists to prevent.

import { Verdict } from "../types.ts";
import type { CarbonGround, CarbonProposal, CarbonQualityRequest } from "./types.ts";

/// Minimum confidence to approve a retirement.
///
/// **Chosen, not measured.** Set equal to the delivery path's cross-border bar
/// rather than below it: a retirement cannot be undone, so the cost of a wrong
/// approval is strictly worse here than for a parcel that can be recalled.
/// Raising it costs delayed purchases; lowering it burns credits on guesses.
export const CARBON_CONFIDENCE_THRESHOLD = 0.9;

/// Oldest vintage the engine will approve without asking a human.
///
/// **Chosen, not measured.** Ten years is the point past which a reduction's
/// ongoing additionality is commonly contested; it is a defensible starting
/// point, not a derived one. Older credits are not refused — they are referred,
/// because age is a reason for a human to look rather than a defect in itself.
export const MAX_VINTAGE_AGE_YEARS = 10;

/// Registries whose retirements can be independently verified.
///
/// **Chosen, not measured**, and sourced from what the endpoint actually
/// returns rather than from memory of what registries exist. A class from a
/// registry not on this list is referred, never silently trusted: the whole
/// proof model rests on a third party being checkable.
export const RECOGNISED_REGISTRIES: readonly string[] = ["VCS", "GS", "ACR", "CAR", "UCR", "PURO"];

/// Apply the rules. Pure, total, and ordered — the order is the policy.
export function decideCarbon(
  request: CarbonQualityRequest,
  proposal: CarbonProposal,
): { verdict: Verdict; ground: CarbonGround } {
  // 1. Integrity defects end the matter. These are refusals rather than
  //    questions: more information about a credit that was already retired
  //    elsewhere does not make it retirable again. Checked first so no
  //    confidence score can reach past them.
  if (proposal.integrityFlags.length > 0) {
    return {
      verdict: Verdict.Refused,
      ground: { kind: "integrity_flag", flags: proposal.integrityFlags },
    };
  }

  // 2. A class the provider cannot identify cannot be ruled on. Not
  //    hypothetical — live inventory contains a class that returns its own
  //    address as its name with no methodology at all.
  if (request.identityUnknown) {
    return { verdict: Verdict.NeedsInformation, ground: { kind: "identity_unknown" } };
  }

  // 3. An unregistered class has no public record to check the retirement
  //    against, which removes the entire basis of the proof.
  if (!request.isRegistered) {
    return { verdict: Verdict.NeedsInformation, ground: { kind: "unregistered_class" } };
  }

  // 4. A registry nobody can verify against is the same defect one step out.
  if (
    request.registries.length === 0 ||
    !request.registries.some((r) => RECOGNISED_REGISTRIES.includes(r.toUpperCase()))
  ) {
    return { verdict: Verdict.NeedsInformation, ground: { kind: "unregistered_class" } };
  }

  // 5. Buying what is not there. Deterministic and cheap to check, so it is
  //    checked before anything that depends on judgement.
  if (request.insufficientLiquidity || request.liquidityTonnes < request.tonnesRequested) {
    return {
      verdict: Verdict.NeedsInformation,
      ground: {
        kind: "insufficient_liquidity",
        available: request.liquidityTonnes,
        requested: request.tonnesRequested,
      },
    };
  }

  // 6. The model said outright that it lacked something. Surfaced as its own
  //    ground rather than folded into low confidence, because "I need X" is
  //    actionable and "I am unsure" is not.
  if (proposal.openQuestions.length > 0) {
    return {
      verdict: Verdict.NeedsInformation,
      ground: { kind: "open_questions", questions: proposal.openQuestions },
    };
  }

  // 7. Weak methodology *and* high permanence risk together describe a credit
  //    unlikely to represent a durable tonne. Either alone is a caution; both
  //    is a refusal, because retirement is the one step that cannot be undone
  //    once the evidence turns out to be thin.
  if (proposal.methodologyStrength === "weak" && proposal.permanenceRisk === "high") {
    return {
      verdict: Verdict.Refused,
      ground: { kind: "weak_methodology", permanenceRisk: proposal.permanenceRisk },
    };
  }

  // 8. Age is a referral, not a defect.
  if (request.oldestVintageAgeYears > MAX_VINTAGE_AGE_YEARS) {
    return {
      verdict: Verdict.NeedsInformation,
      ground: {
        kind: "vintage_too_old",
        ageYears: request.oldestVintageAgeYears,
        maxAgeYears: MAX_VINTAGE_AGE_YEARS,
      },
    };
  }

  // 9. Last, because every check above is a reason that survives regardless of
  //    how sure the model is.
  if (proposal.confidence < CARBON_CONFIDENCE_THRESHOLD) {
    return {
      verdict: Verdict.NeedsInformation,
      ground: {
        kind: "low_confidence",
        confidence: proposal.confidence,
        threshold: CARBON_CONFIDENCE_THRESHOLD,
      },
    };
  }

  return { verdict: Verdict.Approved, ground: { kind: "approved" } };
}
