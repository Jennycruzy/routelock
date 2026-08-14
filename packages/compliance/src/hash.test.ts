import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex } from "viem";
import { canonicalJson, decisionHash, roundConfidence } from "./hash.ts";
import { buildDecision } from "./decide.ts";
import type { ClassificationRequest, Proposal } from "./types.ts";

const request: ClassificationRequest = {
  description: "Bluetooth over-ear headphones, retail packed",
  originCountry: "NG",
  destinationCountry: "GB",
  declaredValue: 25000,
  currency: "NGN",
  weightKg: 0.4,
};

const proposal: Proposal = {
  hs6: "851830",
  confidence: 0.95,
  missingInformation: [],
  purposeFlags: [],
  rationale: "Headphones fall in 8518.30.",
};

const decision = buildDecision(request, proposal, "compliance-0.1.0/hs-2022", "m");

test("canonical json sorts keys at every depth", () => {
  const json = canonicalJson(decision);
  const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
  assert.deepEqual(keys, [...keys].sort());

  const inner = Object.keys(
    (JSON.parse(json) as { request: Record<string, unknown> }).request,
  );
  assert.deepEqual(inner, [...inner].sort());
});

test("key order in the input cannot change the hash", () => {
  // The whole point: two services building the same decision from the same
  // facts must commit the same bytes, whatever order they happened to build
  // the object in.
  const reordered = {
    crossBorder: decision.crossBorder,
    ground: decision.ground,
    verdict: decision.verdict,
    proposal: {
      rationale: proposal.rationale,
      purposeFlags: proposal.purposeFlags,
      missingInformation: proposal.missingInformation,
      confidence: proposal.confidence,
      hs6: proposal.hs6,
    },
    request: {
      weightKg: request.weightKg,
      currency: request.currency,
      declaredValue: request.declaredValue,
      destinationCountry: request.destinationCountry,
      originCountry: request.originCountry,
      description: request.description,
    },
    model: decision.model,
    engineVersion: decision.engineVersion,
  } as typeof decision;

  assert.equal(decisionHash(reordered), decisionHash(decision));
});

test("array order is preserved, because order is meaning", () => {
  // "What material?" then "What size?" is a different record from the reverse.
  const a = buildDecision(
    request,
    { ...proposal, missingInformation: ["What material?", "What size?"] },
    "v",
    "m",
  );
  const b = buildDecision(
    request,
    { ...proposal, missingInformation: ["What size?", "What material?"] },
    "v",
    "m",
  );
  assert.notEqual(decisionHash(a), decisionHash(b));
});

test("the published bytes are exactly what is hashed", () => {
  // A verifier is given `canonical` and `hash`. If hashing the published string
  // did not reproduce the published hash, the audit claim would be empty.
  assert.equal(decisionHash(decision), keccak256(toHex(canonicalJson(decision))));
});

test("a different verdict is a different hash", () => {
  const refused = buildDecision(
    request,
    { ...proposal, purposeFlags: ["counterfeit_or_ip_infringing"] },
    "v",
    "m",
  );
  assert.notEqual(decisionHash(refused), decisionHash(decision));
});

test("the hash is a bytes32 hex string", () => {
  assert.match(decisionHash(decision), /^0x[0-9a-f]{64}$/);
});

test("engine version is part of the commitment", () => {
  // The rule that read the evidence is as much a part of a decision as the
  // evidence, so changing the threshold must change the hash.
  const other = buildDecision(request, proposal, "compliance-0.2.0/hs-2022", "m");
  assert.notEqual(decisionHash(other), decisionHash(decision));
});

test("confidence is rounded before it is committed", () => {
  // Floating point text is where two implementations most easily disagree.
  assert.equal(roundConfidence(0.8534567), 0.853);
  assert.equal(roundConfidence(1.5), 1);
  assert.equal(roundConfidence(-0.2), 0);
  assert.equal(roundConfidence(Number.NaN), 0);
});

test("non-ASCII descriptions hash stably through UTF-8", () => {
  const accented = buildDecision(
    { ...request, description: "Café equipment — piñata, 60 × 40 cm" },
    proposal,
    "v",
    "m",
  );
  assert.equal(decisionHash(accented), keccak256(toHex(canonicalJson(accented))));
  assert.match(decisionHash(accented), /^0x[0-9a-f]{64}$/);
});
