/// What stops an open endpoint from spending the project's inference credit.
///
/// The benchmark runs unbudgeted on purpose — it is a supervised job whose whole
/// point is hundreds of calls. An HTTP endpoint is the opposite: nobody is
/// watching it, anyone can reach it, and this account has already run out of
/// credit twice mid-run. So two independent limits apply here and neither is
/// optional.
///
/// **A separate ledger from the operator's.** A demo cannot drain the budget the
/// end-to-end rehearsal spends from, and the rehearsal cannot be starved by a
/// judge clicking twice. Two files, two caps, reported separately.
///
/// **A per-address rate limit**, in memory. It resets when the process restarts,
/// which is stated rather than hidden — it is a brake on casual repetition, not
/// a security control. The call cap is what actually bounds the money.

import { InferenceBudget, ledgerPath } from "@routelock/compliance";
import type { BudgetCaps } from "@routelock/compliance";

/// Deliberately smaller than the operator's 25. A visitor needs a handful of
/// rulings to understand the system; a hundred adds nothing but cost.
export const SERVED_LEDGER = "data/served-inference.jsonl";

function servedLedger(): string {
  return process.env["ROUTELOCK_SERVED_LEDGER"] ?? SERVED_LEDGER;
}

export function servedCaps(env: NodeJS.ProcessEnv = process.env): BudgetCaps {
  const maxCalls = Number(env["ROUTELOCK_SERVED_MAX_CALLS"] ?? 40);
  const softLimitUsd = Number(env["ROUTELOCK_SERVED_SOFT_LIMIT_USD"] ?? 2);

  if (!Number.isFinite(maxCalls) || maxCalls <= 0) {
    throw new Error(
      `ROUTELOCK_SERVED_MAX_CALLS must be a positive number, got ` +
        `${String(env["ROUTELOCK_SERVED_MAX_CALLS"])}. An endpoint that spends ` +
        `money does not start without a cap.`,
    );
  }
  return { maxCalls: Math.floor(maxCalls), softLimitUsd };
}

export function servedBudget(env: NodeJS.ProcessEnv = process.env): InferenceBudget {
  return new InferenceBudget(ledgerPath(env["ROUTELOCK_SERVED_LEDGER"] ?? SERVED_LEDGER), servedCaps(env));
}

export interface BudgetReport {
  readonly callsUsed: number;
  readonly callsRemaining: number;
  readonly spentUsdEstimate: number;
  readonly softLimitUsd: number;
  readonly overSoftLimit: boolean;
  readonly ledger: string;
}

export function reportBudget(budget: InferenceBudget, caps: BudgetCaps): BudgetReport {
  return {
    callsUsed: budget.callsUsed,
    callsRemaining: budget.callsRemaining,
    // Rounded for display only. The ledger keeps full precision.
    spentUsdEstimate: Number(budget.spentUsd.toFixed(4)),
    softLimitUsd: caps.softLimitUsd,
    overSoftLimit: budget.overSoftLimit,
    ledger: servedLedger(),
  };
}

/// One bucket per caller, refilled by elapsed time.
///
/// Keyed on the address the socket reports. Behind a proxy that is the proxy, so
/// `X-Forwarded-For` is honoured only when `ROUTELOCK_TRUST_PROXY` says to —
/// trusting it by default would let any client claim any identity and defeat the
/// limit entirely.
export class RateLimiter {
  #hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /// True when the call is allowed, and records it. False when the caller is
  /// over the limit.
  take(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.#hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.max) {
      this.#hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }

  /// Seconds until the caller's oldest hit falls out of the window.
  retryAfterSeconds(key: string, now = Date.now()): number {
    const oldest = (this.#hits.get(key) ?? [])[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  /// Drop buckets nobody has touched for a full window, so a long-running
  /// process does not accumulate one entry per address forever.
  sweep(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, hits] of this.#hits) {
      if (hits.every((at) => at <= cutoff)) this.#hits.delete(key);
    }
  }
}
