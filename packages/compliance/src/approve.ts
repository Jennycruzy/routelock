/// The gate between a decision and spending money.
///
/// `FulfilmentAdapter.fulfil()` takes `Approved<TOrder>`, and this is the only
/// sanctioned way to obtain one. Fulfilling work the engine did not approve is
/// therefore a **compile error**, not a runtime check that could be forgotten
/// at one call site — the TypeScript counterpart of `SettlementEscrow`
/// structurally refusing to grant `COMPLIANCE_ROLE`.
///
/// This lives in the compliance package rather than in `@routelock/fulfilment`
/// because it needs `Verdict` and `decisionHash`, and that package is a
/// zero-dependency leaf on purpose: compliance already depends on the delivery
/// package, so a port importing compliance would close a cycle.

import type { Approved } from "@routelock/fulfilment";
import { Verdict } from "./types.ts";
import { canonicalHash } from "./hash.ts";

/// Bind an order to the decision that authorised it.
///
/// Generic over the decision shape, not fixed to the delivery `Decision`. It
/// was fixed, and the carbon path had to cast (`decision as never`) to call
/// it — punching a hole in the one gate the whole design leans on, at the only
/// call site that matters. All this function needs is a verdict to check and a
/// value to hash; anything with a `verdict` qualifies.
///
/// Returns `null` for every verdict other than `Approved`, including
/// `NeedsInformation` — which is a request for more facts, never a soft yes.
/// Callers must handle the null; there is no throwing variant, because a
/// refusal is a correct outcome rather than an exceptional one.
export function approve<TOrder, TDecision extends { readonly verdict: Verdict }>(
  order: TOrder,
  decision: TDecision,
): Approved<TOrder> | null {
  if (decision.verdict !== Verdict.Approved) return null;

  // The single sanctioned construction of the brand. Any other cast to
  // `Approved` is a bypass of the gate and should fail review.
  return {
    order,
    decisionHash: canonicalHash(decision),
  } as Approved<TOrder>;
}

/// Re-open an already-approved order after a process restart.
///
/// This is only for recovery after the exact decision hash has been read from
/// an Activated on-chain entitlement. It does not assess or approve a new
/// order; callers must prove that the chain already holds the approval before
/// using the returned value to resume provider work.
export function approveCommitted<TOrder>(
  order: TOrder,
  decisionHash: `0x${string}`,
): Approved<TOrder> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(decisionHash)) {
    throw new Error(`invalid committed decision hash ${decisionHash}`);
  }
  return { order, decisionHash } as Approved<TOrder>;
}
