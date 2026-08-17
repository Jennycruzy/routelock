/// Pins the role hashes this package sends to chain against the Solidity source.
///
/// ## Why this file exists
///
/// `recover-escrow.ts` originally hard-coded `ORACLE_ROLE` as a hex literal, and
/// the literal was `keccak256("MINTER_ROLE")` — copied from an unrelated revert
/// while debugging a different chain. Nothing caught it. It typechecks, it is a
/// valid `bytes32`, and `hasRole` answers it perfectly happily with `false`.
///
/// The failure mode is what makes it worth a test: the script did not crash or
/// behave erratically. It reported, with complete confidence, that the deployer
/// **did not hold `ORACLE_ROLE`** — a false statement about live chain state,
/// produced by code that looked right. The only reason it cost nothing is that
/// the authority check ran before any transaction was sent, so the wrong answer
/// aborted the run instead of misdirecting money.
///
/// A 32-byte hex constant is unreadable by inspection, so "review it carefully"
/// is not a control. Deriving it is, and this asserts the derivation matches the
/// string the contracts actually hash.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { keccak256, toHex } from "viem";

import { ORACLE_ROLE } from "../scripts/recover-escrow.ts";

test("ORACLE_ROLE is keccak256 of the role name", () => {
  assert.equal(ORACLE_ROLE, keccak256(toHex("ORACLE_ROLE")));
});

test("ORACLE_ROLE is not any other role in the system", () => {
  // The specific confusion that occurred, plus its neighbours. Each of these is
  // a plausible paste and each would produce a silent, confident false negative.
  for (const other of [
    "MINTER_ROLE",
    "ISSUER_ROLE",
    "COMPLIANCE_ROLE",
    "ADMIN_ROLE",
    "FACTORY_ROLE",
    "REGISTRY_ROLE",
  ]) {
    assert.notEqual(ORACLE_ROLE, keccak256(toHex(other)), `collides with ${other}`);
  }
});

/// The check that would have caught the original bug: read the role name out of
/// the contracts rather than trusting this package's idea of it.
test("the role name matches the string RouteLockTypes.sol hashes", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../contracts/src/RouteLockTypes.sol", import.meta.url)),
    "utf8",
  );

  const declared = source.match(/ORACLE_ROLE\s*=\s*keccak256\("([^"]+)"\)/);
  assert.ok(declared, "could not find the ORACLE_ROLE declaration in RouteLockTypes.sol");
  assert.equal(ORACLE_ROLE, keccak256(toHex(declared[1] as string)));
});
