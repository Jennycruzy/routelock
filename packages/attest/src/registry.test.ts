/// Tests for the registry client's refusals.
///
/// Every test here is a transaction that must *not* be sent. The successful
/// path is exercised against the real chain by `scripts/attest-dry-run.ts`,
/// because a mocked success proves only that the mock was written to agree with
/// the code — whereas a refusal is a decision this code makes on its own, and
/// that is worth pinning down.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, PublicClient, WalletClient } from "viem";
import { Verdict } from "@routelock/compliance";
import type { Receipt } from "@routelock/fulfilment";

import { EntitlementState } from "./abi.ts";
import { attest, witness } from "./attestation.ts";
import type { Attestation } from "./attestation.ts";
import { ActivationRegistryClient, RegistryError } from "./registry.ts";

const REGISTRY = "0x38D8a1e9bC45378E4019320ECa4fc5431BeF40Bb" as Address;
const ENTITLEMENT = "0x8A9A92a5Cd3c1eF2D2F0b5cD67E33e73949C992b" as Address;
const DECISION_HASH = `0x${"ab".repeat(32)}` as const;

const receipt: Receipt = {
  ref: "0xretirementtxhash",
  rawResponse: '{"status":"COMPLETED","tonnes":0.001}',
  proofUrl: "https://www.carbonmark.com/retirements/0xabc",
  amountCharged: 0.028136,
  currency: "USDC",
  live: true,
};

function sound(): Attestation {
  return attest({
    vertical: "carbon",
    decisionHash: DECISION_HASH,
    work: { tonnes: 0.001, creditClass: "wind" },
    evidence: { registries: ["UCR"] },
  });
}

/// A public client that answers only what a given test needs. Anything else
/// throws, so a test cannot pass by accidentally reaching an unstubbed call.
function stubPublic(options: {
  state?: EntitlementState;
  boundEntitlement?: Address;
  onSimulate?: () => void;
}): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "entitlement") return options.boundEntitlement ?? ENTITLEMENT;
      if (functionName === "stateOf") {
        if (options.state === undefined) throw new Error("stateOf not stubbed");
        return options.state;
      }
      throw new Error(`unstubbed read: ${functionName}`);
    },
    simulateContract: async () => {
      options.onSimulate?.();
      return { request: {} };
    },
    // The client waits for writes to settle before returning, so a stub that
    // omits this makes every write test hang or throw.
    waitForTransactionReceipt: async () => ({ status: "success" }),
  } as unknown as PublicClient;
}

function stubWallet(onWrite?: () => void): WalletClient {
  return {
    account: { address: "0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6" },
    writeContract: async () => {
      onWrite?.();
      return `0x${"11".repeat(32)}`;
    },
  } as unknown as WalletClient;
}

