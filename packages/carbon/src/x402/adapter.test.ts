import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChain } from "@routelock/chain";
import { CarbonmarkX402Adapter, withSignature } from "./adapter.ts";
import { KlimaX402Client, formatTonnes } from "./client.ts";
import { DEFAULT_CAPS, RetirementLedger, idempotencyKey } from "./ledger.ts";
import { pad } from "./authorization.ts";
import { creditedAsRequested, RETRYABLE_CODES, X402_HOST, X402Error } from "./types.ts";

/// These drive the adapter through an injected transport rather than the live
/// endpoint. That is not a mocked provider standing in for a real one — the
/// real path is exercised by `pnpm --filter @routelock/carbon smoke:x402`
/// against the live service. What is under test here is the behaviour that must
/// hold on the paths a live smoke run must never take: the double retirement,
/// the breached cap, the timeout.

const testnet = getChain("xlayer_testnet");
const mainnet = getChain("xlayer_mainnet");
const botchain = getChain("botchain_testnet");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SIGNATURE = `0x${"ab".repeat(65)}`;
const NONCE = `0x${"40".repeat(32)}`;
const BUYER = "0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6";
const ALLOWED = { ROUTELOCK_X402_ALLOW_LIVE_RETIREMENT: "yes-retire-for-real" };

const ORDER = {
  entitlementTokenId: 7,
  classId: "0xabc",
  carbonClass: "0x0008f35758a4318942ecb5d5414116ce7b1ede2d",
  tonnes: 0.001,
  from: BUYER,
  beneficiaryAddress: BUYER,
  beneficiaryString: "RouteLock demo",
  retirementMessage: "order #1",
};

/// `Approved` is deliberately unconstructible outside the compliance package.
/// Reaching `fulfil` from a test therefore needs a cast, which is greppable —
/// and its absence anywhere in `src/` is the property that matters.
function approve<T>(order: T) {
  return { order, decisionHash: `0x${"11".repeat(32)}` } as unknown as Parameters<
    CarbonmarkX402Adapter["fulfil"]
  >[0];
}

