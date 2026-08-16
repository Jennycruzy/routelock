/// Ruling on the quality of a carbon credit, rather than the tariff code of a
/// parcel.
///
/// This is the second vertical the compliance engine serves, and it exists
/// because a carbon retirement is the one fulfilment that **cannot be undone**.
/// A wrong parcel classification is a delay and a re-submission. A wrong
/// retirement permanently burns a credit that cannot be refunded, resold or
/// disputed, so the engine's ability to say "not sure" is worth more here than
/// anywhere else in the system.
///
/// ## Same architecture as the HS path, deliberately
///
/// The model **proposes** an assessment; deterministic code **decides** the
/// verdict. `CarbonProposal` carries no verdict field, exactly as `Proposal`
/// carries none — the model supplies evidence and a confidence, and
/// `decideCarbon()` applies auditable rules to it. This is what makes the
/// on-chain guarantee meaningful: `SettlementEscrow` structurally refuses
/// `COMPLIANCE_ROLE`, so the model can open a gate and can never move money.
///
/// ## What is measured and what is picked
///
/// The HS thresholds were derived from a calibration curve over 253 customs
/// rulings. **No such corpus exists for carbon.** Every threshold in
/// `decide.ts` is therefore *chosen*, and is documented as chosen at its
/// definition. None of them may be described as measured, in the README, the
/// UI, or anywhere else, until a corpus exists to measure them against.

/// The deterministic facts a retirement is judged on.
///
/// Owned by this package rather than imported from `@routelock/carbon`, for the
/// same reason `ClassificationRequest` is not imported from the carrier
/// package: the engine defines what it needs to rule on, and an adapter maps
/// its own facts onto that. It also keeps the dependency pointing one way.
///
/// Every field here is retrieved from the registry, never supplied by the buyer
/// — which is the opposite of the delivery path, where the goods description is
/// free text written by the shipper.
export interface CarbonQualityRequest {
  /// Opaque class identifier at the provider. Carried so a decision can be tied
  /// back to what was assessed.
  readonly carbonClass: string;
  readonly name: string | null;
  readonly category: string | null;
  readonly country: string | null;
  /// The methodology credits were issued under. Carries most of the quality
  /// signal.
  readonly methodologies: readonly string[];
  readonly registries: readonly string[];
  readonly projectIds: readonly string[];
  readonly vintages: readonly number[];
  readonly oldestVintage: number;
  readonly oldestVintageAgeYears: number;
  readonly isRegistered: boolean;
  readonly liquidityTonnes: number;
  readonly insufficientLiquidity: boolean;
  /// True when the class has no name, category or methodology to rule on.
  readonly identityUnknown: boolean;
  /// How much the buyer asked to retire.
  readonly tonnesRequested: number;
}

/// A defect no confidence score may override.
///
/// The carbon analogue of `PurposeFlag`. These are refusals rather than
/// questions: more information about a credit that is already retired
/// elsewhere does not make it retirable again.
///
/// **These are integrity defects, not quality opinions.** The distinction is
/// the whole design. A credit whose additionality is contested is still the
/// credit the buyer chose to buy at the price the market set for it; that
/// belongs in `adverseFindings`, where it is disclosed and committed on chain.
/// A credit that was already retired, or whose methodology was withdrawn, is
/// not the thing it claims to be at any price — and that is what this list is
/// for.
export type IntegrityFlag =
  /// The credit appears to have been claimed or retired already.
  | "double_counting"
  /// The issuing registry is not one whose retirements can be verified.
  | "unrecognised_registry"
  /// The methodology has been withdrawn or suspended by its standard body.
  | "withdrawn_methodology"
  /// Published findings that the project's claimed reductions did not occur.
  | "documented_non_additionality"
  /// The project is the subject of a fraud finding.
  | "fraud_finding"
  /// The reduction is reversible and the project carries no buffer or
  /// insurance against reversal.
  | "unbuffered_reversal_risk";

/// The model's output. Evidence, not a decision.
///
/// Mirrors `Proposal`: no verdict, and a confidence that is rounded before it
/// reaches the hash so the value stored, published and committed are the same
/// number.
export interface CarbonProposal {
  /// How strong the methodology is as evidence that a tonne was actually
  /// avoided or removed. The model's judgement, not a lookup.
  readonly methodologyStrength: "strong" | "moderate" | "weak";
  /// Whether the reduction is durable, and for how long.
  readonly permanenceRisk: "low" | "medium" | "high";
  /// Published, checkable concerns about this project or methodology. Free
  /// text, each one a claim a reader can go and verify.
  ///
  /// **Disclosed, never blocking.** These are hashed into the evidence set and
  /// committed on chain, so the buyer gets the credit they paid for *and* a
  /// permanent record of what is contested about it. No offset retailer does
  /// that. Treating them as refusals instead was a design error that made the
  /// engine refuse every class in live inventory.
  readonly adverseFindings: readonly string[];
  /// Defects that end the matter regardless of confidence.
  readonly integrityFlags: readonly IntegrityFlag[];
  /// What the model would still need for a fuller picture. Surfaced verbatim
  /// rather than summarised, and **disclosed rather than blocking**: a careful
  /// assessment always has open questions, so treating any question as a
  /// referral makes approval unreachable by construction.
  readonly openQuestions: readonly string[];
  /// 0–1, rounded to three decimals before hashing.
  ///
  /// **Confidence that the credit is what it claims to be and carries no
  /// integrity defect** — not confidence that it is a high-quality credit.
  /// The first question is answerable from registry metadata; the second is
  /// not, and asking it is what pinned every assessment at 0.3–0.4.
  readonly confidence: number;
  readonly rationale: string;
}

/// Why a carbon verdict came out the way it did.
///
/// Every branch names the rule that fired, so a published decision can be
/// audited against the code rather than trusted.
export type CarbonGround =
  | { readonly kind: "approved" }
  | { readonly kind: "integrity_flag"; readonly flags: readonly IntegrityFlag[] }
  | { readonly kind: "identity_unknown" }
  | { readonly kind: "unregistered_class" }
  | { readonly kind: "insufficient_liquidity"; readonly available: number; readonly requested: number }
  | { readonly kind: "vintage_too_old"; readonly ageYears: number; readonly maxAgeYears: number }
  | { readonly kind: "low_confidence"; readonly confidence: number; readonly threshold: number };

/// The complete, publishable record of one carbon ruling.
///
/// Canonicalised and hashed into `decisionHash`, exactly as a delivery
/// `Decision` is. Contains no PII — every field is registry metadata or model
/// output about a public project.
export interface CarbonDecision {
  readonly engineVersion: string;
  readonly model: string;
  readonly request: CarbonQualityRequest;
  readonly proposal: CarbonProposal;
  readonly verdict: import("../types.ts").Verdict;
  readonly ground: CarbonGround;
  /// Always true for this vertical, and stated rather than implied: a
  /// retirement cannot be reversed, which is why the thresholds are stricter
  /// than the delivery path's.
  readonly irreversible: true;
}
