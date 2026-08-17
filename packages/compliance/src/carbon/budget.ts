/// A hard ceiling on inference spend, enforced before the request rather than
/// discovered on the invoice.
///
/// This exists because it already happened once. The HS benchmark spent real
/// money scoring 253 rows for a vertical that was later demoted to a
/// reference implementation, and nothing in the code would have stopped it
/// from spending more. Per-call cost is cents; what turns cents into tens of
/// dollars is a loop that runs five hundred times, and a loop has no natural
/// stopping point unless one is written down.
///
/// It is deliberately the same shape as `RetirementLedger` in
/// `@routelock/carbon`: a durable record written **before** the spend, not
/// after, so a crash mid-flight cannot lose the fact that money was committed.
/// A ledger written afterwards under-counts exactly when it matters.
///
/// ## What this can and cannot promise
///
/// It counts **calls**, and estimates cost from the token usage the API
/// reports. It cannot pre-compute what a call will cost, because output length
/// is not knowable in advance. So the guarantee is a bound on the *number* of
/// requests and an accurate record of what they actually cost — not a
/// pre-authorised dollar amount. A single call cannot overrun; a budget can be
/// exceeded by at most the cost of the one call in flight when the cap is hit.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/// Anchor a ledger path to the repository root, not the working directory.
///
/// A relative path resolves against `process.cwd()`, which differs per package
/// when scripts run under a workspace filter. That silently created **one
/// ledger per script** — so the "hard cap" was really a cap per working
/// directory, and total spend was the cap times the number of entry points.
/// Found by noticing a run report 4/25 when 15 calls had already been made.
///
/// Walking up for `pnpm-workspace.yaml` gives every caller the same file
/// regardless of where it was launched from. Absolute paths are honoured as
/// given, so an operator can still point the ledger anywhere deliberately.
export function ledgerPath(relative: string): string {
  if (isAbsolute(relative)) return relative;

  let dir = process.cwd();
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return resolve(dir, relative);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No workspace root found — fall back to cwd rather than throwing, but the
  // caller gets the same behaviour they had before, not a silent second cap.
  return resolve(process.cwd(), relative);
}

export class InferenceBudgetExceeded extends Error {
  constructor(
    readonly spentCalls: number,
    readonly maxCalls: number,
    /// How many calls the refused operation needed. Present when the ledger has
    /// room for *some* calls but not for all of them — a two-pass ruling asked
    /// for with one call left. Reported because "exhausted" and "cannot afford
    /// the whole ruling" are different situations with the same remedy.
    readonly callsNeeded?: number,
  ) {
    super(
      `inference budget exhausted: ${spentCalls} of ${maxCalls} calls used` +
        (callsNeeded === undefined
          ? ". "
          : `, and this ruling needs ${callsNeeded}. `) +
        `Raise ROUTELOCK_MAX_MODEL_CALLS deliberately, or clear the ledger — ` +
        `refusing to spend further without a decision.`,
    );
    this.name = "InferenceBudgetExceeded";
  }
}

