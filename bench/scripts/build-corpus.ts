/// Builds the HS classification benchmark corpus from CBP's public rulings.
///
/// Every row is a real customs ruling: a described consignment and the HS
/// subheading an authority assigned to it. Nothing here is written by hand or
/// by a model — the script's whole job is to select, cut and cite, and to drop
/// anything it cannot certify.
///
/// Rerunning is safe and roughly reproducible: results are keyed by ruling
/// number and sorted, so the corpus changes only when CROSS does.
///
///   pnpm --filter @routelock/bench build:corpus

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  search,
  fetchRuling,
  rulingUrl,
  groundTruthHs6,
  formatHs6,
  extractDescription,
  type CorpusRow,
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

/// How many search hits to consider per term. Kept modest so no single term
/// dominates the corpus.
const HITS_PER_TERM = 12;

/// Politeness. CROSS is a public service with no published rate limit; this is
/// well under what a person clicking through the site would generate.
const CONCURRENCY = 4;
const DELAY_MS = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rejection {
  readonly rulingNumber: string;
  readonly reason: string;
}

async function main(): Promise<void> {
  const target = Number(process.env["CORPUS_TARGET"] ?? 300);

  // ---- 1. Collect candidate ruling numbers across all terms.
  const candidates = new Map<string, { tariffs: readonly string[] }>();

  for (const term of TERMS) {
    try {
      const hits = await search(term, HITS_PER_TERM);
      for (const hit of hits) {
        if (hit.operationallyRevoked) continue; // no longer good law
        if (!candidates.has(hit.rulingNumber)) {
          candidates.set(hit.rulingNumber, { tariffs: hit.tariffs });
        }
      }
      process.stdout.write(
        `  searched ${term.padEnd(24)} ${String(candidates.size).padStart(4)} candidates\n`,
      );
    } catch (error) {
      process.stdout.write(`  searched ${term.padEnd(24)} FAILED: ${String(error)}\n`);
    }
    await sleep(DELAY_MS);
  }

  // ---- 2. Drop candidates whose ground truth is already unusable, before
  //         spending a request on their full text.
  const worthFetching = [...candidates.entries()]
    .filter(([, v]) => groundTruthHs6(v.tariffs) !== null)
    .map(([rulingNumber]) => rulingNumber)
    .sort();

  process.stdout.write(
    `\n${candidates.size} candidates, ${worthFetching.length} with a single HS-6 ground truth\n\n`,
  );

  // ---- 3. Fetch full text and cut the description out of each letter.
  const rows: CorpusRow[] = [];
  const rejections: Rejection[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < worthFetching.length && rows.length < target) {
      const rulingNumber = worthFetching[cursor++];
      if (rulingNumber === undefined) return;

      try {
        const ruling = await fetchRuling(rulingNumber);
        if (ruling === null) {
          rejections.push({ rulingNumber, reason: "no-text" });
          continue;
        }

        const hs6 = groundTruthHs6(ruling.tariffs);
        if (hs6 === null) {
          rejections.push({ rulingNumber, reason: "ambiguous-ground-truth" });
          continue;
        }

        const extracted = extractDescription(ruling.text, hs6);
        if (!extracted.ok) {
          rejections.push({ rulingNumber, reason: extracted.reason });
          continue;
        }

        rows.push({
          description: extracted.description,
          hs6,
          hs6Formatted: formatHs6(hs6),
          htsCodes: ruling.tariffs,
          rulingNumber,
          rulingDate: ruling.rulingDate.slice(0, 10),
          sourceUrl: rulingUrl(rulingNumber),
        });
      } catch (error) {
        rejections.push({ rulingNumber, reason: `error: ${String(error)}` });
      }
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  rows.sort((a, b) => a.rulingNumber.localeCompare(b.rulingNumber));

  // ---- 4. Write the corpus and a summary of what was kept and dropped.
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

  const stats = {
    builtAt: new Date().toISOString(),
    source: "CBP CROSS (rulings.cbp.gov)",
    rows: rows.length,
    distinctSubheadings: subheadings.size,
    distinctChapters: Object.keys(chapters).length,
    rowsPerChapter: Object.fromEntries(
      Object.entries(chapters).sort(([a], [b]) => a.localeCompare(b)),
    ),
    candidatesConsidered: candidates.size,
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
    `${rows.length} rows, ${subheadings.size} distinct subheadings across ` +
      `${stats.distinctChapters} chapters\n` +
      `${rejections.length} rejected: ${JSON.stringify(stats.rejectedByReason)}\n`,
  );
}

await main();
