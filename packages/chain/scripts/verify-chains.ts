/**
 * Re-verifies every value in CHAINS against the live network.
 *
 * This exists because a chain ID or token address copied from a docs page is an
 * unverified claim. Run it before every deployment and in CI. It makes no
 * assertions of its own — it asks the chain and compares.
 *
 *   pnpm --filter @routelock/chain verify
 */

import { CHAINS, type ChainConfig } from "../src/chains.ts";

const ERC20_SYMBOL = "0x95d89b41";
const ERC20_DECIMALS = "0x313ce567";

/** `getPool()` on Aave's PoolAddressesProvider. */
const AAVE_GET_POOL = "0x026b1d5f";
/** `UNDERLYING_ASSET_ADDRESS()` on an aToken. */
const ATOKEN_UNDERLYING = "0xb16a19de";

interface RpcResult {
  result?: string;
  error?: { message: string };
}

async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const body = (await res.json()) as RpcResult;
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`${method}: empty result`);
  return body.result;
}

/** Decode an ABI-encoded string return value. */
function decodeString(hex: string): string {
  const data = hex.slice(2);
  if (data.length < 128) {
    // Some non-standard tokens return a fixed bytes32 instead of a string.
    return Buffer.from(data, "hex").toString("utf8").replace(/\0+$/, "");
  }
  const length = parseInt(data.slice(64, 128), 16);
  return Buffer.from(data.slice(128, 128 + length * 2), "hex").toString("utf8");
}

type Check = { ok: boolean; label: string; detail: string };

async function verifyChain(key: string, chain: ChainConfig): Promise<Check[]> {
  const url = process.env[chain.rpcEnvVar] ?? chain.defaultRpc;
  const checks: Check[] = [];

  try {
    const chainIdHex = await rpc(url, "eth_chainId", []);
    const actual = parseInt(chainIdHex, 16);
    checks.push({
      ok: actual === chain.chainId,
      label: "chainId",
      detail:
        actual === chain.chainId
          ? `${actual} (${chainIdHex})`
          : `EXPECTED ${chain.chainId}, RPC REPORTED ${actual}`,
    });

    const blockHex = await rpc(url, "eth_blockNumber", []);
    checks.push({
      ok: parseInt(blockHex, 16) > 0,
      label: "liveness",
      detail: `head block ${parseInt(blockHex, 16).toLocaleString()}`,
    });
  } catch (err) {
    checks.push({
      ok: false,
      label: "rpc",
      detail: `${url} unreachable: ${(err as Error).message}`,
    });
    return checks;
  }

  if (chain.settlement.kind === "unresolved") {
    checks.push({
      ok: false,
      label: "settlement",
      detail: `UNRESOLVED — ${chain.settlement.reason}`,
    });
    return checks;
  }

  if (chain.settlement.kind === "native") {
    checks.push({
      ok: true,
      label: "settlement",
      detail: `native ${chain.settlement.symbol}`,
    });
    return checks;
  }

  const { token, symbol, decimals } = chain.settlement;
  try {
    const code = await rpc(url, "eth_getCode", [token, "latest"]);
    if (code === "0x") {
      checks.push({
        ok: false,
        label: "settlement",
        detail: `NO CONTRACT DEPLOYED at ${token}`,
      });
      return checks;
    }

    const actualSymbol = decodeString(
      await rpc(url, "eth_call", [{ to: token, data: ERC20_SYMBOL }, "latest"])
    );
    const actualDecimals = parseInt(
      await rpc(url, "eth_call", [{ to: token, data: ERC20_DECIMALS }, "latest"]),
      16
    );

    const matches = actualSymbol === symbol && actualDecimals === decimals;
    checks.push({
      ok: matches,
      label: "settlement",
      detail: matches
        ? `${actualSymbol} (${actualDecimals} dp) at ${token}`
        : `EXPECTED ${symbol}/${decimals}dp, CHAIN REPORTED ${actualSymbol}/${actualDecimals}dp`,
    });
  } catch (err) {
    checks.push({
      ok: false,
      label: "settlement",
      detail: `token probe failed: ${(err as Error).message}`,
    });
  }

  checks.push(...(await verifyYieldVenue(url, chain)));

  return checks;
}

/** Decode the trailing 20 bytes of a 32-byte word as an address, lowercased. */
function decodeAddress(hex: string): string {
  return `0x${hex.slice(-40)}`.toLowerCase();
}

