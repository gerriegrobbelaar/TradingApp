/**
 * Review of task F2: the rates API at scale (index use, size), its agreement with core
 * buildRateTable, staleness that stays truthful when the job is off or failing, the staleness
 * rule around midnight, Christmas, New Year, 1 May and both DST switches, and the enabled-by-default
 * seeding (new installs only).
 */
import {
  buildRateTable,
  isTargetWorkingDay,
  previousTargetWorkingDay,
  amsterdamParts,
  type FxRatesResponse,
  type FxHistoryResponse,
  type EcbObservation,
} from "@camelthorn/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectedNewestRateDate, fxStaleness } from "../src/fx/staleness";
import { seedDefaultJobs } from "../src/jobs/defaults";
import { SQL_HISTORY, SQL_NEWEST_ON_OR_BEFORE, SQL_RATES_BETWEEN } from "../src/read/fx-routes";
import { resetFx } from "./fx-helpers";
import { addSession, addUser, authed, db, resetDb } from "./helpers";

const NOW = Date.parse("2026-11-11T11:00:00Z"); // Wednesday 12:00 Amsterdam

/** 30 currencies x every TARGET working day of the last 400 days (about 8,400 rows). */
async function bigTable(): Promise<EcbObservation[]> {
  const codes = Array.from(
    { length: 30 },
    (_, i) =>
      `C${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`,
  );
  const obs: EcbObservation[] = [];
  for (
    let d = Date.parse("2025-10-07T00:00:00Z");
    d <= Date.parse("2026-11-10T00:00:00Z");
    d += 86_400_000
  ) {
    const day = new Date(d).toISOString().slice(0, 10);
    if (!isTargetWorkingDay(day)) continue;
    for (const [i, c] of codes.entries())
      obs.push({ currency: c, rateDate: day, rate: `${i + 1}.${(d / 86_400_000) % 9999}` });
  }
  for (let i = 0; i < obs.length; i += 500) {
    await db
      .prepare(
        `INSERT INTO fx_rates (currency, rate_date, rate)
         SELECT json_extract(value, '$.currency'), json_extract(value, '$.rateDate'), json_extract(value, '$.rate')
         FROM json_each(?1)`,
      )
      .bind(JSON.stringify(obs.slice(i, i + 500)))
      .run();
  }
  return obs;
}

let token = "";
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
  await resetFx();
  token = await addSession(await addUser("viewer@camelthorncapital.com", ["viewer"]));
});
afterEach(() => vi.useRealTimers());

const getJson = async <T>(path: string) => {
  const res = await authed(path, token);
  return { status: res.status, text: await res.clone().text(), body: (await res.json()) as T };
};

