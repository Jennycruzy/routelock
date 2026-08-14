/// Builds the HS classification benchmark corpus from two customs authorities.
///
/// Every row is a real ruling: a described consignment and the HS subheading an
/// authority assigned to it. Nothing here is written by hand or by a model — the
/// script selects, cuts and cites, and drops anything it cannot certify.
///
/// Two sources, because RouteLock's route is chosen by whoever is shipping:
///
///   US  CBP CROSS  — binding rulings, published as full letters
///   UK  HMRC ATaR  — advance tariff rulings, published as structured fields
///
/// Rerunning is safe and roughly reproducible: rows are keyed by reference and
/// sorted, so the corpus changes only when the source databases do.
///
///   pnpm --filter @routelock/bench build:corpus

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  search,
  fetchRuling,
  rulingUrl,
  listAtarReferences,
  fetchAtarRuling,
  atarUrl,
  groundTruthHs6,
  formatHs6,
  extractDescription,
  AUTHORITY,
  type CorpusRow,
  type Jurisdiction,
} from "../src/index.ts";

/// Commodity terms, chosen to spread the corpus across the chapters that
/// actually move as parcels rather than to maximise row count. Concentrating on
/// one chapter would let a classifier score well by learning a single answer.
const TERMS = [
  "cotton shirt", "knitted sweater", "leather footwear", "athletic shoes",
  "handbag", "backpack", "wristwatch", "costume jewelry",
  "laptop computer", "mobile phone", "headphones", "power adapter",
  "lithium battery", "electric motor", "led lamp", "solar panel",
  "toy figure", "board game", "bicycle", "fishing rod",
  "kitchen knife", "cookware", "ceramic tableware", "drinking glass",
  "wooden furniture", "mattress", "floor covering", "curtain",
  "shampoo", "lipstick", "perfume", "toothpaste",
  "vitamin supplement", "chocolate confectionery", "coffee", "dried fruit",
  "hand tool", "power drill", "fastener screw", "bearing",
  "automobile part", "tire", "medical device", "surgical instrument",
  "paper stationery", "printed book", "plastic container", "textile fabric",
  "musical instrument", "camera", "pet food", "garden hose",
] as const;

const HITS_PER_TERM = 12;

/// ATaR holds ~6,350 rulings at 25 per page. Walking a stride across the whole
/// range samples the database rather than its most recent corner.
const ATAR_PAGES = 250;
const ATAR_PAGE_STRIDE = 7;

/// Politeness. Neither database publishes a rate limit; this stays well under
/// what a person clicking through either site would generate.
const CONCURRENCY = 4;
const DELAY_MS = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rejection {
  readonly reference: string;
  readonly jurisdiction: Jurisdiction;
  readonly reason: string;
}

const rejections: Rejection[] = [];

function reject(
  reference: string,
  jurisdiction: Jurisdiction,
  reason: string,
): void {
  rejections.push({ reference, jurisdiction, reason });
}

/// Run `task` over `items` with a bounded number of workers.
async function pooled<T>(
  items: readonly T[],
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item === undefined) return;
      await task(item);
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/// ---- US: CBP CROSS ---------------------------------------------------------
async function collectUs(limit: number): Promise<CorpusRow[]> {
  const candidates = new Map<string, readonly string[]>();

  for (const term of TERMS) {
    try {
      for (const hit of await search(term, HITS_PER_TERM)) {
        if (hit.operationallyRevoked) continue; // no longer good law
        if (!candidates.has(hit.rulingNumber)) {
          candidates.set(hit.rulingNumber, hit.tariffs);
        }
      }
    } catch (error) {
      process.stdout.write(`  US search "${term}" failed: ${String(error)}\n`);
    }
    await sleep(DELAY_MS);
  }

  const worthFetching = [...candidates.entries()]
    .filter(([, tariffs]) => groundTruthHs6(tariffs) !== null)
    .map(([reference]) => reference)
    .sort();

  process.stdout.write(
    `US: ${candidates.size} candidates, ${worthFetching.length} with single HS-6 ground truth\n`,
  );

  const rows: CorpusRow[] = [];
  await pooled(worthFetching.slice(0, limit * 2), async (reference) => {
    if (rows.length >= limit) return;
    try {
      const ruling = await fetchRuling(reference);
      if (ruling === null) return reject(reference, "US", "no-text");

      const hs6 = groundTruthHs6(ruling.tariffs);
      if (hs6 === null) return reject(reference, "US", "ambiguous-ground-truth");

      const extracted = extractDescription(ruling.text, hs6);
      if (!extracted.ok) return reject(reference, "US", extracted.reason);

      rows.push({
        description: extracted.description,
        hs6,
        hs6Formatted: formatHs6(hs6),
        nationalCodes: ruling.tariffs,
        jurisdiction: "US",
        reference,
        rulingDate: ruling.rulingDate.slice(0, 10),
        sourceUrl: rulingUrl(reference),
      });
    } catch (error) {
      reject(reference, "US", `error: ${String(error)}`);
    }
  });

  return rows;
}

