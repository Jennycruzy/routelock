import { test } from "node:test";
import assert from "node:assert/strict";
import { getChain } from "@routelock/chain";
import { ShipbubbleAdapter } from "./adapter.ts";
import type { Consignment, Lane, ValidatedAddress } from "./types.ts";

const testnet = getChain("xlayer_testnet");
const mainnet = getChain("xlayer_mainnet");

/// Nothing here calls the network. What is under test is the shape the adapter
/// presents to the rest of the system, and the guarantees that hold before any
/// request is made.

function address(countryCode: string, city: string): ValidatedAddress {
  return {
    code: `code-${countryCode}-${city}`,
    formatted: `${city}, ${countryCode}`,
    country: countryCode,
    countryCode,
    state: "",
    city,
  };
}

const consignment: Consignment = {
  description: "Bluetooth over-ear headphones, retail packed",
  weightKg: 0.4,
  declaredValue: 25000,
  quantity: 1,
  lengthCm: 20,
  widthCm: 18,
  heightCm: 9,
};

const domestic: Lane = {
  origin: address("NG", "Port Harcourt"),
  destination: address("NG", "Lagos"),
};

const crossBorder: Lane = {
  origin: address("NG", "Port Harcourt"),
  destination: address("GB", "London"),
};

test("the adapter declares itself a reference implementation", () => {
  // docs/adapters.md is authoritative, and this is the code-side copy of it.
  // If delivery is ever deployed, both move together — never one alone.
  const adapter = new ShipbubbleAdapter(testnet, "sb_sandbox_example");

  assert.equal(adapter.vertical, "delivery");
  assert.equal(adapter.status, "reference");
});

test("environment pairing is enforced through the adapter too", () => {
  // The adapter must not become a way around the guard on the client beneath
  // it: constructing it builds the client, so a mispaired key is still a dead
  // process rather than a wrong shipment.
  assert.throws(
    () => new ShipbubbleAdapter(testnet, "sb_prod_example"),
    /LIVE carrier key/,
  );
  assert.throws(
    () => new ShipbubbleAdapter(mainnet, "sb_sandbox_example"),
    /sandbox key/,
  );
  assert.throws(
    () => new ShipbubbleAdapter(testnet, undefined),
    /no carrier key/,
  );
});

test("live is inherited from the client, not configured separately", () => {
  assert.equal(new ShipbubbleAdapter(testnet, "sb_sandbox_example").live, false);
  assert.equal(new ShipbubbleAdapter(mainnet, "sb_prod_example").live, true);
});

test("assess needs no network and no model", async () => {
  // Step 1 of the pipeline. Carbon fetches registry metadata here; delivery has
  // nothing to fetch because the shipper supplied the facts. The step still
  // exists so the pipeline shape is the same across verticals.
  const adapter = new ShipbubbleAdapter(testnet, "sb_sandbox_example");

  const facts = await adapter.assess({ lane: crossBorder, consignment });

  assert.equal(facts.description, consignment.description);
  assert.equal(facts.originCountry, "NG");
  assert.equal(facts.destinationCountry, "GB");
  assert.equal(facts.declaredValue, 25000);
  assert.equal(facts.weightKg, 0.4);
});

test("cross-border is computed from the resolved lane, never assumed", async () => {
  const adapter = new ShipbubbleAdapter(testnet, "sb_sandbox_example");

  const abroad = await adapter.assess({ lane: crossBorder, consignment });
  const home = await adapter.assess({ lane: domestic, consignment });

  assert.equal(abroad.crossBorder, true);
  assert.equal(home.crossBorder, false);
});

test("verify refuses rather than reporting a state it did not check", async () => {
  // Delivery is not deployed, so there is no account to verify against. The
  // honest answer is a refusal — returning `found: false` would imply a check
  // that never happened.
  const adapter = new ShipbubbleAdapter(testnet, "sb_sandbox_example");

  await assert.rejects(
    () => adapter.verify("SHIP-123"),
    /reference implementation/,
  );
});

test("the carrier client stays reachable for delivery-only calls", () => {
  // Address validation and cancellation are deliberately absent from the shared
  // port, because carbon and compute have no equivalent. They remain available
  // on the client beneath.
  const adapter = new ShipbubbleAdapter(testnet, "sb_sandbox_example");

  assert.equal(typeof adapter.client.validateAddress, "function");
  assert.equal(typeof adapter.client.cancelShipment, "function");
});
