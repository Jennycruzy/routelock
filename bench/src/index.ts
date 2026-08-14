export { hs6FromHts, groundTruthHs6, formatHs6 } from "./hs.ts";
export { extractDescription } from "./extract.ts";
export type { ExtractionResult } from "./extract.ts";
export { search, fetchRuling, rulingUrl } from "./cross.ts";
export type { SearchHit, RulingDetail } from "./cross.ts";

/// One scored row of the benchmark.
export interface CorpusRow {
  /// The goods description, verbatim from the ruling, with the answer removed.
  readonly description: string;
  /// HS-6 subheading, e.g. `420292`. The label a prediction is scored against.
  readonly hs6: string;
  /// Dotted form, e.g. `4202.92`, for display.
  readonly hs6Formatted: string;
  /// The full HTS codes the ruling issued, kept so the truncation is auditable.
  readonly htsCodes: readonly string[];
  /// Citation. Every row is checkable against the public database.
  readonly rulingNumber: string;
  readonly rulingDate: string;
  readonly sourceUrl: string;
}
