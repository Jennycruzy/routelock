import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAssessmentStatus,
  extractMethodologyId,
  extractVersions,
  DOCUMENTED_DECISIONS,
} from "./icvcm.ts";

/// Markup shaped like the live table on 17 August 2026: one approved row with
/// both PDFs, one rejected row, one row withdrawn from assessment with no
/// document at all, one row still under assessment, and one revision row whose
/// name cites a different methodology.
const PAGE = `
<p>Table last updated 4th August 2026</p>
<table data-footable_id="18989">
<thead><tr class="footable-header"><th>Category</th><th>Program</th><th>Methodology and Version(s)</th><th>Assessment in Progress</th><th>a</th><th>b</th><th>c</th><th>Status</th></tr></thead>
<tbody>
<tr data-row_id="1">
  <td>Afforestation</td><td>ACR</td>
  <td>ACR Afforestation &amp; Reforestation of Degraded Lands v1.0-1.2</td>
  <td>MSWG 2</td><td></td><td></td><td></td>
  <td><strong><a href='https://icvcm.org/wp-content/uploads/2025/07/ACR_Degraded_Lands.pdf' target='_blank'>CCP-Approved</a></strong><br /><br /><a href='https://icvcm.org/wp-content/uploads/2025/07/Board-Observations_ARR.pdf' target='_blank'>Board Observations</a></td>
</tr>
<tr data-row_id="2">
  <td>Renewable Energy</td><td>Verified Carbon Standard</td>
  <td>ACM0002 - Grid-connected electricity generation from renewable sources - 1.0-21.0</td>
  <td></td><td></td><td></td><td></td>
  <td><strong><a href='https://icvcm.org/wp-content/uploads/2024/08/Renewable-Energy.pdf' target='_blank'>Does not meet</a></strong><br /><br /><a href='https://icvcm.org/wp-content/uploads/2024/08/Board-Observations_RE.pdf' target='_blank'>Board Observations</a></td>
</tr>
<tr data-row_id="3">
  <td>Biochar</td><td>Verified Carbon Standard</td>
  <td>VM0044 Methodology for Biochar Utilization in Soil and Non-Soil Applications - 1.0-1.1</td>
  <td></td><td></td><td></td><td></td>
  <td>Withdrawn</td>
</tr>
<tr data-row_id="4">
  <td>Cookstoves</td><td>Gold Standard</td>
  <td>GS Metered Energy Cooking Devices - 2.0</td>
  <td>Internal Assessment</td><td></td><td></td><td></td>
  <td></td>
</tr>
<tr data-row_id="5">
  <td>Renewable Energy</td><td>Verified Carbon Standard</td>
  <td>VMR0017 - Grid-connected electricity generation from renewable sources (ACM0002 revision) - 1.0</td>
  <td></td><td></td><td></td><td></td>
  <td><strong><a href='https://icvcm.org/wp-content/uploads/2026/03/VMR0017.pdf' target='_blank'>CCP-Approved</a></strong></td>
</tr>
</tbody>
</table>`;

test("reads every row of the methodology table, decided or not", () => {
  const table = parseAssessmentStatus(PAGE);
  assert.equal(table.rows.length, 5);
  assert.equal(table.tableLastUpdated, "4th August 2026");
  assert.equal(table.sourceUrl, "https://icvcm.org/assessment-status/");
});

test("a row still under assessment carries no decision, rather than a negative one", () => {
  // 85 of 181 live rows are in this state. Reading an undecided row as a
  // rejection would invent a finding the authority has not made.
  const undecided = parseAssessmentStatus(PAGE).rows.find(
    (row) => row.methodology.startsWith("GS Metered"),
  );
  assert.ok(undecided);
  assert.equal(undecided.decision, null);
  assert.equal(undecided.decisionDocumentUrl, null);
});

test("a decision links the document it was published in", () => {
  const rejected = parseAssessmentStatus(PAGE).rows.find(
    (row) => row.methodologyId === "ACM0002",
  );
  assert.ok(rejected);
  assert.equal(rejected.decision, "Does not meet");
  assert.equal(
    rejected.decisionDocumentUrl,
    "https://icvcm.org/wp-content/uploads/2024/08/Renewable-Energy.pdf",
  );
  assert.equal(
    rejected.boardObservationsUrl,
    "https://icvcm.org/wp-content/uploads/2024/08/Board-Observations_RE.pdf",
  );
});

