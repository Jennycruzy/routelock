import { test } from "node:test";
import assert from "node:assert/strict";
import { getChain } from "@routelock/chain";
import { ShipbubbleAdapter } from "./shipbubble.ts";

const testnet = getChain("xlayer_testnet");
const mainnet = getChain("xlayer_mainnet");

/// These construct the adapter and never call the network. The point under test
/// is that a wrongly paired key cannot produce a usable adapter *at all* — the
/// failure has to happen at construction, before any route exists to call.

test("a testnet chain accepts a sandbox key", () => {
  const adapter = new ShipbubbleAdapter(testnet, "sb_sandbox_example");
  assert.equal(adapter.live, false);
});

test("a mainnet chain accepts a live key", () => {
  const adapter = new ShipbubbleAdapter(mainnet, "sb_prod_example");
  assert.equal(adapter.live, true);
});

test("a live key on a testnet chain refuses to construct", () => {
  // This is how real shipments get bought by accident.
  assert.throws(
    () => new ShipbubbleAdapter(testnet, "sb_prod_example"),
    /LIVE carrier key/,
  );
});

test("a sandbox key on a mainnet chain refuses to construct", () => {
  // A mainnet deployment must never display a sandbox result.
  assert.throws(
    () => new ShipbubbleAdapter(mainnet, "sb_sandbox_example"),
    /sandbox key/,
  );
});

test("an absent key refuses to construct — there is no mock fallback", () => {
  assert.throws(() => new ShipbubbleAdapter(testnet, undefined), /no carrier key/);
  assert.throws(() => new ShipbubbleAdapter(testnet, ""), /no carrier key/);
});

test("an unrecognised key prefix refuses rather than guessing", () => {
  assert.throws(
    () => new ShipbubbleAdapter(testnet, "pk_live_something"),
    /neither the live/,
  );
});

test("liveness is derived from the chain, never configured separately", () => {
  // There is no constructor flag for this. A caller cannot ask a testnet
  // adapter to report itself as live, which is what lets `Quote.live` be
  // trusted as a label on the number it travels with.
  assert.equal(new ShipbubbleAdapter(testnet, "sb_sandbox_x").live, false);
  assert.equal(new ShipbubbleAdapter(mainnet, "sb_prod_x").live, true);
});
