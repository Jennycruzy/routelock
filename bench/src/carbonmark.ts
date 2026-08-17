/// A read-only client for Carbonmark's public catalogue, used to establish what
/// a buyer could actually purchase — the other half of the ICVCM join.
///
/// Both endpoints answer 200 with no API key, which is the property that makes
/// the corpus rebuildable by whoever is checking it.
///
/// Two things are enforced here rather than left to the caller:
///
///   - **Registries are always requested explicitly.** The default ordering of
///     `/carbonProjects` is not representative of what is for sale — the first
///     200 rows are dominated by a registry with almost no listings. Sampling
///     the default order would build a corpus that measures nothing.
///   - **Purchasability comes from `/prices`, not from `hasSupply`.** Supply
///     moves; a listing seen at 18,993 tonnes was at 0.056 minutes later.

const BASE = "https://api.carbonmark.com";

export interface CarbonmarkMethodology {
  readonly id: string;
  readonly category: string | null;
  readonly name: string | null;
}

export interface CarbonmarkProject {
  /// e.g. `VCS-844`. The key `/prices` refers to as `creditId.projectId`.
  readonly key: string;
  readonly projectID: string;
  readonly name: string;
  readonly registry: string;
  readonly country: string | null;
  readonly methodologies: readonly CarbonmarkMethodology[];
  /// The issuing registry's own project page. Every corpus row's `sourceUrl`.
  readonly url: string | null;
  readonly hasSupply: boolean;
}

interface ProjectsResponse {
  readonly items: readonly CarbonmarkProject[];
  readonly itemsCount: number;
}

export function projectsUrl(registry: string, limit = 300): string {
  return `${BASE}/carbonProjects?registry=${encodeURIComponent(registry)}&limit=${limit}`;
}

export function pricesUrl(): string {
  return `${BASE}/prices`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchProjects(
  registry: string,
): Promise<readonly CarbonmarkProject[]> {
  const url = projectsUrl(registry);
  const body = await getJson<ProjectsResponse>(url);
  if (!Array.isArray(body.items)) {
    throw new Error(`${url} returned no items array`);
  }
  if (body.items.length < body.itemsCount) {
    throw new Error(
      `${url} returned ${body.items.length} of ${body.itemsCount} — raise the ` +
        `limit rather than benchmarking a truncated registry`,
    );
  }
  return body.items;
}

/// One listing or pool holding, as `/prices` publishes it.
export interface CarbonmarkPrice {
  readonly supply?: number;
  readonly liquidSupply?: number;
  readonly listing?: { readonly creditId?: { readonly projectId?: string } };
  readonly pool?: { readonly creditId?: { readonly projectId?: string } };
}

export async function fetchPrices(): Promise<readonly CarbonmarkPrice[]> {
  return getJson<readonly CarbonmarkPrice[]>(pricesUrl());
}

/// The project keys a buyer could choose right now.
///
/// A price row can be a listing or a pool holding, and both name the project the
/// same way.
///
/// ⛔ **A price row is not an offer.** On 17 August, **678 of 753** rows carried
/// `supply: 0` and `liquidSupply: 0` — priced, still published, and holding
/// nothing. An earlier version of this function counted every row that named a
/// project, which inflated "purchasable" from 28 projects to 68 and put credits
/// into a benchmark corpus that the engine's own `deterministicGround` then
/// refused on liquidity before the model was ever asked. Supply is the test,
/// and the engine's agreement with that is the reason to trust it.
export function purchasableProjectKeys(
  prices: readonly CarbonmarkPrice[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const price of prices) {
    const projectId =
      price.listing?.creditId?.projectId ?? price.pool?.creditId?.projectId;
    if (!projectId) continue;
    if ((price.supply ?? 0) <= 0 && (price.liquidSupply ?? 0) <= 0) continue;
    keys.add(projectId);
  }
  return keys;
}

/// Methodology identifiers are written differently on each side of the join:
/// Carbonmark returns `AMS-ID` and `AMS-IIIG`, ICVCM writes `AMS-I.D.` and
/// `AMS-III.G.`. Both collapse to the same key once punctuation and case are
/// dropped, and nothing else in either vocabulary collides once they do.
///
/// This is the whole join key, so it is a pure function with its own tests
/// rather than an inline `replace` — a silent miss here would report that no
/// listed methodology has an ICVCM decision, which is the exact number step 2
/// exists to establish.
export function normaliseMethodologyId(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
