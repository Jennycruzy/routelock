import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normaliseMethodologyId,
  purchasableProjectKeys,
  projectsUrl,
} from "./carbonmark.ts";

test("the two sides of the join agree once punctuation is dropped", () => {
  // Carbonmark writes `AMS-ID`; ICVCM writes `AMS-I.D.`. They are the same
  // CDM methodology, and a join that missed it would drop 8 of the 40 joined
  // rows while reporting a clean result.
  assert.equal(normaliseMethodologyId("AMS-ID"), normaliseMethodologyId("AMS-I.D."));
  assert.equal(normaliseMethodologyId("AMS-IIIG"), normaliseMethodologyId("AMS-III.G."));
  assert.equal(normaliseMethodologyId("acm0002"), normaliseMethodologyId("ACM0002"));
});

test("normalisation does not merge methodologies that differ", () => {
  assert.notEqual(normaliseMethodologyId("VM0044"), normaliseMethodologyId("VMR0044"));
  assert.notEqual(normaliseMethodologyId("AMS-I.D."), normaliseMethodologyId("AMS-I.C."));
  assert.notEqual(normaliseMethodologyId("ACM0002"), normaliseMethodologyId("ACM0006"));
});

test("purchasability counts listings and pool holdings alike", () => {
  const keys = purchasableProjectKeys([
    { supply: 10, listing: { creditId: { projectId: "VCS-191" } } },
    { liquidSupply: 5, pool: { creditId: { projectId: "VCS-844" } } },
    { supply: 3, listing: { creditId: { projectId: "VCS-191" } } },
  ]);
  assert.deepEqual([...keys].sort(), ["VCS-191", "VCS-844"]);
});

test("a listing holding nothing is not an offer", () => {
  // 678 of 753 live price rows are priced and empty. Counting them inflated
  // "purchasable" by a factor of two and filled a corpus with rows the engine
  // refuses on liquidity before the model is asked.
  const keys = purchasableProjectKeys([
    { supply: 0, liquidSupply: 0, listing: { creditId: { projectId: "VCS-1883" } } },
    { supply: 0, liquidSupply: 12, listing: { creditId: { projectId: "VCS-191" } } },
  ]);
  assert.deepEqual([...keys], ["VCS-191"]);
});

test("a price row naming no project is skipped rather than counted", () => {
  const keys = purchasableProjectKeys([{}, { listing: {} }, { pool: { creditId: {} } }]);
  assert.equal(keys.size, 0);
});

test("a registry is always named in the request", () => {
  // The default ordering of /carbonProjects is dominated by a registry with
  // almost no listings, so an unfiltered request would sample the wrong slice.
  assert.match(projectsUrl("VCS"), /[?&]registry=VCS\b/);
  assert.match(projectsUrl("PUR", 50), /[?&]limit=50\b/);
});
