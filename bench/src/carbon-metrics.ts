/// Scoring for the carbon quality benchmark.
///
/// Kept separate from the runner and free of I/O, so the rules that turn a
/// proposal into a score are testable without spending money — the same split
/// `metrics.ts` uses for the HS corpus.
///
/// **What is being scored, and what is not.** `methodologyStrength` and
/// `adverseFindings` are *disclosure*: they are hashed into the evidence set and
/// published, and they do not gate a retirement. Nothing here may be described
/// as a pass rate for the gate. The one gating output is `integrityFlags`, and
/// §3.2 of the design records that purchasable inventory offers a single
/// CCP-Approved row to test it on — which is not a rate.

export interface IcvcmLabel {
  readonly methodologyId: string;
  /// ICVCM's own row text, e.g. "ACM0002 - Grid-connected electricity … - 1.0-21.0".
  readonly icvcmMethodology: string;
  readonly icvcmVersions: string | null;
  /// "CCP-Approved", "Does not meet", "Very Unlikely To Meet", …
  readonly decision: string;
  readonly decisionDocumentUrl: string | null;
}

export interface CarbonCorpusRow {
  readonly carbonClass: string;
  readonly name: string | null;
  readonly category: string | null;
  readonly country: string | null;
  readonly methodologies: readonly string[];
  readonly registries: readonly string[];
  readonly projectIds: readonly string[];
  readonly vintages: readonly number[];
  readonly oldestVintage: number;
  readonly oldestVintageAgeYears: number;
  readonly isRegistered: boolean;
  readonly liquidityTonnes: number;
  readonly insufficientLiquidity: boolean;
  readonly identityUnknown: boolean;
  readonly tonnesRequested: number;
  readonly label: IcvcmLabel;
  readonly sourceUrl: string | null;
}

/// ICVCM decisions that say the methodology failed its assessment.
const NEGATIVE = ["Does not meet", "Very Unlikely To Meet"];

/// The mapping from an ICVCM decision to what the engine's `methodologyStrength`
/// ought to say, stated here rather than buried in a comparison.
///
/// It is deliberately **asymmetric and coarse**, because the two vocabularies do
/// not mean the same thing. ICVCM rules on whether a methodology meets the Core
/// Carbon Principles; `methodologyStrength` is the model's judgement of how good
/// the methodology is as evidence that a tonne was really avoided. So:
///
///   - A methodology an authority has **rejected** should not be called
///     `strong`. Scoring it as "must say `weak`" would be stricter than the
///     evidence supports, so `moderate` counts as neither right nor wrong and is
///     reported in its own column.
///   - An **approved** methodology should not be called `weak`.
///
/// Anything finer would be this project inventing a correspondence that neither
/// ICVCM nor the engine states.
export type StrengthOutcome = "correct" | "incorrect" | "partial";

export function scoreStrength(
  decision: string,
  strength: "strong" | "moderate" | "weak",
): StrengthOutcome {
  if (NEGATIVE.includes(decision)) {
    if (strength === "weak") return "correct";
    return strength === "strong" ? "incorrect" : "partial";
  }
  if (decision === "CCP-Approved") {
    if (strength === "weak") return "incorrect";
    return strength === "strong" ? "correct" : "partial";
  }
  // Remedial Action and anything else: no direction is claimed, so no score is
  // claimed either.
  return "partial";
}

/// Does the disclosure name a finding a buyer could look up? — §3.3.
///
/// Two separate questions, because they have very different bars, and reporting
/// them as one number would let the weaker one carry the stronger:
///
///   `namesAuthority` — the text names ICVCM or the CCP assessment itself. This
///   is what makes a disclosure checkable: a buyer can open the decision
///   document from it.
///
///   `namesConcern`   — the text says something specific about the methodology's
///   integrity at all. Weaker, but not nothing.
///
/// Keyword matching, and stated as keyword matching. It can only ever be a lower
/// bound on `namesConcern`; a finding phrased in words not on the list is
/// counted as absent.
const AUTHORITY_TERMS = ["icvcm", "ccp", "core carbon", "integrity council"];
const CONCERN_TERMS = [
  "additionality",
  "over-credit",
  "overcredit",
  "baseline",
  "non-additional",
  "renewable energy",
  "grid-connected",
  "questioned",
  "criticis",
  "controvers",
  "rejected",
  "does not meet",
  "failed",
];

export interface DisclosureScore {
  readonly namesAuthority: boolean;
  readonly namesConcern: boolean;
  readonly findingCount: number;
}

export function scoreDisclosure(adverseFindings: readonly string[]): DisclosureScore {
  const text = adverseFindings.join(" ").toLowerCase();
  return {
    namesAuthority: AUTHORITY_TERMS.some((term) => text.includes(term)),
    namesConcern: CONCERN_TERMS.some((term) => text.includes(term)),
    findingCount: adverseFindings.length,
  };
}

export interface ScoredCarbonRow {
  readonly carbonClass: string;
  readonly sourceUrl: string | null;
  readonly methodologyId: string;
  readonly decision: string;
  readonly decisionDocumentUrl: string | null;
  readonly strength: "strong" | "moderate" | "weak";
  readonly strengthOutcome: StrengthOutcome;
  readonly integrityFlags: readonly string[];
  readonly confidence: number;
  readonly disclosure: DisclosureScore;
  /// The findings themselves, verbatim.
  ///
  /// Carried because `scoreDisclosure` is keyword matching, and a reader who
  /// thinks a keyword list is the wrong instrument must be able to read what the
  /// engine actually wrote and disagree with the score. A published number whose
  /// input is not published is a number to be trusted rather than checked.
  readonly adverseFindings: readonly string[];
  readonly verdict: string;
}

export interface DeterminationMetrics {
  readonly determination: string;
  readonly decision: string;
  readonly decisionDocumentUrl: string | null;
  readonly rows: number;
  readonly correct: number;
  readonly partial: number;
  readonly incorrect: number;
  readonly namesAuthority: number;
  readonly namesConcern: number;
  readonly integrityFlagged: number;
}

/// Results per determination, never as one accuracy over all rows.
///
/// A methodology carries one determination however many projects were issued
/// under it. Averaging over rows would report the same handful of judgements
/// dozens of times and present the repetition as sample size — which is the
/// error the design's §9 exists to prevent. Row counts are carried alongside so
/// a reader can see exactly how thin each line is.
export function byDetermination(
  rows: readonly (ScoredCarbonRow & { readonly determination: string })[],
): readonly DeterminationMetrics[] {
  const groups = new Map<string, (ScoredCarbonRow & { determination: string })[]>();
  for (const row of rows) {
    groups.set(row.determination, [...(groups.get(row.determination) ?? []), row]);
  }

  const count = (
    group: readonly ScoredCarbonRow[],
    predicate: (row: ScoredCarbonRow) => boolean,
  ): number => group.filter(predicate).length;

  return [...groups.entries()]
    .map(([determination, group]) => ({
      determination,
      decision: group[0]?.decision ?? "",
      decisionDocumentUrl: group[0]?.decisionDocumentUrl ?? null,
      rows: group.length,
      correct: count(group, (row) => row.strengthOutcome === "correct"),
      partial: count(group, (row) => row.strengthOutcome === "partial"),
      incorrect: count(group, (row) => row.strengthOutcome === "incorrect"),
      namesAuthority: count(group, (row) => row.disclosure.namesAuthority),
      namesConcern: count(group, (row) => row.disclosure.namesConcern),
      integrityFlagged: count(group, (row) => row.integrityFlags.length > 0),
    }))
    .sort((a, b) => b.rows - a.rows);
}
