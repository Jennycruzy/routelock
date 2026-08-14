import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capsFromEnv,
  DEFAULT_CAPS,
  DuplicateRetirement,
  idempotencyKey,
  RetirementLedger,
  SpendCapExceeded,
} from "./ledger.ts";

/// Nothing here touches the network. What is under test is the set of
/// guarantees that must hold *before* any request goes out, because after it
/// has gone out a retirement cannot be taken back.

function freshLedger(caps = DEFAULT_CAPS, now = () => new Date("2026-08-14T12:00:00Z")) {
  const dir = mkdtempSync(join(tmpdir(), "routelock-ledger-"));
  return new RetirementLedger(join(dir, "retirements.jsonl"), caps, now);
}

const ORDER = {
  entitlementTokenId: 7,
  classId: "0xabc",
  carbonClass: "0x0008f35758a4318942ecb5d5414116ce7b1ede2d",
  tonnes: 0.001,
  beneficiaryAddress: "0x69eb1bAA26BffCD0fA9089aa2187F6Ca3e2A54f6",
};

function attempt(key: string, authValueUsdc: number, at?: string) {
  return {
    key,
    state: "attempting" as const,
    from: ORDER.beneficiaryAddress,
    carbonClass: ORDER.carbonClass,
    tonnes: ORDER.tonnes,
    beneficiaryAddress: ORDER.beneficiaryAddress,
    authValueUsdc,
    nonce: "0x" + "11".repeat(32),
    ...(at === undefined ? {} : { at }),
  };
}

test("the same obligation always produces the same key", () => {
  // The key has to survive a process restart, because the crash it protects
  // against is exactly the one that ends the process. Nothing in it comes from
  // the provider's response.
  assert.equal(idempotencyKey(ORDER), idempotencyKey({ ...ORDER }));
  assert.equal(
    idempotencyKey(ORDER),
    idempotencyKey({
      ...ORDER,
      carbonClass: ORDER.carbonClass.toUpperCase(),
      beneficiaryAddress: ORDER.beneficiaryAddress.toLowerCase(),
    }),
    "address casing is presentation, not identity",
  );
});

test("a different obligation produces a different key", () => {
  // Each field is checked separately: a key that ignored tonnage would let a
  // 1-tonne retirement pass as already done by a 0.001-tonne one.
  const base = idempotencyKey(ORDER);
  assert.notEqual(base, idempotencyKey({ ...ORDER, entitlementTokenId: 8 }));
  assert.notEqual(base, idempotencyKey({ ...ORDER, tonnes: 1 }));
  assert.notEqual(base, idempotencyKey({ ...ORDER, carbonClass: "0xdead" }));
  assert.notEqual(base, idempotencyKey({ ...ORDER, classId: "0xdef" }));
  assert.notEqual(
    base,
    idempotencyKey({ ...ORDER, beneficiaryAddress: "0x" + "9".repeat(40) }),
  );
});

test("an outstanding attempt blocks a second one", () => {
  // The state that matters. `attempting` means "we may have spent money and do
  // not know", and the only safe reading of that is to refuse.
  const ledger = freshLedger();
  const key = idempotencyKey(ORDER);
  ledger.record(attempt(key, 0.03));

  assert.throws(
    () => ledger.assertMaySpend(key, 0.03),
    (error: unknown) =>
      error instanceof DuplicateRetirement && /unresolved/.test(error.message),
  );
});

test("a settled retirement blocks a second one, permanently", () => {
  const ledger = freshLedger();
  const key = idempotencyKey(ORDER);
  ledger.record({ ...attempt(key, 0.03), state: "settled", txHash: "0xfeed" });

  assert.throws(
    () => ledger.assertMaySpend(key, 0.03),
    (error: unknown) =>
      error instanceof DuplicateRetirement && /already retired/.test(error.message),
  );
});

test("an attempt resolved as never-relayed unblocks the obligation", () => {
  // The chain said the nonce was never consumed, so no credit was retired and
  // the obligation is still owed. Refusing to fulfil it after that would strand
  // a buyer's money over an attempt that provably did nothing.
  const ledger = freshLedger();
  const key = idempotencyKey(ORDER);
  ledger.record(attempt(key, 0.03));
  ledger.record({ ...attempt(key, 0.03), state: "failed" });

  assert.doesNotThrow(() => ledger.assertMaySpend(key, 0.03));
});

