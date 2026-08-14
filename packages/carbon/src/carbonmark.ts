/// Carbonmark's API, as a transport client.
///
/// This is the layer beneath the adapter. Every method calls the real API;
/// there is no offline mode and no recorded-response mode, deliberately.
///
/// **There is no sandbox host.** `api.sandbox.carbonmark.com` does not resolve,
/// and a sandbox key and a production key both talk to `api.carbonmark.com`.
/// The key prefix is the only thing separating the two environments, which is
/// why the boot-time pairing check matters more here than it does for the
/// carrier. See `docs/carbonmark-verification.md`.

import {
  assertProviderPairing,
  CARBONMARK_KEYS,
  carrierModeFor,
  type ChainConfig,
} from "@routelock/chain";
import {
  CarbonmarkError,
  registryOf,
  type Listing,
  type Retirement,
  type RetirementRequest,
} from "./types.ts";

const BASE = "https://api.carbonmark.com";

/// A quote. Free, and non-committal until an order consumes it — the response
/// carries `consumed: 0` until then.
export interface CarbonQuote {
  readonly uuid: string;
  readonly sourceId: string;
  readonly quantityTonnes: number;
  /// Billed on a monthly invoice rather than prepaid, so this is an amount that
  /// *will be* charged, not one already taken.
  readonly costUsd: number;
  readonly consumed: boolean;
}

export class CarbonmarkClient {
  readonly name = "Carbonmark";
  readonly live: boolean;

  #key: string;

  constructor(chain: ChainConfig, apiKey: string | undefined) {
    assertProviderPairing(chain, apiKey, CARBONMARK_KEYS);
    this.#key = apiKey as string;
    this.live = carrierModeFor(chain) === "live";
  }

  async #call<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
    const response = await fetch(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.#key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new CarbonmarkError(text.slice(0, 400), response.status, path);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CarbonmarkError(
        `response was not JSON: ${text.slice(0, 200)}`,
        response.status,
        path,
      );
    }
  }

  /// Confirm the key actually works.
  ///
  /// Calls `/orders`, which returns 401 for a bad key. **Never check a key
  /// against `/prices`** — that endpoint is completely public and returns 200
  /// with no key at all, so it reports success for a credential that does not
  /// exist.
  async verifyCredentials(): Promise<boolean> {
    await this.#call<unknown[]>("/orders");
    return true;
  }

  /// Every listed price. Public, and free of charge.
  ///
  /// `liquidSupply` is the field that matters: measured 14 August 2026, only 61
  /// of 723 entries had any. Callers must filter on it rather than trusting
  /// that a displayed listing can be bought.
  async listings(): Promise<readonly Listing[]> {
    const raw = await this.#call<readonly RawPrice[]>("/prices");
    return raw.map(toListing);
  }

  /// Listings that can actually be bought right now, cheapest first.
  async purchasable(minTonnes: number): Promise<readonly Listing[]> {
    const all = await this.listings();
    return all
      .filter((l) => l.liquidSupply >= minTonnes && l.minFillAmount <= minTonnes)
      .sort((a, b) => a.purchasePrice - b.purchasePrice);
  }

  /// Price a retirement. Free, and consumes nothing.
  async quote(sourceId: string, quantityTonnes: number): Promise<CarbonQuote> {
    const q = await this.#call<RawQuote>("/quotes", {
      method: "POST",
      body: { asset_price_source_id: sourceId, quantity_tonnes: quantityTonnes },
    });
    return {
      uuid: q.uuid,
      sourceId: q.asset_price_source_id,
      quantityTonnes: q.quantity_tonnes,
      costUsd: q.cost_usdc,
      consumed: q.consumed === 1,
    };
  }

  /// **Retire a credit. Spends money and cannot be undone.**
  ///
  /// A retirement is permanent by design — that is the whole point of retiring
  /// a credit — so there is no cancellation to offer and no way to recover the
  /// cost. `confirmSpend` exists because this call is reachable from a sandbox
  /// key and it has not been established that a sandbox key is billed
  /// differently from a production one: Carbonmark serves both from the same
  /// host, and a quote made with the sandbox key returned a real credential id
  /// against real market inventory. Until that question is answered in writing,
  /// treat every call here as real money.
  async retire(
    quote: CarbonQuote,
    request: Omit<RetirementRequest, "sourceId" | "quantity">,
    confirmSpend: true,
  ): Promise<Retirement> {
    void confirmSpend;
    const order = await this.#call<RawOrder>("/orders", {
      method: "POST",
      body: {
        quote_uuid: quote.uuid,
        beneficiary_name: request.beneficiaryName,
        retirement_message: request.retirementMessage,
      },
    });

    return {
      orderId: String(order.quote?.uuid ?? quote.uuid),
      retirementTxHash: String(order.transaction_hash ?? ""),
      certificateUrl: String(order.view_retirement_url ?? ""),
      amountCharged: quote.costUsd,
      currency: "USD",
      live: this.live,
    };
  }

  /// Re-read a completed order from Carbonmark.
  async order(id: string): Promise<RawOrder> {
    return this.#call<RawOrder>(`/orders/${encodeURIComponent(id)}`);
  }
}

interface RawPrice {
  readonly sourceId: string;
  readonly purchasePrice?: number;
  readonly baseUnitPrice?: number;
  readonly supply?: number;
  readonly liquidSupply?: number;
  readonly minFillAmount?: number;
  readonly listing?: RawListing;
  readonly pool?: RawListing;
}

interface RawListing {
  readonly creditId?: { readonly projectId?: string; readonly vintage?: number };
  readonly token?: {
    readonly address?: string;
    readonly tokenStandard?: string;
    readonly name?: string;
  };
}

interface RawQuote {
  readonly uuid: string;
  readonly asset_price_source_id: string;
  readonly quantity_tonnes: number;
  readonly cost_usdc: number;
  readonly consumed: number;
}

export interface RawOrder {
  readonly status?: string;
  readonly transaction_hash?: string | null;
  readonly view_retirement_url?: string | null;
  readonly on_chain_explorer_url?: string | null;
  readonly retirement_index?: number | null;
  readonly beneficiary_name?: string | null;
  readonly completed_at?: string | null;
  readonly quote?: { readonly uuid?: string };
}

function toListing(raw: RawPrice): Listing {
  const source = raw.listing ?? raw.pool ?? {};
  const projectId = source.creditId?.projectId ?? "";
  return {
    sourceId: raw.sourceId,
    credit: {
      projectId,
      registry: registryOf(projectId),
      vintage: source.creditId?.vintage ?? 0,
      tokenAddress: source.token?.address ?? "",
      tokenStandard: source.token?.tokenStandard ?? "",
      name: source.token?.name ?? "",
    },
    purchasePrice: raw.purchasePrice ?? 0,
    baseUnitPrice: raw.baseUnitPrice ?? 0,
    liquidSupply: raw.liquidSupply ?? 0,
    supply: raw.supply ?? 0,
    minFillAmount: raw.minFillAmount ?? 0,
  };
}