test("a read-only client refuses to write, and says why", async () => {
  const client = new ActivationRegistryClient(
    stubPublic({ state: EntitlementState.Available }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
  );

  await assert.rejects(
    () => client.submitParcel(1n, sound()),
    (e: unknown) => e instanceof RegistryError && /read-only/.test((e as Error).message),
  );
});

test("an attestation that does not verify is never sent", async () => {
  let sent = false;
  const client = new ActivationRegistryClient(
    stubPublic({ state: EntitlementState.Available, onSimulate: () => (sent = true) }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(() => (sent = true)),
  );

  const a = sound();
  const tampered = { ...a, work: { ...a.work, preimage: '{"tonnes":1000}' } };

  await assert.rejects(
    () => client.submitParcel(1n, tampered),
    (e: unknown) => e instanceof RegistryError && /parcelHash/.test((e as Error).message),
  );
  assert.equal(sent, false, "nothing may reach the chain");
});

test("a registry bound to a different entitlement is refused", async () => {
  const client = new ActivationRegistryClient(
    stubPublic({
      state: EntitlementState.Available,
      boundEntitlement: "0x0000000000000000000000000000000000000dead" as Address,
    }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(),
  );

  await assert.rejects(
    () => client.submitParcel(1n, sound()),
    (e: unknown) => e instanceof RegistryError && /bound to entitlement/.test((e as Error).message),
  );
});

test("submitting a token that is not Available names the state it is in", async () => {
  const client = new ActivationRegistryClient(
    stubPublic({ state: EntitlementState.InTransit }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(),
  );

  await assert.rejects(
    () => client.submitParcel(1n, sound()),
    (e: unknown) => e instanceof RegistryError && /is InTransit/.test((e as Error).message),
  );
});

test("submitting an Available token reaches the chain", async () => {
  let sent = false;
  const client = new ActivationRegistryClient(
    stubPublic({ state: EntitlementState.Available }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(() => (sent = true)),
  );

  await client.submitParcel(1n, sound());
  assert.equal(sent, true);
});

test("Verdict.None is refused before it can revert", async () => {
  const client = new ActivationRegistryClient(
    stubPublic({ state: EntitlementState.PendingReview }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(),
  );

  await assert.rejects(
    () => client.recordDecision(1n, DECISION_HASH, "compliance-1.0.0", Verdict.None),
    (e: unknown) => e instanceof RegistryError && /Verdict.None/.test((e as Error).message),
  );
});

test("a decision with no engine version is refused", async () => {
  const client = new ActivationRegistryClient(
    stubPublic({ state: EntitlementState.PendingReview }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(),
  );

  await assert.rejects(
    () => client.recordDecision(1n, DECISION_HASH, "", Verdict.Approved),
    (e: unknown) => e instanceof RegistryError && /engine version/.test((e as Error).message),
  );
});

test("the zero hash is refused as a decision", async () => {
  const client = new ActivationRegistryClient(
    stubPublic({ state: EntitlementState.PendingReview }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(),
  );

  await assert.rejects(
    () => client.recordDecision(1n, `0x${"0".repeat(64)}`, "compliance-1.0.0", Verdict.Approved),
    (e: unknown) => e instanceof RegistryError && /zero hash/.test((e as Error).message),
  );
});

test("recording a decision on a token not under review explains the revert", async () => {
  const client = new ActivationRegistryClient(
    stubPublic({ state: EntitlementState.Available }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(),
  );

  await assert.rejects(
    () => client.recordDecision(1n, DECISION_HASH, "compliance-1.0.0", Verdict.Approved),
    (e: unknown) => e instanceof RegistryError && /NotUnderReview/.test((e as Error).message),
  );
});

test("a refusal is recorded exactly as an approval is", async () => {
  // Refusal is a success path. It must reach the chain, not be filtered out.
  for (const verdict of [Verdict.Approved, Verdict.NeedsInformation, Verdict.Refused]) {
    let sent = false;
    const client = new ActivationRegistryClient(
      stubPublic({ state: EntitlementState.PendingReview }),
      { registry: REGISTRY, entitlement: ENTITLEMENT },
      stubWallet(() => (sent = true)),
    );

    await client.recordDecision(1n, DECISION_HASH, "compliance-1.0.0", verdict);
    assert.equal(sent, true, `verdict ${verdict} must be committed on chain`);
  }
});

test("provider evidence cannot be recorded before fulfilment", async () => {
  const client = new ActivationRegistryClient(
    stubPublic({ state: EntitlementState.Activated }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(),
  );

  await assert.rejects(
    () => client.recordCarrier(1n, sound()),
    (e: unknown) => e instanceof RegistryError && /no provider evidence/.test((e as Error).message),
  );
});

test("provider evidence on an unapproved token explains the revert", async () => {
  const client = new ActivationRegistryClient(
    stubPublic({ state: EntitlementState.PendingReview }),
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(),
  );

  await assert.rejects(
    () => client.recordCarrier(1n, witness(sound(), receipt)),
    (e: unknown) => e instanceof RegistryError && /NotActivated/.test((e as Error).message),
  );
});

test("provider evidence on an activated token reaches the chain", async () => {
  for (const state of [
    EntitlementState.Activated,
    EntitlementState.LabelCreated,
    EntitlementState.InTransit,
  ]) {
    let sent = false;
    const client = new ActivationRegistryClient(
      stubPublic({ state }),
      { registry: REGISTRY, entitlement: ENTITLEMENT },
      stubWallet(() => (sent = true)),
    );

    await client.recordCarrier(1n, witness(sound(), receipt));
    assert.equal(sent, true);
  }
});

test("the entitlement pairing is read once, not on every write", async () => {
  let pairingReads = 0;
  const publicClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "entitlement") {
        pairingReads += 1;
        return ENTITLEMENT;
      }
      return EntitlementState.PendingReview;
    },
    simulateContract: async () => ({ request: {} }),
    waitForTransactionReceipt: async () => ({ status: "success" }),
  } as unknown as PublicClient;

  const client = new ActivationRegistryClient(
    publicClient,
    { registry: REGISTRY, entitlement: ENTITLEMENT },
    stubWallet(),
  );

  await client.recordDecision(1n, DECISION_HASH, "compliance-1.0.0", Verdict.Approved);
  await client.recordDecision(2n, DECISION_HASH, "compliance-1.0.0", Verdict.Refused);

  assert.equal(pairingReads, 1, "immutable pairing should be read once per client");
});

test("reading an activation maps the tuple onto named fields", async () => {
  const publicClient = {
    readContract: async () => [
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
      `0x${"33".repeat(32)}`,
      `0x${"44".repeat(32)}`,
      `0x${"55".repeat(32)}`,
      "compliance-1.0.0/hs-2026",
      1786654530n,
      1786654600n,
      2,
      Verdict.Refused,
    ],
  } as unknown as PublicClient;

  const client = new ActivationRegistryClient(publicClient, {
    registry: REGISTRY,
    entitlement: ENTITLEMENT,
  });
  const a = await client.read(1n);

  assert.equal(a.parcelHash, `0x${"11".repeat(32)}`);
  assert.equal(a.carrierRawHash, `0x${"55".repeat(32)}`);
  assert.equal(a.engineVersion, "compliance-1.0.0/hs-2026");
  assert.equal(a.attempt, 2);
  assert.equal(a.verdict, Verdict.Refused);
});
