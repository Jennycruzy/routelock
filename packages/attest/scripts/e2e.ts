/// The whole system, once, against real chains and a real model.
///
/// Register an issuer, create a class, post collateral, mint an entitlement,
/// bind the work, rule on it with the compliance engine, and — only if the
/// engine approves — retire a real carbon credit and record the provider's
/// evidence on chain.
///
/// **Dry run by default.** Every step is simulated and nothing is sent unless
/// `--broadcast` is passed. The retirement carries a second, independent gate
/// on top of that (`ROUTELOCK_X402_ALLOW_LIVE_RETIREMENT`), because a testnet
/// obligation discharged with a real credit is irreversible.
///
///   pnpm --filter @routelock/attest e2e              # simulate, spend nothing
///   pnpm --filter @routelock/attest e2e --broadcast  # real transactions
///
/// Two signers are needed and they are deliberately different keys:
///   • the deployer/admin/oracle/issuer/buyer, from the Foundry keystore
///   • the compliance service, from COMPLIANCE_PRIVATE_KEY
/// The escrow structurally refuses to grant the compliance key authority over
/// funds, so the second signer can open the activation gate and can never move
/// money. Running them as one key would erase the property the whole pitch
/// rests on.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseUnits,
  toHex,
} from "viem";
import type { Account, Address, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CarbonmarkX402Adapter, RetirementLedger, capsFromEnv as retirementCaps } from "@routelock/carbon";
import { getChain } from "@routelock/chain";
import {
  budgetCapsFromEnv,
  decideCarbon,
  InferenceBudget,
  proposeCarbonQuality,
  Verdict,
  VERDICT_NAMES,
  CARBON_ENGINE_VERSION,
} from "@routelock/compliance";
import type { CarbonQualityRequest } from "@routelock/compliance";
import { approve, canonicalHash } from "@routelock/compliance";

import { ledgerPath } from "@routelock/compliance";
import { attest, registryFields, witness } from "../src/attestation.ts";
import { ActivationRegistryClient } from "../src/registry.ts";
import { unlockKeystoreAccount } from "./keystore.ts";
import { makeRetirementSigner } from "../src/signer.ts";
import { loadDotEnv } from "./env.ts";

/// Three modes, and the difference matters.
///
/// **dry run** (default) simulates each call against live chain state. It
/// proves the arguments encode and the caller holds the role, but it cannot
/// get past the first state-changing step: nothing is executed, so step 2 sees
/// the world step 1 never changed. Expect it to stop at `createClass` with
/// `IssuerNotRegistered` — that is the mode working, not failing.
///
/// **--fork** runs the entire sequence for real against a local fork of the
/// chain. State accumulates, so every step is genuinely exercised. Costs no
/// gas, touches no real deployment, and needs no private key — accounts are
/// impersonated. This is the rehearsal that actually proves the flow.
///
/// **--broadcast** sends real transactions to the real chain.
const BROADCAST = process.argv.includes("--broadcast");
const FORK = process.argv.includes("--fork");
/// Retiring is opt-in on top of --broadcast, because it is the only step with
/// no undo. The flag sets the adapter's own env guard rather than replacing it:
/// `assertKeylessSpendAllowed` stays the thing that actually blocks, and this
/// is just a way to say yes to it that cannot be lost to a line wrap.
const RETIRE = process.argv.includes("--retire");
if (RETIRE) process.env.ROUTELOCK_X402_ALLOW_LIVE_RETIREMENT = "yes-retire-for-real";
/// A fork executes for real, just against a throwaway chain.
const EXECUTES = BROADCAST || FORK;

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
] as const;

const FACTORY_ABI = [
  { type: "function", name: "registerIssuer", stateMutability: "nonpayable",
    inputs: [{ name: "issuer", type: "address" }], outputs: [] },
  { type: "function", name: "isRegisteredIssuer", stateMutability: "view",
    inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "createClass", stateMutability: "nonpayable",
    inputs: [
      { name: "classId", type: "bytes32" }, { name: "termsHash", type: "bytes32" },
      { name: "settlementToken", type: "address" }, { name: "pricePerUnit", type: "uint256" },
      { name: "payoutObligation", type: "uint256" }, { name: "validUntil", type: "uint64" },
      { name: "maxSupply", type: "uint32" }], outputs: [] },
  { type: "function", name: "classExists", stateMutability: "view",
    inputs: [{ name: "classId", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ name: "classId", type: "bytes32" }, { name: "to", type: "address" }],
    outputs: [{ name: "tokenId", type: "uint256" }] },
] as const;

