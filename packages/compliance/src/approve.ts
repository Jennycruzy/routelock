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
import type { Decision } from "./types.ts";
import { decisionHash } from "./hash.ts";

/// Bind an order to the decision that authorised it.
///
/// Returns `null` for every verdict other than `Approved`, including
/// `NeedsInformation` — which is a request for more facts, never a soft yes.
/// Callers must handle the null; there is no throwing variant, because a
/// refusal is a correct outcome rather than an exceptional one.
export function approve<TOrder>(order: TOrder, decision: Decision): Approved<TOrder> | null {
  if (decision.verdict !== Verdict.Approved) return null;

  // The single sanctioned construction of the brand. Any other cast to
  // `Approved` is a bypass of the gate and should fail review.
  return {
    order,
    decisionHash: decisionHash(decision),
  } as Approved<TOrder>;
}
