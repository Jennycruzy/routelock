import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CHAINS,
  getChain,
  requireSettlementToken,
  assertEnvironmentPairing,
  assertProviderPairing,
  assertKeylessSpendAllowed,
  CARBONMARK_KEYS,
  KLIMA_X402_SPEND,
  FULFILMENT_CHAINS,
  type ChainConfig,
} from "./chains.ts";

const SANDBOX_KEY = "sb_sandbox_abc123";
const LIVE_KEY = "sb_prod_abc123";

describe("assertEnvironmentPairing (spec §1.2.5)", () => {
  test("a test chain accepts a sandbox key", () => {
    assert.doesNotThrow(() =>
      assertEnvironmentPairing(CHAINS.xlayer_testnet, SANDBOX_KEY)
    );
    assert.doesNotThrow(() =>
      assertEnvironmentPairing(CHAINS.botchain_testnet, SANDBOX_KEY)
    );
  });

  test("a live chain accepts a live key", () => {
    assert.doesNotThrow(() =>
      assertEnvironmentPairing(CHAINS.xlayer_mainnet, LIVE_KEY)
    );
    assert.doesNotThrow(() =>
      assertEnvironmentPairing(CHAINS.botchain_mainnet, LIVE_KEY)
    );
  });

  // This is the case that spends real money by accident. It must throw.
  test("a test chain REFUSES a live key", () => {
    for (const chain of [CHAINS.xlayer_testnet, CHAINS.botchain_testnet]) {
      assert.throws(
        () => assertEnvironmentPairing(chain, LIVE_KEY),
        /LIVE carrier key was supplied/,
        `${chain.name} must refuse a live carrier key`
      );
    }
  });

  test("a live chain REFUSES a sandbox key", () => {
    for (const chain of [CHAINS.xlayer_mainnet, CHAINS.botchain_mainnet]) {
      assert.throws(
        () => assertEnvironmentPairing(chain, SANDBOX_KEY),
        /must never display a sandbox result/,
        `${chain.name} must refuse a sandbox carrier key`
      );
    }
  });

  test("an absent key refuses to boot rather than falling back to a mock", () => {
    assert.throws(
      () => assertEnvironmentPairing(CHAINS.xlayer_mainnet, undefined),
      /does not run against a mocked carrier/
    );
    assert.throws(() => assertEnvironmentPairing(CHAINS.xlayer_testnet, ""), /no carrier key/);
  });

  test("an unrecognised key prefix refuses rather than guessing", () => {
    for (const chain of Object.values(CHAINS)) {
      assert.throws(
        () => assertEnvironmentPairing(chain as ChainConfig, "some_other_key"),
        /matches neither the live/,
        `${chain.name} must not guess the environment of an unknown key format`
      );
    }
  });

  test("every chain is covered by exactly one of the two branches", () => {
    for (const chain of Object.values(CHAINS)) {
      assert.ok(
        chain.env === "test" || chain.env === "live",
        `${chain.name} has an env outside the pairing table`
      );
      // carrierMode is derived from env, never configured independently.
      const expected = chain.env === "test" ? "sandbox" : "live";
      assert.equal(
        chain.carrierMode,
        expected,
        `${chain.name} pairs env=${chain.env} with carrierMode=${chain.carrierMode}`
      );
    }
  });
});

describe("requireSettlementToken", () => {
  test("returns the verified token for resolved ERC-20 chains", () => {
    assert.equal(
      requireSettlementToken(CHAINS.botchain_mainnet),
      "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C"
    );
    assert.equal(
      requireSettlementToken(CHAINS.xlayer_mainnet),
      "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"
    );
  });

  test("returns the faucet-dispensed USD₮0 for X Layer testnet", () => {
    assert.equal(
      requireSettlementToken(CHAINS.xlayer_testnet),
      "0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c"
    );
  });

  // No placeholder address, no zero address, no silent default. Kept as a live
  // test against a synthetic config so the refusal path stays covered now that
  // all four real targets resolve.
  test("REFUSES an unresolved settlement rather than returning a placeholder", () => {
    const unresolved = {
      ...CHAINS.xlayer_testnet,
      settlement: { kind: "unresolved", reason: "not yet chosen" },
    } as unknown as ChainConfig;
    assert.throws(() => requireSettlementToken(unresolved), /no confirmed settlement token/);
  });

  test("REFUSES to hand a native settlement back as an ERC-20 address", () => {
    const native = {
      ...CHAINS.botchain_mainnet,
      settlement: { kind: "native", symbol: "BOT", decimals: 18 },
    } as unknown as ChainConfig;
    assert.throws(() => requireSettlementToken(native), /settles in native BOT/);
  });

  test("every settlement token is 6 decimals, so pricing arithmetic is uniform", () => {
    for (const chain of Object.values(CHAINS)) {
      assert.equal(
        chain.settlement.kind === "erc20" ? chain.settlement.decimals : 6,
        6,
        `${chain.name} settlement is not 6 decimals`
      );
    }
  });
});

