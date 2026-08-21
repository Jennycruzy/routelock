/// Akash's provider vocabulary, kept below the shared fulfilment port.
///
/// The adapter never invents a deployment id, provider, price or ingress URL.
/// Those values come from the Console API responses and are carried through
/// unchanged to the receipt and the on-chain commitment.

export interface AkashOrder {
  readonly entitlementTokenId: string;
  readonly classId: `0x${string}`;
  /** The SDL supplied by the operator, read from a file or another input. */
  readonly sdl: string;
  /** Human-readable workload purpose, supplied for the policy assessment. */
  readonly workloadDescription: string;
  /** Service key as it appears in the provider's status response. */
  readonly serviceName: string;
  /** Live acceptable-use document used by the compliance decision. */
  readonly acceptableUsePolicyUrl: string;
  /** Initial Akash managed-wallet deposit, in the provider's USD units. */
  readonly depositUsd: number;
  /** Optional exact provider address; omitted means choose the cheapest open bid. */
  readonly providerAddress?: string;
  /** Existing DSEQ for a non-spending quote/verification or a safe fulfilment resume. */
  readonly deploymentDseq?: string;
}

export interface AkashPolicyFacts {
  /** Canonical policy page supplied by the operator. */
  readonly url: string;
  /** Exact same-origin asset used when the canonical page is client-rendered. */
  readonly sourceUrl: string;
  readonly contentType: string;
  readonly retrievedAt: string;
  /** Exact response text. It is committed as evidence without re-serialising. */
  readonly text: string;
}

export interface AkashFacts {
  readonly workloadDescription: string;
  readonly serviceName: string;
  readonly sdl: string;
  readonly policy: AkashPolicyFacts;
}

export interface AkashLeaseId {
  readonly dseq: string;
  readonly gseq: number;
  readonly oseq: number;
  readonly provider: string;
}

export interface AkashPrice {
  readonly denom: string;
  /** Console API prices are decimal USD-style strings, not always integers. */
  readonly amount: string;
}

/**
 * Spendable Console credits, reserved deployment credits, and their total.
 * The Console API reports these as ACT micro-units (1,000,000 = 1 USD).
 */
export interface AkashBalances {
  readonly balance: number;
  readonly deployments: number;
  readonly total: number;
}

export interface AkashBid {
  readonly id: AkashLeaseId;
  readonly state: string;
  readonly price: AkashPrice;
}

export interface AkashServiceStatus {
  readonly readyReplicas: number;
  readonly availableReplicas: number;
  readonly replicas: number;
  readonly total: number;
  readonly uris: readonly string[];
}

export interface AkashLeaseStatus {
  readonly services: Readonly<Record<string, AkashServiceStatus>>;
  readonly forwardedPorts: unknown;
  readonly ips: unknown;
}

export interface AkashLease {
  readonly id: AkashLeaseId;
  readonly state: string;
  readonly price: AkashPrice;
  readonly status?: AkashLeaseStatus;
}

export interface AkashDeploymentSnapshot {
  readonly deployment: {
    readonly dseq: string;
    readonly state: string;
  };
  readonly leases: readonly AkashLease[];
  readonly escrowAccount: unknown;
}

export class AkashError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`${endpoint} → ${status}: ${message}`);
    this.name = "AkashError";
  }
}

/** Compare two non-negative decimal strings without floating-point rounding. */
export function compareDecimalStrings(left: string, right: string): -1 | 0 | 1 {
  const parse = (value: string): readonly [string, string] => {
    if (!/^\d+(?:\.\d+)?$/.test(value)) {
      throw new AkashError(`invalid non-negative decimal amount: ${value}`, 200, "price");
    }
    const [integer = "0", fraction = ""] = value.split(".");
    return [integer.replace(/^0+(?=\d)/, ""), fraction.replace(/0+$/, "")];
  };
  const [leftInteger, leftFraction] = parse(left);
  const [rightInteger, rightFraction] = parse(right);
  if (leftInteger.length !== rightInteger.length) return leftInteger.length < rightInteger.length ? -1 : 1;
  if (leftInteger !== rightInteger) return leftInteger < rightInteger ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  const leftPadded = leftFraction.padEnd(width, "0");
  const rightPadded = rightFraction.padEnd(width, "0");
  if (leftPadded === rightPadded) return 0;
  return leftPadded < rightPadded ? -1 : 1;
}

/** Normalize the host-only ingress values returned by some Akash providers. */
export function normalizeIngressUrl(value: string): string {
  const raw = value.trim();
  if (raw === "") return "";
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AkashError(`provider ingress is not a valid URL: ${value}`, 200, "ingress");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AkashError(`provider ingress must use HTTP or HTTPS: ${value}`, 200, "ingress");
  }
  return parsed.toString();
}

export function leaseRef(id: AkashLeaseId, serviceName?: string): string {
  const base = `${id.dseq}:${id.gseq}:${id.oseq}:${id.provider}`;
  return serviceName === undefined ? base : `${base}#${encodeURIComponent(serviceName)}`;
}

export function parseLeaseRef(value: string): AkashLeaseId & { readonly serviceName?: string } {
  const [base, encodedService, ...hashRest] = value.split("#");
  const [dseq, rawGseq, rawOseq, provider, ...rest] = (base ?? "").split(":");
  if (
    hashRest.length > 0 ||
    rest.length > 0 ||
    dseq === undefined ||
    !/^\d+$/.test(dseq) ||
    rawGseq === undefined ||
    !/^\d+$/.test(rawGseq) ||
    rawOseq === undefined ||
    !/^\d+$/.test(rawOseq) ||
    provider === undefined ||
    provider.length === 0 ||
    (encodedService !== undefined && encodedService.length === 0)
  ) {
    throw new AkashError(
      `invalid lease reference ${JSON.stringify(value)} — expected dseq:gseq:oseq:provider`,
      0,
      "lease-ref",
    );
  }
  let serviceName: string | undefined;
  if (encodedService !== undefined) {
    try {
      serviceName = decodeURIComponent(encodedService);
    } catch {
      throw new AkashError(
        `invalid encoded service name in ${JSON.stringify(value)}`,
        0,
        "lease-ref",
      );
    }
    if (serviceName.length === 0) {
      throw new AkashError("service name in lease reference is empty", 0, "lease-ref");
    }
  }
  return {
    dseq,
    gseq: Number(rawGseq),
    oseq: Number(rawOseq),
    provider,
    ...(serviceName === undefined ? {} : { serviceName }),
  };
}
