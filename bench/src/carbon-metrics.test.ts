import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreStrength,
  scoreDisclosure,
  byDetermination,
  type ScoredCarbonRow,
} from "./carbon-metrics.ts";

test("a rejected methodology called weak is correct, called strong is wrong", () => {
  assert.equal(scoreStrength("Does not meet", "weak"), "correct");
  assert.equal(scoreStrength("Does not meet", "strong"), "incorrect");
  assert.equal(scoreStrength("Very Unlikely To Meet", "weak"), "correct");
  assert.equal(scoreStrength("Very Unlikely To Meet", "strong"), "incorrect");
});

test("moderate is scored as neither, not quietly as a miss", () => {
  // ICVCM rules on whether a methodology meets the Core Carbon Principles;
  // `methodologyStrength` judges it as evidence a tonne was avoided. Demanding
  // an exact correspondence between the two vocabularies would invent one.
  assert.equal(scoreStrength("Does not meet", "moderate"), "partial");
  assert.equal(scoreStrength("CCP-Approved", "moderate"), "partial");
});

test("an approved methodology called weak is wrong", () => {
  assert.equal(scoreStrength("CCP-Approved", "weak"), "incorrect");
  assert.equal(scoreStrength("CCP-Approved", "strong"), "correct");
});

test("a decision claiming no direction scores no direction", () => {
  // Remedial Action says the programme must fix something, not that the
  // methodology is weak or sound.
  assert.equal(scoreStrength("Remedial Action", "weak"), "partial");
  assert.equal(scoreStrength("Remedial Action", "strong"), "partial");
});

test("naming the authority and voicing a concern are counted separately", () => {
  const cited = scoreDisclosure(["ICVCM found this methodology does not meet the CCPs"]);
  assert.equal(cited.namesAuthority, true);
  assert.equal(cited.namesConcern, true);

  const vague = scoreDisclosure(["Additionality of grid-connected renewables is questioned"]);
  assert.equal(vague.namesAuthority, false);
  assert.equal(vague.namesConcern, true);
});

test("an empty disclosure scores nothing rather than being skipped", () => {
  const none = scoreDisclosure([]);
  assert.deepEqual(none, {
    namesAuthority: false,
    namesSource: false,
    namesConcern: false,
    findingCount: 0,
    findingsWithSource: 0,
  });
});

test("naming some other body counts as a source but not as the authority", () => {
  // The distinction the whole re-score turns on. The engine cites Öko-Institut
  // and Berkeley freely and never cites ICVCM, so a metric that collapsed these
  // two would report the §10 defect as fixed when it is not.
  const other = scoreDisclosure([
    "Öko-Institut's 'How additional is the CDM?' report challenges additionality here",
  ]);

  assert.equal(other.namesSource, true);
  assert.equal(other.namesAuthority, false);
});

test("the authority is always also a source", () => {
  const cited = scoreDisclosure(["ICVCM ruled this methodology does not meet the CCPs"]);

  assert.equal(cited.namesAuthority, true);
  assert.equal(cited.namesSource, true);
});

test("a gesture at unnamed studies is not a source", () => {
  // This is the exact wording the prompt change exists to eliminate: a buyer
  // cannot open "academic studies". Counting it would report success for the
  // failure being measured.
  const vague = scoreDisclosure([
    "Academic studies and NGO analyses have questioned additionality for this project type",
  ]);

  assert.equal(vague.namesSource, false);
  assert.equal(vague.namesConcern, true);
});

test("attribution is counted per finding, not once per row", () => {
  const mixed = scoreDisclosure([
    "Verra tightened hydro additionality rules after 2015",
    "Additionality is contested",
    "Carbon Market Watch has criticised this project type",
  ]);

  assert.equal(mixed.namesSource, true);
  assert.equal(mixed.findingCount, 3);
  assert.equal(mixed.findingsWithSource, 2);
});

const row = (over: Partial<ScoredCarbonRow> & { determination: string }): ScoredCarbonRow & {
  determination: string;
} => ({
  carbonClass: "VCS-1",
  sourceUrl: null,
  methodologyId: "ACM0002",
  decision: "Does not meet",
  decisionDocumentUrl: "https://icvcm.org/x.pdf",
  strength: "weak",
  strengthOutcome: "correct",
  integrityFlags: [],
  confidence: 0.8,
  disclosure: {
    namesAuthority: false,
    namesSource: false,
    namesConcern: true,
    findingCount: 1,
    findingsWithSource: 0,
  },
  adverseFindings: ["Additionality is questioned"],
  verdict: "Approved",
  ...over,
});

test("results group by determination, and carry how thin each one is", () => {
  // 27 projects share the ACM0002 determination. Reporting an accuracy over the
  // rows would state one judgement 27 times and call it sample size.
  const metrics = byDetermination([
    row({ determination: "ACM0002 - Grid-connected" }),
    row({ determination: "ACM0002 - Grid-connected", strengthOutcome: "incorrect" }),
    row({ determination: "AMS-III.G. - Landfill", methodologyId: "AMS-IIIG" }),
  ]);

  assert.equal(metrics.length, 2);
  assert.equal(metrics[0]?.determination, "ACM0002 - Grid-connected");
  assert.equal(metrics[0]?.rows, 2);
  assert.equal(metrics[0]?.correct, 1);
  assert.equal(metrics[0]?.incorrect, 1);
  assert.equal(metrics[1]?.rows, 1);
});

test("an integrity flag is counted per determination, since it is the gating output", () => {
  const metrics = byDetermination([
    row({ determination: "d", integrityFlags: ["withdrawn_methodology"] }),
    row({ determination: "d" }),
  ]);
  assert.equal(metrics[0]?.integrityFlagged, 1);
});
