/**
 * Generic handler contract test (review S1, types.ts "HANDLER CONTRACT").
 *
 * Every registered handler that has a `run` is executed TWICE with the same inputs. The test
 * records what crosses the external boundary (Exact transport; the idempotency table) and asserts:
 *  - no external write is repeated: a write needs an idempotency key claimed by the business
 *    object, and the second run adds no write that the first already made;
 *  - the data tables are stable after the second run (no duplicated rows);
 *  - the stored result holds counts and codes only: short strings, no IBAN, e-mail or URL.
 *
 * A handler that gets a `run` without a fixture here fails the suite on purpose: the author must
 * say how to run it twice.
 */
import { env } from "cloudflare:test";
import type { ExactRequest, ExactTransport } from "@camelthorn/exact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDLERS } from "../src/jobs/handlers";
import { FakeExact as BookingFakeExact } from "./booking-fake-exact";
import { bookingWorld, seedBookable } from "./booking-helpers";
import type { HandlerResult, JobContext } from "../src/jobs/types";
import { assertCountsAndCodesOnly, MAX_STRING } from "./counts-only";
import { stubEcb, type FakeEcb } from "./fx-helpers";
import {
  addItem,
  addRelation,
  addTx,
  CUSTOMER_IBAN,
  enableAuto,
  resetWorld,
} from "./matching-helpers";
import { resetRevolut, seedRevolut, stubRevolut } from "./revolut-helpers";
import { cpRecord, rawApi, rawLeg, rawTx } from "./revolut-q1-helpers";
import { fakeRevolut, simpleTx } from "./revolut-r3-helpers";
import { FakeExact, addDivision, fakeGate, resetSync } from "./sync-helpers";
import { outboxWipeStatements } from "./outbox-wipe";

const db = env.DB;
const NOW = Date.parse("2026-07-15T00:00:00Z"); // 02:00 CEST

/** Tables where a repeated run must not add rows. */
const DATA_TABLES = [
  // Children first: the delete order below is also the order of the foreign keys.
  "exact_write_outbox",
  "exact_write_outbox",
  "match_suggestions",
  "match_allocations",
  "matches",
  "bank_account_exact_map",
  "open_items",
  "relations",
  "relation_bank_accounts",

  "bank_transactions",
  "bank_accounts",
  "revolut_sync_state",
  // Phase 5 review Q1: the quarantine and the counterparty cache must not grow on a repeated run.
  "revolut_quarantine",
  "revolut_counterparties",
  "webhook_events",
  "payments",
  "payment_batches",
  "approvals",
  "fx_rates",
  "fx_revaluations",
  "email_log",
  "reminders",
  "dq_issues",
  "idempotency_keys",
] as const;

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of DATA_TABLES) {
    out[t] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? -1;
  }
  return out;
}

/** What the handler did to the outside world, as seen at the fake boundary. */
interface Effects {
  /** Every external call (method and path only). */
  calls: { method: string; path: string }[];
  /** Calls that change something outside (anything but GET). */
  writes: { method: string; path: string; body: string }[];
}

interface Fixture {
  /** The handler writes to the outside world by design (booking): the first run must write, a second must not. */
  writes?: true;
  /** The handler works on D1 only: there is no external boundary to observe. */
  internal?: true;
  /** Prepares the database and the fakes; returns the syncDeps-style test seam and the effects log. */
  setup(): Promise<{ syncDeps: JobContext["syncDeps"]; effects: Effects }>;
  /** Restores whatever setup stubbed. */
  teardown?(): void;
}

function recording(inner: ExactTransport, effects: Effects): ExactTransport {
  return async (req: ExactRequest) => {
    effects.calls.push({ method: req.method, path: req.path });
    if (req.method !== "GET") {
      effects.writes.push({ method: req.method, path: req.path, body: req.body ?? "" });
    }
    return inner(req);
  };
}

