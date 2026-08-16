/// Binding one fulfilment to the five fields `ActivationRegistry` stores.
///
/// This is the seam between the adapter layer and the chain. Above it, a
/// vertical: a retirement request, a parcel, a lease. Below it, five opaque
/// `bytes32` the contract never parses. `docs/adapter-mapping.md` is the
/// authoritative statement of which vertical concept lands in which field, and
/// this file is its executable form.
///
/// The field names are delivery vocabulary — `parcelHash`, `carrierRefHash` —
/// and are **not renamed**, because the contracts were deployed on 13 August
/// 2026, before any carbon code existed, and a contract that backs a carbon
/// retirement without modification is the evidence for the generality claim.
/// Renaming would mean redeploying, which would destroy the very history that
/// makes the claim checkable.

import type { Approved, Receipt, Vertical } from "@routelock/fulfilment";
import { commit, commitVerbatim, UNRECORDED, verifyCommitment } from "./commit.ts";
import type { Commitment } from "./commit.ts";

/// What the adapter must state about the work, for `parcelHash`.
///
/// Deliberately not a union of per-vertical shapes. The contract commits to an
/// opaque hash and the replay document publishes whatever is here, so the only
/// hard requirement is that it is JSON-serialisable, contains no PII, and fully
/// specifies the work as the provider was asked to perform it.
export type WorkSpec = Record<string, unknown>;

/// What the engine was shown, for `documentsHash`.
///
/// For carbon this is the registry metadata and any published adverse findings
/// that were retrieved; for delivery, the document bundle. Committing to the
/// evidence *set* — not merely the conclusion — is what stops a decision being
/// defended after the fact with facts that were never actually consulted.
export type EvidenceSet = Record<string, unknown>;

/// Everything published about one activation, in one object.
export interface Attestation {
  readonly vertical: Vertical;
  /// Commits to the work as specified. Registry field `parcelHash`.
  readonly work: Commitment;
  /// Commits to the evidence the engine ruled on. Registry field `documentsHash`.
  readonly evidence: Commitment;
  /// Commits to the decision JSON. Registry field `decisionHash`.
  ///
  /// Taken from `Approved.decisionHash` rather than recomputed here. The value
  /// that authorised the spend and the value written on chain must be the same
  /// bytes, and recomputing invites them to differ.
  readonly decisionHash: `0x${string}`;
  /// Commits to the provider's identifier for the completed work. Registry
  /// field `carrierRefHash`. Absent until fulfilment has happened.
  readonly providerRef: Commitment | null;
  /// Commits to the provider's raw response. Registry field `carrierRawHash`.
  readonly providerRaw: Commitment | null;
  /// Where anyone can check the fulfilment without a key or an account.
  readonly proofUrl: string | null;
}

export class AttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationError";
  }
}

/// Build the pre-fulfilment half: what is committed before any work is done.
///
/// `submitParcel` and `recordDecision` both happen before a provider is called,
/// so the work spec, the evidence and the decision are committed while the
/// outcome is still unknown. That ordering is what makes the record an audit
/// trail rather than a retrospective justification.
export function attest<TOrder>(input: {
  readonly vertical: Vertical;
  readonly approved: Approved<TOrder>;
  readonly work: WorkSpec;
  readonly evidence: EvidenceSet;
}): Attestation {
  const work = commit(input.work);
  const evidence = commit(input.evidence);

  return {
    vertical: input.vertical,
    work,
    evidence,
    decisionHash: input.approved.decisionHash,
    providerRef: null,
    providerRaw: null,
    proofUrl: null,
  };
}

/// Add the provider's evidence once the work has been performed.
///
/// Returns a new attestation rather than mutating: the pre-fulfilment
/// commitments were already written on chain and must not be reachable for
/// edit afterwards.
export function witness(attestation: Attestation, receipt: Receipt): Attestation {
  if (receipt.ref.length === 0) {
    throw new AttestationError(
      "the provider returned no reference for completed work — refusing to " +
        "commit an empty carrierRefHash, which would read as a fulfilment " +
        "nobody can look up",
    );
  }
  if (receipt.rawResponse.length === 0) {
    throw new AttestationError(
      "the provider's raw response is empty — refusing to commit to evidence " +
        "that does not exist",
    );
  }

  return {
    ...attestation,
    providerRef: commitVerbatim(receipt.ref),
    providerRaw: commitVerbatim(receipt.rawResponse),
    proofUrl: receipt.proofUrl,
  };
}

/// The five `bytes32` in the order the registry stores them.
///
/// Unrecorded fields are the zero hash, which is exactly what the contract
/// holds for an activation that has not reached that stage — so this function
/// never invents a value to fill a gap.
export function registryFields(attestation: Attestation): {
  readonly parcelHash: `0x${string}`;
  readonly documentsHash: `0x${string}`;
  readonly decisionHash: `0x${string}`;
  readonly carrierRefHash: `0x${string}`;
  readonly carrierRawHash: `0x${string}`;
} {
  return {
    parcelHash: attestation.work.hash,
    documentsHash: attestation.evidence.hash,
    decisionHash: attestation.decisionHash,
    carrierRefHash: attestation.providerRef?.hash ?? UNRECORDED,
    carrierRawHash: attestation.providerRaw?.hash ?? UNRECORDED,
  };
}

/// Check every commitment against its own published preimage.
///
/// Run before publishing, so an unverifiable document is never served. Returns
/// the names of the fields that failed rather than a bare boolean, because
/// "the document is wrong" is not actionable and "documentsHash is wrong" is.
export function unverifiableFields(attestation: Attestation): readonly string[] {
  const checks: readonly (readonly [string, Commitment | null])[] = [
    ["parcelHash", attestation.work],
    ["documentsHash", attestation.evidence],
    ["carrierRefHash", attestation.providerRef],
    ["carrierRawHash", attestation.providerRaw],
  ];

  return checks
    .filter(([, c]) => c !== null && !verifyCommitment(c))
    .map(([name]) => name);
}
