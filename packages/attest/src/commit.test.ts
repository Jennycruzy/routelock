import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toHex } from "viem";

import { commit, commitVerbatim, UNRECORDED, verifyCommitment } from "./commit.ts";

test("a canonical commitment is independent of key order", () => {
  const a = commit({ beneficiary: "RouteLock", tonnes: 0.001, credit: "wind" });
  const b = commit({ tonnes: 0.001, credit: "wind", beneficiary: "RouteLock" });

  assert.equal(a.hash, b.hash);
  assert.equal(a.preimage, b.preimage);
});

test("array order is preserved, because order is meaning", () => {
  const a = commit({ vintages: [2021, 2022] });
  const b = commit({ vintages: [2022, 2021] });

  assert.notEqual(a.hash, b.hash);
});

test("a verbatim commitment preserves the provider's bytes exactly", () => {
  // Deliberately not canonical: unsorted keys, odd spacing, trailing newline.
  // A provider's response is evidence, and reshaping evidence destroys it.
  const raw = '{ "status":"COMPLETED",  "amount": 0.001 }\n';
  const c = commitVerbatim(raw);

  assert.equal(c.preimage, raw);
  assert.equal(c.encoding, "verbatim-utf8");
  assert.equal(c.hash, keccak256(toHex(raw)));
});

test("verbatim and canonical disagree on the same JSON, as they must", () => {
  const raw = '{"b":2,"a":1}';

  // The canonical route sorts keys; the verbatim route does not touch them.
  assert.notEqual(commitVerbatim(raw).hash, commit(JSON.parse(raw)).hash);
});

test("a verifier needs only keccak over the published preimage", () => {
  // The property that makes third-party verification cheap: no JSON library,
  // no key sorting, no knowledge of our canonicalisation rules.
  const canonical = commit({ z: 1, a: { d: 4, c: 3 } });
  const verbatim = commitVerbatim("tracking-12345");

  assert.equal(keccak256(toHex(canonical.preimage)), canonical.hash);
  assert.equal(keccak256(toHex(verbatim.preimage)), verbatim.hash);
  assert.ok(verifyCommitment(canonical));
  assert.ok(verifyCommitment(verbatim));
});

test("a tampered preimage fails verification", () => {
  const c = commit({ tonnes: 0.001 });
  const tampered = { ...c, preimage: c.preimage.replace("0.001", "1000") };

  assert.equal(verifyCommitment(tampered), false);
});

test("a tampered hash fails verification", () => {
  const c = commitVerbatim("tracking-12345");
  const tampered = { ...c, hash: keccak256(toHex("tracking-99999")) };

  assert.equal(verifyCommitment(tampered), false);
});

test("undefined-valued keys are dropped, so absent and undefined agree", () => {
  const a = commit({ ref: "x", note: undefined });
  const b = commit({ ref: "x" });

  assert.equal(a.hash, b.hash);
});

test("null is committed, because null is a stated value", () => {
  const a = commit({ price: null });
  const b = commit({});

  assert.notEqual(a.hash, b.hash);
});

test("nested objects are sorted at every depth", () => {
  const a = commit({ outer: { z: 1, a: { y: 2, b: 3 } } });
  const b = commit({ outer: { a: { b: 3, y: 2 }, z: 1 } });

  assert.equal(a.hash, b.hash);
});

test("UNRECORDED is the zero bytes32 the contract holds for an empty field", () => {
  assert.equal(UNRECORDED, `0x${"0".repeat(64)}`);
  assert.equal(UNRECORDED.length, 66);
});

test("an empty string commits to a real hash, not the zero hash", () => {
  // Otherwise "nothing recorded" and "recorded as empty" would be
  // indistinguishable on chain.
  assert.notEqual(commitVerbatim("").hash, UNRECORDED);
});

test("non-ASCII survives the round trip", () => {
  const c = commitVerbatim("USD₮0 — 0.001 t retired");
  assert.ok(verifyCommitment(c));
});
