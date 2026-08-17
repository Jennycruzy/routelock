/**
 * CarbonmarkX402Adapter — CARBON RETIREMENT
 * Status:  ACTIVE since 17 August 2026. One real retirement — 0.001 t of
 *          UCR-437-2023, 0.027725 USDC on Base, discharging entitlement 4 on
 *          X Layer. Certificate and the checks that confirmed it are in
 *          docs/adapters.md.
 * Chain:   X Layer. The entitlement, collateral, escrow, compliance decision
 *          and audit trail are all on X Layer, and nothing of RouteLock is
 *          deployed anywhere else. The issuer's payment to the supplier crosses
 *          on Base (8453) because that is where the supplier's rails are — a
 *          cost of goods, not a settlement layer.
 * Access:  Keyless. Carbonmark's REST API is KYB-gated (compliance review, a
 *          signed API Services Agreement, then dashboard keys) and cannot be
 *          cleared on a build timeline. The Klima x402 endpoint needs no key
 *          and no account — payment is authorised per request by an EIP-3009
 *          signature — which is what makes this retirement real rather than
 *          described.
 * Purpose: Its fulfilment proof is a public certificate at the registry that
 *          issued the credit, checkable in about ninety seconds with no key,
 *          no login and no wallet.
 * See docs/adapters.md
 */

/// Carbon retirement over the Klima x402 endpoint, through the shared port.
///
/// The obligation being tokenised is **not the credit** — the credit is already
/// a real-world asset custodied in a registry. It is the *obligation to retire
/// one*, which is the part that is currently unenforceable: offsets sold at
/// checkout are paid for immediately and retired later, in bulk, if at all.
///
/// ## Why this adapter and not the REST one
///
/// Carbonmark's standard REST API is KYB-gated — corporate compliance review,
/// then a signed API Services Agreement, then dashboard access to generate live
/// keys. `CarbonmarkAdapter` in the parent directory implements it and is
/// exercised as far as a test-mode key allows, which turned out to be not far
/// at all: a test-mode retirement returns a shared placeholder from April 2024
/// and retires nothing. The x402 endpoint has no onboarding and no key, and its
/// retirements are real. See `docs/carbonmark-verification.md`.
///
/// ## The constraint everything here is shaped by
///
/// A confirmed retirement permanently burns the credit. There is no undo, no
/// refund, no resale and no dispute. That asymmetry is the justification for
/// the refusal gate rather than a caveat attached to it: **the cost of a wrong
/// approval is unrecoverable and the cost of a wrong refusal is a delayed
/// purchase**, so the engine refuses under uncertainty instead of guessing.
///
/// In this file the same asymmetry produces the caps, the ledger written before
/// the request rather than after it, and the refusal to retry a timeout.

import type {
  Approved,
  FulfilmentAdapter,
  FulfilmentQuote,
  Receipt,
  VerificationResult,
} from "@routelock/fulfilment";
import {
  assertKeylessSpendAllowed,
  FULFILMENT_CHAINS,
  KLIMA_X402_SPEND,
  type ChainConfig,
} from "@routelock/chain";
import { KlimaX402Client, type PrepareRequest } from "./client.ts";
import {
  DuplicateRetirement,
  idempotencyKey,
  RetirementLedger,
  type LedgerRecord,
} from "./ledger.ts";
import { authorizationOutcome } from "./authorization.ts";
import {
  creditedAsRequested,
  X402_CHAIN_ID,
  X402Error,
  type CarbonClass,
  type PreparedAuthorization,
  type TypedData,
} from "./types.ts";

