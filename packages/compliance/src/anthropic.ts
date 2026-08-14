/// The model call.
///
/// Structured output is obtained with a tool definition rather than by asking
/// for JSON in prose and parsing whatever comes back. The schema is the
/// contract: the model is required to supply a confidence and to enumerate what
/// it is missing, so "I am not sure" has a place to go. A free-text model that
/// cannot express uncertainty will always express certainty instead.
///
/// There is no offline mode and no recorded-response mode. A compliance engine
/// that can answer without a model is not a compliance engine.

import { roundConfidence } from "./hash.ts";
import type { ClassificationRequest, Proposal, PurposeFlag } from "./types.ts";

const API = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const PURPOSE_FLAGS: readonly PurposeFlag[] = [
  "counterfeit_or_ip_infringing",
  "malware_or_intrusion_tooling",
  "exploitation_or_abuse_material",
  "hateful_or_violent_material",
  "self_harm_promotion",
  "terrorism_support",
  "personal_data_or_credentials",
  "otherwise_unlawful",
];

/// The tool the model must call. Its schema is the whole output contract.
const CLASSIFY_TOOL = {
  name: "record_classification",
  description:
    "Record a proposed HS classification for a consignment, together with " +
    "the confidence in it and anything that would need to be known to be " +
    "more certain.",
  input_schema: {
    type: "object",
    properties: {
      hs6: {
        type: ["string", "null"],
        description:
          "The six-digit HS subheading, digits only, no dots — e.g. '851830'. " +
          "Null if the description does not support naming one.",
      },
      confidence: {
        type: "number",
        description:
          "Probability between 0 and 1 that hs6 is the subheading a customs " +
          "authority would assign. Be honest rather than reassuring: this " +
          "number is measured against real rulings and published.",
      },
      missing_information: {
        type: "array",
        items: { type: "string" },
        description:
          "Questions for the shipper whose answers would change or confirm " +
          "the classification — material, function, composition, intended " +
          "use. Empty if the description is sufficient.",
      },
      purpose_flags: {
        type: "array",
        items: { type: "string", enum: PURPOSE_FLAGS },
        description:
          "Policy concerns raised by what the goods are FOR rather than what " +
          "they are. Empty for ordinary goods. Do not flag an item merely " +
          "because it is regulated or requires a licence.",
      },
      rationale: {
        type: "string",
        description:
          "One or two sentences naming the heading and why it fits. No " +
          "personal data.",
      },
    },
    required: [
      "hs6",
      "confidence",
      "missing_information",
      "purpose_flags",
      "rationale",
    ],
  },
} as const;

export function buildPrompt(request: ClassificationRequest): string {
  const crossBorder = request.originCountry !== request.destinationCountry;

  return [
    "Classify the following consignment under the Harmonized System.",
    "",
    `Goods: ${request.description}`,
    `Route: ${request.originCountry} to ${request.destinationCountry}` +
      `${crossBorder ? " (crosses a customs border)" : " (domestic)"}`,
    `Declared value: ${request.declaredValue} ${request.currency}`,
    `Weight: ${request.weightKg} kg`,
    "",
    crossBorder
      ? "This consignment crosses a customs border, so the classification " +
        "determines duty and admissibility. A wrong code has a real cost."
      : "This consignment is domestic, so the classification governs carrier " +
        "acceptance rather than duty.",
    "",
    "Give the six-digit international subheading, not a national ten-digit",
    "code. If the description leaves the heading genuinely open — a material,",
    "a function, or a composition you would need — say so in",
    "missing_information rather than picking the most likely option.",
    "",
    "Declining is a correct answer here and is recorded as one. An unsupported",
    "guess that happens to be right is worth less than an honest refusal.",
  ].join("\n");
}

interface AnthropicContentBlock {
  readonly type: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

export class ComplianceModelError extends Error {}

export interface ModelClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens?: number;
}

/// Ask the model to classify one consignment.
export async function propose(
  request: ClassificationRequest,
  options: ModelClientOptions,
): Promise<Proposal> {
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
      tools: [CLASSIFY_TOOL],
      // Forcing the tool removes the failure mode where the model answers in
      // prose and a parser has to guess at its meaning.
      tool_choice: { type: "tool", name: CLASSIFY_TOOL.name },
      messages: [{ role: "user", content: buildPrompt(request) }],
    }),
  });

  if (!response.ok) {
    throw new ComplianceModelError(
      `model returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }

  const body = (await response.json()) as { content?: AnthropicContentBlock[] };
  const call = body.content?.find(
    (b) => b.type === "tool_use" && b.name === CLASSIFY_TOOL.name,
  );
  if (call?.input === undefined) {
    throw new ComplianceModelError("model did not call the classification tool");
  }

  return parseProposal(call.input);
}

/// Validate the model's tool input into a `Proposal`.
///
/// Exported for testing, because this is where a malformed or adversarial model
/// response has to be contained. Anything unusable becomes an absent
/// classification and zero confidence, which the decision rule turns into
/// `NeedsInformation` — never into an approval.
export function parseProposal(input: Record<string, unknown>): Proposal {
  const rawHs6 = input["hs6"];
  const hs6 =
    typeof rawHs6 === "string" && /^\d{6}$/.test(rawHs6.replace(/\D/g, ""))
      ? rawHs6.replace(/\D/g, "")
      : null;

  const rawConfidence = input["confidence"];
  const confidence = roundConfidence(
    typeof rawConfidence === "number" ? rawConfidence : 0,
  );

  const missingInformation = Array.isArray(input["missing_information"])
    ? input["missing_information"].filter(
        (q): q is string => typeof q === "string" && q.trim() !== "",
      )
    : [];

  const allowed = new Set<string>(PURPOSE_FLAGS);
  const purposeFlags = Array.isArray(input["purpose_flags"])
    ? (input["purpose_flags"].filter(
        (f): f is PurposeFlag => typeof f === "string" && allowed.has(f),
      ) as PurposeFlag[])
    : [];

  const rationale =
    typeof input["rationale"] === "string" ? input["rationale"] : "";

  return {
    hs6,
    // A classification the engine could not read is not a classification, so
    // its confidence cannot be carried over.
    confidence: hs6 === null ? 0 : confidence,
    missingInformation,
    purposeFlags,
    rationale,
  };
}
