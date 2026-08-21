import { test } from "node:test";
import assert from "node:assert/strict";
import { getChain } from "@routelock/chain";
import { CarbonmarkAdapter } from "./adapter.ts";
import { isPlaceholderRetirement, registryOf } from "./types.ts";

const testnet = getChain("xlayer_testnet");
const mainnet = getChain("xlayer_mainnet");
const botchain = getChain("botchain_testnet");
const SANDBOX = "cm_api_sandbox_example";

/// Nothing here calls the network. What is under test is the shape the adapter
/// presents and the guarantees that hold before any request is made.

test("the adapter declares carbon, and does not claim to be active", () => {
  // docs/adapters.md is authoritative; this is its code-side copy. It moves to
  // "active" only once a real retirement has produced a public certificate.
  const adapter = new CarbonmarkAdapter(testnet, SANDBOX);

  assert.equal(adapter.vertical, "carbon");
  assert.equal(adapter.status, "in_development");
});

test("BOT Chain cannot construct the REST carbon adapter either", () => {
  assert.throws(
    () => new CarbonmarkAdapter(botchain, SANDBOX),
    /BOT Chain Testnet does not allow the carbon fulfilment lane/,
  );
});

test("a retirement is irreversible, and the adapter says so", () => {
  // Nothing can un-retire a credit. `reversible: false` is why the shared port
  // carries no cancel() — a uniform one would have to throw here.
  const adapter = new CarbonmarkAdapter(testnet, SANDBOX);

  assert.equal(adapter.reversible, false);
});

test("environment pairing is enforced through the adapter", () => {
  // Carbonmark has no separate sandbox host — both environments answer on the
  // same domain — so the key prefix is the only thing keeping a mainnet
  // retirement off a sandbox credential.
  assert.throws(
    () => new CarbonmarkAdapter(mainnet, SANDBOX),
    /must never display a sandbox result/,
  );
  assert.throws(
    () => new CarbonmarkAdapter(testnet, undefined),
    /no Carbonmark key/,
  );
  assert.throws(
    () => new CarbonmarkAdapter(testnet, "sb_sandbox_example"),
    /matches neither the live/,
  );
});

test("no key can construct a mainnet adapter while the live prefix is unknown", () => {
  // Production access has not been granted, so no production key has been seen
  // and its prefix cannot be known. Guessing one would defeat the guard.
  for (const candidate of [SANDBOX, "cm_api_prod_guess", "cm_api_live_guess"]) {
    assert.throws(() => new CarbonmarkAdapter(mainnet, candidate), /FATAL/);
  }
});

test("registry is read from the project id, and unknown when it cannot be", () => {
  // 25 of 723 live listings carried no usable project id. A credit whose
  // provenance cannot be established is a fact for the engine to rule on, never
  // one to default quietly.
  assert.equal(registryOf("VCS-1529"), "VCS");
  assert.equal(registryOf("ICR-112"), "ICR");
  assert.equal(registryOf("TVER-0"), "TVER");
  assert.equal(registryOf("vcs-1529"), "VCS");
  assert.equal(registryOf(""), "UNKNOWN");
  assert.equal(registryOf("SOMETHING-ELSE"), "UNKNOWN");
});

test("a receipt that names someone else is not evidence for this order", () => {
  // Carbonmark's test mode does not retire anything. It completes the order and
  // returns a shared placeholder from April 2024 whose beneficiary is
  // "Developer Tester" — and whose own record says it must not be delivered to
  // customers, because the environmental benefit was already claimed.
  //
  // The check is deliberately general rather than a match on that one page: a
  // receipt describing something other than what was asked for cannot support
  // the claim made of it, whatever the provider called it.
  assert.equal(isPlaceholderRetirement("RouteLock", "Developer Tester"), true);
  assert.equal(isPlaceholderRetirement("RouteLock", "RouteLock"), false);
  assert.equal(isPlaceholderRetirement("RouteLock", "  routelock "), false);
  assert.equal(isPlaceholderRetirement("RouteLock", ""), true);
  assert.equal(isPlaceholderRetirement("RouteLock", null), true);
  assert.equal(isPlaceholderRetirement("RouteLock", undefined), true);
});
