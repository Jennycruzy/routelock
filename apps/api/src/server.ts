/// The RouteLock API.
///
/// Serves three kinds of thing, and nothing else:
///
///   1. **Live chain state** — addresses, bytecode, totals, the role graph, and
///      the escrow's live refusal to grant `COMPLIANCE_ROLE`. Every value is an
///      `eth_call` against a real deployment.
///   2. **Real rulings** — the compliance engine, against real inference and real
///      carbon inventory, budget-capped and rate-limited.
///   3. **The audit trail** — what the registry holds for any token, with the
///      `cast` command to re-read it without this server.
///
/// Consumer checkout is deliberately split: the browser wallet owns the
/// consumer's X Layer entitlement transactions, while this process may hold
/// only the deployment's compliance and oracle/retirement relayer identities.
/// The configured RouteLock relayer signs the issuer-side Base USDC retirement;
/// the customer never signs or pays on Base. `consumer.ts` checks those role
/// addresses against the deployment before it can write anything. The selected
/// chain still fixes the lane: X Layer serves carbon and BOT serves compute.
///
/// There is no framework here on purpose: `node:http` and viem are enough, and a
/// dependency that has to be audited before a submission is a cost.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { keccak256, toBytes } from "viem";

import { loadDotEnv, repoRoot } from "@routelock/chain";
import {
  ComplianceEngine,
  configFromEnv,
  ENGINE_VERSION,
  CARBON_ENGINE_VERSION,
  InferenceBudgetExceeded,
  ledgerPath,
} from "@routelock/compliance";
import {
  DuplicateRetirement,
  RetirementLedger,
  SpendCapExceeded,
  X402Error,
  capsFromEnv as retirementCaps,
} from "@routelock/carbon";

import { assertChainMatches, loadChainContext } from "./chain.ts";
import { readFulfilments } from "./fulfilment.ts";
import { checkGuarantee } from "./guarantee.ts";
import { replay } from "./replay.ts";
import {
  BadRequest,
  parseClassificationRequest,
  readOnlyCarbonAdapter,
  ruleOnCarbon,
  ruleOnGoods,
  THRESHOLDS,
} from "./rule.ts";
import { readState } from "./state.ts";
import { RateLimiter, reportBudget, servedBudget, servedCaps } from "./spend.ts";
import { ConsumerError, ConsumerService } from "./consumer.ts";

const loaded = loadDotEnv();

// Local development uses ROUTELOCK_API_PORT. Hosted Node services (including
// Render) provide PORT, so the same process can be deployed without a second
// adapter or a hard-coded public port.
const PORT = Number(process.env["ROUTELOCK_API_PORT"] ?? process.env["PORT"] ?? 8787);
const HOST = process.env["ROUTELOCK_API_HOST"] ?? "127.0.0.1";
// The live product is the X Layer carbon retirement. Testnet remains available
// by explicitly setting ROUTELOCK_CHAIN=xlayer_testnet for a read-only demo.
const CHAIN_KEY = process.env["ROUTELOCK_CHAIN"] ?? "xlayer_mainnet";
const WEB_ROOT = resolve(process.env["ROUTELOCK_WEB_ROOT"] ?? resolve(repoRoot(), "apps/web/public"));
const WEB_INDEX = process.env["ROUTELOCK_WEB_INDEX"] ?? "index.html";
const DATA_ROOT = resolve(process.env["ROUTELOCK_DATA_DIR"] ?? resolve(repoRoot(), "data"));
const dataFile = (name: string): string => resolve(DATA_ROOT, name);
const TRUST_PROXY = process.env["ROUTELOCK_TRUST_PROXY"] === "yes";

/// Model-backed endpoints get their own limiter, because they are the only ones
/// that cost money. Chain reads are cheap and are limited far more loosely.
const modelLimiter = new RateLimiter(
  Number(process.env["ROUTELOCK_RULE_LIMIT"] ?? 5),
  Number(process.env["ROUTELOCK_RULE_WINDOW_MS"] ?? 60 * 60 * 1000),
);
const readLimiter = new RateLimiter(240, 60 * 1000);

const context = loadChainContext(CHAIN_KEY);
const budget = servedBudget();
const caps = servedCaps();