describe("rates API at scale", () => {
  it("uses the indexes for every query (no full scan of fx_rates)", async () => {
    await bigTable();
    await db
      .prepare("ANALYZE")
      .run()
      .catch(() => undefined);
    for (const [sql, binds] of [
      [SQL_NEWEST_ON_OR_BEFORE, ["2026-11-10"]],
      [SQL_RATES_BETWEEN, ["2026-10-27", "2026-11-10"]],
      [SQL_HISTORY, ["CAA", "2025-10-07"]],
    ] as const) {
      const plan = (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...binds)
          .all<{ detail: string }>()
      ).results.map((r) => r.detail);
      const text = plan.join(" | ");
      expect(text, sql).toMatch(/USING (COVERING )?INDEX|USING PRIMARY KEY/);
      expect(text, sql).not.toMatch(/SCAN fx_rates(?! USING)/);
    }
  });

  it("30 currencies x 400 days: rates has 30 entries, history one currency's ~280 points, both small", async () => {
    const obs = await bigTable();
    const rates = await getJson<FxRatesResponse>("/api/fx/rates");
    expect(rates.status).toBe(200);
    expect(rates.body.rates).toHaveLength(30);
    expect(rates.text.length).toBeLessThan(8_000);
    const hist = await getJson<FxHistoryResponse>("/api/fx/history?currency=CAA&days=400");
    const expected = obs.filter((o) => o.currency === "CAA" && o.rateDate >= "2025-10-07").length;
    expect(hist.body.points).toHaveLength(expected);
    expect(hist.text.length).toBeLessThan(20_000);
  });

  it("for any date the API returns exactly what core buildRateTable returns", async () => {
    const put = (c: string, d: string, r: string) =>
      db
        .prepare("INSERT INTO fx_rates (currency, rate_date, rate) VALUES (?1, ?2, ?3)")
        .bind(c, d, r)
        .run();
    const obs: EcbObservation[] = [];
    // USD every working day; HRK stops 2026-10-15; RUB only one old rate; CHF stops 2026-10-28.
    for (
      let d = Date.parse("2026-09-01T00:00:00Z");
      d <= Date.parse("2026-11-10T00:00:00Z");
      d += 86_400_000
    ) {
      const day = new Date(d).toISOString().slice(0, 10);
      if (!isTargetWorkingDay(day)) continue;
      obs.push({ currency: "USD", rateDate: day, rate: "1.1" });
      if (day <= "2026-10-15") obs.push({ currency: "HRK", rateDate: day, rate: "7.53" });
      if (day <= "2026-10-28") obs.push({ currency: "CHF", rateDate: day, rate: "0.940" });
    }
    obs.push({ currency: "RUB", rateDate: "2026-03-01", rate: "100" });
    for (const o of obs) await put(o.currency, o.rateDate, o.rate);
    for (const date of [
      "2026-09-01",
      "2026-10-15",
      "2026-10-29",
      "2026-10-31",
      "2026-11-08",
      "2026-11-11",
    ]) {
      const { body } = await getJson<FxRatesResponse>(`/api/fx/rates?date=${date}`);
      const core = buildRateTable(obs, date);
      expect(body.asOf, date).toBe(core?.asOf ?? null);
      expect(
        Object.fromEntries(body.rates.map((r) => [r.currency, [r.rate, r.rateDate]])),
        date,
      ).toEqual(
        Object.fromEntries(
          Object.entries(core?.rates ?? {}).map(([c, r]) => [c, [r, core?.ratesDate?.[c]]]),
        ),
      );
    }
  });
});

describe("staleness stays truthful whatever the job does", () => {
  it("a disabled or failing job does not hide old rates", async () => {
    await db
      .prepare(
        "INSERT INTO fx_rates (currency, rate_date, rate) VALUES ('USD', '2026-11-06', '1.1')",
      )
      .run();
    await db
      .prepare(
        `UPDATE fx_import_state SET last_attempt_at = '2026-11-11T10:55:00.000Z', last_status = 'ok',
           newest_rate_date = '2026-11-10' WHERE id = 1`,
      )
      .run();
    // The state row claims ok and a newer date; the API trusts the rates table, not the claim.
    const { body } = await getJson<FxRatesResponse>("/api/fx/rates");
    expect(body).toMatchObject({
      asOf: "2026-11-06",
      stale: true,
      staleReason: "older_than_one_working_day",
      workingDaysOld: 3,
      lastImportStatus: "ok",
    });
  });
});

