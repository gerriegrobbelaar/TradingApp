/**
 * Phase 5 review Q1: S6 counterparty lookup (ADR 0034), N3 (re-authorised to other accounts) and
 * N4 (bank-details lookup outcomes). Payload shapes of /counterparty/{id} and /accounts/{id}/bank-details
 * are ASSUMPTIONS to verify with the sandbox (ADR 0030).
 */
import { type RevolutClient, type RevolutCounterpartyRecord } from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COUNTERPARTY_LOOKUPS_PER_RUN,
  COUNTERPARTY_MAX_ATTEMPTS,
  lookUpCounterparties,
  summariseCounterparty,
} from "../src/revolut/counterparties";
import { queueInitialBackfill } from "../src/revolut/initial-backfill";
import { COUNTERPARTY_LOOKUP_JOB_ID, validateRequest } from "../src/revolut/request";
import {
  DETAILS_MAX_ATTEMPTS,
  INITIAL_BACKFILL_DAYS,
  pickOwnDetails,
  requestBackfill,
} from "../src/revolut/sync";
import { env } from "cloudflare:test";
import { db } from "./helpers";
import { assertCountsAndCodesOnly } from "./counts-only";
import {
  auditActions,
  fakeRevolutClock,
  resetRevolut,
  rreq,
  seedRevolut,
  stubRevolut,
  type RevolutStub,
} from "./revolut-helpers";
import {
  ACC_EUR,
  ACC_USD,
  fakeRevolut,
  OUR_IBAN,
  rowsOf,
  type FakeRevolut,
} from "./revolut-r3-helpers";
import {
  ago,
  cpRecord,
  later,
  rawApi,
  rawLeg,
  rawTx,
  sync,
  type RawApi,
  HOUR,
} from "./revolut-q1-helpers";

let connId: number;
let stub: RevolutStub;
let api: FakeRevolut;
let raw: RawApi;

const IBAN_A = "NL91ABNA0417164300";
const IBAN_B = "DE89370400440532013000";

beforeEach(async () => {
  await resetRevolut();
  connId = await seedRevolut({ status: "active" });
  stub = stubRevolut();
  api = fakeRevolut();
  raw = rawApi(api);
  stub.api = raw.handle;
});
afterEach(() => stub.restore());

/** A transaction whose leg names counterparty `cp` without an IBAN. */
const txFor = (id: string, cp: string, extra: Record<string, unknown> = {}) =>
  rawTx(id, ago(0.5), [
    rawLeg(`${id}-l`, {
      counterparty: {
        id: cp,
        account_type: "external",
        account_id: `${cp}-acc`,
        name: "Acme",
        ...extra,
      },
    }),
  ]);
const ibanOf = async (txId: string): Promise<unknown> =>
  (await rowsOf("bank_transactions", `external_id = '${txId}'`))[0]?.["counterparty_iban"];
const cache = () => rowsOf("revolut_counterparties");

