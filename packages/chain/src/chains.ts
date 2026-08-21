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
export type AdapterVertical = "delivery" | "carbon" | "compute";

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

/**
 * Where idle collateral could be floated to earn yield.
 *
 * Modelled the same way settlement is, and for the same reason: "there is no
 * venue here" and "there is a venue and here is its address" must be different
 * shapes, so that the absent case cannot be mistaken for a configured one.
 *
 * `asset` is the token the venue actually accepts. It is stored separately from
 * the chain's `settlement.token` and **deliberately not assumed equal** — on
 * X Layer they happen to be equal only after the canonical USD₮0 correction.
 * Keeping both fields prevents an adapter from silently assuming equality on a
 * different chain and then reverting on its first real deposit.
 */
export type YieldVenue =
  | {
      kind: "aave-v3";
      pool: `0x${string}`;
      addressesProvider: `0x${string}`;
      /** The venue's reserve asset. */
      asset: `0x${string}`;
      assetSymbol: string;
      aToken: `0x${string}`;
      aTokenSymbol: string;
      /**
       * Whether `asset` is this chain's settlement token. When false, no
       * adapter can float settlement here without a swap, and a swap is a
       * different product with a different risk.
       */
      settlesInVenueAsset: boolean;
    }
  | { kind: "none"; reason: string };

export interface ChainConfig {
  readonly name: string;
  readonly chainId: number;
  readonly rpcEnvVar: string;
  readonly defaultRpc: string;
  readonly explorer: string;
  readonly settlement: Settlement;
  readonly yieldVenue: YieldVenue;
  readonly env: ChainEnv;
  readonly carrierMode: CarrierMode;
  /**
   * The verticals this chain lane is allowed to load. This is deliberately
   * part of chain configuration rather than an environment variable: a
   * judge-facing deployment must not change meaning because a shell variable
   * changed.
   */
  readonly allowedVerticals: readonly AdapterVertical[];
}

