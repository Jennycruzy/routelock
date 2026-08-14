import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProposal, buildPrompt } from "./anthropic.ts";
import { decide } from "./decide.ts";
import { Verdict } from "./types.ts";

/// `parseProposal` is where a malformed or adversarial model response has to be
/// contained. Every unusable field must degrade toward asking, never toward
/// approving.

test("reads a well-formed tool call", () => {
  const p = parseProposal({
    hs6: "851830",
    confidence: 0.93,
    missing_information: [],
    purpose_flags: [],
    rationale: "Headphones.",
  });
  assert.equal(p.hs6, "851830");
  assert.equal(p.confidence, 0.93);
});

test("accepts a dotted code and normalises it", () => {
  assert.equal(parseProposal({ hs6: "8518.30" }).hs6, "851830");
});

test("rejects a code that is not six digits", () => {
  for (const hs6 of ["8518", "85183012", "abcdef", "", null, 851830]) {
    assert.equal(parseProposal({ hs6 }).hs6, null, `${String(hs6)} should not parse`);
  }
});

test("drops confidence when the classification could not be read", () => {
  // A high confidence attached to an unreadable code must not survive, or the
  // decision rule would see a confident proposal with no subject.
  const p = parseProposal({ hs6: "not-a-code", confidence: 0.99 });
  assert.equal(p.hs6, null);
  assert.equal(p.confidence, 0);
  assert.equal(decide(p, false).verdict, Verdict.NeedsInformation);
});

test("clamps and rounds confidence", () => {
  assert.equal(parseProposal({ hs6: "851830", confidence: 5 }).confidence, 1);
  assert.equal(parseProposal({ hs6: "851830", confidence: -3 }).confidence, 0);
  assert.equal(parseProposal({ hs6: "851830", confidence: 0.87654 }).confidence, 0.877);
});

test("treats a missing or non-numeric confidence as zero", () => {
  assert.equal(parseProposal({ hs6: "851830" }).confidence, 0);
  assert.equal(parseProposal({ hs6: "851830", confidence: "high" }).confidence, 0);
});

test("ignores purpose flags outside the enumeration", () => {
  // A model inventing its own flag name must not create a refusal ground that
  // no rule was written for.
  const p = parseProposal({
    hs6: "851830",
    confidence: 0.95,
    purpose_flags: ["counterfeit_or_ip_infringing", "vibes_are_off", 42],
  });
  assert.deepEqual(p.purposeFlags, ["counterfeit_or_ip_infringing"]);
});

test("drops empty questions rather than asking nothing", () => {
  const p = parseProposal({
    hs6: "851830",
    confidence: 0.95,
    missing_information: ["", "   ", "What material?"],
  });
  assert.deepEqual(p.missingInformation, ["What material?"]);
});

test("an empty tool input degrades to asking, never approving", () => {
  const p = parseProposal({});
  assert.equal(p.hs6, null);
  assert.equal(p.confidence, 0);
  assert.equal(decide(p, true).verdict, Verdict.NeedsInformation);
});

test("wrongly typed arrays do not throw", () => {
  const p = parseProposal({
    hs6: "851830",
    confidence: 0.9,
    missing_information: "not an array",
    purpose_flags: { nope: true },
  });
  assert.deepEqual(p.missingInformation, []);
  assert.deepEqual(p.purposeFlags, []);
});

test("the prompt states the route and whether it crosses a border", () => {
  const crossBorder = buildPrompt({
    description: "Headphones",
    originCountry: "NG",
    destinationCountry: "HK",
    declaredValue: 1,
    currency: "NGN",
    weightKg: 1,
  });
  assert.match(crossBorder, /NG to HK/);
  assert.match(crossBorder, /crosses a customs border/);

  const domestic = buildPrompt({
    description: "Headphones",
    originCountry: "NG",
    destinationCountry: "NG",
    declaredValue: 1,
    currency: "NGN",
    weightKg: 1,
  });
  assert.match(domestic, /domestic/);
  assert.doesNotMatch(domestic, /crosses a customs border/);
});

test("the prompt asks for a six-digit code and licenses refusal", () => {
  const prompt = buildPrompt({
    description: "Something",
    originCountry: "NG",
    destinationCountry: "GB",
    declaredValue: 1,
    currency: "NGN",
    weightKg: 1,
  });
  assert.match(prompt, /six-digit/);
  assert.match(prompt, /Declining is a correct answer/);
});
