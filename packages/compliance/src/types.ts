/// The compliance engine's vocabulary.
///
/// The central structural rule of this package: **the model proposes, and
/// deterministic code decides.** The model returns a `Proposal` — a candidate
/// classification, a stated confidence, and what it would need to be sure. It
/// never returns a `Verdict`. The verdict is computed from that proposal by
/// `decide()`, a pure function with no network and no model in it.
///
/// That separation is what makes the on-chain guarantee meaningful. The escrow
/// already refuses to grant `COMPLIANCE_ROLE`, so the engine cannot move money;
/// this ensures it cannot even *choose the outcome* — only supply the evidence
/// an auditable rule is applied to.

/// Mirrors `Verdict` in `ActivationRegistry.sol`, including the ordinals, so a
/// value can be sent to `recordDecision` without a translation table.
///
/// `NeedsInformation` and `Refused` are recorded, hashed and committed exactly
/// as `Approved` is. They are correct outcomes, not errors.
export enum Verdict {
  None = 0,
  Approved = 1,
  NeedsInformation = 2,
  Refused = 3,
}

export const VERDICT_NAMES: Readonly<Record<Verdict, string>> = {
  [Verdict.None]: "NONE",
  [Verdict.Approved]: "APPROVED",
  [Verdict.NeedsInformation]: "NEEDS_INFORMATION",
  [Verdict.Refused]: "REFUSED",
};

/// What the engine is asked to rule on.
///
/// Origin and destination are always supplied. Whether a lane crosses a customs
/// border changes what the classification is *for* — duty and restriction
/// versus carrier acceptance — so it is never assumed.
export interface ClassificationRequest {
  /// The goods, as described by whoever is shipping them. Free text.
  readonly description: string;
  /// ISO 3166-1 alpha-2.
  readonly originCountry: string;
  readonly destinationCountry: string;
  readonly declaredValue: number;
  readonly currency: string;
  readonly weightKg: number;
}

/// A reason the goods cannot be shipped that no tariff code can express.
///
/// Shipbubble's acceptable-use policy has eight clauses about the *purpose or
/// content* of goods — counterfeit articles, malware, material that exploits
/// children, and so on. An HS code says what a thing is, never what it is for,
/// so these can only be caught by reading the description.
export type PurposeFlag =
  | "counterfeit_or_ip_infringing"
  | "malware_or_intrusion_tooling"
  | "exploitation_or_abuse_material"
  | "hateful_or_violent_material"
  | "self_harm_promotion"
  | "terrorism_support"
  | "personal_data_or_credentials"
  | "otherwise_unlawful";

/// The model's output. Evidence, not a decision.
export interface Proposal {
  /// Best-guess HS-6 subheading, or null when the model cannot name one.
  readonly hs6: string | null;
  /// The model's stated probability that `hs6` is correct, in [0, 1].
  ///
  /// Treated as a claim to be measured, never as ground truth: the published
  /// calibration curve exists precisely to show how far this can be trusted.
  readonly confidence: number;
  /// Facts that would change the answer, phrased as questions for the shipper.
  /// Non-empty means the description was not sufficient.
  readonly missingInformation: readonly string[];
  /// Purpose-based policy concerns the description raised.
  readonly purposeFlags: readonly PurposeFlag[];
  /// One or two sentences, for the audit record. No PII.
  readonly rationale: string;
}

/// Why a verdict came out the way it did.
///
/// Recorded so a refusal can be explained to the person it affects, and so the
/// public replay endpoint can show the rule that fired rather than only the
/// outcome.
export type DecisionGround =
  | { readonly kind: "approved" }
  | { readonly kind: "purpose_flag"; readonly flags: readonly PurposeFlag[] }
  | { readonly kind: "carrier_policy"; readonly clause: string; readonly detail: string }
  | { readonly kind: "no_classification" }
  | { readonly kind: "low_confidence"; readonly confidence: number; readonly threshold: number }
  | { readonly kind: "missing_information"; readonly questions: readonly string[] };

/// The complete, publishable record of one ruling.
///
/// This object — canonicalised and hashed — is what `decisionHash` commits to
/// on-chain. It contains no names, no addresses and no document contents, only
/// the goods description the shipper themselves supplied.
export interface Decision {
  readonly engineVersion: string;
  readonly model: string;
  readonly request: ClassificationRequest;
  readonly proposal: Proposal;
  readonly verdict: Verdict;
  readonly ground: DecisionGround;
  readonly crossBorder: boolean;
}
