/// Estimate the cost of a full scoring run without making a single API call.
///
/// Token counts are approximated at 4 characters per token, which is close
/// enough for a spending decision and costs nothing to compute.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChapter } from "../src/nomenclature.ts";
import { buildPrompt } from "../src/anthropic.ts";
import { buildGroundingPrompt } from "../src/ground.ts";
import type { Proposal } from "../src/types.ts";

const corpus = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "bench", "data", "corpus.jsonl"),
  "utf8",
).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { description: string; hs6: string });

const sample = corpus.filter((_, i) => i % 12 === 0);
let firstChars = 0, groundChars = 0;

for (const row of sample) {
  const request = {
    description: row.description, originCountry: "NG", destinationCountry: "GB",
    declaredValue: 100000, currency: "NGN", weightKg: 1,
  };
  firstChars += buildPrompt(request).length;

  // Two chapters is the common case for candidate_chapters.
  const chapters = [row.hs6.slice(0, 2), "39"];
  const candidates = (await Promise.all(chapters.map((c) => loadChapter(c)))).flat();
  const proposal: Proposal = {
    hs6: row.hs6, confidence: 0.6, missingInformation: [], purposeFlags: [],
    rationale: "A first pass rationale of roughly typical length for this corpus.",
    candidateChapters: chapters,
  };
  groundChars += buildGroundingPrompt(request, proposal, candidates).length;
}

const n = sample.length;
const inTokens = (firstChars + groundChars) / n / 4;
const outTokens = 400; // both tool calls, generously
const rows = corpus.length;

process.stdout.write(
  `sampled ${n} rows\n` +
  `  mean input tokens per row  ~${Math.round(inTokens)}\n` +
  `  assumed output per row     ~${outTokens}\n\n` +
  `full run of ${rows} rows:\n` +
  `  input  ~${((inTokens * rows) / 1e6).toFixed(2)}M tokens\n` +
  `  output ~${((outTokens * rows) / 1e6).toFixed(2)}M tokens\n`,
);
