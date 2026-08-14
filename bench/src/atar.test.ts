import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRulingPage, atarUrl } from "./atar.ts";

/// Markup shaped like ruling 600003124, including the trailing link text GOV.UK
/// renders after the commodity code and the `Justification` field that must
/// never reach a description.
const PAGE = `
<dl class="govuk-summary-list">
  <dt class="govuk-summary-list__key">Start date</dt>
  <dd class="govuk-summary-list__value">07 Mar 2022</dd>
  <dt class="govuk-summary-list__key">Expiry date</dt>
  <dd class="govuk-summary-list__value">06 Mar 2025</dd>
  <dt class="govuk-summary-list__key">Commodity code</dt>
  <dd class="govuk-summary-list__value">8526920090 <span class="govuk-visually-hidden">(opens in new tab)</span></dd>
  <dt class="govuk-summary-list__key">Description</dt>
  <dd class="govuk-summary-list__value">Remote control for a set-top box, which is voice enabled &amp; battery powered.
     Dimensions: 165mm l x 42mm w x 22mm d.</dd>
  <dt class="govuk-summary-list__key">Keywords</dt>
  <dd class="govuk-summary-list__value">INFRARED REMOTE CONTROL</dd>
  <dt class="govuk-summary-list__key">Justification</dt>
  <dd class="govuk-summary-list__value">Classification has been determined in accordance with GIR 1 and 6,
     and by the terms of heading 8526.</dd>
</dl>`;

test("reads the description and commodity code from a ruling page", () => {
  const ruling = parseRulingPage(PAGE, "600003124");
  assert.ok(ruling);
  assert.equal(ruling.commodityCode, "8526920090");
  assert.equal(ruling.startDate, "07 Mar 2022");
  assert.match(ruling.description, /^Remote control for a set-top box/);
});

test("drops the link text rendered after the commodity code", () => {
  const ruling = parseRulingPage(PAGE, "600003124");
  assert.ok(ruling);
  assert.doesNotMatch(ruling.commodityCode, /opens|new tab/);
});

test("never lets the justification field into the description", () => {
  // Justification states the heading outright. It is a separate field and must
  // stay one — this is the ATaR equivalent of the cut that CROSS letters need.
  const ruling = parseRulingPage(PAGE, "600003124");
  assert.ok(ruling);
  assert.doesNotMatch(ruling.description, /Classification has been determined/);
  assert.doesNotMatch(ruling.description, /8526/);
});

test("decodes HTML entities in the description", () => {
  const ruling = parseRulingPage(PAGE, "600003124");
  assert.ok(ruling);
  assert.match(ruling.description, /voice enabled & battery powered/);
  assert.doesNotMatch(ruling.description, /&amp;/);
});

test("collapses the whitespace GOV.UK markup leaves behind", () => {
  const ruling = parseRulingPage(PAGE, "600003124");
  assert.ok(ruling);
  assert.doesNotMatch(ruling.description, /\s{2,}/);
  assert.doesNotMatch(ruling.description, /\n/);
});

test("returns null when a page is missing the fields it needs", () => {
  assert.equal(parseRulingPage("<p>Service unavailable</p>", "1"), null);
  assert.equal(
    parseRulingPage("<dl><dt>Start date</dt><dd>07 Mar 2022</dd></dl>", "1"),
    null,
  );
});

test("builds the public URL for a ruling", () => {
  assert.equal(
    atarUrl("600003124"),
    "https://www.tax.service.gov.uk/search-for-advance-tariff-rulings/ruling/600003124",
  );
});
