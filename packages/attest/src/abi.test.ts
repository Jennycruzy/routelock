/// Guards the constants in `abi.ts` against the Solidity they mirror.
///
/// Every value in that file is a hand-copied fact about a deployed contract.
/// The failure mode is silent and permanent: reorder `enum Verdict` in the
/// source and this package would keep sending ordinal 3 for `Refused` while the
/// contract reads it as something else, writing a wrong verdict on chain
/// forever. Nothing else in the build would notice.
///
/// So these tests read the contract source itself. They are deliberately
/// stricter than they need to be today, because the point is to fail on a
/// change nobody thought to check.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Verdict } from "@routelock/compliance";

import {
  ACTIVATION_REGISTRY_ABI,
  EntitlementState,
  ENTITLEMENT_STATE_NAMES,
} from "./abi.ts";

function contractSource(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../contracts/src/${name}`, import.meta.url)),
    "utf8",
  );
}

/// Pull the members of a Solidity enum, in declaration order.
function solidityEnum(source: string, name: string): readonly string[] {
  const match = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(match, `enum ${name} not found in source`);
  return match[1]!
    .split(",")
    .map((m) => m.replace(/\/\/.*$/gm, "").trim())
    .filter((m) => m.length > 0);
}

/// Pull a function's parameter types, in declaration order.
function solidityParams(source: string, name: string): readonly string[] {
  const match = new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`).exec(source);
  assert.ok(match, `function ${name} not found in source`);
  return match[1]!
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const type = p.split(/\s+/)[0]!;
      // Solidity writes the enum's name; the ABI encodes it as uint8.
      return type === "Verdict" ? "uint8" : type;
    });
}

test("Verdict ordinals match ActivationRegistry.sol exactly", () => {
  const members = solidityEnum(contractSource("ActivationRegistry.sol"), "Verdict");

  assert.deepEqual(members, ["None", "Approved", "NeedsInformation", "Refused"]);
  members.forEach((name, ordinal) => {
    assert.equal(
      Verdict[name as keyof typeof Verdict],
      ordinal,
      `Verdict.${name} must be ${ordinal} to match the contract`,
    );
  });
});

test("a Verdict added to Solidity without updating TypeScript fails here", () => {
  // The regression this file exists for, stated as a test rather than a comment.
  const members = solidityEnum(contractSource("ActivationRegistry.sol"), "Verdict");
  const tsMembers = Object.keys(Verdict).filter((k) => Number.isNaN(Number(k)));

  assert.deepEqual(tsMembers, [...members]);
});

test("EntitlementState ordinals match RouteLockTypes.sol exactly", () => {
  const members = solidityEnum(contractSource("RouteLockTypes.sol"), "EntitlementState");

  members.forEach((name, ordinal) => {
    assert.equal(
      EntitlementState[name as keyof typeof EntitlementState],
      ordinal,
      `EntitlementState.${name} must be ${ordinal} to match the contract`,
    );
  });
  assert.equal(members.length, Object.keys(ENTITLEMENT_STATE_NAMES).length);
});

test("every state has a name, so a revert never reports a bare number", () => {
  for (const [ordinal, name] of Object.entries(ENTITLEMENT_STATE_NAMES)) {
    assert.equal(typeof name, "string");
    assert.ok(name.length > 0, `state ${ordinal} has no name`);
  }
});

test("the ABI's write signatures match the contract source", () => {
  const source = contractSource("ActivationRegistry.sol");

  for (const fn of ["submitParcel", "recordDecision", "recordCarrier"] as const) {
    const entry = ACTIVATION_REGISTRY_ABI.find((e) => e.name === fn);
    assert.ok(entry, `${fn} missing from ABI`);

    assert.deepEqual(
      entry.inputs.map((i) => i.type),
      solidityParams(source, fn),
      `${fn} parameter types drifted from the contract`,
    );
  }
});

test("the ABI's parameter names match the contract source", () => {
  // Names do not affect encoding, but they are what a reader checks the call
  // site against, and a wrong name is a wrong explanation of a real transaction.
  const source = contractSource("ActivationRegistry.sol");
  const declared = /function\s+recordDecision\s*\(([^)]*)\)/.exec(source)?.[1] ?? "";
  const names = declared
    .split(",")
    .map((p) => p.trim().split(/\s+/).pop())
    .filter((n): n is string => n !== undefined && n.length > 0);

  const entry = ACTIVATION_REGISTRY_ABI.find((e) => e.name === "recordDecision");
  assert.deepEqual(entry?.inputs.map((i) => i.name), names);
});

test("the activations tuple matches the Activation struct field for field", () => {
  const source = contractSource("ActivationRegistry.sol");
  const struct = /struct\s+Activation\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";

  const fields = struct
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.endsWith(";"))
    .map((line) => {
      const [type, name] = line.slice(0, -1).trim().split(/\s+/);
      return { type: type === "Verdict" ? "uint8" : type!, name: name! };
    });

  const entry = ACTIVATION_REGISTRY_ABI.find((e) => e.name === "activations");
  assert.deepEqual(
    entry?.outputs.map((o) => ({ type: o.type, name: o.name })),
    fields,
  );
});

test("no write function in the ABI is marked view", () => {
  // A write silently typed as a view would read as success while changing
  // nothing on chain.
  for (const fn of ["submitParcel", "recordDecision", "recordCarrier"] as const) {
    const entry = ACTIVATION_REGISTRY_ABI.find((e) => e.name === fn);
    assert.equal(entry?.stateMutability, "nonpayable", `${fn} must not be a view`);
  }
});
