import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAINS } from "@routelock/chain";
import { AkashAdapter } from "./adapter.ts";
import { AkashClient } from "./client.ts";
import { AkashError, compareDecimalStrings, leaseRef, normalizeIngressUrl, parseLeaseRef } from "./types.ts";

test("lease references preserve the complete provider lease identity", () => {
  const id = { dseq: "123", gseq: 2, oseq: 1, provider: "akash1provider" } as const;
  assert.equal(leaseRef(id, "inference-api"), "123:2:1:akash1provider#inference-api");
  assert.deepEqual(parseLeaseRef(leaseRef(id, "inference-api")), { ...id, serviceName: "inference-api" });
});

test("malformed lease references refuse rather than guessing", () => {
  assert.throws(
    () => parseLeaseRef("123:2:1"),
    (error: unknown) => error instanceof AkashError && error.message.includes("expected dseq:gseq:oseq:provider"),
  );
  assert.throws(() => parseLeaseRef("123:two:1:akash1provider"), AkashError);
});

test("decimal provider prices compare without floating-point rounding", () => {
  assert.equal(compareDecimalStrings("2.930853000000000000", "2.94"), -1);
  assert.equal(compareDecimalStrings("2.930853", "2.930853000000000000"), 0);
  assert.equal(compareDecimalStrings("10", "9.999999"), 1);
  assert.throws(() => compareDecimalStrings("2e-3", "1"), AkashError);
});

test("host-only provider ingress is normalized to HTTPS", () => {
  assert.equal(
    normalizeIngressUrl("o0mv5es8lhbs1652l9fdvb8ggo.ingress.boogle.cloud"),
    "https://o0mv5es8lhbs1652l9fdvb8ggo.ingress.boogle.cloud/",
  );
  assert.equal(normalizeIngressUrl("http://provider.example/health"), "http://provider.example/health");
  assert.throws(() => normalizeIngressUrl("ftp://provider.example"), AkashError);
});

test("the Console API accepts decimal bid prices", async () => {
  const client = new AkashClient({
    baseUrl: "https://console-api.example.test",
    apiKey: "operator-supplied",
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{
        bid: {
          id: { dseq: "123", gseq: 1, oseq: 1, provider: "akash1provider" },
          state: "open",
          price: { denom: "uakt", amount: "2.930853000000000000" },
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const { bids } = await client.listBids("123");
  assert.equal(bids[0]?.price.amount, "2.930853000000000000");
});

test("the Console API exposes available and deployment-reserved credits", async () => {
  const client = new AkashClient({
    baseUrl: "https://console-api.example.test",
    apiKey: "operator-supplied",
    fetchImpl: async () => new Response(JSON.stringify({
      data: { balance: 456997, deployments: 500000, total: 956997 },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const { balances } = await client.getBalances();
  assert.deepEqual(balances, { balance: 456997, deployments: 500000, total: 956997 });
});

test("the Akash adapter binds to the compute lane and rejects X Layer", () => {
  const client = new AkashClient({ baseUrl: "https://console-api.example.test", apiKey: "operator-supplied" });
  const options = {
    client,
    bidPollMs: 100,
    bidTimeoutMs: 1_000,
    readinessPollMs: 100,
    readinessTimeoutMs: 1_000,
  } as const;
  assert.throws(() => new AkashAdapter(CHAINS.xlayer_testnet, options), /does not allow the compute fulfilment lane/);
  const adapter = new AkashAdapter(CHAINS.botchain_testnet, options);
  assert.equal(adapter.vertical, "compute");
  assert.equal(adapter.live, true);
  assert.equal(adapter.status, "in_development");
});

test("policy assessment follows the official same-origin terms bundle", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://console.example.test/terms-of-service") {
      return new Response(
        '<html><script src="/_next/static/chunks/pages/terms-of-service-abc.js"></script></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response("Akash Network Terms of Service — Prohibited Use", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
  };
  const adapter = new AkashAdapter(CHAINS.botchain_testnet, {
    client: new AkashClient({ baseUrl: "https://console-api.example.test", apiKey: "operator-supplied" }),
    bidPollMs: 100,
    bidTimeoutMs: 1_000,
    readinessPollMs: 100,
    readinessTimeoutMs: 1_000,
    fetchImpl,
  });
  const facts = await adapter.assess({
    entitlementTokenId: "1",
    classId: "0x0000000000000000000000000000000000000000000000000000000000000001",
    sdl: "services: {}",
    workloadDescription: "public web service",
    serviceName: "web",
    acceptableUsePolicyUrl: "https://console.example.test/terms-of-service",
    depositUsd: 0.5,
  });
  assert.deepEqual(calls, [
    "https://console.example.test/terms-of-service",
    "https://console.example.test/_next/static/chunks/pages/terms-of-service-abc.js",
  ]);
  assert.equal(facts.policy.url, "https://console.example.test/terms-of-service");
  assert.equal(facts.policy.sourceUrl, "https://console.example.test/_next/static/chunks/pages/terms-of-service-abc.js");
  assert.match(facts.policy.text, /Prohibited Use/);
});
