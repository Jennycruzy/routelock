import { test } from "node:test";
import assert from "node:assert/strict";
import { parseComputePolicyProposal } from "./propose.ts";

test("compute model output is contained before deterministic rules see it", () => {
  const proposal = parseComputePolicyProposal({
    policy_conflicts: ["uses a prohibited capability", 7],
    missing_information: ["image source", ""],
    confidence: 0.87654,
    rationale: "The policy text was attached.",
  });
  assert.deepEqual(proposal, {
    policyConflicts: ["uses a prohibited capability"],
    missingInformation: ["image source"],
    confidence: 0.877,
    rationale: "The policy text was attached.",
  });
});
