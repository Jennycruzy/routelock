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
import { assertVerticalAllowed, type ChainConfig } from "@routelock/chain";
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
    assertVerticalAllowed(chain, "carbon");
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

    // A test-mode credential does not retire anything. It completes the order
    // and hands back a shared placeholder from April 2024, beneficiary
    // "Developer Tester", which Carbonmark's own record says must not be
    // delivered to customers because the benefit was already claimed.
    //
    // Refusing here is the whole point: a Receipt is what gets hashed into
    // `carrierRefHash` and published as proof. Committing a placeholder
    // on-chain and presenting it as a RouteLock retirement would be fabricated
    // evidence, which is disqualifying — so this throws rather than returning
    // a receipt that cannot support the claim made of it.
    if (retirement.placeholder) {
      throw new CarbonmarkError(
        `test-mode credential returned Carbonmark's shared placeholder retirement ` +
          `instead of retiring for "${order.beneficiaryName}". Nothing was retired ` +
          `and no proof exists. A production key is required for a real retirement — ` +
          `see docs/carbonmark-verification.md`,
        200,
        "/orders",
      );
    }

    return {
      ref: retirement.retirementTxHash,
      rawResponse: JSON.stringify(retirement),
      proofUrl: retirement.certificateUrl,
      amountCharged: retirement.amountCharged,
      currency: retirement.currency,
      live: retirement.live,
    };
  }

  /// Re-check a retirement, keyed by its on-chain transaction hash.
  ///
  /// Matched against the order list rather than fetched by id, because
  /// `GET /orders/{id}` takes a numeric id that no order response contains.
  async verify(ref: string): Promise<VerificationResult> {
    const order = await this.#client.findOrderByTx(ref);
    return {
      found: order !== undefined,
      state: String(order?.status ?? "not found"),
      proofUrl: String(order?.view_retirement_url ?? ""),
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
