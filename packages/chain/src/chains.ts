/**
 * Chain configuration — the single table that drives every deployment.
 *
 * Rule: no chain-specific branches anywhere in application code. If you find
 * yourself writing `if (chain === "xlayer")`, the difference belongs here.
 *
 * Every numeric value below was verified live against the chain's own RPC on
 * 2026-08-13, not copied from a docs page. See docs/chain-verification.md for
 * the raw eth_chainId / symbol() / decimals() responses.
 */

export type ChainEnv = "test" | "live";
export type CarrierMode = "sandbox" | "live";

/**
 * Settlement is behind a discriminated union from day one so that a chain
 * without a stablecoin is a config choice, not a rewrite (spec §7.2).
 *
 * `unresolved` is deliberate and load-bearing: it is how we represent "we have
 * not yet confirmed a settlement token on this network." It is NOT a
 * placeholder address. Any attempt to use an unresolved settlement throws, so
 * an unverified token can never silently reach a deployment.
 */
export type Settlement =
  | { kind: "erc20"; token: `0x${string}`; symbol: string; decimals: number }
  | { kind: "native"; symbol: string; decimals: number }
  | { kind: "unresolved"; reason: string };

export interface ChainConfig {
  readonly name: string;
  readonly chainId: number;
  readonly rpcEnvVar: string;
  readonly defaultRpc: string;
  readonly explorer: string;
  readonly settlement: Settlement;
  readonly env: ChainEnv;
  readonly carrierMode: CarrierMode;
}

export const CHAINS = {
  xlayer_testnet: {
    name: "X Layer Testnet",
    chainId: 1952, // verified: eth_chainId -> 0x7a0
    rpcEnvVar: "XLAYER_TESTNET_RPC",
    defaultRpc: "https://testrpc.xlayer.tech",
    explorer: "https://www.oklink.com/xlayer-test",
    settlement: {
      kind: "unresolved",
      reason:
        "No spendable stablecoin found on X Layer testnet as of 2026-08-13. A USD Coin " +
        "(USDC, 6dp) contract does exist at 0x74b7F16337b8972027F6196A17a631aC6dE26d22, " +
        "but its totalSupply is 0 — nothing has ever been minted, so no account can hold " +
        "or pay with it. No USDT contract was found at any address that resolves on this " +
        "chain. Resolve before the testnet deploy: either obtain a faucet token and " +
        "configure its real address, or deploy a RouteLock test ERC-20 and label it " +
        "plainly as such in the README. See docs/chain-verification.md.",
    },
    env: "test",
    carrierMode: "sandbox",
  },

  xlayer_mainnet: {
    name: "X Layer Mainnet",
    chainId: 196, // verified: eth_chainId -> 0xc4
    rpcEnvVar: "XLAYER_MAINNET_RPC",
    defaultRpc: "https://rpc.xlayer.tech",
    explorer: "https://www.oklink.com/xlayer",
    settlement: {
      kind: "erc20",
      // verified on-chain: symbol() -> "USDT", decimals() -> 6
      token: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
      symbol: "USDT",
      decimals: 6,
    },
    env: "live",
    carrierMode: "live",
  },

  botchain_testnet: {
    name: "BOT Chain Testnet",
    chainId: 968, // verified: eth_chainId -> 0x3c8
    rpcEnvVar: "BOTCHAIN_TESTNET_RPC",
    defaultRpc: "https://rpc.bohr.life",
    explorer: "https://scan.bohr.life",
    settlement: {
      kind: "erc20",
      // verified on-chain: symbol() -> "USDT", decimals() -> 6
      token: "0x75edC9335175Fc0552D51D48439F229c10420fe3",
      symbol: "USDT",
      decimals: 6,
    },
    env: "test",
    carrierMode: "sandbox",
  },

  botchain_mainnet: {
    name: "BOT Chain Mainnet",
    chainId: 677, // verified: eth_chainId -> 0x2a5
    rpcEnvVar: "BOTCHAIN_MAINNET_RPC",
    defaultRpc: "https://rpc.botchain.ai",
    explorer: "https://scan.botchain.ai",
    settlement: {
      kind: "erc20",
      // verified on-chain: symbol() -> "USDT", decimals() -> 6
      token: "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C",
      symbol: "USDT",
      decimals: 6,
    },
    env: "live",
    carrierMode: "live",
  },
} as const satisfies Record<string, ChainConfig>;

export type ChainKey = keyof typeof CHAINS;

export function getChain(key: string): ChainConfig {
  const chain = (CHAINS as Record<string, ChainConfig>)[key];
  if (!chain) {
    throw new Error(
      `Unknown chain "${key}". Known chains: ${Object.keys(CHAINS).join(", ")}`
    );
  }
  return chain;
}

/**
 * Resolve the settlement token, refusing to proceed on an unresolved one.
 * Call this at deploy time and at boot — never default to a zero address.
 */
export function requireSettlementToken(chain: ChainConfig): `0x${string}` {
  if (chain.settlement.kind === "unresolved") {
    throw new Error(
      `FATAL: ${chain.name} has no confirmed settlement token.\n` +
        `  ${chain.settlement.reason}\n` +
        `Refusing to proceed — a guessed token address is worse than no deployment.`
    );
  }
  if (chain.settlement.kind === "native") {
    throw new Error(
      `${chain.name} settles in native ${chain.settlement.symbol}. ` +
        `Use the NativeSettlement path, not an ERC-20 token address.`
    );
  }
  return chain.settlement.token;
}

/**
 * Implements absolute rule §1.2.5 — environment pairing is inviolable.
 *
 * A testnet contract must never hold a live carrier key, and a mainnet contract
 * must never display a sandbox result. This is the guard that makes that
 * structural rather than a matter of discipline: it throws at process start,
 * before any route is registered, so the failure mode is a dead process rather
 * than real money quietly spent from a testnet demo.
 */
export function assertEnvironmentPairing(
  chain: ChainConfig,
  carrierKey: string | undefined
): void {
  if (!carrierKey) {
    throw new Error(
      `FATAL: no carrier key supplied for ${chain.name}. Refusing to boot — ` +
        `RouteLock does not run against a mocked carrier.`
    );
  }

  const isLiveKey = carrierKey.startsWith("sb_prod");
  const isSandboxKey = carrierKey.startsWith("sb_sandbox");

  if (!isLiveKey && !isSandboxKey) {
    throw new Error(
      `FATAL: carrier key for ${chain.name} matches neither the live ` +
        `("sb_prod…") nor the sandbox ("sb_sandbox…") prefix. Refusing to boot ` +
        `rather than guess which environment it belongs to.`
    );
  }

  if (chain.env === "live" && !isLiveKey) {
    throw new Error(
      `FATAL: ${chain.name} is a live chain but the carrier key is a sandbox key. ` +
        `A mainnet deployment must never display a sandbox result.`
    );
  }

  if (chain.env === "test" && !isSandboxKey) {
    throw new Error(
      `FATAL: ${chain.name} is a test chain but a LIVE carrier key was supplied. ` +
        `Refusing to boot — this is how real shipments get bought by accident.`
    );
  }
}

/** Carrier mode is derived from the chain, never configured independently. */
export function carrierModeFor(chain: ChainConfig): CarrierMode {
  return chain.carrierMode;
}
