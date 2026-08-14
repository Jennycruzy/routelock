/// The vocabulary of Carbonmark's API.
///
/// Same layering as delivery: this file and `carbonmark.ts` are the **transport
/// client**, speaking Carbonmark's own terms; `CarbonmarkAdapter` in
/// `adapter.ts` is the single adapter, presenting carbon retirement through the
/// shared `FulfilmentAdapter` port.
///
/// Field shapes here were read off real responses on 14 August 2026, not off
/// documentation. See `docs/carbonmark-verification.md`.

/// Which registry issued a credit, taken from the project id's prefix.
///
/// Measured across 723 live listings: VCS 578, CMARK 42, ICR 40, TVER 35,
/// ECO 2, PUR 1. Verra (VCS) dominance matters for the compliance corpus,
/// because Verra publishes the most suspensions and investigations to draw
/// ground-truth labels from.
export type Registry = "VCS" | "ICR" | "TVER" | "CMARK" | "ECO" | "PUR" | "UNKNOWN";

/// A credit class as Carbonmark identifies it.
export interface CreditClass {
  /// e.g. `VCS-1529`. The registry's own project identifier.
  readonly projectId: string;
  readonly registry: Registry;
  /// The year the reduction was claimed. Older vintages are weaker evidence,
  /// which is one of the quality signals the compliance engine rules on.
  readonly vintage: number;
  readonly tokenAddress: string;
  /// `erc20` for most of the market and `erc1155` for ICR. Recorded because it
  /// is true, not because anything here depends on it: **the adapter never
  /// holds a credit.** It calls an API, and the registry custodies the asset.
  readonly tokenStandard: string;
  readonly name: string;
}

/// One offer to sell a credit, as returned by `/prices`.
export interface Listing {
  readonly sourceId: string;
  readonly credit: CreditClass;
  /// What a buyer pays per tonne, inclusive of margin.
  readonly purchasePrice: number;
  readonly baseUnitPrice: number;
  /// **What can actually be bought right now.** Measured 14 August 2026: only
  /// 61 of 723 listings had any. A listing is displayed long after its
  /// inventory reaches zero, so this is the field that decides whether an offer
  /// is real, and it must be read live rather than cached.
  readonly liquidSupply: number;
  readonly supply: number;
  /// Smallest purchasable quantity, in tonnes. 0.001 across the market, which
  /// is what makes a demo retirement cost well under a cent.
  readonly minFillAmount: number;
}

/// What a retirement is asked to do. No PII: the beneficiary is a public
/// attribution string, never an identity document or an address.
export interface RetirementRequest {
  readonly sourceId: string;
  /// Tonnes. Must be at least the listing's `minFillAmount`.
  readonly quantity: number;
  /// Who the retirement is credited to, shown on the public certificate.
  readonly beneficiaryName: string;
  /// Free text explaining what the retirement is for, e.g. an order reference.
  readonly retirementMessage: string;
}

/// A completed retirement.
export interface Retirement {
  readonly orderId: string;
  /// The Polygon transaction that retired the credit. Hashed on-chain as
  /// `carrierRefHash`.
  readonly retirementTxHash: string;
  /// The public certificate page. No login, no key, no wallet — this is what
  /// makes carbon remotely verifiable where delivery is not.
  readonly certificateUrl: string;
  readonly amountCharged: number;
  readonly currency: string;
  readonly live: boolean;
}

/// Raised when Carbonmark rejects a request, carrying its own message.
export class CarbonmarkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`${endpoint} → ${status}: ${message}`);
    this.name = "CarbonmarkError";
  }
}

/// Read a registry off a project id.
///
/// Returns `UNKNOWN` rather than guessing when the prefix is unrecognised —
/// 25 of 723 live listings carried no usable project id, and a credit whose
/// registry cannot be established is one the compliance engine should be told
/// about rather than one silently assigned a registry.
export function registryOf(projectId: string): Registry {
  const prefix = projectId.split("-")[0]?.toUpperCase();
  switch (prefix) {
    case "VCS":
    case "ICR":
    case "TVER":
    case "CMARK":
    case "ECO":
    case "PUR":
      return prefix;
    default:
      return "UNKNOWN";
  }
}
