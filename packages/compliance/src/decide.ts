/// Turning a model's proposal into a verdict.
///
/// This file contains no network calls and no model. It is a pure function from
/// evidence to outcome, which is the whole point: the language model supplies
/// the evidence, and an auditable rule — one a reader can check by eye —
/// produces the decision that gates money.
///
/// The ordering of the checks is deliberate and is itself part of the rule. A
/// refusal that could be reached two ways is reported by the more serious one,
/// so "we refused because the description suggested counterfeit goods" is never
/// downgraded to "we needed more information".

import { isAcceptable } from "@routelock/carrier";
import {
  Verdict,
  type Decision,
  type DecisionGround,
  type ClassificationRequest,
  type Proposal,
} from "./types.ts";

/// Below this stated confidence the engine declines to approve.
///
/// 0.85 is a starting position, not a tuned constant, and the benchmark exists
/// to replace it with a measured one: the calibration curve shows the confidence
/// at which the model is actually right often enough to act on. Changing it
/// changes `engineVersion`, because a decision is only reproducible if the rule
/// that produced it is pinned alongside the model.
export const CONFIDENCE_THRESHOLD = 0.85;

/// Cross-border consignments face duty assessment and national restrictions
/// that a domestic parcel does not, so the same uncertainty is less tolerable.
export const CROSS_BORDER_CONFIDENCE_THRESHOLD = 0.9;

export function thresholdFor(crossBorder: boolean): number {
  return crossBorder
    ? CROSS_BORDER_CONFIDENCE_THRESHOLD
    : CONFIDENCE_THRESHOLD;
}

/// Apply the rule.
///
/// Exported separately from the engine so it can be tested exhaustively without
/// a model, and so a reader can audit the money-gating logic in one screen.
export function decide(
  proposal: Proposal,
  crossBorder: boolean,
): { verdict: Verdict; ground: DecisionGround } {
  // 1. Purpose-based policy first. These are the clauses no tariff code can
  //    express, and they are refusals rather than questions — more information
  //    about counterfeit goods does not make them shippable.
  if (proposal.purposeFlags.length > 0) {
    return {
      verdict: Verdict.Refused,
      ground: { kind: "purpose_flag", flags: proposal.purposeFlags },
    };
  }

  // 2. No classification at all. The engine cannot approve goods it cannot
  //    name, and it says so rather than guessing a plausible code.
  if (proposal.hs6 === null) {
    return {
      verdict: Verdict.NeedsInformation,
      ground: { kind: "no_classification" },
    };
  }

  // 3. The carrier's own published policy, checked against the proposed code.
  //    This is a refusal: the carrier will not move these goods regardless of
  //    what else is known about them.
  const acceptance = isAcceptable(proposal.hs6);
  if (!acceptance.ok) {
    return {
      verdict: Verdict.Refused,
      ground: {
        kind: "carrier_policy",
        clause: acceptance.clause,
        detail: acceptance.reason,
      },
    };
  }

  // 4. Named gaps in the description. Answerable, so this asks rather than
  //    refuses — the entitlement returns to Available and can be resubmitted.
  if (proposal.missingInformation.length > 0) {
    return {
      verdict: Verdict.NeedsInformation,
      ground: {
        kind: "missing_information",
        questions: proposal.missingInformation,
      },
    };
  }

  // 5. Confidence last, so a specific reason always outranks a bare number.
  //
  //    The range is re-checked here rather than trusted from the caller.
  //    `parseProposal` already clamps model output, but this function is the
  //    one that gates money and a `Proposal` can be built by anything — a
  //    confidence of 2 must not clear a threshold of 0.9 because an upstream
  //    validator was bypassed. NaN is excluded by the comparison itself.
  const threshold = thresholdFor(crossBorder);
  const confidence = proposal.confidence;
  const inRange = confidence >= 0 && confidence <= 1;
  if (!inRange || !(confidence >= threshold)) {
    return {
      verdict: Verdict.NeedsInformation,
      ground: {
        kind: "low_confidence",
        confidence: proposal.confidence,
        threshold,
      },
    };
  }

  return { verdict: Verdict.Approved, ground: { kind: "approved" } };
}

/// Assemble the complete record for a request and proposal.
export function buildDecision(
  request: ClassificationRequest,
  proposal: Proposal,
  engineVersion: string,
  model: string,
): Decision {
  const crossBorder = request.originCountry !== request.destinationCountry;
  const { verdict, ground } = decide(proposal, crossBorder);
  return { engineVersion, model, request, proposal, verdict, ground, crossBorder };
}
