/// The API must never be able to sign.
///
/// This is asserted structurally rather than trusted, in the same way
/// `SettlementEscrow` refuses `COMPLIANCE_ROLE` rather than merely not being
/// granted it. A served endpoint that could sign would be a way to reach the
/// deployer key over HTTP, and no amount of careful routing makes that safe.
///
/// The test reads this package's own source. It is deliberately a grep and not a
/// runtime check: a runtime check can only fail once the dangerous code exists
/// and runs, while this fails the moment it is written.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = dirname(fileURLToPath(import.meta.url));

/// Every way a key could reach this process, and one way a transaction could
/// leave it. `writeContract` and `sendTransaction` are included because a wallet
/// obtained by any other route would still have to call one of them.
const FORBIDDEN = [
  "privateKeyToAccount",
  "mnemonicToAccount",
  "hdKeyToAccount",
  "createWalletClient",
  "writeContract",
  "sendTransaction",
  "signTypedData",
  "signMessage",
  "decrypt-keystore",
  "unlockKeystoreAccount",
  "COMPLIANCE_PRIVATE_KEY",
  "PRIVATE_KEY",
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

test("no source file in the API can sign, hold a key, or send a transaction", () => {
  const files = sources(SRC);
  assert.ok(files.length >= 5, "expected to be reading real source files");

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // Comments are stripped first, because this file's own prose names every
    // forbidden symbol and the other files discuss signing deliberately. What
    // matters is whether the *code* can do it.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/^\s*\/\/\/.*$/gm, "");

    for (const symbol of FORBIDDEN) {
      assert.ok(
        !code.includes(symbol),
        `${file} references ${symbol}. The served API holds no key and signs ` +
          `nothing — every state change in RouteLock is an operator action.`,
      );
    }
  }
});

test("the signer the API installs refuses, whatever it is asked to sign", async () => {
  // Belt and braces on top of the grep above: even if a wallet appeared, the
  // callback the served adapter would invoke to authorise a payment throws.
  //
  // Tested directly rather than by attempting a `fulfil()`. A first attempt did
  // that and passed for the wrong reason — the hand-built order was malformed,
  // so it died in `idempotencyKey` long before reaching a signature, and the
  // assertion "it rejected" was satisfied by a `TypeError`. A refusal for the
  // wrong reason is not evidence of a refusal.
  const { refuseToSign } = await import("./rule.ts");

  await assert.rejects(refuseToSign, /never signs/);
});