async function exactFixture(): Promise<{ syncDeps: JobContext["syncDeps"]; effects: Effects }> {
  await resetSync();
  const div = await addDivision();
  const fx = new FakeExact(div.exactDivision);
  fx.divisions = [{ code: div.exactDivision, description: "Camelthorn Advisory B.V." }];
  fx.accounts = [
    { n: 1, name: "Acme BV", ts: 1, supplier: true, email: "billing@acme.example" },
    { n: 2, name: "Globex", ts: 2, customer: true, email: "ap@globex.example" },
  ];
  fx.banks = [{ n: 1, account: 1, iban: "NL91ABNA0417164300" }];
  fx.receivables = [
    {
      n: 101,
      account: 2,
      name: "Globex",
      amount: 100.5,
      currency: "EUR",
      invoiceNumber: 2026001,
      ts: 3,
    },
  ];
  fx.payables = [
    { n: 201, account: 1, name: "Acme BV", amount: 40, currency: "EUR", invoiceNumber: 77, ts: 4 },
  ];
  const effects: Effects = { calls: [], writes: [] };
  return {
    syncDeps: { transport: recording(fx.transport, effects), gate: fakeGate(), now: () => NOW },
    effects,
  };
}

/**
 * The Revolut boundary is the fetch stub behind the real RevolutGate: every call to Revolut is
 * recorded (method and path). The two Revolut handlers only read from Revolut and write to D1.
 */
let revolutStub: ReturnType<typeof stubRevolut> | null = null;
async function revolutFixture(): Promise<{ syncDeps: JobContext["syncDeps"]; effects: Effects }> {
  await resetRevolut();
  const id = await seedRevolut({ status: "active" });
  expect(id).toBeGreaterThan(0);
  const stub = stubRevolut();
  revolutStub = stub;
  const api = fakeRevolut();
  api.transactions = [
    simpleTx("rc-1", { createdAt: new Date(NOW - 3_600_000).toISOString() }),
    simpleTx("rc-2", { createdAt: new Date(NOW - 7_200_000).toISOString(), state: "pending" }),
  ];
  // Review Q1 paths: a bad row (quarantine), a leg without our account (skipped), and a
  // counterparty that has only an id (the lazy GET /counterparty/{id} lookup).
  const raw = rawApi(api);
  raw.rows = [
    rawTx("rc-bad", new Date(NOW - 1_800_000).toISOString(), [{ amount: "x" }]),
    rawTx("rc-skip", new Date(NOW - 2_400_000).toISOString(), [
      rawLeg("a", { counterparty: { id: "cp-c", account_type: "external", name: "Acme" } }),
      rawLeg("b", { account_id: undefined }),
    ]),
  ];
  raw.counterparties.set(
    "cp-c",
    cpRecord("cp-c", [{ id: "x", iban: "NL91ABNA0417164300", currency: "EUR" }]),
  );
  stub.api = raw.handle;
  const effects: Effects = { calls: [], writes: [] };
  // Mirror what reaches Revolut into the effects log as the gate makes the calls.
  const original = raw.handle;
  stub.api = (c) => {
    effects.calls.push({ method: c.method, path: c.url.pathname });
    if (c.method !== "GET")
      effects.writes.push({ method: c.method, path: c.url.pathname, body: c.body ?? "" });
    return original(c);
  };
  return { syncDeps: undefined, effects };
}

/**
 * The ECB boundary is the fetch stub: one plain GET per run, nothing is ever written to the ECB.
 * It serves rates up to the day before the slot, so a scheduled run ends partial (not yet
 * published) and a manual run ends ok; both are repeatable.
 */
