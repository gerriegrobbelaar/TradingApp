/**
 * GET /api/fx/rates and /api/fx/history (task F2): authorisation, validation, shapes pinned to
 * packages/core api-types, staleness against a fixed clock.
 */
import type { FxHistoryResponse, FxRateDto, FxRatesResponse } from "@camelthorn/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FX_NOTICE } from "../src/read/fx-routes";
import { fxRows, resetFx } from "./fx-helpers";
import { addSession, addUser, authed, call, db, resetDb } from "./helpers";

const keysOf =
  <T>() =>
  <const K extends readonly (keyof T)[]>(
    k: K & ([keyof T] extends [K[number]] ? unknown : "missing keys"),
  ): string[] =>
    [...k].map(String).sort();

const RATES_KEYS = keysOf<FxRatesResponse>()([
  "base",
  "asOf",
  "rates",
  "stale",
  "staleReason",
  "workingDaysOld",
  "lastImportAt",
  "lastImportStatus",
  "notice",
]);
const RATE_KEYS = keysOf<FxRateDto>()(["currency", "rate", "rateDate", "source"]);

// Wednesday 11 November 2026, 12:00 Amsterdam (CET).
const NOW = Date.parse("2026-11-11T11:00:00Z");
let tokens: Record<string, string> = {};

const put = (currency: string, date: string, rate: string) =>
  db
    .prepare("INSERT INTO fx_rates (currency, rate_date, rate) VALUES (?1, ?2, ?3)")
    .bind(currency, date, rate)
    .run();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
  await resetFx();
  tokens = {};
  for (const role of ["admin", "finance", "approver", "viewer"] as const) {
    tokens[role] = await addSession(await addUser(`${role}@camelthorncapital.com`, [role]));
  }
});
afterEach(() => vi.useRealTimers());

const get = async <T>(path: string, role = "viewer") => {
  const res = await authed(path, tokens[role] as string);
  return { status: res.status, res, body: (await res.json()) as T };
};

