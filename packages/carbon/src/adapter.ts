/**
 * CarbonmarkAdapter — CARBON RETIREMENT
 * Status:  IN DEVELOPMENT. Not deployed. No retirement has been performed.
 * Purpose: The first adapter, and the one X Layer leads with. Its fulfilment
 *          proof is a public certificate URL that a judge in any timezone can
 *          check in about ninety seconds without a key, a login or a wallet.
 * See docs/adapters.md
 */

/// Carbon retirement, presented through the shared port.
///
/// The obligation being tokenised is **not the credit** — the credit is already
/// a real-world asset custodied in a registry. It is the *obligation to retire
/// one*, which is the part that is currently unenforceable: offsets sold at
/// checkout are paid for immediately and retired later, in bulk, if at all.

import type {
  Approved,
  FulfilmentAdapter,
  FulfilmentQuote,
  Receipt,
  VerificationResult,
} from "@routelock/fulfilment";
import type { ChainConfig } from "@routelock/chain";
import { CarbonmarkClient } from "./carbonmark.ts";
import { CarbonmarkError, type Listing, type Registry } from "./types.ts";

/// What one retirement order consists of.
export interface CarbonOrder {
  /// Which listing to retire from. Chosen from live purchasable supply at the
  /// time of the order, never from a cached or hardcoded list — 662 of 723
  /// listings displayed zero liquid supply when measured.
  readonly sourceId: string;
  readonly tonnes: number;
  /// Public attribution shown on the certificate. Not PII: a merchant name or
  /// an order reference, never an identity document.
  readonly beneficiaryName: string;
  readonly retirementMessage: string;
}

/// The deterministic facts the compliance engine rules on.
///
/// Gathered by fetching the listing — step 1 of the pipeline, and **no model is
/// involved**. Quality judgement happens later, against retrieved evidence.
export interface CarbonFacts {
  readonly sourceId: string;
  readonly projectId: string;
  readonly registry: Registry;
  readonly vintage: number;
  /// Years between the vintage and now. Older vintages are weaker evidence, and
  /// this is the arithmetic form of that signal.
  readonly vintageAgeYears: number;
  readonly pricePerTonne: number;
  readonly liquidSupply: number;
  /// True when the listing cannot currently satisfy the requested quantity.
  /// A deterministic fact, established before any judgement is asked for.
  readonly insufficientSupply: boolean;
  /// True when the registry could not be established from the project id.
  /// 25 of 723 live listings carried no usable project id, and a credit whose
  /// provenance cannot be established is a fact the engine must be told, not
  /// one to be quietly defaulted.
  readonly registryUnknown: boolean;
}

export class CarbonmarkAdapter
  implements FulfilmentAdapter<CarbonOrder, CarbonFacts>
{
  readonly name = "Carbonmark";
  readonly vertical = "carbon" as const;
  readonly status = "in_development" as const;
  readonly live: boolean;
  /// A retired credit cannot be un-retired. There is no cancellation to offer,
  /// which is why the shared port carries no `cancel` — a uniform one would be
  /// a lie told by the type.
  readonly reversible = false;

  #client: CarbonmarkClient;
  #now: () => Date;

  constructor(
    chain: ChainConfig,
    apiKey: string | undefined,
    now: () => Date = () => new Date(),
  ) {
    this.#client = new CarbonmarkClient(chain, apiKey);
    this.live = this.#client.live;
    this.#now = now;
  }

  get client(): CarbonmarkClient {
    return this.#client;
  }

  /// What this retirement would cost. Free, and consumes nothing.
  async quote(order: CarbonOrder): Promise<readonly FulfilmentQuote[]> {
    const quote = await this.#client.quote(order.sourceId, order.tonnes);
    return [
      {
        ref: quote.uuid,
        providerName: this.name,
        currency: "USD",
        total: quote.costUsd,
        live: this.live,
      },
    ];
  }

  async assess(order: CarbonOrder): Promise<CarbonFacts> {
    const listing = await this.#findListing(order.sourceId);
    const vintage = listing.credit.vintage;
    const year = this.#now().getUTCFullYear();

    return {
      sourceId: listing.sourceId,
      projectId: listing.credit.projectId,
      registry: listing.credit.registry,
      vintage,
      vintageAgeYears: vintage > 0 ? year - vintage : -1,
      pricePerTonne: listing.purchasePrice,
      liquidSupply: listing.liquidSupply,
      insufficientSupply: listing.liquidSupply < order.tonnes,
      registryUnknown: listing.credit.registry === "UNKNOWN",
    };
  }

  /// **Retires a credit. Spends money and cannot be undone.**
  ///
  /// Unreachable without an approved decision: `Approved` is obtainable only
  /// from `approve()` in the compliance package.
  ///
  /// The order is re-quoted here rather than carrying a quote from earlier,
  /// because a quote is consumed by the order that uses it and a stale one
  /// would retire against a price no longer offered.
  async fulfil(approved: Approved<CarbonOrder>): Promise<Receipt> {
    const { order } = approved;
    const quote = await this.#client.quote(order.sourceId, order.tonnes);

    const retirement = await this.#client.retire(
      quote,
      {
        beneficiaryName: order.beneficiaryName,
        retirementMessage: order.retirementMessage,
      },
      true,
    );

    return {
      ref: retirement.retirementTxHash,
      rawResponse: JSON.stringify(retirement),
      proofUrl: retirement.certificateUrl,
      amountCharged: retirement.amountCharged,
      currency: retirement.currency,
      live: retirement.live,
    };
  }

  /// Re-check a retirement against Carbonmark.
  async verify(ref: string): Promise<VerificationResult> {
    const order = await this.#client.order(ref);
    return {
      found: true,
      state: String(order.status ?? "unknown"),
      proofUrl: String(order.view_retirement_url ?? ""),
      checkedAt: this.#now().toISOString(),
      live: this.live,
    };
  }

  async #findListing(sourceId: string): Promise<Listing> {
    const all = await this.#client.listings();
    const found = all.find((l) => l.sourceId === sourceId);
    if (found === undefined) {
      throw new CarbonmarkError(
        `no listing with sourceId ${sourceId}`,
        404,
        "/prices",
      );
    }
    return found;
  }
}
