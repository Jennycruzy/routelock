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