/// A transport that answers each action from a script, and records what it saw.
function scriptedFetch(script: Record<string, unknown | (() => never)>) {
  const seen: { action: string; body: Record<string, unknown> }[] = [];
  const impl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const action = String(body["action"]);
    seen.push({ action, body });
    const answer = script[action];
    if (typeof answer === "function") (answer as () => never)();
    if (answer === undefined) throw new Error(`no scripted answer for ${action}`);
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const PREPARED = {
  scheme: "eip3009",
  chainId: 8453,
  inputToken: USDC,
  spender: "0x290e98e95dacE244c73376C0c39A4D53b22E34B6",
  authValue: "28035",
  executorGas: "17561",
  quote: {
    tonnesFormatted: "0.001",
    retirementPrice: "72",
    fee: "10000",
    total: "10072",
    suggestedMaxInput: "10474",
    pricePerTonne: "72000",
    humanSummary: "0.001 tonnes @ 0.000072 USDC + 0.01 USDC fee",
    resolvedCredit: { creditToken: "0x625d", tokenId: 0, vintage: 2022 },
  },
  typedData: {
    domain: {},
    types: { TransferWithAuthorization: [] },
    primaryType: "TransferWithAuthorization",
    message: { nonce: NONCE, validBefore: "1786746620" },
  },
  actionsRetireRequest: {
    action: "actions/retire",
    details: { beneficiaryAddress: BUYER },
    salt: `0x${"a7".repeat(32)}`,
    authPayload: { from: BUYER, nonce: NONCE },
  },
};

const SETTLED = {
  status: "settled",
  transactionHash: "0x4a7f",
  retirements: [
    {
      certificateUrl: "https://app.carbonmark.com/retirements/id/8453-0x4a7f-0",
      amountInTonnes: "0.001",
      beneficiaryAddress: BUYER,
      beneficiaryName: "RouteLock demo",
      projectId: "UCR-423",
      creditId: "UCR-423-2022",
    },
  ],
};

function build(
  script: Record<string, unknown | (() => never)>,
  {
    chain = mainnet,
    env = {} as Record<string, string | undefined>,
    caps = DEFAULT_CAPS,
  } = {},
) {
  const { impl, seen } = scriptedFetch(script);
  const dir = mkdtempSync(join(tmpdir(), "routelock-x402-"));
  const ledger = new RetirementLedger(join(dir, "retirements.jsonl"), caps);
  const adapter = new CarbonmarkX402Adapter(chain, {
    client: new KlimaX402Client({ fetchImpl: impl, backoffMs: [] }),
    ledger,
    sign: async () => SIGNATURE,
    env,
    certificateTimeoutMs: 40,
    certificatePollMs: 10,
  });
  return { adapter, ledger, seen };
}

test("the adapter declares the active X Layer carbon lane", () => {
  // docs/adapters.md is authoritative; this is its code-side copy. It moves to
  // "active" only once a real retirement has produced a public certificate.
  const { adapter } = build({});
  assert.equal(adapter.vertical, "carbon");
  assert.equal(adapter.status, "active");
  assert.equal(adapter.reversible, false);
});

test("BOT Chain cannot construct the carbon adapter", () => {
  assert.throws(
    () => build({}, { chain: botchain }),
    /BOT Chain Testnet does not allow the carbon fulfilment lane/,
  );
});

test("the adapter reports live on a testnet chain, because it is", () => {
  // Every other adapter derives `live` from the chain. This one cannot: the
  // endpoint serves Base mainnet only, so there is no sandbox figure to show
  // and claiming one would be the lie.
  const { adapter } = build({}, { chain: testnet });
  assert.equal(adapter.live, true);
});

test("a test chain cannot spend without a deliberate opt-in", async () => {
  // §1.2.5 with no key to inspect. The guard moves to the spend boundary
  // because that is the only place the distinction has consequences.
  const { adapter, seen } = build(
    { "prepare-auth": PREPARED, "actions/retire": SETTLED },
    { chain: testnet },
  );

  await assert.rejects(adapter.fulfil(approve(ORDER)), /no sandbox/);
  assert.deepEqual(seen, [], "it refused before making any request at all");
});

test("the opt-in must be exact", async () => {
  for (const value of ["yes", "true", "1", "YES-RETIRE-FOR-REAL"]) {
    const { adapter } = build(
      { "prepare-auth": PREPARED },
      { chain: testnet, env: { ROUTELOCK_X402_ALLOW_LIVE_RETIREMENT: value } },
    );
    await assert.rejects(adapter.fulfil(approve(ORDER)), /no sandbox/);
  }

  const { adapter } = build(
    { "prepare-auth": PREPARED, "actions/retire": SETTLED },
    { chain: testnet, env: ALLOWED },
  );
  const receipt = await adapter.fulfil(approve(ORDER));
  assert.match(receipt.proofUrl, /app\.carbonmark\.com/);
});

test("a retirement releases against a certificate URL and returns the tx", async () => {
  const { adapter, ledger } = build({
    "prepare-auth": PREPARED,
    "actions/retire": SETTLED,
  });

  const receipt = await adapter.fulfil(approve(ORDER));

  assert.equal(receipt.ref, "0x4a7f");
  assert.equal(receipt.proofUrl, SETTLED.retirements[0]?.certificateUrl);
  assert.equal(receipt.currency, "USDC");
  assert.equal(receipt.amountCharged, 0.028035, "the authorised ceiling, not the quote");
  assert.equal(ledger.latest(idempotencyKey(ORDER))?.state, "settled");
});

test("the same obligation cannot be retired twice", async () => {
  // The single most expensive bug available in this system, and the reason the
  // ledger is written before the request rather than after it.
  const { adapter, seen } = build({
    "prepare-auth": PREPARED,
    "actions/retire": SETTLED,
  });

  await adapter.fulfil(approve(ORDER));
  const callsAfterFirst = seen.length;

  await assert.rejects(adapter.fulfil(approve(ORDER)), /already retired/);
  assert.equal(seen.length, callsAfterFirst, "the duplicate cost no network calls");
});

test("the attempt is on disk before the request that could spend", async () => {
  // Asserted by reading the ledger from inside the transport, at the moment
  // `actions/retire` is being handled — which is precisely the window a crash
  // would fall into.
  const dir = mkdtempSync(join(tmpdir(), "routelock-x402-"));
  const ledger = new RetirementLedger(join(dir, "retirements.jsonl"));
  let stateAtSubmit: string | undefined;

  const { impl } = scriptedFetch({
    "prepare-auth": PREPARED,
    "actions/retire": SETTLED,
  });
  const watching = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (body["action"] === "actions/retire") {
      stateAtSubmit = ledger.latest(idempotencyKey(ORDER))?.state;
    }
    return impl(url as string, init);
  }) as unknown as typeof fetch;

  const adapter = new CarbonmarkX402Adapter(mainnet, {
    client: new KlimaX402Client({ fetchImpl: watching, backoffMs: [] }),
    ledger,
    sign: async () => SIGNATURE,
  });
  await adapter.fulfil(approve(ORDER));

  assert.equal(stateAtSubmit, "attempting");
});

