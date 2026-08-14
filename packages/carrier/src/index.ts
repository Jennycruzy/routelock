/// The adapter is the package's public surface. `ShipbubbleClient` is exported
/// too, because address validation and cancellation are delivery-specific and
/// deliberately absent from the shared port — but the adapter is what the rest
/// of the system programs against.
export { ShipbubbleAdapter } from "./adapter.ts";
export type { DeliveryOrder, DeliveryFacts } from "./adapter.ts";
export { ShipbubbleClient } from "./shipbubble.ts";
export { isCrossBorder, CarrierError } from "./types.ts";
export type {
  CarrierClient,
  AddressInput,
  ValidatedAddress,
  Lane,
  Consignment,
  Quote,
  Shipment,
} from "./types.ts";
export { categoryForHs6, CATEGORY_NAMES } from "./categories.ts";
export type { CategoryName, CategoryResolution } from "./categories.ts";
export { isAcceptable, POLICY_SOURCE } from "./policy.ts";
export type { AcceptanceResult } from "./policy.ts";
