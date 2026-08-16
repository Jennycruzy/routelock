import assert from "node:assert/strict";
import { test } from "node:test";
import type { Receipt } from "@routelock/fulfilment";

import {
  attest,
  AttestationError,
  registryFields,
  unverifiableFields,
  witness,
} from "./attestation.ts";
import { UNRECORDED } from "./commit.ts";

const DECISION_HASH = `0x${"ab".repeat(32)}` as const;

const receipt: Receipt = {
  ref: "0xretirementtxhash",
  rawResponse: '{"status":"COMPLETED","tonnes":0.001}',
  proofUrl: "https://www.carbonmark.com/retirements/0xabc",
  amountCharged: 0.028136,
  currency: "USDC",
  live: true,
};

test("the pre-fulfilment attestation commits work, evidence and decision", () => {
  const a = attest({
    vertical: "carbon",
    decisionHash: DECISION_HASH,
    work: { tonnes: 0.001, beneficiary: "RouteLock", creditClass: "wind" },
    evidence: { registries: ["UCR"], vintages: [2021, 2022] },
  });

  assert.equal(a.vertical, "carbon");
  assert.equal(a.decisionHash, DECISION_HASH);
  assert.ok(a.work.hash.startsWith("0x"));
  assert.ok(a.evidence.hash.startsWith("0x"));
});

test("provider fields are absent before fulfilment, not zero-filled", () => {
  const a = attest({
    vertical: "carbon",
    decisionHash: DECISION_HASH,
    work: {},
    evidence: {},
  });

  assert.equal(a.providerRef, null);
  assert.equal(a.providerRaw, null);
  assert.equal(a.proofUrl, null);
});

test("unfulfilled registry fields read as the contract's own empty value", () => {
  const fields = registryFields(
    attest({
      vertical: "carbon",
      decisionHash: DECISION_HASH,
      work: {},
      evidence: {},
    }),
  );

  assert.equal(fields.carrierRefHash, UNRECORDED);
  assert.equal(fields.carrierRawHash, UNRECORDED);
  assert.notEqual(fields.parcelHash, UNRECORDED);
});

test("the decision hash is carried through, never recomputed", () => {
  // The value that authorised the spend and the value written on chain must be
  // the same bytes.
  const a = attest({
    vertical: "carbon",
    decisionHash: DECISION_HASH,
    work: { tonnes: 999 },
    evidence: {},
  });

  assert.equal(registryFields(a).decisionHash, DECISION_HASH);
});

test("witnessing adds the provider evidence and the public proof url", () => {
  const a = witness(
    attest({
      vertical: "carbon",
      decisionHash: DECISION_HASH,
      work: {},
      evidence: {},
    }),
    receipt,
  );

  assert.equal(a.providerRef?.preimage, receipt.ref);
  assert.equal(a.providerRaw?.preimage, receipt.rawResponse);
  assert.equal(a.proofUrl, receipt.proofUrl);
  assert.equal(a.providerRaw?.encoding, "verbatim-utf8");
});

test("witnessing does not disturb the commitments already written on chain", () => {
  const before = attest({
    vertical: "carbon",
    decisionHash: DECISION_HASH,
    work: { tonnes: 0.001 },
    evidence: { registries: ["UCR"] },
  });
  const after = witness(before, receipt);

  assert.equal(after.work.hash, before.work.hash);
  assert.equal(after.evidence.hash, before.evidence.hash);
  assert.equal(after.decisionHash, before.decisionHash);
  // And the original is untouched, so a caller holding it cannot be surprised.
  assert.equal(before.providerRef, null);
});

test("an empty provider reference is refused rather than committed", () => {
  const a = attest({
    vertical: "carbon",
    decisionHash: DECISION_HASH,
    work: {},
    evidence: {},
  });

  assert.throws(
    () => witness(a, { ...receipt, ref: "" }),
    (e: unknown) => e instanceof AttestationError && /empty carrierRefHash/.test((e as Error).message),
  );
});

test("an empty raw response is refused rather than committed", () => {
  const a = attest({
    vertical: "carbon",
    decisionHash: DECISION_HASH,
    work: {},
    evidence: {},
  });

  assert.throws(
    () => witness(a, { ...receipt, rawResponse: "" }),
    (e: unknown) => e instanceof AttestationError && /does not exist/.test((e as Error).message),
  );
});

test("a sound attestation has no unverifiable fields", () => {
  const a = witness(
    attest({
      vertical: "carbon",
      decisionHash: DECISION_HASH,
      work: { tonnes: 0.001 },
      evidence: { registries: ["UCR"] },
    }),
    receipt,
  );

  assert.deepEqual(unverifiableFields(a), []);
});

test("tampering is reported by field name, not as a bare failure", () => {
  const a = witness(
    attest({
      vertical: "carbon",
      decisionHash: DECISION_HASH,
      work: { tonnes: 0.001 },
      evidence: { registries: ["UCR"] },
    }),
    receipt,
  );

  const tampered = {
    ...a,
    providerRaw: { ...a.providerRaw!, preimage: '{"status":"COMPLETED","tonnes":1000}' },
  };

  assert.deepEqual(unverifiableFields(tampered), ["carrierRawHash"]);
});

test("multiple tampered fields are all reported", () => {
  const a = witness(
    attest({
      vertical: "carbon",
      decisionHash: DECISION_HASH,
      work: { tonnes: 0.001 },
      evidence: { registries: ["UCR"] },
    }),
    receipt,
  );

  const tampered = {
    ...a,
    work: { ...a.work, preimage: '{"tonnes":1000}' },
    providerRef: { ...a.providerRef!, preimage: "0xsomethingelse" },
  };

  assert.deepEqual(unverifiableFields(tampered), ["parcelHash", "carrierRefHash"]);
});

test("an unfulfilled attestation is verifiable, with nothing to say about the provider", () => {
  const a = attest({
    vertical: "carbon",
    decisionHash: DECISION_HASH,
    work: { tonnes: 0.001 },
    evidence: {},
  });

  assert.deepEqual(unverifiableFields(a), []);
});

test("the same work under a different vertical still commits identically", () => {
  // The contracts carry no vertical, and neither does the commitment. This is
  // the executable form of the claim in docs/adapter-mapping.md.
  const work = { ref: "unit-1", quantity: 1 };
  const carbon = attest({
    vertical: "carbon",
    decisionHash: DECISION_HASH,
    work,
    evidence: {},
  });
  const delivery = attest({
    vertical: "delivery",
    decisionHash: DECISION_HASH,
    work,
    evidence: {},
  });

  assert.equal(carbon.work.hash, delivery.work.hash);
  assert.notEqual(carbon.vertical, delivery.vertical);
});
