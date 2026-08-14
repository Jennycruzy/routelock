import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDescription } from "./extract.ts";

/// Verbatim opening of ruling N245007, including the `\r` line endings and the
/// tabs CROSS actually returns. Trimmed only at the end, mid-conclusion.
const N245007 =
  "\fN245007\r\rSeptember 4, 2013\r\rCLA-2-42:OT:RR:NC:N4:441 \r\rCATEGORY:\tClassification\r\r" +
  "TARIFF NO.: 4202.92.9026\r\rAdam Lees\rPanalpina Inc.\r1000A Castle Road\rSecaucus, NJ 07094\r\r" +
  "RE:\tThe tariff classification of laptop computer sleeves from China\r\r" +
  "Dear Mr. Lees:\r\r" +
  "In your letter dated August 7, 2013, you requested a tariff classification ruling on behalf of Paper Rain, Inc.  " +
  "You have submitted samples which we are returning to you. \r                           \r" +
  "Article 27812 is a laptop sleeve constructed with an outer surface of 100% nylon textile material. " +
  "The sleeve is specially shaped and fitted to contain one laptop computer. It is designed to provide " +
  "storage, protection, organization, and portability to the laptop.\r\r" +
  "The applicable subheading for the laptop sleeves will be 4202.92.9026, Harmonized Tariff Schedule of " +
  "the United States (HTSUS), which provides for other containers and cases";

test("extracts the goods description from a real ruling", () => {
  const result = extractDescription(N245007, "420292");
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.match(result.description, /^You have submitted samples/);
  assert.match(result.description, /outer surface of 100% nylon textile/);
});

test("cuts the header, which states the answer before the letter begins", () => {
  const result = extractDescription(N245007, "420292");
  assert.ok(result.ok);
  assert.doesNotMatch(result.description, /TARIFF NO/);
  assert.doesNotMatch(result.description, /4202/);
});

test("cuts the conclusion, which states the answer again", () => {
  const result = extractDescription(N245007, "420292");
  assert.ok(result.ok);
  assert.doesNotMatch(result.description, /applicable subheading/);
  assert.doesNotMatch(result.description, /HTSUS/);
});

test("strips the procedural opener but keeps the goods", () => {
  const result = extractDescription(N245007, "420292");
  assert.ok(result.ok);
  assert.doesNotMatch(result.description, /you requested a tariff classification/);
  assert.match(result.description, /Article 27812/);
});

test("keeps a sentence that only begins like the procedural opener", () => {
  // "You are requesting the tariff classification on an item that is described
  // as a Spider-Man 3 Spider-Smart Learning Laptop" is the description itself.
  const text =
    "Dear Mr. Baskin:\r\r\tYou are requesting the tariff classification on an item that is " +
    "described as a Spider-Man 3 Spider-Smart Learning Laptop, Model Number SM-737. The product is " +
    "an electronic toy designed for children of ages five and up, modelled after a laptop computer " +
    "and decorated with an image of a comic book character.\r\r" +
    "The applicable subheading for the toy will be 9503.00.0080";

  const result = extractDescription(text, "950300");
  assert.ok(result.ok);
  assert.match(result.description, /Spider-Smart Learning Laptop/);
});

test("normalizes whitespace without altering wording", () => {
  const result = extractDescription(N245007, "420292");
  assert.ok(result.ok);
  assert.doesNotMatch(result.description, /[\r\t\f]/);
  assert.doesNotMatch(result.description, /  /);
});

test("refuses a description that still contains a dotted tariff code", () => {
  const text =
    "Dear Sir:\r\rThe item is a cotton shirt of woven construction, which you believe falls in " +
    "6205.20 given its composition and the manner in which it is finished for retail sale.\r\r" +
    "The applicable subheading will be 6205.20.2050";

  const result = extractDescription(text, "620520");
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.reason, "answer-leaked");
});

