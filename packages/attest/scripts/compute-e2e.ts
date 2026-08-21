/// Live BOT Chain compute run.
///
/// This is intentionally a separate entry point from the carbon demo. It does
/// not contain a provider fixture, a canned SDL, a fake bid, or a fake ingress
/// URL. The Akash Console API, Anthropic, BOT Chain RPC and the signer keys are
/// all required at runtime. The script refuses to start without --broadcast so
/// a local simulation cannot be mistaken for a compute fulfilment.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseUnits,
  toHex,
} from "viem";
import type { Account, Address, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { assertVerticalAllowed, getChain, requireSettlementToken } from "@routelock/chain";
import {
  approve,
  approveCommitted,
  buildComputeDecision,
  buildComputePolicyPrompt,
  canonicalHash,
  COMPUTE_ENGINE_VERSION,
  InferenceBudget,
  ledgerPath,
  proposeComputePolicyWithRetry,
  Verdict,
  VERDICT_NAMES,
  type ComputePolicyRequest,
} from "@routelock/compliance";
import { AkashAdapter, AkashClient, type AkashOrder } from "@routelock/compute";

import { ActivationRegistryClient } from "../src/registry.ts";
import { attest, registryFields, witness } from "../src/attestation.ts";
import { loadDotEnv } from "./env.ts";
import { unlockKeystoreAccount } from "./keystore.ts";

const BROADCAST = process.argv.includes("--broadcast");
const RESUME = process.argv.includes("--resume");
if (!BROADCAST) {
  throw new Error(
    "compute:e2e is live-only: pass --broadcast. It will not use a mock Akash " +
      "deployment or pretend that a simulated lease is compute fulfilment.",
  );
}

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const FACTORY_ABI = [
  {
    type: "function",
    name: "registerIssuer",
    stateMutability: "nonpayable",
    inputs: [{ name: "issuer", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isRegisteredIssuer",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "createClass",
    stateMutability: "nonpayable",
    inputs: [
      { name: "classId", type: "bytes32" },
      { name: "termsHash", type: "bytes32" },
      { name: "settlementToken", type: "address" },
      { name: "pricePerUnit", type: "uint256" },
      { name: "payoutObligation", type: "uint256" },
      { name: "validUntil", type: "uint64" },
      { name: "maxSupply", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "classExists",
    stateMutability: "view",
    inputs: [{ name: "classId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ name: "classId", type: "bytes32" }, { name: "to", type: "address" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ESCROW_ABI = [
  {
    type: "function",
    name: "postCollateral",
    stateMutability: "nonpayable",
    inputs: [{ name: "classId", type: "bytes32" }, { name: "amount", type: "uint256" }],
    outputs: [],
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
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawCollateral",
    stateMutability: "nonpayable",
    inputs: [{ name: "classId", type: "bytes32" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }, { name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "classEscrow",
    stateMutability: "view",
    inputs: [{ name: "classId", type: "bytes32" }],
    outputs: [
      { name: "issuer", type: "address" },
      { name: "token", type: "address" },
      { name: "payoutObligation", type: "uint256" },
      { name: "collateral", type: "uint256" },
      { name: "obligation", type: "uint256" },
      { name: "registered", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ROLE_ABI = [
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const DEPLOYMENT_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "classOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "stateOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "totalMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface Deployment {
  readonly activationRegistry: Address;
  readonly admin: Address;
  readonly chain: string;
  readonly chainId: number;
  readonly compliance: Address;
  readonly entitlementFactory: Address;
  readonly oracle: Address;
  readonly serviceEntitlement: Address;
  readonly settlementEscrow: Address;
  readonly settlementSymbol: string;
  readonly settlementToken: Address;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required; no default is safe`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function positiveNumber(name: string): number {
  const value = Number(required(name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function decimalAmount(name: string, decimals: number): bigint {
  const raw = required(name);
  const amount = parseUnits(raw, decimals);
  if (amount <= 0n) throw new Error(`${name} must be greater than zero`);
  return amount;
}

function step(n: number, title: string): void {
  console.log(`\n${"─".repeat(66)}\n${n}. ${title}\n${"─".repeat(66)}`);
}

async function send(
  wallet: WalletClient,
  publicClient: PublicClient,
  account: Account,
  call: { readonly address: Address; readonly abi: readonly unknown[]; readonly functionName: string; readonly args: readonly unknown[] },
  label: string,
): Promise<unknown> {
  let simulated: { readonly request: unknown; readonly result: unknown } | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      simulated = (await publicClient.simulateContract({
        address: call.address,
        abi: call.abi as never,
        functionName: call.functionName as never,
        args: call.args as never,
        account,
      })) as { request: unknown; result: unknown };
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      console.log(`  ${label}: simulation failed; retrying against the public RPC`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  if (simulated === undefined) throw lastError;
  const hash = await wallet.writeContract(simulated.request as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  console.log(`  ${label}\n    ${receipt.status} — ${hash}`);
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  return simulated.result;
}

async function main(): Promise<void> {
  const loaded = loadDotEnv();
  if (loaded.length > 0) console.log(`env       loaded ${loaded.length} values from .env`);

  const chainKey = required("ROUTELOCK_CHAIN");
  if (!chainKey.startsWith("botchain_")) {
    throw new Error(`compute:e2e requires a BOT Chain deployment, got ${chainKey}`);
  }
  const chain = getChain(chainKey);
  assertVerticalAllowed(chain, "compute");
  const deployment = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../deployments/${chainKey}.json`, import.meta.url)), "utf8"),
  ) as Deployment;
  if (deployment.chain !== chainKey || deployment.chainId !== chain.chainId) {
    throw new Error(`deployment metadata does not match ${chainKey}`);
  }

  const rpc = process.env[chain.rpcEnvVar] ?? chain.defaultRpc;
  const viemChain = {
    id: deployment.chainId,
    name: chain.name,
    nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  } as const;
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== chain.chainId) throw new Error(`RPC is chain ${liveChainId}, expected ${chain.chainId}`);

  const settlementToken = requireSettlementToken(chain) as Address;
  if (chain.settlement.kind !== "erc20") throw new Error(`BOT Chain settlement must be an ERC20`);
  if (settlementToken.toLowerCase() !== deployment.settlementToken.toLowerCase()) {
    throw new Error(`deployment settlement token differs from verified chain config`);
  }
  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ address: settlementToken, abi: ERC20_ABI, functionName: "symbol" }),
    publicClient.readContract({ address: settlementToken, abi: ERC20_ABI, functionName: "decimals" }),
  ]);
  if (symbol !== deployment.settlementSymbol || decimals !== chain.settlement.decimals) {
    throw new Error(`settlement token metadata changed: ${symbol}/${decimals}`);
  }
  console.log(`chain     ${chain.name} (${chain.chainId})`);
  console.log(`settlement ${symbol} (${decimals} decimals) ${settlementToken}`);

  const client = new AkashClient({
    baseUrl: required("AKASH_CONSOLE_API_URL"),
    apiKey: required("AKASH_API_KEY"),
  });
  const adapter = new AkashAdapter(chain, {
    client,
    bidPollMs: positiveInteger("AKASH_BID_POLL_MS"),
    bidTimeoutMs: positiveInteger("AKASH_BID_TIMEOUT_MS"),
    readinessPollMs: positiveInteger("AKASH_READY_POLL_MS"),
    readinessTimeoutMs: positiveInteger("AKASH_READY_TIMEOUT_MS"),
  });
  const label = required("ROUTELOCK_COMPUTE_CLASS_LABEL");
  const classId = keccak256(toHex(label));
  const providerAddress = process.env.AKASH_PROVIDER_ADDRESS?.trim() || undefined;
  const resumeDseq = process.env.AKASH_RESUME_DSEQ?.trim() || undefined;
  if (RESUME && resumeDseq === undefined && process.env.AKASH_RESUME_NEW_DEPLOYMENT !== "yes") {
    throw new Error(
      "--resume requires AKASH_RESUME_DSEQ for an existing Akash lease, or " +
        "AKASH_RESUME_NEW_DEPLOYMENT=yes after a pre-deployment failure",
    );
  }
  const commonOrder = {
    classId,
    sdl: readFileSync(required("AKASH_SDL_PATH"), "utf8"),
    workloadDescription: required("AKASH_WORKLOAD_DESCRIPTION"),
    serviceName: required("AKASH_SERVICE_NAME"),
    acceptableUsePolicyUrl: required("AKASH_ACCEPTABLE_USE_POLICY_URL"),
    depositUsd: positiveNumber("AKASH_DEPOSIT_USD"),
    ...(providerAddress === undefined ? {} : { providerAddress }),
    ...(resumeDseq === undefined ? {} : { deploymentDseq: resumeDseq }),
  } as const;
  if (commonOrder.sdl.trim() === "") throw new Error("AKASH_SDL_PATH contains an empty SDL");
  if (RESUME && resumeDseq === undefined) {
    console.log("  resume     no Akash DSEQ supplied; the approved on-chain entitlement will use a new Akash deployment");
  }
  if (resumeDseq === undefined) {
    const { balances } = await client.getBalances();
    const requiredCredits = Math.ceil(commonOrder.depositUsd * 1_000_000);
    if (balances.balance < requiredCredits) {
      const availableUsd = balances.balance / 1_000_000;
      const reservedUsd = balances.deployments / 1_000_000;
      const totalUsd = balances.total / 1_000_000;
      const shortfallUsd = (requiredCredits - balances.balance) / 1_000_000;
      throw new Error(
        `Akash Console credits are reserved: available ${availableUsd.toFixed(6)} USD, ` +
          `reserved by deployments ${reservedUsd.toFixed(6)} USD, total ${totalUsd.toFixed(6)} USD; ` +
          `this deployment requires ${commonOrder.depositUsd.toFixed(6)} USD and is short by ` +
          `${shortfallUsd.toFixed(6)} USD. Close an unused deployment or add the shortfall, ` +
          `then rerun. No BOT Chain transaction was attempted.`,
      );
    }
    console.log(
      `  Akash credits ${ (balances.balance / 1_000_000).toFixed(6) } USD available ` +
        `(${(balances.deployments / 1_000_000).toFixed(6)} USD reserved)`,
    );
  }

  const price = decimalAmount("ROUTELOCK_COMPUTE_PRICE", decimals);
  const collateral = decimalAmount("ROUTELOCK_COMPUTE_COLLATERAL", decimals);
  const payout = decimalAmount("ROUTELOCK_COMPUTE_PAYOUT", decimals);
  const maxSupply = positiveInteger("ROUTELOCK_COMPUTE_MAX_SUPPLY");
  if (maxSupply > 4_294_967_295) throw new Error("ROUTELOCK_COMPUTE_MAX_SUPPLY exceeds uint32");
  const validUntil = BigInt(required("ROUTELOCK_COMPUTE_VALID_UNTIL"));
  if (collateral < payout) throw new Error("ROUTELOCK_COMPUTE_COLLATERAL must cover ROUTELOCK_COMPUTE_PAYOUT");
  if (validUntil <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("ROUTELOCK_COMPUTE_VALID_UNTIL is in the past");

  const policyOrder = { ...commonOrder, entitlementTokenId: classId } satisfies AkashOrder;
  step(1, "Read the live Akash policy and rule on the supplied workload");
  const facts = await adapter.assess(policyOrder);
  const request: ComputePolicyRequest = {
    workloadDescription: facts.workloadDescription,
    serviceName: facts.serviceName,
    sdl: facts.sdl,
    deployerJurisdiction: required("AKASH_DEPLOYER_JURISDICTION"),
    lawfulUseConfirmation: required("AKASH_LAWFUL_USE_CONFIRMATION"),
    acceptableUsePolicyUrl: facts.policy.url,
    acceptableUsePolicy: facts.policy.text,
  };
  let decision: ReturnType<typeof buildComputeDecision> | undefined;
  if (RESUME) {
    console.log(`  resume     policy facts refreshed; reusing the existing Approved decision on BOT Chain`);
  } else {
    const budget = new InferenceBudget(
      process.env.ROUTELOCK_INFERENCE_LEDGER ?? "data/inference-calls.jsonl",
      {
        maxCalls: positiveInteger("ROUTELOCK_COMPUTE_MAX_MODEL_CALLS"),
        softLimitUsd: positiveNumber("ROUTELOCK_COMPUTE_MODEL_BUDGET_USD"),
      },
    );
    if (budget.callsRemaining < 1) throw new Error(`compute inference budget has no calls left: ${budget.summary()}`);
    const model = required("ROUTELOCK_LLM_MODEL");
    const proposal = await proposeComputePolicyWithRetry(request, {
      apiKey: required("ANTHROPIC_API_KEY"),
      model,
      budget,
    });
    decision = buildComputeDecision(request, proposal, model);
    console.log(`  service     ${request.serviceName}`);
    console.log(`  policy      ${request.acceptableUsePolicyUrl}`);
    console.log(`  prompt hash ${canonicalHash(buildComputePolicyPrompt(request))}`);
    console.log(`  confidence  ${proposal.confidence}`);
    console.log(`  VERDICT     ${VERDICT_NAMES[decision.verdict]} (${decision.ground.kind})`);
    if (proposal.policyConflicts.length > 0) {
      console.log(`  conflicts   ${proposal.policyConflicts.join(" | ")}`);
    }
    if (proposal.missingInformation.length > 0) {
      console.log(`  missing     ${proposal.missingInformation.join(" | ")}`);
    }
    console.log(`  cost        ${budget.summary()}`);

    // A non-approval is a complete, safe preflight outcome. Do not unlock any
    // chain key—or ask for a password—when no entitlement can be fulfilled.
    if (decision.verdict !== Verdict.Approved) {
      console.log(`  no signer unlock or chain transaction is needed for this verdict`);
      return;
    }
  }

  const complianceAccount = privateKeyToAccount(required("COMPLIANCE_PRIVATE_KEY") as `0x${string}`);
  if (complianceAccount.address.toLowerCase() !== deployment.compliance.toLowerCase()) {
    throw new Error(`COMPLIANCE_PRIVATE_KEY resolves to ${complianceAccount.address}, not deployment compliance ${deployment.compliance}`);
  }
  const ownerAccountName = process.env["ROUTELOCK_KEYSTORE_ACCOUNT"]?.trim() || "routelock-deployer";
  const owner = await unlockKeystoreAccount(ownerAccountName);
  if (owner.address.toLowerCase() !== deployment.admin.toLowerCase()) {
    throw new Error(`deployer key is ${owner.address}, not deployment admin ${deployment.admin}`);
  }
  if (owner.address.toLowerCase() === complianceAccount.address.toLowerCase()) {
    throw new Error("deployer and compliance signer are the same key");
  }
  const ownerWallet = createWalletClient({ account: owner, chain: viemChain, transport: http(rpc) });
  let oracle = owner;
  let oracleWallet = ownerWallet;
  if (deployment.oracle.toLowerCase() !== owner.address.toLowerCase()) {
    const oracleAccountName = process.env["ROUTELOCK_ORACLE_KEYSTORE_ACCOUNT"]?.trim() || "routelock-oracle";
    const unlocked = await unlockKeystoreAccount(oracleAccountName);
    if (unlocked.address.toLowerCase() !== deployment.oracle.toLowerCase()) {
      throw new Error(`oracle key is ${unlocked.address}, not deployment oracle ${deployment.oracle}`);
    }
    oracle = unlocked;
    oracleWallet = createWalletClient({ account: oracle, chain: viemChain, transport: http(rpc) });
  }
  const complianceWallet = createWalletClient({ account: complianceAccount, chain: viemChain, transport: http(rpc) });
  const oracleGas = await publicClient.getBalance({ address: oracle.address });
  if (oracleGas === 0n) throw new Error(`oracle ${oracle.address} has no native gas`);

  const ORACLE_ROLE = keccak256(toHex("ORACLE_ROLE"));
  const COMPLIANCE_ROLE = keccak256(toHex("COMPLIANCE_ROLE"));
  const registryOracle = await publicClient.readContract({
    address: deployment.activationRegistry,
    abi: ROLE_ABI,
    functionName: "hasRole",
    args: [ORACLE_ROLE, oracle.address],
  });
  const escrowOracle = await publicClient.readContract({
    address: deployment.settlementEscrow,
    abi: ESCROW_ABI,
    functionName: "hasRole",
    args: [ORACLE_ROLE, oracle.address],
  });
  const registryCompliance = await publicClient.readContract({
    address: deployment.activationRegistry,
    abi: ROLE_ABI,
    functionName: "hasRole",
    args: [COMPLIANCE_ROLE, complianceAccount.address],
  });
  const escrowCompliance = await publicClient.readContract({
    address: deployment.settlementEscrow,
    abi: ESCROW_ABI,
    functionName: "hasRole",
    args: [COMPLIANCE_ROLE, complianceAccount.address],
  });
  if (!registryOracle || !escrowOracle || !registryCompliance || escrowCompliance) {
    throw new Error(
      `role preflight failed: oracle registry=${registryOracle} escrow=${escrowOracle}; ` +
        `compliance registry=${registryCompliance} escrow=${escrowCompliance}`,
    );
  }
  console.log(`roles      oracle verified on registry/escrow; compliance verified only on registry`);

  const termsHash = canonicalHash({
    vertical: "compute",
    label,
    serviceName: commonOrder.serviceName,
    sdl: commonOrder.sdl,
    acceptableUsePolicyUrl: facts.policy.url,
    acceptableUsePolicyHash: canonicalHash(facts.policy.text),
  });
  const factory = deployment.entitlementFactory;
  const alreadyIssuer = await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "isRegisteredIssuer",
    args: [owner.address],
  });
  if (!alreadyIssuer) {
    await send(ownerWallet, publicClient, owner, { address: factory, abi: FACTORY_ABI, functionName: "registerIssuer", args: [owner.address] }, "registerIssuer");
  }
  const classExists = await publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: "classExists", args: [classId] });
  let postedCollateral = 0n;
  if (classExists) {
    if (!RESUME) throw new Error(`class label already exists on chain: ${label}; rerun with --resume to continue the interrupted run`);
    // A failed run may have created the class and posted collateral before a
    // later read failed. Resume that exact class after checking its escrow
    // identity instead of creating a duplicate or posting collateral twice.
    const existingEscrow = await publicClient.readContract({
      address: deployment.settlementEscrow,
      abi: ESCROW_ABI,
      functionName: "classEscrow",
      args: [classId],
    });
    if (existingEscrow[0].toLowerCase() !== owner.address.toLowerCase()) {
      throw new Error(`existing compute class ${label} belongs to ${existingEscrow[0]}, not the deployer`);
    }
    if (existingEscrow[1].toLowerCase() !== settlementToken.toLowerCase() || existingEscrow[2] !== payout || !existingEscrow[5]) {
      throw new Error(`existing compute class ${label} does not match the requested settlement escrow terms`);
    }
    postedCollateral = existingEscrow[3];
    console.log(`  resume     reusing class ${label}; collateral already posted ${Number(postedCollateral) / 10 ** decimals} ${symbol}`);
  } else {
    await send(ownerWallet, publicClient, owner, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: "createClass",
      args: [classId, termsHash, settlementToken, price, payout, validUntil, maxSupply],
    }, `create compute class ${label}`);
  }
  if (postedCollateral > collateral) {
    throw new Error(`existing compute class has ${Number(postedCollateral) / 10 ** decimals} ${symbol} collateral, above requested ${Number(collateral) / 10 ** decimals}`);
  }
  const collateralToPost = collateral - postedCollateral;
  // In resume mode the entitlement price was already paid when the existing
  // token was minted. Only any still-missing collateral may be needed; do not
  // demand the price a second time from the issuer wallet.
  const requiredOnChain = (RESUME ? 0n : price) + collateralToPost;
  const balance = await publicClient.readContract({
    address: settlementToken,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner.address],
  });
  if (balance < requiredOnChain) {
    throw new Error(`deployer needs ${Number(requiredOnChain) / 10 ** decimals} ${symbol}, has ${Number(balance) / 10 ** decimals}`);
  }
  console.log(`budget     ${Number(requiredOnChain) / 10 ** decimals} ${symbol} on-chain input; Akash deposit ${commonOrder.depositUsd}`);

  step(2, "Open the on-chain compute entitlement");
  if (requiredOnChain > 0n) {
    await send(ownerWallet, publicClient, owner, {
      address: settlementToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [deployment.settlementEscrow, requiredOnChain],
    }, `approve escrow for ${Number(requiredOnChain) / 10 ** decimals} ${symbol}`);
  } else {
    console.log(`  payment      skipped — existing entitlement already paid`);
  }
  if (collateralToPost > 0n) {
    await send(ownerWallet, publicClient, owner, {
      address: deployment.settlementEscrow,
      abi: ESCROW_ABI,
      functionName: "postCollateral",
      args: [classId, collateralToPost],
    }, `postCollateral ${Number(collateralToPost) / 10 ** decimals} ${symbol}`);
  } else {
    console.log(`  postCollateral skipped — requested backing is already held`);
  }
  let tokenId: bigint | undefined;
  let existingActivation: Awaited<ReturnType<ActivationRegistryClient["read"]>> | undefined;
  if (RESUME) {
    const minted = await publicClient.readContract({ address: deployment.serviceEntitlement, abi: DEPLOYMENT_ABI, functionName: "totalMinted" });
    for (let candidate = 1n; candidate <= minted; candidate += 1n) {
      const candidateClass = await publicClient.readContract({ address: deployment.serviceEntitlement, abi: DEPLOYMENT_ABI, functionName: "classOf", args: [candidate] });
      if (candidateClass.toLowerCase() !== classId.toLowerCase()) continue;
      const candidateOwner = await publicClient.readContract({ address: deployment.serviceEntitlement, abi: DEPLOYMENT_ABI, functionName: "ownerOf", args: [candidate] });
      if (candidateOwner.toLowerCase() === owner.address.toLowerCase()) {
        tokenId = candidate;
        break;
      }
    }
    if (tokenId === undefined) throw new Error(`--resume could not find an entitlement for class ${label}`);
    const readRegistry = new ActivationRegistryClient(publicClient, {
      registry: deployment.activationRegistry,
      entitlement: deployment.serviceEntitlement,
    });
    existingActivation = await readRegistry.read(tokenId);
    const tokenState = await readRegistry.stateOf(tokenId);
    if (tokenState !== 3 || existingActivation.verdict !== Verdict.Approved) {
      throw new Error(`--resume requires an Activated, Approved entitlement; token ${tokenId} is state ${tokenState}, verdict ${existingActivation.verdict}`);
    }
    if (existingActivation.carrierRefHash !== `0x${"0".repeat(64)}` || existingActivation.carrierRawHash !== `0x${"0".repeat(64)}`) {
      throw new Error(`--resume found provider evidence already recorded for token ${tokenId}`);
    }
    console.log(`  resume     using existing Activated entitlement ${tokenId}`);
  } else {
    const mintedBefore = await publicClient.readContract({ address: deployment.serviceEntitlement, abi: DEPLOYMENT_ABI, functionName: "totalMinted" });
    await send(ownerWallet, publicClient, owner, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: "mint",
      args: [classId, owner.address],
    }, `mint compute entitlement at ${Number(price) / 10 ** decimals} ${symbol}`);
    const mintedAfter = await publicClient.readContract({ address: deployment.serviceEntitlement, abi: DEPLOYMENT_ABI, functionName: "totalMinted" });
    if (mintedAfter !== mintedBefore + 1n) throw new Error(`totalMinted moved from ${mintedBefore} to ${mintedAfter}, not by one`);
    tokenId = mintedAfter;
  }
  if (tokenId === undefined) throw new Error(`compute entitlement token was not resolved`);
  const order: AkashOrder = { ...commonOrder, entitlementTokenId: tokenId.toString(), classId };
  const tokenOwner = await publicClient.readContract({ address: deployment.serviceEntitlement, abi: DEPLOYMENT_ABI, functionName: "ownerOf", args: [tokenId] });
  if (tokenOwner.toLowerCase() !== owner.address.toLowerCase()) throw new Error(`token ${tokenId} owner is ${tokenOwner}, not deployer`);
  console.log(`  tokenId    ${tokenId}`);

  step(3, "Commit the compute work and compliance decision on BOT Chain");
  const registry = new ActivationRegistryClient(publicClient, {
    registry: deployment.activationRegistry,
    entitlement: deployment.serviceEntitlement,
  }, ownerWallet);
  const oracleRegistry = new ActivationRegistryClient(publicClient, {
    registry: deployment.activationRegistry,
    entitlement: deployment.serviceEntitlement,
  }, oracleWallet);
  const decisionHash = existingActivation?.decisionHash ?? canonicalHash(decision!);
  const attestation = attest({
    vertical: "compute",
    decisionHash,
    work: {
      workloadDescription: order.workloadDescription,
      serviceName: order.serviceName,
      sdl: order.sdl,
      providerAddress: order.providerAddress ?? null,
    },
    evidence: {
      policy: facts.policy,
      workloadDescription: facts.workloadDescription,
      serviceName: facts.serviceName,
      sdl: facts.sdl,
    },
  });
  const fields = registryFields(attestation);
  if (RESUME) {
    console.log(`  decision   reusing ${VERDICT_NAMES[existingActivation!.verdict]} — ${fields.decisionHash}`);
  } else {
    await registry.submitParcel(tokenId, attestation);
    await new ActivationRegistryClient(publicClient, {
      registry: deployment.activationRegistry,
      entitlement: deployment.serviceEntitlement,
    }, complianceWallet).recordDecision(tokenId, fields.decisionHash, COMPUTE_ENGINE_VERSION, decision!.verdict);
    console.log(`  decision   ${VERDICT_NAMES[decision!.verdict]} — ${fields.decisionHash}`);
  }

  const approved = RESUME ? approveCommitted(order, decisionHash) : approve(order, decision!);
  if (approved === null || approved.decisionHash !== fields.decisionHash) {
    throw new Error(`approved decision hash does not match the on-chain commitment`);
  }

  step(4, "Create the real Akash deployment, accept a live bid, and verify ingress");
  const receipt = await adapter.fulfil(approved);
  const providerCheck = await adapter.verify(receipt.ref);
  if (!providerCheck.found || providerCheck.proofUrl !== receipt.proofUrl) {
    throw new Error(`Akash receipt did not re-verify live: ${JSON.stringify(providerCheck)}`);
  }
  console.log(`  lease      ${receipt.ref}`);
  console.log(`  price      ${receipt.amountCharged} ${receipt.currency}`);
  console.log(`  proof      ${receipt.proofUrl}`);

  step(5, "Commit provider evidence and settle the BOT Chain escrow");
  const witnessed = witness(attestation, receipt);
  const finalFields = registryFields(witnessed);
  await oracleRegistry.recordCarrier(tokenId, witnessed);
  await send(oracleWallet, publicClient, oracle, {
    address: deployment.settlementEscrow,
    abi: ESCROW_ABI,
    functionName: "releaseToIssuer",
    args: [tokenId],
  }, `releaseToIssuer(${tokenId})`);
  // The public BOT RPC is load-balanced. A read immediately after a confirmed
  // write can still come from a node that has not seen the release. This is a
  // money path: a transient zero must never be treated as no money owed.
  let claimable = 0n;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    claimable = await publicClient.readContract({
      address: deployment.settlementEscrow,
      abi: ESCROW_ABI,
      functionName: "claimable",
      args: [owner.address, settlementToken],
    });
    if (claimable >= price) break;
    console.log(`  claimable reads ${Number(claimable) / 10 ** decimals} ${symbol}; node may be behind, retrying`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
  }
  if (claimable < price) {
    throw new Error(
      `release succeeded but expected at least ${Number(price) / 10 ** decimals} ${symbol} ` +
        `is not claimable; run pnpm --filter @routelock/attest recover --broadcast`,
    );
  }
  await send(ownerWallet, publicClient, owner, {
    address: deployment.settlementEscrow,
    abi: ESCROW_ABI,
    functionName: "claim",
    args: [settlementToken],
  }, `claim ${Number(claimable) / 10 ** decimals} ${symbol}`);
  let escrow = await publicClient.readContract({ address: deployment.settlementEscrow, abi: ESCROW_ABI, functionName: "classEscrow", args: [classId] });
  for (let attempt = 0; attempt < 5 && escrow[4] !== 0n; attempt += 1) {
    console.log(`  class obligation still reads ${Number(escrow[4]) / 10 ** decimals} ${symbol}; node may be behind, retrying`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    escrow = await publicClient.readContract({ address: deployment.settlementEscrow, abi: ESCROW_ABI, functionName: "classEscrow", args: [classId] });
  }
  const collateralOnChain = escrow[3];
  const obligationOnChain = escrow[4];
  if (obligationOnChain !== 0n) {
    throw new Error(
      `provider settlement succeeded but class obligation still reads ${Number(obligationOnChain) / 10 ** decimals} ${symbol}; ` +
        `run pnpm --filter @routelock/attest recover --broadcast`,
    );
  }
  if (collateralOnChain > obligationOnChain) {
    await send(ownerWallet, publicClient, owner, {
      address: deployment.settlementEscrow,
      abi: ESCROW_ABI,
      functionName: "withdrawCollateral",
      args: [classId, collateralOnChain - obligationOnChain],
    }, `withdraw collateral ${Number(collateralOnChain - obligationOnChain) / 10 ** decimals} ${symbol}`);
  }

  const onChain = await registry.read(tokenId);
  if (
    (!RESUME && (onChain.parcelHash !== fields.parcelHash || onChain.documentsHash !== fields.documentsHash)) ||
    onChain.decisionHash !== fields.decisionHash ||
    onChain.carrierRefHash !== finalFields.carrierRefHash ||
    onChain.carrierRawHash !== finalFields.carrierRawHash
  ) throw new Error("BOT Chain activation record does not match the published compute evidence");
  const settled = await publicClient.readContract({ address: deployment.settlementEscrow, abi: ESCROW_ABI, functionName: "classEscrow", args: [classId] });
  let escrowBalance = await publicClient.readContract({ address: settlementToken, abi: ERC20_ABI, functionName: "balanceOf", args: [deployment.settlementEscrow] });
  for (let attempt = 0; attempt < 5 && escrowBalance !== 0n; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    escrowBalance = await publicClient.readContract({ address: settlementToken, abi: ERC20_ABI, functionName: "balanceOf", args: [deployment.settlementEscrow] });
  }
  if (settled[4] !== 0n || escrowBalance !== 0n) throw new Error(`escrow is not empty after settlement: obligation=${settled[4]} balance=${escrowBalance}`);
  const verifiedAgain = await adapter.verify(receipt.ref);
  if (!verifiedAgain.found) throw new Error("Akash proof stopped verifying after BOT Chain settlement");

  console.log(
    `\n${"═".repeat(66)}\nCOMPLETE. A real Akash compute lease was accepted from a live bid,\n` +
      `its live ingress was re-verified, and BOT Chain committed the provider\n` +
      `evidence before settling the entitlement.\n` +
      `Check the live proof: ${receipt.proofUrl}\n${"═".repeat(66)}`,
  );
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
