/// Real-model proposal for a compute workload against a fetched provider policy.

import { roundConfidence } from "../hash.ts";
import {
  ComplianceModelError,
  withRetry,
} from "../anthropic.ts";
import { InferenceBudget } from "../carbon/budget.ts";
import type { ComputePolicyProposal, ComputePolicyRequest } from "./types.ts";

const API = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const COMPUTE_POLICY_TOOL = {
  name: "record_compute_policy_assessment",
  description:
    "Assess whether the supplied compute workload is permissible under the " +
    "retrieved acceptable-use policy. Use only the attached workload and policy.",
  input_schema: {
    type: "object",
    properties: {
      policy_conflicts: {
        type: "array",
        items: { type: "string" },
        description:
          "Specific policy conflicts. Empty means no direct conflict was found.",
      },
      missing_information: {
        type: "array",
        items: { type: "string" },
        description:
          "Questions whose answers are required before approving this workload.",
      },
      confidence: {
        type: "number",
        description:
          "Probability between 0 and 1 that the workload is permissible under the attached policy.",
      },
      rationale: {
        type: "string",
        description: "One or two sentences explaining the assessment without inventing facts.",
      },
    },
    required: ["policy_conflicts", "missing_information", "confidence", "rationale"],
  },
} as const;

export function buildComputePolicyPrompt(request: ComputePolicyRequest): string {
  return [
    "Assess this Akash compute workload against the exact acceptable-use policy retrieved below.",
    "Do not use a policy from memory. Do not approve merely because the image name looks familiar.",
    "If the workload purpose or image behavior is unclear, list the missing information.",
    "A direct conflict is a refusal; uncertainty is a request for information.",
    "The managed Akash Console flow may use account and payment-method checks without exposing a separate identity-document upload.",
    "Do not invent a missing identity or age-verification document requirement. Use the operator's explicit eligibility declaration as the supplied fact unless the attached policy explicitly requires a specific check for this workload.",
    "Akash may perform its own account screening separately; that provider-side possibility is not, by itself, missing workload information.",
    "",
    `Service name: ${request.serviceName}`,
    `Workload purpose: ${request.workloadDescription}`,
    `Authorized deployer jurisdiction (operator declaration): ${request.deployerJurisdiction}`,
    `Operator eligibility and lawful-use declaration: ${request.lawfulUseConfirmation}`,
    "",
    "SDL (operator-supplied):",
    request.sdl,
    "",
    `Policy URL: ${request.acceptableUsePolicyUrl}`,
    "Retrieved acceptable-use policy:",
    request.acceptableUsePolicy,
  ].join("\n");
}

interface AnthropicContentBlock {
  readonly type: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

export async function proposeComputePolicy(
  request: ComputePolicyRequest,
  options: {
    readonly apiKey: string;
    readonly model: string;
    readonly maxTokens?: number;
    readonly budget: InferenceBudget;
  },
): Promise<ComputePolicyProposal> {
  options.budget.assertCallAllowed();
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
      tools: [COMPUTE_POLICY_TOOL],
      tool_choice: { type: "tool", name: COMPUTE_POLICY_TOOL.name },
      messages: [{ role: "user", content: buildComputePolicyPrompt(request) }],
    }),
  });

  if (!response.ok) {
    throw new ComplianceModelError(
      `model returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
      response.status === 429 || response.status === 529 || response.status >= 500,
    );
  }

  const body = (await response.json()) as {
    readonly content?: readonly AnthropicContentBlock[];
    readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  };
  options.budget.record({
    model: options.model,
    purpose: "compute-policy",
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  });
  const call = body.content?.find(
    (block) => block.type === "tool_use" && block.name === COMPUTE_POLICY_TOOL.name,
  );
  if (call?.input === undefined) {
    throw new ComplianceModelError("model did not call the compute-policy tool");
  }
  return parseComputePolicyProposal(call.input);
}

export async function proposeComputePolicyWithRetry(
  request: ComputePolicyRequest,
  options: {
    readonly apiKey: string;
    readonly model: string;
    readonly maxTokens?: number;
    readonly budget: InferenceBudget;
  },
): Promise<ComputePolicyProposal> {
  return withRetry(() => proposeComputePolicy(request, options));
}

export function parseComputePolicyProposal(input: Record<string, unknown>): ComputePolicyProposal {
  const strings = (value: unknown): readonly string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [];
  const rawConfidence = input["confidence"];
  const confidence = roundConfidence(typeof rawConfidence === "number" ? rawConfidence : 0);
  return {
    policyConflicts: strings(input["policy_conflicts"]),
    missingInformation: strings(input["missing_information"]),
    confidence,
    rationale: typeof input["rationale"] === "string" ? input["rationale"] : "",
  };
}
