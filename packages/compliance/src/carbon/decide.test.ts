import assert from "node:assert/strict";
import { test } from "node:test";

import { Verdict } from "../types.ts";
import {
  CARBON_CONFIDENCE_THRESHOLD,
  decideCarbon,
  deterministicGround,
  MAX_VINTAGE_AGE_YEARS,
  RECOGNISED_REGISTRIES,
  unassessedProposal,
} from "./decide.ts";
import type { CarbonProposal, CarbonQualityRequest } from "./types.ts";

/// A class that should sail through, so each test can break exactly one thing.
function goodRequest(over: Partial<CarbonQualityRequest> = {}): CarbonQualityRequest {
  return {
    carbonClass: "0x0008f357",
    name: "Wind Energy - Small Scale",
    category: "renewable",
    country: "IN",
    methodologies: ["Energy Industries (renewable / non-renewable sources)"],
    registries: ["UCR"],
    projectIds: ["150", "164"],
    vintages: [2021, 2022],
    oldestVintage: 2021,
    oldestVintageAgeYears: 5,
    isRegistered: true,
    liquidityTonnes: 233_316,
    insufficientLiquidity: false,
    identityUnknown: false,
    tonnesRequested: 0.001,
    ...over,
  };
}

function goodProposal(over: Partial<CarbonProposal> = {}): CarbonProposal {
  return {
    methodologyStrength: "strong",
    permanenceRisk: "low",
    adverseFindings: [],
    integrityFlags: [],
    openQuestions: [],
    confidence: 0.95,
    rationale: "Grid-connected renewable generation with a standard methodology.",
    ...over,
  };
}

test("a sound credit with a confident assessment is approved", () => {
  const { verdict, ground } = decideCarbon(goodRequest(), goodProposal());

  assert.equal(verdict, Verdict.Approved);
  assert.equal(ground.kind, "approved");
});

test("the function is pure — same inputs, same verdict", () => {
  const req = goodRequest();
  const prop = goodProposal({ confidence: 0.91 });

  assert.deepEqual(decideCarbon(req, prop), decideCarbon(req, prop));
});

// --- integrity flags outrank everything ------------------------------------

test("an integrity flag refuses outright", () => {
  const { verdict, ground } = decideCarbon(
    goodRequest(),
    goodProposal({ integrityFlags: ["double_counting"] }),
  );

  assert.equal(verdict, Verdict.Refused);
  assert.equal(ground.kind, "integrity_flag");
});

test("no confidence score can overturn an integrity flag", () => {
  // The property that makes the flag a flag rather than a weight.
  const { verdict } = decideCarbon(
    goodRequest(),
    goodProposal({ confidence: 1, integrityFlags: ["fraud_finding"] }),
  );

  assert.equal(verdict, Verdict.Refused);
});

test("every integrity flag is reported, not just the first", () => {
  const { ground } = decideCarbon(
    goodRequest(),
    goodProposal({ integrityFlags: ["double_counting", "withdrawn_methodology"] }),
  );

  assert.equal(ground.kind, "integrity_flag");
  if (ground.kind === "integrity_flag") assert.equal(ground.flags.length, 2);
});

// --- deterministic facts outrank the model ---------------------------------

test("an unidentifiable class is referred however sure the model is", () => {
  const { verdict, ground } = decideCarbon(
    goodRequest({ identityUnknown: true }),
    goodProposal({ confidence: 1 }),
  );

  assert.equal(verdict, Verdict.NeedsInformation);
  assert.equal(ground.kind, "identity_unknown");
});

test("an unregistered class is referred", () => {
  const { verdict, ground } = decideCarbon(goodRequest({ isRegistered: false }), goodProposal());

  assert.equal(verdict, Verdict.NeedsInformation);
  assert.equal(ground.kind, "unregistered_class");
});

test("a class with no registry at all is referred", () => {
  const { verdict, ground } = decideCarbon(goodRequest({ registries: [] }), goodProposal());

  assert.equal(verdict, Verdict.NeedsInformation);
  assert.equal(ground.kind, "unregistered_class");
});

test("an unrecognised registry is referred rather than trusted", () => {
  const { verdict } = decideCarbon(
    goodRequest({ registries: ["SOME-NEW-REGISTRY"] }),
    goodProposal(),
  );

  assert.equal(verdict, Verdict.NeedsInformation);
});

test("registry matching is case-insensitive", () => {
  // The provider's casing is not a policy decision.
  assert.equal(decideCarbon(goodRequest({ registries: ["ucr"] }), goodProposal()).verdict, Verdict.Approved);
});

test("insufficient liquidity is referred, with the numbers", () => {
  const { verdict, ground } = decideCarbon(
    goodRequest({ liquidityTonnes: 0.0005, tonnesRequested: 0.001 }),
    goodProposal(),
  );

  assert.equal(verdict, Verdict.NeedsInformation);
  assert.equal(ground.kind, "insufficient_liquidity");
  if (ground.kind === "insufficient_liquidity") {
    assert.equal(ground.available, 0.0005);
    assert.equal(ground.requested, 0.001);
  }
});