export const CHAINS = {
  xlayer_testnet: {
    name: "X Layer Testnet",
    chainId: 1952, // verified: eth_chainId -> 0x7a0
    rpcEnvVar: "XLAYER_TESTNET_RPC",
    defaultRpc: "https://testrpc.xlayer.tech",
    explorer: "https://www.oklink.com/xlayer-test",
    settlement: {
      kind: "erc20",
      // USD₮0 — the omnichain USDT deployment, and the token the X Layer testnet
      // faucet actually dispenses. Verified on-chain: symbol() -> "USD₮0",
      // decimals() -> 6, non-zero totalSupply. Chosen over the other two faucet
      // tokens (USDC_TEST, USDG) because it is the testnet analogue of the USDT
      // used for settlement on all three other targets.
      token: "0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c",
      symbol: "USD₮0",
      decimals: 6,
    },
    // Probed live 2026-08-17: Aave's X Layer Pool and PoolAddressesProvider both
    // return empty code (`0x`) on 1952. The market exists on mainnet only, so
    // there is nowhere on testnet to exercise a yield adapter against the real
    // thing — and a mock one would be worth nothing.
    yieldVenue: {
      kind: "none",
      reason: "Aave V3 is not deployed on X Layer testnet — Pool and provider have no code at 1952",
    },
    env: "test",
    carrierMode: "sandbox",
    allowedVerticals: ["carbon", "delivery"],
  },

  xlayer_mainnet: {
    name: "X Layer Mainnet",
    chainId: 196, // verified: eth_chainId -> 0xc4
    rpcEnvVar: "XLAYER_MAINNET_RPC",
    defaultRpc: "https://rpc.xlayer.tech",
    explorer: "https://www.oklink.com/xlayer",
    settlement: {
      kind: "erc20",
      // USD₮0 — LayerZero-OFT USDT, and the canonical stablecoin on X Layer.
      // Verified on-chain 2026-08-17: name() -> "USD₮0", decimals() -> 6.
      //
      // ⛔ This was `0x1E4a5963…` ("Tether USD", USDT) until 2026-08-17, and
      // that was wrong. Both contracts are live on 196, so nothing reverted and
      // nothing looked broken — the config simply named the legacy bridged
      // token, which is being phased out in favour of USD₮0. What settles it,
      // measured rather than argued:
      //
      //   supply     113,309,004,080,663  vs  3,829,200,805,666   (30x)
      //   transfers  6,175                vs  324                 (19x, sampled
      //              over ten 100-block windows spanning ~50k blocks)
      //   Aave       USD₮0 listed         vs legacy token absent from reserves
      //   testnet    the 1952 faucet dispenses USD₮0, matching mainnet's
      //              canonical settlement asset
      //
      // The lesson is the one this file already teaches, applied one level
      // further: `symbol()` returning "USDT" proves a token calls itself USDT,
      // not that it is the one the chain actually uses.
      token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      symbol: "USD₮0",
      decimals: 6,
    },
    // Aave V3 launched on X Layer on 30 March 2026 and every address below was
    // read off the chain on 2026-08-17, not off the announcement.
    //
    // `settlesInVenueAsset` is TRUE: Aave's X Layer reserve *is* the settlement
    // token. It read false until the settlement address above was corrected —
    // the mismatch was never Aave's, it was ours.
    yieldVenue: {
      kind: "aave-v3",
      pool: "0xE3F3Caefdd7180F884c01E57f65Df979Af84f116",
      addressesProvider: "0xdFf435BCcf782f11187D3a4454d96702eD78e092",
      asset: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      assetSymbol: "USD₮0",
      aToken: "0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297",
      aTokenSymbol: "aXlrUSDT0",
      settlesInVenueAsset: true,
    },
    env: "live",
    carrierMode: "live",
    allowedVerticals: ["carbon", "delivery"],
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
    yieldVenue: {
      kind: "none",
      reason: "Aave V3 has no BOT Chain deployment — no market has been announced or found on 968",
    },
    env: "test",
    carrierMode: "sandbox",
    allowedVerticals: ["compute"],
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
    yieldVenue: {
      kind: "none",
      reason: "Aave V3 has no BOT Chain deployment — no market has been announced or found on 677",
    },
    env: "live",
    carrierMode: "live",
    allowedVerticals: ["compute"],
  },
} as const satisfies Record<string, ChainConfig>;

export type ChainKey = keyof typeof CHAINS;

/**
 * Chains RouteLock does not deploy to, but whose state its proofs point at.
 *
 * Base is here and not in `CHAINS` because the distinction is the architecture,
 * not a filing convenience. The obligation, the collateral, the escrow and the
 * compliance record are RouteLock's own and live on X Layer; the retirement
 * executes on Base through Klima's aggregator, and the certificate is
 * Carbonmark's. Nothing is deployed here, nothing is bridged, and no credit is
 * wrapped or tokenised. A judge inspects X Layer state and then clicks a
 * third-party receipt — which is stronger than a self-contained system where
 * every claim traces back to our own database.
 *
 * Verified live 2026-08-14: eth_chainId -> 0x2105.
 */
export const FULFILMENT_CHAINS = {
  base_mainnet: {
    name: "Base Mainnet",
    chainId: 8453,
    rpcEnvVar: "BASE_MAINNET_RPC",
    defaultRpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    /**
     * The input token the retirement is paid in. Verified on-chain
     * 2026-08-14: symbol() -> "USDC", decimals() -> 6. Also the token whose
     * EIP-3009 authorization the issuer signs, which is why its address is
     * pinned here rather than read from the endpoint's response — an endpoint
     * that could name its own payment token could name a different one.
     */
    inputToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    inputTokenSymbol: "USDC",
    inputTokenDecimals: 6,
  },
} as const;

