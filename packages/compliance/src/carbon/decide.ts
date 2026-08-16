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
///
/// It measures confidence that **the credit is what it claims to be and
/// carries no integrity defect** — not that it is a high-quality credit. That
/// distinction is why the number can stay at 0.9 rather than being tuned
/// downward until something passes.
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
/// **Chosen, not measured.** A class from a registry not on this list is
/// referred, never silently trusted: the proof model rests on a third party
/// being checkable.
///
/// ⚠️ **These are the provider's codes, read off live responses — not registry
/// names from memory.** The first version of this list was written from memory
/// and was wrong in a way that refused three of the six classes in live
/// inventory: it said `PURO` where the endpoint returns `PUR`, and omitted
/// `REGEN` entirely. A scan of the whole inventory caught it. If a new code
/// appears, read it from a response before adding it here.
///
/// Codes observed live on 2026-08-16: `UCR`, `REGEN`, `PUR`, `CMARK`.
///
/// `CMARK` is deliberately **absent**. It appears on Carbonmark-side listings
/// and it is not established that it identifies an issuing registry whose
/// retirements can be checked independently of the marketplace itself — which
/// is the entire property this check tests for. Referring those classes until
/// somebody confirms what the code denotes is the correct failure direction.
export const RECOGNISED_REGISTRIES: readonly string[] = [
  "VCS", // Verra
  "GS", // Gold Standard
  "ACR", // American Carbon Registry
  "CAR", // Climate Action Reserve
  "UCR", // Universal Carbon Registry
  "PUR", // Puro.earth — the provider's code, not "PURO"
  "REGEN", // Regen Registry
];

/// Can the facts alone settle this, without asking the model?
///
/// Several grounds below depend on nothing the model supplies: a class with no
/// identity, no registry, or not enough supply is referred whatever an
/// assessment would have said. Paying for inference on those is spending money
/// to reach a conclusion already reached.
///
/// Returns the ground when the facts decide, `null` when a model is genuinely
/// needed. Callers that skip the call must still record *why* they skipped —
/// see `unassessedProposal`.
export function deterministicGround(request: CarbonQualityRequest): CarbonGround | null {
  if (request.identityUnknown) return { kind: "identity_unknown" };
  if (!request.isRegistered) return { kind: "unregistered_class" };
  if (
    request.registries.length === 0 ||
    !request.registries.some((r) => RECOGNISED_REGISTRIES.includes(r.toUpperCase()))
  ) {
    return { kind: "unregistered_class" };
  }
  if (request.insufficientLiquidity || request.liquidityTonnes < request.tonnesRequested) {
    return {
      kind: "insufficient_liquidity",
      available: request.liquidityTonnes,
      requested: request.tonnesRequested,
    };
  }
  return null;
}

/// The proposal to record when no model was asked.
///
/// Not an empty object dressed up as an assessment: it states plainly that no
/// assessment was attempted and why. The published decision must never imply a
/// model looked at something it never saw.
export function unassessedProposal(reason: string): CarbonProposal {
  return {
    methodologyStrength: "weak",
    permanenceRisk: "high",
    adverseFindings: [],
    integrityFlags: [],
    openQuestions: [`no assessment was attempted: ${reason}`],
    confidence: 0,
    rationale: "",
  };
}

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

  // 6. Open questions and adverse findings are **disclosed, not blocking**.
  //    They are hashed into the evidence set and committed on chain, so the
  //    buyer receives the credit they chose plus a permanent record of what is
  //    contested about it. Blocking on them instead refused every class in
  //    live inventory — a gate that only ever closes is not a gate.
  //
  //    Likewise a weak methodology or high permanence risk: those are quality
  //    opinions about a credit the market has already priced, not evidence
  //    that the credit is other than it claims to be.

  // 7. Age is a referral, not a defect.
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

  // 8. Last. Note what this threshold now measures: confidence that the credit
  //    is **what it claims to be and free of integrity defects** — a question
  //    answerable from registry metadata. It used to measure confidence that
  //    the credit was high quality, which no assessment can reach from this
  //    evidence, so nothing could ever clear it.
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
