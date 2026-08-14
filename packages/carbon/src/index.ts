/// Two carbon adapters, one vertical, and the difference matters.
///
/// `CarbonmarkX402Adapter` is the one that ships: the Klima x402 endpoint needs
/// no key and no onboarding, and its retirements are real. `CarbonmarkAdapter`
/// implements Carbonmark's standard REST API, which is KYB-gated — corporate
/// compliance review, a signed API Services Agreement, then dashboard access
/// for live keys. It is retained rather than deleted because it is exercised as
/// far as a test-mode key allows and because it holds the finding that a
/// test-mode retirement returns a shared placeholder and retires nothing.
/// `docs/adapters.md` is authoritative on which is which.
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
