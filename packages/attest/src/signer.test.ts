/// Tests for the only function in the repo that can spend irreversibly.
///
/// Every test is a signature that must **not** be produced. There is no
/// success-path test that signs a real authorisation, because a passing test
/// suite must never be able to move money.

import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { makeRetirementSigner, SignatureRefused } from "./signer.ts";

// A throwaway key. It signs nothing real: every test here refuses before the
// signature is reached, except the one that checks a signature is well-formed.
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

function payload(over: Record<string, unknown> = {}) {
  return {
    domain: { name: "USDC", version: "2", chainId: 8453, verifyingContract: `0x${"22".repeat(20)}` },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: `0x${"33".repeat(20)}`,
      value: "28136", // 0.028136 USDC
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${"44".repeat(32)}`,
      ...over,
    },
  };
}

test("an authorisation from another account is refused", async () => {
  const sign = makeRetirementSigner(account, 1);

  await assert.rejects(
    () => sign(payload({ from: `0x${"99".repeat(20)}` })),
    (e: unknown) => e instanceof SignatureRefused && /another account/.test((e as Error).message),
  );
});

test("an authorisation with no value is refused", async () => {
  const sign = makeRetirementSigner(account, 1);

  await assert.rejects(
    () => sign(payload({ value: undefined })),
    (e: unknown) => e instanceof SignatureRefused && /blank cheque/.test((e as Error).message),
  );
});

test("an authorisation above the ceiling is refused", async () => {
  const sign = makeRetirementSigner(account, 1); // 1 USDC

  await assert.rejects(
    () => sign(payload({ value: "1000001" })), // 1.000001 USDC
    (e: unknown) => e instanceof SignatureRefused && /ceiling is 1 USDC/.test((e as Error).message),
  );
});

test("the ceiling is compared in atomic units, not whole USDC", async () => {
  // The unit bug this guards: treating a 6-decimal atomic value as whole USDC
  // would read 28136 as 28,136 USDC and refuse a 3-cent retirement — or, the
  // dangerous direction, read a huge atomic value as small.
  const sign = makeRetirementSigner(account, 1);
  const signature = await sign(payload({ value: "28136" })); // 0.028136 USDC

  assert.match(signature, /^0x[0-9a-f]{130}$/i);
});

test("a value exactly at the ceiling is allowed", async () => {
  const sign = makeRetirementSigner(account, 1);
  assert.match(await sign(payload({ value: "1000000" })), /^0x[0-9a-f]{130}$/i);
});

test("a fractional ceiling is honoured", async () => {
  const sign = makeRetirementSigner(account, 0.05);

  await assert.rejects(() => sign(payload({ value: "60000" })), SignatureRefused); // 0.06
  assert.match(await sign(payload({ value: "40000" })), /^0x[0-9a-f]{130}$/i); // 0.04
});

test("address comparison is case-insensitive", async () => {
  // Checksummed vs lowercase is not a policy difference.
  const sign = makeRetirementSigner(account, 1);
  assert.match(
    await sign(payload({ from: account.address.toLowerCase() })),
    /^0x[0-9a-f]{130}$/i,
  );
});

test("a huge value cannot slip past as a string", async () => {
  const sign = makeRetirementSigner(account, 1);

  await assert.rejects(
    () => sign(payload({ value: "999999999999999999999" })),
    SignatureRefused,
  );
});