let ecbStub: FakeEcb | null = null;
async function ecbFixture(): Promise<{ syncDeps: JobContext["syncDeps"]; effects: Effects }> {
  const stub = stubEcb();
  ecbStub = stub;
  stub.fill({ USD: 1.1, GBP: 0.86, JPY: 160 }, "2026-06-01", "2026-07-14");
  // Live views of the stub's call log: every request is a call, anything but a GET a write.
  const view = () =>
    stub.calls.map((c) => ({ method: c.init?.method ?? "GET", path: c.url.pathname }));
  const effects = {} as Effects;
  Object.defineProperty(effects, "calls", { get: view });
  Object.defineProperty(effects, "writes", {
    get: () =>
      view()
        .filter((c) => c.method !== "GET")
        .map((c) => ({ ...c, body: "" })),
  });
  return { syncDeps: undefined, effects };
}

/**
 * bank.match reads and writes D1 only (suggestions, and automatic matches when switched on). The
 * fixture has one perfect match (automatic matching ON, so the first run creates the match) and
 * one amount-only suggestion; the second run must change nothing.
 */
async function matchingFixture(): Promise<{ syncDeps: JobContext["syncDeps"]; effects: Effects }> {
  const w = await resetWorld();
  await enableAuto();
  const rel = await addRelation({ divisionId: w.divisionId, ibans: [CUSTOMER_IBAN] });
  const a = await addItem({
    divisionId: w.divisionId,
    invoiceNumber: "INV-2026-0042",
    openMinor: 12_345,
    relationExactId: rel.exactId,
  });
  expect(a).toBeGreaterThan(0);
  await addItem({ divisionId: w.divisionId, invoiceNumber: "INV-2026-0099", openMinor: 5_000 });
  await addTx({
    accountId: w.accountId,
    connectionId: w.revolutConnectionId,
    amountMinor: 12_345,
    reference: "Payment INV-2026-0042",
    counterpartyIban: CUSTOMER_IBAN,
  });
  await addTx({ accountId: w.accountId, connectionId: w.revolutConnectionId, amountMinor: 5_000 });
  return { syncDeps: undefined, effects: { calls: [], writes: [] } };
}

/**
 * exact.book_matches WRITES to Exact by design (behind the fail-closed switch, which this fixture
 * turns on): one bank entry and one MatchSet for one match. The contract still holds: the first
 * run's writes each have their idempotency key claimed first, and the second run repeats nothing.
 */
async function bookingFixture(): Promise<{ syncDeps: JobContext["syncDeps"]; effects: Effects }> {
  const w = await bookingWorld({ creates: true });
  const fake = new BookingFakeExact();
  fake.closing.set("90", 100_000);
  await seedBookable(w, fake, { createdAt: "2026-07-14T08:00:00.000Z" });
  const effects: Effects = { calls: [], writes: [] };
  return {
    syncDeps: { transport: recording(fake.transport, effects), gate: fakeGate(), now: () => NOW },
    effects,
  };
}

/** One entry per implemented handler. */
const FIXTURES: Record<string, Fixture> = {
  "exact.book_matches": { setup: bookingFixture, writes: true },
  "exact.full_sync": { setup: exactFixture },
  "exact.incremental_sync": { setup: exactFixture },
  "revolut.sync": { setup: revolutFixture, teardown: () => revolutStub?.restore() },
  "revolut.backfill": { setup: revolutFixture, teardown: () => revolutStub?.restore() },
  "ecb.fx_import": { setup: ecbFixture, teardown: () => ecbStub?.restore() },
  "bank.match": { setup: matchingFixture, internal: true },
};

function contextFor(
  key: string,
  trigger: JobContext["trigger"],
  syncDeps: JobContext["syncDeps"],
): JobContext {
  const budget =
    key === "exact.full_sync"
      ? 240
      : key === "exact.book_matches"
        ? 30
        : key.startsWith("revolut.") || key === "bank.match"
          ? 0
          : 40;
  return {
    env,
    job: { id: 1, name: key, handler: key, exactBudget: budget },
    run: { id: 1, attempt: 1, scheduledFor: new Date(NOW).toISOString(), requestedBy: "system" },
    trigger,
    budget,
    deadlineMs: NOW + 60 * 60_000,
    signal: new AbortController().signal,
    log: () => undefined,
    now: () => NOW,
    ...(syncDeps ? { syncDeps } : {}),
  };
}

