import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, type ScoredRow } from "./metrics.ts";
import { Verdict } from "@routelock/compliance";

function row(over: Partial<ScoredRow> = {}): ScoredRow {
  return {
    reference: "R1",
    jurisdiction: "US",
    expectedHs6: "851830",
    proposedHs6: "851830",
    confidence: 0.95,
    verdict: Verdict.Approved,
    groundKind: "approved",
    correct: true,
    ...over,
  };
}

test("accuracy over answered rows ignores rows with no classification", () => {
  const m = computeMetrics([
    row(),
    row({ proposedHs6: null, correct: null, verdict: Verdict.NeedsInformation, groundKind: "no_classification" }),
  ]);
  assert.equal(m.answered, 1);
  assert.equal(m.top1AccuracyAnswered, 1);
  // Over all rows, an unanswered row still counts against the engine.
  assert.equal(m.top1AccuracyAll, 0.5);
});

test("refusal precision counts declines that would have been wrong", () => {
  // Two uncertainty declines: one would have been wrong, one would have been
  // right. Precision is 0.5 — half the caution was warranted.
  const m = computeMetrics([
    row({
      proposedHs6: "999999", correct: false, confidence: 0.4,
      verdict: Verdict.NeedsInformation, groundKind: "low_confidence",
    }),
    row({
      proposedHs6: "851830", correct: true, confidence: 0.4,
      verdict: Verdict.NeedsInformation, groundKind: "low_confidence",
    }),
  ]);
  assert.equal(m.declinedForUncertainty, 2);
  assert.equal(m.refusalPrecision, 0.5);
});

test("a decline with no classification counts as correctly declined", () => {
  const m = computeMetrics([
    row({
      proposedHs6: null, correct: null,
      verdict: Verdict.NeedsInformation, groundKind: "no_classification",
    }),
  ]);
  assert.equal(m.refusalPrecision, 1);
});

test("policy refusals are never pooled with uncertainty declines", () => {
  // Whisky: classified perfectly, refused on policy. Counting it as a good
  // refusal would inflate refusal precision with a case that had nothing to do
  // with uncertainty.
  const m = computeMetrics([
    row({ verdict: Verdict.Refused, groundKind: "carrier_policy", correct: true }),
    row({
      proposedHs6: "999999", correct: false, confidence: 0.3,
      verdict: Verdict.NeedsInformation, groundKind: "low_confidence",
    }),
  ]);
  assert.equal(m.refusedByPolicy, 1);
  assert.equal(m.declinedForUncertainty, 1);
  assert.equal(m.refusalPrecision, 1);
  assert.equal(m.policyRefusalsCorrectlyClassified, 1);
});

test("approved accuracy is what a user actually experiences", () => {
  const m = computeMetrics([
    row(),
    row({ proposedHs6: "999999", correct: false }),
    row({
      proposedHs6: "999999", correct: false, confidence: 0.2,
      verdict: Verdict.NeedsInformation, groundKind: "low_confidence",
    }),
  ]);
  // Two approvals, one right. The third error was caught before approval.
  assert.equal(m.approved, 2);
  assert.equal(m.approvedAccuracy, 0.5);
});

test("calibration bins report observed accuracy against stated confidence", () => {
  const m = computeMetrics(
    [
      row({ confidence: 0.95, correct: true }),
      row({ confidence: 0.95, correct: false, proposedHs6: "999999" }),
      row({ confidence: 0.15, correct: false, proposedHs6: "999999" }),
    ],
    10,
  );
  const top = m.calibration[9];
  assert.ok(top);
  assert.equal(top.count, 2);
  assert.equal(top.accuracy, 0.5); // claimed 0.95, delivered 0.5
  const low = m.calibration[1];
  assert.ok(low);
  assert.equal(low.count, 1);
  assert.equal(low.accuracy, 0);
});

test("a confidence of exactly 1 lands in the top bin", () => {
  const m = computeMetrics([row({ confidence: 1 })], 10);
  assert.equal(m.calibration[9]?.count, 1);
});

test("calibration error is zero for a perfectly calibrated set", () => {
  const m = computeMetrics([
    row({ confidence: 1, correct: true }),
    row({ confidence: 0, correct: false, proposedHs6: "999999" }),
  ]);
  assert.equal(m.calibrationError, 0);
});

test("calibration error approaches one for confident and wrong", () => {
  const m = computeMetrics([
    row({ confidence: 1, correct: false, proposedHs6: "999999" }),
  ]);
  assert.equal(m.calibrationError, 1);
});

test("reports accuracy per jurisdiction", () => {
  // The corpus draws on two authorities; a large gap between them would mean
  // the engine has learned one country's reading rather than the nomenclature.
  const m = computeMetrics([
    row({ jurisdiction: "US", correct: true }),
    row({ jurisdiction: "UK", correct: false, proposedHs6: "999999" }),
  ]);
  assert.equal(m.byJurisdiction["US"]?.accuracy, 1);
  assert.equal(m.byJurisdiction["UK"]?.accuracy, 0);
});

test("an empty set does not divide by zero", () => {
  const m = computeMetrics([]);
  assert.equal(m.rows, 0);
  assert.equal(m.refusalPrecision, null);
  assert.equal(m.calibrationError, null);
});
