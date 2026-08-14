/// A read-only client for CBP's public rulings database (CROSS).
///
/// CROSS publishes binding tariff classification rulings: a customs officer's
/// description of specific goods together with the classification that officer
/// issued. That pairing is what makes it usable as ground truth — the label is
/// an authority's determination, not an annotator's opinion, and every row can
/// be checked by anyone against a citable ruling number.

const API = "https://rulings.cbp.gov/api";

/// Public per-ruling page, recorded on every corpus row so a reader can audit it.
export function rulingUrl(rulingNumber: string): string {
  return `https://rulings.cbp.gov/ruling/${rulingNumber}`;
}

export interface SearchHit {
  readonly rulingNumber: string;
  readonly subject: string;
  readonly rulingDate: string;
  readonly tariffs: readonly string[];
  readonly operationallyRevoked: boolean;
}

export interface RulingDetail extends SearchHit {
  readonly text: string;
}

interface SearchResponse {
  readonly rulings?: readonly Partial<SearchHit>[];
  readonly totalHits?: number;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return response.json();
}

/// Search rulings for a commodity term.
///
/// Only classification rulings carry a tariff number, so hits without one are
/// dropped here rather than surviving to become rows with no ground truth.
export async function search(
  term: string,
  pageSize: number,
): Promise<SearchHit[]> {
  const url =
    `${API}/search?term=${encodeURIComponent(term)}` +
    `&collection=ALL&sortBy=RELEVANCE&pageSize=${pageSize}&page=1`;

  const body = (await getJson(url)) as SearchResponse;
  const hits = body.rulings ?? [];

  const usable: SearchHit[] = [];
  for (const hit of hits) {
    if (
      typeof hit.rulingNumber !== "string" ||
      !Array.isArray(hit.tariffs) ||
      hit.tariffs.length === 0
    ) {
      continue;
    }
    usable.push({
      rulingNumber: hit.rulingNumber,
      subject: typeof hit.subject === "string" ? hit.subject : "",
      rulingDate: typeof hit.rulingDate === "string" ? hit.rulingDate : "",
      tariffs: hit.tariffs,
      operationallyRevoked: hit.operationallyRevoked === true,
    });
  }
  return usable;
}

/// Fetch one ruling's full letter text.
export async function fetchRuling(
  rulingNumber: string,
): Promise<RulingDetail | null> {
  const body = (await getJson(`${API}/ruling/${rulingNumber}`)) as
    | Partial<RulingDetail>
    | null;

  if (body === null || typeof body.text !== "string") return null;
  if (!Array.isArray(body.tariffs) || body.tariffs.length === 0) return null;

  return {
    rulingNumber,
    subject: typeof body.subject === "string" ? body.subject : "",
    rulingDate: typeof body.rulingDate === "string" ? body.rulingDate : "",
    tariffs: body.tariffs,
    operationallyRevoked: body.operationallyRevoked === true,
    text: body.text,
  };
}
