/// The live Akash Console API transport.
///
/// This client has no recorded responses, fixture mode, or default API key.
/// Every successful value used by the adapter came from the response body that
/// is also retained as raw text for the fulfilment receipt.

import {
  AkashError,
  type AkashBid,
  type AkashBalances,
  type AkashDeploymentSnapshot,
  type AkashLease,
  type AkashLeaseId,
  type AkashPrice,
} from "./types.ts";

export interface AkashProvider {
  readonly owner: string;
  readonly hostUri: string;
  readonly isOnline: boolean;
  readonly name: string | null;
}

interface RawResponse<T> {
  readonly body: T;
  readonly raw: string;
}

interface AkashClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AkashError(`expected object for ${label}`, 200, label);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AkashError(`missing string ${label}`, 200, label);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AkashError(`missing finite number ${label}`, 200, label);
  }
  return value;
}

function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new AkashError(`missing array ${label}`, 200, label);
  return value;
}

function price(value: unknown, label: string): AkashPrice {
  const object = record(value, label);
  const amount = stringValue(object["amount"], `${label}.amount`);
  if (!/^\d+(?:\.\d+)?$/.test(amount)) {
    throw new AkashError(`price amount is not a non-negative decimal: ${amount}`, 200, label);
  }
  return {
    denom: stringValue(object["denom"], `${label}.denom`),
    amount,
  };
}

function leaseId(value: unknown, label: string): AkashLeaseId {
  const object = record(value, label);
  return {
    dseq: stringValue(object["dseq"], `${label}.dseq`),
    gseq: numberValue(object["gseq"], `${label}.gseq`),
    oseq: numberValue(object["oseq"], `${label}.oseq`),
    provider: stringValue(object["provider"], `${label}.provider`),
  };
}

function serviceStatus(value: unknown, label: string) {
  const object = record(value, label);
  const uris = arrayValue(object["uris"], `${label}.uris`).filter(
    (uri): uri is string => typeof uri === "string" && uri.length > 0,
  );
  return {
    readyReplicas: numberValue(object["ready_replicas"], `${label}.ready_replicas`),
    availableReplicas: numberValue(object["available_replicas"], `${label}.available_replicas`),
    replicas: numberValue(object["replicas"], `${label}.replicas`),
    total: numberValue(object["total"], `${label}.total`),
    uris,
  };
}

function leaseStatus(value: unknown, label: string) {
  const object = record(value, label);
  const servicesObject = record(object["services"], `${label}.services`);
  const services: Record<string, ReturnType<typeof serviceStatus>> = {};
  for (const [name, service] of Object.entries(servicesObject)) {
    services[name] = serviceStatus(service, `${label}.services.${name}`);
  }
  return {
    services,
    forwardedPorts: object["forwarded_ports"],
    ips: object["ips"],
  };
}

function parseLease(value: unknown, label: string): AkashLease {
  const object = record(value, label);
  const statusValue = object["status"];
  return {
    id: leaseId(object["id"], `${label}.id`),
    state: stringValue(object["state"], `${label}.state`),
    price: price(object["price"], `${label}.price`),
    ...(statusValue === undefined || statusValue === null
      ? {}
      : { status: leaseStatus(statusValue, `${label}.status`) }),
  };
}

function deploymentSnapshot(value: unknown, endpoint: string): AkashDeploymentSnapshot {
  const root = record(value, endpoint);
  const deployment = record(root["deployment"], `${endpoint}.deployment`);
  const id = record(deployment["id"], `${endpoint}.deployment.id`);
  const leases = arrayValue(root["leases"], `${endpoint}.leases`).map((lease, index) =>
    parseLease(lease, `${endpoint}.leases[${index}]`),
  );
  return {
    deployment: {
      dseq: stringValue(id["dseq"], `${endpoint}.deployment.id.dseq`),
      state: stringValue(deployment["state"], `${endpoint}.deployment.state`),
    },
    leases,
    escrowAccount: root["escrow_account"],
  };
}

function parseEnvelope(body: unknown, endpoint: string): unknown {
  const root = record(body, endpoint);
  if (!("data" in root)) throw new AkashError(`response has no data field`, 200, endpoint);
  return root["data"];
}

