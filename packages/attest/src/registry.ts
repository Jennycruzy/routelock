/// Writing the five commitments to `ActivationRegistry` on X Layer.
///
/// This is the only place in the codebase that turns an attestation into a
/// transaction. Everything above it is pure and testable; everything below it
/// is a chain that does not forget. That boundary is why the checks here are
/// preflight checks rather than error handling: a revert costs gas and tells
/// you almost nothing, while a refusal before sending costs nothing and names
/// the reason.
///
/// ## What this will not do
///
/// It will not write an attestation whose published preimages do not reproduce
/// its own hashes. Publishing a commitment nobody can verify is worse than
/// publishing nothing: it looks like evidence and is not. `unverifiableFields`
/// is checked before every write, not at the end of the run.
///
/// It will not write the zero hash as provider evidence. On chain, zero means
/// "not recorded"; writing it deliberately would make an empty record
/// indistinguishable from a fulfilment that never happened.
///
/// It will not assume the address it was handed is a registry. `entitlement()`
/// is read once and checked against the entitlement contract the caller
/// expects, because a correctly-formed transaction to the wrong address is the
/// failure mode that produces a confident, wrong audit trail.

import type { Address, Hash, PublicClient, WalletClient } from "viem";
import { Verdict } from "@routelock/compliance";

import {
  ACTIVATION_REGISTRY_ABI,
  ENTITLEMENT_STATE_NAMES,
  EntitlementState,
  SERVICE_ENTITLEMENT_ABI,
} from "./abi.ts";
import { registryFields, unverifiableFields } from "./attestation.ts";
import type { Attestation } from "./attestation.ts";
import { UNRECORDED } from "./commit.ts";

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface RegistryAddresses {
  readonly registry: Address;
  /// The entitlement contract this registry must be bound to. Checked, not
  /// assumed — see the file header.
  readonly entitlement: Address;
}

/// What the chain currently holds for one activation.
export interface OnChainActivation {
  readonly parcelHash: `0x${string}`;
  readonly documentsHash: `0x${string}`;
  readonly decisionHash: `0x${string}`;
  readonly carrierRefHash: `0x${string}`;
  readonly carrierRawHash: `0x${string}`;
  readonly engineVersion: string;
  readonly submittedAt: bigint;
  readonly activatedAt: bigint;
  readonly attempt: number;
  readonly verdict: Verdict;
}

