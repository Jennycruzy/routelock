/// The adapter is the package's public surface. The client is exported for the
/// carbon-specific calls the shared port deliberately does not carry — listing
/// discovery and credential verification.
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
