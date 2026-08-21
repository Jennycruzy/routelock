import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { OfferCatalog } from "./catalog.ts";

test("offer catalogue persists valid class ids and deduplicates them", () => {
  const directory = mkdtempSync(join(tmpdir(), "routelock-offer-catalog-"));
  const path = join(directory, "classes.jsonl");
  const id = `0x${"ab".repeat(32)}`;

  try {
    writeFileSync(path, `0x${"AB".repeat(32)}\nnot-a-class\n${id}\n`, "utf8");
    const catalog = new OfferCatalog(path);
    assert.deepEqual(catalog.ids(), [id]);

    catalog.remember(`0x${"cd".repeat(32)}`);
    catalog.remember(id);
    assert.deepEqual(catalog.ids(), [id, `0x${"cd".repeat(32)}`]);

    const reloaded = new OfferCatalog(path);
    assert.deepEqual(reloaded.ids(), [id, `0x${"cd".repeat(32)}`]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offer catalogue refuses malformed class ids", () => {
  const directory = mkdtempSync(join(tmpdir(), "routelock-offer-catalog-"));
  try {
    const catalog = new OfferCatalog(join(directory, "classes.jsonl"));
    assert.throws(() => catalog.remember("0x1234"), /32-byte service offer id/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
