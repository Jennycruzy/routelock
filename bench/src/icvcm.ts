/// A read-only client for the ICVCM Core Carbon Principles assessment status.
///
/// <https://icvcm.org/assessment-status/>
///
/// The Integrity Council for the Voluntary Carbon Market publishes, per
/// methodology, whether that methodology meets its Core Carbon Principles. It is
/// an independent body, the determination is methodology-level rather than
/// project-level, and most decisions carry a published assessment report.
///
/// That is the carbon analogue of what CBP and HMRC give the HS corpus: a label
/// nobody on this project wrote. The same rule applies — this module selects,
/// cuts and cites, and records what it cannot certify rather than filling it in.
///
/// Two things this module deliberately does not do:
///
///   - It does not convert a decision into a registry status. ICVCM's
///     `Withdrawn` means withdrawn from *its* assessment process, not withdrawn
///     by the issuing registry, and the two are scored on different axes.
///     See `IcvcmDecision` below.
///   - It does not date a decision. The page carries one date for the whole
///     table and none per row, so `tableLastUpdated` is the only date that can
///     be cited. The upload path of a decision document is recorded verbatim as
///     a URL and not reinterpreted as a decision date.

const ASSESSMENT_STATUS_URL = "https://icvcm.org/assessment-status/";

/// The methodology table. There is a second table on the same page listing
/// carbon-crediting *programmes*, which is a different unit of assessment.
const METHODOLOGY_TABLE_ID = "18989";

/// The status vocabulary the page actually uses, verbatim. `Does not meet` is
/// lower-case on the page; it is kept that way rather than tidied, because a
/// label that has been reformatted is a label somebody edited.
///
/// The two undocumented values matter and are not interchangeable with the rest:
///
///   `Very Unlikely To Meet` — a forward-looking statement about methodologies
///   ICVCM has not assessed and does not expect to approve. No report is
///   published per row.
///
///   `Withdrawn` — the methodology was withdrawn *from the ICVCM assessment
///   process*, by the programme that submitted it. It says nothing about whether
///   the issuing registry still considers the methodology active, and it is not
///   evidence for the engine's `withdrawn_methodology` integrity flag. No report
///   is published per row.
export const ICVCM_DECISIONS = [
  "CCP-Approved",
  "Does not meet",
  "Remedial Action",
  "Very Unlikely To Meet",
  "Withdrawn",
] as const;

export type IcvcmDecision = (typeof ICVCM_DECISIONS)[number];

/// Decisions that come with a published assessment report, and therefore clear
/// the corpus standard of "every label opens a primary document".
export const DOCUMENTED_DECISIONS: readonly IcvcmDecision[] = [
  "CCP-Approved",
  "Does not meet",
  "Remedial Action",
];

export interface IcvcmRow {
  /// ICVCM's own category grouping, e.g. "Landfill Gas".
  readonly category: string;
  /// The carbon-crediting programme that submitted the methodology, e.g.
  /// "Verified Carbon Standard". The same methodology identifier is assessed
  /// separately under different programmes, so this is part of the key.
  readonly programme: string;
  /// The methodology cell verbatim, e.g.
  /// "ACM0002 - Grid-connected electricity generation from renewable sources - 1.0-21.0".
  readonly methodology: string;
  /// The leading identifier where the cell carries one — `ACM0002`, `AMS-I.D.`,
  /// `VM0047`. Null where the programme names its methodology in prose instead,
  /// which is most of Gold Standard, Isometric and Puro.earth. Null is not a
  /// parse failure; it means there is no code to join on.
  readonly methodologyId: string | null;
  /// The version or version range the decision covers, verbatim — "1.0-21.0",
  /// "v1.0-1.2", "2.2". Null where the cell states none.
  ///
  /// This is not decoration. Decisions are version-scoped and they diverge:
  /// VM0044 is Withdrawn at 1.0-1.1 and CCP-Approved at 1.2.
  readonly versions: string | null;
  /// Null while the methodology is still under assessment — 85 of 181 rows on
  /// 17 August 2026. An undecided row is not a negative label.
  readonly decision: IcvcmDecision | null;
  /// The assessment report or board decision for this row. Null for
  /// `Very Unlikely To Meet` and `Withdrawn`, which the page states without
  /// publishing a per-row document.
  readonly decisionDocumentUrl: string | null;
  /// The board observations PDF, where one is published alongside the decision.
  readonly boardObservationsUrl: string | null;
}

export interface IcvcmTable {
  /// "4th August 2026" — the page's own words. The only date it publishes.
  readonly tableLastUpdated: string | null;
  readonly sourceUrl: string;
  readonly rows: readonly IcvcmRow[];
}

export function assessmentStatusUrl(): string {
  return ASSESSMENT_STATUS_URL;
}

