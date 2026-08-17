/// The retirements this system has actually performed.
///
/// `docs/adapters.md` sets one bar for an adapter being **Active**: deployed, and
/// one real fulfilment with a public proof URL. This endpoint is what lets a
/// stranger check that claim instead of reading it — each record is re-verified
/// against the provider at request time, and the certificate link goes to the
/// registry that issued the credit rather than to anything this project controls.
///
/// What is deliberately *not* served: the authorisation nonce and the internal
/// idempotency key. Neither tells a reader anything they cannot get from the
/// transaction itself, and a ledger is operational state rather than evidence.
///
/// The check that matters, and the one this project learned the hard way: a
/// receipt that exists is not a receipt that is recent. A test-mode retirement
/// once returned `COMPLETED`, a real transaction hash and a real certificate —
/// for a retirement performed in April 2024 by somebody else. So the block
/// distance is computed and served, and a transaction that is not recent is
/// reported as stale rather than shown as proof.

import { createPublicClient, http } from "viem";
import type { Address } from "viem";
import { FULFILMENT_CHAINS } from "@routelock/chain";
import type { CarbonmarkX402Adapter, RetirementLedger } from "@routelock/carbon";

export interface FulfilmentRecord {
  readonly tonnes: number;
  readonly carbonClass: string;
  readonly beneficiary: string;
  readonly chargedUsdc: number;
  readonly at: string;
  readonly txHash: string;
  readonly proofUrl: string | null;
  /// Live re-verification through the provider, at request time.
  readonly providerState: string | null;
  readonly providerFound: boolean | null;
  /// The payment chain's own view of the transaction.
  readonly settlementChain: string;
  readonly block: string | null;
  readonly blocksBehindHead: string | null;
  readonly minedAt: string | null;
  readonly recent: boolean | null;
  readonly note?: string;
}

/// A transaction older than this many blocks on the payment chain is not
/// evidence for a retirement requested minutes ago. Base produces a block every
/// two seconds, so this is a little under a day — generous on purpose, because
/// the failure it catches was off by 36 million blocks, not by a few thousand.
const RECENT_BLOCKS = 40_000n;

export async function readFulfilments(
  ledger: RetirementLedger,
  adapter: CarbonmarkX402Adapter,
): Promise<{ readonly count: number; readonly records: readonly FulfilmentRecord[] }> {
  const settled = ledger.all().filter((r) => r.state === "settled" && r.txHash !== undefined);

  // The payment chain is the provider's, not RouteLock's. Read from its own
  // config entry rather than a literal, so this cannot drift from the adapter.
  const paymentChain = FULFILMENT_CHAINS.base_mainnet;
  const client = createPublicClient({
    chain: {
      id: paymentChain.chainId,
      name: paymentChain.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [paymentChain.defaultRpc] } },
    },
    transport: http(paymentChain.defaultRpc),
  });

  const head = await client.getBlockNumber().catch(() => null);

  const records = await Promise.all(
    settled.map(async (record): Promise<FulfilmentRecord> => {
      const txHash = record.txHash as `0x${string}`;

      const [verification, receipt] = await Promise.all([
        adapter.verify(txHash).catch(() => null),
        client.getTransactionReceipt({ hash: txHash }).catch(() => null),
      ]);

      const block = receipt?.blockNumber ?? null;
      const minedBlock =
        block === null
          ? null
          : await client.getBlock({ blockNumber: block }).catch(() => null);

      const behind = block !== null && head !== null ? head - block : null;

      return {
        tonnes: record.tonnes,
        carbonClass: record.carbonClass,
        beneficiary: record.beneficiaryAddress as Address,
        chargedUsdc: record.authValueUsdc,
        at: record.at,
        txHash,
        proofUrl: verification?.proofUrl ?? record.certificateUrl ?? null,
        providerState: verification?.state ?? null,
        providerFound: verification?.found ?? null,
        settlementChain: `${paymentChain.name} (${paymentChain.chainId})`,
        block: block?.toString() ?? null,
        blocksBehindHead: behind?.toString() ?? null,
        minedAt:
          minedBlock === null ? null : new Date(Number(minedBlock.timestamp) * 1000).toISOString(),
        recent: behind === null ? null : behind < RECENT_BLOCKS,
        ...(behind !== null && behind >= RECENT_BLOCKS
          ? {
              note:
                "This transaction is too old to be evidence for a recent request. " +
                "Treat it as stale, not as proof — a shared placeholder receipt is " +
                "exactly what this check exists to catch.",
            }
          : {}),
      };
    }),
  );

  return { count: records.length, records };
}
