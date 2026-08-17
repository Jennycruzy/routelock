/// Recovers funds sitting in `SettlementEscrow` after an end-to-end run.
///
///   pnpm --filter @routelock/attest recover              # dry run, sends nothing
///   pnpm --filter @routelock/attest recover --broadcast  # sends, prompts for the keystore
///
/// ## Why this exists
///
/// `e2e.ts` moves money *in* — a buyer deposit and the issuer's collateral — and
/// never moves it out. It calls neither `releaseToIssuer`, `refundBuyer`,
/// `claim` nor `withdrawCollateral`. The funds are not lost; nothing reclaims
/// them. On X Layer testnet that had left **9.3 USD₮0** in escrow across four
/// runs with `claimable` still zero. On a mainnet balance the same pattern is
/// real money disappearing 0.3 at a time.
///
/// ## The decision this script makes, and what makes it deterministic
///
/// Every unsettled deposit ends one of two ways, and they are **not**
/// interchangeable: `releaseToIssuer` pays the issuer and emits
/// `SettlementReleased`; `refundBuyer` returns the buyer's money and emits
/// `BuyerRefunded`. Both are permanent public records of what happened. Choosing
/// the convenient one would write a false account of whether the work was done.
///
/// So the choice is made from on-chain evidence, never from a flag:
///
///   `carrierRefHash != 0`  the provider's own evidence is committed against
///                          this entitlement — the service was performed, so the
///                          issuer is owed. **Release.**
///
///   `carrierRefHash == 0`  no fulfilment was ever proven. **Refund.**
///
/// There is deliberately no `--release-everything`. An operator who wants a
/// different answer has to change the chain, not the script.
///
/// ## Where it refuses instead of guessing
///
/// A token whose entitlement state claims the carrier moved it
/// (`LabelCreated`, `InTransit`, `Delivered`) while carrying **no** committed
/// carrier evidence is contradictory: one of the two records is wrong, and this
/// script cannot tell which. It refuses that token, reports it, and continues
/// with the rest. Refusing one token is recoverable; paying the wrong party is
/// not.
///
/// ## Ordering, which is not cosmetic
///
/// Releases and refunds run first because `_dischargeObligation` reduces the
/// class's outstanding obligation, and `withdrawCollateral` refuses to take
/// collateral below that obligation. Collateral is therefore computed from state
/// **re-read after** the settlements land, never from the values this script
/// started with.
///
/// ## Safety
///
/// - Dry run is the default, and it is not a printout: every call is put through
///   `simulateContract` against live state, so a plan that would revert fails
///   here rather than halfway through spending gas.
/// - The signer's authority is checked before anything is sent — `ORACLE_ROLE`
///   for settlements, class issuer for collateral — so a missing role is a clear
///   message rather than a revert.
/// - It never sends a settlement for a deposit already marked settled.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  getAddress,
  keccak256,
  toHex,
} from "viem";
import type { Account, Address, PublicClient } from "viem";
import { getChain, loadDotEnv, requireSettlementToken } from "@routelock/chain";

import { ENTITLEMENT_STATE_NAMES, EntitlementState, SERVICE_ENTITLEMENT_ABI } from "../src/abi.ts";
import { unlockKeystoreAccount } from "./keystore.ts";

const BROADCAST = process.argv.includes("--broadcast");

const ZERO_HASH = `0x${"0".repeat(64)}`;