export type FulfilmentChainKey = keyof typeof FULFILMENT_CHAINS;
export type FulfilmentChainConfig =
  (typeof FULFILMENT_CHAINS)[FulfilmentChainKey];

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
 * Refuse to load an adapter on the wrong chain lane.
 *
 * BOT Chain is reserved for compute, while X Layer carries the live carbon
 * lane. Keeping this at the shared chain boundary makes the rule apply to
 * every adapter constructor and not only to one demo script.
 */
export function assertVerticalAllowed(
  chain: ChainConfig,
  vertical: AdapterVertical,
): void {
  if (chain.allowedVerticals.includes(vertical)) return;

  throw new Error(
    `FATAL: ${chain.name} does not allow the ${vertical} fulfilment lane. ` +
      `Allowed lanes: ${chain.allowedVerticals.join(", ")}. ` +
      `This chain's vertical binding is fixed in code, not configurable by ` +
      `an environment variable.`,
  );
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
  assertProviderPairing(chain, carrierKey, SHIPBUBBLE_KEYS);
}

/**
 * How one provider's keys announce which environment they belong to.
 *
 * `livePrefix` is nullable because a provider's production prefix is not
 * knowable until production access is granted. A null one does not mean
 * "accept anything" — it means no key can satisfy a live chain, so a mainnet
 * boot fails loudly instead of proceeding on a guess.
 */
export interface ProviderKeyScheme {
  /** Names the credential in error messages, e.g. "carrier key". */
  readonly noun: string;
  readonly sandboxPrefix: string;
  readonly livePrefix: string | null;
  /** What goes wrong if a live key reaches a test chain. Provider-specific. */
  readonly liveOnTestConsequence: string;
}

export const SHIPBUBBLE_KEYS: ProviderKeyScheme = {
  noun: "carrier key",
  sandboxPrefix: "sb_sandbox",
  livePrefix: "sb_prod",
  liveOnTestConsequence: "this is how real shipments get bought by accident",
};

/**
 * Carbonmark's production prefix is deliberately unknown.
 *
 * Production access has not been granted, so no production key has been seen.
 * Guessing a prefix would defeat the guard: an unrecognised key would be
 * accepted as live and a mainnet retirement could be attempted with a sandbox
 * credential, or the reverse. It stays null until a real production key exists
 * to read it from.
 *
 * This matters more here than for the carrier, because Carbonmark has no
 * separate sandbox host — both environments answer on api.carbonmark.com, so
 * the key prefix is the only thing distinguishing them. See
 * docs/carbonmark-verification.md.
 */
export const CARBONMARK_KEYS: ProviderKeyScheme = {
  noun: "Carbonmark key",
  sandboxPrefix: "cm_api_sandbox",
  livePrefix: null,
  liveOnTestConsequence: "this is how real credits get retired by accident",
};

/**
 * A provider that has no sandbox at all, and therefore no key to mispair.
 *
 * `ProviderKeyScheme` above works because a keyed provider announces its
 * environment in the credential itself, so the mismatch is detectable at boot.
 * A keyless mainnet-only provider offers nothing to inspect: there is no
 * credential, no test host, and no way for a wrong configuration to look
 * different from a right one. The guard therefore moves from process start to
 * the spend boundary — the only place where the distinction has consequences.
 *
 * This is a deliberate narrowing of §1.2.5, not a lapse from it. The rule
 * exists so a testnet deployment cannot quietly spend real money; here that is
 * enforced where the money actually moves, and reads — which cost nothing and
 * are identical in both environments — stay available everywhere.
 */
export interface KeylessSpendScheme {
  /** Names the provider in error messages. */
  readonly noun: string;
  /** Why no sandbox exists. Stated so the guard reads as measured, not assumed. */
  readonly reason: string;
  /** Env var an operator must set to authorise real spending from a test chain. */
  readonly optInVar: string;
  /** The exact value required. Deliberately unguessable and self-describing. */
  readonly optInValue: string;
}

