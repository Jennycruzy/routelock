/// The consumer relayer may write with the two narrowly-scoped deployment
/// identities. The customer signs only X Layer transactions; the configured
/// RouteLock/oracle relayer signs the issuer-side Base USDC authorization.
///
/// This is asserted structurally rather than trusted: the browser must not be
/// asked for a Base signature, and the server must use the bounded signer rather
/// than accepting a signature supplied by the caller.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { makeRetirementSigner } from "@routelock/attest";

const SRC = dirname(fileURLToPath(import.meta.url));

const CUSTOMER_PAYMENT_SIGNING_SYMBOLS = [
  "signTypedData",
  "signMessage",
  "eth_signTypedData_v4",
  "personal_sign",
] as const;

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

test("the browser is never asked to sign the Base payment", () => {
  const file = join(SRC, "consumer.ts");
  const text = readFileSync(file, "utf8");
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*\/\/\/.*$/gm, "");

  for (const symbol of CUSTOMER_PAYMENT_SIGNING_SYMBOLS) {
    assert.ok(
      !code.includes(symbol),
      `${file} references ${symbol}. The customer must not sign the Base ` +
        `authorization; the RouteLock relayer owns that payment.`,
    );
  }
  assert.match(code, /makeRetirementSigner/);
  assert.match(code, /fulfilSigned/);
});

test("the RouteLock signer rejects a Base authorization for another payer", async () => {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const sign = makeRetirementSigner(account, 1);
  const typedData = {
    domain: {},
    types: {},
    primaryType: "TransferWithAuthorization",
    message: {
      from: `0x${"22".repeat(20)}`,
      value: "28035",
    },
  };

  await assert.rejects(sign(typedData), /refusing to sign for another account/);
});