/// Only what this script calls. A hand-written ABI is a claim about deployed
/// bytecode, so every entry here is exercised by the dry run's simulation
/// before any of it is trusted with a transaction.
const ESCROW_ABI = [
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
    name: "claimable",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
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
    name: "refundBuyer",
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
    inputs: [
      { name: "classId", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const REGISTRY_ACTIVATIONS_ABI = [
  {
    type: "function",
    name: "activations",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "parcelHash", type: "bytes32" },
      { name: "documentsHash", type: "bytes32" },
      { name: "decisionHash", type: "bytes32" },
      { name: "carrierRefHash", type: "bytes32" },
      { name: "carrierRawHash", type: "bytes32" },
      { name: "engineVersion", type: "string" },
      { name: "submittedAt", type: "uint64" },
      { name: "activatedAt", type: "uint64" },
      { name: "attempt", type: "uint32" },
      { name: "verdict", type: "uint8" },
    ],
  },
] as const;

/// `keccak256("ORACLE_ROLE")`, matching `RouteLockTypes.sol`.
///
/// ⛔ **Derived, never transcribed.** This was first written as a pasted literal
/// and the literal was wrong — it was `keccak256("MINTER_ROLE")`, copied from an
/// unrelated revert while debugging a different chain. A role hash is 32 bytes of
/// hex that no reviewer will read, so the mistake is invisible on the page and
/// only shows up as a confident, false "this account lacks the role".
///
/// Computing it from the string makes the constant self-evidently correct and
/// removes the whole class of error. `roleHash.test.ts` pins the value against
/// the Solidity source as well.
export const ORACLE_ROLE = keccak256(toHex("ORACLE_ROLE"));

interface Deployment {
  readonly chainId: number;
  readonly settlementEscrow: Address;
  readonly activationRegistry: Address;
  readonly serviceEntitlement: Address;
  readonly settlementToken: Address;
}

type Action = "release" | "refund" | "refuse";

interface Settlement {
  readonly tokenId: bigint;
  readonly classId: `0x${string}`;
  readonly amount: bigint;
  readonly action: Action;
  readonly reason: string;
}

/// The whole policy, in one pure function so it can be read without following
/// any I/O. `fulfilled` is "the provider's evidence is committed on chain".
export function decideSettlement(
  fulfilled: boolean,
  state: EntitlementState,
): { action: Action; reason: string } {
  if (fulfilled) {
    return { action: "release", reason: "carrier evidence committed — the issuer performed" };
  }

  const claimsCarrierMovement =
    state === EntitlementState.LabelCreated ||
    state === EntitlementState.InTransit ||
    state === EntitlementState.Delivered;

  if (claimsCarrierMovement) {
    return {
      action: "refuse",
      reason:
        `state is ${ENTITLEMENT_STATE_NAMES[state]} but no carrierRefHash is committed — ` +
        `the two records contradict each other, so this script will not choose a payee`,
    };
  }

  return { action: "refund", reason: "no fulfilment was ever proven — the buyer is owed" };
}

function fmt(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals)} ${symbol}`;
}

async function main(): Promise<void> {
  // One parser, anchored at the repo root — the same loader e2e and the API use.
  loadDotEnv();

  const chainKey = process.env.ROUTELOCK_CHAIN ?? "xlayer_testnet";
  const chain = getChain(chainKey);
  const settlement = requireSettlementToken(chain);

  const deployment = JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../deployments/${chainKey}.json`, import.meta.url)),
      "utf8",
    ),
  ) as Deployment;

  const rpc = process.env[chain.rpcEnvVar] ?? chain.defaultRpc;
  const publicClient: PublicClient = createPublicClient({ transport: http(rpc) });

  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== deployment.chainId) {
    throw new Error(
      `${rpc} reports chain ${liveChainId} but the deployment file is for ` +
        `${deployment.chainId} — refusing to move money on the wrong chain`,
    );
  }

  // The deployment file and the chain table must agree about the token, or the
  // balances printed below describe something other than what is being moved.
  if (getAddress(deployment.settlementToken) !== getAddress(settlement)) {
    throw new Error(
      `deployment settles in ${deployment.settlementToken} but chains.ts says ${settlement}`,
    );
  }

  const decimals = chain.settlement.kind === "erc20" ? chain.settlement.decimals : 18;
  const symbol = chain.settlement.kind === "erc20" ? chain.settlement.symbol : "?";

  console.log(`chain     ${chain.name} (${liveChainId})`);
  console.log(`escrow    ${deployment.settlementEscrow}`);
  console.log(`token     ${settlement} (${symbol})`);
  console.log(`mode      ${BROADCAST ? "BROADCAST — this will send transactions" : "dry run"}\n`);

  const escrowHeld = await publicClient.readContract({
    address: settlement,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "a", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [deployment.settlementEscrow],
  });

  const totalMinted = await publicClient.readContract({
    address: deployment.serviceEntitlement,
    abi: SERVICE_ENTITLEMENT_ABI,
    functionName: "totalMinted",
  });

  console.log(`escrow holds ${fmt(escrowHeld, decimals, symbol)} across ${totalMinted} entitlement(s)\n`);

  // ---- plan the settlements -------------------------------------------
  const settlements: Settlement[] = [];
  const classIds = new Set<`0x${string}`>();

  for (let tokenId = 1n; tokenId <= totalMinted; tokenId++) {
    const [classId, buyer, amount, settled] = await publicClient.readContract({
      address: deployment.settlementEscrow,
      abi: ESCROW_ABI,
      functionName: "deposits",
      args: [tokenId],
    });

    if (buyer === "0x0000000000000000000000000000000000000000") continue;
    classIds.add(classId);

    if (settled) {
      console.log(`  token ${tokenId}  already settled, nothing to do`);
      continue;
    }

    const activation = await publicClient.readContract({
      address: deployment.activationRegistry,
      abi: REGISTRY_ACTIVATIONS_ABI,
      functionName: "activations",
      args: [tokenId],
    });
    const carrierRefHash = activation[3];

    const state = (await publicClient.readContract({
      address: deployment.serviceEntitlement,
      abi: SERVICE_ENTITLEMENT_ABI,
      functionName: "stateOf",
      args: [tokenId],
    })) as EntitlementState;

    const { action, reason } = decideSettlement(carrierRefHash !== ZERO_HASH, state);
    settlements.push({ tokenId, classId, amount, action, reason });

    console.log(
      `  token ${tokenId}  ${ENTITLEMENT_STATE_NAMES[state].padEnd(13)} ` +
        `${fmt(amount, decimals, symbol).padEnd(14)} -> ${action.toUpperCase()}`,
    );
    console.log(`            ${reason}`);
  }

  const actionable = settlements.filter((s) => s.action !== "refuse");
  const refused = settlements.filter((s) => s.action === "refuse");

  if (refused.length > 0) {
    console.log(`\n⛔ ${refused.length} token(s) refused and left untouched: ${refused.map((s) => s.tokenId).join(", ")}`);
  }

  // ---- check authority before sending anything -------------------------
  let account: Account | undefined;
  if (BROADCAST) {
    if (actionable.length === 0 && classIds.size === 0) {
      console.log("\nnothing to do.");
      return;
    }
    console.log(`\nunlocking keystore — password prompt follows`);
    account = await unlockKeystoreAccount(process.env.ROUTELOCK_KEYSTORE_ACCOUNT ?? "routelock-deployer");
    console.log(`signer    ${account.address}`);

    if (actionable.length > 0) {
      const isOracle = await publicClient.readContract({
        address: deployment.settlementEscrow,
        abi: ESCROW_ABI,
        functionName: "hasRole",
        args: [ORACLE_ROLE, account.address],
      });
      if (!isOracle) {
        throw new Error(
          `${account.address} does not hold ORACLE_ROLE on the escrow, so it cannot ` +
            `release or refund. Nothing has been sent.`,
        );
      }
    }
  }

  const walletClient =
    account === undefined
      ? undefined
      : createWalletClient({ account, chain: { ...chain, id: liveChainId } as never, transport: http(rpc) });

  /// Simulate always; send only with --broadcast. The simulation is the dry
  /// run's substance — it proves the call would succeed against live state.
  async function run(
    label: string,
    address: Address,
    functionName: string,
    args: readonly unknown[],
  ): Promise<void> {
    try {
      await publicClient.simulateContract({
        address,
        abi: ESCROW_ABI,
        functionName: functionName as never,
        args: args as never,
        account: account?.address ?? (process.env.ROUTELOCK_ADMIN as Address),
      });
    } catch (err) {
      console.log(`  FAIL  ${label}: ${(err as Error).message.split("\n")[0]}`);
      return;
    }

    if (walletClient === undefined || account === undefined) {
      console.log(`  would ${label}`);
      return;
    }

    const hash = await walletClient.writeContract({
      address,
      abi: ESCROW_ABI,
      functionName: functionName as never,
      args: args as never,
      account,
      chain: null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${receipt.status === "success" ? "OK  " : "FAIL"}  ${label}  ${hash}`);
  }

  // ---- settle deposits --------------------------------------------------
  if (actionable.length > 0) {
    console.log(`\nsettling ${actionable.length} deposit(s):`);
    for (const s of actionable) {
      await run(
        `${s.action} token ${s.tokenId} (${fmt(s.amount, decimals, symbol)})`,
        deployment.settlementEscrow,
        s.action === "release" ? "releaseToIssuer" : "refundBuyer",
        [s.tokenId],
      );
    }
  }

  // ---- claim what releasing made claimable ------------------------------
  // Read after the settlements, because that is what created the balance.
  const beneficiary = account?.address ?? (process.env.ROUTELOCK_ADMIN as Address);
  const claimable = await publicClient.readContract({
    address: deployment.settlementEscrow,
    abi: ESCROW_ABI,
    functionName: "claimable",
    args: [beneficiary, settlement],
  });

  if (claimable > 0n) {
    console.log(`\nclaiming ${fmt(claimable, decimals, symbol)}:`);
    await run(`claim`, deployment.settlementEscrow, "claim", [settlement]);
  } else if (BROADCAST) {
    console.log(`\nnothing claimable for ${beneficiary}`);
  }

  // ---- withdraw collateral above outstanding obligations ----------------
  // Re-read: the settlements above discharged obligations, and this is exactly
  // the number `withdrawCollateral` refuses to go below.
  console.log(`\ncollateral:`);
  let plannedCollateral = 0n;
  for (const classId of classIds) {
    const [issuer, , payoutObligation, collateral, obligation] = await publicClient.readContract({
      address: deployment.settlementEscrow,
      abi: ESCROW_ABI,
      functionName: "classEscrow",
      args: [classId],
    });

    // A dry run has not discharged anything, so the obligation still standing on
    // chain includes every deposit the plan above would settle. Reporting the
    // raw number would understate the recovery — on X Layer testnet by 3.1 of
    // 9.3 — and an operator reading it would conclude the money is stuck.
    //
    // So project what `_dischargeObligation` will do: one `payoutObligation` per
    // planned settlement for this class, floored at zero exactly as the contract
    // floors it. Under `--broadcast` the discharges have already landed, so the
    // value read back is the real one and no projection is applied.
    const plannedDischarges = BigInt(actionable.filter((s) => s.classId === classId).length);
    const projected = BROADCAST
      ? obligation
      : obligation > payoutObligation * plannedDischarges
        ? obligation - payoutObligation * plannedDischarges
        : 0n;

    const withdrawable = collateral > projected ? collateral - projected : 0n;
    const label = `${classId.slice(0, 10)}…`;

    if (withdrawable === 0n) {
      console.log(
        `  ${label}  nothing free (collateral ${fmt(collateral, decimals, symbol)}, ` +
          `obligation ${fmt(obligation, decimals, symbol)})`,
      );
      continue;
    }

    // A projected withdrawal cannot be simulated: the contract still holds the
    // undischarged obligation, so `withdrawCollateral` would revert right now
    // and correctly so. Say that, rather than printing a FAIL an operator would
    // read as a broken plan.
    plannedCollateral += withdrawable;

    if (!BROADCAST && projected !== obligation) {
      console.log(
        `  would withdraw ${fmt(withdrawable, decimals, symbol)} from ${label} ` +
          `(after the ${plannedDischarges} settlement(s) above discharge ` +
          `${fmt(obligation - projected, decimals, symbol)} of obligation)`,
      );
      continue;
    }

    if (BROADCAST && account !== undefined && getAddress(issuer) !== getAddress(account.address)) {
      console.log(`  ${label}  SKIP — issuer is ${issuer}, signer is ${account.address}`);
      continue;
    }

    await run(
      `withdraw ${fmt(withdrawable, decimals, symbol)} from ${label}`,
      deployment.settlementEscrow,
      "withdrawCollateral",
      [classId, withdrawable],
    );
  }

  const plannedDeposits = actionable.reduce((sum, x) => sum + x.amount, 0n);
  const plannedTotal = plannedDeposits + plannedCollateral;
  console.log(
    `\nthis plan moves ${fmt(plannedTotal, decimals, symbol)} out of escrow ` +
      `(${fmt(plannedDeposits, decimals, symbol)} deposits + ` +
      `${fmt(plannedCollateral, decimals, symbol)} collateral) of ` +
      `${fmt(escrowHeld, decimals, symbol)} held`,
  );
  if (plannedTotal < escrowHeld) {
    // Not an error: refused tokens and their still-obligated collateral stay
    // behind by design. Stated so the shortfall is never a silent one.
    console.log(
      `  ${fmt(escrowHeld - plannedTotal, decimals, symbol)} stays in escrow` +
        `${refused.length > 0 ? ` — ${refused.length} refused token(s) and the collateral still backing them` : ""}`,
    );
  }

  const escrowAfter = await publicClient.readContract({
    address: settlement,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "a", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [deployment.settlementEscrow],
  });

  console.log(`\nescrow now holds ${fmt(escrowAfter, decimals, symbol)}`);
  if (!BROADCAST) {
    console.log(`(dry run — nothing was sent. Re-run with --broadcast to act on this plan.)`);
  }
}

await main();
