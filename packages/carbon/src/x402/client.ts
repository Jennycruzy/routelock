/// The Klima x402 endpoint, as a transport client.
///
/// Every method calls the real service; there is no offline mode and no
/// recorded-response mode, deliberately. The endpoint needs no key, no account
/// and no onboarding — the read and encode actions are free, and the only cost
/// is on-chain, inside the retirement itself.
///
/// **All six actions are POSTed to one URL** with an `action` field, rather
/// than using the equivalent GET aliases. A single JSON body is one thing to
/// log, hash and replay; a query string spread across six paths is not. The
/// raw response of the action that spends money becomes the preimage of
/// `carrierRawHash`, so its exact bytes matter.

import {
  RETRYABLE_CODES,
  X402_API,
  X402_CHAIN_ID,
  X402_MANIFEST,
  X402Error,
  type CarbonClass,
  type CarbonCredit,
  type PreparedAuthorization,
  type RetirementRecord,
  type TypedData,
  type X402Quote,
  type X402Retirement,
} from "./types.ts";

/// Waits between attempts, in milliseconds.
///
/// The shape the endpoint's own guidance asks for: 2s → 4s → 8s on a transient
/// failure. Exposed so tests can drive the policy without sleeping.
const DEFAULT_BACKOFF = [2_000, 4_000, 8_000] as const;

export interface ClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly backoffMs?: readonly number[];
  readonly timeoutMs?: number;
}

export interface QuoteRequest {
  readonly carbonClass: string;
  readonly tonnes: number;
  readonly inputToken: string;
  readonly creditToken?: string;
  readonly vintage?: number;
}

export interface PrepareRequest extends QuoteRequest {
  /// The wallet that signs and pays. Must hold USDC on Base; **needs no ETH**,
  /// which is the whole reason the relay path was chosen over self-submit.
  readonly from: string;
  /// Who the retirement is credited to on-chain. Required — the endpoint
  /// returns `attribution_required` rather than defaulting it, because the
  /// beneficiary is a permanent grouping key that cannot be edited afterwards.
  readonly beneficiaryAddress: string;
  /// Shown on the public certificate. Not PII: a merchant name or an order
  /// reference, never an identity document.
  readonly beneficiaryString: string;
  readonly retirementMessage: string;
}

export class KlimaX402Client {
  readonly name = "Klima Retirement Aggregator";

  #fetch: typeof fetch;
  #backoff: readonly number[];
  #timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#backoff = options.backoffMs ?? DEFAULT_BACKOFF;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  /// The live capability manifest. The authoritative list of what exists.
  async manifest(): Promise<Record<string, unknown>> {
    const response = await this.#fetch(X402_MANIFEST, {
      headers: { accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new X402Error(
        "manifest_unavailable",
        text.slice(0, 300),
        response.status,
        "manifest",
      );
    }
    return JSON.parse(text) as Record<string, unknown>;
  }

