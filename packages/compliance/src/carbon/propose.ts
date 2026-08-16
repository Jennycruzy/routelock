/// The one place in the carbon path that spends money.
///
/// Mirrors `../anthropic.ts`: a forced tool call so the model returns a
/// structured assessment rather than prose a parser has to interpret, and a
/// validator that contains anything malformed. The difference is the budget —
/// every call here is checked against a hard ceiling first and recorded to a
/// durable ledger after, because the failure mode this package has already hit
/// once is a loop that spends five hundred times without anything stopping it.
///
/// ## The model proposes; it does not decide
///
/// Nothing returned here is a verdict. `CarbonProposal` has no verdict field,
/// by construction — `decideCarbon()` in `./decide.ts` applies auditable rules
/// to this evidence, and the deterministic facts outrank the model at every
/// step. That separation is what makes the on-chain guarantee meaningful:
/// `SettlementEscrow` structurally refuses `COMPLIANCE_ROLE`, so the model can
/// open a gate and can never move money.
///
/// ## Failure degrades toward refusal, never toward approval
///
/// Every parse failure, missing field and unrecognised value resolves to lower
/// confidence or an open question — both of which `decideCarbon` turns into
/// `NeedsInformation`. There is no path through this file where a broken or
/// adversarial response becomes an approval to burn a credit.

import { ComplianceModelError, withRetry } from "../anthropic.ts";
import { roundConfidence } from "../hash.ts";
import { InferenceBudget } from "./budget.ts";
import type { CarbonProposal, CarbonQualityRequest, IntegrityFlag } from "./types.ts";

const API = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const INTEGRITY_FLAGS: readonly IntegrityFlag[] = [
  "double_counting",
  "unrecognised_registry",
  "withdrawn_methodology",
  "documented_non_additionality",
  "fraud_finding",
  "unbuffered_reversal_risk",
];

/// The schema the model must fill. Forcing this tool removes the failure mode
/// where the model answers in prose and a parser has to guess at its meaning.
const ASSESS_TOOL = {
  name: "assess_carbon_quality",
  description:
    "Record an assessment of a carbon credit class. Report evidence and " +
    "confidence only — do not decide whether to retire.",
  input_schema: {
    type: "object",
    properties: {
      methodologyStrength: {
        type: "string",
        enum: ["strong", "moderate", "weak"],
        description:
          "How strong the methodology is as evidence that a tonne was actually " +
          "avoided or removed.",
      },
      permanenceRisk: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Risk that the reduction reverses.",
      },
      adverseFindings: {
        type: "array",
        items: { type: "string" },
        description:
          "Published, checkable concerns about this project or methodology. " +
          "Each must be a claim a reader could go and verify. Empty if none.",
      },
      integrityFlags: {
        type: "array",
        items: { type: "string", enum: [...INTEGRITY_FLAGS] },
        description:
          "Defects that end the matter regardless of confidence. Use only when " +
          "the evidence supports it; these cause an outright refusal.",
      },
      openQuestions: {
        type: "array",
        items: { type: "string" },
        description:
          "What you would still need in order to rule. Non-empty means the " +
          "evidence was incomplete.",
      },
      confidence: {
        type: "number",
        description: "0 to 1. Your confidence in this assessment.",
      },
      rationale: {
        type: "string",
        description: "Two or three sentences. No PII.",
      },
    },
    required: [
      "methodologyStrength",
      "permanenceRisk",
      "adverseFindings",
      "integrityFlags",
      "openQuestions",
      "confidence",
      "rationale",
    ],
  },
} as const;

/// The facts, rendered for the model.
///
/// Only registry metadata goes in — no buyer, no wallet, no price the issuer
/// paid. Exported so a published decision can be checked against the exact
/// text the model was shown.
export function buildCarbonPrompt(request: CarbonQualityRequest): string {
  return [
    "Assess the quality of this carbon credit class as evidence that a real,",
    "additional, durable tonne of CO2e was avoided or removed.",
    "",
    "A retirement is irreversible: the credit is permanently burned, with no",
    "refund and no dispute. Prefer an open question over a confident guess.",
    "",
    `Class name:      ${request.name ?? "(unidentified)"}`,
    `Category:        ${request.category ?? "(none stated)"}`,
    `Country:         ${request.country ?? "(none stated)"}`,
    `Registries:      ${request.registries.join(", ") || "(none)"}`,
    `Project ids:     ${request.projectIds.join(", ") || "(none)"}`,
    `Vintages:        ${request.vintages.join(", ") || "(none)"}`,
    `Oldest vintage:  ${request.oldestVintage} (${request.oldestVintageAgeYears} years old)`,
    `Methodologies:   ${request.methodologies.join("; ") || "(none stated)"}`,
    `Liquidity:       ${request.liquidityTonnes} tonnes available`,
    `Requested:       ${request.tonnesRequested} tonnes`,
    "",
    "Report only what the facts above support. If they are insufficient to",
    "judge a dimension, say so in openQuestions rather than guessing.",
  ].join("\n");
}