test("a timeout on actions/retire is never retried", async () => {
  // The retirement may already have mined while the socket was closing. A
  // second attempt would burn a second credit, irreversibly.
  let submits = 0;
  const { adapter, ledger } = build({
    "prepare-auth": PREPARED,
    "actions/retire": () => {
      submits++;
      throw new Error("socket hang up");
    },
  });

  await assert.rejects(
    adapter.fulfil(approve(ORDER)),
    (error: unknown) =>
      error instanceof X402Error &&
      error.code === "retirement_outcome_unknown" &&
      /Do NOT retry/.test(error.message),
  );

  assert.equal(submits, 1);
  assert.equal(
    ledger.latest(idempotencyKey(ORDER))?.state,
    "attempting",
    "left unresolved on purpose — only the chain can close it",
  );
  assert.equal(ledger.unresolved().length, 1);
});

test("an unresolved attempt blocks the next one until the chain is asked", async () => {
  const { adapter } = build({
    "prepare-auth": PREPARED,
    "actions/retire": () => {
      throw new Error("socket hang up");
    },
  });

  await assert.rejects(adapter.fulfil(approve(ORDER)), /outcome_unknown/);
  await assert.rejects(adapter.fulfil(approve(ORDER)), /unresolved/);
});

test("a breached cap refuses after pricing and before signing", async () => {
  // Pricing is free, so the cap is checked against the real authorised budget
  // rather than an estimate. Nothing is signed and nothing is submitted.
  let signed = false;
  const { impl, seen } = scriptedFetch({
    "prepare-auth": PREPARED,
    "actions/retire": SETTLED,
  });
  const dir = mkdtempSync(join(tmpdir(), "routelock-x402-"));
  const adapter = new CarbonmarkX402Adapter(mainnet, {
    client: new KlimaX402Client({ fetchImpl: impl, backoffMs: [] }),
    ledger: new RetirementLedger(join(dir, "l.jsonl"), {
      perRetirementUsdc: 0.01,
      dailyUsdc: 1,
    }),
    sign: async () => {
      signed = true;
      return SIGNATURE;
    },
  });

  await assert.rejects(adapter.fulfil(approve(ORDER)), /per-retirement spending cap/);
  assert.equal(signed, false);
  assert.deepEqual(
    seen.map((s) => s.action),
    ["prepare-auth"],
  );
});

test("an authorization that does not match the order is not signed", async () => {
  // The endpoint resolves the credit, the price and the attribution itself.
  // The signature makes whatever it returned permanent, so it is checked first.
  const cases: [string, Record<string, unknown>][] = [
    ["chainId", { ...PREPARED, chainId: 1 }],
    ["input token", { ...PREPARED, inputToken: `0x${"9".repeat(40)}` }],
    [
      "tonnes",
      { ...PREPARED, quote: { ...PREPARED.quote, tonnesFormatted: "1" } },
    ],
    [
      "beneficiary",
      {
        ...PREPARED,
        actionsRetireRequest: {
          ...PREPARED.actionsRetireRequest,
          details: { beneficiaryAddress: `0x${"9".repeat(40)}` },
        },
      },
    ],
  ];

  for (const [label, prepared] of cases) {
    let signed = false;
    const { impl } = scriptedFetch({ "prepare-auth": prepared });
    const dir = mkdtempSync(join(tmpdir(), "routelock-x402-"));
    const adapter = new CarbonmarkX402Adapter(mainnet, {
      client: new KlimaX402Client({ fetchImpl: impl, backoffMs: [] }),
      ledger: new RetirementLedger(join(dir, "l.jsonl")),
      sign: async () => {
        signed = true;
        return SIGNATURE;
      },
    });

    await assert.rejects(
      adapter.fulfil(approve(ORDER)),
      /authorization_mismatch/,
      `mismatched ${label} should refuse`,
    );
    assert.equal(signed, false, `mismatched ${label} must not be signed`);
  }
});

