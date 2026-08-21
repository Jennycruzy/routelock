/// Akash compute leasing over the live Console API.
///
/// Status: IN DEVELOPMENT. The adapter is wired to real API responses, but it
/// is not Active until a real lease produces a public ingress proof.
/// Chain: BOT Chain only. The shared chain guard rejects this adapter on X Layer.

import { assertVerticalAllowed, type ChainConfig } from "@routelock/chain";
import type {
  Approved,
  FulfilmentAdapter,
  FulfilmentQuote,
  Receipt,
  VerificationResult,
} from "@routelock/fulfilment";
import { AkashClient } from "./client.ts";
import {
  AkashError,
  leaseRef,
  parseLeaseRef,
  type AkashBid,
  type AkashDeploymentSnapshot,
  type AkashFacts,
  type AkashLease,
  type AkashOrder,
  compareDecimalStrings,
  normalizeIngressUrl,
} from "./types.ts";

export interface AkashAdapterOptions {
  readonly client: AkashClient;
  readonly bidPollMs: number;
  readonly bidTimeoutMs: number;
  readonly readinessPollMs: number;
  readonly readinessTimeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new AkashError(`${name} must be positive`, 0, "adapter");
}

function assertOrder(order: AkashOrder): void {
  if (order.sdl.trim() === "") throw new AkashError("SDL is empty", 0, "order");
  if (order.workloadDescription.trim() === "") throw new AkashError("workload description is empty", 0, "order");
  if (order.serviceName.trim() === "") throw new AkashError("service name is empty", 0, "order");
  if (!/^https:\/\//.test(order.acceptableUsePolicyUrl)) {
    throw new AkashError("acceptable-use policy URL must use HTTPS", 0, "order");
  }
  assertPositive(order.depositUsd, "depositUsd");
}

function containsSubstantivePolicy(text: string): boolean {
  // The managed Console serves this page through a client-rendered shell. The
  // page bundle is still the official source rendered by that URL; requiring
  // these two headings prevents us from treating a shell or error page as a
  // policy document.
  return text.includes("Akash Network Terms of Service") && text.includes("Prohibited Use");
}

function linkedTermsScripts(pageUrl: string, html: string): readonly URL[] {
  const page = new URL(pageUrl);
  const scripts: URL[] = [];
  for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const source = new URL(raw, page);
    if (source.origin === page.origin && /terms-of-service/i.test(source.pathname)) {
      scripts.push(source);
    }
  }
  return scripts;
}