/// What one retirement order consists of.
export interface X402Order {
  /// The RouteLock entitlement being discharged. The idempotency anchor: one
  /// entitlement is one obligation, and the same entitlement fulfilled twice is
  /// a double retirement however much else changed around it.
  readonly entitlementTokenId: string | number;
  /// The opaque class hash the contracts store. Carried so the retirement can
  /// be tied back to the obligation it discharges; the contracts never parse
  /// it, and nothing about carbon can be read out of it.
  readonly classId: string;
  /// Which class to retire from, chosen from live `discover` inventory at the
  /// time of the order rather than from a cached or hardcoded list.
  readonly carbonClass: string;
  readonly tonnes: number;
  /// The wallet that signs and pays. Holds USDC on Base and needs no ETH.
  readonly from: string;
  /// Credited on-chain. Permanent and un-editable once the retirement
  /// confirms, which is why the endpoint refuses to default it.
  readonly beneficiaryAddress: string;
  /// Shown on the public certificate. Not PII: a merchant name or an order
  /// reference, never an identity document.
  readonly beneficiaryString: string;
  readonly retirementMessage: string;
  /// Pin a specific credit within the class. Omitted lets the endpoint choose
  /// the most liquid one that can cover the amount.
  readonly creditToken?: string;
  readonly vintage?: number;
}

/// The deterministic facts the compliance engine rules on.
///
/// Step 1 of the pipeline, and **no model is involved**. Everything here comes
/// from `discover` — the provider's own metadata — or from arithmetic on it.
/// Quality judgement happens later, against retrieved evidence.
export interface X402Facts {
  readonly carbonClass: string;
  readonly name: string | null;
  readonly category: string | null;
  readonly country: string | null;
  /// The methodology the credits were issued under. The signal that carries
  /// most of the quality verdict: avoided-deforestation, renewable-energy
  /// additionality and cookstove methodologies are the known-weak categories.
  readonly methodologies: readonly string[];
  readonly registries: readonly string[];
  readonly projectIds: readonly string[];
  readonly vintages: readonly number[];
  /// Oldest vintage in the class, and its age. Older vintages are weaker
  /// evidence; this is the arithmetic form of that signal.
  readonly oldestVintage: number;
  readonly oldestVintageAgeYears: number;
  readonly isRegistered: boolean;
  readonly pricePerTonne: number | null;
  readonly liquidityTonnes: number;
  /// True when the class cannot currently satisfy the requested quantity.
  readonly insufficientLiquidity: boolean;
  /// True when the class has no name, category or methodology to rule on.
  ///
  /// Not hypothetical: one class in live inventory returns its own address as
  /// its name, `category: "Unknown"`, no methodologies and zero credits. A
  /// class whose identity cannot be established is a fact the engine must be
  /// told about, never one to be quietly defaulted — and it is the clearest
  /// case there is for `NEEDS_INFORMATION`.
  readonly identityUnknown: boolean;
}

/// Signs an EIP-712 payload and returns a 65-byte signature.
///
/// A callback rather than a key, so the issuer's private key never enters this
/// package. It also keeps the adapter usable from a browser wallet, a keystore,
/// or a hardware signer without any of them being a dependency here.
export type SignTypedData = (typedData: TypedData) => Promise<string>;

export interface X402AdapterOptions {
  readonly client?: KlimaX402Client;
  readonly ledger: RetirementLedger;
  readonly sign: SignTypedData;
  readonly now?: () => Date;
  readonly env?: Record<string, string | undefined>;
  /// How long to keep polling for the certificate after a `pending_index`.
  /// Configurable so the suite can exercise the give-up path without waiting
  /// out the production timeout.
  readonly certificateTimeoutMs?: number;
  readonly certificatePollMs?: number;
}

