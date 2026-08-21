/// The audit trail: committing a fulfilment to chain, and letting anyone check
/// the commitment without trusting this system.
///
/// `ActivationRegistry` stores five `bytes32` and no plaintext. This package is
/// what makes that an audit trail rather than five opaque numbers — it computes
/// the commitments, keeps their preimages, and verifies its own output before
/// publishing it.

export {
  commit,
  commitVerbatim,
  verifyCommitment,
  UNRECORDED,
} from "./commit.ts";
export type { Commitment } from "./commit.ts";

export {
  attest,
  witness,
  registryFields,
  unverifiableFields,
  AttestationError,
} from "./attestation.ts";
export type { Attestation, WorkSpec, EvidenceSet } from "./attestation.ts";

export { ActivationRegistryClient, RegistryError } from "./registry.ts";
export type { RegistryAddresses, OnChainActivation } from "./registry.ts";
export {
  ACTIVATION_REGISTRY_ABI,
  SERVICE_ENTITLEMENT_ABI,
  EntitlementState,
  ENTITLEMENT_STATE_NAMES,
} from "./abi.ts";

export { makeRetirementSigner, SignatureRefused } from "./signer.ts";