const implemented = Object.entries(HANDLERS).filter(([, d]) => d.run !== undefined);

describe("handler contract: every implemented handler", () => {
  afterEach(() => {
    for (const f of Object.values(FIXTURES)) f.teardown?.();
  });

  it("has a contract fixture (add one when a handler gets a run)", () => {
    for (const [key] of implemented) {
      expect(FIXTURES[key], `no contract fixture for ${key}`).toBeDefined();
    }
    for (const key of Object.keys(FIXTURES)) {
      expect(HANDLERS[key]?.run, `fixture for ${key} but it is not implemented`).toBeDefined();
    }
  });

  it("declares sane contract fields", () => {
    for (const [key, d] of implemented) {
      expect(d.maxAttempts, key).toBeGreaterThanOrEqual(1);
      expect(d.maxLatenessMs, `${key} should bound its lateness`).toBeGreaterThan(0);
      for (const r of d.runRoles ?? [])
        expect(["admin", "finance", "approver", "viewer"]).toContain(r);
    }
  });

  for (const [key, def] of implemented) {
    for (const trigger of ["schedule", "manual"] as const) {
      describe(`${key} (${trigger})`, () => {
        beforeEach(async () => {
          const wipe = await outboxWipeStatements(db);
          await db.batch(
            DATA_TABLES.flatMap((t) =>
              t === "exact_write_outbox" ? wipe : [db.prepare(`DELETE FROM ${t}`)],
            ),
          );
        });

        it("run twice with the same context: no duplicated external effect, stable rows, counts and codes only", async () => {
          const fixture = FIXTURES[key] as Fixture;
          const { syncDeps, effects } = await fixture.setup();
          const run = def.run as (ctx: JobContext) => Promise<HandlerResult>;

          const first = await run(contextFor(key, trigger, syncDeps));
          if (fixture.internal) expect(effects.calls).toEqual([]);
          else {
            expect(
              effects.calls.length,
              "the first run should really talk to the boundary",
            ).toBeGreaterThan(0);
          }
          const writes1 = effects.writes.length;
          const idemAfterFirst = (await counts())["idempotency_keys"];
          const rowsAfterFirst = await counts();

          const second = await run(contextFor(key, trigger, syncDeps));
          const rowsAfterSecond = await counts();

          // The sync handlers only read from Exact and write to D1.
          if (fixture.writes) expect(writes1, "the booking run writes").toBeGreaterThan(0);
          else expect(effects.writes, "external writes").toEqual([]);
          // Generic rule for handlers that do write: a second run adds no write, and every write
          // had its idempotency key claimed first.
          expect(effects.writes.length - writes1).toBe(0);
          if (writes1 > 0) expect(idemAfterFirst).toBeGreaterThanOrEqual(writes1);
          expect(rowsAfterSecond).toEqual(rowsAfterFirst);
          expect(first.status).not.toBe("error");
          expect(second.status).not.toBe("error");

          for (const r of [first, second]) {
            assertCountsAndCodesOnly(r.summary);
            if (r.code !== undefined) expect(r.code).toMatch(/^[a-z][a-z0-9_]*$/);
            expect(JSON.stringify(r).length).toBeLessThan(4000);
          }
        });
      });
    }
  }

  it("the checker really rejects personal data and long strings", () => {
    expect(() => assertCountsAndCodesOnly({ x: "NL91ABNA0417164300" })).toThrow();
    expect(() => assertCountsAndCodesOnly({ x: "someone@example.com" })).toThrow();
    expect(() => assertCountsAndCodesOnly({ x: ["https://example.com/a"] })).toThrow();
    expect(() => assertCountsAndCodesOnly({ x: "a".repeat(MAX_STRING + 1) })).toThrow();
    expect(() =>
      assertCountsAndCodesOnly({ ok: 1, code: "done_today", list: [{ id: 3 }] }),
    ).not.toThrow();
  });
});
