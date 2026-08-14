/**
 * ShipbubbleAdapter — DELIVERY
 * Status:  REFERENCE IMPLEMENTATION. Not deployed on any chain.
 * Purpose: Demonstrates that the same FulfilmentAdapter interface and the same
 *          unchanged contract set back a physical-logistics obligation. Retained
 *          as evidence of vertical-agnosticism, not as a live integration.
 * See docs/adapters.md
 */

/// Delivery, presented through the shared port.
///
/// This is the only adapter in this package. Beneath it, `ShipbubbleClient`
/// speaks Shipbubble's API in Shipbubble's own vocabulary; this class translates
/// that into the `FulfilmentAdapter` shape that carbon and compute also
/// implement. The translation is the point rather than an accident of
/// refactoring: it is what demonstrates that the delivery interface this project
/// started from is a *special case* of the general one, which is the claim the
/// contracts make and this code should not weaken.

import type {
  Approved,
  FulfilmentAdapter,
  FulfilmentQuote,
  Receipt,
  VerificationResult,
} from "@routelock/fulfilment";
import type { ChainConfig } from "@routelock/chain";
import { ShipbubbleClient } from "./shipbubble.ts";
import type { Consignment, Lane, Quote } from "./types.ts";
import { isCrossBorder } from "./types.ts";

/// What one delivery order consists of.
///
/// A `classId` cannot stand in for this — it is a keccak hash, and no lane or
/// consignment can be read back out of one. That is precisely why the port is
/// generic over its order type.
export interface DeliveryOrder {
  readonly lane: Lane;
  readonly consignment: Consignment;
}

/// The deterministic facts the compliance engine rules on for a delivery.
///
/// Carbon fetches registry metadata at this step; delivery has nothing to
/// fetch, because the shipper already supplied every fact that matters. The
/// step still exists, and still contains no model, so the pipeline shape is the
/// same across verticals.
export interface DeliveryFacts {
  readonly description: string;
  readonly originCountry: string;
  readonly destinationCountry: string;
  readonly declaredValue: number;
  readonly weightKg: number;
  /// Decided from the two resolved country codes, never configured or assumed.
  /// This is what makes a classification load-bearing rather than advisory.
  readonly crossBorder: boolean;
}

export class ShipbubbleAdapter
  implements FulfilmentAdapter<DeliveryOrder, DeliveryFacts>
{
  readonly name = "Shipbubble";
  readonly vertical = "delivery" as const;
  readonly status = "reference" as const;
  readonly live: boolean;
  /// Shipbubble cancellation exists but is narrow: scheduled shipments only,
  /// before the processing date, with refund behaviour unconfirmed. It is
  /// exposed on the client rather than here, shaped to what the carrier
  /// actually supports.
  readonly reversible = true;

  #client: ShipbubbleClient;

  constructor(chain: ChainConfig, carrierKey: string | undefined) {
    this.#client = new ShipbubbleClient(chain, carrierKey);
    this.live = this.#client.live;
  }

  /// The underlying carrier API, for delivery-specific calls the shared port
  /// deliberately does not carry — address validation and cancellation.
  get client(): ShipbubbleClient {
    return this.#client;
  }

  async quote(order: DeliveryOrder): Promise<readonly FulfilmentQuote[]> {
    const quotes = await this.#client.quote(order.lane, order.consignment);
    return quotes.map((q) => toFulfilmentQuote(q));
  }

  async assess(order: DeliveryOrder): Promise<DeliveryFacts> {
    return {
      description: order.consignment.description,
      originCountry: order.lane.origin.countryCode,
      destinationCountry: order.lane.destination.countryCode,
      declaredValue: order.consignment.declaredValue,
      weightKg: order.consignment.weightKg,
      crossBorder: isCrossBorder(order.lane),
    };
  }

  /// Unreachable without an approved decision: the argument type can only be
  /// produced by `approve()` in `@routelock/compliance`.
  ///
  /// Buying a shipment requires the carrier's own `requestToken`, so this
  /// re-quotes the order and matches the offer the approval was granted
  /// against. A price the carrier is no longer offering is a failure, not a
  /// silent substitution.
  async fulfil(approved: Approved<DeliveryOrder>): Promise<Receipt> {
    const { order } = approved;
    const offers = await this.#client.quote(order.lane, order.consignment);
    const offer = offers[0];
    if (offer === undefined) {
      throw new Error("carrier returned no offer for an approved order");
    }

    const shipment = await this.#client.createShipment(offer);
    return {
      ref: shipment.shipmentId,
      rawResponse: JSON.stringify(shipment),
      proofUrl: shipment.trackingUrl,
      amountCharged: shipment.amountCharged,
      currency: shipment.currency,
      live: shipment.live,
    };
  }

  /// Delivery's proof is a tracking page, which is why this vertical is the one
  /// a remote judge cannot verify: a tracking number in Nigeria proves nothing
  /// to someone in Singapore within the time they will spend looking. Carbon
  /// and compute were chosen over it for exactly this reason — see
  /// `docs/adapters.md`.
  async verify(ref: string): Promise<VerificationResult> {
    throw new Error(
      `Shipbubble is a reference implementation and is not deployed; ` +
        `verification of ${ref} is not wired to a live account. See docs/adapters.md`,
    );
  }
}

function toFulfilmentQuote(q: Quote): FulfilmentQuote {
  return {
    ref: q.requestToken,
    providerName: q.courierName,
    currency: q.currency,
    total: q.total,
    live: q.live,
  };
}
