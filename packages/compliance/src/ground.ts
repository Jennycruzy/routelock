/// The grounding pass.
///
/// The first pass classifies from memory. Measured against 330 real customs
/// rulings it names the right **chapter** 80.6% of the time and the right
/// **subheading** only 36.1% of the time — it knows roughly where goods belong
/// and loses precision drilling down. So the second pass gives it the published
/// text of every subheading in the chapters it named and asks it to choose by
/// reading rather than by recall.
///
/// Two approaches were measured before this one was built, because a shortlist
/// is the ceiling on accuracy and measuring it costs nothing:
///
///   lexical retrieval over the whole nomenclature   recall@40 = 22.3%
///   the first pass's own candidate chapters         ceiling  = 80.6%
///
/// Lexical retrieval loses because tariff wording is legalistic and shares
/// little vocabulary with how a shipper describes goods — "angled flange plated
/// base" against "lamps and lighting fittings, parts thereof". It was discarded
/// rather than shipped.

import { loadChapter, type Subheading } from "./nomenclature.ts";
import { reportUsage, type UsageSink } from "./anthropic.ts";
import { roundConfidence } from "./hash.ts";
import type { ClassificationRequest, Proposal } from "./types.ts";

const API = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const SELECT_TOOL = {
  name: "select_subheading",
  description:
    "Choose the correct HS subheading for the goods from the published " +
    "nomenclature supplied, or report that none of them fits.",
  input_schema: {
    type: "object",
    properties: {
      hs6: {
        type: ["string", "null"],
        description:
          "The chosen six-digit subheading, digits only. Must be one of the " +
          "codes listed. Null if none of them covers these goods.",
      },
      confidence: {
        type: "number",
        description:
          "Probability between 0 and 1 that this is the subheading a customs " +
          "authority would assign, now that the actual text has been read.",
      },
      rationale: {
        type: "string",
        description:
          "One or two sentences quoting what in the subheading text decided " +
          "it, and what the nearest competing subheading was.",
      },
    },
    required: ["hs6", "confidence", "rationale"],
  },
} as const;

function renderCandidates(subheadings: readonly Subheading[]): string {
  const byHeading = new Map<string, Subheading[]>();
  for (const s of subheadings) {
    const list = byHeading.get(s.heading) ?? [];
    list.push(s);
    byHeading.set(s.heading, list);
  }

  const lines: string[] = [];
  for (const [heading, rows] of byHeading) {
    lines.push(`\n${heading}`);
    for (const r of rows) {
      lines.push(`  ${r.hs6.slice(0, 4)}.${r.hs6.slice(4)}  ${r.text}`);
    }
  }
  return lines.join("\n");
}

export function buildGroundingPrompt(
  request: ClassificationRequest,
  first: Proposal,
  candidates: readonly Subheading[],
): string {
  return [
    `Goods: ${request.description}`,
    "",
    "A first pass proposed " +
      (first.hs6 === null ? "no subheading" : first.hs6) +
      ` with confidence ${first.confidence}. Its reasoning: ${first.rationale}`,
    "",
    "Below is the published nomenclature for the chapters in question, grouped",
    "under each four-digit heading. Choose by reading it, not from memory.",
    "The first pass is often right about the chapter and wrong about the",
    "subheading, so treat its proposal as a starting point and not an answer.",
    renderCandidates(candidates),
    "",
    "Pick the subheading whose text actually covers these goods. If two compete,",
    "say which you rejected and why. If none of them fits, return null rather",
    "than the closest — a wrong code costs more than an honest gap.",
  ].join("\n");
}

export interface GroundedResult {
  readonly hs6: string | null;
  readonly confidence: number;
  readonly rationale: string;
  readonly candidatesConsidered: number;
  readonly chaptersRead: readonly string[];
}

/// Re-decide the subheading against the published text.
export async function ground(
  request: ClassificationRequest,
  first: Proposal,
  options: { apiKey: string; model: string; onUsage?: UsageSink },
): Promise<GroundedResult | null> {
  const chapters = first.candidateChapters ?? [];
  if (chapters.length === 0) return null;

  const candidates: Subheading[] = [];
  for (const chapter of chapters) {
    candidates.push(...(await loadChapter(chapter)));
  }
  if (candidates.length === 0) return null;

  const response = await fetch(API, {
    method: "POST",
    headers: {
      "x-api-key": options.apiKey,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: 700,
      tools: [SELECT_TOOL],
      tool_choice: { type: "tool", name: SELECT_TOOL.name },
      messages: [
        {
          role: "user",
          content: buildGroundingPrompt(request, first, candidates),
        },
      ],
    }),
  });

  if (!response.ok) return null; // the first pass stands

  const body = (await response.json()) as {
    content?: { type: string; name?: string; input?: Record<string, unknown> }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // This pass discards its own answer whenever the model invents a code rather
  // than choosing one from the list. Discarded or not, it was paid for.
  reportUsage(body, options, "hs_ground");

  const call = body.content?.find(
    (b) => b.type === "tool_use" && b.name === SELECT_TOOL.name,
  );
  if (call?.input === undefined) return null;

  const raw = call.input["hs6"];
  const digits = typeof raw === "string" ? raw.replace(/\D/g, "") : "";
  const offered = new Set(candidates.map((c) => c.hs6));

  // A code the model invented rather than chose is not grounded in anything,
  // so it is discarded rather than trusted — the point of this pass is that the
  // answer came from the published list.
  const hs6 = /^\d{6}$/.test(digits) && offered.has(digits) ? digits : null;

  const rawConfidence = call.input["confidence"];
  return {
    hs6,
    confidence: hs6 === null ? 0 : roundConfidence(
      typeof rawConfidence === "number" ? rawConfidence : 0,
    ),
    rationale:
      typeof call.input["rationale"] === "string" ? call.input["rationale"] : "",
    candidatesConsidered: candidates.length,
    chaptersRead: chapters,
  };
}
