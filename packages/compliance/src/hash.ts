/// Committing a decision to chain, and letting anyone check the commitment.
///
/// `ActivationRegistry.decisionHash` is documented as "hash of the canonical
/// compliance decision JSON", and the contract's own comment promises that the
/// full decision is served publicly so that anyone can canonicalise it, hash it,
/// and confirm it matches. That promise is only worth anything if
/// canonicalisation is defined precisely enough that an independent
/// implementation lands on the same bytes.
///
/// So it is defined here, narrowly:
///
///   1. Object keys are sorted by Unicode code point, at every depth.
///   2. Arrays keep their order — order is meaning, not formatting.
///   3. No insignificant whitespace: `JSON.stringify` with no spacing.
///   4. UTF-8 bytes, hashed with keccak256 — the same function Solidity uses,
///      so a contract could verify a re-submitted decision on-chain.
///   5. Numbers are serialised by `JSON.stringify`, and confidence is rounded
///      to three decimals *before* it ever reaches this function, because
///      floating point text is the one place two languages most easily
///      disagree.
///
/// No PII enters this hash, because no PII enters a `Decision`. The only
/// free text is the goods description the shipper wrote themselves.

import { keccak256, toHex } from "viem";
import type { Decision } from "./types.ts";

/// Recursively sort object keys. Arrays are left alone.
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value === null || typeof value !== "object") return value;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = canonicalise(v);
  return out;
}

/// The exact bytes that get hashed. Published alongside the hash so a verifier
/// never has to guess at the serialisation.
export function canonicalJson(decision: Decision): string {
  return JSON.stringify(canonicalise(decision));
}

/// `bytes32` for `ActivationRegistry.recordDecision`.
export function decisionHash(decision: Decision): `0x${string}` {
  return keccak256(toHex(canonicalJson(decision)));
}

/// Round a model-supplied probability to the precision the hash commits to.
///
/// Applied where the proposal is built, not here, so that the value stored, the
/// value published and the value hashed are the same number.
export function roundConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  const clamped = Math.min(1, Math.max(0, confidence));
  return Math.round(clamped * 1000) / 1000;
}
