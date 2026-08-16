/// Two carbon adapters, one vertical, and the difference is how access to a
/// real registry was obtained.
///
/// `CarbonmarkAdapter` speaks Carbonmark's standard REST API, which is
/// **KYB-gated**: corporate compliance review, a signed API Services Agreement,
/// then dashboard access before a live key exists. That is a multi-week
/// commercial process, so it cannot produce a real retirement on a build
/// timeline. It is retained rather than deleted because it is exercised as far
/// as a test-mode key allows, and because it holds the finding that a test-mode
/// retirement returns a shared placeholder and retires nothing.
///
/// `CarbonmarkX402Adapter` is the one that ships. The **Klima x402 endpoint
/// needs no API key, no account and no onboarding** — payment is authorised per
/// request by an EIP-3009 signature — and its retirements are genuine. Keyless
/// access is precisely what lets an unonboarded project retire a real credit
/// instead of describing one.
///
/// The obligation it discharges is issued, collateralised, escrowed, adjudicated
/// and audited on **X Layer**. `docs/adapters.md` is authoritative.
export {
  CarbonmarkX402Adapter,
  withSignature,
} from "./x402/adapter.ts";
export type {
  X402Order,
  X402Facts,
  SignTypedData,
  X402AdapterOptions,
} from "./x402/adapter.ts";
export { KlimaX402Client, formatTonnes } from "./x402/client.ts";
export type { ClientOptions, QuoteRequest, PrepareRequest } from "./x402/client.ts";
export {
  RetirementLedger,
  SpendCapExceeded,
  DuplicateRetirement,
  idempotencyKey,
  capsFromEnv,
  DEFAULT_CAPS,
} from "./x402/ledger.ts";
export type { LedgerRecord, AttemptState, SpendCaps } from "./x402/ledger.ts";
export { authorizationOutcome } from "./x402/authorization.ts";
export type { AuthorizationOutcome } from "./x402/authorization.ts";
export {
  X402Error,
  creditedAsRequested,
  RETRYABLE_CODES,
  X402_API,
  X402_HOST,
  X402_CHAIN_ID,
  X402_MANIFEST,
} from "./x402/types.ts";
export type {
  CarbonClass,
  CarbonCredit,
  X402Quote,
  PreparedAuthorization,
  X402Retirement,
  RetirementRecord,
  TypedData,
} from "./x402/types.ts";

/// The REST path, kept for the reason stated above.
export { CarbonmarkAdapter } from "./adapter.ts";
export type { CarbonOrder, CarbonFacts } from "./adapter.ts";
export { CarbonmarkClient } from "./carbonmark.ts";
export type { CarbonQuote, RawOrder } from "./carbonmark.ts";
export { CarbonmarkError, registryOf } from "./types.ts";
export type {
  Registry,
  CreditClass,
  Listing,
  RetirementRequest,
  Retirement,
} from "./types.ts";
