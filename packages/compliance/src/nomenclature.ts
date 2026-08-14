/// The Harmonized System nomenclature, as text the engine can read.
///
/// The first version of this engine asked a model to recall five thousand
/// subheadings from memory and scored 36% top-1 against real customs rulings.
/// That is not what classification is: it is a procedure applied to published
/// text — compare the competing headings, read what each actually says. A model
/// with no access to the nomenclature is doing the wrong task.
///
/// **Source:** the United States International Trade Commission's public HTS
/// export endpoint, <https://hts.usitc.gov/reststop/exportList>. The first six
/// digits of every HTS line are the international HS subheading, and the heading
/// text at that level is the WCO's own wording, so this is the real nomenclature
/// rather than a paraphrase of it.
///
/// Fetched once and cached to disk. No model is involved in retrieval, so
/// building the index costs nothing and a scoring run is reproducible.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXPORT = "https://hts.usitc.gov/reststop/exportList";

/// One six-digit subheading, carrying the heading it sits under.
///
/// The heading matters: a great many subheadings read "Other" or "Parts" and
/// mean nothing alone. `8518.90` is "Parts"; only with its heading does it
/// become "parts of microphones, loudspeakers and headphones".
export interface Subheading {
  readonly hs6: string;
  /// Four-digit heading text.
  readonly heading: string;
  /// The subheading's own text.
  readonly text: string;
}

function cacheDir(): string {
  return join(import.meta.dirname, "..", "data", "nomenclature");
}

interface HtsLine {
  readonly htsno?: string;
  readonly description?: string;
}

/// Strip the inline markup the HTS export carries (`<il>300 Hz</il>`).
function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .replace(/:$/, "")
    .trim();
}

/// Fetch one chapter's six-digit subheadings, with their headings attached.
export async function fetchChapter(chapter: string): Promise<Subheading[]> {
  const response = await fetch(
    `${EXPORT}?from=${chapter}00&to=${chapter}99&format=JSON&styles=false`,
  );
  if (!response.ok) {
    throw new Error(`HTS export for chapter ${chapter} returned ${response.status}`);
  }
  return parseChapter((await response.json()) as HtsLine[]);
}

/// Walk the flat export, tracking the current heading.
///
/// Exported for testing against saved rows without a network call.
export function parseChapter(lines: readonly HtsLine[]): Subheading[] {
  const out: Subheading[] = [];
  const seen = new Set<string>();
  let heading = "";

  for (const line of lines) {
    const code = String(line.htsno ?? "");
    const description = clean(String(line.description ?? ""));
    if (description === "") continue;

    if (/^\d{4}$/.test(code)) {
      heading = description;
      continue;
    }
    if (/^\d{4}\.\d{2}$/.test(code)) {
      const hs6 = code.replace(".", "");
      if (seen.has(hs6)) continue;
      seen.add(hs6);
      out.push({ hs6, heading, text: description });
    }
  }
  return out;
}

/// Load a chapter, fetching and caching it on first use.
export async function loadChapter(chapter: string): Promise<Subheading[]> {
  const dir = cacheDir();
  const path = join(dir, `${chapter}.json`);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as Subheading[];
  }

  const subheadings = await fetchChapter(chapter);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(subheadings, null, 1) + "\n");
  return subheadings;
}

/// Every chapter that carries goods. 77 is reserved by the WCO.
export const CHAPTERS: readonly string[] = Array.from({ length: 97 }, (_, i) =>
  String(i + 1).padStart(2, "0"),
).filter((c) => c !== "77");

/// Load the whole nomenclature.
export async function loadAll(
  onProgress?: (chapter: string, count: number) => void,
): Promise<Subheading[]> {
  const all: Subheading[] = [];
  for (const chapter of CHAPTERS) {
    const rows = await loadChapter(chapter);
    all.push(...rows);
    onProgress?.(chapter, rows.length);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/// Words too common in tariff text to discriminate between headings.
const STOPWORDS = new Set([
  "other", "parts", "thereof", "and", "or", "of", "the", "for", "with",
  "whether", "not", "in", "a", "an", "to", "be", "which", "than", "more",
  "less", "including", "such", "as", "by", "from", "any", "all", "kind",
  "kinds", "type", "types", "used", "use", "made", "containing", "weight",
  "value", "over", "under", "nesoi", "provided", "goods", "articles", "article",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/// Rank subheadings against a goods description by term overlap.
///
/// Deliberately lexical and deliberately simple. It is a *shortlist*, not a
/// classifier: its job is to put the right subheading somewhere in the candidate
/// set, and the model's job is to choose among them by reading the text. An
/// embedding index would rank better and would also make the shortlist itself
/// an unexplainable step, which is the wrong trade for a compliance record.
///
/// Rarer terms count for more, so "snorkel" outweighs "plastic".
export function retrieve(
  description: string,
  corpus: readonly Subheading[],
  limit: number,
): Subheading[] {
  const queryTerms = new Set(tokens(description));
  if (queryTerms.size === 0) return [];

  const documentFrequency = new Map<string, number>();
  const documentTokens = corpus.map((s) => {
    const set = new Set(tokens(`${s.heading} ${s.text}`));
    for (const term of set) {
      if (queryTerms.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
    return set;
  });

  const scored = corpus.map((subheading, i) => {
    let score = 0;
    for (const term of documentTokens[i] ?? []) {
      if (!queryTerms.has(term)) continue;
      const df = documentFrequency.get(term) ?? 1;
      score += Math.log(1 + corpus.length / df);
    }
    return { subheading, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.subheading);
}