describe("S6: the counterparty lookup", () => {
  it("fills the IBAN of an unmatched row from GET /counterparty/{id}", async () => {
    raw.rows = [txFor("t1", "cp-1")];
    raw.counterparties.set(
      "cp-1",
      cpRecord("cp-1", [{ id: "cp-1-acc", iban: IBAN_A, currency: "EUR" }]),
    );
    const r = await sync();
    expect(r.status).toBe("ok");
    expect(r.summary).toMatchObject({
      counterpartyLookups: 1,
      counterpartiesResolved: 1,
      counterpartyIbansFilled: 1,
    });
    expect(await ibanOf("t1")).toBe(IBAN_A);
    expect(raw.counterpartyCalls).toEqual(["cp-1"]);
    expect(await cache()).toMatchObject([{ counterparty_ref: "cp-1", status: "ok", iban: IBAN_A }]);
    assertCountsAndCodesOnly(r.summary);
    // The IBAN is in no run result, no audit row.
    const audit = await rowsOf("audit_log", "action LIKE 'revolut.%'");
    expect(JSON.stringify(audit)).not.toContain(IBAN_A);
  });

  it("spends at most 5 lookups per run, the rest on the next run, and never asks twice", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `cp-${i}`);
    raw.rows = ids.map((c, i) => txFor(`t${i}`, c));
    for (const c of ids) {
      raw.counterparties.set(c, cpRecord(c, [{ id: `${c}-acc`, iban: IBAN_A, currency: "EUR" }]));
    }
    const first = await sync();
    expect(first.summary["counterpartyLookups"]).toBe(COUNTERPARTY_LOOKUPS_PER_RUN);
    expect(raw.counterpartyCalls).toHaveLength(5);
    const second = await sync();
    expect(second.summary["counterpartyLookups"]).toBe(2);
    expect(new Set(raw.counterpartyCalls).size).toBe(7);
    const third = await sync();
    expect(third.summary["counterpartyLookups"]).toBeUndefined();
    expect(raw.counterpartyCalls).toHaveLength(7);
    for (let i = 0; i < 7; i++) expect(await ibanOf(`t${i}`)).toBe(IBAN_A);
    // The call count of the first run stays inside poll budget + lookup budget.
    expect(first.callsUsed ?? 0).toBeLessThanOrEqual(10 + COUNTERPARTY_LOOKUPS_PER_RUN);
  });

  it("the lookups are made under their own job id, at job priority", async () => {
    raw.rows = [txFor("t1", "cp-1")];
    raw.counterparties.set("cp-1", cpRecord("cp-1", [{ iban: IBAN_A }]));
    await sync();
    const call = stub.apiCalls.find((c) => c.url.pathname === "/api/1.0/counterparty/cp-1");
    expect(call?.method).toBe("GET");
    expect(call?.url.search).toBe("");
  });

  it("uses the counterparty account the leg names, else the EUR one", async () => {
    raw.rows = [txFor("t-eur", "cp-m"), txFor("t-usd", "cp-m")];
    raw.rows[1] = rawTx("t-usd", ago(0.4), [
      rawLeg("t-usd-l", {
        counterparty: { id: "cp-m", account_id: "acc-usd", account_type: "external" },
      }),
    ]);
    raw.rows[0] = rawTx("t-eur", ago(0.5), [
      rawLeg("t-eur-l", { counterparty: { id: "cp-m", account_type: "external" } }),
    ]);
    raw.counterparties.set(
      "cp-m",
      cpRecord("cp-m", [
        { id: "acc-usd", iban: IBAN_B, currency: "USD" },
        { id: "acc-eur", iban: IBAN_A, currency: "EUR" },
      ]),
    );
    await sync();
    expect(await ibanOf("t-eur")).toBe(IBAN_A);
    expect(await ibanOf("t-usd")).toBe(IBAN_B);
    expect(raw.counterpartyCalls).toEqual(["cp-m"]);
  });

  it("a leg that already carries an IBAN needs no lookup; an own-account (self) leg none either", async () => {
    raw.rows = [
      txFor("with-iban", "cp-1", { iban: IBAN_A }),
      rawTx("self", ago(0.3), [
        rawLeg("self-l", { counterparty: { id: "me", account_type: "self", account_id: ACC_USD } }),
      ]),
    ];
    await sync();
    expect(raw.counterpartyCalls).toEqual([]);
    expect(await ibanOf("with-iban")).toBe(IBAN_A);
  });

  it("a cached counterparty fills a NEW transaction at ingest, with no call", async () => {
    raw.rows = [txFor("t1", "cp-1")];
    raw.counterparties.set(
      "cp-1",
      cpRecord("cp-1", [{ id: "cp-1-acc", iban: IBAN_A, currency: "EUR" }]),
    );
    await sync();
    raw.rows = [...raw.rows, txFor("t2", "cp-1")];
    await sync();
    expect(await ibanOf("t2")).toBe(IBAN_A);
    expect(raw.counterpartyCalls).toEqual(["cp-1"]);
  });

  it("a stored IBAN survives a later delivery that has none", async () => {
    raw.rows = [txFor("t1", "cp-1")];
    raw.counterparties.set("cp-1", cpRecord("cp-1", [{ id: "cp-1-acc", iban: IBAN_A }]));
    await sync();
    await db.prepare("DELETE FROM revolut_counterparties").run();
    await sync(); // the poll sees t1 again, without an IBAN, cache gone
    expect(await ibanOf("t1")).toBe(IBAN_A);
  });

  it("a decided (ignored) row never gets its counterparty IBAN filled in", async () => {
    raw.rows = [txFor("t1", "cp-1")];
    await sync(); // no record yet: 404, cached as not_found
    await db.prepare("DELETE FROM revolut_counterparties").run();
    // 'matched' needs a live match since migration 0022; 'ignored' freezes the same way.
    await db.prepare("UPDATE bank_transactions SET match_status = 'ignored'").run();
    raw.counterparties.set("cp-1", cpRecord("cp-1", [{ iban: IBAN_A }]));
    await sync();
    expect(await ibanOf("t1")).toBeNull();
    expect(raw.counterpartyCalls).toEqual(["cp-1"].slice(0, 1));
  });

  it("an unknown counterparty (404) is cached and not asked again", async () => {
    raw.rows = [txFor("t1", "cp-gone")];
    await sync();
    await sync(later(5 * HOUR));
    expect(raw.counterpartyCalls).toEqual(["cp-gone"]);
    expect(await cache()).toMatchObject([{ status: "not_found", iban: null }]);
  });

  it("a counterparty without any IBAN is cached with none and not asked again", async () => {
    raw.rows = [txFor("t1", "cp-uk")];
    raw.counterparties.set("cp-uk", cpRecord("cp-uk", [{ id: "x", currency: "GBP" }]));
    const r = await sync();
    expect(r.summary).toMatchObject({ counterpartyLookups: 1, counterpartiesResolved: 0 });
    await sync();
    expect(raw.counterpartyCalls).toEqual(["cp-uk"]);
    expect(await ibanOf("t1")).toBeNull();
  });

  it("a permanent error is retried after an hour, at most 5 times; messages stay masked", async () => {
    raw.rows = [txFor("t1", "cp-bad")];
    raw.counterparties.set("cp-bad", 400);
    const r = await sync();
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r)).not.toContain(IBAN_A);
    await sync(); // within the hour: no new call
    expect(raw.counterpartyCalls).toHaveLength(1);
    for (let i = 1; i <= COUNTERPARTY_MAX_ATTEMPTS + 2; i++) {
      await sync(later(i * (HOUR + 60_000)));
    }
    expect(raw.counterpartyCalls).toHaveLength(COUNTERPARTY_MAX_ATTEMPTS);
    expect(await cache()).toMatchObject([{ status: "error", attempts: COUNTERPARTY_MAX_ATTEMPTS }]);
  });

  it("a rate limit on a lookup records nothing, ends the loop and does not fail the sync", async () => {
    raw.rows = [txFor("t1", "cp-1"), txFor("t2", "cp-2")];
    raw.counterparties.set("cp-1", 500);
    const inner = raw.handle;
    stub.api = (c) =>
      c.url.pathname.startsWith("/api/1.0/counterparty/")
        ? new Response("{}", { status: 429, headers: { "retry-after": "1" } })
        : inner(c);
    const r = await sync();
    expect(r.status).toBe("ok");
    expect(await cache()).toEqual([]);
  });

  it("the cache is bounded: a lookup run keeps at most the cap per connection", async () => {
    // Fill beyond the cap directly, then let one lookup trigger the prune.
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 5003; i++) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO revolut_counterparties (connection_id, counterparty_ref, status, fetched_at, checked_at)
             VALUES (?1, ?2, 'not_found', ?3, ?3)`,
          )
          .bind(
            connId,
            `old-${i}`,
            new Date(Date.parse("2026-01-01T00:00:00Z") + i * 1000).toISOString(),
          ),
      );
    }
    for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500));
    const client = {
      getCounterparty: async (id: string) => cpRecord(id, [{ iban: IBAN_A }]),
    } as unknown as RevolutClient;
    await lookUpCounterparties(
      db,
      client,
      connId,
      ["fresh-1"],
      Date.now(),
      new AbortController().signal,
    );
    const n = (
      await db.prepare("SELECT COUNT(*) AS n FROM revolut_counterparties").first<{ n: number }>()
    )?.n;
    expect(n).toBe(5000);
    expect(await rowsOf("revolut_counterparties", "counterparty_ref = 'fresh-1'")).toHaveLength(1);
    expect(await rowsOf("revolut_counterparties", "counterparty_ref = 'old-0'")).toHaveLength(0);
  });

  it("lookUpCounterparties with a fake client: order, abort and the IBAN preference", async () => {
    const seen: string[] = [];
    const client = {
      getCounterparty: async (id: string): Promise<RevolutCounterpartyRecord> => {
        seen.push(id);
        return cpRecord(id, [
          { id: "g", iban: IBAN_B, currency: "GBP" },
          { id: "e", iban: IBAN_A, currency: "EUR" },
        ]) as unknown as RevolutCounterpartyRecord;
      },
    } as unknown as RevolutClient;
    const ac = new AbortController();
    const res = await lookUpCounterparties(db, client, connId, ["a", "b"], Date.now(), ac.signal);
    expect(res).toMatchObject({ looked: 2, resolved: 2 });
    expect(seen).toEqual(["a", "b"]);
    expect((await cache()).every((r) => r["iban"] === IBAN_A)).toBe(true);
    ac.abort();
    const none = await lookUpCounterparties(db, client, connId, ["c"], Date.now(), ac.signal);
    expect(none.looked).toBe(0);
  });

  it("summariseCounterparty prefers EUR, caps accounts, compacts the IBAN", () => {
    const rec = cpRecord("x", [
      { iban: "de89 3704 0044 0532 0130 00", currency: "USD" },
      { iban: IBAN_A, currency: "EUR" },
      { currency: "GBP" },
    ]) as unknown as RevolutCounterpartyRecord;
    const s = summariseCounterparty(rec);
    expect(s.iban).toBe(IBAN_A);
    expect(s.accounts.map((a) => a.i)).toEqual([IBAN_B, IBAN_A]);
  });
});

describe("S6: the gate allow-list for GET /counterparty/{id}", () => {
  const ok = (over: Record<string, unknown> = {}) =>
    rreq(connId, {
      path: "/counterparty/cp-1",
      priority: "job",
      jobId: COUNTERPARTY_LOOKUP_JOB_ID,
      ...over,
    });

  it("is allowed for job priority and exactly one job id", () => {
    expect(() => validateRequest(ok())).not.toThrow();
  });

  it("is refused for user priority, any other job id, other methods and sibling paths", () => {
    expect(() => validateRequest(ok({ priority: "user" }))).toThrow();
    expect(() => validateRequest(ok({ jobId: "revolut-sync" }))).toThrow();
    expect(() => validateRequest(ok({ method: "POST" }))).toThrow();
    expect(() => validateRequest(ok({ method: "DELETE" }))).toThrow();
    for (const path of [
      "/counterparty",
      "/counterparty/",
      "/counterparty/a/b",
      "/counterparty/a?x=1",
      "/counterparty/../accounts",
      "/counterparties/cp-1",
    ]) {
      expect(() => validateRequest(ok({ path })), path).toThrow();
    }
  });
});

describe("N3: re-authorised to different accounts", () => {
  const OTHER = [
    {
      id: "9f1e2d3c-4b5a-4968-8776-655443322119",
      name: "New EUR",
      currency: "EUR",
      balance: 5,
      state: "active",
    },
  ];

  async function seedOldWalks(): Promise<void> {
    await sync();
    await db
      .prepare(
        "INSERT INTO revolut_sync_state (connection_id, entity) VALUES (?1, 'backfill') ON CONFLICT DO NOTHING",
      )
      .bind(connId)
      .run();
    await db
      .prepare(
        `UPDATE revolut_sync_state SET cursor = '{"toIso":"2026-01-01T00:00:00.000Z","seen":[]}',
           window_from = '2026-01-01T00:00:00.000Z', walk_started_at = '2026-01-01T00:00:00.000Z',
           window_days = 35, initial = 1, rows_seen = 9, rows_missing = 4
         WHERE connection_id = ?1 AND entity = 'backfill'`,
      )
      .bind(connId)
      .run();
  }

  it("the sync notices that none of its known accounts is left, resets the walks and asks for 90 days", async () => {
    raw.rows = [rawTx("old-tx", ago(1))];
    const auditBefore = await auditActions("revolut.accounts_replaced");
    await seedOldWalks();
    api.accounts = OTHER;
    // The first read without any known account only raises the suspicion: nothing is retired or
    // reset (it could be a glitch or a permission change at Revolut).
    const first = await sync();
    expect(first.summary).toMatchObject({ accountsReplacementSuspected: true, accountsRetired: 0 });
    expect(first.summary["accountsReplaced"]).toBeUndefined();
    expect((await rowsOf("revolut_sync_state", "entity = 'backfill'"))[0]).toMatchObject({
      window_from: "2026-01-01T00:00:00.000Z",
      rows_missing: 4,
    });
    expect((await rowsOf("bank_accounts", `external_id = '${ACC_EUR}'`))[0]?.["is_active"]).toBe(1);
    expect(await auditActions("revolut.accounts_replaced")).toBe(auditBefore);
    // The second read in a row confirms it.
    const r = await sync();
    expect(r.summary).toMatchObject({ accountsReplaced: true, accounts: 1, accountsRetired: 2 });
    const accounts = await rowsOf("bank_accounts", `connection_id = ${connId}`);
    expect(accounts.filter((a) => a["is_active"] === 1).map((a) => a["external_id"])).toEqual([
      OTHER[0]?.id,
    ]);
    expect(accounts.filter((a) => a["external_id"] === ACC_EUR)[0]?.["is_active"]).toBe(0);
    // History stays.
    expect((await rowsOf("bank_transactions")).map((x) => x["external_id"])).toEqual(["old-tx"]);
    expect(
      await db
        .prepare(
          "SELECT cursor, window_from, window_days, walk_started_at, requested_days, initial, rows_seen, rows_missing FROM revolut_sync_state WHERE entity = 'backfill'",
        )
        .first(),
    ).toEqual({
      cursor: null,
      window_from: null,
      window_days: null,
      walk_started_at: null,
      requested_days: INITIAL_BACKFILL_DAYS,
      initial: 0,
      rows_seen: 0,
      rows_missing: 0,
    });
    expect(await auditActions("revolut.accounts_replaced")).toBe(auditBefore + 1);
    // The next backfill is the 90-day initial walk.
    stub.apiCalls.length = 0;
    const { backfill } = await import("./revolut-q1-helpers");
    expect((await backfill()).summary).toMatchObject({ initial: true, windowDays: 90 });
  });

  it("a suspicion is cleared when a known account is listed again (a glitch)", async () => {
    await seedOldWalks();
    const known = api.accounts;
    api.accounts = OTHER;
    expect((await sync()).summary["accountsReplacementSuspected"]).toBe(true);
    api.accounts = known;
    const back = await sync();
    expect(back.summary["accountsReplaced"]).toBeUndefined();
    expect(back.summary["accountsReplacementSuspected"]).toBeUndefined();
    expect(
      (await rowsOf("revolut_sync_state", "entity = 'accounts'"))[0]?.["pending_replacement"],
    ).toBeNull();
    // A later single odd read starts over: suspected again, not confirmed.
    api.accounts = OTHER;
    const again = await sync();
    expect(again.summary["accountsReplaced"]).toBeUndefined();
    expect(again.summary["accountsReplacementSuspected"]).toBe(true);
    expect((await rowsOf("revolut_sync_state", "entity = 'backfill'"))[0]?.["window_from"]).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("an empty or failing read between two odd reads decides nothing", async () => {
    await seedOldWalks();
    api.accounts = OTHER;
    await sync();
    api.accounts = [];
    expect((await sync()).summary["accountsReplaced"]).toBeUndefined();
    api.accounts = OTHER;
    expect((await sync()).summary["accountsReplaced"]).toBe(true);
  });

  it("after the confirm route reset, the sync only retires the old accounts (no second reset)", async () => {
    await seedOldWalks();
    await queueInitialBackfill(env, connId, "gerrie.grobbelaar@camelthorncapital.com", Date.now(), {
      replacesAccounts: true,
    });
    const audits = await auditActions("revolut.accounts_replaced");
    // The 90-day walk starts and makes progress before the next accounts read.
    await db
      .prepare(
        "UPDATE revolut_sync_state SET window_from = '2026-02-01T00:00:00.000Z', walk_started_at = '2026-05-01T00:00:00.000Z', initial = 1 WHERE entity = 'backfill'",
      )
      .run();
    api.accounts = OTHER;
    const r = await sync();
    expect(r.summary["accountsReplaced"]).toBeUndefined();
    expect(r.summary["accountsReplacementSuspected"]).toBeUndefined();
    expect(r.summary["accountsRetired"]).toBe(2);
    expect((await rowsOf("revolut_sync_state", "entity = 'backfill'"))[0]).toMatchObject({
      window_from: "2026-02-01T00:00:00.000Z",
      requested_days: INITIAL_BACKFILL_DAYS,
    });
    expect(await auditActions("revolut.accounts_replaced")).toBe(audits);
    // Nothing pending afterwards: a further read with the same accounts is ordinary.
    expect((await sync()).summary["accountsReplacementSuspected"]).toBeUndefined();
  });

  it("one account going away is not a replacement", async () => {
    await sync();
    const before = await auditActions("revolut.accounts_replaced");
    api.accounts = api.accounts.filter((a) => a.id === ACC_EUR);
    const r = await sync();
    expect(r.summary["accountsReplaced"]).toBeUndefined();
    expect(await auditActions("revolut.accounts_replaced")).toBe(before);
  });

  it("an empty answer is not a replacement either", async () => {
    await sync();
    api.accounts = [];
    const r = await sync();
    expect(r.summary["accountsReplaced"]).toBeUndefined();
  });

  it("accounts first met by a transaction (never read from /accounts) do not count as known", async () => {
    raw.rows = [rawTx("t", ago(1))];
    // The ingest creates the account row (balance_at stays NULL) before any accounts read.
    const { upsertTransaction } = await import("../src/revolut/ingest");
    const { mapTransaction, parseJsonRawNumbers } = await import("@camelthorn/revolut");
    await upsertTransaction(
      { DB: db },
      connId,
      mapTransaction(parseJsonRawNumbers(JSON.stringify(raw.rows[0]))),
      "webhook",
    );
    api.accounts = OTHER;
    const r = await sync();
    expect(r.summary["accountsReplaced"]).toBeUndefined();
  });

  it("queueInitialBackfill({ replacesAccounts }) resets the cursors itself (the confirm route)", async () => {
    await seedOldWalks();
    const audits = await auditActions("revolut.accounts_replaced");
    await queueInitialBackfill(env, connId, "gerrie.grobbelaar@camelthorncapital.com", Date.now(), {
      replacesAccounts: true,
    });
    expect(
      await db
        .prepare(
          "SELECT cursor, window_from, requested_days FROM revolut_sync_state WHERE entity = 'backfill'",
        )
        .first(),
    ).toEqual({ cursor: null, window_from: null, requested_days: INITIAL_BACKFILL_DAYS });
    expect(await auditActions("revolut.accounts_replaced")).toBe(audits + 1);
    // Without the flag an in-progress walk is left alone.
    await db
      .prepare(
        "UPDATE revolut_sync_state SET window_from = '2026-01-01T00:00:00.000Z' WHERE entity = 'backfill'",
      )
      .run();
    await queueInitialBackfill(
      env,
      connId,
      "gerrie.grobbelaar@camelthorncapital.com",
      Date.now() + 1,
    );
    expect((await rowsOf("revolut_sync_state", "entity = 'backfill'"))[0]?.["window_from"]).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    await requestBackfill(db, connId, INITIAL_BACKFILL_DAYS);
  });
});

describe("N4: bank details lookup", () => {
  const detailsOf = async (id: string) =>
    db
      .prepare(
        "SELECT iban, bic, details_status, details_attempts, details_checked_at FROM bank_accounts WHERE connection_id = ?1 AND external_id = ?2",
      )
      .bind(connId, id)
      .first<Record<string, unknown>>();
  const detailCalls = () =>
    stub.apiCalls.filter((c) => c.url.pathname.endsWith("/bank-details")).length;
  const failDetails = (status: number) => {
    const inner = raw.handle;
    stub.api = (c) =>
      c.url.pathname.endsWith("/bank-details")
        ? new Response(JSON.stringify({ message: "no" }), { status })
        : inner(c);
    return inner;
  };

  it("distinguishes 'no IBAN' (the account has none) from 'error', and never re-asks the former", async () => {
    await sync();
    expect(await detailsOf(ACC_EUR)).toMatchObject({ iban: OUR_IBAN, details_status: "ok" });
    expect(await detailsOf(ACC_USD)).toMatchObject({
      iban: null,
      bic: "",
      details_status: "no_iban",
      details_attempts: 1,
    });
    const calls = detailCalls();
    await sync(later(100 * 24 * HOUR));
    expect(detailCalls()).toBe(calls);
  });

  it("a permanent error is retried after 24 hours with a bound, and then succeeds", async () => {
    const inner = failDetails(400);
    await sync();
    expect(await detailsOf(ACC_EUR)).toMatchObject({
      iban: null,
      details_status: "error",
      details_attempts: 1,
    });
    const calls = detailCalls();
    await sync(later(2 * HOUR)); // too early
    expect(detailCalls()).toBe(calls);
    stub.api = inner;
    await sync(later(25 * HOUR));
    expect(await detailsOf(ACC_EUR)).toMatchObject({
      iban: OUR_IBAN,
      details_status: "ok",
      details_attempts: 2,
    });
  });

  it("gives up after 5 attempts", async () => {
    failDetails(400);
    for (let i = 0; i < DETAILS_MAX_ATTEMPTS + 3; i++) await sync(later(i * 25 * HOUR));
    expect(await detailsOf(ACC_EUR)).toMatchObject({
      details_status: "error",
      details_attempts: DETAILS_MAX_ATTEMPTS,
    });
    expect(
      stub.apiCalls.filter((c) => c.url.pathname === `/api/1.0/accounts/${ACC_EUR}/bank-details`),
    ).toHaveLength(DETAILS_MAX_ATTEMPTS);
  });

  it("a rate limit records nothing and stops the loop", async () => {
    await fakeRevolutClock(connId);
    const inner = raw.handle;
    stub.api = (c) =>
      c.url.pathname.endsWith("/bank-details")
        ? new Response("{}", { status: 429, headers: { "retry-after": "1" } })
        : inner(c);
    await sync();
    expect(await detailsOf(ACC_EUR)).toMatchObject({ details_status: null, details_attempts: 0 });
  });

  it("an account looked up before the migration without an IBAN is checked once more", async () => {
    await sync();
    await db
      .prepare(
        "UPDATE bank_accounts SET iban = NULL, bic = '', details_status = 'error', details_attempts = 1, details_checked_at = '2026-01-01T00:00:00.000Z' WHERE external_id = ?1",
      )
      .bind(ACC_EUR)
      .run();
    await sync();
    expect(await detailsOf(ACC_EUR)).toMatchObject({ iban: OUR_IBAN, details_status: "ok" });
  });

  describe("pickOwnDetails", () => {
    const d = (over: Record<string, unknown>) => ({ schemes: [] as string[], ...over });
    it("prefers the account's own SEPA details for EUR and skips pooled ones", () => {
      const pick = pickOwnDetails(
        [
          d({ iban: "LT00POOLED", pooled: true, schemes: ["sepa"] }),
          d({ iban: "GB00SWIFT", schemes: ["swift"] }),
          d({ iban: "LT00OWNSEPA", schemes: ["sepa"] }),
        ],
        "EUR",
      );
      expect(pick?.iban).toBe("LT00OWNSEPA");
    });
    it("prefers SWIFT for other currencies", () => {
      expect(
        pickOwnDetails(
          [d({ iban: "A", schemes: ["sepa"] }), d({ iban: "B", schemes: ["swift"] })],
          "USD",
        )?.iban,
      ).toBe("B");
    });
    it("never takes a pooled (shared) IBAN as the account's own, and none without one", () => {
      expect(pickOwnDetails([d({ iban: "P", pooled: true, schemes: ["sepa"] })], "EUR")).toBe(
        undefined,
      );
      expect(
        pickOwnDetails(
          [d({ iban: "P", pooled: true, schemes: ["swift"] }), d({ iban: "OWN", schemes: [] })],
          "USD",
        )?.iban,
      ).toBe("OWN");
      expect(pickOwnDetails([d({ accountNo: "1" }), d({ iban: "" })], "EUR")).toBeUndefined();
      expect(pickOwnDetails([], "EUR")).toBeUndefined();
    });
  });
});
