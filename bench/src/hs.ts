/// HS code handling for the classification benchmark.
///
/// The ground truth in this corpus comes from US Customs binding rulings, which
/// classify to a 10-digit **HTS** code. HTS is the United States' extension of
/// the international 6-digit **HS** nomenclature: the first six digits of an HTS
/// code are the HS subheading and are valid worldwide, while digits 7-10 are
/// US-only statistical detail.
///
/// RouteLock classifies against HS, so the corpus truncates to six digits. That
/// truncation is the only transformation applied to the authority's answer, and
/// it is done here rather than inline so it is testable and stated once.

/// US-only chapters that have no international HS meaning.
///
/// Chapter 98 is special classification provisions (US goods returned, personal
/// exemptions) and chapter 99 is temporary rate modifications, including the
/// Section 301 provisions. Both are appended by the US to the HS and exist in no
/// other country's tariff, so a ruling that lands in one carries no HS ground
/// truth and must not enter the corpus.
const US_ONLY_CHAPTERS = new Set(["98", "99"]);

/// Reduce a single HTS code to its HS-6 subheading.
///
/// Returns `null` rather than throwing, because an unusable code is an ordinary
/// outcome when reading thousands of rulings — it means "exclude this row", not
/// "the program is wrong".
export function hs6FromHts(htsCode: string): string | null {
  const digits = htsCode.replace(/\D/g, "");
  if (digits.length < 6) return null;

  const chapter = digits.slice(0, 2);
  if (US_ONLY_CHAPTERS.has(chapter)) return null;

  // Chapter 00 is not a real chapter; it appears in malformed entries.
  if (chapter === "00") return null;

  return digits.slice(0, 6);
}

/// Derive the single HS-6 ground truth for a ruling, or `null` if there isn't one.
///
/// A ruling may classify several articles at once — a kit, or a letter covering
/// three products — and its `tariffs` array then holds several codes. If those
/// disagree at the HS-6 level there is no single correct answer to score a
/// prediction against, so the ruling is excluded rather than resolved by picking
/// the first. Ambiguous ground truth silently scored as if it were certain is
/// the most common way a benchmark ends up measuring nothing.
export function groundTruthHs6(tariffs: readonly string[]): string | null {
  const distinct = new Set<string>();

  for (const tariff of tariffs) {
    const hs6 = hs6FromHts(tariff);
    if (hs6 !== null) distinct.add(hs6);
  }

  if (distinct.size !== 1) return null;
  return [...distinct][0] ?? null;
}

/// Format an HS-6 as the conventional dotted subheading, e.g. `4202.92`.
export function formatHs6(hs6: string): string {
  return `${hs6.slice(0, 4)}.${hs6.slice(4, 6)}`;
}