async function retrievePolicy(
  fetchImpl: typeof fetch,
  policyUrl: string,
): Promise<{
  readonly canonicalUrl: string;
  readonly sourceUrl: string;
  readonly contentType: string;
  readonly text: string;
}> {
  const response = await fetchImpl(policyUrl, {
    headers: { accept: "text/plain, text/html;q=0.9" },
    redirect: "follow",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AkashError(text, response.status, policyUrl);
  }
  if (text.trim() === "") {
    throw new AkashError("acceptable-use policy response is empty", response.status, response.url);
  }
  if (containsSubstantivePolicy(text)) {
    return {
      canonicalUrl: policyUrl,
      sourceUrl: response.url || policyUrl,
      contentType: response.headers.get("content-type") ?? "",
      text,
    };
  }

  // Follow only a same-origin script explicitly named for this policy page.
  // This handles the live Next.js page without accepting arbitrary third-party
  // content or inventing a local copy of the terms.
  const resolvedPageUrl = response.url || policyUrl;
  for (const source of linkedTermsScripts(resolvedPageUrl, text)) {
    const scriptResponse = await fetchImpl(source, {
      headers: { accept: "text/javascript, application/javascript;q=0.9, text/plain;q=0.8" },
      redirect: "follow",
    });
    const scriptText = await scriptResponse.text();
    if (scriptResponse.ok && containsSubstantivePolicy(scriptText)) {
      return {
        canonicalUrl: policyUrl,
        sourceUrl: scriptResponse.url || source.toString(),
        contentType: scriptResponse.headers.get("content-type") ?? "",
        text: scriptText,
      };
    }
  }
  throw new AkashError(
    "response did not contain substantive Akash terms and no same-origin terms asset was found",
    response.status,
    response.url,
  );
}

function findLease(snapshot: AkashDeploymentSnapshot, id: ReturnType<typeof parseLeaseRef>): AkashLease | undefined {
  return snapshot.leases.find(
    (lease) =>
      lease.id.dseq === id.dseq &&
      lease.id.gseq === id.gseq &&
      lease.id.oseq === id.oseq &&
      lease.id.provider === id.provider,
  );
}

function chooseBid(bids: readonly AkashBid[], providerAddress: string | undefined): AkashBid | undefined {
  const candidates = bids.filter(
    (bid) =>
      bid.state === "open" &&
      (providerAddress === undefined || bid.id.provider.toLowerCase() === providerAddress.toLowerCase()),
  );
  return candidates.reduce<AkashBid | undefined>((best, bid) => {
    if (best === undefined) return bid;
    return compareDecimalStrings(bid.price.amount, best.price.amount) < 0 ? bid : best;
  }, undefined);
}

function numericPrice(amount: string, label: string): number {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) {
    throw new AkashError(`provider price is not a finite non-negative number: ${amount}`, 200, label);
  }
  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class AkashAdapter implements FulfilmentAdapter<AkashOrder, AkashFacts> {
  readonly name = "Akash";
  readonly vertical = "compute" as const;
  readonly status = "in_development" as const;
  readonly live = true;
  readonly reversible = true;

  readonly #client: AkashClient;
  readonly #bidPollMs: number;
  readonly #bidTimeoutMs: number;
  readonly #readinessPollMs: number;
  readonly #readinessTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(chain: ChainConfig, options: AkashAdapterOptions) {
    assertVerticalAllowed(chain, "compute");
    assertPositive(options.bidPollMs, "bidPollMs");
    assertPositive(options.bidTimeoutMs, "bidTimeoutMs");
    assertPositive(options.readinessPollMs, "readinessPollMs");
    assertPositive(options.readinessTimeoutMs, "readinessTimeoutMs");
    this.#client = options.client;
    this.#bidPollMs = options.bidPollMs;
    this.#bidTimeoutMs = options.bidTimeoutMs;
    this.#readinessPollMs = options.readinessPollMs;
    this.#readinessTimeoutMs = options.readinessTimeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async quote(order: AkashOrder): Promise<readonly FulfilmentQuote[]> {
    assertOrder(order);
    if (order.deploymentDseq === undefined) {
      throw new AkashError(
        "Akash quotes require an existing deploymentDseq; creating a deployment consumes provider funds and belongs to fulfil()",
        0,
        "quote",
      );
    }
    const { deployment } = await this.#client.getDeployment(order.deploymentDseq);
    return deployment.leases
      .filter((lease) => lease.state === "active")
      .map((lease) => ({
        ref: leaseRef(lease.id),
        providerName: lease.id.provider,
        currency: `${lease.price.denom}/block`,
        total: numericPrice(lease.price.amount, "quote.lease.price.amount"),
        live: true,
      }));
  }

  async assess(order: AkashOrder): Promise<AkashFacts> {
    assertOrder(order);
    const policy = await retrievePolicy(this.#fetch, order.acceptableUsePolicyUrl);
    return {
      workloadDescription: order.workloadDescription,
      serviceName: order.serviceName,
      sdl: order.sdl,
      policy: {
        url: policy.canonicalUrl,
        sourceUrl: policy.sourceUrl,
        contentType: policy.contentType,
        retrievedAt: new Date().toISOString(),
        text: policy.text,
      },
    };
  }

  async fulfil(approved: Approved<AkashOrder>): Promise<Receipt> {
    const order = approved.order;
    assertOrder(order);

    if (order.deploymentDseq !== undefined) {
      const { deployment } = await this.#client.getDeployment(order.deploymentDseq);
      const lease = deployment.leases.find(
        (candidate) => candidate.state === "active" &&
          (order.providerAddress === undefined ||
            candidate.id.provider.toLowerCase() === order.providerAddress.toLowerCase()),
      );
      if (lease === undefined) {
        throw new AkashError(
          `deployment ${order.deploymentDseq} has no active lease to resume`,
          409,
          "/v1/deployments/:dseq",
        );
      }
      const ready = await this.#waitForReady(order.deploymentDseq, lease.id, order.serviceName);
      const provider = await this.#client.getProvider(lease.id.provider);
      if (provider.provider.owner.toLowerCase() !== lease.id.provider.toLowerCase()) {
        throw new AkashError(
          `provider lookup returned ${provider.provider.owner}, expected ${lease.id.provider}`,
          502,
          "/v1/providers/:address",
        );
      }
      return {
        ref: leaseRef(ready.lease.id, order.serviceName),
        rawResponse: ready.raw,
        proofUrl: ready.proofUrl,
        amountCharged: numericPrice(ready.lease.price.amount, "lease.price.amount"),
        currency: `${ready.lease.price.denom}/block`,
        live: true,
      };
    }

    const created = await this.#client.createDeployment(order.sdl, order.depositUsd);
    let leaseAttempted = false;
    try {
      const deadline = Date.now() + this.#bidTimeoutMs;
      let bid: AkashBid | undefined;
      while (Date.now() < deadline && bid === undefined) {
        const { bids } = await this.#client.listBids(created.dseq);
        bid = chooseBid(bids, order.providerAddress);
        if (bid === undefined) await sleep(this.#bidPollMs);
      }
      if (bid === undefined) {
        throw new AkashError(
          `no eligible open bid arrived before timeout for dseq ${created.dseq}; deployment will be closed`,
          408,
          "/v1/bids",
        );
      }

      // Once this POST is attempted, the Console API may have accepted the
      // lease even if a response is lost. Leave the deployment inspectable on
      // every ambiguous post-lease failure rather than closing a real job.
      leaseAttempted = true;
      await this.#client.createLease(created.manifest, bid);
      const ready = await this.#waitForReady(created.dseq, bid.id, order.serviceName);
      const provider = await this.#client.getProvider(bid.id.provider);
      if (provider.provider.owner.toLowerCase() !== bid.id.provider.toLowerCase()) {
        throw new AkashError(
          `provider lookup returned ${provider.provider.owner}, expected ${bid.id.provider}`,
          502,
          "/v1/providers/:address",
        );
      }

      const amountCharged = numericPrice(ready.lease.price.amount, "lease.price.amount");
      return {
        ref: leaseRef(ready.lease.id, order.serviceName),
        rawResponse: ready.raw,
        proofUrl: ready.proofUrl,
        amountCharged,
        currency: `${ready.lease.price.denom}/block`,
        live: true,
      };
    } catch (error) {
      // A deployment with no lease is safe to close and refund. Once a lease
      // exists, leave it visible for operator inspection instead of killing a
      // real workload after a readiness timeout.
      if (!leaseAttempted) {
        try {
          await this.#client.closeDeployment(created.dseq);
        } catch (cleanupError) {
          throw new AkashError(
            `deployment ${created.dseq} failed and cleanup also failed: ${String(cleanupError)}`,
            500,
            "fulfil",
          );
        }
      }
      throw error;
    }
  }

  async verify(ref: string): Promise<VerificationResult> {
    const id = parseLeaseRef(ref);
    const { deployment } = await this.#client.getDeployment(id.dseq);
    const lease = findLease(deployment, id);
    if (lease === undefined) {
      return { found: false, state: "not_found", proofUrl: "", checkedAt: new Date().toISOString(), live: true };
    }
    const services = lease.status?.services ?? {};
    const serviceName = id.serviceName ?? (Object.keys(services).length === 1 ? Object.keys(services)[0] : undefined);
    const service = serviceName === undefined ? undefined : services[serviceName];
    const rawProofUrl = service?.uris[0] ?? "";
    const proofUrl = rawProofUrl === "" ? "" : normalizeIngressUrl(rawProofUrl);
    const replicas = service;
    const ready =
      lease.state === "active" &&
      replicas !== undefined &&
      replicas.total > 0 &&
      replicas.readyReplicas >= replicas.total &&
      proofUrl !== "";
    if (!ready) {
      return { found: false, state: lease.state, proofUrl, checkedAt: new Date().toISOString(), live: true };
    }
    const probe = await this.#fetch(proofUrl, { redirect: "follow" });
    await probe.arrayBuffer();
    return {
      found: probe.status >= 200 && probe.status < 400,
      state: lease.state,
      proofUrl,
      checkedAt: new Date().toISOString(),
      live: true,
    };
  }

  async #waitForReady(
    dseq: string,
    id: ReturnType<typeof parseLeaseRef>,
    serviceName: string,
  ): Promise<{ readonly lease: AkashLease; readonly proofUrl: string; readonly raw: string }> {
    const deadline = Date.now() + this.#readinessTimeoutMs;
    let lastState = "unknown";
    while (Date.now() < deadline) {
      const { deployment, raw } = await this.#client.getDeployment(dseq);
      const lease = findLease(deployment, id);
      lastState = lease?.state ?? "lease_not_visible";
      const service = lease?.status?.services[serviceName];
      const rawProofUrl = service?.uris[0] ?? "";
      const proofUrl = rawProofUrl === "" ? "" : normalizeIngressUrl(rawProofUrl);
      if (
        lease !== undefined &&
        lease.state === "active" &&
        service !== undefined &&
        service.total > 0 &&
        service.readyReplicas >= service.total &&
        proofUrl !== ""
      ) {
        const probe = await this.#fetch(proofUrl, { redirect: "follow" });
        await probe.arrayBuffer();
        if (probe.status >= 200 && probe.status < 400) return { lease, proofUrl, raw };
      }
      await sleep(this.#readinessPollMs);
    }
    throw new AkashError(
      `lease ${leaseRef(id)} did not become ready before timeout; last state ${lastState}; deployment ${dseq} remains open for inspection`,
      408,
      "/v1/deployments/:dseq",
    );
  }
}
