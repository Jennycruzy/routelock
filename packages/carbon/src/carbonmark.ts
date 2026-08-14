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
  isPlaceholderRetirement,
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

  /// **Retire a credit. With a production key this spends money and cannot be
  /// undone.**
  ///
  /// A retirement is permanent by design — that is the whole point of retiring
  /// a credit — so there is no cancellation to offer and no way to recover the
  /// cost. `confirmSpend` marks the call site as deliberate.
  ///
  /// **A test-mode key retires nothing.** Established by calling it on
  /// 14 August 2026: the order completes, but the transaction hash returned
  /// belongs to a pre-existing retirement from April 2024 and every test order
  /// links to that same page. The returned `placeholder` flag says which
  /// happened, and callers must not publish a placeholder as proof.
  async retire(
    quote: CarbonQuote,
    request: Omit<RetirementRequest, "sourceId" | "quantity">,
    confirmSpend: true,
  ): Promise<Retirement> {
    void confirmSpend;
    const accepted = await this.#call<RawOrder>("/orders", {
      method: "POST",
      body: {
        quote_uuid: quote.uuid,
        beneficiary_name: request.beneficiaryName,
        retirement_message: request.retirementMessage,
      },
    });

    // Retirement is asynchronous. The POST returns as soon as the order is
    // accepted, with `transaction_hash` and `view_retirement_url` still empty;
    // the on-chain retirement lands a second or two later. Observed on the
    // first real retirement, 14 August 2026: accepted at 18:10:56, completed at
    // 18:10:57. Returning the accepted response directly would hand back a
    // receipt with no proof in it.
    const settled = accepted.transaction_hash
      ? accepted
      : await this.awaitOrder(quote.uuid);

    return {
      orderId: quote.uuid,
      placeholder: isPlaceholderRetirement(
        request.beneficiaryName,
        settled.beneficiary_name,
      ),
      retirementTxHash: String(settled.transaction_hash ?? ""),
      certificateUrl: String(settled.view_retirement_url ?? ""),
      amountCharged: quote.costUsd,
      currency: "USD",
      live: this.live,
    };
  }

  /// Every order on this account.
  async orders(): Promise<readonly RawOrder[]> {
    return this.#call<readonly RawOrder[]>("/orders");
  }

  /// Find an order by the quote it consumed.
  ///
  /// Orders are matched this way because **there is no usable order id**:
  /// `GET /orders/{id}` takes a numeric id that no order response ever
  /// contains, so the endpoint cannot be called for an order this code created.
  /// The quote uuid is the only identifier that crosses the boundary.
  async findOrderByQuote(quoteUuid: string): Promise<RawOrder | undefined> {
    const all = await this.orders();
    return all.find((o) => o.quote?.uuid === quoteUuid);
  }

  /// Find a completed order by its on-chain retirement transaction.
  async findOrderByTx(txHash: string): Promise<RawOrder | undefined> {
    const all = await this.orders();
    const wanted = txHash.toLowerCase();
    return all.find((o) => (o.transaction_hash ?? "").toLowerCase() === wanted);
  }

  /// Poll until the retirement settles on-chain.
  ///
  /// Throws rather than returning a half-filled receipt: an order that never
  /// completes has no proof to publish, and a receipt without a certificate URL
  /// is exactly the kind of unverifiable claim this project refuses to make.
  async awaitOrder(
    quoteUuid: string,
    { timeoutMs = 90_000, intervalMs = 2_000 } = {},
  ): Promise<RawOrder> {
    const deadline = Date.now() + timeoutMs;
    let last: RawOrder | undefined;

    while (Date.now() < deadline) {
      last = await this.findOrderByQuote(quoteUuid);
      if (last?.transaction_hash) return last;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new CarbonmarkError(
      `order for quote ${quoteUuid} did not settle within ${timeoutMs}ms ` +
        `(last status ${last?.status ?? "unknown"})`,
      504,
      "/orders",
    );
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
