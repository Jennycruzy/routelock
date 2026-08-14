/// The vocabulary of the Klima x402 retirement endpoint.
///
/// Every shape here was read off a real response on 2026-08-14, not off the
/// documentation — the two disagree in at least one load-bearing place (the
/// manifest's `chainId` schema advertises Base Sepolia; the runtime rejects
/// it). See `docs/carbonmark-verification.md` for the raw captures.
///
/// Layering matches the rest of the repo: this file and `client.ts` are the
/// **transport client**, speaking the endpoint's own terms;
/// `CarbonmarkX402Adapter` in `adapter.ts` is the single adapter above them,
/// presenting retirement through the shared `FulfilmentAdapter` port.

/// The pinned host.
///
/// The bare `x402.klimalabs.com` always serves the latest release and **moves
/// on a major bump**; `v1.` receives additive minor and patch releases and
/// never moves to v2. A breaking change landing mid-judging is an unacceptable
/// risk for no benefit, so the major is pinned and the changelog is read
/// deliberately rather than absorbed silently.
export const X402_HOST = "https://v1.x402.klimalabs.com";
export const X402_API = `${X402_HOST}/api`;
export const X402_MANIFEST = `${X402_HOST}/.well-known/x402.json`;

/// The only chain the endpoint settles on. Not configurable, because it is not
/// a choice: 84532 is in the published schema and rejected by the service.
export const X402_CHAIN_ID = 8453;

/// One retirable class, as `discover` returns it.
///
/// The metadata fields are the compliance engine's raw material — vintage,
/// registry, methodology and country are exactly the quality signals the risk
/// gate rules on, and they arrive from the provider rather than being asserted
/// here.
export interface CarbonClass {
  readonly carbonClassId: string;
  /// Null-ish in practice: one live class returns its own address as its name,
  /// `category: "Unknown"`, no methodologies and zero credits. A class whose
  /// identity cannot be established is a fact the engine must be told, never
  /// one to be quietly defaulted.
  readonly name: string | null;
  readonly category: string | null;
  readonly country: string | null;
  readonly region: string | null;
  readonly methodologies: readonly string[];
  readonly isRegistered: boolean;
  /// **Marginal spot price, accurate near one tonne.** Large orders walk up the
  /// AAM curve — Biochar quoted ~$107.82/t at 1 t and ~$386.61/t at 100 t. This
  /// is a catalogue figure for filtering and display; the price of a specific
  /// size comes from `quote` and nowhere else.
  readonly priceUsdcPerTonne: number | null;
  readonly credits: readonly CarbonCredit[];
  /// Protocol minimum, currently 0.001 t (1 kg). It is what makes a real
  /// retirement cost about a cent rather than a hundred dollars.
  readonly minRetirementTonnes: number;
}

export interface CarbonCredit {
  readonly tokenAddress: string;
  readonly tokenStandard: string;
  readonly tokenId: number;
  /// `UCR`, `REGEN`, `CMARK`, `PUR`, … The issuing registry.
  readonly registry: string;
  readonly projectId: string;
  /// Occasionally not a year: one live credit reports `20240430`. Kept as the
  /// provider reported it and normalised where it is used, rather than being
  /// coerced here into something that looks tidier than the source.
  readonly vintage: number;
  readonly liquidityTonnes: number;
}

/// A live price for a specific size. Free, and commits to nothing.
export interface X402Quote {
  readonly tonnes: number;
  /// USDC. The cost of the credits themselves.
  readonly retirementPrice: number;
  /// USDC. `max(floor, feeBps%)`, collected on-chain by the settlement
  /// contract. The floor dominates at demo sizes: 0.001 t of the cheapest class
  /// prices at 0.000072 USDC of carbon against a 0.01 USDC fee.
  readonly fee: number;
  readonly total: number;
  /// `total` plus a 4% slippage buffer. What the contract is permitted to
  /// spend; anything unused is refunded in the same transaction.
  readonly suggestedMaxInput: number;
  readonly pricePerTonne: number;
  /// The endpoint's own one-line rendering. Published verbatim in the UI and
  /// the decision record rather than restated, so the figure a human approves
  /// is the figure the provider quoted.
  readonly humanSummary: string;
  readonly resolvedCredit: {
    readonly creditToken: string;
    readonly tokenId: number;
    readonly vintage: number;
  };
}

