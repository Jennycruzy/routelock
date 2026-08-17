/// The engine's spend discipline.
///
/// The carbon path has been budget-capped since it was written; the HS path was
/// not, which was fine while its only caller was a supervised benchmark and
/// stopped being fine the moment an HTTP endpoint could reach it. These tests
/// are about the cap, not about classification — `decide.test.ts` and
/// `anthropic.test.ts` cover the ruling itself.
///
/// Every test here stubs `fetch`, so no call leaves the machine and no real
/// money is spent proving that money is not spent.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ComplianceEngine } from "./engine.ts";
import { InferenceBudget, InferenceBudgetExceeded } from "./carbon/budget.ts";
import type { ClassificationRequest } from "./types.ts";

function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), "routelock-engine-")), "calls.jsonl");
}

const REQUEST: ClassificationRequest = {
  description: "Wireless over-ear headphones, plastic housing",
  originCountry: "NG",
  destinationCountry: "GB",
  declaredValue: 120,
  currency: "USD",
  weightKg: 0.4,
};

/// A well-formed first-pass response, with the usage counts the API reports.
function proposalResponse(inputTokens: number, outputTokens: number): Response {
  return new Response(
    JSON.stringify({
      content: [
        {
          type: "tool_use",
          name: "record_classification",
          input: {
            hs6: "851830",
            confidence: 0.91,
            missing_information: [],
            purpose_flags: [],
            rationale: "Headphones are covered by the loudspeaker heading.",
            candidate_chapters: [],
          },
        },
      ],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/// Replace `fetch` for the duration of one test, counting the calls made.
async function withStubbedFetch<T>(
  respond: () => Response,
  body: (calls: () => number) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return respond();
  }) as typeof fetch;
  try {
    return await body(() => calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("a grounded ruling refuses when it cannot afford both passes", async () => {
  // One call left, and a grounded ruling costs two. The refusal has to happen
  // *before* the first call: spending on a first pass that cannot be grounded
  // would produce a decision recording `+grounded` in its engine version, and
  // a decision hash that misdescribes what produced it is worse than no answer.
  const budget = new InferenceBudget(tempLedger(), { maxCalls: 1, softLimitUsd: 1 });
  const engine = new ComplianceEngine({ apiKey: "k", model: "claude-sonnet-5" }, { budget });

  await withStubbedFetch(
    () => proposalResponse(1000, 200),
    async (calls) => {
      await assert.rejects(() => engine.classify(REQUEST), InferenceBudgetExceeded);
      assert.equal(calls(), 0, "nothing may be spent by a ruling that cannot finish");
    },
  );
});

test("the refusal names how many calls the ruling needed", async () => {
  const budget = new InferenceBudget(tempLedger(), { maxCalls: 1, softLimitUsd: 1 });
  const engine = new ComplianceEngine({ apiKey: "k", model: "claude-sonnet-5" }, { budget });

  await withStubbedFetch(
    () => proposalResponse(1000, 200),
    async () => {
      await assert.rejects(
        () => engine.classify(REQUEST),
        (error: unknown) => {
          assert.ok(error instanceof InferenceBudgetExceeded);
          assert.equal(error.callsNeeded, 2);
          assert.match(error.message, /this ruling needs 2/);
          return true;
        },
      );
    },
  );
});

test("an ungrounded ruling needs only one call, and takes it", async () => {
  const budget = new InferenceBudget(tempLedger(), { maxCalls: 1, softLimitUsd: 1 });
  const engine = new ComplianceEngine(
    { apiKey: "k", model: "claude-sonnet-5" },
    { budget, grounding: false },
  );

  await withStubbedFetch(
    () => proposalResponse(1200, 300),
    async (calls) => {
      const ruling = await engine.classify(REQUEST);
      assert.equal(calls(), 1);
      assert.equal(ruling.decision.proposal.hs6, "851830");
    },
  );
});

test("the ledger records the counts the API reported, not an estimate of them", async () => {
  const budget = new InferenceBudget(tempLedger(), { maxCalls: 5, softLimitUsd: 1 });
  const engine = new ComplianceEngine(
    { apiKey: "k", model: "claude-sonnet-5" },
    { budget, grounding: false },
  );

  await withStubbedFetch(
    () => proposalResponse(1234, 567),
    async () => {
      await engine.classify(REQUEST);

      const records = budget.records();
      assert.equal(records.length, 1);
      assert.equal(records[0]?.inputTokens, 1234);
      assert.equal(records[0]?.outputTokens, 567);
      assert.equal(records[0]?.purpose, "hs_classify");
      assert.equal(records[0]?.model, "claude-sonnet-5");
      // 1234 in at $2/Mtok plus 567 out at $10/Mtok.
      assert.equal(records[0]?.costUsd.toFixed(6), "0.008138");
      assert.equal(budget.callsRemaining, 4);
    },
  );
});

test("a spent call is recorded even when its response cannot be parsed", async () => {
  // The failure this exists for: a 200 whose content is unusable has still been
  // charged. Recording only successful parses would let a run repeatedly pay for
  // garbage while the ledger insisted nothing had happened.
  const budget = new InferenceBudget(tempLedger(), { maxCalls: 5, softLimitUsd: 1 });
  const engine = new ComplianceEngine(
    { apiKey: "k", model: "claude-sonnet-5" },
    { budget, grounding: false },
  );

  await withStubbedFetch(
    () =>
      new Response(JSON.stringify({ content: [], usage: { input_tokens: 800, output_tokens: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await assert.rejects(() => engine.classify(REQUEST));

      assert.equal(budget.callsUsed, 1, "an unparseable 200 was still paid for");
      assert.equal(budget.records()[0]?.inputTokens, 800);
    },
  );
});

test("no budget means no ledger and no cap — the benchmark's supervised path", async () => {
  // Deliberate: a benchmark's whole purpose is to spend hundreds of calls, and
  // a 25-call cap in front of it would only teach the operator to raise caps.
  const engine = new ComplianceEngine(
    { apiKey: "k", model: "claude-sonnet-5" },
    { grounding: false },
  );
  assert.equal(engine.budget, undefined);

  await withStubbedFetch(
    () => proposalResponse(10, 10),
    async (calls) => {
      await engine.classify(REQUEST);
      await engine.classify(REQUEST);
      assert.equal(calls(), 2);
    },
  );
});
