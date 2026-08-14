/// The carrier-facing side of a `ServiceEntitlement`.
///
/// The contracts describe a service commitment identified by a class and a terms
/// hash; they know nothing about parcels, carriers or customs. This interface is
/// where a specific kind of service becomes concrete, and it is deliberately the
/// only place delivery vocabulary appears. A warehousing or equipment-time
/// adapter would implement the same three-stage shape: quote, commit, observe.
///
/// Nothing here takes a route as a constant. Origin and destination are always
/// arguments, because whoever is shipping chooses them.

/// A postal address as the carrier understands it, after the carrier has
/// resolved and accepted it. `code` is the carrier's handle for a validated
/// address and is the only form later calls accept.
export interface ValidatedAddress {
  readonly code: string;
  readonly formatted: string;
  readonly country: string;
  /// ISO 3166-1 alpha-2, e.g. `NG`, `GB`, `HK`.
  readonly countryCode: string;
  readonly state: string;
  readonly city: string;
}

/// The parties to a shipment. Held together because a quote needs both, and a
/// lane is only meaningful as a pair.
export interface Lane {
  readonly origin: ValidatedAddress;
  readonly destination: ValidatedAddress;
}

/// True when a lane crosses a customs border.
///
/// This is what decides whether a compliance classification is advisory or
/// load-bearing, so it is computed from the two resolved country codes rather
/// than configured or assumed.
export function isCrossBorder(lane: Lane): boolean {
  return lane.origin.countryCode !== lane.destination.countryCode;
}

/// What is being moved. Weight in kilograms, value in the carrier's currency.
export interface Consignment {
  readonly description: string;
  readonly weightKg: number;
  readonly declaredValue: number;
  readonly quantity: number;
  readonly lengthCm: number;
  readonly widthCm: number;
  readonly heightCm: number;
}

/// One carrier's offer to perform a shipment.
export interface Quote {
  /// Both identifiers are kept because purchasing requires both, and they are
  /// not always the same value even though the sandbox returns them equal.
  readonly courierId: string;
  readonly serviceCode: string;
  readonly courierName: string;
  readonly serviceType: string;
  readonly currency: string;
  readonly total: number;
  readonly estimatedDelivery: string;
  /// The carrier's handle for this quotation. Buying a shipment quotes this
  /// back, so a purchase can never be for a price the carrier did not offer.
  readonly requestToken: string;
  /// False when the quote came from the carrier's sandbox. Carried on the quote
  /// itself so it cannot be separated from the number it qualifies.
  readonly live: boolean;
}

/// A shipment the carrier has accepted and issued a label for.
export interface Shipment {
  readonly shipmentId: string;
  readonly trackingUrl: string;
  readonly courierName: string;
  readonly status: string;
  /// What the carrier actually charged, from its own response — never a figure
  /// computed on this side. This is the value the oracle records on-chain.
  readonly amountCharged: number;
  readonly currency: string;
  readonly live: boolean;
}

/// The generic carrier port. One implementation per carrier.
export interface CarrierAdapter {
  readonly name: string;
  /// Sandbox or live, derived from the chain rather than configured separately.
  readonly live: boolean;

  /// Resolve a free-text address to something the carrier will accept.
  validateAddress(input: AddressInput): Promise<ValidatedAddress>;

  /// Ask what this shipment would cost. Free of charge and consumes no shipment
  /// quota, which is why the adapter is built and exercised against it first.
  quote(lane: Lane, consignment: Consignment): Promise<Quote[]>;

  /// Buy the shipment. **Spends real money against a live key** and consumes one
  /// of a finite number of shipments.
  createShipment(quote: Quote): Promise<Shipment>;

  /// Cancel a shipment. Located and documented before any live purchase.
  cancelShipment(shipmentId: string, reason: string): Promise<boolean>;
}

export interface AddressInput {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  /// Free text. Include country for reliable resolution.
  readonly address: string;
}

/// Raised when the carrier rejects a request. Carries the carrier's own message
/// rather than a rewritten one, so a failure can be traced to its source.
export class CarrierError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`${endpoint} → ${status}: ${message}`);
    this.name = "CarrierError";
  }
}
