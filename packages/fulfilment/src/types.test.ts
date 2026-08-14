import { test } from "node:test";
import assert from "node:assert/strict";
import { FulfilmentError } from "./types.ts";

test("FulfilmentError reports the provider's own message and endpoint", () => {
  const err = new FulfilmentError("credit class not found", 404, "/retirements");

  assert.equal(err.message, "/retirements → 404: credit class not found");
  assert.equal(err.status, 404);
  assert.equal(err.endpoint, "/retirements");
  assert.equal(err.name, "FulfilmentError");
  assert.ok(err instanceof Error);
});

test("FulfilmentError preserves a provider message verbatim", () => {
  // The point of carrying the provider's wording is that a failure can be
  // traced back to its source, so nothing may be normalised or truncated.
  const raw = 'retirement failed: {"code":"INSUFFICIENT_SUPPLY","tonnes":0.01}';
  const err = new FulfilmentError(raw, 422, "/orders");

  assert.ok(err.message.includes(raw));
});