  /// What is retirable right now, with the registry metadata the compliance
  /// engine rules on. Free.
  async discover(
    filters: { carbonClass?: string; maxUsdcPricePerTonne?: string } = {},
  ): Promise<readonly CarbonClass[]> {
    const body: Record<string, unknown> = { action: "discover" };
    if (filters.carbonClass !== undefined) body["carbonClass"] = filters.carbonClass;
    if (filters.maxUsdcPricePerTonne !== undefined) {
      body["maxUsdcPricePerTonne"] = filters.maxUsdcPricePerTonne;
    }

    const raw = await this.#post<{ carbonClasses?: readonly RawClass[] }>(
      "discover",
      body,
    );
    return (raw.carbonClasses ?? []).map(toCarbonClass);
  }

  /// Price a specific size. Free, and commits to nothing.
  ///
  /// Always call this rather than multiplying `discover`'s catalogue price by a
  /// tonnage: that figure is the marginal price near one tonne, and a large
  /// order walks up the curve.
  async quote(request: QuoteRequest): Promise<X402Quote> {
    const raw = await this.#post<RawQuote>("quote", {
      action: "quote",
      ...this.#quoteBody(request),
    });
    return toQuote(raw);
  }

  /// Build the authorization to sign. Free; nothing has moved.
  ///
  /// Returns the endpoint's `actionsRetireRequest` untouched, because it must
  /// be posted back verbatim — it carries the `salt` without which the signed
  /// nonce cannot be reproduced.
  async prepareAuth(request: PrepareRequest): Promise<PreparedAuthorization> {
    const raw = await this.#post<RawPrepareAuth>("prepare-auth", {
      action: "prepare-auth",
      ...this.#quoteBody(request),
      from: request.from,
      details: {
        beneficiaryAddress: request.beneficiaryAddress,
        beneficiaryString: request.beneficiaryString,
        retirementMessage: request.retirementMessage,
      },
    });

    const typedData = raw.typedData;
    if (
      typedData === undefined ||
      typeof typedData["domain"] !== "object" ||
      typeof typedData["types"] !== "object" ||
      typeof typedData["primaryType"] !== "string"
    ) {
      throw new X402Error(
        "unusable_authorization",
        `prepare-auth returned no complete EIP-712 payload. Refusing to sign a ` +
          `partially-formed authorization.`,
        200,
        "prepare-auth",
      );
    }

    const message = typedData.message ?? {};
    const nonce = String(message["nonce"] ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
      // The nonce is what makes crash recovery possible at all. Without it
      // there is no way to ask the chain whether an authorization was spent,
      // and a timeout becomes unrecoverable rather than merely inconvenient.
      throw new X402Error(
        "unusable_authorization",
        `prepare-auth returned no signable nonce (got ${JSON.stringify(message["nonce"])}). ` +
          `Refusing to sign an authorization whose outcome could not be checked afterwards.`,
        200,
        "prepare-auth",
      );
    }

    return {
      scheme: String(raw.scheme ?? ""),
      chainId: Number(raw.chainId ?? 0),
      inputToken: String(raw.inputToken ?? ""),
      spender: String(raw.spender ?? ""),
      authValue: atomicToUsdc(raw.authValue),
      executorGas: atomicToUsdc(raw.executorGas),
      // `prepare-auth` carries `resolvedCredit` at the top level while `quote`
      // nests it inside the quote object. Folding it in here keeps one shape
      // for callers; taking `raw.quote` alone silently reported the retirement
      // as being of credit "" vintage 0, which is exactly the kind of quiet
      // zero the pre-sign check exists to catch.
      quote: toQuote({
        ...(raw.quote ?? {}),
        ...(raw.resolvedCredit === undefined
          ? {}
          : { resolvedCredit: raw.resolvedCredit }),
      }),
      typedData: typedData as unknown as TypedData,
      actionsRetireRequest: raw.actionsRetireRequest ?? {},
      onChainDetails: raw.onChainDetails ?? {},
      nonce: nonce as `0x${string}`,
      validBefore: Number(message["validBefore"] ?? 0),
    };
  }

  /// **Relay a signed authorization. This spends money and cannot be undone.**
  ///
  /// `body` is the endpoint's own `actionsRetireRequest` with only the
  /// signature filled in. Nothing else is added or reordered: the endpoint
  /// rebuilds the retirement, re-hashes it with the submitted salt, and rejects
  /// anything that does not reproduce the nonce that was signed.
  ///
  /// **This call is never retried, at any level.** A timeout here does not mean
  /// the retirement failed — it may have been relayed and mined while the
  /// connection was dropping, and a blind second attempt would burn a second
  /// credit irreversibly. Recovery is the caller's job and is done against the
  /// chain, not against this endpoint: see `authorization.ts`.
  async submitRetirement(
    body: Record<string, unknown>,
    confirmSpend: true,
  ): Promise<X402Retirement> {
    void confirmSpend;
    const raw = await this.#post<RawRetire>("actions/retire", body, {
      attempts: 1,
    });
    return {
      status: String(raw.status ?? ""),
      transactionHash: String(raw.transactionHash ?? ""),
      retirements: (raw.retirements ?? []).map(toRecord),
      raw: JSON.stringify(raw),
    };
  }

  /// Resolve the public certificate for a transaction. Free.
  ///
  /// A `retirement_not_found` immediately after confirmation means the subgraph
  /// has not indexed yet, not that the retirement failed — which is why the
  /// code is in the retryable set and why this is the right call to make after
  /// a `pending_index`.
  async certificate(txHash: string): Promise<readonly RetirementRecord[]> {
    const raw = await this.#post<{ retirements?: readonly RawRecord[] }>(
      "certificate",
      { action: "certificate", txHash },
    );
    return (raw.retirements ?? []).map(toRecord);
  }

  /// Poll until the certificate resolves.
  ///
  /// Throws rather than returning a retirement with no proof attached. Escrow
  /// releases against a resolved certificate and nothing else, so a receipt
  /// without one is not a partial success — it is a claim that cannot be
  /// checked, which is the kind this project does not make.
  async awaitCertificate(
    txHash: string,
    { timeoutMs = 120_000, intervalMs = 4_000 } = {},
  ): Promise<readonly RetirementRecord[]> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";

    while (Date.now() < deadline) {
      try {
        const records = await this.certificate(txHash);
        if (records.length > 0) return records;
      } catch (error) {
        if (!(error instanceof X402Error) || !RETRYABLE_CODES.has(error.code)) throw error;
        lastError = error.code;
      }
      await sleep(intervalMs);
    }

    throw new X402Error(
      "certificate_timeout",
      `no certificate for ${txHash} within ${timeoutMs}ms (last: ${lastError || "empty result"}). ` +
        `The retirement may still be settling; the transaction is the record of it.`,
      504,
      "certificate",
    );
  }

  #quoteBody(request: QuoteRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      chainId: X402_CHAIN_ID,
      inputToken: request.inputToken,
      carbonClass: request.carbonClass,
      // A decimal tonne string, not a number: the endpoint parses it exactly,
      // and a float round-trip is how "0.001" becomes "0.0009999999999".
      amount: formatTonnes(request.tonnes),
    };
    if (request.creditToken !== undefined) body["creditToken"] = request.creditToken;
    if (request.vintage !== undefined) body["vintage"] = request.vintage;
    return body;
  }

  async #post<T>(
    action: string,
    body: Record<string, unknown>,
    { attempts = this.#backoff.length + 1 } = {},
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(this.#backoff[attempt - 1] ?? 8_000);

      try {
        return await this.#postOnce<T>(action, body);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof X402Error
            ? RETRYABLE_CODES.has(error.code)
            : // A network-level failure on a free read is safe to repeat. On
              // `actions/retire` it is not, and that call is passed
              // attempts: 1 so it never reaches this branch.
              true;
        if (!retryable) throw error;
      }
    }

    throw lastError;
  }

  async #postOnce<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.#fetch(X402_API, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new X402Error(
        "unparseable_response",
        `response was not JSON: ${text.slice(0, 200)}`,
        response.status,
        action,
      );
    }

    const envelope = parsed as Record<string, unknown>;
    if (!response.ok || typeof envelope["error"] === "string") {
      const { error, message, ...context } = envelope;
      throw new X402Error(
        String(error ?? "unknown_error"),
        String(message ?? text.slice(0, 200)),
        response.status,
        action,
        context,
      );
    }

    return parsed as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/// Render tonnes as the endpoint's decimal string, without exponent notation.
