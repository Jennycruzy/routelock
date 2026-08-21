/// Consumer order orchestration.
///
/// The browser owns the consumer's wallet and signs only the X Layer ERC-20 /
/// entitlement transactions. The configured RouteLock/oracle relayer signs the
/// issuer-side Base EIP-712 payment authorization. This service owns the two
/// protocol roles that cannot be held by a consumer wallet: recording the
/// compliance decision and committing provider evidence / settlement.
///
/// No private key is accepted for the consumer. The compliance and oracle keys
/// are deployment identities, checked against the addresses actually granted
/// on chain before they can be used. The oracle key is also the bounded Base
/// retirement payer; the buyer address remains the certificate beneficiary.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  createWalletClient,
  createPublicClient,
  http,
  isAddress,
  parseEventLogs,
  type Address,
  type Hash,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  ACTIVATION_REGISTRY_ABI,
  ActivationRegistryClient,
  ENTITLEMENT_STATE_NAMES,
  EntitlementState,
  SERVICE_ENTITLEMENT_ABI,
  attest,
  makeRetirementSigner,
  registryFields,
  witness,
  type Attestation,
} from "@routelock/attest";
import {
  approve,
  type Verdict,
  Verdict as VerdictEnum,
  VERDICT_NAMES,
} from "@routelock/compliance";
import type { InferenceBudget } from "@routelock/compliance";
import {
  CarbonmarkX402Adapter,
  capsFromEnv,
  type SignTypedData,
  type X402Order,
} from "@routelock/carbon";
import type { PreparedAuthorization } from "@routelock/carbon";
import type { FulfilmentQuote } from "@routelock/fulfilment";
import { FULFILMENT_CHAINS, repoRoot } from "@routelock/chain";
import type { ChainKey } from "@routelock/chain";

import type { ChainContext } from "./chain.ts";
import { OfferCatalog } from "./catalog.ts";
import { unlockKeystoreAccount } from "./keystore.ts";
import { ruleOnCarbon, type CarbonRulingResponse } from "./rule.ts";

const FACTORY_ABI = [
  {
    type: "function",
    name: "getClass",
    stateMutability: "view",
    inputs: [{ name: "classId", type: "bytes32" }],
    outputs: [{
      name: "",
      type: "tuple",
      components: [
        { name: "classId", type: "bytes32" },
        { name: "issuer", type: "address" },
        { name: "termsHash", type: "bytes32" },
        { name: "settlementToken", type: "address" },
        { name: "pricePerUnit", type: "uint256" },
        { name: "payoutObligation", type: "uint256" },
        { name: "validUntil", type: "uint64" },
        { name: "maxSupply", type: "uint32" },
        { name: "minted", type: "uint32" },
        { name: "paused", type: "bool" },
      ],
    }],
  },
  {
    type: "event",
    name: "ClassCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "classId", type: "bytes32" },
      { indexed: true, name: "issuer", type: "address" },
      { indexed: false, name: "pricePerUnit", type: "uint256" },
      { indexed: false, name: "maxSupply", type: "uint32" },
    ],
  },
  {
    type: "event",
    name: "EntitlementPurchased",
    anonymous: false,
    inputs: [
      { indexed: true, name: "classId", type: "bytes32" },
      { indexed: true, name: "tokenId", type: "uint256" },
      { indexed: true, name: "buyer", type: "address" },
    ],
  },
] as const;

const BASE_USDC_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ENTITLEMENT_CATALOG_ABI = [
  {
    type: "function",
    name: "totalMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "classOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const ESCROW_ABI = [
  {
    type: "function",
    name: "classEscrow",
    stateMutability: "view",
    inputs: [{ name: "classId", type: "bytes32" }],
    outputs: [{
      name: "",
      type: "tuple",
      components: [
        { name: "issuer", type: "address" },
        { name: "token", type: "address" },
        { name: "payoutObligation", type: "uint256" },
        { name: "collateral", type: "uint256" },
        { name: "obligation", type: "uint256" },
        { name: "registered", type: "bool" },
      ],
    }],
  },
  {
    type: "function",
    name: "deposits",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "classId", type: "bytes32" },
      { name: "buyer", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "settled", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "releaseToIssuer",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "strategyShares",
    stateMutability: "view",
    inputs: [{ name: "classId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "collateralStrategy",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const AAVE_ADAPTER_ABI = [
  {
    type: "function",
    name: "escrow",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalShares",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewRedeem",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "asset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "aToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

type FactoryClass = {
  readonly classId: `0x${string}`;
  readonly issuer: Address;
  readonly termsHash: `0x${string}`;
  readonly settlementToken: Address;
  readonly pricePerUnit: bigint;
  readonly payoutObligation: bigint;
  readonly validUntil: bigint;
  readonly maxSupply: number;
  readonly minted: number;
  readonly paused: boolean;
};

type EscrowClass = {
  readonly issuer: Address;
  readonly token: Address;
  readonly payoutObligation: bigint;
  readonly collateral: bigint;
  readonly obligation: bigint;
  readonly registered: boolean;
};

export class ConsumerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ConsumerError";
  }
}

export type ConsumerState =
  | "refused"
  | "awaiting_mint"
  | "awaiting_submit"
  | "awaiting_decision"
  | "awaiting_retirement"
  | "awaiting_relayer"
  /** Legacy browser-paid state. Loaded orders are reset before use. */
  | "awaiting_payment_signature"
  | "provider_settled"
  | "complete";

export interface ConsumerOffering {
  readonly classId: string;
  readonly vertical: "carbon" | "compute";
  readonly issuer: string;
  readonly settlementToken: string;
  readonly priceAtomic: string;
  readonly price: string;
  readonly payoutObligationAtomic: string;
  readonly validUntil: string;
  readonly maxSupply: number;
  readonly minted: number;
  readonly remainingSupply: number;
  readonly paused: boolean;
  readonly backed: boolean;
  readonly available: boolean;
  readonly availabilityReason: string | null;
  readonly collateralAtomic: string;
  readonly strategyAssetsAtomic: string;
  readonly strategySharesAtomic: string;
  readonly totalBackingAtomic: string;
  readonly obligationAtomic: string;
  readonly nextSaleCollateralAtomic: string;
  readonly allRemainingCollateralAtomic: string;
}

interface ConsumerOrder {
  readonly id: string;
  readonly chainKey: ChainKey;
  readonly vertical: "carbon";
  state: ConsumerState;
  buyer: Address;
  beneficiaryAddress: Address;
  beneficiaryString: string;
  retirementMessage: string;
  classId: `0x${string}`;
  tonnes: number;
  offering: ConsumerOffering;
  ruling: CarbonRulingResponse;
  decision: Record<string, unknown>;
  attestation: Attestation;
  quote: FulfilmentQuote | null;
  tokenId?: string | undefined;
  mintTxHash?: Hash | undefined;
  submitTxHash?: Hash | undefined;
  complianceTxHash?: Hash | undefined;
  prepared?: PreparedAuthorization | undefined;
  receipt?: {
    readonly ref: string;
    readonly rawResponse: string;
    readonly proofUrl: string;
    readonly amountCharged: number;
    readonly currency: string;
    readonly live: boolean;
  } | undefined;
  carrierTxHash?: Hash | undefined;
  settlementTxHash?: Hash | undefined;
  error?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

function now(): string {
  return new Date().toISOString();
}

function atomic(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new ConsumerError(400, `${field} must be a valid EVM address`);
  }
  return value as Address;
}

function parseTonnes(value: unknown): number {
  const tonnes = typeof value === "number" ? value : Number(value ?? 0.001);
  if (!Number.isFinite(tonnes) || tonnes <= 0 || tonnes > 1) {
    throw new ConsumerError(400, "tonnes must be greater than 0 and at most 1");
  }
  return tonnes;
}

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  ));
}

function asFactoryClass(value: unknown): FactoryClass {
  return value as FactoryClass;
}

function asEscrowClass(value: unknown): EscrowClass {
  return value as EscrowClass;
}

function viemChain(context: ChainContext) {
  return {
    id: context.deployment.chainId,
    name: context.chain.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [context.rpc] } },
  } as const;
}

