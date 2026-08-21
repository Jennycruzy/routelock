/// Unlock a Foundry keystore only when a write actually needs the role.
///
/// The password is entered by the operator directly into `cast`. It is never
/// passed on a command line, read by this process, or written to a log.

import { spawn } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";

export async function unlockKeystoreAccount(accountName: string): Promise<PrivateKeyAccount> {
  const key = await new Promise<string>((resolve, reject) => {
    const child = spawn("cast", ["wallet", "decrypt-keystore", accountName], {
      stdio: ["inherit", "pipe", "inherit"],
      env: process.env,
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`could not run cast — is Foundry on PATH? ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`cast wallet decrypt-keystore exited ${code} — wrong password?`));
        return;
      }
      const match = /(0x[0-9a-fA-F]{64})/.exec(output);
      if (match === null) {
        reject(new Error("could not find a private key in cast output"));
        return;
      }
      resolve(match[1]!);
    });
  });

  return privateKeyToAccount(key as `0x${string}`);
}
