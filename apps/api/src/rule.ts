/// The two things a visitor can ask the engine to rule on.
///
/// Both follow the same shape, which is the shape the whole project argues for:
/// the model proposes, and deterministic code decides. The response therefore
/// separates the two halves explicitly — `proposal` is what the model said, and
/// `verdict`/`ground` is what the rule made of it. A page that showed only the
/// verdict would be indistinguishable from one where the model decided.
///
/// **A refusal is a completed request, not an error.** `NEEDS_INFORMATION` and
/// `REFUSED` return 200 with the same detail an approval gets, because they are
/// correct outcomes. The only 4xx here is a malformed request or an exhausted
/// budget.
///
/// Nothing in this file writes to a chain. A visitor's ruling is real inference
/// against real inventory, and it is *not* committed on chain — committing needs
/// `COMPLIANCE_ROLE`, held by a key this process does not have. The operator's
/// e2e run is what puts a decision on chain, and `/api/replay` is where anyone
/// can read the ones that are there.

import {
  CARBON_CONFIDENCE_THRESHOLD,
  CARBON_ENGINE_VERSION,
  ComplianceEngine,
  CROSS_BORDER_CONFIDENCE_THRESHOLD,
  CONFIDENCE_THRESHOLD,
  canonicalHash,
  decideCarbon,
  ENGINE_VERSION,
  proposeCarbonQuality,
  thresholdFor,
  VERDICT_NAMES,
} from "@routelock/compliance";
import type {
  CarbonQualityRequest,
  ClassificationRequest,
  InferenceBudget,
} from "@routelock/compliance";
import { CarbonmarkX402Adapter } from "@routelock/carbon";
import type { CarbonClass, RetirementLedger } from "@routelock/carbon";
import type { ChainConfig } from "@routelock/chain";

export class BadRequest extends Error {}

/// ISO 3166-1 alpha-2, upper-cased. Not validated against a country list: the
/// owner's rule is that no route may be hardcoded, and a list maintained here
/// would quietly become one.
function country(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value.trim())) {
    throw new BadRequest(`${field} must be a two-letter ISO country code`);
  }
  return value.trim().toUpperCase();
}

function positiveNumber(value: unknown, field: string, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new BadRequest(`${field} must be a positive number`);
  if (n > max) throw new BadRequest(`${field} must be at most ${max}`);
  return n;
}

/// The description is free text and reaches a model, so its length is bounded
/// here — the cap is a cost control, not a content rule. What the description
/// *says* is the engine's business: purpose flags exist precisely so that a
/// description of something unshippable produces a reasoned refusal rather
/// than a rejected request.
function description(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 3) {
    throw new BadRequest("description must be at least 3 characters");
  }
  if (value.length > 600) {
    throw new BadRequest("description must be at most 600 characters");
  }
  return value.trim();
}

export function parseClassificationRequest(body: Record<string, unknown>): ClassificationRequest {
  return {
    description: description(body["description"]),
    originCountry: country(body["originCountry"], "originCountry"),
    destinationCountry: country(body["destinationCountry"], "destinationCountry"),
    declaredValue: positiveNumber(body["declaredValue"] ?? 100, "declaredValue", 10_000_000),
    currency:
      typeof body["currency"] === "string" && /^[A-Za-z]{3}$/.test(body["currency"].trim())
        ? body["currency"].trim().toUpperCase()
        : "USD",
    weightKg: positiveNumber(body["weightKg"] ?? 1, "weightKg", 30_000),
  };
}

export interface HsRulingResponse {
  readonly vertical: "hs_classification";
  readonly request: ClassificationRequest;
  readonly crossBorder: boolean;
  readonly threshold: number;
  readonly verdict: string;
  readonly verdictOrdinal: number;
  readonly ground: unknown;
  readonly proposal: unknown;
  readonly engineVersion: string;
  readonly model: string;
  /// What would be written to `ActivationRegistry.recordDecision`, and the exact
  /// bytes it commits to. Served so a visitor can hash the canonical form
  /// themselves and get the same answer.
  readonly decisionHash: string;
  readonly canonical: string;
  readonly committedOnChain: false;
}

export async function ruleOnGoods(
  engine: ComplianceEngine,
  request: ClassificationRequest,
): Promise<HsRulingResponse> {
  const ruling = await engine.classify(request);
  const crossBorder = request.originCountry !== request.destinationCountry;

  return {
    vertical: "hs_classification",
    request,
    crossBorder,
    threshold: thresholdFor(crossBorder),
    verdict: VERDICT_NAMES[ruling.decision.verdict],
    verdictOrdinal: ruling.decision.verdict,
    ground: ruling.decision.ground,
    proposal: ruling.decision.proposal,
    engineVersion: ENGINE_VERSION,
    model: engine.model,
    decisionHash: ruling.hash,
    canonical: ruling.canonical,
    // Stated in the payload rather than left to the reader. A page that shows a
    // decision hash next to a chain explorer invites the assumption that the
    // hash is on the chain; this says plainly that it is not.
    committedOnChain: false,
  };
}

