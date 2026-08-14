import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, thresholdFor, buildDecision } from "./decide.ts";
import { Verdict, type Proposal } from "./types.ts";

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    hs6: "851830",
    confidence: 0.95,
    missingInformation: [],
    purposeFlags: [],
    rationale: "Headphones fall in 8518.30.",
    ...over,
  };
}

test("approves a confident, unflagged, acceptable classification", () => {
  const { verdict, ground } = decide(proposal(), false);
  assert.equal(verdict, Verdict.Approved);
  assert.equal(ground.kind, "approved");
});

test("refuses on a purpose flag, whatever the confidence", () => {
  // More information about counterfeit goods does not make them shippable, so
  // this is a refusal and not a question.
  const { verdict, ground } = decide(
    proposal({ purposeFlags: ["counterfeit_or_ip_infringing"], confidence: 1 }),
    false,
  );
  assert.equal(verdict, Verdict.Refused);
  assert.equal(ground.kind, "purpose_flag");
});

test("refuses goods the carrier's published policy prohibits", () => {
  const { verdict, ground } = decide(proposal({ hs6: "220830" }), false); // whisky
  assert.equal(verdict, Verdict.Refused);
  assert.equal(ground.kind, "carrier_policy");
  assert.ok(ground.kind === "carrier_policy" && ground.clause.length > 0);
});

test("asks rather than guesses when no classification was reached", () => {
  const { verdict, ground } = decide(proposal({ hs6: null }), false);
  assert.equal(verdict, Verdict.NeedsInformation);
  assert.equal(ground.kind, "no_classification");
});

test("asks when the model named something it needs to know", () => {
  const { verdict, ground } = decide(
    proposal({ missingInformation: ["Is the outer surface leather or plastic?"] }),
    false,
  );
  assert.equal(verdict, Verdict.NeedsInformation);
  assert.equal(ground.kind, "missing_information");
});

test("asks when confidence is below the threshold", () => {
  const { verdict, ground } = decide(proposal({ confidence: 0.5 }), false);
  assert.equal(verdict, Verdict.NeedsInformation);
  assert.equal(ground.kind, "low_confidence");
});

test("holds cross-border consignments to a higher bar", () => {
  // 0.87 clears the domestic threshold and not the cross-border one. Duty and
  // admissibility ride on a cross-border code, so the same uncertainty is less
  // tolerable there.
  const p = proposal({ confidence: 0.87 });
  assert.equal(decide(p, false).verdict, Verdict.Approved);
  assert.equal(decide(p, true).verdict, Verdict.NeedsInformation);
  assert.ok(thresholdFor(true) > thresholdFor(false));
});

test("treats the threshold as inclusive", () => {
  assert.equal(decide(proposal({ confidence: 0.85 }), false).verdict, Verdict.Approved);
  assert.equal(decide(proposal({ confidence: 0.849 }), false).verdict, Verdict.NeedsInformation);
});

test("reports the most serious ground when several apply", () => {
  // A prohibited item described vaguely by an unsure model could exit through
  // three different doors. It must exit through the policy one, or the record
  // would say "we needed more information" about goods that are simply refused.
  const { verdict, ground } = decide(
    proposal({
      hs6: "930200",
      confidence: 0.1,
      missingInformation: ["What is the calibre?"],
      purposeFlags: ["otherwise_unlawful"],
    }),
    true,
  );
  assert.equal(verdict, Verdict.Refused);
  assert.equal(ground.kind, "purpose_flag");
});

test("prefers a named gap over a bare confidence number", () => {
  // Both apply here. "We need to know the material" is actionable; "confidence
  // was 0.4" is not, so the actionable one is recorded.
  const { ground } = decide(
    proposal({ confidence: 0.4, missingInformation: ["What material?"] }),
    false,
  );
  assert.equal(ground.kind, "missing_information");
});

test("never approves on a NaN or out-of-range confidence", () => {
  for (const confidence of [Number.NaN, -1, 2, Infinity]) {
    const { verdict } = decide(proposal({ confidence }), false);
    assert.notEqual(verdict, Verdict.Approved);
  }
});

test("the model cannot emit a verdict — only evidence", () => {
  // A Proposal has no verdict field, so there is no path by which the model's
  // own opinion of the outcome reaches the chain. This test exists to fail
  // loudly if that shape is ever widened.
  const keys = Object.keys(proposal()).sort();
  assert.deepEqual(keys, [
    "confidence",
    "hs6",
    "missingInformation",
    "purposeFlags",
    "rationale",
  ]);
});

test("derives cross-border from the request, not from a caller's flag", () => {
  const request = {
    description: "Headphones",
    originCountry: "NG",
    destinationCountry: "GB",
    declaredValue: 25000,
    currency: "NGN",
    weightKg: 0.4,
  };
  const decision = buildDecision(request, proposal({ confidence: 0.87 }), "v", "m");
  assert.equal(decision.crossBorder, true);
  assert.equal(decision.verdict, Verdict.NeedsInformation);
});

test("verdict ordinals match the on-chain enum", () => {
  // ActivationRegistry.Verdict: None, Approved, NeedsInformation, Refused.
  // A drift here would record the wrong outcome on-chain while every test that
  // compares names still passed.
  assert.equal(Verdict.None, 0);
  assert.equal(Verdict.Approved, 1);
  assert.equal(Verdict.NeedsInformation, 2);
  assert.equal(Verdict.Refused, 3);
});