/// An EIP-712 payload, exactly as returned. Signed as-is.
///
/// Never rebuilt on this side. On the USDC path the authorization's `nonce` is
/// `keccak256(retirement, salt)` — the credit, token id, amount and full
/// attribution struct — so the signature binds *what is retired and who is
/// credited*, not merely a dollar amount. Reassembling any part of it locally
/// would break that binding and earn a `params_mismatch`.
export interface TypedData {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, readonly { name: string; type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

/// What `prepare-auth` hands back. Free; nothing has moved yet.
export interface PreparedAuthorization {
  readonly scheme: string;
  readonly chainId: number;
  readonly inputToken: string;
  /// The settlement contract. Read from the response rather than hardcoded —
  /// the endpoint's own documentation says it moves.
  readonly spender: string;
  /// USDC. Retirement + protocol fee + the executor's gas reimbursement, which
  /// is what makes the relay path work without the signer holding any ETH.
  /// **This is the number the caps are enforced against**, because it is the
  /// most the signature can cost.
  readonly authValue: number;
  readonly executorGas: number;
  readonly quote: X402Quote;
  readonly typedData: TypedData;
  /// Posted back verbatim with only the signature added. It carries the `salt`
  /// that, with the retirement itself, reproduces the signed nonce; the
  /// endpoint re-derives and rejects a mismatch.
  readonly actionsRetireRequest: Record<string, unknown>;
  /// Exactly what the signed nonce commits to, in the endpoint's own words.
  /// Its documentation says to read this before signing; it is checked against
  /// the order here and published in the decision record, so what was approved
  /// and what was authorised can be compared by anyone.
  readonly onChainDetails: Record<string, unknown>;
  /// The `nonce` field of the signed message, lifted out for the ledger.
  ///
  /// This is the load-bearing value for crash recovery. USDC permanently burns
  /// each `(from, nonce)` pair when an authorization is used, so this single
  /// bytes32 answers "did my money move?" from the chain itself, with no
  /// reliance on the provider's own reporting.
  readonly nonce: `0x${string}`;
  /// Unix seconds. The endpoint's own limit is 300s and it is hard.
  readonly validBefore: number;
}

/// A settled retirement.
export interface X402Retirement {
  /// `settled` — mined and indexed, certificate present.
  /// `pending_index` — mined, subgraph behind; poll `certificate`.
  readonly status: string;
  readonly transactionHash: string;
  readonly retirements: readonly RetirementRecord[];
  /// The endpoint's response, verbatim. Preimage of `carrierRawHash`.
  readonly raw: string;
}

export interface RetirementRecord {
  /// Public, no login, no wallet. The artifact a judge checks.
  readonly certificateUrl: string;
  readonly amountInTonnes: string;
  /// **The address credited on-chain.** Checked against what was asked for;
  /// `retiringAddress` on the same record is the aggregator's own settlement
  /// address and says nothing about attribution.
  readonly beneficiaryAddress: string;
  readonly beneficiaryName: string;
  readonly projectId: string;
  readonly creditId: string;
}

/// The endpoint's error envelope.
///
/// **Match on `code`, never on `message`** — the endpoint's own documentation
/// says codes are stable and wording is not. `retryable` comes from the
/// published registry rather than from a guess made here.
export class X402Error extends Error {
  constructor(
    /// The stable `error` field, e.g. `insufficient_liquidity`.
    readonly code: string,
    message: string,
    readonly status: number,
    readonly action: string,
    /// The rest of the body — `issues`, `expectedNonce`, `availableVintages`,
    /// `decoded`, whichever the code carries.
    readonly context: Record<string, unknown> = {},
  ) {
    super(`${action} → ${status} ${code}: ${message}`);
    this.name = "X402Error";
  }
}

/// Codes for which repeating the identical request can succeed.
///
/// Taken from the published registry at `/.well-known/x402-errors.json`, read
/// 2026-08-14. `verify:x402` re-reads that document and fails when this set
/// drifts from it, so the list cannot quietly rot.
export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "internal_error",
  "no_candidates",
  "insufficient_liquidity",
  "contract_revert",
  "transaction_reverted",
  "retirement_not_found",
  "gas_estimate_unavailable",
]);

/// Did the retirement credit the party it was asked to credit?
///
/// The same check the REST adapter needed, for the same reason and against a
/// different failure. There it caught a shared test-mode placeholder from April
/// 2024; here there is no test mode to produce one, but the principle does not
/// depend on the provider: **a receipt that does not describe the request is
/// not evidence for the request**, and a `Receipt` is what gets hashed into
/// `carrierRefHash` and published as proof.
export function creditedAsRequested(
  requested: string,
  returned: string | null | undefined,
): boolean {
  const got = (returned ?? "").trim().toLowerCase();
  if (got === "") return false;
  return got === requested.trim().toLowerCase();
}
