/// The five commitments `ActivationRegistry` stores, and their preimages.
///
/// The contract holds nothing but `bytes32`. That is only an audit trail if the
/// preimages are published and anyone can recompute the hashes from them, so
/// every commitment here carries its preimage rather than discarding it. A hash
/// whose preimage was never kept commits to nothing checkable.
///
/// ## Two hashing regimes, deliberately not unified
///
/// Three of the five commit to values this system constructs — a work
/// specification, an evidence set, a decision. Those are hashed as **canonical
/// JSON**, defined once in `@routelock/compliance` so an independent verifier
/// lands on the same bytes.
///
/// The other two commit to what a provider said. Those are hashed **verbatim**,
/// over the exact UTF-8 bytes received, with no parsing, sorting or
/// re-serialisation. Canonicalising a provider's response would mean the
/// on-chain commitment is to *our reading* of the evidence rather than the
/// evidence, and the whole point of `carrierRawHash` is to answer "why should
/// anyone believe your transcription".
///
/// The two are separate functions rather than one function with a flag, because
/// a flag is something a caller gets wrong once and nobody notices until a
/// verifier cannot reproduce a hash.

import { canonicalHash, canonicalJson } from "@routelock/compliance";
import { keccak256, toHex } from "viem";

/// A `bytes32` alongside the exact bytes it was computed from.
export interface Commitment {
  readonly hash: `0x${string}`;
  /// What to publish so a third party can recompute `hash`. For canonical
  /// commitments this is the canonical JSON — not the original object, whose
  /// key order is not what was hashed.
  readonly preimage: string;
  /// How to recompute. Published so a verifier never has to infer it.
  readonly encoding: "canonical-json" | "verbatim-utf8";
}

/// What `ActivationRegistry` reads as "nothing recorded yet".
export const UNRECORDED = `0x${"0".repeat(64)}` as const;

/// Commit to a value this system constructed.
///
/// Used for `parcelHash` and `documentsHash`. The value must contain no PII —
/// see `docs/adapter-mapping.md` for what each vertical puts here.
export function commit(value: unknown): Commitment {
  return {
    hash: canonicalHash(value),
    preimage: canonicalJson(value),
    encoding: "canonical-json",
  };
}

/// Commit to bytes a provider produced, exactly as received.
///
/// Used for `carrierRefHash` and `carrierRawHash`. Do not trim, pretty-print,
/// re-encode or strip fields from `text` before calling this: whatever is
/// passed here is what gets published, and any difference between the two
/// breaks verification for everyone downstream.
export function commitVerbatim(text: string): Commitment {
  return {
    hash: keccak256(toHex(text)),
    preimage: text,
    encoding: "verbatim-utf8",
  };
}

/// Recompute a commitment from its published preimage and check it matches.
///
/// This is the verifier's side of the promise, kept in the same file as the
/// producer's side so the two cannot drift apart. The replay endpoint runs it
/// against its own output before serving, so a document that cannot be
/// verified is never published in the first place.
///
/// Note there is deliberately **no branch on `encoding` here**, and that is the
/// property that makes the published document easy to check rather than merely
/// possible to check: because a canonical preimage is stored *already
/// canonicalised*, verification is `keccak256(utf8(preimage))` in both regimes.
/// A verifier needs no JSON library, no key-sorting implementation and no
/// knowledge of our rules — only keccak256 over the bytes we published.
/// `encoding` is published so a verifier can see how the preimage was *derived*
/// upstream, not because checking it requires re-deriving it.
export function verifyCommitment(commitment: Commitment): boolean {
  return keccak256(toHex(commitment.preimage)) === commitment.hash;
}