test("the provider's own insufficiency flag is honoured even if the maths looks fine", () => {
  const { verdict } = decideCarbon(
    goodRequest({ insufficientLiquidity: true }),
    goodProposal(),
  );

  assert.equal(verdict, Verdict.NeedsInformation);
});

// --- model-derived grounds --------------------------------------------------

test("open questions are disclosed, not blocking", () => {
  // A careful assessment always has questions. Blocking on them made approval
  // unreachable and refused every class in live inventory.
  const { verdict } = decideCarbon(
    goodRequest(),
    goodProposal({ openQuestions: ["Is the buffer pool disclosed?", "Which vintage was verified?"] }),
  );

  assert.equal(verdict, Verdict.Approved);
});

test("adverse findings are disclosed, not blocking", () => {
  // The buyer chose this credit at this price. What is contested about it goes
  // on the record, hashed into the evidence set — it does not veto the sale.
  const { verdict } = decideCarbon(
    goodRequest(),
    goodProposal({
      adverseFindings: [
        "additionality contested for grid-connected wind in this market",
        "registry has less independent scrutiny than Verra",
      ],
    }),
  );

  assert.equal(verdict, Verdict.Approved);
});

test("a quality opinion never blocks, but an integrity defect always does", () => {
  // The line the whole design turns on.
  const quality = decideCarbon(
    goodRequest(),
    goodProposal({ methodologyStrength: "weak", permanenceRisk: "high", adverseFindings: ["contested"] }),
  );
  const integrity = decideCarbon(goodRequest(), goodProposal({ integrityFlags: ["double_counting"] }));

  assert.equal(quality.verdict, Verdict.Approved);
  assert.equal(integrity.verdict, Verdict.Refused);
});

test("weak methodology and high permanence risk are disclosed, not refused", () => {
  // These are opinions about a credit the market has already priced, not
  // evidence the credit is other than it claims to be.
  const { verdict } = decideCarbon(
    goodRequest(),
    goodProposal({ methodologyStrength: "weak", permanenceRisk: "high" }),
  );

  assert.equal(verdict, Verdict.Approved);
});

test("an over-age vintage is referred, not refused", () => {
  const { verdict, ground } = decideCarbon(
    goodRequest({ oldestVintageAgeYears: MAX_VINTAGE_AGE_YEARS + 1 }),
    goodProposal(),
  );

  assert.equal(verdict, Verdict.NeedsInformation);
  assert.equal(ground.kind, "vintage_too_old");
});

test("a vintage exactly at the limit is still approvable", () => {
  const { verdict } = decideCarbon(
    goodRequest({ oldestVintageAgeYears: MAX_VINTAGE_AGE_YEARS }),
    goodProposal(),
  );

  assert.equal(verdict, Verdict.Approved);
});

test("confidence below the bar is referred, reporting both numbers", () => {
  const { verdict, ground } = decideCarbon(
    goodRequest(),
    goodProposal({ confidence: CARBON_CONFIDENCE_THRESHOLD - 0.01 }),
  );

  assert.equal(verdict, Verdict.NeedsInformation);
  assert.equal(ground.kind, "low_confidence");
  if (ground.kind === "low_confidence") {
    assert.equal(ground.threshold, CARBON_CONFIDENCE_THRESHOLD);
  }
});

test("confidence exactly at the bar is approved", () => {
  const { verdict } = decideCarbon(
    goodRequest(),
    goodProposal({ confidence: CARBON_CONFIDENCE_THRESHOLD }),
  );

  assert.equal(verdict, Verdict.Approved);
});

test("the gate still refuses on facts alone, whatever the confidence bar is", () => {
  // This is what stops the threshold being load-bearing. Set it to zero and
  // these still refuse — the discrimination lives upstream of the number.
  const certain = goodProposal({ confidence: 1 });

  assert.notEqual(decideCarbon(goodRequest({ identityUnknown: true }), certain).verdict, Verdict.Approved);
  assert.notEqual(decideCarbon(goodRequest({ registries: ["CMARK"] }), certain).verdict, Verdict.Approved);
  assert.notEqual(decideCarbon(goodRequest({ liquidityTonnes: 0, tonnesRequested: 1 }), certain).verdict, Verdict.Approved);
  assert.equal(decideCarbon(goodRequest(), goodProposal({ confidence: 1, integrityFlags: ["fraud_finding"] })).verdict, Verdict.Refused);
});

test("the threshold is documented as picked, and is not the delivery bar", () => {
  // Pins the reasoning: 0.9 was calibrated for HS classification, a different
  // question. Copying it here refused the entire marketplace.
  assert.ok(CARBON_CONFIDENCE_THRESHOLD < 0.9);
  assert.ok(CARBON_CONFIDENCE_THRESHOLD > 0.5, "still has to mean something");
});