describe("getChain", () => {
  test("resolves every declared chain key", () => {
    for (const key of Object.keys(CHAINS)) {
      assert.equal(getChain(key).chainId, CHAINS[key as keyof typeof CHAINS].chainId);
    }
  });

  test("throws on an unknown key and names the valid ones", () => {
    assert.throws(() => getChain("ethereum"), /Unknown chain "ethereum"/);
    assert.throws(() => getChain("ethereum"), /xlayer_testnet/);
  });
});

describe("chain identity", () => {
  test("chain IDs are unique across all four targets", () => {
    const ids = Object.values(CHAINS).map((c) => c.chainId);
    assert.equal(new Set(ids).size, ids.length, "duplicate chainId in CHAINS");
  });

  test("chain IDs match the values verified on 2026-08-13", () => {
    assert.equal(CHAINS.xlayer_testnet.chainId, 1952);
    assert.equal(CHAINS.xlayer_mainnet.chainId, 196);
    assert.equal(CHAINS.botchain_testnet.chainId, 968);
    assert.equal(CHAINS.botchain_mainnet.chainId, 677);
  });
});

describe("Carbonmark key pairing", () => {
  const sandbox = "cm_api_sandbox_example";

  test("a sandbox key pairs with a test chain", () => {
    assert.doesNotThrow(() =>
      assertProviderPairing(CHAINS.xlayer_testnet, sandbox, CARBONMARK_KEYS),
    );
  });

  test("a sandbox key on a live chain refuses", () => {
    // A mainnet retirement displayed from a sandbox credential would be a
    // fabricated certificate — the exact failure rule §1.2.1 forbids.
    assert.throws(
      () => assertProviderPairing(CHAINS.xlayer_mainnet, sandbox, CARBONMARK_KEYS),
      /must never display a sandbox result/,
    );
  });

  test("no key at all can satisfy a live chain while the live prefix is unknown", () => {
    // Production access has not been granted, so no production key has been
    // seen and its prefix cannot be known. The guard must fail a mainnet boot
    // rather than accept an unrecognised key as live — otherwise the one thing
    // it exists to prevent becomes possible.
    for (const candidate of [
      sandbox,
      "cm_api_prod_guess",
      "cm_api_live_guess",
      "cm_whatever",
    ]) {
      assert.throws(
        () => assertProviderPairing(CHAINS.xlayer_mainnet, candidate, CARBONMARK_KEYS),
        /FATAL/,
      );
    }
  });

  test("an unrecognised prefix says why it cannot be classified", () => {
    assert.throws(
      () => assertProviderPairing(CHAINS.xlayer_testnet, "cm_api_prod_guess", CARBONMARK_KEYS),
      /production access has not been granted/,
    );
  });

  test("a carrier key is not accepted as a Carbonmark key", () => {
    // Two providers, two prefixes. Pasting one into the other's variable is an
    // ordinary mistake and must not boot.
    assert.throws(
      () => assertProviderPairing(CHAINS.xlayer_testnet, "sb_sandbox_example", CARBONMARK_KEYS),
      /matches neither the live/,
    );
  });

  test("an absent Carbonmark key refuses — there is no mock retirement", () => {
    assert.throws(
      () => assertProviderPairing(CHAINS.xlayer_testnet, undefined, CARBONMARK_KEYS),
      /no Carbonmark key/,
    );
  });
});

describe("keyless spending — the Klima x402 endpoint has no sandbox", () => {
  const ALLOWED = { ROUTELOCK_X402_ALLOW_LIVE_RETIREMENT: "yes-retire-for-real" };

  test("a live chain may spend", () => {
    assert.doesNotThrow(() =>
      assertKeylessSpendAllowed(CHAINS.xlayer_mainnet, KLIMA_X402_SPEND, {}),
    );
  });

  test("a test chain refuses, because there is no rehearsal to spend on", () => {
    // The manifest's schema advertises Base Sepolia; the runtime rejects it
    // with `supported: [8453]`. So a testnet deployment reaching this endpoint
    // would retire a real credit, irreversibly, against a testnet obligation.
    for (const chain of [CHAINS.xlayer_testnet, CHAINS.botchain_testnet]) {
      assert.throws(
        () => assertKeylessSpendAllowed(chain, KLIMA_X402_SPEND, {}),
        /no sandbox/,
      );
    }
  });

  test("the opt-in is exact, and nothing near it counts", () => {
    // A guard that is satisfied by "true" or "1" is a guard that gets tripped
    // by a leftover variable from something else.
    for (const value of ["yes", "true", "1", "", "YES-RETIRE-FOR-REAL"]) {
      assert.throws(
        () =>
          assertKeylessSpendAllowed(CHAINS.xlayer_testnet, KLIMA_X402_SPEND, {
            ROUTELOCK_X402_ALLOW_LIVE_RETIREMENT: value,
          }),
        /no sandbox/,
      );
    }

    assert.doesNotThrow(() =>
      assertKeylessSpendAllowed(CHAINS.xlayer_testnet, KLIMA_X402_SPEND, ALLOWED),
    );
  });

  test("the refusal explains what would happen, not just that it refused", () => {
    // An operator who hits this needs to know the consequence, because the
    // opt-in that clears it authorises real irreversible spending.
    assert.throws(
      () => assertKeylessSpendAllowed(CHAINS.xlayer_testnet, KLIMA_X402_SPEND, {}),
      /irreversibly/,
    );
  });
});