///
/// `0.001` is the protocol minimum and `Number.prototype.toString` renders
/// anything below `1e-6` in exponent form, which the endpoint's schema rejects.
export function formatTonnes(tonnes: number): string {
  if (!Number.isFinite(tonnes) || tonnes <= 0) {
    throw new RangeError(`tonnes must be a positive finite number, got ${tonnes}`);
  }
  return tonnes.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

/// Atomic USDC (6 decimals) to a decimal number.
///
/// Parsed from the atomic integer rather than the `*Formatted` string, because
/// the atomic value is what the contract moves and the formatted one is a
/// rendering of it. Money is compared against the caps in this unit.
function atomicToUsdc(atomic: unknown): number {
  const value = Number(atomic ?? 0);
  return Number.isFinite(value) ? value / 1e6 : 0;
}

interface RawClass {
  carbonClassId?: string;
  name?: string | null;
  category?: string | null;
  country?: string | null;
  region?: string | null;
  methodologies?: readonly unknown[];
  isRegistered?: boolean;
  priceUsdcPerTonneFormatted?: string | null;
  creditsDetailed?: readonly RawCredit[];
  minRetirementTonnesFormatted?: string;
}

interface RawCredit {
  tokenAddress?: string;
  tokenStandard?: string;
  tokenId?: number;
  registry?: string;
  projectId?: string;
  vintage?: number | string;
  liquidityFormatted?: string;
}

interface RawQuote {
  tonnesFormatted?: string;
  retirementPrice?: string;
  fee?: string;
  total?: string;
  suggestedMaxInput?: string;
  pricePerTonne?: string;
  humanSummary?: string;
  resolvedCredit?: { creditToken?: string; tokenId?: number; vintage?: number };
}

interface RawPrepareAuth {
  scheme?: string;
  chainId?: number;
  inputToken?: string;
  spender?: string;
  authValue?: string;
  executorGas?: string;
  quote?: RawQuote;
  resolvedCredit?: { creditToken?: string; tokenId?: number; vintage?: number };
  typedData?: { message?: Record<string, unknown> } & Record<string, unknown>;
  actionsRetireRequest?: Record<string, unknown>;
  onChainDetails?: Record<string, unknown>;
}

interface RawRetire {
  status?: string;
  transactionHash?: string;
  retirements?: readonly RawRecord[];
}

interface RawRecord {
  certificateUrl?: string;
  amountInTonnes?: string;
  beneficiaryAddress?: string;
  beneficiaryName?: string;
  projectId?: string;
  creditId?: string;
}

function toCarbonClass(raw: RawClass): CarbonClass {
  const price = raw.priceUsdcPerTonneFormatted;
  return {
    carbonClassId: String(raw.carbonClassId ?? ""),
    // A class whose name is its own address carries no name. Reported as null
    // rather than dressed up, so the engine sees the gap.
    name: raw.name && raw.name !== raw.carbonClassId ? raw.name : null,
    category: raw.category === "Unknown" ? null : (raw.category ?? null),
    country: raw.country === "Unknown" ? null : (raw.country ?? null),
    region: raw.region === "Unknown" ? null : (raw.region ?? null),
    methodologies: (raw.methodologies ?? []).map(String),
    isRegistered: raw.isRegistered === true,
    priceUsdcPerTonne: price == null ? null : Number(price),
    credits: (raw.creditsDetailed ?? []).map(toCredit),
    minRetirementTonnes: Number(raw.minRetirementTonnesFormatted ?? 0),
  };
}

function toCredit(raw: RawCredit): CarbonCredit {
  return {
    tokenAddress: String(raw.tokenAddress ?? ""),
    tokenStandard: String(raw.tokenStandard ?? ""),
    tokenId: Number(raw.tokenId ?? 0),
    registry: String(raw.registry ?? ""),
    projectId: String(raw.projectId ?? ""),
    vintage: Number(raw.vintage ?? 0),
    liquidityTonnes: Number(raw.liquidityFormatted ?? 0),
  };
}

function toQuote(raw: RawQuote): X402Quote {
  return {
    tonnes: Number(raw.tonnesFormatted ?? 0),
    retirementPrice: atomicToUsdc(raw.retirementPrice),
    fee: atomicToUsdc(raw.fee),
    total: atomicToUsdc(raw.total),
    suggestedMaxInput: atomicToUsdc(raw.suggestedMaxInput),
    pricePerTonne: atomicToUsdc(raw.pricePerTonne),
    humanSummary: String(raw.humanSummary ?? ""),
    resolvedCredit: {
      creditToken: String(raw.resolvedCredit?.creditToken ?? ""),
      tokenId: Number(raw.resolvedCredit?.tokenId ?? 0),
      vintage: Number(raw.resolvedCredit?.vintage ?? 0),
    },
  };
}

function toRecord(raw: RawRecord): RetirementRecord {
  return {
    certificateUrl: String(raw.certificateUrl ?? ""),
    amountInTonnes: String(raw.amountInTonnes ?? ""),
    beneficiaryAddress: String(raw.beneficiaryAddress ?? ""),
    beneficiaryName: String(raw.beneficiaryName ?? ""),
    projectId: String(raw.projectId ?? ""),
    creditId: String(raw.creditId ?? ""),
  };
}