function accountFromEnv(
  name: string,
  expected: Address,
): PrivateKeyAccount | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${name} must be a 32-byte 0x-prefixed private key`);
  }
  const account = privateKeyToAccount(raw as `0x${string}`);
  if (account.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${name} resolves to ${account.address}, but the deployment grants the role to ${expected}`,
    );
  }
  return account;
}

function walletFromEnv(
  name: string,
  expected: Address,
  context: ChainContext,
): WalletClient | null {
  const account = accountFromEnv(name, expected);
  return account === null
    ? null
    : createWalletClient({ account, chain: viemChain(context), transport: http(context.rpc) });
}

function walletFromAccount(
  account: PrivateKeyAccount,
  expected: Address,
  context: ChainContext,
): WalletClient {
  if (account.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `oracle keystore resolves to ${account.address}, but the deployment grants the role to ${expected}`,
    );
  }
  return createWalletClient({ account, chain: viemChain(context), transport: http(context.rpc) });
}

class OrderStore {
  readonly #path: string;
  readonly #orders = new Map<string, ConsumerOrder>();

  constructor(path: string) {
    this.#path = path;
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split("\n").filter(Boolean)) {
        const order = JSON.parse(line) as ConsumerOrder;
        // Do not ever relay an authorization prepared for the old customer
        // wallet flow. Re-open the review step so a fresh authorization binds
        // `from` to the RouteLock relayer instead.
        if (order.state === "awaiting_payment_signature") {
          order.state = "awaiting_retirement";
          order.prepared = undefined;
        }
        this.#orders.set(order.id, order);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(id: string): ConsumerOrder {
    const order = this.#orders.get(id);
    if (order === undefined) throw new ConsumerError(404, `consumer order ${id} was not found`);
    return order;
  }