test("a retirement credited to someone else is not published as proof", async () => {
  // A receipt that does not describe the request is not evidence for the
  // request, and a Receipt is what gets hashed on-chain and published.
  const { adapter } = build({
    "prepare-auth": PREPARED,
    "actions/retire": {
      ...SETTLED,
      retirements: [
        { ...SETTLED.retirements[0], beneficiaryAddress: `0x${"9".repeat(40)}` },
      ],
    },
  });

  await assert.rejects(adapter.fulfil(approve(ORDER)), /attribution_mismatch/);
});

test("a retirement with no certificate is not a success", async () => {
  // Escrow releases against a resolved certificate and nothing else. A
  // transaction hash alone is not the proof this project publishes.
  const { adapter } = build({
    "prepare-auth": PREPARED,
    "actions/retire": { status: "settled", transactionHash: "0x4a7f", retirements: [] },
    certificate: { retirements: [] },
  });

  await assert.rejects(adapter.fulfil(approve(ORDER)), /certificate/);
});

test("pending_index polls the certificate rather than failing", async () => {
  // Mined but not yet indexed is the expected interim state, not an error.
  const { adapter } = build({
    "prepare-auth": PREPARED,
    "actions/retire": {
      status: "pending_index",
      transactionHash: "0x4a7f",
      retirements: [],
    },
    certificate: { retirements: SETTLED.retirements },
  });

  const receipt = await adapter.fulfil(approve(ORDER));
  assert.equal(receipt.proofUrl, SETTLED.retirements[0]?.certificateUrl);
});

test("the signature is added to the endpoint's body and nothing else changes", () => {
  const signed = withSignature(PREPARED.actionsRetireRequest, SIGNATURE);

  assert.equal(signed["salt"], PREPARED.actionsRetireRequest.salt, "salt survives");
  assert.deepEqual(signed["details"], PREPARED.actionsRetireRequest.details);
  assert.equal(
    (signed["authPayload"] as Record<string, unknown>)["nonce"],
    NONCE,
    "the signed nonce is posted back unchanged",
  );
  assert.equal((signed["authPayload"] as Record<string, unknown>)["signature"], SIGNATURE);
});

test("a malformed signature is refused before it can be posted", () => {
  for (const bad of ["0xdeadbeef", "", SIGNATURE.slice(0, -2)]) {
    assert.throws(() => withSignature(PREPARED.actionsRetireRequest, bad), RangeError);
  }
  assert.throws(() => withSignature({ action: "x" }, SIGNATURE), /no authPayload/);
});

test("prepare-auth without a signable nonce is refused", async () => {
  // Without the nonce there is nothing to ask the chain after a crash, so a
  // timeout would become unrecoverable rather than merely inconvenient.
  const { adapter } = build({
    "prepare-auth": {
      ...PREPARED,
      typedData: { ...PREPARED.typedData, message: { validBefore: "1" } },
    },
  });

  await assert.rejects(adapter.fulfil(approve(ORDER)), /unusable_authorization/);
});

test("facts come from the provider, and gaps are reported as gaps", async () => {
  // One live class returns its own address as its name, no methodologies and
  // zero credits. That is the clearest NEEDS_INFORMATION there is, and it only
  // works if the adapter refuses to tidy it away.
  const { adapter } = build({
    discover: {
      carbonClasses: [
        {
          carbonClassId: "0x67cb",
          name: "0x67cb",
          category: "Unknown",
          country: "Unknown",
          methodologies: [],
          isRegistered: true,
          priceUsdcPerTonneFormatted: null,
          creditsDetailed: [],
          minRetirementTonnesFormatted: "0.001",
        },
      ],
    },
  });

  const facts = await adapter.assess({ ...ORDER, carbonClass: "0x67cb" });

  assert.equal(facts.name, null);
  assert.equal(facts.category, null);
  assert.equal(facts.pricePerTonne, null);
  assert.equal(facts.identityUnknown, true);
  assert.equal(facts.insufficientLiquidity, true);
  assert.equal(facts.oldestVintageAgeYears, -1);
});

