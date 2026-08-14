/// Download and cache the HS nomenclature.
///
/// Free — the USITC export endpoint involves no model. Run once; the cache under
/// `data/nomenclature/` makes every later run reproducible and offline.
///
///   pnpm --filter @routelock/compliance fetch:nomenclature

import { loadAll } from "../src/nomenclature.ts";

const all = await loadAll((chapter, count) => {
  process.stdout.write(`  chapter ${chapter}: ${count}\n`);
});

process.stdout.write(`\ncached ${all.length} six-digit subheadings\n`);
