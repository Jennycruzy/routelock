/// Tests for the rule that decides who gets paid when escrow is unwound.
///
/// `decideSettlement` is the whole of `recover-escrow.ts` that matters, and it
/// is pure precisely so it can be tested without a chain, a key or a balance.
/// The script around it is I/O.
///
/// What is being protected: `releaseToIssuer` and `refundBuyer` emit different
/// permanent events and pay different parties. A bug here does not throw — it
/// quietly pays the wrong person and writes a false account of whether the
/// service was performed.

import assert from "node:assert/strict";
import { test } from "node:test";

import { EntitlementState } from "./abi.ts";
import { decideSettlement } from "../scripts/recover-escrow.ts";

const EVERY_STATE = [
  EntitlementState.Available,
  EntitlementState.PendingReview,
  EntitlementState.Activated,
  EntitlementState.LabelCreated,
  EntitlementState.InTransit,
  EntitlementState.Delivered,
  EntitlementState.Remedied,
  EntitlementState.Expired,
];

test("committed carrier evidence pays the issuer, whatever the state says", () => {
  // The evidence is the provider's own, hashed on chain. It outranks the
  // lifecycle enum, which is written by this project about itself.
  for (const state of EVERY_STATE) {
    assert.equal(decideSettlement(true, state).action, "release", `state ${state}`);
  }
});

test("no evidence and no claim of carriage refunds the buyer", () => {
  for (const state of [
    EntitlementState.Available,
    EntitlementState.PendingReview,
    EntitlementState.Activated,
    EntitlementState.Remedied,
    EntitlementState.Expired,
  ]) {
    assert.equal(decideSettlement(false, state).action, "refund", `state ${state}`);
  }
});

/// The case worth having a script refuse over.
///
/// `LabelCreated` onwards means the oracle recorded that a carrier took the
/// goods, but a missing `carrierRefHash` means no provider evidence was ever
/// committed. One of those two records is wrong. Guessing pays the wrong party
/// irreversibly; refusing one token costs nothing and can be resolved by a human
/// who can look at what actually happened.
test("a state claiming carriage without evidence is refused, not guessed", () => {
  for (const state of [
    EntitlementState.LabelCreated,
    EntitlementState.InTransit,
    EntitlementState.Delivered,
  ]) {
    const decision = decideSettlement(false, state);
    assert.equal(decision.action, "refuse", `state ${state}`);
    assert.match(decision.reason, /contradict/);
  }
});

test("an approved-but-unfulfilled entitlement refunds rather than releases", () => {
  // The live shape of tokens 1, 2 and 4 on X Layer testnet: compliance ruled,
  // and for 1 and 2 nothing was ever performed. Approval is not fulfilment, and
  // paying the issuer on approval alone would be the single most damaging
  // mistake this script could make — it is the exact separation the escrow's
  // COMPLIANCE_ROLE refusal exists to enforce.
  assert.equal(decideSettlement(false, EntitlementState.Activated).action, "refund");
});

test("every decision explains itself", () => {
  for (const fulfilled of [true, false]) {
    for (const state of EVERY_STATE) {
      const { reason } = decideSettlement(fulfilled, state);
      assert.notEqual(reason.trim(), "", `state ${state}, fulfilled=${fulfilled}`);
    }
  }
});
