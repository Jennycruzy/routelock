import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryForHs6, CATEGORY_NAMES } from "./categories.ts";

test("maps electrical goods to the carrier's electronics bucket", () => {
  // 8517.62 — telephones and network apparatus.
  const result = categoryForHs6("851762");
  assert.ok(result.ok);
  assert.equal(result.category, CATEGORY_NAMES.electronics);
});

test("maps apparel to fashion", () => {
  const result = categoryForHs6("620520"); // men's cotton shirts
  assert.ok(result.ok);
  assert.equal(result.category, CATEGORY_NAMES.fashion);
});

test("maps pharmaceuticals to medical supplies", () => {
  const result = categoryForHs6("300490");
  assert.ok(result.ok);
  assert.equal(result.category, CATEGORY_NAMES.medical);
});

test("separates machinery from electronics", () => {
  // Chapter 84 is mechanical, 85 is electrical. A carrier routes them
  // differently, so collapsing the two would be a real mis-route.
  const mechanical = categoryForHs6("841810");
  const electrical = categoryForHs6("850440");
  assert.ok(mechanical.ok && electrical.ok);
  assert.equal(mechanical.category, CATEGORY_NAMES.machinery);
  assert.equal(electrical.category, CATEGORY_NAMES.electronics);
});

test("refuses goods a carrier will not knowingly accept", () => {
  for (const [hs6, expected] of [
    ["010121", "live animals"],
    ["240220", "tobacco products"],
    ["360200", "explosives and pyrotechnics"],
    ["930200", "arms and ammunition"],
  ] as const) {
    const result = categoryForHs6(hs6);
    assert.ok(!result.ok, `${hs6} should be refused`);
    assert.equal(result.reason, "refused");
    assert.equal(result.detail, expected);
  }
});

test("distinguishes a refusal from an unmapped chapter", () => {
  // These are different outcomes and must not collapse into one "unknown".
  // A refusal is a decision; unmapped means the table has nothing to say.
  const refused = categoryForHs6("930200"); // arms
  const unmapped = categoryForHs6("250100"); // salt — no carrier bucket fits
  assert.ok(!refused.ok && !unmapped.ok);
  assert.equal(refused.reason, "refused");
  assert.equal(unmapped.reason, "unmapped");
});

test("never falls back to a general bucket", () => {
  // A default would let refused goods be quoted and bought as ordinary parcels,
  // which is exactly the failure the compliance gate exists to prevent.
  const result = categoryForHs6("360200");
  assert.ok(!result.ok);
});

test("rejects anything that is not an HS-6", () => {
  for (const bad of ["8517", "85176201", "abcdef", "", "85 17 62"]) {
    const result = categoryForHs6(bad);
    assert.ok(!result.ok, `${bad} should not resolve`);
    assert.equal(result.reason, "unmapped");
  }
});
