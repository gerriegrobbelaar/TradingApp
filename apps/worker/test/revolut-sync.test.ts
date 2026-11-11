/**
 * The Revolut sync jobs (task R3a, ADR 0033): revolut.sync (balances, poll, pending refresh) and
 * revolut.backfill (35-day walk, missing count, initial 90-day backfill), including resumable
 * cursors, skip codes, failure codes, the call budget and the "counts and codes only" results.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CREDENTIALS_REJECTED } from "../src/revolut/gate";
import {
  BACKFILL_CALL_BUDGET,
  BACKFILL_DAYS,
  BACKFILL_MAX_PAGES,
  INITIAL_BACKFILL_DAYS,
  POLL_OVERLAP_MS,
  requestBackfill,
  runRevolutBackfill,
  runRevolutSync,
  SYNC_CALL_BUDGET,
  SYNC_DETAILS_PER_RUN,
  SYNC_MAX_PAGES,
  SYNC_PENDING_REFRESH,
} from "../src/revolut/sync";
import type { HandlerResult, JobContext } from "../src/jobs/types";
import { db } from "./helpers";
import { assertCountsAndCodesOnly } from "./counts-only";
import { resetRevolut, seedRevolut, stubRevolut, type RevolutStub } from "./revolut-helpers";
import {
  ACC_EUR,
  ACC_USD,
  fakeRevolut,
  OUR_IBAN,
  rowsOf,
  simpleTx,
  type FakeRevolut,
  type FakeTransaction,
} from "./revolut-r3-helpers";

let connId: number;
let stub: RevolutStub;
let api: FakeRevolut;

const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

function ctxFor(handler: string, over: Partial<JobContext> = {}): JobContext {
  const t = Date.now();
  return {
    env,
    job: { id: 1, name: handler, handler, exactBudget: 0 },
    run: { id: 1, attempt: 1, scheduledFor: new Date(t).toISOString(), requestedBy: "system" },
    trigger: "schedule",
    budget: 0,
    deadlineMs: t + 10 * 60_000,
    signal: new AbortController().signal,
    log: () => undefined,
    now: () => Date.now(),
    ...over,
  };
}

const sync = (over: Partial<JobContext> = {}) => runRevolutSync(ctxFor("revolut.sync", over));
const backfill = (over: Partial<JobContext> = {}) =>
  runRevolutBackfill(ctxFor("revolut.backfill", over));

const tx = (id: string, hoursAgo: number, over: Partial<FakeTransaction> = {}): FakeTransaction =>
  simpleTx(id, { createdAt: ago(hoursAgo), ...over });

const stateRow = async (entity: string) =>
  db
    .prepare("SELECT * FROM revolut_sync_state WHERE connection_id = ?1 AND entity = ?2")
    .bind(connId, entity)
    .first<Record<string, unknown>>();

const apiPaths = () => stub.apiCalls.map((c) => c.url.pathname);

beforeEach(async () => {
  await resetRevolut();
  connId = await seedRevolut({ status: "active" });
  stub = stubRevolut();
  api = fakeRevolut();
  stub.api = api.handle;
});
afterEach(() => stub.restore());

describe("budget arithmetic (ADR 0033)", () => {
  it("the parts of a poll run fit the per-run budget, and the day fits the rate limit", () => {
    const worst = 1 + SYNC_DETAILS_PER_RUN + SYNC_MAX_PAGES + SYNC_PENDING_REFRESH;
    expect(worst).toBeLessThanOrEqual(SYNC_CALL_BUDGET);
    expect(BACKFILL_MAX_PAGES).toBeLessThanOrEqual(BACKFILL_CALL_BUDGET);
    // Every 5 minutes (the fastest allowed): 288 runs a day, 10 calls each, and a run's calls are
    // spread over seconds, far below 60 per minute.
    expect(288 * SYNC_CALL_BUDGET).toBe(2880);
    expect(SYNC_CALL_BUDGET).toBeLessThanOrEqual(60);
    // Every 10 minutes (the default): 144 runs.
    expect(144 * SYNC_CALL_BUDGET).toBe(1440);
  });
});

describe("revolut.sync: skips", () => {
  it("skips with a code when there is no usable connection", async () => {
    await resetRevolut();
    expect(await sync()).toMatchObject({ status: "skipped", code: "no_connection" });
    const staged = await seedRevolut({ status: "pending" });
    expect(await sync()).toMatchObject({ status: "skipped", code: "pending_confirmation" });
    await db
      .prepare("UPDATE connections SET status = 'needs_reauth' WHERE id = ?1")
      .bind(staged)
      .run();
    expect(await sync()).toMatchObject({ status: "skipped", code: "needs_reauth" });
    await db.prepare("UPDATE connections SET status = 'disabled' WHERE id = ?1").bind(staged).run();
    expect(await sync()).toMatchObject({ status: "skipped", code: "not_active" });
    await db
      .prepare("UPDATE connections SET status = 'active', last_error = ?2 WHERE id = ?1")
      .bind(staged, CREDENTIALS_REJECTED)
      .run();
    expect(await sync()).toMatchObject({ status: "skipped", code: "credentials_rejected" });
    expect(stub.apiCalls).toEqual([]);
    expect(await rowsOf("revolut_sync_state")).toEqual([]);
  });

  it("backfill skips the same way", async () => {
    await db.prepare("UPDATE connections SET status = 'needs_reauth'").run();
    expect(await backfill()).toMatchObject({ status: "skipped", code: "needs_reauth" });
  });
});

describe("revolut.sync: accounts and balances", () => {
  it("stores balances in minor units, fills the IBAN once, and marks freshness", async () => {
    const r = await sync();
    expect(r.status).toBe("ok");
    const accounts = await rowsOf("bank_accounts", `connection_id = ${connId}`);
    const eur = accounts.find((a) => a["external_id"] === ACC_EUR);
    const usd = accounts.find((a) => a["external_id"] === ACC_USD);
    expect(eur).toMatchObject({
      name: "Main EUR",
      currency: "EUR",
      balance_minor: 123450,
      state: "active",
      is_active: 1,
      iban: OUR_IBAN,
      bic: "REVOGB21",
    });
    expect(usd).toMatchObject({ balance_minor: 1000, iban: null, bic: "", is_active: 1 });
    expect(typeof eur?.["balance_at"]).toBe("string");
    expect(await stateRow("accounts")).toMatchObject({ last_status: "ok" });
    expect((await stateRow("accounts"))?.["last_completed_at"]).toBeTruthy();
    // IBAN lookups happen once per account, not every run.
    const detailCalls = () => apiPaths().filter((p) => p.endsWith("/bank-details")).length;
    expect(detailCalls()).toBe(2);
    await sync();
    expect(detailCalls()).toBe(2);
  });

  it("retires accounts only after a complete, non-empty read", async () => {
    await sync();
    api.accounts = api.accounts.filter((a) => a.id === ACC_EUR);
    await sync();
    const active = async (id: string) =>
      (
        await db
          .prepare("SELECT is_active FROM bank_accounts WHERE external_id = ?1")
          .bind(id)
          .first<{ is_active: number }>()
      )?.is_active;
    expect(await active(ACC_USD)).toBe(0);
    expect(await active(ACC_EUR)).toBe(1);
    // An empty answer retires nothing.
    api.accounts = [];
    await sync();
    expect(await active(ACC_EUR)).toBe(1);
    // A failed read retires nothing.
    api.accounts = api.accounts.length ? api.accounts : [];
    api.failAll = 400;
    await sync();
    expect(await active(ACC_EUR)).toBe(1);
  });
});

describe("revolut.sync: the transaction poll", () => {
  it("ingests recent transactions with source poll, counts only in the result", async () => {
    api.transactions = [tx("t1", 1), tx("t2", 2, { state: "pending" }), tx("t-old", 30)];
    const r = await sync();
    expect(r).toMatchObject({ status: "ok" });
    expect(r.summary).toMatchObject({ seen: 2, inserted: 2, updated: 0, complete: true });
    const rows = await rowsOf("bank_transactions");
    expect(rows.map((x) => x["external_id"]).sort()).toEqual(["t1", "t2"]);
    expect(rows.every((x) => x["source"] === "poll")).toBe(true);
    assertCountsAndCodesOnly(r.summary);
    expect(r.callsUsed).toBeLessThanOrEqual(SYNC_CALL_BUDGET);
    const t = await stateRow("transactions");
    expect(t).toMatchObject({ last_status: "ok", cursor: null });
    expect(t?.["watermark"]).toBeTruthy();
  });

  it("a second run is a no-op on the data and cheap", async () => {
    api.transactions = [tx("t1", 1)];
    await sync();
    const before = await rowsOf("bank_transactions");
    stub.apiCalls.length = 0;
    const r = await sync();
    const after = await rowsOf("bank_transactions");
    expect(r.summary).toMatchObject({ inserted: 0, updated: 0 });
    expect(after.map((x) => x["id"])).toEqual(before.map((x) => x["id"]));
    // accounts (1) + the two-call end of a walk; no details, nothing pending
    expect(r.callsUsed).toBeLessThanOrEqual(4);
  });

  it("starts 2 hours before the end of the last complete walk (overlap)", async () => {
    await sync();
    const watermark = String((await stateRow("transactions"))?.["watermark"]);
    stub.apiCalls.length = 0;
    await sync();
    const from = stub.apiCalls
      .find((c) => c.url.pathname === "/api/1.0/transactions")
      ?.url.searchParams.get("from");
    expect(Date.parse(from ?? "")).toBe(Date.parse(watermark) - POLL_OVERLAP_MS);
  });

  it("a transaction created inside the overlap window after the last walk is found", async () => {
    await sync();
    // Appears late (eventual consistency): created 90 minutes before the last walk started.
    api.transactions = [tx("late", 1.5)];
    const r = await sync();
    expect(r.summary).toMatchObject({ inserted: 1 });
    expect(await rowsOf("bank_transactions")).toHaveLength(1);
  });

  it("resumes an unfinished walk from the saved cursor and finishes", async () => {
    api.maxCount = 2; // the server returns 2 rows per call whatever is asked
    api.transactions = Array.from({ length: 11 }, (_, i) => tx(`t${i + 1}`, 0.5 + i / 20));
    const first = await sync();
    expect(first.status).toBe("partial");
    expect(first.code).toBe("walk_incomplete");
    expect(first.callsUsed).toBeLessThanOrEqual(SYNC_CALL_BUDGET);
    const mid = await stateRow("transactions");
    expect(mid?.["cursor"]).toBeTruthy();
    expect(mid?.["watermark"]).toBeNull();
    const partRows = (await rowsOf("bank_transactions")).length;
    expect(partRows).toBeGreaterThan(0);
    expect(partRows).toBeLessThan(11);

    let guard = 0;
    let last: HandlerResult = first;
    while (last.status === "partial" && guard++ < 6) last = await sync();
    expect(last.status).toBe("ok");
    expect(await rowsOf("bank_transactions")).toHaveLength(11);
    const done = await stateRow("transactions");
    expect(done).toMatchObject({ cursor: null, last_status: "ok" });
    expect(done?.["watermark"]).toBeTruthy();
  });

  it("refreshes old pending rows (outside the poll window) so a missed state change heals", async () => {
    await sync();
    // A pending row from 3 days ago, completed at Revolut meanwhile.
    api.transactions = [tx("old", 72, { state: "completed", updatedAt: ago(1) })];
    await db
      .prepare(
        `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, leg_id, state, amount_minor,
                                        currency, booked_at, created_at, updated_at, source)
         VALUES (?1, (SELECT id FROM bank_accounts WHERE external_id = ?2), 'old', 'old-l1', 'pending', -10050,
                 'EUR', ?3, ?3, ?4, 'webhook')`,
      )
      .bind(connId, ACC_EUR, ago(72), ago(71))
      .run();
    const r = await sync();
    expect(r.summary).toMatchObject({ pendingRefreshed: 1 });
    expect((await rowsOf("bank_transactions", "external_id = 'old'"))[0]).toMatchObject({
      state: "completed",
    });
  });

  it("a pending row Revolut no longer knows does not hog the refresh slots", async () => {
    await sync();
    const insert = (id: string, lastEvent: string) =>
      db
        .prepare(
          `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, leg_id, state, amount_minor,
                                          currency, booked_at, created_at, last_event_at, source)
           VALUES (?1, (SELECT id FROM bank_accounts WHERE external_id = ?2), ?3, ?3 || '-l', 'pending', -1,
                   'EUR', ?4, ?4, ?5, 'webhook')`,
        )
        .bind(connId, ACC_EUR, id, ago(100), lastEvent)
        .run();
    await insert("gone-1", "2026-01-01T00:00:00.000Z");
    await insert("gone-2", "2026-01-02T00:00:00.000Z");
    await insert("gone-3", "2026-01-03T00:00:00.000Z");
    api.transactions = [];
    await sync();
    await sync();
    const asked = stub.apiCalls
      .filter((c) => c.url.pathname.startsWith("/api/1.0/transaction/"))
      .map((c) => c.url.pathname);
    // Over two runs all three were looked at, not the first two over and over.
    expect(new Set(asked).size).toBe(3);
  });
});

describe("revolut.sync: failures", () => {
  it("a rate limit is a partial run with a code, nothing half-recorded", async () => {
    api.failAll = 429;
    const r = await sync();
    expect(r).toMatchObject({ status: "partial", code: "rate_limited" });
    expect(await stateRow("transactions")).toMatchObject({
      last_status: "partial",
      last_error: "rate_limited",
    });
  });

  it("a permanent API error is an error with a code, a rejected token a skip", async () => {
    api.failAll = 400;
    expect(await sync()).toMatchObject({ status: "error", code: "api_400" });
    api.failAll = null;
    await db.prepare("UPDATE connections SET status = 'needs_reauth'").run();
    expect(await sync()).toMatchObject({ status: "skipped", code: "needs_reauth" });
  });

  it("stops between calls when the signal is aborted", async () => {
    api.transactions = [tx("t1", 1)];
    const ac = new AbortController();
    ac.abort();
    const r = await sync({ signal: ac.signal });
    expect(r.status).toBe("partial");
    expect(await rowsOf("bank_transactions")).toEqual([]);
  });

  it("writes one summary audit row for a run that changed something, none for a quiet one", async () => {
    const count = async () =>
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'revolut.sync_run'")
          .first<{ n: number }>()
      )?.n ?? 0;
    const before = await count();
    api.transactions = [tx("t1", 1)];
    await sync();
    expect(await count()).toBe(before + 1);
    await sync();
    expect(await count()).toBe(before + 1);
    const row = await db
      .prepare(
        "SELECT after_json FROM audit_log WHERE action = 'revolut.sync_run' ORDER BY id DESC LIMIT 1",
      )
      .first<{ after_json: string }>();
    expect(JSON.parse(row?.after_json ?? "{}")).toMatchObject({ status: "ok", inserted: 1 });
    expect(row?.after_json).not.toMatch(/[A-Z]{2}\d{2}[A-Z0-9]{10,}/);
  });
});

describe("revolut.backfill", () => {
  it("walks the last 35 days from the slot, not from the clock", async () => {
    const slot = Date.parse("2026-07-01T03:15:00.000Z");
    api.transactions = [
      simpleTx("in", { createdAt: "2026-06-10T10:00:00.000Z" }),
      simpleTx("out", { createdAt: "2026-05-20T10:00:00.000Z" }),
    ];
    const r = await backfill({
      run: { id: 1, attempt: 2, scheduledFor: new Date(slot).toISOString(), requestedBy: "system" },
    });
    expect(r.status).toBe("ok");
    const from = stub.apiCalls
      .find((c) => c.url.pathname === "/api/1.0/transactions")
      ?.url.searchParams.get("from");
    expect(Date.parse(from ?? "")).toBe(slot - BACKFILL_DAYS * 24 * HOUR);
    expect((await rowsOf("bank_transactions")).map((x) => x["external_id"])).toEqual(["in"]);
    expect((await rowsOf("bank_transactions"))[0]?.["source"]).toBe("backfill");
  });

  it("counts transactions that were missing: the data-quality signal", async () => {
    api.transactions = [tx("a", 10), tx("b", 20), tx("c", 30)];
    // 'a' arrived by webhook before.
    const { upsertTransaction } = await import("../src/revolut/ingest");
    const { mapTransaction, parseJsonRawNumbers } = await import("@camelthorn/revolut");
    const { txJson } = await import("./revolut-r3-helpers");
    await upsertTransaction(
      env,
      connId,
      mapTransaction(parseJsonRawNumbers(JSON.stringify(txJson(tx("a", 10))))),
      "webhook",
    );
    const r = await backfill();
    expect(r.summary).toMatchObject({
      seen: 3,
      missing: 2,
      inserted: 2,
      initial: false,
      complete: true,
    });
    expect(await stateRow("backfill")).toMatchObject({
      last_missing: 2,
      rows_missing: 2,
      cursor: null,
    });
    // Run again: nothing missing any more.
    const again = await backfill();
    expect(again.summary).toMatchObject({ missing: 0, inserted: 0 });
    expect(await stateRow("backfill")).toMatchObject({ last_missing: 0 });
    assertCountsAndCodesOnly(r.summary);
  });

  it("the one-off initial backfill covers 90 days and is not a data-quality signal", async () => {
    api.transactions = [tx("a", 24 * 80), tx("b", 24 * 100)];
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
    const r = await backfill();
    expect(r.summary).toMatchObject({ initial: true, windowDays: 90, missing: 1, complete: true });
    expect(await rowsOf("bank_transactions")).toHaveLength(1);
    const s = await stateRow("backfill");
    expect(s).toMatchObject({ requested_days: null, last_missing: null });
    // the next ordinary run is a 35-day walk again
    const next = await backfill();
    expect(next.summary).toMatchObject({ initial: false, windowDays: 35 });
  });

  it("a walk that does not finish keeps its cursor, asks for a retry, and resumes with the same bounds", async () => {
    // The server returns 2 rows per call, one of them the boundary row seen before: one new row
    // per call.
    api.maxCount = 2;
    api.transactions = Array.from({ length: BACKFILL_MAX_PAGES + 5 }, (_, i) =>
      tx(`t${i + 1}`, 1 + i),
    );
    const first = await backfill();
    expect(first.status).toBe("partial");
    expect(first.retry?.delaySeconds).toBeGreaterThan(0);
    expect(first.callsUsed).toBeLessThanOrEqual(BACKFILL_CALL_BUDGET);
    const mid = await stateRow("backfill");
    expect(mid?.["cursor"]).toBeTruthy();
    const from = mid?.["window_from"];
    const second = await backfill({
      run: {
        id: 2,
        attempt: 2,
        scheduledFor: new Date(Date.now() + 5 * 24 * HOUR).toISOString(),
        requestedBy: "system",
      },
    });
    expect(second.status).toBe("ok");
    expect((await stateRow("backfill"))?.["window_from"]).toBeNull();
    expect(from).toBeTruthy();
    expect(await rowsOf("bank_transactions")).toHaveLength(BACKFILL_MAX_PAGES + 5);
    // The count accumulated over both runs.
    expect(second.summary).toMatchObject({ missing: BACKFILL_MAX_PAGES + 5, complete: true });
  });

  it("runs twice with the same result and rows", async () => {
    api.transactions = [tx("a", 10), tx("b", 20)];
    await backfill();
    const rows = await rowsOf("bank_transactions");
    await backfill();
    expect(await rowsOf("bank_transactions")).toEqual(
      rows.map((r) => ({ ...r, last_event_at: expect.any(String) })),
    );
  });
});
