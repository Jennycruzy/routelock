import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CHAINS,
  getChain,
  requireSettlementToken,
  assertEnvironmentPairing,
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
      "0x1E4a5963aBFD975d8c9021ce480b42188849D41d"
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