/**
 * The Klima x402 retirement endpoint.
 *
 * **It has no test mode.** The manifest's JSON schema advertises chainId 84532
 * (Base Sepolia) alongside 8453, and the published error registry repeats it —
 * but the live endpoint rejects 84532 with
 * `unsupported_chain_id: "Only Base mainnet is supported", supported: [8453]`.
 * Verified 2026-08-14; see docs/carbonmark-verification.md. The schema is
 * aspirational and the runtime is authoritative, which is the whole reason
 * every value in this file is read from the thing itself rather than its
 * documentation.
 *
 * Consequence: every retirement this project performs is real, irreversible,
 * and on Base mainnet. There is no environment in which a retirement can be
 * rehearsed, so there is nothing to pair a test chain against.
 */
export const KLIMA_X402_SPEND: KeylessSpendScheme = {
  noun: "Klima x402 retirement",
  reason:
    "the endpoint serves Base mainnet only — chainId 84532 appears in its " +
    "schema but is rejected at runtime, so no sandbox retirement exists",
  optInVar: "ROUTELOCK_X402_ALLOW_LIVE_RETIREMENT",
  optInValue: "yes-retire-for-real",
};

/**
 * Refuse to spend real money on behalf of a test-chain deployment.
 *
 * Called from `fulfil()`, not from a constructor: discovery, pricing and
 * authorization-building are free and behave identically everywhere, so a
 * testnet deployment must still be able to perform them. What it must not do
 * is burn a credit that cannot be un-burned.
 *
 * The opt-in exists because the alternative is worse. Without it, exercising
 * the real path during development would mean editing the guard — and a guard
 * that gets edited to be worked around is not a guard.
 */
export function assertKeylessSpendAllowed(
  chain: ChainConfig,
  scheme: KeylessSpendScheme,
  env: Record<string, string | undefined> = process.env
): void {
  if (chain.env === "live") return;

  if (env[scheme.optInVar] === scheme.optInValue) return;

  throw new Error(
    `FATAL: ${chain.name} is a test chain and ${scheme.noun} has no sandbox — ` +
      `${scheme.reason}. Proceeding would retire a real credit, irreversibly, ` +
      `against a testnet obligation. Set ${scheme.optInVar}=${scheme.optInValue} ` +
      `to authorise that deliberately, or run this on a live chain.`
  );
}

export function assertProviderPairing(
  chain: ChainConfig,
  key: string | undefined,
  scheme: ProviderKeyScheme
): void {
  if (!key) {
    throw new Error(
      `FATAL: no ${scheme.noun} supplied for ${chain.name}. Refusing to boot — ` +
        `RouteLock does not run against a mocked carrier.`
    );
  }

  const isSandboxKey = key.startsWith(scheme.sandboxPrefix);
  const isLiveKey = scheme.livePrefix !== null && key.startsWith(scheme.livePrefix);

  if (!isLiveKey && !isSandboxKey) {
    const live =
      scheme.livePrefix === null
        ? `(the live prefix is not yet known — production access has not been granted)`
        : `("${scheme.livePrefix}…")`;
    throw new Error(
      `FATAL: ${scheme.noun} for ${chain.name} matches neither the live ` +
        `${live} nor the sandbox ("${scheme.sandboxPrefix}…") prefix. Refusing to boot ` +
        `rather than guess which environment it belongs to.`
    );
  }

  if (chain.env === "live" && !isLiveKey) {
    throw new Error(
      `FATAL: ${chain.name} is a live chain but the ${scheme.noun} is a sandbox key. ` +
        `A mainnet deployment must never display a sandbox result.`
    );
  }

  if (chain.env === "test" && !isSandboxKey) {
    throw new Error(
      `FATAL: ${chain.name} is a test chain but a LIVE ${scheme.noun} was supplied. ` +
        `Refusing to boot — ${scheme.liveOnTestConsequence}.`
    );
  }
}

/** Carrier mode is derived from the chain, never configured independently. */
export function carrierModeFor(chain: ChainConfig): CarrierMode {
  return chain.carrierMode;
}