// --- ordering ---------------------------------------------------------------

test("the gate can actually open — the regression that started all this", () => {
  // A gate that only ever closes is not a gate. Every class in live inventory
  // was being refused; this pins that a realistic assessment can approve.
  const realistic = goodProposal({
    methodologyStrength: "moderate",
    permanenceRisk: "low",
    adverseFindings: ["additionality contested in this category"],
    openQuestions: ["are project-level verification reports public?"],
    confidence: 0.92,
  });

  assert.equal(decideCarbon(goodRequest(), realistic).verdict, Verdict.Approved);
});

test("a hard fact is reported ahead of low confidence", () => {
  // Ordering is the policy: report the reason that survives, not the vaguest one.
  const { ground } = decideCarbon(
    goodRequest({ identityUnknown: true }),
    goodProposal({ confidence: 0.1 }),
  );

  assert.equal(ground.kind, "identity_unknown");
});

test("an integrity flag is reported ahead of a missing identity", () => {
  const { ground } = decideCarbon(
    goodRequest({ identityUnknown: true }),
    goodProposal({ integrityFlags: ["fraud_finding"] }),
  );

  assert.equal(ground.kind, "integrity_flag");
});

test("refusal and needs-information are distinct outcomes, never collapsed", () => {
  const refused = decideCarbon(goodRequest(), goodProposal({ integrityFlags: ["double_counting"] }));
  const referred = decideCarbon(goodRequest({ identityUnknown: true }), goodProposal());

  assert.equal(refused.verdict, Verdict.Refused);
  assert.equal(referred.verdict, Verdict.NeedsInformation);
  assert.notEqual(refused.verdict, referred.verdict);
});

// --- skipping inference when the facts already decide ----------------------

test("a sound class needs the model — no short-circuit", () => {
  assert.equal(deterministicGround(goodRequest()), null);
});

test("an unidentifiable class is settled without paying for inference", () => {
  const ground = deterministicGround(goodRequest({ identityUnknown: true }));
  assert.equal(ground?.kind, "identity_unknown");
});

test("an unregistered class is settled without inference", () => {
  assert.equal(deterministicGround(goodRequest({ isRegistered: false }))?.kind, "unregistered_class");
});

test("an unrecognised registry is settled without inference", () => {
  assert.equal(
    deterministicGround(goodRequest({ registries: ["NOT-A-REGISTRY"] }))?.kind,
    "unregistered_class",
  );
});

test("insufficient liquidity is settled without inference", () => {
  assert.equal(
    deterministicGround(goodRequest({ liquidityTonnes: 0, tonnesRequested: 1 }))?.kind,
    "insufficient_liquidity",
  );
});

test("the short-circuit agrees with the full decision every time", () => {
  // If these ever disagreed, skipping the model would change the verdict —
  // which would make the saving a correctness bug.
  const cases = [
    goodRequest({ identityUnknown: true }),
    goodRequest({ isRegistered: false }),
    goodRequest({ registries: [] }),
    goodRequest({ liquidityTonnes: 0, tonnesRequested: 1 }),
  ];

  for (const req of cases) {
    const short = deterministicGround(req);
    assert.notEqual(short, null);
    const full = decideCarbon(req, unassessedProposal("short-circuit"));
    assert.equal(full.ground.kind, short!.kind);
    assert.equal(full.verdict, Verdict.NeedsInformation);
  }
});

test("an unassessed proposal states plainly that nothing was assessed", () => {
  const p = unassessedProposal("class identity could not be established");

  assert.equal(p.confidence, 0);
  assert.equal(p.rationale, "");
  assert.match(p.openQuestions[0]!, /no assessment was attempted/);
  // And it can never approve.
  assert.notEqual(decideCarbon(goodRequest(), p).verdict, Verdict.Approved);
});

test("the registry allowlist uses the provider's codes, not registry names", () => {
  // The bug this pins: "PURO" was written from memory; the endpoint returns
  // "PUR", and three of six live classes were refused as a result.
  assert.ok(RECOGNISED_REGISTRIES.includes("PUR"), "Puro.earth is PUR, not PURO");
  assert.ok(!RECOGNISED_REGISTRIES.includes("PURO"), "PURO is not a code the provider returns");
  assert.ok(RECOGNISED_REGISTRIES.includes("REGEN"));
});

test("CMARK stays out until somebody confirms what it denotes", () => {
  // Not an oversight — a deliberate refusal direction. Remove this test only
  // alongside evidence about what the code identifies.
  assert.ok(!RECOGNISED_REGISTRIES.includes("CMARK"));
});

test("every live registry code is either recognised or deliberately refused", () => {
  const observed = ["UCR", "REGEN", "PUR", "CMARK"];
  for (const code of observed) {
    const known = RECOGNISED_REGISTRIES.includes(code);
    assert.equal(typeof known, "boolean");
  }
  assert.equal(observed.filter((c) => !RECOGNISED_REGISTRIES.includes(c)).length, 1);
});
