/// Shipbubble as a `CarrierAdapter`.
///
/// Every method here calls the real API. There is no offline mode and no
/// recorded-response mode, deliberately — a carrier adapter that can answer
/// without a carrier is the kind of simulated feature this project treats as
/// disqualifying. What varies is *which* real environment answers: the sandbox
/// or the live account, and that is decided by the chain, never by a flag.

import {
  assertEnvironmentPairing,
  carrierModeFor,
  type ChainConfig,
} from "@routelock/chain";
import {
  CarrierError,
  type AddressInput,
  type CarrierAdapter,
  type Consignment,
  type Lane,
  type Quote,
  type Shipment,
  type ValidatedAddress,
} from "./types.ts";
import { CATEGORY_NAMES, type CategoryName } from "./categories.ts";

const BASE = "https://api.shipbubble.com/v1";

interface Envelope<T> {
  readonly status?: string;
  readonly message?: string;
  readonly data?: T;
}

export class ShipbubbleAdapter implements CarrierAdapter {
  readonly name = "Shipbubble";
  readonly live: boolean;

  #key: string;
  #categoryIds = new Map<string, number>();

  /// The key is checked against the chain before the adapter exists.
  ///
  /// Constructing an adapter is the first thing that happens on a boot that
  /// intends to talk to a carrier, so putting the pairing assertion here makes a
  /// mismatched pair a dead process rather than a wrong shipment.
  constructor(chain: ChainConfig, carrierKey: string | undefined) {
    assertEnvironmentPairing(chain, carrierKey);
    this.#key = carrierKey as string;
    this.live = carrierModeFor(chain) === "live";
  }

  async #call<T>(
    path: string,
    init?: { method: string; body: unknown },
  ): Promise<T> {
    const response = await fetch(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.#key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(init?.body === undefined
        ? {}
        : { body: JSON.stringify(init.body) }),
    });

    const text = await response.text();
    let body: Envelope<T>;
    try {
      body = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new CarrierError(text.slice(0, 200), response.status, path);
    }

    if (!response.ok || body.status !== "success" || body.data === undefined) {
      throw new CarrierError(
        body.message ?? "unrecognised response",
        response.status,
        path,
      );
    }
    return body.data;
  }

  /// Resolve the carrier's package category ids.
  ///
  /// Ids are account-specific — the sandbox returns entirely different numbers
  /// from Shipbubble's published example — so they are fetched and matched by
  /// name rather than hardcoded. Cached for the process lifetime; the taxonomy
  /// does not change between calls.
  async #categoryId(category: CategoryName): Promise<number> {
    if (this.#categoryIds.size === 0) {
      const rows = await this.#call<
        readonly { category_id: number; category: string }[]
      >("/shipping/labels/categories");
      for (const row of rows) this.#categoryIds.set(row.category, row.category_id);
    }

    const id = this.#categoryIds.get(category);
    if (id === undefined) {
      throw new CarrierError(
        `carrier has no category named "${category}"; it offers ` +
          `${[...this.#categoryIds.keys()].join(", ")}`,
        200,
        "/shipping/labels/categories",
      );
    }
    return id;
  }

  async validateAddress(input: AddressInput): Promise<ValidatedAddress> {
    const data = await this.#call<{
      address_code: number | string;
      formatted_address: string;
      country: string;
      country_code: string;
      state: string;
      city: string;
    }>("/shipping/address/validate", { method: "POST", body: input });

    return {
      code: String(data.address_code),
      formatted: data.formatted_address,
      country: data.country,
      countryCode: data.country_code,
      state: data.state,
      city: data.city,
    };
  }

  /// Ask what a shipment would cost.
  ///
  /// Free, and consumes no shipment quota — which is why the whole adapter is
  /// exercised against this before `createShipment` is ever called.
  async quote(
    lane: Lane,
    consignment: Consignment,
    category: CategoryName = CATEGORY_NAMES.lightweight,
  ): Promise<Quote[]> {
    const categoryId = await this.#categoryId(category);

    const data = await this.#call<{
      request_token: string;
      couriers: readonly {
        courier_id?: string;
        service_code?: string;
        courier_name?: string;
        service_type?: string;
        currency?: string;
        total?: number | string;
        delivery_eta_time?: string;
      }[];
    }>("/shipping/fetch_rates", {
      method: "POST",
      body: {
        sender_address_code: Number(lane.origin.code),
        reciever_address_code: Number(lane.destination.code),
        pickup_date: nextBusinessDay(),
        category_id: categoryId,
        package_items: [
          {
            name: consignment.description.slice(0, 60),
            description: consignment.description,
            unit_weight: String(consignment.weightKg),
            unit_amount: String(consignment.declaredValue),
            quantity: String(consignment.quantity),
          },
        ],
        package_dimension: {
          length: consignment.lengthCm,
          width: consignment.widthCm,
          height: consignment.heightCm,
        },
      },
    });

    return data.couriers.map((c) => ({
      courierId: c.courier_id ?? "",
      serviceCode: c.service_code ?? c.courier_id ?? "",
      courierName: c.courier_name ?? "",
      serviceType: c.service_type ?? "",
      currency: c.currency ?? "NGN",
      total: Number(c.total ?? 0),
      estimatedDelivery: c.delivery_eta_time ?? "",
      requestToken: data.request_token,
      live: this.live,
    }));
  }

  /// Buy the shipment.
  ///
  /// The price is not passed. The carrier is given back its own
  /// `request_token` and `courier_id`, so a shipment can only ever be bought at
  /// a price the carrier itself quoted — a number computed on this side can
  /// never become the amount charged.
  async createShipment(quote: Quote): Promise<Shipment> {
    const data = await this.#call<{
      order_id?: string;
      status?: string;
      tracking_url?: string;
      courier?: { name?: string };
      payment?: { shipping_fee?: number; currency?: string; status?: string };
    }>("/shipping/labels", {
      method: "POST",
      body: {
        request_token: quote.requestToken,
        service_code: quote.serviceCode,
        courier_id: quote.courierId,
      },
    });

    return {
      shipmentId: String(data.order_id ?? ""),
      trackingUrl: String(data.tracking_url ?? ""),
      courierName: data.courier?.name ?? quote.courierName,
      status: String(data.status ?? ""),
      amountCharged: Number(data.payment?.shipping_fee ?? 0),
      currency: String(data.payment?.currency ?? quote.currency),
      live: this.live,
    };
  }

  /// Cancel a shipment.
  ///
  /// **Only scheduled shipments can be cancelled**, and only while the
  /// processing date has not passed; afterwards the carrier answers "Shipment
  /// label already processed" and the shipment stands. Whether cancelling
  /// refunds the wallet is not stated in the carrier's documentation and has not
  /// been confirmed — so a live purchase must be treated as spent, not as
  /// reversible.
  async cancelShipment(shipmentId: string, reason: string): Promise<boolean> {
    await this.#call(`/shipping/labels/cancel/${shipmentId}`, {
      method: "POST",
      body: { reason },
    });
    return true;
  }
}

/// Carriers reject a pickup date in the past, and the demo must not depend on
/// what time of day it is run.
function nextBusinessDay(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}
