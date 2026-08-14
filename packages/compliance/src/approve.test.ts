import { test } from "node:test";
import assert from "node:assert/strict";
import { approve } from "./approve.ts";
import { buildDecision } from "./decide.ts";
import { decisionHash } from "./hash.ts";
import { Verdict } from "./types.ts";
import type { ClassificationRequest, Proposal } from "./types.ts";

const request: ClassificationRequest = {
  description: "Bluetooth over-ear headphones, retail packed",
  originCountry: "NG",
  destinationCountry: "GB",
  declaredValue: 25000,
  currency: "NGN",
  weightKg: 0.4,
};

const order = { lane: "PHC→LOS", quantity: 1 };

function decisionFrom(proposal: Proposal) {
  return buildDecision(request, proposal, "compliance-0.1.0/hs-2022", "m");
}

test("an approved decision yields a token carrying its own hash", () => {
  const decision = decisionFrom({
    hs6: "851830",
    confidence: 0.95,
    missingInformation: [],
    purposeFlags: [],
    rationale: "Headphones fall in 8518.30.",
  });
  assert.equal(decision.verdict, Verdict.Approved);

  const approved = approve(order, decision);

  assert.ok(approved !== null);
  assert.deepEqual(approved.order, order);
  assert.equal(approved.decisionHash, decisionHash(decision));
});

test("needs-information is not a soft yes", () => {
  // The verdict most likely to be mistaken for one: the engine is asking for
  // facts, and treating that as approval is exactly the failure the gate exists
  // to prevent.
  const decision = decisionFrom({
    hs6: "851830",
    confidence: 0.95,
    missingInformation: ["Is the battery lithium-ion, and is it installed?"],
    purposeFlags: [],
    rationale: "Battery chemistry changes the answer.",
  });
  assert.equal(decision.verdict, Verdict.NeedsInformation);

  assert.equal(approve(order, decision), null);
});

test("a refusal yields nothing to fulfil with", () => {
  const decision = decisionFrom({
    hs6: null,
    confidence: 0.1,
    missingInformation: [],
    purposeFlags: ["counterfeit_or_ip_infringing"],
    rationale: "Description indicates counterfeit branded goods.",
  });
  assert.equal(decision.verdict, Verdict.Refused);

  assert.equal(approve(order, decision), null);
});

test("low confidence alone withholds the token", () => {
  const decision = decisionFrom({
    hs6: "851830",
    confidence: 0.4,
    missingInformation: [],
    purposeFlags: [],
    rationale: "Plausible but not certain.",
  });

  assert.notEqual(decision.verdict, Verdict.Approved);
  assert.equal(approve(order, decision), null);
});

test("the hash commits to the decision, so a changed decision changes the token", () => {
  const first = decisionFrom({
    hs6: "851830",
    confidence: 0.95,
    missingInformation: [],
    purposeFlags: [],
    rationale: "Headphones fall in 8518.30.",
  });
  const second = decisionFrom({
    hs6: "851830",
    confidence: 0.99,
    missingInformation: [],
    purposeFlags: [],
    rationale: "Headphones fall in 8518.30.",
  });

  const a = approve(order, first);
  const b = approve(order, second);

  assert.ok(a !== null && b !== null);
  assert.notEqual(a.decisionHash, b.decisionHash);
});