/// What the API charged, as the API reported it.
///
/// Never a figure computed on this side. `costUsd` is derived from these
/// counts and the rate table below, and is an estimate of list price — not an
/// invoice.
export interface CallRecord {
  readonly at: string;
  readonly model: string;
  readonly purpose: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/// Published rates, in USD per million tokens.
///
/// Rates are a fact about the vendor's price list, not about this code, so
/// they are stated with the date they were read. `claude-sonnet-5` carries an
/// introductory rate through 2026-08-31; after that it reverts to 3/15. The
/// estimate is therefore a *floor* once that date passes, which is the safe
/// direction for a budget to be wrong in.
///
/// Read 2026-08-16 from the published pricing table.
const RATES_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

/// Estimate list-price cost for one call. Unknown models are priced at the
/// most expensive rate in the table rather than zero: a budget that silently
/// treats an unrecognised model as free is not a budget.
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const known = RATES_USD_PER_MTOK[model];
  const rate =
    known ??
    Object.values(RATES_USD_PER_MTOK).reduce((worst, r) =>
      r.input + r.output > worst.input + worst.output ? r : worst,
    );

  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

export interface BudgetCaps {
  /// Hard ceiling on model calls for the lifetime of the ledger.
  readonly maxCalls: number;
  /// Advisory. Reported, and warned about, but the call cap is what stops
  /// spending — a dollar figure cannot be enforced before a call completes.
  readonly softLimitUsd: number;
}

/// Deliberately small. A demo run is a handful of calls; a benchmark is
/// hundreds. This default makes the second one impossible by accident.
export const DEFAULT_CAPS: BudgetCaps = { maxCalls: 25, softLimitUsd: 1.0 };

export function capsFromEnv(env: Record<string, string | undefined> = process.env): BudgetCaps {
  const maxCalls = Number(env.ROUTELOCK_MAX_MODEL_CALLS ?? DEFAULT_CAPS.maxCalls);
  const softLimitUsd = Number(env.ROUTELOCK_SOFT_LIMIT_USD ?? DEFAULT_CAPS.softLimitUsd);

  if (!Number.isFinite(maxCalls) || maxCalls <= 0) {
    throw new Error(
      `ROUTELOCK_MAX_MODEL_CALLS must be a positive number, got ${env.ROUTELOCK_MAX_MODEL_CALLS}`,
    );
  }
  return {
    maxCalls: Math.floor(maxCalls),
    softLimitUsd: Number.isFinite(softLimitUsd) ? softLimitUsd : DEFAULT_CAPS.softLimitUsd,
  };
}

/// An append-only spend record on disk.
///
/// JSONL rather than JSON so an interrupted write costs one line, not the
/// file. Gitignored: it is local operational state, not evidence.
export class InferenceBudget {
  #records: CallRecord[] | null = null;

  private readonly path: string;

  constructor(path: string, private readonly caps: BudgetCaps = DEFAULT_CAPS) {
    this.path = ledgerPath(path);
  }

  /// Every call recorded so far. Read once, then kept in memory — the ledger
  /// is single-process by design.
  records(): readonly CallRecord[] {
    if (this.#records !== null) return this.#records;

    try {
      this.#records = readFileSync(this.path, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as CallRecord);
    } catch {
      // A ledger that does not exist yet is an empty ledger, not an error.
      this.#records = [];
    }
    return this.#records;
  }

  get callsUsed(): number {
    return this.records().length;
  }

  get spentUsd(): number {
    return this.records().reduce((sum, r) => sum + r.costUsd, 0);
  }

  get callsRemaining(): number {
    return Math.max(0, this.caps.maxCalls - this.callsUsed);
  }

  /// Throw unless there is room for one more call.
  ///
  /// Called immediately before the request, not at construction: a long-lived
  /// process must be stopped at the moment it runs out, not merely warned when
  /// it started.
  assertCallAllowed(): void {
    if (this.callsUsed >= this.caps.maxCalls) {
      throw new InferenceBudgetExceeded(this.callsUsed, this.caps.maxCalls);
    }
  }

  /// True when spend has passed the advisory limit. Reported by callers; does
  /// not block, because the honest enforcement point is the call cap.
  get overSoftLimit(): boolean {
    return this.spentUsd > this.caps.softLimitUsd;
  }

  /// Record a completed call. Appended immediately, before the caller does
  /// anything with the result, so a downstream throw cannot lose the spend.
  record(entry: Omit<CallRecord, "at" | "costUsd">): CallRecord {
    const record: CallRecord = {
      at: new Date().toISOString(),
      costUsd: estimateCostUsd(entry.model, entry.inputTokens, entry.outputTokens),
      ...entry,
    };

    // Load any existing ledger *before* appending. Reading afterwards would
    // pick up the line just written and then add it again in memory, so every
    // call would count twice and the cap would trip at half its stated value.
    const existing = this.records();

    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");

    this.#records = [...existing, record];
    return record;
  }

  /// One line, for a script to print after a run.
  summary(): string {
    return (
      `${this.callsUsed}/${this.caps.maxCalls} calls, ` +
      `$${this.spentUsd.toFixed(4)} estimated` +
      (this.overSoftLimit ? ` — OVER the $${this.caps.softLimitUsd} soft limit` : "")
    );
  }
}