export class ActivationRegistryClient {
  #pairingChecked = false;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly addresses: RegistryAddresses,
    /// Absent for a read-only client. A client that cannot write is the right
    /// default for anything that only serves the audit trail.
    private readonly wallet?: WalletClient,
  ) {}

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  /// Read one activation as the chain holds it.
  async read(tokenId: bigint): Promise<OnChainActivation> {
    const raw = await this.publicClient.readContract({
      address: this.addresses.registry,
      abi: ACTIVATION_REGISTRY_ABI,
      functionName: "activations",
      args: [tokenId],
    });

    return {
      parcelHash: raw[0],
      documentsHash: raw[1],
      decisionHash: raw[2],
      carrierRefHash: raw[3],
      carrierRawHash: raw[4],
      engineVersion: raw[5],
      submittedAt: raw[6],
      activatedAt: raw[7],
      attempt: raw[8],
      verdict: raw[9] as Verdict,
    };
  }

  async stateOf(tokenId: bigint): Promise<EntitlementState> {
    const state = await this.publicClient.readContract({
      address: this.addresses.entitlement,
      abi: SERVICE_ENTITLEMENT_ABI,
      functionName: "stateOf",
      args: [tokenId],
    });
    return state as EntitlementState;
  }

  /// Read the state, retrying while it disagrees with what the caller expects.
  ///
  /// A preflight check is only as good as the freshness of the node that
  /// answers it. Rather than refuse on the first stale answer, give the chain a
  /// few seconds to agree with itself — then refuse for real. A genuinely wrong
  /// state still fails, just a little later.
  async #stateSettled(tokenId: bigint, expected: readonly EntitlementState[]): Promise<EntitlementState> {
    let state = await this.stateOf(tokenId);
    for (let attempt = 0; attempt < 4 && !expected.includes(state); attempt += 1) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      state = await this.stateOf(tokenId);
    }
    return state;
  }

  // -------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------

  /// Bind the work specification and the evidence set, putting the entitlement
  /// under review. Caller must be the token holder.
  async submitParcel(tokenId: bigint, attestation: Attestation): Promise<Hash> {
    this.#assertVerifiable(attestation);
    await this.#assertBoundToEntitlement();

    const state = await this.#stateSettled(tokenId, [EntitlementState.Available]);
    if (state !== EntitlementState.Available) {
      throw new RegistryError(
        `token ${tokenId} is ${nameState(state)}, and only an Available ` +
          `entitlement can be submitted for review — submitting now would ` +
          `revert, or overwrite a review already in progress`,
      );
    }

    const fields = registryFields(attestation);
    return this.#send("submitParcel", [tokenId, fields.parcelHash, fields.documentsHash]);
  }

  /// Commit the compliance decision. Caller must hold `COMPLIANCE_ROLE`.
  ///
  /// Takes the verdict explicitly rather than deriving it from the attestation,
  /// because a refusal has no `Approved` to carry a decision hash and must
  /// still be recorded. Refusals are committed exactly as approvals are.
  async recordDecision(
    tokenId: bigint,
    decisionHash: `0x${string}`,
    engineVersion: string,
    verdict: Verdict,
  ): Promise<Hash> {
    await this.#assertBoundToEntitlement();

    if (verdict === Verdict.None) {
      throw new RegistryError(
        "refusing to record Verdict.None — the contract rejects it, and an " +
          "absent verdict is not a decision",
      );
    }
    if (engineVersion.length === 0) {
      throw new RegistryError(
        "refusing to record a decision with no engine version — the record " +
          "would not say what produced it",
      );
    }
    if (decisionHash === UNRECORDED) {
      throw new RegistryError(
        "refusing to record the zero hash as a decision — it is what the " +
          "contract holds for an activation that has none",
      );
    }

    const state = await this.#stateSettled(tokenId, [EntitlementState.PendingReview]);
    if (state !== EntitlementState.PendingReview) {
      throw new RegistryError(
        `token ${tokenId} is ${nameState(state)}, not PendingReview — ` +
          `recordDecision would revert with NotUnderReview(). Submit the work ` +
          `specification first.`,
      );
    }

    return this.#send("recordDecision", [tokenId, decisionHash, engineVersion, verdict]);
  }

  /// Commit the provider's own evidence. Caller must hold `ORACLE_ROLE`.
  async recordCarrier(tokenId: bigint, attestation: Attestation): Promise<Hash> {
    this.#assertVerifiable(attestation);
    await this.#assertBoundToEntitlement();

    const fields = registryFields(attestation);
    if (fields.carrierRefHash === UNRECORDED || fields.carrierRawHash === UNRECORDED) {
      throw new RegistryError(
        "this attestation has no provider evidence — call witness() with the " +
          "provider's receipt first. Writing zero here would record a " +
          "fulfilment that cannot be looked up.",
      );
    }

    const permitted = [
      EntitlementState.Activated,
      EntitlementState.LabelCreated,
      EntitlementState.InTransit,
    ];
    const state = await this.#stateSettled(tokenId, permitted);
    if (!permitted.includes(state)) {
      throw new RegistryError(
        `token ${tokenId} is ${nameState(state)} — recordCarrier would revert ` +
          `with NotActivated(). Provider evidence can only be attached to work ` +
          `the engine approved.`,
      );
    }

    return this.#send("recordCarrier", [tokenId, fields.carrierRefHash, fields.carrierRawHash]);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  #assertVerifiable(attestation: Attestation): void {
    const broken = unverifiableFields(attestation);
    if (broken.length > 0) {
      throw new RegistryError(
        `refusing to commit an attestation whose published preimages do not ` +
          `reproduce its hashes: ${broken.join(", ")}. Anyone checking this ` +
          `record would find it does not verify.`,
      );
    }
  }

  /// Confirm the registry is bound to the entitlement contract the caller
  /// expects. Read once per client, because it cannot change: `entitlement` is
  /// `immutable` in the contract.
  async #assertBoundToEntitlement(): Promise<void> {
    if (this.#pairingChecked) return;

    const bound = await this.publicClient.readContract({
      address: this.addresses.registry,
      abi: ACTIVATION_REGISTRY_ABI,
      functionName: "entitlement",
    });

    if (bound.toLowerCase() !== this.addresses.entitlement.toLowerCase()) {
      throw new RegistryError(
        `registry ${this.addresses.registry} is bound to entitlement ${bound}, ` +
          `not the expected ${this.addresses.entitlement}. Refusing to write — ` +
          `a correctly-formed transaction to the wrong deployment produces a ` +
          `confident and wrong audit trail.`,
      );
    }
    this.#pairingChecked = true;
  }

  async #send(
    functionName: "submitParcel" | "recordDecision" | "recordCarrier",
    args: readonly unknown[],
  ): Promise<Hash> {
    const wallet = this.wallet;
    if (wallet === undefined) {
      throw new RegistryError(
        `this client is read-only — ${functionName} needs a wallet. A ` +
          `read-only client is the correct default for serving the audit trail.`,
      );
    }
    const account = wallet.account;
    if (account === undefined) {
      throw new RegistryError(`the wallet has no account, so ${functionName} cannot be signed`);
    }

    // Simulate first: this surfaces a revert reason without spending gas, and
    // catches a role the caller does not hold before a transaction exists.
    const { request } = await this.publicClient.simulateContract({
      address: this.addresses.registry,
      abi: ACTIVATION_REGISTRY_ABI,
      functionName,
      args: args as never,
      account,
    });

    const hash = await wallet.writeContract(request);

    // Wait for the write to be visible before returning. Returning the hash
    // immediately caused a real failure: `submitParcel` was broadcast, this
    // returned, and `recordDecision` read `stateOf` on the very next line and
    // saw the pre-transaction value — so it refused a token that had in fact
    // moved to PendingReview. Two confirmations, because the public RPC is
    // load-balanced and one node seeing the block does not mean the next one
    // has.
    await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
    return hash;
  }
}

function nameState(state: EntitlementState): string {
  return ENTITLEMENT_STATE_NAMES[state] ?? `an unrecognised state (${state})`;
}
