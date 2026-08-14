import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryForHs6, CATEGORY_NAMES } from "./categories.ts";

test("every real HS chapter resolves to a routing category", () => {
  // Completeness is the property under test. An unmapped chapter previously
  // meant common goods — vehicle parts, leather, wood, base metals — could not
  // be quoted at all, which reads as a refusal without being one.
  const unresolved: string[] = [];
  for (let c = 1; c <= 97; c++) {
    const chapter = String(c).padStart(2, "0");
    if (chapter === "77") continue; // reserved by the WCO
    if (!categoryForHs6(`${chapter}0000`).ok) unresolved.push(chapter);
  }
  assert.deepEqual(unresolved, []);
});

test("routes vehicle parts, which are ordinary parcel goods", () => {
  const result = categoryForHs6("870899"); // parts of motor vehicles
  assert.ok(result.ok);
  assert.equal(result.category, CATEGORY_NAMES.machinery);
});

test("maps electrical goods to electronics", () => {
  const result = categoryForHs6("851762"); // network apparatus
  assert.ok(result.ok);
  assert.equal(result.category, CATEGORY_NAMES.electronics);
});

test("separates mechanical machinery from electrical goods", () => {
  // A carrier routes chapter 84 and 85 differently, so collapsing them would
  // be a real mis-route.
  const mechanical = categoryForHs6("841810");
  const electrical = categoryForHs6("850440");
  assert.ok(mechanical.ok && electrical.ok);
  assert.equal(mechanical.category, CATEGORY_NAMES.machinery);
  assert.equal(electrical.category, CATEGORY_NAMES.electronics);
});

test("routes goods the carrier will refuse", () => {
  // Routing and acceptance are separate questions. Tobacco still has a routing
  // category; whether it may be shipped is asked by `isAcceptable`, whose
  // refusal cites the policy clause. Answering both here would hide the reason.
  const result = categoryForHs6("240220"); // cigarettes
  assert.ok(result.ok);
});

test("rejects the WCO's reserved chapter", () => {
  const result = categoryForHs6("770000");
  assert.ok(!result.ok);
  assert.match(result.detail, /reserved/);
});

test("rejects anything that is not an HS-6", () => {
  for (const bad of ["8517", "85176201", "abcdef", "", "85 17 62", "000000"]) {
    const result = categoryForHs6(bad);
    assert.ok(!result.ok, `${bad} should not resolve`);
    assert.equal(result.reason, "malformed");
  }
});