describe("Base is a fulfilment chain, not a deployment target", () => {
  test("Base is absent from the deployment table", () => {
    // The distinction is the architecture. RouteLock deploys nothing on Base:
    // the obligation, the collateral, the escrow and the compliance record are
    // on X Layer, and only the retirement executes over there.
    assert.equal(
      Object.values(CHAINS).some((c: ChainConfig) => c.chainId === 8453),
      false,
    );
  });

  test("Base mainnet matches the values verified on 2026-08-14", () => {
    assert.equal(FULFILMENT_CHAINS.base_mainnet.chainId, 8453);
    assert.equal(FULFILMENT_CHAINS.base_mainnet.inputTokenDecimals, 6);
    assert.equal(
      FULFILMENT_CHAINS.base_mainnet.inputToken,
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
  });
});

describe("Yield venues are configured from the chain, not from announcements", () => {
  test("every chain states a venue, so 'unknown' cannot masquerade as 'none'", () => {
    for (const [key, chain] of Object.entries(CHAINS) as [string, ChainConfig][]) {
      assert.ok(chain.yieldVenue, `${key} has no yieldVenue`);
      assert.ok(
        chain.yieldVenue.kind === "none" || chain.yieldVenue.kind === "aave-v3",
        `${key} has an unrecognised venue kind`,
      );
    }
  });

  test("an absent venue must say why", () => {
    for (const [key, chain] of Object.entries(CHAINS) as [string, ChainConfig][]) {
      if (chain.yieldVenue.kind === "none") {
        assert.notEqual(chain.yieldVenue.reason.trim(), "", `${key} gives no reason`);
      }
    }
  });

  // Aave's X Layer reserve and X Layer's settlement token are the same asset:
  // USD₮0. They read as different for one day, on 2026-08-17, because the
  // mainnet settlement address in this file named the legacy bridged USDT
  // (`0x1E4a5963…`) rather than the canonical USD₮0 the chain actually uses.
  //
  // That mistake briefly produced a confident, wrong conclusion — "Aave does not
  // list our token, so no yield adapter can be built" — from entirely correct
  // on-chain readings. The readings were never the problem; the config they were
  // compared against was.
  test("X Layer mainnet settles in the asset Aave's market lists", () => {
    const chain = CHAINS.xlayer_mainnet;
    assert.equal(chain.yieldVenue.kind, "aave-v3");
    if (chain.yieldVenue.kind !== "aave-v3") return;
    if (chain.settlement.kind !== "erc20") throw new Error("expected an erc20 settlement");

    assert.equal(
      chain.settlement.token.toLowerCase(),
      chain.yieldVenue.asset.toLowerCase(),
      "settlement and the Aave reserve have diverged — a yield adapter would need a swap",
    );
    assert.equal(chain.yieldVenue.settlesInVenueAsset, true);
  });

  // The legacy token must not come back by copy-paste. It is a live 6-decimal
  // ERC-20 that answers symbol() with "USDT", so every structural check in this
  // repo passes on it — `_assertSettlementToken` included. Nothing but naming it
  // catches it.
  test("the deprecated bridged USDT is not a settlement token anywhere", () => {
    const legacy = "0x1e4a5963abfd975d8c9021ce480b42188849d41d";
    for (const [key, chain] of Object.entries(CHAINS) as [string, ChainConfig][]) {
      if (chain.settlement.kind !== "erc20") continue;
      assert.notEqual(
        chain.settlement.token.toLowerCase(),
        legacy,
        `${key} settles in X Layer's phased-out bridged USDT`,
      );
    }
  });

  // `settlesInVenueAsset` is a claim, and a claim that can drift from the two
  // addresses it describes is a lie waiting to happen. verify:chains re-checks
  // it against the live chain; this checks it against the config itself, so a
  // mistake is caught without a network round trip.
  test("settlesInVenueAsset agrees with the addresses it describes", () => {
    for (const [key, chain] of Object.entries(CHAINS) as [string, ChainConfig][]) {
      if (chain.yieldVenue.kind !== "aave-v3") continue;

      const settlement = chain.settlement.kind === "erc20" ? chain.settlement.token.toLowerCase() : null;
      assert.equal(
        chain.yieldVenue.settlesInVenueAsset,
        settlement === chain.yieldVenue.asset.toLowerCase(),
        `${key} claims settlesInVenueAsset=${chain.yieldVenue.settlesInVenueAsset} and its addresses disagree`,
      );
    }
  });
});
