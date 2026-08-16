import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  capsFromEnv,
  DEFAULT_CAPS,
  estimateCostUsd,
  InferenceBudget,
  InferenceBudgetExceeded,
  ledgerPath,
} from "./budget.ts";

function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), "routelock-budget-")), "calls.jsonl");
}

test("a fresh ledger has spent nothing", () => {
  const budget = new InferenceBudget(tempLedger());

  assert.equal(budget.callsUsed, 0);
  assert.equal(budget.spentUsd, 0);
  assert.equal(budget.callsRemaining, DEFAULT_CAPS.maxCalls);
});

test("a missing ledger file is an empty ledger, not an error", () => {
  const budget = new InferenceBudget("/nonexistent/dir/calls.jsonl");
  assert.doesNotThrow(() => budget.callsUsed);
  assert.equal(budget.callsUsed, 0);
});

test("cost is estimated from the published rate table", () => {
  // 1M input at $2 + 1M output at $10 = $12
  assert.equal(estimateCostUsd("claude-sonnet-5", 1_000_000, 1_000_000), 12);
  // A realistic single decision: ~2k in, ~600 out
  const cost = estimateCostUsd("claude-sonnet-5", 2000, 600);
  assert.ok(cost > 0.009 && cost < 0.011, `expected ~$0.01, got $${cost}`);
});

test("an unknown model is priced at the worst known rate, never free", () => {
  const unknown = estimateCostUsd("some-future-model", 1_000_000, 1_000_000);
  const worst = estimateCostUsd("claude-opus-5", 1_000_000, 1_000_000);

  assert.equal(unknown, worst);
  assert.ok(unknown > 0, "an unrecognised model must never estimate as free");
});

test("a recorded call is written to disk before it is returned", () => {
  const path = tempLedger();
  const budget = new InferenceBudget(path);

  budget.record({
    model: "claude-sonnet-5",
    purpose: "carbon-quality",
    inputTokens: 2000,
    outputTokens: 600,
  });

  // Read the file directly — the promise is durability, not in-memory state.
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const written = JSON.parse(lines[0]!);
  assert.equal(written.purpose, "carbon-quality");
  assert.equal(written.inputTokens, 2000);
  assert.ok(written.at.endsWith("Z"), "timestamp must be ISO 8601 UTC");
});

test("spend accumulates across calls", () => {
  const budget = new InferenceBudget(tempLedger());
  for (let i = 0; i < 3; i += 1) {
    budget.record({
      model: "claude-sonnet-5",
      purpose: "carbon-quality",
      inputTokens: 2000,
      outputTokens: 600,
    });
  }

  assert.equal(budget.callsUsed, 3);
  assert.ok(budget.spentUsd > 0.029 && budget.spentUsd < 0.032);
});

test("a new ledger instance reads spend the previous one wrote", () => {
  // The crash-recovery property: spend survives the process that made it.
  const path = tempLedger();
  new InferenceBudget(path).record({
    model: "claude-sonnet-5",
    purpose: "carbon-quality",
    inputTokens: 1000,
    outputTokens: 100,
  });

  assert.equal(new InferenceBudget(path).callsUsed, 1);
});

test("the call cap refuses the call that would exceed it", () => {
  const budget = new InferenceBudget(tempLedger(), { maxCalls: 2, softLimitUsd: 100 });

  budget.assertCallAllowed();
  budget.record({ model: "claude-sonnet-5", purpose: "p", inputTokens: 1, outputTokens: 1 });
  budget.assertCallAllowed();
  budget.record({ model: "claude-sonnet-5", purpose: "p", inputTokens: 1, outputTokens: 1 });

  assert.throws(
    () => budget.assertCallAllowed(),
    (e: unknown) => e instanceof InferenceBudgetExceeded && /2 of 2 calls/.test((e as Error).message),
  );
  assert.equal(budget.callsRemaining, 0);
});

test("the cap survives a restart — it is not per-process", () => {
  const path = tempLedger();
  const caps = { maxCalls: 1, softLimitUsd: 100 };

  new InferenceBudget(path, caps).record({
    model: "claude-sonnet-5",
    purpose: "p",
    inputTokens: 1,
    outputTokens: 1,
  });

  assert.throws(() => new InferenceBudget(path, caps).assertCallAllowed(), InferenceBudgetExceeded);
});

test("the soft limit reports without blocking", () => {
  const budget = new InferenceBudget(tempLedger(), { maxCalls: 100, softLimitUsd: 0.001 });
  budget.record({
    model: "claude-sonnet-5",
    purpose: "p",
    inputTokens: 10_000,
    outputTokens: 10_000,
  });

  assert.ok(budget.overSoftLimit);
  // Advisory only — it must not stop the next call.
  assert.doesNotThrow(() => budget.assertCallAllowed());
});

test("the default cap makes a 253-row benchmark impossible by accident", () => {
  // The regression this file exists for.
  assert.ok(
    DEFAULT_CAPS.maxCalls < 253,
    "the default must not silently permit a corpus-sized run",
  );
});

test("caps come from the environment when set", () => {
  const caps = capsFromEnv({ ROUTELOCK_MAX_MODEL_CALLS: "5", ROUTELOCK_SOFT_LIMIT_USD: "0.25" });
  assert.equal(caps.maxCalls, 5);
  assert.equal(caps.softLimitUsd, 0.25);
});

test("an unset environment falls back to the defaults", () => {
  assert.deepEqual(capsFromEnv({}), DEFAULT_CAPS);
});

test("a nonsensical cap throws rather than defaulting silently", () => {
  // Defaulting a typo to 25 would spend money the operator did not authorise.
  assert.throws(() => capsFromEnv({ ROUTELOCK_MAX_MODEL_CALLS: "0" }), /positive number/);
  assert.throws(() => capsFromEnv({ ROUTELOCK_MAX_MODEL_CALLS: "-3" }), /positive number/);
  assert.throws(() => capsFromEnv({ ROUTELOCK_MAX_MODEL_CALLS: "lots" }), /positive number/);
});

test("the summary names both the count and the spend", () => {
  const budget = new InferenceBudget(tempLedger(), { maxCalls: 10, softLimitUsd: 1 });
  budget.record({
    model: "claude-sonnet-5",
    purpose: "p",
    inputTokens: 2000,
    outputTokens: 600,
  });

  assert.match(budget.summary(), /^1\/10 calls, \$0\.0\d{3} estimated$/);
});

test("a relative ledger path anchors to the repo root, not the working directory", () => {
  // The defect this pins: running scripts from different package directories
  // created one ledger each, so the cap multiplied by the number of scripts.
  const fromRoot = ledgerPath("data/inference-calls.jsonl");

  assert.ok(fromRoot.startsWith("/"), "must resolve to an absolute path");
  assert.ok(
    !fromRoot.includes("/packages/"),
    `expected a repo-root path, got ${fromRoot}`,
  );
});

test("two budgets built from the same relative path share one ledger", () => {
  const a = new InferenceBudget("data/test-shared-ledger.jsonl", { maxCalls: 2, softLimitUsd: 1 });
  a.record({ model: "claude-sonnet-5", purpose: "p", inputTokens: 1, outputTokens: 1 });

  const b = new InferenceBudget("data/test-shared-ledger.jsonl", { maxCalls: 2, softLimitUsd: 1 });
  assert.equal(b.callsUsed, a.callsUsed, "a second entry point must see the first one's spend");

  rmSync(ledgerPath("data/test-shared-ledger.jsonl"), { force: true });
});

test("an absolute path is honoured as given", () => {
  assert.equal(ledgerPath("/tmp/explicit.jsonl"), "/tmp/explicit.jsonl");
});
