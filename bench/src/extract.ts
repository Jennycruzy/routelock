/// Turning a CBP ruling into a benchmark input.
///
/// A ruling letter states its own answer twice: once in the `TARIFF NO.:` header
/// and again in the "The applicable subheading ... will be 4202.92.9026" passage
/// that closes the analysis. Everything between the salutation and that closing
/// passage is the customs officer's description of the goods, which is the only
/// part a classifier should ever see.
///
/// So extraction is a cutting problem, and the cut has to be provably clean: a
/// benchmark whose inputs contain their own answers measures nothing at all and
/// would report near-perfect accuracy while doing so. `extractDescription`
/// therefore refuses to return a description it cannot certify, and the caller
/// drops that ruling.

/// The description begins after the salutation line (`Dear Mr. Lees:`).
const SALUTATION = /^\s*Dear\b[^\n:]{0,80}:/m;

/// The description ends at the first phrase that opens the legal conclusion.
///
/// Ordered by nothing in particular — the earliest match in the text wins, not
/// the earliest in this list — but every one of them is followed by the answer
/// within a sentence or two.
const CONCLUSION_MARKERS = [
  "The applicable subheading",
  "The applicable tariff",
  "The applicable classification",
  "The merchandise is classified",
  "The merchandise will be classified",
  "The product is classified",
  "Classification of the merchandise",
  "In your letter you suggest",
  "You have suggested classification",
  "Consequently, the",
  "Accordingly, the",
] as const;

/// The procedural opener, which is identical across thousands of rulings and
/// describes the correspondence rather than the goods.
///
/// Stripped only when it matches in full, because a sentence that *starts* the
/// same way often continues into the description itself — "You are requesting
/// the tariff classification on an item that is described as a Spider-Man 3
/// Spider-Smart Learning Laptop" is the description.
const PROCEDURAL_OPENER =
  /^\s*In your letter dated [^.]{0,80}?,? you requested a tariff classification ruling(?: on behalf of [^.]{0,80})?\.\s*/i;

/// Patterns that mean the text still carries its own answer.
///
/// The first two catch a code in any of its written forms. The rest are
/// deliberately blunt: a description of goods has no reason to discuss tariff
/// nomenclature at all, so any of this vocabulary indicates the cut landed
/// inside the legal analysis rather than before it.
///
/// `HTSUS` is matched without a trailing word boundary on purpose. Rulings also
/// write `HTSUSA`, and `\bHTSUS\b` does not match it — that gap let one row
/// through carrying "classifiable in Chapter 95 of the HTSUSA", which discloses
/// the first two digits of its own answer.
///
/// A bare chapter reference is treated as a leak for the same reason: chapter 95
/// *is* the answer's first two digits.
const LEAK_PATTERNS: readonly RegExp[] = [
  /\d{4}\.\d{2}/, // 4202.92 or 4202.92.9026
  /\b\d{6,10}\b/, // 420292 written without separators
  /\bHTSUS/i,
  /\bHarmonized Tariff\b/i,
  /\bsubheading\b/i,
  /\bheading\s+\d{4}\b/i,
  /\bchapter\s+\d{1,2}\b/i,
  /\bclassifiable\b|\bclassified\s+(?:in|under)\b/i,
];

export interface ExtractionFailure {
  readonly ok: false;
  readonly reason:
    | "no-salutation"
    | "no-conclusion"
    | "too-short"
    | "answer-leaked";
}

export interface ExtractionSuccess {
  readonly ok: true;
  readonly description: string;
}

export type ExtractionResult = ExtractionSuccess | ExtractionFailure;

/// Collapse the ruling's mixed `\r`, tab and form-feed whitespace into single
/// spaces. This is the only edit made to the authority's wording; no word is
/// added, removed, reordered or paraphrased.
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/// Extract the goods description from a ruling letter's full text.
///
/// `hs6` is the ruling's own ground truth, passed in so the leak check can look
/// for that specific answer as well as for tariff-shaped text in general.
export function extractDescription(
  rulingText: string,
  hs6: string,
): ExtractionResult {
  const salutation = SALUTATION.exec(rulingText);
  if (salutation === null) return { ok: false, reason: "no-salutation" };

  const afterSalutation = rulingText.slice(
    salutation.index + salutation[0].length,
  );

  let cutAt = -1;
  for (const marker of CONCLUSION_MARKERS) {
    const at = afterSalutation.indexOf(marker);
    if (at !== -1 && (cutAt === -1 || at < cutAt)) cutAt = at;
  }
  if (cutAt === -1) return { ok: false, reason: "no-conclusion" };

  const body = normalizeWhitespace(afterSalutation.slice(0, cutAt)).replace(
    PROCEDURAL_OPENER,
    "",
  );

  // Short bodies are letters that spend their length on procedure and cite the
  // goods only by reference to an attachment we do not have.
  if (body.length < 120) return { ok: false, reason: "too-short" };

  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(body)) return { ok: false, reason: "answer-leaked" };
  }

  // Check the answer against the description stripped to bare digits, not just
  // against its raw text. `4202.92`, `4202 92` and `4202-92` are all the answer
  // written out, and a plain substring test sees none of them.
  if (body.replace(/\D/g, "").includes(hs6)) {
    return { ok: false, reason: "answer-leaked" };
  }

  return { ok: true, description: body };
}
