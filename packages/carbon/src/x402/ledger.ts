/// The spending ledger — caps, idempotency, and crash recovery.
///
/// Retirement is irreversible. A confirmed retirement permanently burns the
/// credit: there is no undo, no refund, no chargeback and no dispute. Every
/// protection in this file exists because of that one fact, and none of them is
/// a nicety.
///
/// The file is append-only JSONL. A key's current state is its **last** line,
/// so a state change is a new record rather than a rewrite. That is not a
/// stylistic choice: rewriting a file is not atomic, and a crash mid-rewrite
/// could lose the record of an attempt that had already spent money. An append
/// that lands is durable and an append that does not is simply absent.

import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

/// Where an attempt stands.
///
/// `attempting` is written **before** the network call and is the only state
/// that matters for safety. A record stuck in it means "we may have spent
/// money and do not yet know" — which is exactly the situation that must block
/// a second attempt rather than be cleared away.
export type AttemptState = "attempting" | "settled" | "failed" | "abandoned";

export interface LedgerRecord {
  /// Derived from the obligation, not from the provider's response. Two
  /// attempts to fulfil the same entitlement produce the same key even across
  /// a process restart, which is what makes them detectable as duplicates.
  readonly key: string;
  readonly state: AttemptState;
  readonly at: string;
  readonly from: string;
  readonly carbonClass: string;
  readonly tonnes: number;
  readonly beneficiaryAddress: string;
  /// USDC. The **most** the signature can cost — retirement, protocol fee and
  /// the executor's gas reimbursement. Caps are enforced against this rather
  /// than the quoted total, because it is the number actually authorised.
  readonly authValueUsdc: number;
  /// The EIP-3009 nonce. USDC permanently burns each `(from, nonce)` pair when
  /// an authorization is used, so this is what lets the chain answer "did my
  /// money move?" without asking the provider.
  readonly nonce: string;
  readonly txHash?: string;
  readonly certificateUrl?: string;
  readonly note?: string;
}

/// The caps, enforced in code before any network call.
///
/// Defaults are deliberately close to a real retirement rather than generously
/// above it. A demo retirement of 0.001 t costs about 0.028 USDC, of which the
/// protocol fee floor is 0.01 and the executor's gas reimbursement is most of
/// the rest. A cap that would let a runaway loop spend a hundred dollars is not
/// a cap.
export interface SpendCaps {
  readonly perRetirementUsdc: number;
  readonly dailyUsdc: number;
}

export const DEFAULT_CAPS: SpendCaps = {
  perRetirementUsdc: 1,
  dailyUsdc: 5,
};

/// Read caps from the environment, refusing anything unparseable.
///
/// An unreadable cap becomes the default rather than infinity, and a negative
/// or non-numeric one throws. A typo in a shell variable must not be able to
/// widen a spending limit.
export function capsFromEnv(
  env: Record<string, string | undefined> = process.env,
): SpendCaps {
  return {
    perRetirementUsdc: readCap(
      env["ROUTELOCK_X402_MAX_USDC_PER_RETIREMENT"],
      DEFAULT_CAPS.perRetirementUsdc,
      "ROUTELOCK_X402_MAX_USDC_PER_RETIREMENT",
    ),
    dailyUsdc: readCap(
      env["ROUTELOCK_X402_MAX_USDC_PER_DAY"],
      DEFAULT_CAPS.dailyUsdc,
      "ROUTELOCK_X402_MAX_USDC_PER_DAY",
    ),
  };
}

function readCap(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `${name}="${raw}" is not a positive number. Refusing to boot rather than ` +
        `fall back to a default that is larger than what was intended.`,
    );
  }
  return value;
}

/// Raised when a cap would be breached. Carries the numbers so the refusal can
/// be shown rather than described.
export class SpendCapExceeded extends Error {
  constructor(
    readonly cap: "per-retirement" | "daily",
    readonly limitUsdc: number,
    readonly attemptedUsdc: number,
  ) {
    super(
      `${cap} spending cap of ${limitUsdc} USDC would be exceeded by an ` +
        `authorization of ${attemptedUsdc} USDC. Nothing was sent.`,
    );
    this.name = "SpendCapExceeded";
  }
}

/// Raised when an obligation has already been fulfilled, or has an attempt
/// outstanding whose outcome is unknown.
export class DuplicateRetirement extends Error {
  constructor(
    readonly key: string,
    readonly prior: LedgerRecord,
  ) {
    super(
      prior.state === "attempting"
        ? `an earlier attempt at ${key} is unresolved (nonce ${prior.nonce}). ` +
            `It may already have retired a credit. Resolve it against the chain ` +
            `before authorising another — see authorization.ts.`
        : `${key} was already retired (${prior.txHash ?? "no tx recorded"}). ` +
            `A retirement cannot be undone and must not be repeated.`,
    );
    this.name = "DuplicateRetirement";
  }
}

