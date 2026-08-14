import { test } from "node:test";
import assert from "node:assert/strict";
import { isCrossBorder, type ValidatedAddress } from "./types.ts";

function address(countryCode: string, country: string): ValidatedAddress {
  return {
    code: "1",
    formatted: `somewhere in ${country}`,
    country,
    countryCode,
    state: "",
    city: "",
  };
}

const lagos = address("NG", "Nigeria");
const portHarcourt = address("NG", "Nigeria");
const london = address("GB", "United Kingdom");
const hongKong = address("HK", "Hong Kong");

test("a domestic lane is not cross-border", () => {
  assert.equal(
    isCrossBorder({ origin: lagos, destination: portHarcourt }),
    false,
  );
});

test("recognises a cross-border lane in either direction", () => {
  assert.equal(isCrossBorder({ origin: lagos, destination: london }), true);
  assert.equal(isCrossBorder({ origin: london, destination: lagos }), true);
});

test("uses the resolved country code, not the country name", () => {
  // The carrier returns "Hong Kong" as a country in its own right, so a lane
  // into it from Nigeria crosses a customs border even though a name-based
  // check on a substring might not think so.
  assert.equal(isCrossBorder({ origin: lagos, destination: hongKong }), true);
});

test("does not assume a route — the same function serves any pair", () => {
  // Nothing in the adapter hardcodes an origin or destination. A judge in any
  // country must be able to put in their own lane, so this is asserted rather
  // than left to convention.
  const anywhere = address("SG", "Singapore");
  assert.equal(isCrossBorder({ origin: anywhere, destination: hongKong }), true);
  assert.equal(isCrossBorder({ origin: anywhere, destination: anywhere }), false);
});