  save(order: ConsumerOrder): ConsumerOrder {
    order.updatedAt = now();
    this.#orders.set(order.id, order);
    mkdirSync(dirname(this.#path), { recursive: true });
    appendFileSync(this.#path, `${JSON.stringify(jsonValue(order))}\n`, "utf8");
    return order;
  }
}

export class ConsumerService {
  readonly #context: ChainContext;
  readonly #budget: InferenceBudget;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #store: OrderStore;
  readonly #catalog: OfferCatalog;
  readonly #carbon: CarbonmarkX402Adapter | null;
  readonly #checkoutCarbon: CarbonmarkX402Adapter | null;
  readonly #complianceWallet: WalletClient | null;
  readonly #oracleWallet: WalletClient | null;
  #oracleAccount: PrivateKeyAccount | null;
  readonly #oracleKeystoreAccount: string | null;
  readonly #retirementPayer: Address;
  readonly #retirementSigner: SignTypedData | null;
  readonly #baseClient: PublicClient | null;
  #baseBalanceCache: { at: number; balance: bigint } | null = null;
  #oracleWalletPromise: Promise<WalletClient | null> | null = null;
  #oracleAccountPromise: Promise<PrivateKeyAccount | null> | null = null;

  constructor(options: {
    context: ChainContext;
    budget: InferenceBudget;
    apiKey: string;
    model: string;
    carbon: CarbonmarkX402Adapter | null;
    storePath?: string;
    catalogPath?: string;
  }) {
    this.#context = options.context;
    this.#budget = options.budget;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#store = new OrderStore(
      options.storePath ?? resolve(repoRoot(), "data/consumer-orders.jsonl"),
    );
    this.#catalog = new OfferCatalog(
      options.catalogPath ?? resolve(repoRoot(), "data/consumer-catalog.jsonl"),
    );
    this.#carbon = options.carbon;
    const isCarbonChain = options.context.chain.allowedVerticals.includes("carbon");
    this.#complianceWallet = isCarbonChain
      ? walletFromEnv(
          "COMPLIANCE_PRIVATE_KEY",
          options.context.deployment.compliance,
          options.context,
        )
      : null;
    const oracleAccount = isCarbonChain
      ? accountFromEnv("ROUTELOCK_ORACLE_PRIVATE_KEY", options.context.deployment.oracle)
      : null;
    this.#oracleAccount = oracleAccount;
    this.#oracleWallet = oracleAccount === null
      ? null
      : walletFromAccount(oracleAccount, options.context.deployment.oracle, options.context);
    const oracleKeystore = isCarbonChain
      ? (process.env["ROUTELOCK_ORACLE_KEYSTORE_ACCOUNT"]?.trim() ||
        (options.context.deployment.chain === "xlayer_mainnet" ? "routelock-oracle" : undefined))
      : undefined;
    this.#oracleKeystoreAccount = oracleKeystore === undefined || oracleKeystore === "" ? null : oracleKeystore;
    this.#retirementPayer = options.context.deployment.oracle;
    const base = FULFILMENT_CHAINS.base_mainnet;
    this.#baseClient = isCarbonChain
      ? createPublicClient({
          chain: {
            id: base.chainId,
            name: base.name,
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: [process.env["BASE_MAINNET_RPC"] ?? base.defaultRpc] } },
          },
          transport: http(process.env["BASE_MAINNET_RPC"] ?? base.defaultRpc),
        })
      : null;
    const retirementConfigured = this.#oracleAccount !== null || this.#oracleKeystoreAccount !== null;
    const retirementCeiling = capsFromEnv().perRetirementUsdc;
    this.#retirementSigner = retirementConfigured
      ? async (typedData) => {
          const account = await this.oracleAccount();
          if (account === null) {
            throw new ConsumerError(503, "the RouteLock retirement relayer is not configured");
          }
          return makeRetirementSigner(account, retirementCeiling)(typedData);
        }
      : null;
    this.#checkoutCarbon = this.#carbon !== null && this.#retirementSigner !== null
      ? new CarbonmarkX402Adapter(options.context.chain, {
          ledger: this.#carbon.ledger,
          sign: this.#retirementSigner,
        })
      : this.#carbon;
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const isCarbonChain = this.#context.chain.allowedVerticals.includes("carbon");
    const isComputeChain = this.#context.chain.allowedVerticals.includes("compute");
    const oracleConfigured = this.#oracleWallet !== null || this.#oracleKeystoreAccount !== null;
    const retirementConfigured = this.#retirementSigner !== null;
    const baseBalance = isCarbonChain ? await this.baseUsdcBalance() : null;
    const retirementFunded = baseBalance !== null && baseBalance > 0n;
    const checkoutEnabled =
      isCarbonChain &&
      this.#apiKey.length > 0 &&
      this.#complianceWallet !== null &&
      retirementConfigured &&
      retirementFunded &&
      this.#context.chain.env === "live";
    const carbonReason = !isCarbonChain
      ? `${this.#context.chain.name} is the BOT compute lane; select an X Layer API for carbon`
      : this.#context.chain.env !== "live"
        ? "X Layer testnet is read-only here because carbon retirement is real and irreversible; use the X Layer mainnet API for checkout"
        : !this.#apiKey
          ? "the compliance model key is not configured"
          : this.#complianceWallet === null
            ? "the deployment compliance relayer is not configured for this API"
            : !retirementConfigured
              ? "the RouteLock retirement relayer is not configured for this API"
              : baseBalance === null
                ? "the RouteLock retirement relayer's Base USDC balance could not be verified"
                : !retirementFunded
                  ? `the RouteLock retirement relayer ${this.#retirementPayer} has no Base USDC`
                  : null;
    const configuredAaveAdapter = this.#context.deployment.aaveYieldAdapter;
    const aaveEnabled = configuredAaveAdapter !== undefined && !/^0x0{40}$/i.test(configuredAaveAdapter);
    const venue = this.#context.chain.yieldVenue;
    const computeConfigNames = [
      "AKASH_CONSOLE_API_URL",
      "AKASH_API_KEY",
      "AKASH_SDL_PATH",
      "AKASH_WORKLOAD_DESCRIPTION",
      "AKASH_SERVICE_NAME",
      "AKASH_ACCEPTABLE_USE_POLICY_URL",
      "AKASH_DEPOSIT_USD",
      "AKASH_BID_POLL_MS",
      "AKASH_BID_TIMEOUT_MS",
      "AKASH_READY_POLL_MS",
      "AKASH_READY_TIMEOUT_MS",
    ] as const;
    const computeConfigMissing = computeConfigNames.filter((name) => {
      const value = process.env[name];
      return value === undefined || value.trim() === "";
    });
    const computeProofUrl = process.env["ROUTELOCK_COMPUTE_PROOF_URL"]?.trim() || null;
    const computeProofIsHttps = computeProofUrl === null || /^https:\/\//i.test(computeProofUrl);
    const computeActive =
      isComputeChain &&
      computeConfigMissing.length === 0 &&
      computeProofUrl !== null &&
      computeProofIsHttps;
    return {
      agent: {
        name: "RouteLock Agent",
        track: "AI RWA",
        role: "Checks real-world service requests, records the decision, and gates settlement on provider proof.",
        boundary: "The agent can approve or refuse a request, but it cannot release customer funds by itself.",
      },
      lanes: {
        carbon: {
          status: "active",
          name: "Carbon retirement",
          chainKey: "xlayer_mainnet",
          chainName: "X Layer Mainnet",
          chainId: 196,
          proofUrls: [
            "https://app.carbonmark.com/retirements/id/8453-0x8717eb0fad50d2afed907edc810bb7daca7b19a66eccce7cc67a20aa58d7b6d2-0",
            "https://app.carbonmark.com/retirements/id/8453-0xdb7451c298d6f57b58874bd1f7e7c447863ed1e1190c98cc45478c9aae285f0d-0",
          ],
          summary: "Live carbon retirements and public certificates are on X Layer.",
        },
        compute: {
          status: computeActive ? "active" : "in_development",
          name: "Compute leasing",
          chainKey: this.#context.deployment.chain,
          chainName: this.#context.chain.name,
          chainId: this.#context.deployment.chainId,
          proofUrls: computeProofUrl === null ? [] : [computeProofUrl],
          summary: computeActive
            ? "A live Akash lease and ingress proof have been committed on this BOT Chain deployment."
            : "The Akash adapter is configured; a committed live ingress proof is required before compute becomes active.",
        },
      },
      chain: {
        key: this.#context.deployment.chain,
        name: this.#context.chain.name,
        id: this.#context.deployment.chainId,
        environment: this.#context.chain.env,
        explorer: this.#context.chain.explorer,
      },
      contracts: {
        entitlementFactory: this.#context.deployment.entitlementFactory,
        serviceEntitlement: this.#context.deployment.serviceEntitlement,
        settlementEscrow: this.#context.deployment.settlementEscrow,
        activationRegistry: this.#context.deployment.activationRegistry,
        settlementToken: this.#context.deployment.settlementToken,
        ...(aaveEnabled ? { aaveYieldAdapter: configuredAaveAdapter } : {}),
      },
      yield: {
        enabled: aaveEnabled,
        venue: venue.kind === "aave-v3"
          ? {
              name: "Aave V3",
              pool: venue.pool,
              asset: venue.asset,
              assetSymbol: venue.assetSymbol,
              aToken: venue.aToken,
              aTokenSymbol: venue.aTokenSymbol,
            }
          : null,
        reason: aaveEnabled
          ? "Idle provider collateral can be supplied to Aave and withdrawn through the escrow safety checks."
          : venue.kind === "aave-v3"
            ? "Aave is verified on this chain, but this deployment still uses the original raw-collateral escrow."
            : venue.reason,
        adapter: aaveEnabled ? configuredAaveAdapter : null,
      },
      carbon: {
        productStatus: "active",
        supported: isCarbonChain,
        review: isCarbonChain && this.#apiKey.length > 0,
        complianceRelay: isCarbonChain && this.#complianceWallet !== null,
        retirementRelay: isCarbonChain && retirementConfigured,
        checkoutEnabled,
        payment: isCarbonChain
          ? {
              customerChain: this.#context.chain.name,
              customerCurrency: this.#context.deployment.settlementSymbol,
              retirementChain: "Base Mainnet (8453)",
              retirementCurrency: "USDC",
              retirementPayer: this.#retirementPayer,
              retirementRelayerBaseUsdc: baseBalance === null ? null : Number(baseBalance) / 1_000_000,
              retirementFunded,
              customerBaseUsdcRequired: false,
            }
          : null,
        reason: carbonReason,
      },
      compute: {
        productStatus: computeActive ? "active" : "in_development",
        supported: isComputeChain,
        active: computeActive,
        providerConfigured: isComputeChain && computeConfigMissing.length === 0,
        missingConfiguration: isComputeChain ? computeConfigMissing : [],
        reason: isComputeChain && computeConfigMissing.length > 0
          ? `the live provider run is not configured; missing ${computeConfigMissing.join(", ")}`
          : isComputeChain && !computeProofIsHttps
            ? "ROUTELOCK_COMPUTE_PROOF_URL must use HTTPS"
            : isComputeChain && computeProofUrl === null
              ? "the deployment is configured, but no committed live ingress proof URL is configured"
              : "the adapter and preflight are ready",
      },
    };
  }

  async catalog(): Promise<{ readAt: string; capabilities: Record<string, unknown>; offerings: readonly ConsumerOffering[] }> {
    if (!this.#context.chain.allowedVerticals.includes("carbon")) {
      return { readAt: now(), capabilities: await this.capabilities(), offerings: [] };
    }

    // The factory has no enumerable class list. Existing entitlements still
    // provide a recovery path, while the persistent discovery index records
    // classes created through the provider flow before the first sale. Both
    // sources are only identifiers; every offering is re-read from the live
    // factory and escrow below.
    const ids = new Set(this.#catalog.ids());
    const totalMinted = await this.#context.client.readContract({
      address: this.#context.deployment.serviceEntitlement,
      abi: ENTITLEMENT_CATALOG_ABI,
      functionName: "totalMinted",
    });
    if (totalMinted > 10_000n) {
      throw new ConsumerError(503, "the live entitlement catalogue is too large to enumerate safely");
    }
    const mintedClassIds = await Promise.all(
      Array.from({ length: Number(totalMinted) }, (_, index) =>
        this.#context.client.readContract({
          address: this.#context.deployment.serviceEntitlement,
          abi: ENTITLEMENT_CATALOG_ABI,
          functionName: "classOf",
          args: [BigInt(index + 1)],
        }),
      ),
    );
    for (const classId of mintedClassIds) {
      const id = String(classId).toLowerCase();
      ids.add(id);
      this.#catalog.remember(id);
    }
    const offerings = await Promise.all([...ids].map((id) => this.readOffering(id as `0x${string}`)));
    return { readAt: now(), capabilities: await this.capabilities(), offerings };
  }

  /// Provider-facing read for a class id that was just created in a wallet.
  /// The public consumer catalogue is derived from minted entitlements; a
  /// merchant also needs to inspect a brand-new class before its first sale.
  async merchantClass(classIdValue: unknown): Promise<{ readonly readAt: string; readonly offering: ConsumerOffering }> {
    if (!this.#context.chain.allowedVerticals.includes("carbon")) {
      throw new ConsumerError(409, `${this.#context.chain.name} is the BOT compute lane; use the BOT deployment for provider offer reads`);
    }
    if (typeof classIdValue !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(classIdValue)) {
      throw new ConsumerError(400, "classId must be a 32-byte service offer id");
    }
    return {
      readAt: now(),
      offering: await this.readOffering(classIdValue as `0x${string}`),
    };
  }

  /// Record a provider-created class in the discovery cache after verifying it
  /// against the live contracts. No caller-supplied price, issuer, or backing
  /// is trusted; those values are read by `readOffering` and rechecked every
  /// time the public catalogue is served.
  async discoverMerchantClass(classIdValue: unknown): Promise<{ readonly readAt: string; readonly offering: ConsumerOffering }> {
    const result = await this.merchantClass(classIdValue);
    this.#catalog.remember(result.offering.classId);
    return result;
  }

  async previewCarbon(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.#context.chain.allowedVerticals.includes("carbon")) {
      throw new ConsumerError(409, `${this.#context.chain.name} is not the carbon lane`);
    }

    const buyer = parseAddress(input["buyer"], "buyer");
    const beneficiaryAddress = parseAddress(input["beneficiaryAddress"] ?? buyer, "beneficiaryAddress");
    if (buyer.toLowerCase() !== beneficiaryAddress.toLowerCase()) {
      throw new ConsumerError(400, "beneficiaryAddress must match the connected wallet for a consumer order");
    }
    const classIdValue = input["classId"];
    if (typeof classIdValue !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(classIdValue)) {
      throw new ConsumerError(400, "classId must be a bytes32 class from the live catalog");
    }
    const classId = classIdValue as `0x${string}`;
    const carbon = this.requireCarbon();
    const tonnes = parseTonnes(input["tonnes"]);
    const offering = await this.readOffering(classId);
    if (!offering.available) {
      throw new ConsumerError(409, offering.availabilityReason ?? "this offering is not available");
    }

    const beneficiaryString = typeof input["beneficiaryString"] === "string" && input["beneficiaryString"].trim() !== ""
      ? input["beneficiaryString"].trim().slice(0, 120)
      : "RouteLock consumer";
    const retirementMessage = typeof input["retirementMessage"] === "string" && input["retirementMessage"].trim() !== ""
      ? input["retirementMessage"].trim().slice(0, 180)
      : "RouteLock carbon retirement";

    const baseOrder: X402Order = {
      entitlementTokenId: "0",
      classId,
      carbonClass: String(input["carbonClass"] ?? ""),
      tonnes,
      // The customer is the beneficiary, not the Base payer. The configured
      // RouteLock/oracle relayer signs the Base EIP-3009 authorization; the
      // customer only pays the X Layer entitlement/escrow amount.
      from: this.#retirementPayer,
      beneficiaryAddress,
      beneficiaryString,
      retirementMessage,
    };
    if (!/^0x[0-9a-fA-F]{40}$/.test(baseOrder.carbonClass)) {
      throw new ConsumerError(400, "carbonClass must be a class id from the live carbon inventory");
    }

    const ruling = await ruleOnCarbon(
      carbon,
      this.#budget,
      this.#apiKey,
      this.#model,
      baseOrder.carbonClass,
      tonnes,
    );

    const attestation = attest({
      vertical: "carbon",
      decisionHash: ruling.decisionHash as `0x${string}`,
      work: {
        carbonClass: ruling.carbonClass,
        tonnes,
        beneficiary: beneficiaryString,
      },
      evidence: {
        registries: (ruling.facts as { registries: readonly string[] }).registries,
        vintages: (ruling.facts as { vintages: readonly number[] }).vintages,
        methodologies: (ruling.facts as { methodologies: readonly string[] }).methodologies,
      },
    });
    const quote = ruling.verdict === "APPROVED" ? (await carbon.quote(baseOrder))[0] ?? null : null;
    const decision = ruling.decision as Record<string, unknown>;
    const id = randomUUID();
    const order: ConsumerOrder = {
      id,
      chainKey: this.#context.deployment.chain as ChainKey,
      vertical: "carbon",
      state: ruling.verdict === "APPROVED" ? "awaiting_mint" : "refused",
      buyer,
      beneficiaryAddress,
      beneficiaryString,
      retirementMessage,
      classId,
      tonnes,
      offering,
      ruling,
      decision,
      attestation,
      quote,
      createdAt: now(),
      updatedAt: now(),
    };
    this.#store.save(order);
    return this.publicOrder(order);
  }

  getOrder(id: string): Record<string, unknown> {
    return this.publicOrder(this.#store.get(id));
  }

  async recordMint(id: string, txHashValue: unknown): Promise<Record<string, unknown>> {
    const order = this.#store.get(id);
    if (order.state !== "awaiting_mint") throw new ConsumerError(409, `order is ${order.state}, not awaiting mint`);
    const txHash = this.parseHash(txHashValue, "mintTxHash");
    const receipt = await this.#context.client.getTransactionReceipt({ hash: txHash });
    const transaction = await this.#context.client.getTransaction({ hash: txHash });
    if (receipt.status !== "success") throw new ConsumerError(400, "the entitlement transaction reverted");
    if (transaction.from.toLowerCase() !== order.buyer.toLowerCase()) {
      throw new ConsumerError(400, "the entitlement transaction was not sent by the connected wallet");
    }
    const events = parseEventLogs({ abi: FACTORY_ABI, logs: receipt.logs, eventName: "EntitlementPurchased", strict: false });
    const event = events[0];
    if (event === undefined) throw new ConsumerError(400, "the transaction did not purchase a RouteLock entitlement");
    const args = event.args as { classId: `0x${string}`; tokenId: bigint; buyer: Address };
    if (args.classId.toLowerCase() !== order.classId.toLowerCase() || args.buyer.toLowerCase() !== order.buyer.toLowerCase()) {
      throw new ConsumerError(400, "the purchased class or buyer does not match this order");
    }
    const owner = await this.#context.client.readContract({
      address: this.#context.deployment.serviceEntitlement,
      abi: SERVICE_ENTITLEMENT_ABI,
      functionName: "ownerOf",
      args: [args.tokenId],
    });
    if (owner.toLowerCase() !== order.buyer.toLowerCase()) throw new ConsumerError(400, "the purchased entitlement is not owned by the connected wallet");

    order.tokenId = args.tokenId.toString();
    order.mintTxHash = txHash;
    order.state = "awaiting_submit";
    order.error = undefined;
    this.#store.save(order);
    return this.publicOrder(order);
  }

  async recordSubmitted(id: string, txHashValue: unknown): Promise<Record<string, unknown>> {
    const order = this.#store.get(id);
    if (order.state !== "awaiting_submit") throw new ConsumerError(409, `order is ${order.state}, not awaiting submission`);
    if (order.tokenId === undefined) throw new ConsumerError(409, "the order has no entitlement token");
    const txHash = this.parseHash(txHashValue, "submitTxHash");
    const receipt = await this.#context.client.getTransactionReceipt({ hash: txHash });
    const transaction = await this.#context.client.getTransaction({ hash: txHash });
    if (receipt.status !== "success") throw new ConsumerError(400, "the work-submission transaction reverted");
    if (transaction.from.toLowerCase() !== order.buyer.toLowerCase()) throw new ConsumerError(400, "the work-submission transaction was not sent by the connected wallet");
    const state = await this.#context.client.readContract({
      address: this.#context.deployment.serviceEntitlement,
      abi: SERVICE_ENTITLEMENT_ABI,
      functionName: "stateOf",
      args: [BigInt(order.tokenId)],
    });
    const fields = registryFields(order.attestation);
    const activation = await this.#context.client.readContract({
      address: this.#context.deployment.activationRegistry,
      abi: ACTIVATION_REGISTRY_ABI,
      functionName: "activations",
      args: [BigInt(order.tokenId)],
    });
    if (state !== EntitlementState.PendingReview || activation[0] !== fields.parcelHash || activation[1] !== fields.documentsHash) {
      throw new ConsumerError(
        400,
        `the chain does not hold the expected pending review (${ENTITLEMENT_STATE_NAMES[state as EntitlementState] ?? state})`,
      );
    }

    if (this.#complianceWallet === null) {
      throw new ConsumerError(503, "the compliance relayer is not configured; no decision was written");
    }
    const verdict = Number(order.ruling.verdictOrdinal) as Verdict;
    if (verdict === VerdictEnum.None) throw new ConsumerError(409, "the ruling has no usable verdict");
    const registry = new ActivationRegistryClient(
      this.#context.client,
      { registry: this.#context.deployment.activationRegistry, entitlement: this.#context.deployment.serviceEntitlement },
      this.#complianceWallet,
    );
    const complianceTxHash = await registry.recordDecision(
      BigInt(order.tokenId),
      order.ruling.decisionHash as `0x${string}`,
      order.ruling.engineVersion,
      verdict,
    );
    order.submitTxHash = txHash;
    order.complianceTxHash = complianceTxHash;
    order.state = verdict === VerdictEnum.Approved ? "awaiting_retirement" : "refused";
    order.error = undefined;
    this.#store.save(order);
    return this.publicOrder(order);
  }

  async prepareRetirement(id: string): Promise<Record<string, unknown>> {
    const order = this.#store.get(id);
    if (order.state !== "awaiting_retirement") throw new ConsumerError(409, `order is ${order.state}, not awaiting retirement`);
    if (order.tokenId === undefined) throw new ConsumerError(409, "the order has no entitlement token");
    const approved = this.approvedOrder(order);
    const prepared = await this.requireCheckoutCarbon().prepareAuthorization(approved);
    await this.assertRetirementBalance(prepared.authValue);
    order.prepared = prepared;
    order.state = "awaiting_relayer";
    order.error = undefined;
    this.#store.save(order);
    return this.publicOrder(order);
  }

  async fulfilRetirement(id: string): Promise<Record<string, unknown>> {
    const order = this.#store.get(id);
    if (order.state !== "awaiting_relayer") throw new ConsumerError(409, `order is ${order.state}, not awaiting RouteLock relay`);
    if (order.prepared === undefined) throw new ConsumerError(409, "the order has no prepared payment authorization");
    if (this.#retirementSigner === null) throw new ConsumerError(503, "the RouteLock retirement relayer is not configured; payment was not submitted");

    const approved = this.approvedOrder(order);
    await this.assertRetirementBalance(order.prepared.authValue);
    const signature = await this.#retirementSigner(order.prepared.typedData);
    const receipt = await this.requireCheckoutCarbon().fulfilSigned(approved, order.prepared, signature);
    order.receipt = receipt;
    order.state = "provider_settled";
    order.prepared = undefined;
    order.error = undefined;
    this.#store.save(order);
    return this.settle(order);
  }

  async settleOrder(id: string): Promise<Record<string, unknown>> {
    const order = this.#store.get(id);
    if (order.state !== "provider_settled") throw new ConsumerError(409, `order is ${order.state}, not awaiting provider settlement`);
    return this.settle(order);
  }

  private async settle(order: ConsumerOrder): Promise<Record<string, unknown>> {
    const oracleWallet = await this.oracleWallet();
    if (oracleWallet === null) throw new ConsumerError(503, "the oracle relayer is not configured");
    if (order.tokenId === undefined || order.receipt === undefined) throw new ConsumerError(409, "provider receipt or entitlement token is missing");

    const witnessed = witness(order.attestation, order.receipt);
    const fields = registryFields(witnessed);
    const current = await this.#context.client.readContract({
      address: this.#context.deployment.activationRegistry,
      abi: ACTIVATION_REGISTRY_ABI,
      functionName: "activations",
      args: [BigInt(order.tokenId)],
    });
    if (current[3] !== fields.carrierRefHash || current[4] !== fields.carrierRawHash) {
      const registry = new ActivationRegistryClient(
        this.#context.client,
        { registry: this.#context.deployment.activationRegistry, entitlement: this.#context.deployment.serviceEntitlement },
        oracleWallet,
      );
      order.carrierTxHash = await registry.recordCarrier(BigInt(order.tokenId), witnessed);
    }

    const deposit = await this.#context.client.readContract({
      address: this.#context.deployment.settlementEscrow,
      abi: ESCROW_ABI,
      functionName: "deposits",
      args: [BigInt(order.tokenId)],
    });
    if (!deposit[3]) {
      const account = oracleWallet.account;
      if (account === undefined) throw new ConsumerError(503, "oracle wallet has no account");
      const { request } = await this.#context.client.simulateContract({
        address: this.#context.deployment.settlementEscrow,
        abi: ESCROW_ABI,
        functionName: "releaseToIssuer",
        args: [BigInt(order.tokenId)],
        account,
      });
      const hash = await oracleWallet.writeContract(request);
      await this.#context.client.waitForTransactionReceipt({ hash, confirmations: 2 });
      order.settlementTxHash = hash;
    }

    order.attestation = witnessed;
    order.state = "complete";
    order.error = undefined;
    this.#store.save(order);
    return this.publicOrder(order);
  }

  private requireCarbon(): CarbonmarkX402Adapter {
    if (this.#carbon === null) {
      throw new ConsumerError(409, `${this.#context.chain.name} is the BOT compute lane, not the carbon lane`);
    }
    return this.#carbon;
  }

  private requireCheckoutCarbon(): CarbonmarkX402Adapter {
    if (this.#checkoutCarbon === null || this.#retirementSigner === null) {
      throw new ConsumerError(503, "the RouteLock retirement relayer is not configured; payment was not submitted");
    }
    return this.#checkoutCarbon;
  }

  private async baseUsdcBalance(force = false): Promise<bigint | null> {
    if (this.#baseClient === null) return null;
    const nowMs = Date.now();
    if (!force && this.#baseBalanceCache !== null && nowMs - this.#baseBalanceCache.at < 30_000) {
      return this.#baseBalanceCache.balance;
    }
    try {
      const balance = await this.#baseClient.readContract({
        address: FULFILMENT_CHAINS.base_mainnet.inputToken as Address,
        abi: BASE_USDC_ABI,
        functionName: "balanceOf",
        args: [this.#retirementPayer],
      });
      this.#baseBalanceCache = { at: nowMs, balance };
      return balance;
    } catch {
      return null;
    }
  }

  private async assertRetirementBalance(authValueUsdc: number): Promise<void> {
    if (this.#baseClient === null) {
      throw new ConsumerError(503, "the Base retirement relayer is not configured");
    }
    const balance = await this.baseUsdcBalance(true);
    if (balance === null) {
      throw new ConsumerError(503, "could not verify the RouteLock relayer's Base USDC balance");
    }
    const needed = BigInt(Math.round(authValueUsdc * 1_000_000));
    if (balance < needed) {
      throw new ConsumerError(
        503,
        `the RouteLock retirement relayer has ${Number(balance) / 1_000_000} USDC on Base but this retirement needs ${authValueUsdc} USDC; fund ${this.#retirementPayer} before continuing`,
      );
    }
  }

  private async oracleAccount(): Promise<PrivateKeyAccount | null> {
    if (this.#oracleAccount !== null) return this.#oracleAccount;
    if (this.#oracleKeystoreAccount === null) return null;
    this.#oracleAccountPromise ??= unlockKeystoreAccount(this.#oracleKeystoreAccount);
    try {
      const account = await this.#oracleAccountPromise;
      if (account === null) return null;
      if (account.address.toLowerCase() !== this.#retirementPayer.toLowerCase()) {
        throw new ConsumerError(
          503,
          `oracle keystore resolves to ${account.address}, but the deployment retirement relayer is ${this.#retirementPayer}`,
        );
      }
      this.#oracleAccount = account;
      return account;
    } catch (error) {
      this.#oracleAccountPromise = null;
      if (error instanceof ConsumerError) throw error;
      throw new ConsumerError(503, error instanceof Error ? error.message : String(error));
    }
  }

  private async oracleWallet(): Promise<WalletClient | null> {
    if (this.#oracleWallet !== null) return this.#oracleWallet;
    if (this.#oracleKeystoreAccount === null) return null;
    this.#oracleWalletPromise ??= this.oracleAccount().then((account) => account === null ? null :
      walletFromAccount(account, this.#context.deployment.oracle, this.#context),
    );
    try {
      return await this.#oracleWalletPromise;
    } catch (error) {
      this.#oracleWalletPromise = null;
      throw new ConsumerError(503, error instanceof Error ? error.message : String(error));
    }
  }

  private async readOffering(classId: `0x${string}`): Promise<ConsumerOffering> {
    let raw: unknown;
    try {
      raw = await this.#context.client.readContract({
        address: this.#context.deployment.entitlementFactory,
        abi: FACTORY_ABI,
        functionName: "getClass",
        args: [classId],
      });
    } catch {
      throw new ConsumerError(404, `class ${classId} is not registered on this deployment`);
    }
    const spec = asFactoryClass(raw);
    if (
      typeof spec.issuer !== "string" ||
      spec.issuer.toLowerCase() === "0x0000000000000000000000000000000000000000" ||
      typeof spec.classId !== "string" ||
      spec.classId.toLowerCase() !== classId.toLowerCase()
    ) {
      throw new ConsumerError(404, `class ${classId} is not registered on this deployment`);
    }
    const escrow = asEscrowClass(await this.#context.client.readContract({
      address: this.#context.deployment.settlementEscrow,
      abi: ESCROW_ABI,
      functionName: "classEscrow",
      args: [classId],
    }));
    let strategyShares = 0n;
    let strategyAssets = 0n;
    const configuredAaveAdapter = this.#context.deployment.aaveYieldAdapter;
    const aaveEnabled = configuredAaveAdapter !== undefined && !/^0x0{40}$/i.test(configuredAaveAdapter);
    if (aaveEnabled) {
      try {
        const [wiredAdapter, strategyEscrow, strategyAsset] = await Promise.all([
          this.#context.client.readContract({
            address: this.#context.deployment.settlementEscrow,
            abi: ESCROW_ABI,
            functionName: "collateralStrategy",
          }),
          this.#context.client.readContract({
            address: configuredAaveAdapter,
            abi: AAVE_ADAPTER_ABI,
            functionName: "escrow",
          }),
          this.#context.client.readContract({
            address: configuredAaveAdapter,
            abi: AAVE_ADAPTER_ABI,
            functionName: "asset",
          }),
        ]);
        if (
          wiredAdapter.toLowerCase() !== configuredAaveAdapter.toLowerCase() ||
          strategyEscrow.toLowerCase() !== this.#context.deployment.settlementEscrow.toLowerCase() ||
          strategyAsset.toLowerCase() !== this.#context.deployment.settlementToken.toLowerCase()
        ) {
          throw new ConsumerError(503, "the configured Aave strategy does not match the live escrow and settlement token");
        }
        strategyShares = await this.#context.client.readContract({
          address: this.#context.deployment.settlementEscrow,
          abi: ESCROW_ABI,
          functionName: "strategyShares",
          args: [classId],
        });
        if (strategyShares > 0n) {
          strategyAssets = await this.#context.client.readContract({
            address: configuredAaveAdapter,
            abi: AAVE_ADAPTER_ABI,
            functionName: "previewRedeem",
            args: [strategyShares],
          });
        }
      } catch {
        throw new ConsumerError(503, "the configured Aave collateral strategy could not be read safely");
      }
    }
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const remaining = Math.max(0, spec.maxSupply - spec.minted);
    const totalBacking = escrow.collateral + strategyAssets;
    const nextSaleBacking = escrow.obligation + escrow.payoutObligation;
    const allRemainingBacking = escrow.obligation + escrow.payoutObligation * BigInt(remaining);
    const backed = totalBacking >= nextSaleBacking;
    const available = escrow.registered && !spec.paused && spec.validUntil >= nowSeconds && remaining > 0 && backed;
    const decimals = this.#context.chain.settlement.kind === "erc20" ? this.#context.chain.settlement.decimals : 18;
    const symbol = this.#context.chain.settlement.kind === "erc20" ? this.#context.chain.settlement.symbol : "native token";
    const missingBacking = nextSaleBacking > totalBacking ? nextSaleBacking - totalBacking : 0n;
    const reason = available
      ? null
      : !escrow.registered
        ? "the escrow class is not registered"
        : spec.paused
          ? "the issuer paused this class"
            : spec.validUntil < nowSeconds
              ? "the class has expired"
              : remaining === 0
                ? "the class has no supply remaining"
              : `the offer needs ${atomic(missingBacking, decimals)} ${symbol} more backing for the next retirement (current ${atomic(totalBacking, decimals)}; required ${atomic(nextSaleBacking, decimals)})`;
    return {
      classId: spec.classId,
      vertical: "carbon",
      issuer: spec.issuer,
      settlementToken: spec.settlementToken,
      priceAtomic: spec.pricePerUnit.toString(),
      price: atomic(spec.pricePerUnit, decimals),
      payoutObligationAtomic: spec.payoutObligation.toString(),
      validUntil: new Date(Number(spec.validUntil) * 1000).toISOString(),
      maxSupply: spec.maxSupply,
      minted: spec.minted,
      remainingSupply: remaining,
      paused: spec.paused,
      backed,
      available,
      availabilityReason: reason,
      collateralAtomic: escrow.collateral.toString(),
      strategyAssetsAtomic: strategyAssets.toString(),
      strategySharesAtomic: strategyShares.toString(),
      totalBackingAtomic: totalBacking.toString(),
      obligationAtomic: escrow.obligation.toString(),
      nextSaleCollateralAtomic: nextSaleBacking.toString(),
      allRemainingCollateralAtomic: allRemainingBacking.toString(),
    };
  }

  private approvedOrder(order: ConsumerOrder) {
    if (order.tokenId === undefined) throw new ConsumerError(409, "the order has no entitlement token");
    const x402Order: X402Order = {
      entitlementTokenId: order.tokenId,
      classId: order.classId,
      carbonClass: order.ruling.carbonClass,
      tonnes: order.tonnes,
      from: this.#retirementPayer,
      beneficiaryAddress: order.beneficiaryAddress,
      beneficiaryString: order.beneficiaryString,
      retirementMessage: order.retirementMessage,
    };
    const approved = approve(x402Order, order.decision as { verdict: Verdict });
    if (approved === null || approved.decisionHash !== order.ruling.decisionHash) {
      throw new ConsumerError(409, "the stored decision no longer matches the order; refusing to spend");
    }
    return approved;
  }

  private parseHash(value: unknown, field: string): Hash {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new ConsumerError(400, `${field} must be a transaction hash`);
    }
    return value as Hash;
  }

  private publicOrder(order: ConsumerOrder): Record<string, unknown> {
    return {
      id: order.id,
      chain: {
        key: order.chainKey,
        name: this.#context.chain.name,
        id: this.#context.deployment.chainId,
        explorer: this.#context.chain.explorer,
      },
      vertical: order.vertical,
      state: order.state,
      buyer: order.buyer,
      beneficiaryAddress: order.beneficiaryAddress,
      classId: order.classId,
      tonnes: order.tonnes,
      offering: order.offering,
      ruling: {
        verdict: order.ruling.verdict,
        verdictOrdinal: order.ruling.verdictOrdinal,
        threshold: order.ruling.threshold,
        ground: order.ruling.ground,
        proposal: order.ruling.proposal,
        facts: order.ruling.facts,
        decisionHash: order.ruling.decisionHash,
        engineVersion: order.ruling.engineVersion,
        model: order.ruling.model,
      },
      quote: order.quote,
      attestation: registryFields(order.attestation),
      tokenId: order.tokenId ?? null,
      mintTxHash: order.mintTxHash ?? null,
      submitTxHash: order.submitTxHash ?? null,
      complianceTxHash: order.complianceTxHash ?? null,
      prepared: order.prepared === undefined
        ? null
        : {
            payer: this.#retirementPayer,
            paymentChain: "Base Mainnet (8453)",
            authValue: order.prepared.authValue,
            executorGas: order.prepared.executorGas,
            quote: order.prepared.quote,
            nonce: order.prepared.nonce,
            validBefore: order.prepared.validBefore,
          },
      receipt: order.receipt ?? null,
      carrierTxHash: order.carrierTxHash ?? null,
      settlementTxHash: order.settlementTxHash ?? null,
      error: order.error ?? null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
}