/**
 * Probe the yield venue, before anything is wired to it.
 *
 * This exists because of what it found the first time it ran. Aave V3 launched
 * on X Layer in March 2026, which made "float idle collateral into Aave" look
 * like a wiring task. It is not: the market lists USD₮0 and RouteLock settles
 * mainnet in USDT, two different contracts, and Aave's reserve list does not
 * contain RouteLock's token at all.
 *
 * An announcement says a protocol is on a chain. It does not say the asset you
 * hold is listed on it, and that is the fact an adapter actually depends on.
 */
async function verifyYieldVenue(url: string, chain: ChainConfig): Promise<Check[]> {
  const venue = chain.yieldVenue;

  if (venue.kind === "none") {
    // Not a failure. A chain with no venue is a fact about the chain, and
    // recording it is the point — it is what stops the question being reopened
    // every time somebody remembers that Aave is multi-chain.
    return [{ ok: true, label: "yield", detail: `none — ${venue.reason}` }];
  }

  const checks: Check[] = [];

  try {
    for (const [label, address] of [
      ["pool", venue.pool],
      ["provider", venue.addressesProvider],
      ["aToken", venue.aToken],
      ["asset", venue.asset],
    ] as const) {
      if ((await rpc(url, "eth_getCode", [address, "latest"])) === "0x") {
        return [{ ok: false, label: "yield", detail: `NO CONTRACT DEPLOYED at ${label} ${address}` }];
      }
    }

    // The provider must agree about the pool. A pool address that the protocol's
    // own registry does not point at is either stale or a different market.
    const resolvedPool = decodeAddress(
      await rpc(url, "eth_call", [{ to: venue.addressesProvider, data: AAVE_GET_POOL }, "latest"]),
    );
    if (resolvedPool !== venue.pool.toLowerCase()) {
      checks.push({
        ok: false,
        label: "yield",
        detail: `provider resolves pool ${resolvedPool}, config says ${venue.pool}`,
      });
    } else {
      checks.push({ ok: true, label: "yield", detail: `${venue.kind} pool ${venue.pool}` });
    }

    // The aToken must be the receipt for the asset we think it is.
    const underlying = decodeAddress(
      await rpc(url, "eth_call", [{ to: venue.aToken, data: ATOKEN_UNDERLYING }, "latest"]),
    );
    const aTokenSymbol = decodeString(
      await rpc(url, "eth_call", [{ to: venue.aToken, data: ERC20_SYMBOL }, "latest"]),
    );
    const underlyingMatches = underlying === venue.asset.toLowerCase();

    checks.push({
      ok: underlyingMatches && aTokenSymbol === venue.aTokenSymbol,
      label: "yield asset",
      detail: underlyingMatches
        ? `${aTokenSymbol} receipts ${venue.assetSymbol} at ${venue.asset}`
        : `aToken underlying is ${underlying}, config says ${venue.asset}`,
    });

    // The claim that matters to an adapter, checked against the chain rather
    // than trusted from the config that asserts it.
    const settlementToken =
      chain.settlement.kind === "erc20" ? chain.settlement.token.toLowerCase() : null;
    const actuallySettlesInVenueAsset = settlementToken === venue.asset.toLowerCase();

    checks.push({
      ok: actuallySettlesInVenueAsset === venue.settlesInVenueAsset,
      label: "yield match",
      detail: actuallySettlesInVenueAsset
        ? `venue accepts the settlement token — an adapter can float it directly`
        : `venue accepts ${venue.assetSymbol} ${venue.asset}, settlement is ` +
          `${chain.settlement.kind === "erc20" ? `${chain.settlement.symbol} ${chain.settlement.token}` : chain.settlement.kind} ` +
          `— NO ADAPTER CAN FLOAT SETTLEMENT HERE without a swap`,
    });
  } catch (err) {
    checks.push({ ok: false, label: "yield", detail: `venue probe failed: ${(err as Error).message}` });
  }

  return checks;
}

async function main(): Promise<void> {
  console.log(`RouteLock chain verification — ${new Date().toISOString()}\n`);

  let failures = 0;
  for (const [key, chain] of Object.entries(CHAINS)) {
    console.log(`${chain.name}  [${key}]  env=${chain.env}  carrier=${chain.carrierMode}`);
    const checks = await verifyChain(key, chain as ChainConfig);
    for (const check of checks) {
      if (!check.ok) failures++;
      console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.label.padEnd(11)} ${check.detail}`);
    }
    console.log();
  }

  if (failures > 0) {
    console.log(`${failures} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("All chain configuration verified against live networks.");
}

await main();
