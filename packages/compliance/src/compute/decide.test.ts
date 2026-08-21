import { test } from "node:test";
import assert from "node:assert/strict";
import { Verdict } from "../types.ts";
import { COMPUTE_CONFIDENCE_THRESHOLD, decideCompute } from "./decide.ts";

const proposal = {
  policyConflicts: [],
  missingInformation: [],
  confidence: 0.9,
  rationale: "The workload is described and no conflict was found.",
} as const;

test("compute policy conflicts refuse before confidence is considered", () => {
  const result = decideCompute({ ...proposal, policyConflicts: ["policy clause"] });
  assert.equal(result.verdict, Verdict.Refused);
  assert.equal(result.ground.kind, "policy_conflict");
});

test("missing workload information needs information", () => {
  const result = decideCompute({ ...proposal, missingInformation: ["image behavior"] });
  assert.equal(result.verdict, Verdict.NeedsInformation);
  assert.equal(result.ground.kind, "missing_information");
});

test("the chosen compute confidence bar is deterministic", () => {
  assert.equal(decideCompute({ ...proposal, confidence: COMPUTE_CONFIDENCE_THRESHOLD }).verdict, Verdict.Approved);
  assert.equal(decideCompute({ ...proposal, confidence: COMPUTE_CONFIDENCE_THRESHOLD - 0.001 }).verdict, Verdict.NeedsInformation);
});