export async function fetchAssessmentStatus(): Promise<string> {
  const response = await fetch(ASSESSMENT_STATUS_URL, {
    headers: { accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(`${ASSESSMENT_STATUS_URL} responded ${response.status}`);
  }
  return response.text();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8211;/g, "–")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    );
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/// Methodology identifiers as the programmes write them: CDM codes (`ACM0002`,
/// `AM0065`), CDM small-scale codes (`AMS-I.D.`, `AMS-III.G.`), and Verra codes
/// (`VM0047`, `VMR0016`). Anchored at the start of the cell, because a code
/// mentioned mid-sentence is a cross-reference to another methodology rather
/// than this row's own identifier — `VMR0017 - ... (ACM0002 revision)` is a
/// CCP-Approved row that must not be joined onto ACM0002, which is not.
/// The lookahead rather than `\b` is deliberate: `AMS-I.D.` ends in a full stop,
/// and a word boundary after it never matches.
const IDENTIFIER =
  /^(ACM\d{4}|AMS-[IVX]+\.[A-Z]\.?|AM\d{4}|VMR\d{4}|VM\d{4})(?=[\s,]|$)/;

/// Version suffixes, in the two shapes the page uses: " - 1.0-21.0" after a
/// separating dash, and " v1.0-1.2" attached to a prose name.
const TRAILING_VERSION = /\s[-–]\s*(\d+(?:\.\d+)*(?:\s*[-–]\s*\d+(?:\.\d+)*)?)\s*$/;
const ATTACHED_VERSION = /\s(v\d+(?:\.\d+)*(?:\s*[-–]\s*\d+(?:\.\d+)*)?)\s*$/i;

export function extractMethodologyId(methodology: string): string | null {
  return IDENTIFIER.exec(methodology.trim())?.[1] ?? null;
}

export function extractVersions(methodology: string): string | null {
  const version =
    TRAILING_VERSION.exec(methodology)?.[1] ?? ATTACHED_VERSION.exec(methodology)?.[1];
  return version ? version.replace(/\s*[-–]\s*/, "-") : null;
}

function firstHref(html: string, linkText: string): string | null {
  const pattern = new RegExp(
    `<a[^>]*href=['"]([^'"]+)['"][^>]*>\\s*${linkText}`,
    "i",
  );
  return pattern.exec(html)?.[1] ?? null;
}

function readDecision(cell: string): IcvcmDecision | null {
  const text = plainText(cell);
  // Longest first, so "Does not meet" is not shadowed by a shorter prefix.
  for (const decision of [...ICVCM_DECISIONS].sort(
    (a, b) => b.length - a.length,
  )) {
    if (text.toLowerCase().startsWith(decision.toLowerCase())) return decision;
  }
  return null;
}

function tableSegment(page: string, tableId: string): string | null {
  const start = page.indexOf(`data-footable_id="${tableId}"`);
  if (start < 0) return null;
  const end = page.indexOf("</table>", start);
  return end < 0 ? null : page.slice(start, end);
}

function readLastUpdated(page: string): string | null {
  return /Table last updated\s*([^<]+)/i.exec(page)?.[1]?.trim() ?? null;
}

/// Parses the methodology table out of the page.
///
/// The table is server-rendered — the Ninja Tables REST route the plugin
/// normally exposes answers 404 on this site, and the rows are in the HTML
/// instead. That is better for the corpus than an API would be: what is parsed
/// here is exactly what a reader sees at the cited URL.
export function parseAssessmentStatus(page: string): IcvcmTable {
  const segment = tableSegment(page, METHODOLOGY_TABLE_ID);
  if (!segment) {
    throw new Error(
      `no methodology table (id ${METHODOLOGY_TABLE_ID}) in the page — ` +
        `the table id or the page structure has changed, and parsing further ` +
        `would produce a corpus from the wrong table`,
    );
  }

  const rows: IcvcmRow[] = [];
  for (const [, rowHtml] of segment.matchAll(
    /<tr[^>]*data-row_id[^>]*>([\s\S]*?)<\/tr>/g,
  )) {
    const cells = [...(rowHtml ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (cell) => cell[1] ?? "",
    );
    // Eight columns: category, programme, methodology, four progress markers,
    // status. A row with fewer is not this table's shape.
    if (cells.length < 8) continue;

    const methodology = plainText(cells[2] ?? "");
    if (!methodology) continue;

    const statusCell = cells[7] ?? "";
    const decision = readDecision(statusCell);

    rows.push({
      category: plainText(cells[0] ?? ""),
      programme: plainText(cells[1] ?? ""),
      methodology,
      methodologyId: extractMethodologyId(methodology),
      versions: extractVersions(methodology),
      decision,
      decisionDocumentUrl: decision ? firstHref(statusCell, decision) : null,
      boardObservationsUrl: firstHref(statusCell, "Board Observations"),
    });
  }

  return {
    tableLastUpdated: readLastUpdated(page),
    sourceUrl: ASSESSMENT_STATUS_URL,
    rows,
  };
}
