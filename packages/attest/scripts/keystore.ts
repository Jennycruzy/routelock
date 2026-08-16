/// Unlocking the deployer key without the password touching this process.
///
/// The deploy script's rule is that the keystore password is typed by a human
/// at an interactive prompt, never passed on a command line where it would
/// land in shell history or a process listing. This keeps that rule while
/// still handing viem a signer.
///
/// `cast wallet decrypt-keystore` is spawned with **stdin inherited**, so the
/// password goes straight from the terminal into `cast`. It is never read,
/// buffered, logged or held by Node. Only the decrypted key comes back, on
/// stdout, and it stays in memory for the life of the run.
///
/// `--unsafe-password` and `CAST_UNSAFE_PASSWORD` exist and are deliberately
/// not used: both put the password somewhere another process can read it.

import { spawn } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";

export async function unlockKeystoreAccount(accountName: string): Promise<PrivateKeyAccount> {
  const key = await new Promise<string>((resolve, reject) => {
    const child = spawn("cast", ["wallet", "decrypt-keystore", accountName], {
      // stdin inherited: the human types into `cast`, not into us.
      stdio: ["inherit", "pipe", "inherit"],
      env: process.env,
    });

    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });

    child.on("error", (error) =>
      reject(new Error(`could not run \`cast\` — is Foundry on PATH? ${error.message}`)),
    );

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`cast wallet decrypt-keystore exited ${code} — wrong password?`));
        return;
      }
      // cast prints e.g. "<name>'s private key is: 0x…"
      const match = /(0x[0-9a-fA-F]{64})/.exec(out);
      if (match === null) {
        reject(new Error("could not find a private key in cast's output"));
        return;
      }
      resolve(match[1]!);
    });
  });

  return privateKeyToAccount(key as `0x${string}`);
}
