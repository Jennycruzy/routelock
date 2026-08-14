/// A read-only client for the UK's Advance Tariff Rulings database (ATaR).
///
/// ATaR is the UK's post-Brexit equivalent of EU Binding Tariff Information: a
/// classification decision issued by HMRC, binding on the holder and on UK
/// customs, published with a reference number.
///
/// It is a second, independent authority. A corpus drawn from one country
/// measures how well a model reproduces that country's reading of the
/// nomenclature; a corpus drawn from two measures something closer to the
/// nomenclature itself, which is what a cross-border product needs.
///
/// ATaR is also structurally cleaner than a US ruling letter. HMRC publishes the
/// goods description as its own field, separate from the `Justification` field
/// that carries the legal reasoning — so there is no letter to cut apart. The
/// leak guard still runs over it, because a description written by a person can
/// still mention a heading.

const BASE = "https://www.tax.service.gov.uk/search-for-advance-tariff-rulings";

export function atarUrl(reference: string): string {
  return `${BASE}/ruling/${reference}`;
}

export interface AtarRuling {
  readonly reference: string;
  readonly commodityCode: string;
  readonly description: string;
  readonly startDate: string;
}

async function getHtml(url: string): Promise<string> {
  const response = await fetch(url, { headers: { accept: "text/html" } });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.text();
}

/// Minimal entity decoding. HMRC's pages are plain GOV.UK markup and carry only
/// the standard five plus numeric escapes.
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/// Read the `<dt>`/`<dd>` pairs a ruling page is built from.
///
/// Exported so it can be tested against saved markup without a network call.
export function parseRulingPage(
  html: string,
  reference: string,
): AtarRuling | null {
  const fields = new Map<string, string>();

  const pattern = /<dt[^>]*>(.*?)<\/dt>\s*<dd[^>]*>(.*?)<\/dd>/gis;
  for (const match of html.matchAll(pattern)) {
    const key = stripTags(match[1] ?? "");
    const value = stripTags(match[2] ?? "");
    if (key !== "") fields.set(key, value);
  }

  const description = fields.get("Description");
  const rawCode = fields.get("Commodity code");
  if (description === undefined || rawCode === undefined) return null;

  // The page renders the code with a trailing "(opens in new tab)" from the
  // link to the tariff browser.
  const commodityCode = (rawCode.match(/\d[\d\s.]*/)?.[0] ?? "").trim();
  if (commodityCode === "") return null;

  return {
    reference,
    commodityCode,
    description,
    startDate: fields.get("Start date") ?? "",
  };
}

/// Collect ruling references from one page of the results list.
///
/// There is deliberately no search term. The service accepts a `searchTerm`
/// parameter and **ignores it** — "laptop", "banana" and an empty string all
/// return byte-identical first pages — so a term-based collector would quietly
/// gather the same 25 rulings over and over while appearing to sample by
/// commodity. Paging is real, and callers spread their sampling across the
/// range instead.
export async function listReferences(page: number): Promise<string[]> {
  const url = `${BASE}/search?searchTerm=&page=${page}`;
  const html = await getHtml(url);

  const references = new Set<string>();
  for (const match of html.matchAll(
    /\/search-for-advance-tariff-rulings\/ruling\/(\d+)/g,
  )) {
    const reference = match[1];
    if (reference !== undefined) references.add(reference);
  }
  return [...references];
}

export async function fetchRuling(
  reference: string,
): Promise<AtarRuling | null> {
  return parseRulingPage(await getHtml(atarUrl(reference)), reference);
}