export class AkashClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: AkashClientOptions) {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!/^https:\/\//.test(baseUrl)) {
      throw new AkashError(`Console API URL must use HTTPS: ${baseUrl}`, 0, "constructor");
    }
    if (options.apiKey.length === 0) throw new AkashError("AKASH_API_KEY is empty", 0, "constructor");
    this.#baseUrl = baseUrl;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #request<T>(
    path: string,
    init: RequestInit = {},
    authenticated = true,
  ): Promise<RawResponse<T>> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (authenticated) headers.set("x-api-key", this.#apiKey);
    if (init.body !== undefined) headers.set("content-type", "application/json");

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
    });
    const raw = await response.text();
    if (!response.ok) throw new AkashError(raw, response.status, path);
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      throw new AkashError(`response was not JSON: ${raw.slice(0, 300)}`, response.status, path);
    }
    return { body: body as T, raw };
  }

  async createDeployment(sdl: string, depositUsd: number): Promise<{
    readonly dseq: string;
    readonly manifest: string;
    readonly raw: string;
  }> {
    const response = await this.#request<unknown>("/v1/deployments", {
      method: "POST",
      body: JSON.stringify({ data: { sdl, deposit: depositUsd } }),
    });
    const data = record(parseEnvelope(response.body, "/v1/deployments"), "/v1/deployments.data");
    return {
      dseq: stringValue(data["dseq"], "/v1/deployments.data.dseq"),
      manifest: stringValue(data["manifest"], "/v1/deployments.data.manifest"),
      raw: response.raw,
    };
  }

  async getBalances(): Promise<{ readonly balances: AkashBalances; readonly raw: string }> {
    const response = await this.#request<unknown>("/v1/balances");
    const data = record(parseEnvelope(response.body, "/v1/balances"), "/v1/balances.data");
    return {
      balances: {
        balance: numberValue(data["balance"], "/v1/balances.data.balance"),
        deployments: numberValue(data["deployments"], "/v1/balances.data.deployments"),
        total: numberValue(data["total"], "/v1/balances.data.total"),
      },
      raw: response.raw,
    };
  }

  async listBids(dseq: string): Promise<{ readonly bids: readonly AkashBid[]; readonly raw: string }> {
    const response = await this.#request<unknown>(`/v1/bids?dseq=${encodeURIComponent(dseq)}`);
    const rows = arrayValue(parseEnvelope(response.body, "/v1/bids"), "/v1/bids.data");
    const bids = rows.map((row, index) => {
      const wrapper = record(row, `/v1/bids.data[${index}]`);
      const bid = record(wrapper["bid"], `/v1/bids.data[${index}].bid`);
      return {
        id: leaseId(bid["id"], `/v1/bids.data[${index}].bid.id`),
        state: stringValue(bid["state"], `/v1/bids.data[${index}].bid.state`),
        price: price(bid["price"], `/v1/bids.data[${index}].bid.price`),
      };
    });
    return { bids, raw: response.raw };
  }

  async createLease(manifest: string, bid: AkashBid): Promise<{
    readonly deployment: AkashDeploymentSnapshot;
    readonly raw: string;
  }> {
    const response = await this.#request<unknown>("/v1/leases", {
      method: "POST",
      body: JSON.stringify({
        manifest,
        leases: [{ ...bid.id }],
      }),
    });
    const data = parseEnvelope(response.body, "/v1/leases");
    return { deployment: deploymentSnapshot(data, "/v1/leases.data"), raw: response.raw };
  }

  async getDeployment(dseq: string): Promise<{
    readonly deployment: AkashDeploymentSnapshot;
    readonly raw: string;
  }> {
    const response = await this.#request<unknown>(`/v1/deployments/${encodeURIComponent(dseq)}`);
    const data = parseEnvelope(response.body, "/v1/deployments/:dseq");
    return {
      deployment: deploymentSnapshot(data, "/v1/deployments/:dseq.data"),
      raw: response.raw,
    };
  }

  async getProvider(address: string): Promise<{ readonly provider: AkashProvider; readonly raw: string }> {
    const response = await this.#request<unknown>(
      `/v1/providers/${encodeURIComponent(address)}`,
      {},
      false,
    );
    const provider = record(response.body, "/v1/providers/:address");
    return {
      provider: {
        owner: stringValue(provider["owner"], "/v1/providers/:address.owner"),
        hostUri: stringValue(provider["hostUri"], "/v1/providers/:address.hostUri"),
        isOnline: provider["isOnline"] === true,
        name: typeof provider["name"] === "string" ? provider["name"] : null,
      },
      raw: response.raw,
    };
  }

  async closeDeployment(dseq: string): Promise<{ readonly raw: string }> {
    const response = await this.#request<unknown>(`/v1/deployments/${encodeURIComponent(dseq)}`, {
      method: "DELETE",
    });
    return { raw: response.raw };
  }
}
