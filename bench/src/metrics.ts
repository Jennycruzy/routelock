/// Scoring the engine against the corpus.
///
/// The headline number is not accuracy. It is **refusal precision**: of the
/// consignments the engine declined to approve, how many would it have got
/// wrong? A model that refuses exactly when it would have erred is more useful
/// than one with higher raw accuracy that guesses confidently, because a wrong
/// classification on a cross-border shipment costs money and a refusal costs a
/// follow-up question.
///
/// Two kinds of decline are counted separately and must never be pooled:
///
///   **uncertainty** — no classification, low confidence, missing information.
///     These are the engine saying "I might be wrong", and they are what refusal
///     precision measures.
///   **policy** — carrier policy or a purpose flag. Whisky is refused while
///     being classified perfectly. Counting a policy refusal as a good call
///     would inflate the figure with cases that had nothing to do with
///     uncertainty.

import { Verdict, type Decision } from "@routelock/compliance";

export interface ScoredRow {
  readonly reference: string;
  readonly jurisdiction: string;
  readonly expectedHs6: string;
  readonly proposedHs6: string | null;
  readonly confidence: number;
  readonly verdict: Verdict;
  readonly groundKind: string;
  /// Null when the engine proposed no code at all.
  readonly correct: boolean | null;
}

export function scoreRow(
  decision: Decision,
  expectedHs6: string,
  reference: string,
  jurisdiction: string,
): ScoredRow {
  const proposedHs6 = decision.proposal.hs6;
  return {
    reference,
    jurisdiction,
    expectedHs6,
    proposedHs6,
    confidence: decision.proposal.confidence,
    verdict: decision.verdict,
    groundKind: decision.ground.kind,
    correct: proposedHs6 === null ? null : proposedHs6 === expectedHs6,
  };
}

const UNCERTAINTY_GROUNDS = new Set([
  "no_classification",
  "low_confidence",
  "missing_information",
]);

export interface CalibrationBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  /// Observed accuracy among rows in this bin that proposed a code.
  readonly accuracy: number | null;
  /// Mean stated confidence in the bin, for comparison against `accuracy`.
  readonly meanConfidence: number | null;
}

export interface Metrics {
  readonly rows: number;
  /// Rows where a code was proposed at all.
  readonly answered: number;
  /// Correct among answered. The figure usually meant by "accuracy".
  readonly top1AccuracyAnswered: number;
  /// Correct among all rows, counting an absent classification as incorrect.
  readonly top1AccuracyAll: number;

  readonly approved: number;
  /// Correct among approved. What a user of the system actually experiences.
  readonly approvedAccuracy: number | null;

  readonly declinedForUncertainty: number;
  /// Of those, how many would have been wrong had they been approved.
  /// Null when nothing was declined for uncertainty.
  readonly refusalPrecision: number | null;

  readonly refusedByPolicy: number;
  /// Policy refusals where the classification was nonetheless correct. High is
  /// good: it means policy refusals are not hiding classification failures.
  readonly policyRefusalsCorrectlyClassified: number;

  readonly calibration: readonly CalibrationBin[];
  /// Mean |confidence − correctness| over answered rows. 0 is perfect
  /// calibration; a confidently wrong model scores near 1.
  readonly calibrationError: number | null;

  readonly byJurisdiction: Readonly<Record<string, { rows: number; accuracy: number | null }>>;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function computeMetrics(
  scored: readonly ScoredRow[],
  binCount = 10,
): Metrics {
  const answered = scored.filter((r) => r.proposedHs6 !== null);
  const correct = answered.filter((r) => r.correct === true);

  const approved = scored.filter((r) => r.verdict === Verdict.Approved);
  const approvedCorrect = approved.filter((r) => r.correct === true);

  const uncertainty = scored.filter((r) => UNCERTAINTY_GROUNDS.has(r.groundKind));
  // A decline is "precise" when approving it would have been an error — either
  // the proposed code was wrong, or there was no code to approve.
  const uncertaintyWouldHaveErred = uncertainty.filter((r) => r.correct !== true);

  const policy = scored.filter(
    (r) => r.groundKind === "carrier_policy" || r.groundKind === "purpose_flag",
  );

  const calibration: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lower = i / binCount;
    const upper = (i + 1) / binCount;
    const inBin = answered.filter(
      (r) =>
        r.confidence >= lower &&
        (i === binCount - 1 ? r.confidence <= upper : r.confidence < upper),
    );
    calibration.push({
      lower,
      upper,
      count: inBin.length,
      accuracy:
        inBin.length === 0
          ? null
          : ratio(inBin.filter((r) => r.correct === true).length, inBin.length),
      meanConfidence:
        inBin.length === 0
          ? null
          : inBin.reduce((sum, r) => sum + r.confidence, 0) / inBin.length,
    });
  }

  const calibrationError =
    answered.length === 0
      ? null
      : answered.reduce(
          (sum, r) => sum + Math.abs(r.confidence - (r.correct === true ? 1 : 0)),
          0,
        ) / answered.length;

  const byJurisdiction: Record<string, { rows: number; accuracy: number | null }> = {};
  for (const j of new Set(scored.map((r) => r.jurisdiction))) {
    const rows = scored.filter((r) => r.jurisdiction === j);
    const ans = rows.filter((r) => r.proposedHs6 !== null);
    byJurisdiction[j] = {
      rows: rows.length,
      accuracy:
        ans.length === 0
          ? null
          : ratio(ans.filter((r) => r.correct === true).length, ans.length),
    };
  }

  return {
    rows: scored.length,
    answered: answered.length,
    top1AccuracyAnswered: ratio(correct.length, answered.length),
    top1AccuracyAll: ratio(correct.length, scored.length),
    approved: approved.length,
    approvedAccuracy:
      approved.length === 0 ? null : ratio(approvedCorrect.length, approved.length),
    declinedForUncertainty: uncertainty.length,
    refusalPrecision:
      uncertainty.length === 0
        ? null
        : ratio(uncertaintyWouldHaveErred.length, uncertainty.length),
    refusedByPolicy: policy.length,
    policyRefusalsCorrectlyClassified: policy.filter((r) => r.correct === true).length,
    calibration,
    calibrationError,
    byJurisdiction,
  };
}