test("a vintage that is not a year is normalised, and the fact kept", async () => {
  // A live Puro credit reports `20240430`. Read as a year it lands eighteen
  // thousand years in the future and every age-based signal inverts.
  const { adapter } = build({
    discover: {
      carbonClasses: [
        {
          carbonClassId: "0x4d6f",
          name: "Biochar",
          category: "Biochar",
          methodologies: ["C03000000"],
          isRegistered: true,
          priceUsdcPerTonneFormatted: "94.671246",
          creditsDetailed: [
            { registry: "PUR", vintage: 2023, liquidityFormatted: "100" },
            { registry: "PUR", vintage: 20240430, liquidityFormatted: "97.7" },
          ],
          minRetirementTonnesFormatted: "0.001",
        },
      ],
    },
  });

  const facts = await adapter.assess({ ...ORDER, carbonClass: "0x4d6f" });

  assert.deepEqual(facts.vintages, [2023, 2024]);
  assert.equal(facts.oldestVintage, 2023);
  assert.equal(facts.insufficientLiquidity, false);
});

test("tonnes are rendered as a decimal string, never in exponent form", () => {
  // The protocol minimum is 0.001 t and the endpoint's schema takes a decimal
  // string. A float round-trip is how "0.001" becomes "1e-3" and 400s.
  assert.equal(formatTonnes(0.001), "0.001");
  assert.equal(formatTonnes(1), "1");
  assert.equal(formatTonnes(1.5), "1.5");
  assert.equal(formatTonnes(0.000001), "0.000001");
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => formatTonnes(bad), RangeError);
  }
});

test("the retryable set matches the published registry, and excludes the rest", () => {
  // Match on the code, never on the message — the endpoint's own documentation
  // says codes are stable and wording is not.
  for (const code of ["retirement_not_found", "insufficient_liquidity", "internal_error"]) {
    assert.equal(RETRYABLE_CODES.has(code), true, code);
  }
  for (const code of ["params_mismatch", "attribution_required", "schema_validation"]) {
    assert.equal(RETRYABLE_CODES.has(code), false, code);
  }
});

test("attribution is compared, not assumed", () => {
  assert.equal(creditedAsRequested(BUYER, BUYER), true);
  assert.equal(creditedAsRequested(BUYER, BUYER.toLowerCase()), true);
  assert.equal(creditedAsRequested(BUYER, ""), false);
  assert.equal(creditedAsRequested(BUYER, null), false);
  assert.equal(creditedAsRequested(BUYER, `0x${"9".repeat(40)}`), false);
});

test("the host is pinned to a major", () => {
  // The bare host serves the latest release and moves on a major bump. A
  // breaking change landing mid-judging is an unacceptable risk for no benefit.
  assert.equal(X402_HOST, "https://v1.x402.klimalabs.com");
});

test("hex words are padded, and anything that cannot be is refused", () => {
  assert.equal(pad(BUYER), `${"0".repeat(24)}${BUYER.slice(2).toLowerCase()}`);
  assert.equal(pad(NONCE).length, 64);
  assert.throws(() => pad("0xzz"), RangeError);
  assert.throws(() => pad(`0x${"1".repeat(66)}`), RangeError);
});

test("an authorization with no resolved credit is not signed", async () => {
  // The endpoint picks the credit when the order does not pin one, so this is
  // the only moment its choice is visible before a signature makes it
  // permanent. Caught for real by a smoke run: `prepare-auth` carries
  // `resolvedCredit` at the top level while `quote` nests it, and reading only
  // the nested one reported the retirement as credit "" vintage 0.
  const { adapter } = build({
    "prepare-auth": {
      ...PREPARED,
      quote: { ...PREPARED.quote, resolvedCredit: undefined },
    },
  });

  await assert.rejects(adapter.fulfil(approve(ORDER)), /no resolved credit/);
});

test("a pinned credit that the endpoint did not honour is not signed", async () => {
  const { adapter } = build({ "prepare-auth": PREPARED });

  await assert.rejects(
    adapter.fulfil(approve({ ...ORDER, creditToken: `0x${"9".repeat(40)}` })),
    /pinned/,
  );
});