const ESCROW_ABI = [
  { type: "function", name: "postCollateral", stateMutability: "nonpayable",
    inputs: [{ name: "classId", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

interface Deployment {
  readonly activationRegistry: Address;
  readonly serviceEntitlement: Address;
  readonly entitlementFactory: Address;
  readonly settlementEscrow: Address;
  readonly settlementToken: Address;
  readonly chainId: number;
}

/// Sized against the faucet: 10 USD₮0 per claim is the ceiling, so a run must
/// cost well under that or a second run needs a second claim.
///
/// Overridable because the faucet's per-address cooldown is the real constraint,
/// not the balance. A rehearsal that has already burned a claim can still run at
/// a tenth of these figures on the change left over:
///
///   ROUTELOCK_PRICE=0.1 ROUTELOCK_COLLATERAL=0.2 ROUTELOCK_PAYOUT=0.1
///
/// The amounts are denominated in whole USD₮0 and are arbitrary on testnet — the
/// escrow only cares that collateral covers the obligation after the mint
/// (`SettlementEscrow.sol:143`), which any uniform scaling preserves. Nothing
/// about the mechanism changes; only the denomination does.
function usd(envVar: string, fallback: string): bigint {
  const raw = process.env[envVar];
  if (raw === undefined) return parseUnits(fallback, 6);
  const parsed = parseUnits(raw, 6);
  if (parsed <= 0n) throw new Error(`${envVar} must be greater than zero, got ${raw}`);
  return parsed;
}

const PRICE = usd("ROUTELOCK_PRICE", "1");
const COLLATERAL = usd("ROUTELOCK_COLLATERAL", "2");
const PAYOUT_OBLIGATION = usd("ROUTELOCK_PAYOUT", "1");
const MAX_SUPPLY = 5;

// Fail here rather than at the mint, where it costs a broadcast to learn it.
if (COLLATERAL < PAYOUT_OBLIGATION) {
  throw new Error(
    `collateral ${Number(COLLATERAL) / 1e6} does not cover the payout obligation ` +
      `${Number(PAYOUT_OBLIGATION) / 1e6} — the escrow will refuse the mint`,
  );
}

function step(n: number, title: string): void {
  console.log(`\n${"─".repeat(66)}\n${n}. ${title}\n${"─".repeat(66)}`);
}

async function send(
  wallet: WalletClient,
  publicClient: PublicClient,
  account: Account,
  call: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] },
  label: string,
): Promise<unknown> {
  // Simulate first, always. It surfaces a revert reason without spending gas
  // and catches a role the caller does not hold before a transaction exists.
  //
  // Retried, because a public RPC behind a load balancer will happily confirm
  // a receipt on one node and then simulate against another that has not seen
  // that block yet. That produced a real failure here: `approve` was mined and
  // confirmed, and the very next `postCollateral` simulation reverted with
  // ERC20InsufficientAllowance while the allowance was already 3 USD₮0 on
  // chain. A genuine revert still fails — it just fails a few seconds later.
  let simulated: { request: unknown; result: unknown } | undefined;
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
      console.log(`  ${label}: simulation failed, node may be behind — retrying`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  if (simulated === undefined) throw lastError;
  const { request, result } = simulated as { request: never; result: unknown };

  if (!EXECUTES) {
    const data = encodeFunctionData({
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as Parameters<typeof encodeFunctionData>[0]);
    console.log(`  ${label}`);
    console.log(`    simulated OK — would send ${data.slice(0, 10)} to ${call.address}`);
    return result;
  }

  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  console.log(`  ${label}`);
  console.log(`    ${receipt.status} — ${hash}`);
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  return result;
}

async function main(): Promise<void> {
  const loaded = loadDotEnv();
  if (loaded.length > 0) console.log(`env       loaded ${loaded.length} values from .env`);

  const chainKey = process.env.ROUTELOCK_CHAIN ?? "xlayer_testnet";
  const chain = getChain(chainKey);
  const deployment = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../deployments/${chainKey}.json`, import.meta.url)), "utf8"),
  ) as Deployment;

  const upstream = process.env[chain.rpcEnvVar] ?? chain.defaultRpc;
  const rpc = FORK ? (process.env.ROUTELOCK_FORK_RPC ?? "http://127.0.0.1:8545") : upstream;

  // viem needs a chain descriptor to build a transaction. Built from the
  // project's own verified config rather than a chain-directory package —
  // those are exactly where the stale id 195 comes from.
  const viemChain = {
    id: deployment.chainId,
    name: chain.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  } as const;

  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });

  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== deployment.chainId) {
    throw new Error(`${rpc} is chain ${liveChainId}, deployment is for ${deployment.chainId}`);
  }

  console.log(`chain     ${chain.name} (${liveChainId})`);
  console.log(
    `mode      ${
      FORK
        ? `FORK — real execution against ${rpc}, no gas, no real state`
        : BROADCAST
          ? "BROADCAST — real transactions on the real chain"
          : "DRY RUN — simulate only, nothing sent"
    }`,
  );

  // ---- signers -----------------------------------------------------------
  step(0, "Signers");

  const compliancePk = process.env.COMPLIANCE_PRIVATE_KEY;
  if (!compliancePk) throw new Error("COMPLIANCE_PRIVATE_KEY is not set");
  const complianceAccount = privateKeyToAccount(compliancePk as `0x${string}`);

  console.log(`  compliance  ${complianceAccount.address} (from COMPLIANCE_PRIVATE_KEY)`);

  // A dry run simulates from an address; it never signs. Unlocking the
  // keystore for it would demand a password to accomplish nothing, and would
  // make the safe mode the inconvenient one — which is how people end up
  // running --broadcast to avoid a prompt.
  let owner: Account;
  if (FORK) {
    const admin = (process.env.ROUTELOCK_ADMIN ?? "") as Address;
    if (!admin) throw new Error("ROUTELOCK_ADMIN is not set");
    // A fork lets us act as the real admin without holding its key. That is
    // the point: the rehearsal needs no secret, so it is safe to run in CI.
    for (const who of [admin, complianceAccount.address]) {
      await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_impersonateAccount", params: [who] }),
      });
      await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "anvil_setBalance",
          params: [who, "0xde0b6b3a7640000"],
        }),
      });
    }
    owner = { address: admin, type: "json-rpc" } as Account;
    console.log(`  deployer    ${admin} (impersonated on the fork — no key needed)`);
  } else if (BROADCAST) {
    console.log(`  deployer    unlocking Foundry keystore — password prompt follows`);
    owner = await unlockKeystoreAccount(process.env.ROUTELOCK_KEYSTORE_ACCOUNT ?? "routelock-deployer");
  } else {
    const admin = process.env.ROUTELOCK_ADMIN;
    if (!admin) throw new Error("ROUTELOCK_ADMIN is not set — needed to simulate from");
    owner = { address: admin as Address, type: "json-rpc" } as Account;
    console.log(`  deployer    ${admin} (address only — a dry run needs no key)`);
  }
  console.log(`  role        issuer, buyer, admin, oracle`);

  if (owner.address.toLowerCase() === complianceAccount.address.toLowerCase()) {
    throw new Error(
      "the compliance signer and the owner are the same key — that erases the " +
        "separation the escrow's COMPLIANCE_ROLE refusal exists to enforce",
    );
  }

  const ownerWallet = createWalletClient({ account: owner, chain: viemChain, transport: http(rpc) });
  const complianceWallet = createWalletClient({
    account: FORK ? ({ address: complianceAccount.address, type: "json-rpc" } as Account) : complianceAccount,
    chain: viemChain,
    transport: http(rpc),
  });

  const balance = await publicClient.readContract({
    address: deployment.settlementToken, abi: ERC20_ABI, functionName: "balanceOf", args: [owner.address],
  });
  console.log(`  USD₮0       ${Number(balance) / 1e6}`);
  console.log(
    `  run cost    ${Number(PRICE + COLLATERAL) / 1e6} ` +
      `(price ${Number(PRICE) / 1e6} + collateral ${Number(COLLATERAL) / 1e6})`,
  );
  if (balance < PRICE + COLLATERAL) {
    throw new Error(
      `need ${Number(PRICE + COLLATERAL) / 1e6} USD₮0, have ${Number(balance) / 1e6}. ` +
        `Claim from the faucet, or run cheaper — ROUTELOCK_PRICE / ROUTELOCK_COLLATERAL / ` +
        `ROUTELOCK_PAYOUT scale the run down without changing what it proves.`,
    );
  }

  // ---- issuance ----------------------------------------------------------
  // Resume an entitlement that already exists and is already under review.
  // Each full run locks 3 USD₮0 into escrow, and testnet USD₮0 comes from a
  // rate-limited faucet — so re-running from the top after a late failure
  // burns supply to redo work the chain already has.
  let minted: unknown;
  const resumeToken = process.env.ROUTELOCK_RESUME_TOKEN;
  if (resumeToken !== undefined) {
    console.log(`\n  resuming token ${resumeToken} — skipping issuance and submission`);
  }

  // The label is opaque to the contracts — they store keccak256 of it and never
  // parse it. Nothing about carbon can be read back out of a classId.
  //
  // Declared out here, not inside the issuance block below: step 5 builds the
  // order from classId, so a block-scoped const is a ReferenceError on every
  // run that gets that far. Resuming needs the label of the class the token was
  // actually minted under — a fresh Date.now() label would hash to a class that
  // does not hold the token.
  if (resumeToken !== undefined && process.env.ROUTELOCK_CLASS_LABEL === undefined) {
    throw new Error(
      "resuming requires ROUTELOCK_CLASS_LABEL — the label token " +
        `${resumeToken} was minted under. Without it the run computes a ` +
        "different classId and binds the decision to the wrong class.",
    );
  }
  const label = process.env.ROUTELOCK_CLASS_LABEL ?? `carbon-retirement-0.001t-${Date.now()}`;
  const classId = keccak256(toHex(label));
  const termsHash = keccak256(toHex(`RouteLock carbon retirement terms v1 :: ${label}`));
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);

  if (resumeToken === undefined) {
  step(1, "Register the issuer");
  const alreadyIssuer = await publicClient.readContract({
    address: deployment.entitlementFactory, abi: FACTORY_ABI,
    functionName: "isRegisteredIssuer", args: [owner.address],
  });
  if (alreadyIssuer) {
    console.log(`  already registered — nothing to do`);
  } else {
    await send(ownerWallet, publicClient, owner, {
      address: deployment.entitlementFactory, abi: FACTORY_ABI,
      functionName: "registerIssuer", args: [owner.address],
    }, "registerIssuer");
  }

  step(2, "Create the class");
  console.log(`  label       ${label}`);
  console.log(`  classId     ${classId}`);

  const exists = await publicClient.readContract({
    address: deployment.entitlementFactory, abi: FACTORY_ABI, functionName: "classExists", args: [classId],
  });
  if (exists) {
    console.log(`  class already exists — reusing`);
  } else {
    await send(ownerWallet, publicClient, owner, {
      address: deployment.entitlementFactory, abi: FACTORY_ABI, functionName: "createClass",
      args: [classId, termsHash, deployment.settlementToken, PRICE, PAYOUT_OBLIGATION, validUntil, MAX_SUPPLY],
    }, "createClass");
  }

  step(3, "Post collateral — before any entitlement can exist");
  await send(ownerWallet, publicClient, owner, {
    address: deployment.settlementToken, abi: ERC20_ABI, functionName: "approve",
    args: [deployment.settlementEscrow, COLLATERAL + PRICE],
  }, `approve escrow for ${Number(COLLATERAL + PRICE) / 1e6} USD₮0`);

  await send(ownerWallet, publicClient, owner, {
    address: deployment.settlementEscrow, abi: ESCROW_ABI, functionName: "postCollateral",
    args: [classId, COLLATERAL],
  }, `postCollateral ${Number(COLLATERAL) / 1e6} USD₮0`);

  step(4, "Mint the entitlement — the buyer's payment goes to escrow, not the issuer");
  // The factory returns the id it minted. Reading it back beats assuming the
  // first token is 1 — a second run on the same deployment mints 2, and a
  // hardcoded id silently binds the wrong entitlement.
  minted = await send(ownerWallet, publicClient, owner, {
    address: deployment.entitlementFactory, abi: FACTORY_ABI, functionName: "mint",
    args: [classId, owner.address],
  }, `mint (price ${Number(PRICE) / 1e6} USD₮0 into escrow)`);

  }

  if (!EXECUTES) {
    console.log(
      `\n${"═".repeat(66)}\nDRY RUN COMPLETE. Every step simulated without reverting.\n` +
        `Nothing was sent, no credit retired, no inference spent.\nRe-run with --broadcast to execute.\n${"═".repeat(66)}`,
    );
    return;
  }

  // From here the entitlement exists on chain.
  let tokenId: bigint;
  if (resumeToken !== undefined) {
    tokenId = BigInt(resumeToken);
  } else {
    if (typeof minted !== "bigint") throw new Error(`mint did not return a token id: ${String(minted)}`);
    tokenId = minted;
  }
  console.log(`  tokenId     ${tokenId}`);

  // ---- assessment and ruling ---------------------------------------------
  step(5, "Assess the credit — deterministic facts, no model");
  const carbon = new CarbonmarkX402Adapter(chain, {
    ledger: new RetirementLedger(ledgerPath("data/retirements.jsonl"), retirementCaps()),
    sign: async () => {
      throw new Error("signing is wired separately; this run does not sign yet");
    },
  });

  const classes = await carbon.discover();
  // Selectable, because the engine refuses some classes on purpose and a run
  // that always picks the first one can only ever exercise one outcome.
  const wanted = process.env.ROUTELOCK_CARBON_CLASS;
  const candidate =
    wanted !== undefined
      ? classes.find((c) => c.carbonClassId.toLowerCase() === wanted.toLowerCase())
      : classes.find((c) => c.priceUsdcPerTonne !== null && c.name !== null);
  if (candidate === undefined) {
    throw new Error(
      wanted !== undefined
        ? `class ${wanted} is not in live inventory`
        : "no identifiable class in live inventory",
    );
  }

  const tonnes = Number(process.env.ROUTELOCK_SMOKE_TONNES ?? 0.001);
  const order = {
    entitlementTokenId: tokenId.toString(),
    classId,
    carbonClass: candidate.carbonClassId,
    tonnes,
    from: owner.address,
    beneficiaryAddress: owner.address,
    beneficiaryString: "RouteLock entitlement holder",
    retirementMessage: `RouteLock entitlement ${tokenId}`,
  };
  const facts = await carbon.assess(order);
  console.log(`  ${facts.name} — ${facts.registries.join(", ")}, oldest vintage ${facts.oldestVintageAgeYears}y`);

  step(6, "Rule on it — the model proposes, deterministic code decides");
  const budget = new InferenceBudget(
    process.env.ROUTELOCK_INFERENCE_LEDGER ?? "data/inference-calls.jsonl",
    budgetCapsFromEnv(),
  );
  const request: CarbonQualityRequest = {
    carbonClass: facts.carbonClass, name: facts.name, category: facts.category,
    country: facts.country, methodologies: facts.methodologies, registries: facts.registries,
    projectIds: facts.projectIds, vintages: facts.vintages, oldestVintage: facts.oldestVintage,
    oldestVintageAgeYears: facts.oldestVintageAgeYears, isRegistered: facts.isRegistered,
    liquidityTonnes: facts.liquidityTonnes, insufficientLiquidity: facts.insufficientLiquidity,
    identityUnknown: facts.identityUnknown, tonnesRequested: tonnes,
  };

  const { proposal } = await proposeCarbonQuality(request, {
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: process.env.ROUTELOCK_LLM_MODEL!,
    budget,
  });
  const { verdict, ground } = decideCarbon(request, proposal);
  console.log(`  confidence  ${proposal.confidence}`);
  console.log(`  VERDICT     ${VERDICT_NAMES[verdict]} (${ground.kind})`);
  console.log(`  cost        ${budget.summary()}`);

  const decision = {
    engineVersion: CARBON_ENGINE_VERSION, model: process.env.ROUTELOCK_LLM_MODEL!,
    request, proposal, verdict, ground, irreversible: true as const,
  };

  step(7, "Bind the work and commit the decision on X Layer");
  const registry = new ActivationRegistryClient(publicClient, {
    registry: deployment.activationRegistry, entitlement: deployment.serviceEntitlement,
  }, ownerWallet);

  // The hash commits to the decision whatever the verdict was — a refusal is
  // recorded exactly as an approval is. `approve()` is used further down, and
  // only there: it gates spending money, not writing the record.
  const attestation = attest({
    vertical: "carbon",
    decisionHash: canonicalHash(decision),
    work: { carbonClass: order.carbonClass, tonnes, beneficiary: order.beneficiaryString },
    evidence: { registries: facts.registries, vintages: facts.vintages, methodologies: facts.methodologies },
  });

  const fields = registryFields(attestation);
  console.log(`  parcelHash     ${fields.parcelHash}`);
  console.log(`  documentsHash  ${fields.documentsHash}`);
  console.log(`  decisionHash   ${fields.decisionHash}`);

  if (resumeToken === undefined) {
    console.log(`\n  submitParcel (token holder)…`);
    await registry.submitParcel(tokenId, attestation);
  } else {
    // Already submitted. Confirm the chain holds the same work spec — resuming
    // against a different one would record a decision about work nobody bound.
    const onChain = await registry.read(tokenId);
    if (onChain.parcelHash !== fields.parcelHash) {
      throw new Error(
        `token ${tokenId} was submitted with parcelHash ${onChain.parcelHash}, ` +
          `but this run computed ${fields.parcelHash} — refusing to rule on ` +
          `work the chain did not record`,
      );
    }
    console.log(`\n  submitParcel already recorded, parcelHash matches`);
  }

  console.log(`  recordDecision (COMPLIANCE_ROLE — a different key)…`);
  const complianceRegistry = new ActivationRegistryClient(publicClient, {
    registry: deployment.activationRegistry, entitlement: deployment.serviceEntitlement,
  }, complianceWallet);
  await complianceRegistry.recordDecision(tokenId, fields.decisionHash, CARBON_ENGINE_VERSION, verdict);
  console.log(`    committed — ${VERDICT_NAMES[verdict]} is now on chain`);

  if (verdict !== Verdict.Approved) {
    console.log(
      `\n${"═".repeat(66)}\nThe engine did not approve, and that is a completed run.\n` +
        `The refusal is committed on chain exactly as an approval would be, the\n` +
        `entitlement is reusable, and the buyer's funds never moved.\n${"═".repeat(66)}`,
    );
    return;
  }

  step(8, "Retire the credit — REAL, IRREVERSIBLE");

  if (!BROADCAST) {
    console.log(`  fork mode does not retire: the credit and the USDC are real on Base.`);
    console.log(`  Approved order is ready. Run with --broadcast to retire.`);
    return;
  }
  if (!RETIRE) {
    console.log(`  not retiring: pass --retire to burn a real credit.`);
    console.log(`  Everything up to the signature is done. Nothing was retired.`);
    return;
  }
  // Only here does the compile-time gate matter: `fulfil()` accepts nothing
  // but an `Approved`, so unapproved work cannot reach a provider.
  const approved = approve(order, decision);
  if (approved === null) throw new Error("unreachable: verdict is Approved but approve() refused");
  // The value that authorised the spend and the value already written on chain
  // must be the same bytes. Produced at two call sites, so checked, not assumed.
  if (approved.decisionHash !== fields.decisionHash) {
    throw new Error(
      `decision hash mismatch: committed ${fields.decisionHash}, ` +
        `authorising ${approved.decisionHash} — refusing to fulfil against a ` +
        `decision other than the one on chain`,
    );
  }
  console.log(`  approved order ready — decisionHash ${approved.decisionHash}`);

  // A signer that will not exceed a ceiling read here, at the call site, on top
  // of the adapter's own caps. The one action with no undo gets two locks.
  const ceiling = Number(process.env.ROUTELOCK_MAX_RETIREMENT_USDC ?? 1);
  const retiring = new CarbonmarkX402Adapter(chain, {
    ledger: new RetirementLedger(ledgerPath("data/retirements.jsonl"), retirementCaps()),
    sign: makeRetirementSigner(owner as never, ceiling),
  });
  console.log(`  ceiling  ${ceiling} USDC for this signature`);

  const receipt = await retiring.fulfil(approved);
  console.log(`\n  RETIRED.`);
  console.log(`    ref        ${receipt.ref}`);
  console.log(`    charged    ${receipt.amountCharged} ${receipt.currency}`);
  console.log(`    proof      ${receipt.proofUrl}`);

  step(9, "Commit the provider's own evidence on X Layer");
  const witnessed = witness(attestation, receipt);
  const finalFields = registryFields(witnessed);
  console.log(`  carrierRefHash  ${finalFields.carrierRefHash}`);
  console.log(`  carrierRawHash  ${finalFields.carrierRawHash}`);

  // recordCarrier is ORACLE_ROLE, which the owner holds. The compliance key
  // cannot reach it — it opens the activation gate and nothing else.
  await registry.recordCarrier(tokenId, witnessed);
  console.log(`    committed`);

  console.log(
    `\n${"═".repeat(66)}\nCOMPLETE. A real carbon credit was retired against an\n` +
      `on-chain entitlement, and the provider's own evidence is committed.\n` +
      `Check it yourself: ${receipt.proofUrl}\n${"═".repeat(66)}`,
  );
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