describe("staleness around midnight, holidays and DST", () => {
  it("uses the Amsterdam date, not the UTC date, near midnight", () => {
    // 23:30 UTC on Tuesday 10 Nov is 00:30 Wednesday in Amsterdam: Tuesday's rate is expected.
    const t = Date.parse("2026-11-10T23:30:00Z");
    expect(amsterdamParts(t).date).toBe("2026-11-11");
    expect(expectedNewestRateDate(t)).toBe("2026-11-10");
    expect(fxStaleness("2026-11-09", t).stale).toBe(true);
    expect(fxStaleness("2026-11-10", t)).toMatchObject({ stale: false, workingDaysOld: 1 });
    // 22:30 UTC on Tuesday is 23:30 Tuesday: still Tuesday's (after 17:30).
    expect(expectedNewestRateDate(Date.parse("2026-11-10T22:30:00Z"))).toBe("2026-11-10");
    // In summer 22:30 UTC is already 00:30 the next day.
    const s = Date.parse("2026-06-09T22:30:00Z");
    expect(amsterdamParts(s).date).toBe("2026-06-10");
    expect(expectedNewestRateDate(s)).toBe("2026-06-09");
  });

  it("Christmas, New Year and 1 May", () => {
    const at = (iso: string) => Date.parse(iso);
    // Christmas 2025: 24 Dec (Wed) is a working day; 25 and 26 are holidays.
    expect(expectedNewestRateDate(at("2025-12-25T12:00:00Z"))).toBe("2025-12-24");
    expect(expectedNewestRateDate(at("2025-12-29T10:00:00Z"))).toBe("2025-12-24");
    expect(expectedNewestRateDate(at("2025-12-29T17:00:00Z"))).toBe("2025-12-29");
    // New Year 2026: 31 Dec is a working day, 1 Jan a holiday, 2 Jan (Friday) a working day.
    expect(expectedNewestRateDate(at("2026-01-01T20:00:00Z"))).toBe("2025-12-31");
    expect(expectedNewestRateDate(at("2026-01-02T09:00:00Z"))).toBe("2025-12-31");
    expect(fxStaleness("2025-12-31", at("2026-01-02T17:00:00Z")).stale).toBe(true);
    // 1 May 2026 is a Friday: Thursday's rate is fine through the weekend and Monday morning.
    for (const t of ["2026-05-01T18:00:00Z", "2026-05-03T12:00:00Z", "2026-05-04T07:00:00Z"]) {
      expect(fxStaleness("2026-04-30", at(t)).stale, t).toBe(false);
    }
    expect(fxStaleness("2026-04-30", at("2026-05-04T16:00:00Z")).stale).toBe(true); // 18:00 CEST
  });

  it("matches the written rule for every quarter hour over Christmas, 1 May and both DST switches", () => {
    const ranges: [string, string][] = [
      ["2025-12-22", "2026-01-06"],
      ["2026-03-27", "2026-03-31"],
      ["2026-04-29", "2026-05-05"],
      ["2026-10-23", "2026-10-27"],
    ];
    for (const [from, to] of ranges) {
      for (
        let t = Date.parse(`${from}T00:00:00Z`);
        t <= Date.parse(`${to}T23:45:00Z`);
        t += 15 * 60_000
      ) {
        const p = amsterdamParts(t);
        const after = p.hour * 60 + p.minute > 17 * 60 + 30;
        const expected =
          isTargetWorkingDay(p.date) && after ? p.date : previousTargetWorkingDay(p.date);
        expect(expectedNewestRateDate(t), new Date(t).toISOString()).toBe(expected);
        expect(fxStaleness(previousTargetWorkingDay(expected), t).stale).toBe(true);
        expect(fxStaleness(expected, t).stale).toBe(false);
      }
    }
  });
});

describe("enabled by default: new installs only", () => {
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM job_runs"),
      db.prepare("DELETE FROM jobs"),
      db.prepare("DELETE FROM settings WHERE key = 'seed.default_jobs'"),
    ]);
  });

  it("an existing install whose ecb.fx_import row is disabled keeps it disabled on every seed", async () => {
    await db
      .prepare(
        `INSERT INTO jobs (name, handler, kind, schedule_json, enabled, exact_budget)
         VALUES ('ecb.fx_import', 'ecb.fx_import', 'system',
                 '{"kind":"cron","expr":"15 16 * * *","workingDaysOnly":true}', 0, 0)`,
      )
      .run();
    // An older marker: the seed applies the current version and inserts only missing jobs.
    await db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_by)
         VALUES ('seed.default_jobs', json_object('version', 1), 'system')`,
      )
      .run();
    expect(await seedDefaultJobs(db)).toBe("applied");
    expect(await seedDefaultJobs(db)).toBe("current");
    const row = await db
      .prepare("SELECT enabled, next_run_at FROM jobs WHERE name = 'ecb.fx_import'")
      .first<{ enabled: number; next_run_at: string | null }>();
    expect(row).toEqual({ enabled: 0, next_run_at: null });
  });

  it("a new install gets it enabled with a next run on a TARGET working day at 16:15", async () => {
    await seedDefaultJobs(db, NOW);
    const row = await db
      .prepare("SELECT enabled, next_run_at FROM jobs WHERE name = 'ecb.fx_import'")
      .first<{ enabled: number; next_run_at: string }>();
    expect(row?.enabled).toBe(1);
    const p = amsterdamParts(Date.parse(row?.next_run_at as string));
    expect([p.date, p.hour, p.minute]).toEqual(["2026-11-11", 16, 15]);
  });
});