/// The thresholds, published so the page can show what the number had to beat.
export const THRESHOLDS = {
  domestic: CONFIDENCE_THRESHOLD,
  crossBorder: CROSS_BORDER_CONFIDENCE_THRESHOLD,
  carbon: CARBON_CONFIDENCE_THRESHOLD,
} as const;

/// A read-only carbon adapter for API discovery and review: real inventory, and
/// physically unable to spend. Consumer checkout uses its separately guarded
/// adapter instance in `consumer.ts`, where the configured retirement relayer
/// signs the issuer-side payment.
///
/// The `sign` callback throws. That is not a placeholder — it is the same
/// asymmetry `e2e.ts` uses deliberately, and it means the code path a visitor
/// can reach cannot authorise a payment even if every other guard were removed.
export async function refuseToSign(): Promise<never> {
  throw new Error(
    "the served API never signs. Retirement is an operator action, run from " +
      "a terminal with an explicit ceiling and an opt-in flag.",
  );
}

export function readOnlyCarbonAdapter(
  chain: ChainConfig,
  ledger: RetirementLedger,
): CarbonmarkX402Adapter {
  return new CarbonmarkX402Adapter(chain, { ledger, sign: refuseToSign });
}

export interface CarbonRulingResponse {
  readonly vertical: "carbon_quality";
  readonly carbonClass: string;
  readonly tonnes: number;
  readonly facts: unknown;
  readonly threshold: number;
  readonly verdict: string;
  readonly verdictOrdinal: number;
  readonly ground: unknown;
  readonly proposal: unknown;
  /// The exact decision object whose canonical hash is committed when the
  /// consumer completes the on-chain activation. Returning it lets the
  /// relayer reconstruct the typed `Approved` gate without inventing a second
  /// decision representation.
  readonly decision: Record<string, unknown>;
  readonly engineVersion: string;
  readonly model: string;
  readonly decisionHash: string;
  readonly quotedUsdc: number | null;
  readonly committedOnChain: false;
  readonly retired: false;
}

/// Rule on a class the visitor picked out of live inventory.
///
/// The class id is checked against `discover()` rather than trusted, because a
/// ruling on a class that is not for sale describes nothing. That check is a
/// free call — inventory and pricing cost no money and no signature.
export async function ruleOnCarbon(
  adapter: CarbonmarkX402Adapter,
  budget: InferenceBudget,
  apiKey: string,
  model: string,
  carbonClassId: string,
  tonnes: number,
): Promise<CarbonRulingResponse> {
  const inventory = await adapter.discover();
  const chosen = inventory.find(
    (c: CarbonClass) => c.carbonClassId.toLowerCase() === carbonClassId.toLowerCase(),
  );
  if (chosen === undefined) {
    throw new BadRequest(
      `${carbonClassId} is not in live inventory. Inventory moves — one listing ` +
        `went from 18,993 t to 0.056 t within minutes — so re-read /api/carbon/inventory.`,
    );
  }

  const order = {
    // A ruling is not an order. These fields exist because `assess()` takes an
    // order shape, and the zero token id records that no entitlement is bound:
    // nothing here can be fulfilled.
    entitlementTokenId: "0",
    classId: "0x0000000000000000000000000000000000000000000000000000000000000000",
    carbonClass: chosen.carbonClassId,
    tonnes,
    from: "0x0000000000000000000000000000000000000000",
    beneficiaryAddress: "0x0000000000000000000000000000000000000000",
    beneficiaryString: "not an order — a ruling requested through the public API",
    retirementMessage: "not an order",
  };

  const facts = await adapter.assess(order);
  const request: CarbonQualityRequest = {
    carbonClass: facts.carbonClass,
    name: facts.name,
    category: facts.category,
    country: facts.country,
    methodologies: facts.methodologies,
    registries: facts.registries,
    projectIds: facts.projectIds,
    vintages: facts.vintages,
    oldestVintage: facts.oldestVintage,
    oldestVintageAgeYears: facts.oldestVintageAgeYears,
    isRegistered: facts.isRegistered,
    liquidityTonnes: facts.liquidityTonnes,
    insufficientLiquidity: facts.insufficientLiquidity,
    identityUnknown: facts.identityUnknown,
    tonnesRequested: tonnes,
  };

  const { proposal } = await proposeCarbonQuality(request, { apiKey, model, budget });
  const { verdict, ground } = decideCarbon(request, proposal);

  const decision = {
    engineVersion: CARBON_ENGINE_VERSION,
    model,
    request,
    proposal,
    verdict,
    ground,
    irreversible: true as const,
  };

  return {
    vertical: "carbon_quality",
    carbonClass: chosen.carbonClassId,
    tonnes,
    facts,
    threshold: CARBON_CONFIDENCE_THRESHOLD,
    verdict: VERDICT_NAMES[verdict],
    verdictOrdinal: verdict,
    ground,
    proposal,
    decision,
    engineVersion: CARBON_ENGINE_VERSION,
    model,
    // The same hash the operator's run would commit, computed the same way.
    decisionHash: canonicalHash(decision),
    quotedUsdc: chosen.priceUsdcPerTonne,
    committedOnChain: false,
    retired: false,
  };
}
