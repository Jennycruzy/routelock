/// Crash recovery, asked of the chain rather than of the provider.
///
/// **This file exists because of one failure mode.** `actions/retire` can time
/// out after the executor has already relayed the transaction. The connection
/// dies; the retirement mines anyway. A blind retry then burns a second credit,
/// irreversibly, for an obligation that was already discharged — and the only
/// evidence either way is on-chain.
///
/// USDC's EIP-3009 implementation makes that evidence exact. Each
/// `(authorizer, nonce)` pair is permanently consumed when an authorization is
/// used, exposed as `authorizationState(address,bytes32) -> bool`, and the
/// consumption emits `AuthorizationUsed(address indexed, bytes32 indexed)` —
/// indexed on both, so a log filter recovers the transaction hash itself. The
/// nonce is recorded in the ledger before the request goes out, which is what
/// makes all of this reachable after a crash.
///
/// Nothing here trusts the endpoint. That is the point: the endpoint is the
/// party whose silence created the ambiguity.
///
/// Zero dependencies, like the rest of the path that touches money. The two
/// calls needed are hand-encoded rather than pulled in behind a client library.

import { FULFILMENT_CHAINS } from "@routelock/chain";

/// `authorizationState(address,bytes32)`.
const AUTHORIZATION_STATE = "0xe94a0102";

/// `keccak256("AuthorizationUsed(address,bytes32)")`.
const AUTHORIZATION_USED =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

export type AuthorizationOutcome =
  /// The authorization was never relayed. No credit was retired and no money
  /// moved. Safe to prepare a fresh authorization and try again.
  | { readonly spent: false }
  /// The authorization was consumed. A credit was retired. `txHash` is the
  /// transaction that did it, recovered from the log rather than from the
  /// provider's report of it.
  | { readonly spent: true; readonly txHash: string; readonly blockNumber: number };

export interface RpcOptions {
  readonly rpcUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /// How far back to search for the consuming log. The default covers roughly
  /// a day on Base's two-second blocks, which is far longer than any
  /// authorization can survive — the endpoint expires them after 300 seconds.
  readonly lookbackBlocks?: number;
}

/// Did this authorization spend?
///
/// Two questions, in order. `authorizationState` is cheap and definitive about
/// *whether*; the log lookup answers *which transaction*, and is only worth
/// making once the first has said yes.
export async function authorizationOutcome(
  authorizer: string,
  nonce: string,
  options: RpcOptions = {},
): Promise<AuthorizationOutcome> {
  const base = FULFILMENT_CHAINS.base_mainnet;
  const rpcUrl = options.rpcUrl ?? process.env[base.rpcEnvVar] ?? base.defaultRpc;
  const doFetch = options.fetchImpl ?? fetch;
  const token = base.inputToken;

  const used = await rpc<string>(rpcUrl, doFetch, "eth_call", [
    {
      to: token,
      data: AUTHORIZATION_STATE + pad(authorizer) + pad(nonce),
    },
    "latest",
  ]);

  // A bool is ABI-encoded as a 32-byte word. Anything with a set bit is true;
  // comparing against the all-zero word rather than parsing avoids depending
  // on whether the node zero-pads or trims.
  if (/^0x0*$/.test(used)) return { spent: false };

  const head = Number(await rpc<string>(rpcUrl, doFetch, "eth_blockNumber", []));
  const lookback = options.lookbackBlocks ?? 43_200;
  const logs = await rpc<readonly RawLog[]>(rpcUrl, doFetch, "eth_getLogs", [
    {
      address: token,
      fromBlock: `0x${Math.max(0, head - lookback).toString(16)}`,
      toBlock: "latest",
      topics: [AUTHORIZATION_USED, `0x${pad(authorizer)}`, `0x${pad(nonce)}`],
    },
  ]);

  const log = logs[0];
  if (log === undefined) {
    // The chain says the nonce is spent but the consuming log is outside the
    // search window. Reporting "not spent" here would be the one wrong answer
    // — it is the answer that authorises a second retirement.
    throw new Error(
      `authorization ${nonce} for ${authorizer} is consumed on Base, but its ` +
        `AuthorizationUsed log was not found within ${lookback} blocks. The ` +
        `retirement happened; widen lookbackBlocks to recover its transaction. ` +
        `Do not treat this as an unspent authorization.`,
    );
  }

  return {
    spent: true,
    txHash: String(log.transactionHash),
    blockNumber: Number(log.blockNumber),
  };
}

interface RawLog {
  readonly transactionHash?: string;
  readonly blockNumber?: string;
}

async function rpc<T>(
  url: string,
  doFetch: typeof fetch,
  method: string,
  params: readonly unknown[],
): Promise<T> {
  const response = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (body.error) {
    throw new Error(`Base RPC ${method} failed: ${body.error.message ?? "unknown"}`);
  }
  if (body.result === undefined) {
    throw new Error(`Base RPC ${method} returned no result`);
  }
  return body.result;
}

/// Left-pad a hex value to a 32-byte word, without the `0x`.
export function pad(value: string): string {
  const hex = value.replace(/^0x/, "").toLowerCase();
  if (hex.length > 64 || !/^[0-9a-f]*$/.test(hex)) {
    throw new RangeError(`not a hex value that fits a 32-byte word: ${value}`);
  }
  return hex.padStart(64, "0");
}
