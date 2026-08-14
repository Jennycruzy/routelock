import { test } from "node:test";
import assert from "node:assert/strict";
import { isAcceptable } from "./policy.ts";

/// Each refusal below traces to a named phrase in Shipbubble's published
/// "Prohibited products" clause. The tests assert the *clause*, not just the
/// outcome, so a rule cannot drift away from the policy it claims to implement.

test("refuses the five categories the policy names", () => {
  for (const [hs6, clause] of [
    ["010121", "live plants and animals"], // live horses
    ["060210", "live plants and animals"], // live plants
    ["240220", "tobacco"], // cigarettes
    ["300490", "prescription pharmaceuticals"], // medicaments
    ["930200", "ammunition and firearms"], // revolvers and pistols
    ["220830", "alcoholic beverages"], // whisky
  ] as const) {
    const result = isAcceptable(hs6);
    assert.ok(!result.ok, `${hs6} should be refused`);
    assert.equal(result.clause, clause);
  }
});

test("splits chapter 22 at the heading, not the chapter", () => {
  // 2201 and 2202 are water and soft drinks; 2203-2208 are alcoholic. Refusing
  // the whole chapter would block bottled water, and permitting it would ship
  // whisky. Both errors are real, in opposite directions.
  assert.equal(isAcceptable("220110").ok, true); // mineral water
  assert.equal(isAcceptable("220210").ok, true); // sweetened soft drinks
  assert.equal(isAcceptable("220300").ok, false); // beer
  assert.equal(isAcceptable("220421").ok, false); // wine
  assert.equal(isAcceptable("220870").ok, false); // liqueurs
});

test("permits ordinary goods", () => {
  for (const hs6 of [
    "851762", // network apparatus
    "620520", // men's cotton shirts
    "870899", // vehicle parts
    "420292", // travel bags
    "180690", // chocolate
  ]) {
    assert.equal(isAcceptable(hs6).ok, true, `${hs6} should be acceptable`);
  }
});

test("does not refuse goods the policy never mentions", () => {
  // These were refused by an earlier hand-written table that had no source.
  // The published policy says nothing about them, so neither does this.
  for (const hs6 of [
    "271019", // petroleum oils
    "280110", // chlorine
    "290511", // methanol
    "310210", // urea fertiliser
    "970110", // paintings
  ]) {
    assert.equal(
      isAcceptable(hs6).ok,
      true,
      `${hs6} is not named in the policy and must not be refused`,
    );
  }
});

test("every refusal cites its clause and its source", () => {
  const result = isAcceptable("220830");
  assert.ok(!result.ok);
  assert.ok(result.clause.length > 0);
  assert.ok(result.reason.length > 0);
  assert.match(result.source, /shipbubble\.com\/terms-and-conditions/);
});

test("rejects anything that is not an HS-6", () => {
  for (const bad of ["2208", "abcdef", ""]) {
    assert.equal(isAcceptable(bad).ok, false);
  }
});
