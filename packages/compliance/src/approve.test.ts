import { test } from "node:test";
import assert from "node:assert/strict";
import { approve } from "./approve.ts";
import { buildDecision } from "./decide.ts";
import { canonicalHash, decisionHash } from "./hash.ts";
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

test("approve works for a carbon decision, with no cast", () => {
  // The carbon path used to need `decision as never` to call this, which
  // bypassed the gate at the one call site the gate exists for.
  const carbonDecision = {
    engineVersion: "compliance-1.0.0",
    model: "claude-sonnet-5",
    verdict: Verdict.Approved,
    irreversible: true as const,
    proposal: { confidence: 0.82 },
  };

  const approved = approve({ tonnes: 0.001 }, carbonDecision);
  assert.notEqual(approved, null);
  assert.ok(approved!.decisionHash.startsWith("0x"));
});

test("a refused carbon decision still yields nothing to fulfil with", () => {
  assert.equal(
    approve({ tonnes: 0.001 }, { verdict: Verdict.Refused, model: "claude-sonnet-5" }),
    null,
  );
  assert.equal(
    approve({ tonnes: 0.001 }, { verdict: Verdict.NeedsInformation, model: "claude-sonnet-5" }),
    null,
  );
});

test("the hash approve computes is the hash the attestation commits", () => {
  // These must be the same bytes: the value that authorised the spend and the
  // value written on chain. They are produced by different call sites, so the
  // agreement is asserted rather than assumed.
  const decision = { verdict: Verdict.Approved, model: "claude-sonnet-5", proposal: { confidence: 1 } };
  const approved = approve({ tonnes: 0.001 }, decision);

  assert.equal(approved!.decisionHash, canonicalHash(decision));
});