test("refuses a description that names its own answer undotted", () => {
  const text =
    "Dear Sir:\r\rThe merchandise is a woven cotton shirt for men, cut and sewn for retail sale, " +
    "reported by the importer under 620520 in previous entries of the same style.\r\r" +
    "The applicable subheading will be 6205.20.2050";

  const result = extractDescription(text, "620520");
  assert.ok(!result.ok);
  assert.equal(result.reason, "answer-leaked");
});

test("refuses when the cut lands inside the legal analysis", () => {
  // Tariff vocabulary in the body means the description boundary was missed,
  // and the surrounding text is reasoning rather than a description of goods.
  const text =
    "Dear Sir:\r\rThe subheading that applies to this article depends on whether the outer surface " +
    "is of textile or of plastic sheeting, a question addressed at length in the notes to the " +
    "chapter and in prior rulings on comparable carrying cases.\r\r" +
    "Consequently, the article is classified as a container";

  const result = extractDescription(text, "420292");
  assert.ok(!result.ok);
  assert.equal(result.reason, "answer-leaked");
});

test("refuses text saying HTSUSA, which \\bHTSUS\\b does not match", () => {
  // Verbatim from ruling G89720, which reached the corpus on the first build:
  // naming the chapter discloses the first two digits of its own answer.
  const text =
    "Dear Sir:\r\rThe merchandise is a set of swim gear comprising a snorkel mask, a breathing " +
    "tube and a pair of swim fins, packed together with a drawstring backpack for retail sale. " +
    "The snorkel mask, breathing tube and swim fins are classifiable in Chapter 95 of the HTSUSA " +
    "as other water sport equipment.\r\rThe applicable subheading will be 9506.29.0040";

  const result = extractDescription(text, "950629");
  assert.ok(!result.ok);
  assert.equal(result.reason, "answer-leaked");
});

test("refuses a bare chapter reference, which is the answer's first two digits", () => {
  const text =
    "Dear Sir:\r\rThe article is a moulded plastic storage crate with a hinged lid, intended for " +
    "domestic use, which the importer entered under Chapter 39 in previous shipments of the same " +
    "design and dimensions.\r\rThe applicable subheading will be 3924.90.5650";

  const result = extractDescription(text, "392490");
  assert.ok(!result.ok);
  assert.equal(result.reason, "answer-leaked");
});

test("refuses an answer written with a space or dash instead of a dot", () => {
  // A raw substring test sees none of these; the digit-stripped check does.
  for (const written of ["6205 20", "6205-20", "6205. 20"]) {
    const text =
      `Dear Sir:\r\rThe merchandise is a men's woven shirt of cotton, cut and sewn for retail ` +
      `sale, which the importer has entered as ${written} on prior occasions without objection ` +
      `from the port of entry concerned.\r\rConsequently, the shirt is a garment`;

    const result = extractDescription(text, "620520");
    assert.ok(!result.ok, `expected a leak for ${written}`);
    assert.equal(result.reason, "answer-leaked");
  }
});

test("refuses a letter with no goods description of usable length", () => {
  const text =
    "Dear Sir:\r\rIn your letter dated May 1, 2014, you requested a tariff classification ruling.\r\r" +
    "The applicable subheading will be 4202.92.9026";

  const result = extractDescription(text, "420292");
  assert.ok(!result.ok);
  assert.equal(result.reason, "too-short");
});

test("refuses a letter whose structure it does not recognise", () => {
  const noSalutation = extractDescription("A memorandum with no letter form.", "420292");
  assert.ok(!noSalutation.ok);
  assert.equal(noSalutation.reason, "no-salutation");

  const noConclusion = extractDescription(
    "Dear Sir:\r\rA description of goods that runs on for a while without ever reaching the " +
      "point at which the officer states which subheading was chosen for them in the end.",
    "420292",
  );
  assert.ok(!noConclusion.ok);
  assert.equal(noConclusion.reason, "no-conclusion");
});