test("the last record wins, not the first", () => {
  // The file is append-only, so a key accumulates records. Reading anything
  // other than the latest would resurrect a state that was already resolved.
  const ledger = freshLedger();
  const key = idempotencyKey(ORDER);
  ledger.record(attempt(key, 0.03));
  ledger.record({ ...attempt(key, 0.03), state: "failed" });

  assert.equal(ledger.latest(key)?.state, "failed");
  assert.equal(ledger.unresolved().length, 0);
});

test("the per-retirement cap refuses before anything is sent", () => {
  const ledger = freshLedger({ perRetirementUsdc: 0.05, dailyUsdc: 100 });

  assert.throws(
    () => ledger.assertMaySpend(idempotencyKey(ORDER), 0.06),
    (error: unknown) => error instanceof SpendCapExceeded && error.cap === "per-retirement",
  );
  assert.doesNotThrow(() => ledger.assertMaySpend(idempotencyKey(ORDER), 0.05));
});

test("the daily cap counts unresolved attempts, not just settled ones", () => {
  // A run of timeouts each *may* have spent. Counting only confirmed spending
  // would let a loop that times out repeatedly walk straight through the cap
  // while burning a credit on every pass.
  const ledger = freshLedger({ perRetirementUsdc: 1, dailyUsdc: 0.1 });
  ledger.record(attempt("a", 0.04));
  ledger.record(attempt("b", 0.04));

  assert.equal(ledger.spentLast24h(), 0.08);
  assert.throws(
    () => ledger.assertMaySpend("c", 0.04),
    (error: unknown) => error instanceof SpendCapExceeded && error.cap === "daily",
  );
});

test("the daily window rolls rather than resetting at midnight", () => {
  // A calendar cap resets at a moment nobody is watching, so a loop that
  // empties the budget at 23:59 gets a fresh one a minute later.
  const now = new Date("2026-08-14T12:00:00Z");
  const ledger = freshLedger({ perRetirementUsdc: 1, dailyUsdc: 0.1 }, () => now);
  ledger.record(attempt("old", 0.09, "2026-08-13T11:00:00Z"));
  ledger.record(attempt("recent", 0.05, "2026-08-14T11:00:00Z"));

  assert.equal(ledger.spentLast24h(), 0.05, "the 25-hour-old attempt has aged out");
});

test("a record is on disk before the call it protects could have been made", () => {
  // The whole point of the ledger is that it is written first. This asserts the
  // bytes are readable by a separate reader immediately after `record` returns.
  const ledger = freshLedger();
  ledger.record(attempt("k", 0.03));

  const lines = readFileSync(ledger.path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0] as string).state, "attempting");
});

test("a missing ledger is empty, not an error", () => {
  // The first retirement has to be able to happen.
  const ledger = freshLedger();
  assert.deepEqual(ledger.all(), []);
  assert.equal(ledger.spentLast24h(), 0);
  assert.doesNotThrow(() => ledger.assertMaySpend("first", 0.03));
});

test("blank lines in the ledger are tolerated", () => {
  const ledger = freshLedger();
  ledger.record(attempt("k", 0.03));
  writeFileSync(ledger.path, `${readFileSync(ledger.path, "utf8")}\n\n`, "utf8");

  assert.equal(ledger.all().length, 1);
});

test("caps come from the environment, and a typo refuses to boot", () => {
  // Silently falling back to a default that is larger than what was intended
  // is the failure this prevents.
  assert.deepEqual(capsFromEnv({}), DEFAULT_CAPS);
  assert.equal(
    capsFromEnv({ ROUTELOCK_X402_MAX_USDC_PER_RETIREMENT: "0.5" }).perRetirementUsdc,
    0.5,
  );
  for (const bad of ["nonsense", "-1", "0"]) {
    assert.throws(
      () => capsFromEnv({ ROUTELOCK_X402_MAX_USDC_PER_DAY: bad }),
      RangeError,
    );
  }
});