/// The idempotency key for one obligation.
///
/// Derived from what is being promised, never from what the provider returns.
/// The entitlement's token id is the anchor because one entitlement is one
/// obligation: the same entitlement fulfilled twice is a double retirement
/// whatever else changed around it.
///
/// The endpoint's own nonce cannot serve this purpose. It is
/// `keccak256(retirement, salt)` with a fresh salt minted per authorization, so
/// two `prepare-auth` calls for the identical retirement yield different
/// nonces — by design, since USDC burns `(from, nonce)` and an unsalted
/// commitment would make a legitimate repeat retirement unspendable.
export function idempotencyKey(input: {
  readonly entitlementTokenId: string | number;
  readonly classId: string;
  readonly carbonClass: string;
  readonly tonnes: number;
  readonly beneficiaryAddress: string;
}): string {
  const canonical = JSON.stringify([
    String(input.entitlementTokenId),
    input.classId.toLowerCase(),
    input.carbonClass.toLowerCase(),
    input.tonnes,
    input.beneficiaryAddress.toLowerCase(),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export class RetirementLedger {
  #path: string;
  #caps: SpendCaps;
  #now: () => Date;

  constructor(
    path: string,
    caps: SpendCaps = DEFAULT_CAPS,
    now: () => Date = () => new Date(),
  ) {
    this.#path = path;
    this.#caps = caps;
    this.#now = now;
  }

  get caps(): SpendCaps {
    return this.#caps;
  }

  get path(): string {
    return this.#path;
  }

  /// Every record, oldest first. A missing file is an empty ledger, not an
  /// error — the first retirement has to be able to happen.
  all(): readonly LedgerRecord[] {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as LedgerRecord);
  }

  /// The current state of one key — its last record.
  latest(key: string): LedgerRecord | undefined {
    let found: LedgerRecord | undefined;
    for (const record of this.all()) {
      if (record.key === key) found = record;
    }
    return found;
  }

  /// USDC authorised in the trailing 24 hours.
  ///
  /// Counts `attempting` alongside `settled`, because an attempt whose outcome
  /// is unknown may well have spent. Counting only confirmed spending would let
  /// a sequence of timeouts walk straight through the cap.
  ///
  /// The window rolls rather than resetting at midnight UTC. A calendar cap
  /// resets at a moment nobody is watching, so a loop that empties the budget
  /// at 23:59 gets a fresh one a minute later.
  spentLast24h(): number {
    const cutoff = this.#now().getTime() - 24 * 60 * 60 * 1000;
    return this.all()
      .filter((r) => r.state === "attempting" || r.state === "settled")
      .filter((r) => Date.parse(r.at) >= cutoff)
      .reduce((total, r) => total + r.authValueUsdc, 0);
  }

  /// Check both caps and the duplicate guard. Throws; returns nothing.
  ///
  /// **Call before any network request.** A cap enforced after the request has
  /// gone out is not a cap on spending, it is a cap on reporting.
  assertMaySpend(key: string, authValueUsdc: number): void {
    const prior = this.latest(key);
    if (prior !== undefined && prior.state !== "failed" && prior.state !== "abandoned") {
      throw new DuplicateRetirement(key, prior);
    }

    if (authValueUsdc > this.#caps.perRetirementUsdc) {
      throw new SpendCapExceeded(
        "per-retirement",
        this.#caps.perRetirementUsdc,
        authValueUsdc,
      );
    }

    const projected = this.spentLast24h() + authValueUsdc;
    if (projected > this.#caps.dailyUsdc) {
      throw new SpendCapExceeded("daily", this.#caps.dailyUsdc, projected);
    }
  }

  /// Write a record and force it to disk before returning.
  ///
  /// The `fsync` is the point. An `attempting` record that is still sitting in
  /// the page cache when the machine dies is a record that never existed, and
  /// the next run would happily retire a second credit for the same
  /// obligation. Durability here is worth the milliseconds.
  record(record: Omit<LedgerRecord, "at"> & { at?: string }): LedgerRecord {
    const complete: LedgerRecord = {
      ...record,
      at: record.at ?? this.#now().toISOString(),
    };

    mkdirSync(dirname(this.#path), { recursive: true });
    appendFileSync(this.#path, `${JSON.stringify(complete)}\n`, "utf8");

    const fd = openSync(this.#path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    return complete;
  }

  /// Attempts whose outcome was never established.
  ///
  /// Surfaced rather than swept up: each one is an authorization that may have
  /// been relayed, and the only honest way to close it is to ask the chain
  /// whether its nonce was consumed.
  unresolved(): readonly LedgerRecord[] {
    const byKey = new Map<string, LedgerRecord>();
    for (const record of this.all()) byKey.set(record.key, record);
    return [...byKey.values()].filter((r) => r.state === "attempting");
  }
}
