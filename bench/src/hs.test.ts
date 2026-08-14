import { test } from "node:test";
import assert from "node:assert/strict";
import { hs6FromHts, groundTruthHs6, formatHs6 } from "./hs.ts";

test("truncates an HTS code to its HS-6 subheading", () => {
  assert.equal(hs6FromHts("4202.92.9026"), "420292");
  assert.equal(hs6FromHts("9503.00.0080"), "950300");
});

test("accepts a code written without separators", () => {
  assert.equal(hs6FromHts("4202929026"), "420292");
});

test("accepts a code that is exactly six digits", () => {
  assert.equal(hs6FromHts("4202.92"), "420292");
});

test("rejects a code with fewer than six digits", () => {
  assert.equal(hs6FromHts("4202.9"), null);
  assert.equal(hs6FromHts(""), null);
});

test("rejects US-only chapters, which have no international HS meaning", () => {
  // Chapter 99 is temporary US rate modification, chapter 98 special provisions.
  // Both are US extensions of the HS and exist in no other country's tariff.
  assert.equal(hs6FromHts("9902.12.42"), null);
  assert.equal(hs6FromHts("9801.00.10"), null);
});

test("rejects chapter 00, which is not a real chapter", () => {
  assert.equal(hs6FromHts("0012.34.56"), null);
});

test("takes ground truth from a single-code ruling", () => {
  assert.equal(groundTruthHs6(["4202.92.9026"]), "420292");
});

test("accepts codes that agree at HS-6 but differ in US detail", () => {
  // The same subheading with two statistical suffixes is still one HS answer.
  assert.equal(groundTruthHs6(["4202.92.9026", "4202.92.9060"]), "420292");
});

test("refuses ground truth when a ruling classifies to different subheadings", () => {
  // A letter covering several articles has no single correct answer. Resolving
  // it by taking the first code would score predictions against a coin flip.
  assert.equal(groundTruthHs6(["4202.92.9026", "6110.30.3053"]), null);
});

test("refuses ground truth when every code is unusable", () => {
  assert.equal(groundTruthHs6(["9902.12.42"]), null);
  assert.equal(groundTruthHs6([]), null);
});

test("ignores unusable codes alongside one usable code", () => {
  // A ruling citing both a real subheading and a chapter 99 rate provision
  // still has exactly one HS answer.
  assert.equal(groundTruthHs6(["6110.30.3053", "9903.88.15"]), "611030");
});

test("formats an HS-6 as a dotted subheading", () => {
  assert.equal(formatHs6("420292"), "4202.92");
});
