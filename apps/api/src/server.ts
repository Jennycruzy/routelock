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
/// It holds no key, constructs no wallet, and signs nothing. Every state change
/// in RouteLock is an operator action taken at a terminal. `no-signing.test.ts`
/// reads this package's source and fails if that stops being true.
///
/// There is no framework here on purpose: `node:http` and viem are enough, and a
/// dependency that has to be audited before a submission is a cost.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";

import { loadDotEnv, repoRoot } from "@routelock/chain";
import {
  ComplianceEngine,
  configFromEnv,
  ENGINE_VERSION,
  CARBON_ENGINE_VERSION,
  InferenceBudgetExceeded,
  ledgerPath,
} from "@routelock/compliance";
import { RetirementLedger, capsFromEnv as retirementCaps } from "@routelock/carbon";

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

const loaded = loadDotEnv();

const PORT = Number(process.env["ROUTELOCK_API_PORT"] ?? 8787);
const HOST = process.env["ROUTELOCK_API_HOST"] ?? "127.0.0.1";
const CHAIN_KEY = process.env["ROUTELOCK_CHAIN"] ?? "xlayer_testnet";
const WEB_ROOT = resolve(repoRoot(), "apps/web/public");
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
const engine = new ComplianceEngine(configFromEnv(), { budget });
const retirements = new RetirementLedger(ledgerPath("data/retirements.jsonl"), retirementCaps());
const carbon = readOnlyCarbonAdapter(context.chain, retirements);

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
  let file = resolve(join(WEB_ROOT, relative));

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
        // Re-verified against the provider on every request, not read from a
        // cache. A proof URL this project stored is a claim; a proof URL the
        // provider still confirms is evidence.
        send(response, 200, await readFulfilments(retirements, carbon));
        return;

      case "GET /api/carbon/inventory": {
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
