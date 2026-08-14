export { hs6FromHts, groundTruthHs6, formatHs6 } from "./hs.ts";
export { extractDescription } from "./extract.ts";
export type { ExtractionResult } from "./extract.ts";
export { search, fetchRuling, rulingUrl } from "./cross.ts";
export type { SearchHit, RulingDetail } from "./cross.ts";
export {
  listReferences as listAtarReferences,
  fetchRuling as fetchAtarRuling,
  parseRulingPage,
  atarUrl,
} from "./atar.ts";
export type { AtarRuling } from "./atar.ts";

/// The customs authorities the corpus draws ground truth from.
///
/// Two, deliberately. A single authority's rulings measure how well a model
/// reproduces *that country's* reading of the nomenclature. RouteLock is a
/// cross-border product whose route is chosen by whoever is shipping, so the
/// benchmark has to reflect more than one jurisdiction or its number does not
/// mean what it appears to mean.
export type Jurisdiction = "US" | "UK";

export const AUTHORITY: Record<Jurisdiction, string> = {
  US: "US CBP — CROSS binding rulings",
  UK: "UK HMRC — Advance Tariff Rulings",
};

/// One scored row of the benchmark.
export interface CorpusRow {
  /// The goods description, verbatim from the authority, with no answer in it.
  readonly description: string;
  /// HS-6 subheading, e.g. `420292`. The label a prediction is scored against.
  readonly hs6: string;
  /// Dotted form, e.g. `4202.92`, for display.
  readonly hs6Formatted: string;
  /// The full national codes the ruling issued — 10-digit HTS in the US, 10-digit
  /// commodity code in the UK — kept so the truncation to HS-6 is auditable.
  readonly nationalCodes: readonly string[];
  readonly jurisdiction: Jurisdiction;
  /// Citation. Every row is checkable against a public government database.
  readonly reference: string;
  readonly rulingDate: string;
  readonly sourceUrl: string;
}