describe("access", () => {
  it("needs a session; any role may read; responses are no-store", async () => {
    expect((await call("/api/fx/rates")).status).toBe(401);
    expect((await call("/api/fx/history?currency=USD")).status).toBe(401);
    await put("USD", "2026-11-10", "1.1");
    for (const role of ["admin", "finance", "approver", "viewer"]) {
      expect((await get("/api/fx/rates", role)).status, role).toBe(200);
      expect((await get("/api/fx/history?currency=USD", role)).status, role).toBe(200);
    }
    const { res } = await get("/api/fx/rates");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("is read-only", async () => {
    const res = await authed("/api/fx/rates", tokens["admin"] as string, {
      method: "POST",
      json: {},
    });
    expect([404, 405]).toContain(res.status);
  });
});

describe("GET /api/fx/rates", () => {
  it("an empty table is 200 with stale never_imported", async () => {
    const { status, body } = await get<FxRatesResponse>("/api/fx/rates");
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(RATES_KEYS);
    expect(body).toMatchObject({
      base: "EUR",
      asOf: null,
      rates: [],
      stale: true,
      staleReason: "never_imported",
      workingDaysOld: null,
      lastImportAt: null,
      lastImportStatus: null,
      notice: FX_NOTICE,
    });
    expect(body.notice).toMatch(/^ECB reference rates are for information only\./);
  });

  it("returns the newest rate per currency with its own date, sorted, as decimal strings", async () => {
    await put("USD", "2026-11-09", "1.1000");
    await put("USD", "2026-11-10", "1.1650");
    await put("GBP", "2026-11-10", "0.8700");
    await put("HRK", "2022-12-30", "7.5300"); // discontinued: dropped, as core buildRateTable does
    await put("CHF", "2026-10-27", "0.9400"); // 10 TARGET days before asOf: still current
    await put("SEK", "2026-10-26", "11.2000"); // 11 TARGET days before asOf: dropped
    await db
      .prepare(
        `UPDATE fx_import_state SET last_attempt_at = '2026-11-10T15:20:00.000Z', last_status = 'ok' WHERE id = 1`,
      )
      .run();
    const { body } = await get<FxRatesResponse>("/api/fx/rates");
    expect(Object.keys(body).sort()).toEqual(RATES_KEYS);
    expect(body.rates.map((r) => r.currency)).toEqual(["CHF", "GBP", "USD"]);
    for (const r of body.rates) {
      expect(Object.keys(r).sort()).toEqual(RATE_KEYS);
      expect(r.source).toBe("ECB");
      expect(typeof r.rate).toBe("string");
    }
    expect(body.rates.find((r) => r.currency === "USD")).toEqual({
      currency: "USD",
      rate: "1.165", // canonical form (core parseRate), whatever was stored
      rateDate: "2026-11-10",
      source: "ECB",
    });
    expect(body.rates.find((r) => r.currency === "CHF")).toMatchObject({
      rate: "0.94",
      rateDate: "2026-10-27",
    });
    expect(body).toMatchObject({
      asOf: "2026-11-10",
      stale: false, // Wednesday noon expects Tuesday's rate
      staleReason: null,
      workingDaysOld: 1,
      lastImportAt: "2026-11-10T15:20:00.000Z",
      lastImportStatus: "ok",
    });
  });

  it("date= picks the newest rate on or before that day", async () => {
    await put("USD", "2026-11-06", "1.0600");
    await put("USD", "2026-11-09", "1.0900");
    const sat = (await get<FxRatesResponse>("/api/fx/rates?date=2026-11-08")).body;
    expect(sat.rates).toEqual([
      { currency: "USD", rate: "1.06", rateDate: "2026-11-06", source: "ECB" },
    ]);
    expect(sat.asOf).toBe("2026-11-06");
    // Freshness describes the feed (newest stored: Monday 9th) against now (Wednesday noon
    // expects Tuesday's), not the past date asked for: stale, 2 working days old.
    expect(sat).toMatchObject({
      stale: true,
      staleReason: "older_than_one_working_day",
      workingDaysOld: 2,
    });
    // Before the first stored date: no rates; the freshness is still the feed's.
    const early = (await get<FxRatesResponse>("/api/fx/rates?date=2026-01-01")).body;
    expect(early).toMatchObject({ asOf: null, rates: [], stale: true, workingDaysOld: 2 });
    // With Tuesday's rate stored the same past date reads fresh.
    await put("USD", "2026-11-10", "1.1");
    const fresh = (await get<FxRatesResponse>("/api/fx/rates?date=2026-11-08")).body;
    expect(fresh).toMatchObject({ asOf: "2026-11-06", stale: false, workingDaysOld: 1 });
    // Today is allowed.
    expect((await get("/api/fx/rates?date=2026-11-11")).status).toBe(200);
  });

  it("validates date", async () => {
    for (const bad of ["x", "2026-13-01", "2026-02-30", "20261110", "2026-11-10T00:00", ""]) {
      const r = await get<{ error: string }>(`/api/fx/rates?date=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBe(400);
      expect(r.body.error).toBe("bad_date");
    }
    const future = await get<{ error: string }>("/api/fx/rates?date=2026-11-12");
    expect(future).toMatchObject({ status: 400, body: { error: "date_in_future" } });
  });

  it("staleness follows the clock: Tuesday 18:00 with Monday as the newest is stale", async () => {
    await put("USD", "2026-11-09", "1.1");
    vi.setSystemTime(Date.parse("2026-11-10T17:00:00Z")); // 18:00 CET
    const s = await addSession(await addUser("late@camelthorncapital.com", ["viewer"]));
    const r = await authed("/api/fx/rates", s);
    expect(await r.json()).toMatchObject({
      stale: true,
      staleReason: "older_than_one_working_day",
      workingDaysOld: 1,
    });
    vi.setSystemTime(Date.parse("2026-11-10T14:00:00Z")); // 15:00 CET, before publication
    expect(await (await authed("/api/fx/rates", s)).json()).toMatchObject({ stale: false });
  });

  it("Monday morning with Friday's rate is not stale", async () => {
    await put("USD", "2026-11-06", "1.1");
    vi.setSystemTime(Date.parse("2026-11-09T08:00:00Z")); // 09:00 CET
    const s = await addSession(await addUser("mon@camelthorncapital.com", ["viewer"]));
    expect(await (await authed("/api/fx/rates", s)).json()).toMatchObject({
      stale: false,
      workingDaysOld: 1,
    });
  });
});

describe("GET /api/fx/history", () => {
  beforeEach(async () => {
    await put("USD", "2025-09-01", "1.0000"); // more than 400 days before NOW
    await put("USD", "2026-08-12", "1.1000"); // 91 days back
    await put("USD", "2026-10-12", "1.1200");
    await put("USD", "2026-11-10", "1.1650");
    await put("GBP", "2026-11-10", "0.8700");
  });

  it("returns one currency oldest first (default 90 days) in the documented shape", async () => {
    const { status, body } = await get<FxHistoryResponse>("/api/fx/history?currency=USD");
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      keysOf<FxHistoryResponse>()(["currency", "base", "points"]),
    );
    expect(body.currency).toBe("USD");
    expect(body.base).toBe("EUR");
    expect(body.points).toEqual([
      { rateDate: "2026-10-12", rate: "1.12" },
      { rateDate: "2026-11-10", rate: "1.165" },
    ]);
  });

  it("days selects the window, up to 400; the currency is case-insensitive", async () => {
    const week = await get<FxHistoryResponse>("/api/fx/history?currency=usd&days=7");
    expect(week.body.currency).toBe("USD");
    expect(week.body.points.map((p) => p.rateDate)).toEqual(["2026-11-10"]);
    const long = await get<FxHistoryResponse>("/api/fx/history?currency=USD&days=100");
    expect(long.body.points).toHaveLength(3);
    const max = await get<FxHistoryResponse>("/api/fx/history?currency=USD&days=400");
    expect(max.body.points).toHaveLength(3); // 2025-09-01 is 436 days back
  });

  it("validates currency and days; unknown currencies are 404", async () => {
    for (const q of [
      "",
      "?currency=",
      "?currency=US",
      "?currency=USDD",
      "?currency=U5D",
      "?days=5",
    ]) {
      const r = await get<{ error: string }>(`/api/fx/history${q}`);
      expect(r, q).toMatchObject({ status: 400, body: { error: "bad_currency" } });
    }
    for (const days of ["0", "-1", "401", "abc", "1.5", "1e2", "", "99999"]) {
      const r = await get<{ error: string }>(`/api/fx/history?currency=USD&days=${days}`);
      expect(r, days).toMatchObject({ status: 400, body: { error: "bad_days" } });
    }
    for (const c of ["JPY", "EUR"]) {
      const r = await get<{ error: string }>(`/api/fx/history?currency=${c}`);
      expect(r, c).toMatchObject({ status: 404, body: { error: "unknown_currency" } });
    }
    expect(await fxRows()).toHaveLength(5);
  });
});