/// ---- UK: HMRC ATaR ---------------------------------------------------------
///
/// HMRC publishes the goods description as its own field, separate from the
/// `Justification` that carries the legal reasoning, so there is no letter to
/// cut apart. The leak guard still runs: a description written by a person can
/// still name a heading, and that would be just as fatal.
async function collectUk(limit: number): Promise<CorpusRow[]> {
  const references = new Set<string>();

  // Sampled across the whole result set rather than taken from the front.
  // ATaR's list is ordered, so consecutive pages cluster by issue date and
  // therefore by commodity; a stride spreads the sample across the database.
  // (Searching by term is not an option — the service accepts `searchTerm` and
  // ignores it, so every term returns page 1 of the same list.)
  for (let page = 1; page <= ATAR_PAGES; page += ATAR_PAGE_STRIDE) {
    try {
      for (const reference of await listAtarReferences(page)) {
        references.add(reference);
      }
    } catch (error) {
      process.stdout.write(`  UK page ${page} failed: ${String(error)}\n`);
    }
    await sleep(DELAY_MS);
  }

  const sorted = [...references].sort();
  process.stdout.write(`UK: ${sorted.length} candidate rulings\n`);

  const rows: CorpusRow[] = [];
  await pooled(sorted.slice(0, limit * 3), async (reference) => {
    if (rows.length >= limit) return;
    try {
      const ruling = await fetchAtarRuling(reference);
      if (ruling === null) return reject(reference, "UK", "unparsable-page");

      const hs6 = groundTruthHs6([ruling.commodityCode]);
      if (hs6 === null) return reject(reference, "UK", "ambiguous-ground-truth");

      // ATaR descriptions arrive already separated from the reasoning, so they
      // are checked for leakage rather than cut. `extractDescription` expects a
      // letter, so the guard is applied by wrapping the field in the minimum
      // structure it recognises.
      const extracted = extractDescription(
        `Dear Sir:\n\n${ruling.description}\n\nThe applicable subheading`,
        hs6,
      );
      if (!extracted.ok) return reject(reference, "UK", extracted.reason);

      rows.push({
        description: extracted.description,
        hs6,
        hs6Formatted: formatHs6(hs6),
        nationalCodes: [ruling.commodityCode],
        jurisdiction: "UK",
        reference,
        rulingDate: ruling.startDate,
        sourceUrl: atarUrl(reference),
      });
    } catch (error) {
      reject(reference, "UK", `error: ${String(error)}`);
    }
  });

  return rows;
}

async function main(): Promise<void> {
  const perSource = Number(process.env["CORPUS_PER_SOURCE"] ?? 175);

  const us = await collectUs(perSource);
  const uk = await collectUk(perSource);

  const rows = [...us, ...uk].sort((a, b) =>
    a.jurisdiction === b.jurisdiction
      ? a.reference.localeCompare(b.reference)
      : a.jurisdiction.localeCompare(b.jurisdiction),
  );

  const dataDir = join(import.meta.dirname, "..", "data");
  writeFileSync(
    join(dataDir, "corpus.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  const byReason: Record<string, number> = {};
  for (const r of rejections) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;

  const chapters: Record<string, number> = {};
  const subheadings = new Set<string>();
  for (const row of rows) {
    const chapter = row.hs6.slice(0, 2);
    chapters[chapter] = (chapters[chapter] ?? 0) + 1;
    subheadings.add(row.hs6);
  }

  // Subheadings both authorities have ruled on. These are the rows where the
  // two jurisdictions demonstrably agree at HS-6, and they are the evidence
  // that the label travels across borders rather than being a US artefact.
  const usSubheadings = new Set(us.map((r) => r.hs6));
  const ukSubheadings = new Set(uk.map((r) => r.hs6));
  const shared = [...usSubheadings].filter((h) => ukSubheadings.has(h));

  const stats = {
    builtAt: new Date().toISOString(),
    authorities: AUTHORITY,
    rows: rows.length,
    rowsByJurisdiction: { US: us.length, UK: uk.length },
    distinctSubheadings: subheadings.size,
    distinctChapters: Object.keys(chapters).length,
    subheadingsCoveredByBothAuthorities: shared.length,
    rowsPerChapter: Object.fromEntries(
      Object.entries(chapters).sort(([a], [b]) => a.localeCompare(b)),
    ),
    rejected: rejections.length,
    rejectedByReason: Object.fromEntries(
      Object.entries(byReason).sort(([, a], [, b]) => b - a),
    ),
  };
  writeFileSync(
    join(dataDir, "corpus-stats.json"),
    JSON.stringify(stats, null, 2) + "\n",
  );

  process.stdout.write(
    `\n${rows.length} rows (US ${us.length}, UK ${uk.length}), ` +
      `${subheadings.size} subheadings across ${stats.distinctChapters} chapters\n` +
      `${shared.length} subheadings ruled on by both authorities\n` +
      `${rejections.length} rejected: ${JSON.stringify(stats.rejectedByReason)}\n`,
  );
}

await main();