export class CarbonmarkX402Adapter
  implements FulfilmentAdapter<X402Order, X402Facts>
{
  readonly name = "Carbonmark (Klima x402)";
  readonly vertical = "carbon" as const;
  readonly status = "in_development" as const;
  /// **Always true, and not derived from the chain.**
  ///
  /// Every other adapter reads this off the chain because its provider has a
  /// sandbox to read. This one has none: the endpoint's schema advertises Base
  /// Sepolia and its runtime rejects it, so a retirement is real or it does not
  /// happen. Reporting `live: false` on a testnet deployment would be the one
  /// lie this field could tell — a sandbox figure is safe to show and a real
  /// one is not, and here they are the same figure.
  readonly live = true;
  /// A retired credit cannot be un-retired. There is no cancellation to offer,
  /// which is why the shared port carries no `cancel` — a uniform one would be
  /// a lie told by the type.
  readonly reversible = false;

  #chain: ChainConfig;
  #client: KlimaX402Client;
  #ledger: RetirementLedger;
  #sign: SignTypedData;
  #now: () => Date;
  #env: Record<string, string | undefined>;
  #certificateWait: { timeoutMs: number; intervalMs: number };

  constructor(chain: ChainConfig, options: X402AdapterOptions) {
    this.#chain = chain;
    this.#client = options.client ?? new KlimaX402Client();
    this.#ledger = options.ledger;
    this.#sign = options.sign;
    this.#now = options.now ?? (() => new Date());
    this.#env = options.env ?? process.env;
    this.#certificateWait = {
      timeoutMs: options.certificateTimeoutMs ?? 120_000,
      intervalMs: options.certificatePollMs ?? 4_000,
    };
  }

  get client(): KlimaX402Client {
    return this.#client;
  }

  get ledger(): RetirementLedger {
    return this.#ledger;
  }

  /// Whether this deployment may spend. Read by the UI so a testnet banner can
  /// state the truth rather than the customary "sandbox provider" wording,
  /// which would be false here.
  get canSpend(): boolean {
    try {
      assertKeylessSpendAllowed(this.#chain, KLIMA_X402_SPEND, this.#env);
      return true;
    } catch {
      return false;
    }
  }

  /// What is retirable right now. Free.
  ///
  /// Carbon-specific rather than part of the shared port: a courier quotes a
  /// lane it is given and has no catalogue of obligations to list, so a
  /// `discover` on the port would be a method one vertical implements and
  /// another fakes.
  async discover(): Promise<readonly CarbonClass[]> {
    return this.#client.discover();
  }

  /// What this retirement would cost. Free, and commits to nothing.
  async quote(order: X402Order): Promise<readonly FulfilmentQuote[]> {
    const quote = await this.#client.quote(this.#quoteArgs(order));
    return [
      {
        ref: quote.resolvedCredit.creditToken,
        providerName: this.name,
        currency: "USDC",
        total: quote.total,
        live: this.live,
      },
    ];
  }

  async assess(order: X402Order): Promise<X402Facts> {
    const found = await this.#findClass(order.carbonClass);
    const credits = found.credits;
    const vintages = credits.map((c) => c.vintage).filter((v) => v > 0);
    // One live credit reports a vintage of `20240430`. Treating it as a year
    // would put it 18,000 years in the future, so a value that is not a
    // plausible year is normalised to its leading four digits and the fact is
    // kept rather than the arithmetic.
    const years = vintages.map((v) => (v > 9999 ? Math.floor(v / 10_000) : v));
    const oldest = years.length > 0 ? Math.min(...years) : 0;
    const liquidity = credits.reduce((sum, c) => sum + c.liquidityTonnes, 0);

    return {
      carbonClass: found.carbonClassId,
      name: found.name,
      category: found.category,
      country: found.country,
      methodologies: found.methodologies,
      registries: [...new Set(credits.map((c) => c.registry).filter(Boolean))],
      projectIds: [...new Set(credits.map((c) => c.projectId).filter(Boolean))],
      vintages: [...new Set(years)].sort(),
      oldestVintage: oldest,
      oldestVintageAgeYears: oldest > 0 ? this.#now().getUTCFullYear() - oldest : -1,
      isRegistered: found.isRegistered,
      pricePerTonne: found.priceUsdcPerTonne,
      liquidityTonnes: liquidity,
      insufficientLiquidity: liquidity < order.tonnes,
      identityUnknown:
        found.name === null &&
        found.category === null &&
        found.methodologies.length === 0,
    };
  }

  /// **Retires a credit. Spends real money on Base mainnet, irreversibly.**
  ///
  /// Unreachable without an approved decision: `Approved` is obtainable only
  /// from `approve()` in the compliance package, so fulfilling unapproved work
  /// is a compile error rather than a check a future call site could forget.
  ///
  /// The order of the steps is the safety property, not an implementation
  /// detail:
  ///
  ///  1. **duplicate check** — local, free, and first, so a repeat costs
  ///     nothing and cannot race a network call;
  ///  2. **spend authorisation** — a test-chain deployment refuses here;
  ///  3. **prepare-auth** — free, and the only source of the true budget;
  ///  4. **cap check** against that budget, before anything is signed;
  ///  5. **ledger write, fsynced** — *before* the request, because a record
  ///     written afterwards does not exist during the window that matters;
  ///  6. **sign, then submit once.**
  ///
  /// Steps 5 and 6 are the pair that a crash falls between, and step 5 is what
  /// makes that survivable.
  async fulfil(approved: Approved<X402Order>): Promise<Receipt> {
    const { order } = approved;
    const key = idempotencyKey({
      entitlementTokenId: order.entitlementTokenId,
      classId: order.classId,
      carbonClass: order.carbonClass,
      tonnes: order.tonnes,
      beneficiaryAddress: order.beneficiaryAddress,
    });

    const prior = this.#ledger.latest(key);
    if (prior !== undefined && prior.state !== "failed" && prior.state !== "abandoned") {
      throw new DuplicateRetirement(key, prior);
    }

    assertKeylessSpendAllowed(this.#chain, KLIMA_X402_SPEND, this.#env);

    const prepared = await this.#client.prepareAuth(this.#prepareArgs(order));
    this.#assertAuthorizationMatchesOrder(prepared, order);
    this.#ledger.assertMaySpend(key, prepared.authValue);

    this.#ledger.record({
      key,
      state: "attempting",
      from: order.from,
      carbonClass: order.carbonClass,
      tonnes: order.tonnes,
      beneficiaryAddress: order.beneficiaryAddress,
      authValueUsdc: prepared.authValue,
      nonce: prepared.nonce,
    });

    const signature = await this.#sign(prepared.typedData);
    const body = withSignature(prepared.actionsRetireRequest, signature);

    let settled;
    try {
      settled = await this.#client.submitRetirement(body, true);
    } catch (error) {
      // The dangerous case. A timeout, a dropped connection or a 5xx says
      // nothing about whether the executor relayed the transaction — it may
      // have mined while the socket was closing. The attempt therefore stays
      // `attempting`, and resolving it is a separate, deliberate act against
      // the chain rather than a retry.
      throw new X402Error(
        "retirement_outcome_unknown",
        `actions/retire did not return a usable result (${(error as Error).message}). ` +
          `The authorization may already have been relayed. Do NOT retry: resolve ` +
          `attempt ${key} with resolveUnresolved() first — it asks Base whether ` +
          `nonce ${prepared.nonce} was consumed.`,
        502,
        "actions/retire",
      );
    }

    const records =
      settled.retirements.length > 0
        ? settled.retirements
        : await this.#client.awaitCertificate(
            settled.transactionHash,
            this.#certificateWait,
          );

    const record = records[0];
    if (record === undefined || record.certificateUrl === "") {
      // Escrow releases against a resolved certificate and nothing else. A
      // transaction hash alone is not the proof this project publishes.
      throw new X402Error(
        "certificate_missing",
        `retirement ${settled.transactionHash} produced no certificate URL`,
        502,
        "certificate",
      );
    }

    // A receipt that does not describe the request is not evidence for the
    // request — and a Receipt is what gets hashed into `carrierRefHash` and
    // published as proof. Committing one that credits somebody else would be
    // fabricated evidence.
    if (!creditedAsRequested(order.beneficiaryAddress, record.beneficiaryAddress)) {
      throw new X402Error(
        "attribution_mismatch",
        `retirement credited ${record.beneficiaryAddress || "nobody"} but the ` +
          `order named ${order.beneficiaryAddress}. Refusing to publish it as ` +
          `proof of this obligation.`,
        502,
        "actions/retire",
      );
    }

    this.#ledger.record({
      key,
      state: "settled",
      from: order.from,
      carbonClass: order.carbonClass,
      tonnes: order.tonnes,
      beneficiaryAddress: order.beneficiaryAddress,
      authValueUsdc: prepared.authValue,
      nonce: prepared.nonce,
      txHash: settled.transactionHash,
      certificateUrl: record.certificateUrl,
    });

    return {
      ref: settled.transactionHash,
      rawResponse: settled.raw,
      proofUrl: record.certificateUrl,
      // What was actually authorised, from the prepared budget rather than a
      // figure computed here. The contract refunds unused slippage in the same
      // transaction, so this is a ceiling and is reported as one.
      amountCharged: prepared.authValue,
      currency: "USDC",
      live: true,
    };
  }

  /// Re-check a retirement by its Base transaction hash, against the public
  /// certificate rather than against anything stored here.
  async verify(ref: string): Promise<VerificationResult> {
    try {
      const records = await this.#client.certificate(ref);
      const record = records[0];
      return {
        found: record !== undefined,
        state: record === undefined ? "no retirement indexed" : "retired",
        proofUrl: record?.certificateUrl ?? "",
        checkedAt: this.#now().toISOString(),
        live: true,
      };
    } catch (error) {
      if (error instanceof X402Error && error.code === "retirement_not_found") {
        return {
          found: false,
          state: "retirement_not_found",
          proofUrl: "",
          checkedAt: this.#now().toISOString(),
          live: true,
        };
      }
      throw error;
    }
  }

  /// Close out attempts whose outcome was never established, by asking Base.
  ///
  /// **This is the recovery path, and it is deliberately not a retry.** For
  /// each unresolved attempt it checks whether the EIP-3009 authorization was
  /// consumed. Consumed means a credit was retired and the transaction is
  /// recovered from the log; unconsumed means nothing happened and the
  /// obligation is free to be fulfilled again.
  ///
  /// Run it before any re-attempt after a crash or a timeout. Nothing else in
  /// the system can distinguish the two cases, and guessing wrong in one
  /// direction burns a second credit.
  async resolveUnresolved(): Promise<readonly LedgerRecord[]> {
    const resolved: LedgerRecord[] = [];

    for (const attempt of this.#ledger.unresolved()) {
      const outcome = await authorizationOutcome(attempt.from, attempt.nonce);

      if (!outcome.spent) {
        resolved.push(
          this.#ledger.record({
            ...attempt,
            state: "failed",
            note: "authorization never relayed; nonce unconsumed on Base",
          }),
        );
        continue;
      }

      let certificateUrl = "";
      try {
        certificateUrl = (await this.#client.certificate(outcome.txHash))[0]?.certificateUrl ?? "";
      } catch {
        // The retirement is established by the chain regardless of whether the
        // subgraph has caught up. Recording it without the certificate is
        // right; pretending it did not happen would not be.
      }

      resolved.push(
        this.#ledger.record({
          ...attempt,
          state: "settled",
          txHash: outcome.txHash,
          ...(certificateUrl === "" ? {} : { certificateUrl }),
          note: `recovered from chain: authorization consumed in block ${outcome.blockNumber}`,
        }),
      );
    }

    return resolved;
  }

  /// The endpoint resolves the credit, the price and the attribution itself.
  /// Checking its answer against the order before signing is what stops a
  /// silent substitution — the signature binds this struct, so anything wrong
  /// in it becomes permanent the moment it is signed.
  #assertAuthorizationMatchesOrder(
    prepared: PreparedAuthorization,
    order: X402Order,
  ): void {
    const problems: string[] = [];

    if (prepared.chainId !== X402_CHAIN_ID) {
      problems.push(`chainId ${prepared.chainId}, expected ${X402_CHAIN_ID}`);
    }
    if (
      prepared.inputToken.toLowerCase() !==
      FULFILMENT_CHAINS.base_mainnet.inputToken.toLowerCase()
    ) {
      problems.push(`input token ${prepared.inputToken}`);
    }
    if (Math.abs(prepared.quote.tonnes - order.tonnes) > 1e-9) {
      problems.push(`${prepared.quote.tonnes} tonnes, ordered ${order.tonnes}`);
    }
    // The endpoint picks the credit when the order does not pin one, so this
    // is the only place its choice is visible before the signature makes it
    // permanent. An empty one means the response was not read correctly rather
    // than that no credit was chosen — which is how it was caught.
    if (prepared.quote.resolvedCredit.creditToken === "") {
      problems.push("no resolved credit");
    }
    if (
      order.creditToken !== undefined &&
      prepared.quote.resolvedCredit.creditToken.toLowerCase() !==
        order.creditToken.toLowerCase()
    ) {
      problems.push(
        `credit ${prepared.quote.resolvedCredit.creditToken}, pinned ${order.creditToken}`,
      );
    }
    const beneficiary = String(
      (prepared.actionsRetireRequest["details"] as Record<string, unknown> | undefined)?.[
        "beneficiaryAddress"
      ] ?? "",
    );
    if (beneficiary.toLowerCase() !== order.beneficiaryAddress.toLowerCase()) {
      problems.push(`beneficiary ${beneficiary || "unset"}`);
    }

    if (problems.length > 0) {
      throw new X402Error(
        "authorization_mismatch",
        `prepare-auth returned an authorization that does not match the order: ` +
          `${problems.join("; ")}. Refusing to sign.`,
        502,
        "prepare-auth",
      );
    }
  }

  #quoteArgs(order: X402Order) {
    return {
      carbonClass: order.carbonClass,
      tonnes: order.tonnes,
      inputToken: FULFILMENT_CHAINS.base_mainnet.inputToken,
      ...(order.creditToken === undefined ? {} : { creditToken: order.creditToken }),
      ...(order.vintage === undefined ? {} : { vintage: order.vintage }),
    };
  }

  #prepareArgs(order: X402Order): PrepareRequest {
    return {
      ...this.#quoteArgs(order),
      from: order.from,
      beneficiaryAddress: order.beneficiaryAddress,
      beneficiaryString: order.beneficiaryString,
      retirementMessage: order.retirementMessage,
    };
  }

  async #findClass(carbonClass: string): Promise<CarbonClass> {
    const classes = await this.#client.discover({ carbonClass });
    const wanted = carbonClass.toLowerCase();
    const found = classes.find((c) => c.carbonClassId.toLowerCase() === wanted);
    if (found === undefined) {
      throw new X402Error(
        "no_candidates",
        `no carbon class ${carbonClass} in live inventory`,
        404,
        "discover",
      );
    }
    return found;
  }
}

/// Add the signature to the endpoint's own request body, changing nothing else.
///
/// Posted back verbatim because the nonce commits to the retirement: rebuilding
/// any part of the body — including reordering `details` — risks a
/// `params_mismatch`, and the endpoint's documentation says so explicitly.
export function withSignature(
  actionsRetireRequest: Record<string, unknown>,
  signature: string,
): Record<string, unknown> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new RangeError(
      `signature must be 65 bytes of hex, got ${signature.length} chars`,
    );
  }
  const authPayload = actionsRetireRequest["authPayload"];
  if (authPayload === undefined || typeof authPayload !== "object") {
    throw new RangeError("actionsRetireRequest carries no authPayload to sign");
  }
  return {
    ...actionsRetireRequest,
    authPayload: { ...(authPayload as Record<string, unknown>), signature },
  };
}
