/// Load `.env` from the repository root, so a run does not depend on how the
/// caller happened to invoke it.
///
/// This exists because of a real failure. The documented command was
/// `set -a && . ./.env && set +a && VAR=… pnpm …`, it wrapped across two lines
/// in a terminal, the second line ran without the sourced environment, and the
/// script aborted with `COMPLIANCE_PRIVATE_KEY is not set`. Harmless there —
/// but a shell-quoting accident should not be able to change what the one
/// irreversible command in this project does.
///
/// Values already present in `process.env` always win, so an explicit
/// `VAR=x pnpm …` still overrides the file.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/// Parse and apply `.env`. Returns the names it set, never the values —
/// this file must not be a way for a secret to reach a log.
export function loadDotEnv(): readonly string[] {
  const path = resolve(repoRoot(), ".env");
  if (!existsSync(path)) return [];

  const applied: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // An explicit environment variable outranks the file, so the documented
    // override still works.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