/// Built once. `configFromEnv` throws when there is no API key, which is the
/// intended behaviour: an engine that cannot perform real inference must not
/// start, because the alternative is an endpoint that appears to work.
const inferenceConfig = configFromEnv();
const engine = new ComplianceEngine(inferenceConfig, { budget });
const retirements = new RetirementLedger(
  process.env["ROUTELOCK_RETIREMENTS_LEDGER"] ?? dataFile("retirements.jsonl"),
  retirementCaps(),
);
const carbon = context.chain.allowedVerticals.includes("carbon")
  ? readOnlyCarbonAdapter(context.chain, retirements)
  : null;
const consumer = new ConsumerService({
  context,
  budget,
  apiKey: inferenceConfig.apiKey,
  model: inferenceConfig.model,
  carbon,
  storePath: dataFile("consumer-orders.jsonl"),
  catalogPath: dataFile("consumer-catalog.jsonl"),
});

function callerOf(request: IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // Read-only JSON about a public chain, so any origin may read it. There is
    // nothing to protect here and no cookie or credential to leak.
    "access-control-allow-origin": "*",
  });
  response.end(json);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // A body larger than this is not a classification request. Refusing early
    // beats buffering whatever arrives.
    if (size > 16 * 1024) throw new BadRequest("request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new BadRequest("request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BadRequest) throw error;
    throw new BadRequest("request body is not valid JSON");
  }
}

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/// Serve the frontend. Paths are normalised and confined to `WEB_ROOT`: without
/// that check `GET /../../.env` reads a secret, which is the one bug in a static
/// file server that actually matters.
async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = pathname === "/"
    ? resolve(join(WEB_ROOT, WEB_INDEX))
    : resolve(join(WEB_ROOT, relative));

  if (!file.startsWith(WEB_ROOT)) {
    send(response, 403, { error: "path is outside the web root" });
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(WEB_ROOT, "index.html"); // single page: unknown paths render it
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(body);
  } catch {
    send(response, 404, { error: "not found" });
  }
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    // Last resort. A handler that throws must still answer, and the message is
    // the message — a served API that hides why it refused is not debuggable by
    // the person who most needs to know.
    if (!response.headersSent) {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const caller = callerOf(request);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    response.end();
    return;
  }

  if (!path.startsWith("/api/")) {
    if (request.method !== "GET") {
      send(response, 405, { error: "method not allowed" });
      return;
    }
    await serveStatic(path, response);
    return;
  }

  if (!readLimiter.take(caller)) {
    send(response, 429, { error: "too many requests" });
    return;
  }
  readLimiter.sweep();

  try {
    switch (`${request.method} ${path}`) {
      case "GET /api/health":
        send(response, 200, {
          ok: true,
          chain: CHAIN_KEY,
          engineVersions: { hs: ENGINE_VERSION, carbon: CARBON_ENGINE_VERSION },
          envValuesLoaded: loaded.length,
        });
        return;

      case "GET /api/state":
        send(response, 200, await readState(context));
        return;

      case "GET /api/guarantee":
        send(response, 200, await checkGuarantee(context));
        return;

      case "GET /api/budget":
        send(response, 200, {
          ...reportBudget(budget, caps),
          thresholds: THRESHOLDS,
          note:
            "The served endpoints spend from their own ledger, separate from the " +
            "operator's, so a visitor cannot drain the budget the end-to-end run " +
            "needs and cannot be starved by it.",
        });
        return;

      case "GET /api/fulfilment":
        if (carbon === null) {
          throw new ConsumerError(409, `${context.chain.name} is the BOT compute lane; carbon fulfilment is served by an X Layer API`);
        }
        // Re-verified against the provider on every request, not read from a
        // cache. A proof URL this project stored is a claim; a proof URL the
        // provider still confirms is evidence.
        send(response, 200, await readFulfilments(retirements, carbon));
        return;

      case "GET /api/carbon/inventory": {
        if (carbon === null) {
          throw new ConsumerError(409, `${context.chain.name} is the BOT compute lane; carbon inventory is served by an X Layer API`);
        }
        // Free: discovery and pricing cost no money and no signature.
        const classes = await carbon.discover();
        send(response, 200, {
          readAt: new Date().toISOString(),
          source: "Klima x402 endpoint, read live — no API key, no account",
          count: classes.length,
          classes,
        });
        return;
      }

      case "GET /api/consumer/capabilities":
        send(response, 200, await consumer.capabilities());
        return;

      case "GET /api/consumer/catalog":
        send(response, 200, await consumer.catalog());
        return;

      case "GET /api/merchant/capabilities":
        {
          const capabilities = await consumer.capabilities();
          send(response, 200, {
          role: "merchant",
          chain: context.chain.name,
          chainKey: context.deployment.chain,
          chainId: context.deployment.chainId,
          contracts: {
            entitlementFactory: context.deployment.entitlementFactory,
            settlementEscrow: context.deployment.settlementEscrow,
            settlementToken: context.deployment.settlementToken,
            ...(context.deployment.aaveYieldAdapter
              ? { aaveYieldAdapter: context.deployment.aaveYieldAdapter }
              : {}),
          },
          admin: context.deployment.admin,
          issuer: context.deployment.issuer ?? null,
          permissionlessIssuers: context.deployment.permissionlessIssuers === true,
          walletSigns: true,
          yield: capabilities.yield,
          note: context.deployment.permissionlessIssuers === true
            ? "RouteLock Agent checks customer requests and gates proof-backed settlement. Any wallet can publish an offer; its first offer registers it automatically. The admin can pause providers, while offer creation and collateral moves remain approved by the connected wallet."
            : "Offer creation and collateral moves are approved by the connected provider wallet. The API only reads and derives identifiers.",
          lanes: capabilities,
        });
        return;
        }

      case "GET /api/merchant/catalog":
        send(response, 200, await consumer.catalog());
        return;

      case "POST /api/merchant/draft": {
        const body = await readJsonBody(request);
        const label = body["label"];
        const terms = body["terms"];
        if (typeof label !== "string" || label.trim() === "") {
          throw new BadRequest("label is required to create a service offer");
        }
        if (typeof terms !== "string" || terms.trim() === "") {
          throw new BadRequest("terms are required to create a service offer");
        }
        // This endpoint never signs or broadcasts. It only applies the same
        // deterministic hash convention used by the contracts and e2e tools;
        // the connected provider wallet still creates the class on chain.
        send(response, 200, {
          classId: keccak256(toBytes(`routelock:class:${label.trim()}`)),
          termsHash: keccak256(toBytes(terms.trim())),
        });
        return;
      }

      case "POST /api/merchant/discover": {
        const body = await readJsonBody(request);
        send(response, 200, await consumer.discoverMerchantClass(body["classId"]));
        return;
      }

      case "POST /api/consumer/carbon/preview": {
        if (!modelLimiter.take(caller)) {
          send(response, 429, {
            error: "rate limit reached for model-backed consumer reviews",
            retryAfterSeconds: modelLimiter.retryAfterSeconds(caller),
          });
          return;
        }
        send(response, 200, await consumer.previewCarbon(await readJsonBody(request)));
        return;
      }

      case "POST /api/rule/hs": {
        const body = await readJsonBody(request);
        if (!modelLimiter.take(caller)) {
          send(response, 429, {
            error: "rate limit reached for model-backed rulings",
            retryAfterSeconds: modelLimiter.retryAfterSeconds(caller),
          });
          return;
        }
        const ruling = await ruleOnGoods(engine, parseClassificationRequest(body));
        send(response, 200, { ...ruling, budget: reportBudget(budget, caps) });
        return;
      }

      case "POST /api/rule/carbon": {
        if (carbon === null) {
          throw new ConsumerError(409, `${context.chain.name} is the BOT compute lane; carbon reviews are served by an X Layer API`);
        }
        const body = await readJsonBody(request);
        const carbonClass = body["carbonClass"];
        if (typeof carbonClass !== "string" || carbonClass.trim() === "") {
          throw new BadRequest("carbonClass is required — pick one from /api/carbon/inventory");
        }
        const tonnes = Number(body["tonnes"] ?? 0.001);
        if (!Number.isFinite(tonnes) || tonnes <= 0 || tonnes > 1) {
          throw new BadRequest("tonnes must be between 0 and 1 for a public ruling");
        }
        if (!modelLimiter.take(caller)) {
          send(response, 429, {
            error: "rate limit reached for model-backed rulings",
            retryAfterSeconds: modelLimiter.retryAfterSeconds(caller),
          });
          return;
        }
        const config = configFromEnv();
        const ruling = await ruleOnCarbon(
          carbon,
          budget,
          config.apiKey,
          config.model,
          carbonClass.trim(),
          tonnes,
        );
        send(response, 200, { ...ruling, budget: reportBudget(budget, caps) });
        return;
      }

      default:
        break;
    }

    const replayMatch = /^\/api\/replay\/(\d{1,20})$/.exec(path);
    if (request.method === "GET" && replayMatch !== null) {
      send(response, 200, await replay(context, BigInt(replayMatch[1]!)));
      return;
    }

    const merchantClassMatch = /^\/api\/merchant\/classes\/(0x[0-9a-fA-F]{64})$/.exec(path);
    if (request.method === "GET" && merchantClassMatch !== null) {
      send(response, 200, await consumer.merchantClass(merchantClassMatch[1]));
      return;
    }

    const consumerOrderMatch = /^\/api\/consumer\/orders\/([^/]+)(?:\/(minted|submitted|retirement\/prepare|retirement\/fulfil|settle))?$/.exec(path);
    if (consumerOrderMatch !== null) {
      const orderId = decodeURIComponent(consumerOrderMatch[1]!);
      const action = consumerOrderMatch[2];
      if (request.method === "GET" && action === undefined) {
        send(response, 200, consumer.getOrder(orderId));
        return;
      }
      if (request.method !== "POST" || action === undefined) {
        send(response, 405, { error: "method not allowed" });
        return;
      }
      const body = await readJsonBody(request);
      if (action === "minted") {
        send(response, 200, await consumer.recordMint(orderId, body["txHash"]));
        return;
      }
      if (action === "submitted") {
        send(response, 200, await consumer.recordSubmitted(orderId, body["txHash"]));
        return;
      }
      if (action === "retirement/prepare") {
        send(response, 200, await consumer.prepareRetirement(orderId));
        return;
      }
      if (action === "retirement/fulfil") {
        send(response, 200, await consumer.fulfilRetirement(orderId));
        return;
      }
      send(response, 200, await consumer.settleOrder(orderId));
      return;
    }

    send(response, 404, { error: `no route for ${request.method ?? "?"} ${path}` });
  } catch (error) {
    if (error instanceof BadRequest) {
      send(response, 400, { error: error.message });
      return;
    }
    if (error instanceof InferenceBudgetExceeded) {
      // 402, not 500: the request was well formed and the service is working.
      // It has simply spent what it was allowed to spend, and says so.
      send(response, 402, {
        error: error.message,
        budget: reportBudget(budget, caps),
      });
      return;
    }
    if (error instanceof ConsumerError) {
      send(response, error.status, { error: error.message });
      return;
    }
    if (error instanceof X402Error) {
      send(response, error.status, {
        error: error.message,
        code: error.code,
        action: error.action,
        ...error.context,
      });
      return;
    }
    if (error instanceof SpendCapExceeded) {
      send(response, 409, {
        error: error.message,
        cap: error.cap,
        limitUsdc: error.limitUsdc,
        attemptedUsdc: error.attemptedUsdc,
      });
      return;
    }
    if (error instanceof DuplicateRetirement) {
      send(response, 409, { error: error.message, key: error.key, prior: error.prior });
      return;
    }
    throw error;
  }
}

await assertChainMatches(context);

server.listen(PORT, HOST, () => {
  console.log(`RouteLock API on http://${HOST}:${PORT}`);
  console.log(`  chain      ${context.chain.name} (${context.deployment.chainId}) via ${context.rpc}`);
  console.log(`  registry   ${context.deployment.activationRegistry}`);
  console.log(`  model      ${engine.model}`);
  console.log(`  budget     ${budget.summary()} (served ledger)`);
  console.log(`  web root   ${WEB_ROOT}`);
});
