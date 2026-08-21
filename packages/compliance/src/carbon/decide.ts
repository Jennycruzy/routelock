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

/// What produced a carbon ruling, written on chain as `engineVersion`.
///
/// Separate from the delivery engine's version, and it has to be: the first
/// live run committed `compliance-0.2.0/hs-2022+grounded` against a carbon
/// decision, which claims the HS classifier and its nomenclature edition
/// produced a judgement they had nothing to do with. On a permanent audit
/// record that is a false provenance, not a cosmetic slip.
///
/// The suffix names what the ruling actually depended on: the registry
/// allowlist and confidence bar in this file, both picked rather than measured.
export const CARBON_ENGINE_VERSION = "compliance-0.2.0/carbon-registry-v2";

/// Minimum confidence to approve a retirement.
///
/// It measures confidence that **the credit is what it claims to be and
/// carries no integrity defect** — not that it is a high-quality credit.
///
/// ## This number is picked, and here is exactly how picked
///
/// It was 0.9, copied from the delivery path's cross-border bar. That 0.9 is
/// genuinely calibrated — the HS benchmark showed the model states 92.0% and
/// delivers 92.6% in the 0.9–1.0 band. But that curve measures **HS
/// classification accuracy**, and this threshold governs a different question
/// on different evidence. A calibrated number transplanted onto a task it was
/// not calibrated on is not rigour; it is the appearance of rigour, and it set
/// a bar that no assessment from registry metadata could clear. Every class in
/// live inventory was refused.
///
/// 0.6 is a judgement, stated as one. **No curve backs it.** It is the live
/// starting bar for the demo: enough to require meaningful model evidence
/// while allowing the recognised, registered, liquid classes in the current
/// inventory to proceed. Earning a calibrated number needs a corpus of credit
/// classes with known integrity outcomes, which does not exist yet.
///
/// ## Why lowering it does not hollow out the gate
///
/// Confidence is the last check, not the main one. Integrity flags refuse
/// outright and no confidence overrides them; a class that cannot be
/// identified, sits on an unverifiable registry, or lacks supply is referred
/// before the model is even asked. On live inventory two of six classes refuse
/// on those grounds alone, at any threshold. The teeth are upstream of this
/// number.
export const CARBON_CONFIDENCE_THRESHOLD = 0.6;

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

  // 2–5. The checks that depend on nothing the model supplies: a class with no
  //    identity, on no recognised registry, or without the supply to fill the
  //    order. Delegated to `deterministicGround` rather than repeated here,
  //    because callers use that function to decide whether to pay for
  //    inference at all — and if the two ever disagreed, skipping the model
  //    would change the verdict. One implementation, so they cannot.
  const facts = deterministicGround(request);
  if (facts !== null) {
    return { verdict: Verdict.NeedsInformation, ground: facts };
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
