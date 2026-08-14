/// The shared fulfilment port. One adapter per vertical, one interface.
///
/// The contracts beneath this know nothing about any vertical: `classId` is an
/// opaque hash and `ActivationRegistry` stores opaque `bytes32` it never parses.
/// This interface is the single place where a generic service obligation
/// becomes a specific piece of work — a parcel moved, a credit retired, a
/// container leased.
///
/// **This package has no dependencies, deliberately.** It is the leaf that
/// every adapter and the compliance engine import. `@routelock/compliance`
/// already depends on `@routelock/carrier`, so a port that imported compliance
/// would close a dependency cycle. That is also why `approve()` — the only
/// sanctioned constructor for `Approved` — lives in the compliance package
/// rather than here: it needs `Verdict` and `decisionHash`, and this file must
/// not.

/// Which kind of work an adapter performs. Not stored on-chain, and not derived
/// from anything on-chain — the vertical exists only above the contracts.
export type Vertical = "delivery" | "carbon" | "compute";

/// Mirrors the status table in `docs/adapters.md`, which is authoritative.
///
/// `active` has a defined bar: deployed on its chain **and** at least one real
/// fulfilment completed with a public proof URL. Nothing may be presented as
/// working in the UI or the README until it reaches that bar.
export type AdapterStatus = "active" | "in_development" | "not_started" | "reference";

/// What a provider would charge to perform the work.
export interface FulfilmentQuote {
  /// The provider's handle for this offer. Fulfilment quotes it back, so work
  /// can never be bought at a price the provider did not offer.
  readonly ref: string;
  readonly providerName: string;
  readonly currency: string;
  readonly total: number;
  /// False when the offer came from a provider sandbox. Carried on the quote
  /// itself so a sandbox number cannot be separated from what it qualifies.
  readonly live: boolean;
}

declare const approvedBrand: unique symbol;

/// An order that a completed compliance decision approved.
///
/// The only way to obtain one is `approve()` in `@routelock/compliance`, which
/// returns `null` unless the verdict is `Approved`. Because `fulfil()` takes
/// this type rather than a bare order, fulfilling unapproved work is a
/// **compile error rather than a runtime check** — the TypeScript counterpart
/// of `SettlementEscrow` structurally refusing to grant `COMPLIANCE_ROLE`.
///
/// The brand is not exported. Constructing one of these outside `approve()`
/// requires a deliberate cast, which is greppable and reviewable.
export interface Approved<TOrder> {
  readonly order: TOrder;
  /// Commits to the exact decision JSON that authorised this work. Written
  /// on-chain as `decisionHash` and served by the public replay endpoint, so
  /// anyone can recompute it from the published document.
  readonly decisionHash: `0x${string}`;
  readonly [approvedBrand]: true;
}

/// Proof that the work was performed, in the provider's own words.
///
/// The three string fields are the preimages of the hashes `ActivationRegistry`
/// stores — see `docs/adapter-mapping.md`. They are published rather than
/// summarised, so the on-chain commitment means "here is the provider's
/// response, check it yourself" rather than "trust our transcription".
export interface Receipt {
  /// The provider's own identifier for the completed work. Preimage of
  /// `carrierRefHash`.
  readonly ref: string;
  /// The provider's raw response, verbatim and unrewritten. Preimage of
  /// `carrierRawHash`.
  readonly rawResponse: string;
  /// Where anyone can check this — no key, no login, no wallet. This is the
  /// field that makes a submission verifiable by a judge in another timezone.
  readonly proofUrl: string;
  /// What the provider actually charged, from its own response. Never a figure
  /// computed on this side.
  readonly amountCharged: number;
  readonly currency: string;
  readonly live: boolean;
}

/// The result of re-checking a fulfilment against the provider, after the fact.
export interface VerificationResult {
  readonly found: boolean;
  /// The provider's own word for the state, not a normalised one. A state this
  /// side does not recognise must still be reportable.
  readonly state: string;
  readonly proofUrl: string;
  /// ISO 8601, so a stale check is visible as stale.
  readonly checkedAt: string;
  readonly live: boolean;
}

/// The port every vertical implements.
///
/// Generic over the order type because the work being ordered is precisely what
/// differs between verticals, and it cannot be recovered from a `classId` — a
/// `classId` is a keccak hash, and no lane, quantity or workload spec can be
/// read back out of it. Everything downstream of the order is shared.
export interface FulfilmentAdapter<TOrder, TFacts> {
  readonly name: string;
  readonly vertical: Vertical;
  readonly status: AdapterStatus;
  /// Sandbox or live, derived from the chain rather than configured
  /// separately, so a testnet deployment cannot reach a live provider key.
  readonly live: boolean;
  /// False when fulfilment cannot be undone. A retired carbon credit stays
  /// retired; there is no cancellation to offer, and a uniform `cancel()` that
  /// threw for carbon would be a lie told by the type. Adapters that can
  /// reverse expose their own cancellation, shaped to what the provider
  /// actually supports.
  readonly reversible: boolean;

  /// What the work would cost. Must not spend money or consume provider quota.
  quote(order: TOrder): Promise<readonly FulfilmentQuote[]>;

  /// Gather the deterministic facts the compliance engine will rule on — step 1
  /// of the pipeline. **No model in this path.** Carbon fetches registry
  /// metadata; delivery has nothing to fetch and returns what the shipper
  /// supplied.
  assess(order: TOrder): Promise<TFacts>;

  /// Perform the work. **Spends real money against a live key.** Unreachable
  /// without an approved decision, by construction.
  fulfil(approved: Approved<TOrder>): Promise<Receipt>;

  /// Re-check a completed fulfilment against the provider.
  verify(ref: string): Promise<VerificationResult>;
}

/// Raised when a provider rejects a request. Carries the provider's own message
/// rather than a rewritten one, so a failure can be traced to its source.
export class FulfilmentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`${endpoint} → ${status}: ${message}`);
    this.name = "FulfilmentError";
  }
}