export interface CarbonModelOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens?: number;
  /// Enforced before the request and recorded after. Required, not optional:
  /// an unbudgeted path is how the last overspend happened.
  readonly budget: InferenceBudget;
}

interface ContentBlock {
  readonly type: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

/// Ask the model to assess one credit class. **Spends money.**
export async function proposeCarbonQuality(
  request: CarbonQualityRequest,
  options: CarbonModelOptions,
): Promise<{ proposal: CarbonProposal; inputTokens: number; outputTokens: number }> {
  // Before the request, not after: a budget checked afterwards has already
  // been exceeded by the time it complains.
  options.budget.assertCallAllowed();

  // `thinking` is deliberately left at the model's default rather than
  // disabled. Disabling it is the cheaper setting, but on current models it
  // introduces a failure mode where a tool call is written into the visible
  // text and silently never runs — which here would read as "the engine
  // declined to assess" rather than as an error.
  const response = await fetch(API, {
    method: "POST",
    headers: {
      "x-api-key": options.apiKey,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 1024,
      tools: [ASSESS_TOOL],
      tool_choice: { type: "tool", name: ASSESS_TOOL.name },
      messages: [{ role: "user", content: buildCarbonPrompt(request) }],
    }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new ComplianceModelError(
      `model returned ${response.status}: ${body}`,
      response.status === 429 || response.status >= 500,
    );
  }

  const body = (await response.json()) as {
    content?: readonly ContentBlock[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  // Record the spend before anything can throw on the way out. A ledger that
  // only records successful parses under-counts exactly what was paid for.
  const inputTokens = body.usage?.input_tokens ?? 0;
  const outputTokens = body.usage?.output_tokens ?? 0;
  options.budget.record({
    model: options.model,
    purpose: "carbon-quality",
    inputTokens,
    outputTokens,
  });

  const call = body.content?.find((b) => b.type === "tool_use" && b.name === ASSESS_TOOL.name);
  if (call?.input === undefined) {
    throw new ComplianceModelError("model did not call the assessment tool");
  }

  return { proposal: parseCarbonProposal(call.input), inputTokens, outputTokens };
}

/// Validate the model's tool input into a `CarbonProposal`.
///
/// Exported for testing, because this is where a malformed or adversarial
/// response has to be contained. Every unusable field degrades toward refusal:
/// an unreadable confidence becomes 0, an unreadable strength becomes `weak`,
/// and a response missing its rationale gains an open question. None of those
/// can produce an approval.
export function parseCarbonProposal(input: Record<string, unknown>): CarbonProposal {
  const strength = input["methodologyStrength"];
  const methodologyStrength =
    strength === "strong" || strength === "moderate" || strength === "weak" ? strength : "weak";

  const risk = input["permanenceRisk"];
  const permanenceRisk = risk === "low" || risk === "medium" || risk === "high" ? risk : "high";

  const rawConfidence = input["confidence"];
  const confidence =
    typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
      ? roundConfidence(rawConfidence)
      : 0;

  const strings = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

  // Only flags the schema defines. An invented flag is discarded rather than
  // trusted — a model must not be able to widen the refusal vocabulary.
  const integrityFlags = strings(input["integrityFlags"]).filter((f): f is IntegrityFlag =>
    (INTEGRITY_FLAGS as readonly string[]).includes(f),
  );

  const rationale = typeof input["rationale"] === "string" ? input["rationale"] : "";
  const openQuestions = [...strings(input["openQuestions"])];
  if (rationale === "") {
    openQuestions.push("the model returned no rationale for this assessment");
  }

  return {
    methodologyStrength,
    permanenceRisk,
    adverseFindings: strings(input["adverseFindings"]),
    integrityFlags,
    openQuestions,
    confidence,
    rationale,
  };
}

/// Retry wrapper, reusing the delivery path's backoff so both verticals fail
/// the same way. The budget is checked inside each attempt, so a retry storm
/// cannot outrun the cap.
export function proposeCarbonQualityWithRetry(
  request: CarbonQualityRequest,
  options: CarbonModelOptions,
): Promise<{ proposal: CarbonProposal; inputTokens: number; outputTokens: number }> {
  return withRetry(() => proposeCarbonQuality(request, options));
}