test("board observations are never mistaken for the decision document", () => {
  const approved = parseAssessmentStatus(PAGE).rows[0];
  assert.ok(approved);
  assert.equal(approved.decision, "CCP-Approved");
  assert.match(approved.decisionDocumentUrl ?? "", /ACR_Degraded_Lands\.pdf$/);
  assert.notEqual(approved.decisionDocumentUrl, approved.boardObservationsUrl);
});

test("withdrawn from assessment is recorded, and publishes no document", () => {
  // ICVCM's `Withdrawn` means the programme pulled the methodology out of the
  // ICVCM assessment, not that the registry withdrew it. It is stated on the
  // page with no report behind it, so it cannot carry a document URL and must
  // never be read as the engine's `withdrawn_methodology` flag.
  const withdrawn = parseAssessmentStatus(PAGE).rows.find(
    (row) => row.methodologyId === "VM0044",
  );
  assert.ok(withdrawn);
  assert.equal(withdrawn.decision, "Withdrawn");
  assert.equal(withdrawn.decisionDocumentUrl, null);
  assert.ok(!DOCUMENTED_DECISIONS.includes(withdrawn.decision));
});

test("version ranges survive, because decisions disagree across versions", () => {
  // VM0044 is Withdrawn at 1.0-1.1 and CCP-Approved at 1.2 on the live page.
  // Dropping the version would collapse two opposite decisions into one row.
  const rows = parseAssessmentStatus(PAGE).rows;
  assert.equal(rows[0]?.versions, "v1.0-1.2");
  assert.equal(rows[1]?.versions, "1.0-21.0");
  assert.equal(
    rows.find((row) => row.methodologyId === "VM0044")?.versions,
    "1.0-1.1",
  );
});

test("an identifier is read only from the start of the cell", () => {
  // VMR0017 is a CCP-Approved revision *of* ACM0002, which is Does not meet.
  // Joining it onto ACM0002 would credit the engine for the wrong answer.
  const revision = parseAssessmentStatus(PAGE).rows[4];
  assert.ok(revision);
  assert.equal(revision.methodologyId, "VMR0017");
  assert.equal(revision.decision, "CCP-Approved");
});

test("programme is part of the key, since one methodology is assessed twice", () => {
  const rows = parseAssessmentStatus(PAGE).rows;
  assert.equal(rows[1]?.programme, "Verified Carbon Standard");
  assert.equal(rows[0]?.programme, "ACR");
});

test("identifiers are recognised in each form the programmes write them", () => {
  assert.equal(extractMethodologyId("ACM0002 - Grid-connected - 1.0"), "ACM0002");
  assert.equal(extractMethodologyId("AMS-I.D. - Grid connected - 1.0-18.0"), "AMS-I.D.");
  assert.equal(extractMethodologyId("AMS-III.G. - Landfill methane - 9.0"), "AMS-III.G.");
  assert.equal(extractMethodologyId("AM0065 - Replacement of SF6 - 2.1"), "AM0065");
  assert.equal(extractMethodologyId("VM0047 Afforestation - 1.0"), "VM0047");
  assert.equal(extractMethodologyId("VMR0016 Flaring or Use of Landfill Gas - 1.0"), "VMR0016");
});

test("a prose methodology name yields no identifier, and that is not a failure", () => {
  // Gold Standard, Isometric and Puro.earth name methodologies in prose. There
  // is no code to join on, and guessing one would fabricate the join.
  assert.equal(extractMethodologyId("GS Metered Energy Cooking Devices - 2.0"), null);
  assert.equal(extractMethodologyId("Biochar Methodology_2022 - 3.0"), null);
  assert.equal(extractMethodologyId("ISM Mangrove Restoration - 1.0"), null);
});

test("a cell with no version says so instead of guessing one", () => {
  assert.equal(extractVersions("GS Methane Emissions Reduction from Enteric Fermentation"), null);
  assert.equal(extractVersions("VM0045 Improved Forest Management Methodology"), null);
});

test("parsing refuses rather than reading the wrong table", () => {
  // The same page carries a programme-level table. Silently falling through to
  // it would produce a corpus about programmes labelled as methodologies.
  assert.throws(
    () => parseAssessmentStatus("<table data-footable_id='19059'></table>"),
    /no methodology table/,
  );
});
