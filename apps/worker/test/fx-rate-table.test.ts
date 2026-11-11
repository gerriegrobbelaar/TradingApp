/**
 * Server-side rate tables (Phase 6 review S8, ADR 0039): the loader the rates API now uses, the
 * strict loader for month-end booking (Phase 12) and the "currencies without a rate" helper
 * (Phase 8). Fixed dates only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  currenciesWithoutRate,
  loadRateTable,
  loadRateTableExactly,
  loadRateTableWithNewest,
} from "../src/fx/rate-table";
import { db, resetFx } from "./fx-helpers";

const put = (currency: string, date: string, rate: string) =>
  db
    .prepare("INSERT INTO fx_rates (currency, rate_date, rate) VALUES (?1, ?2, ?3)")
    .bind(currency, date, rate)
    .run();

const conflict = (currency: string, date: string, resolved = false) =>
  db
    .prepare(
      `INSERT INTO fx_rate_conflicts (currency, rate_date, stored_rate, ecb_rate, resolved_at,
         resolved_by, resolution)
       VALUES (?1, ?2, '1.1', '1.2', ?3, ?4, ?5)`,
    )
    .bind(
      currency,
      date,
      resolved ? "2026-11-11T10:00:00.000Z" : null,
      resolved ? "admin@camelthorncapital.com" : null,
      resolved ? "kept" : null,
    )
    .run();

beforeEach(async () => {
  await resetFx();
  await db.prepare("DELETE FROM fx_rate_conflicts").run();
});

describe("loadRateTable", () => {
  it("returns null with no rates and for a bad date", async () => {
    expect(await loadRateTable(db, "2026-11-10")).toBeNull();
    await put("USD", "2026-11-10", "1.1");
    expect(await loadRateTable(db, "2026-13-40")).toBeNull();
    expect(await loadRateTable(db, "x")).toBeNull();
    expect(await loadRateTable(db, "2026-11-09")).toBeNull(); // nothing on or before
  });

  it("the newest rate on or before the date, with each currency's own date", async () => {
    await put("USD", "2026-11-06", "1.0600");
    await put("USD", "2026-11-09", "1.0900");
    await put("GBP", "2026-11-06", "0.8600");
    const t = await loadRateTable(db, "2026-11-10");
    expect(t).toEqual({
      asOf: "2026-11-09",
      base: "EUR",
      rates: { GBP: "0.86", USD: "1.09" },
      ratesDate: { GBP: "2026-11-06", USD: "2026-11-09" },
    });
    const w = await loadRateTableWithNewest(db, "2026-11-08");
    expect(w.newestDate).toBe("2026-11-06");
    expect(w.table?.asOf).toBe("2026-11-06");
  });

  it("Friday's rate serves the weekend and Monday", async () => {
    await put("USD", "2026-11-06", "1.1"); // Friday
    for (const d of ["2026-11-07", "2026-11-08", "2026-11-09"]) {
      expect((await loadRateTable(db, d))?.rates, d).toEqual({ USD: "1.1" });
      expect((await loadRateTable(db, d))?.asOf, d).toBe("2026-11-06");
    }
  });

  it("holidays reuse the last rate: Good Friday and Easter Monday 2026", async () => {
    await put("USD", "2026-04-02", "1.08"); // Maundy Thursday
    await put("USD", "2026-04-07", "1.09"); // Tuesday
    expect((await loadRateTable(db, "2026-04-03"))?.asOf).toBe("2026-04-02");
    expect((await loadRateTable(db, "2026-04-06"))?.asOf).toBe("2026-04-02");
    expect((await loadRateTable(db, "2026-04-07"))?.rates["USD"]).toBe("1.09");
  });

  it("leaves out a currency the ECB stopped publishing, at exactly more than 10 TARGET days", async () => {
    await put("USD", "2026-11-10", "1.1");
    await put("RUB", "2026-10-26", "90"); // 11 TARGET days older: out
    await put("HRK", "2026-10-27", "7.5"); // 10 TARGET days older: still in
    const t = await loadRateTable(db, "2026-11-10");
    expect(Object.keys(t?.rates ?? {})).toEqual(["HRK", "USD"]);
    // maxAgeTargetDays is honoured
    const tight = await loadRateTable(db, "2026-11-10", { maxAgeTargetDays: 5 });
    expect(Object.keys(tight?.rates ?? {})).toEqual(["USD"]);
    const loose = await loadRateTable(db, "2026-11-10", { maxAgeTargetDays: 11 });
    expect(Object.keys(loose?.rates ?? {})).toEqual(["HRK", "RUB", "USD"]);
  });

  it("returns canonical rates and ignores rows core refuses", async () => {
    await put("USD", "2026-11-10", "1.1000");
    await put("JPY", "2026-11-10", "170.250");
    expect((await loadRateTable(db, "2026-11-10"))?.rates).toEqual({ JPY: "170.25", USD: "1.1" });
  });
});

describe("loadRateTableExactly (strict, for booking)", () => {
  beforeEach(async () => {
    await put("USD", "2026-10-30", "1.1650");
    await put("GBP", "2026-10-30", "0.8700");
    await put("USD", "2026-11-02", "1.1700");
  });

  it("returns only rates dated exactly that day", async () => {
    const r = await loadRateTableExactly(db, "2026-10-30", ["USD", "GBP"]);
    expect(r).toEqual({
      ok: true,
      table: {
        asOf: "2026-10-30",
        base: "EUR",
        rates: { GBP: "0.87", USD: "1.165" },
        ratesDate: { GBP: "2026-10-30", USD: "2026-10-30" },
      },
    });
  });

  it("refuses a date with no rates, even when an older one exists (rate_date_mismatch)", async () => {
    // Saturday: loadRateTable would serve Friday's rate, the strict loader must not.
    expect(await loadRateTableExactly(db, "2026-10-31", ["USD"])).toEqual({
      ok: false,
      error: "rate_date_mismatch",
      newestDate: "2026-10-30",
    });
    expect(await loadRateTableExactly(db, "2026-10-01")).toEqual({
      ok: false,
      error: "rate_date_mismatch",
      newestDate: null,
    });
  });

  it("refuses when a required currency has no rate on that day (missing_rate, sorted)", async () => {
    expect(await loadRateTableExactly(db, "2026-11-02", ["USD", "GBP"])).toEqual({
      ok: false,
      error: "missing_rate",
      missing: ["GBP"],
    });
    expect(await loadRateTableExactly(db, "2026-11-02", ["JPY", "CHF", "USD", "JPY"])).toEqual({
      ok: false,
      error: "missing_rate",
      missing: ["CHF", "JPY"],
    });
  });

  it("EUR and no required currencies are fine; extra currencies on the day are kept", async () => {
    const r = await loadRateTableExactly(db, "2026-10-30", ["EUR", "USD"]);
    expect(r.ok).toBe(true);
    const none = await loadRateTableExactly(db, "2026-10-30");
    expect(none.ok && Object.keys(none.table.rates)).toEqual(["GBP", "USD"]);
  });

  it("a bad date is bad_date", async () => {
    expect(await loadRateTableExactly(db, "2026-02-30")).toEqual({ ok: false, error: "bad_date" });
    expect(await loadRateTableExactly(db, "")).toEqual({ ok: false, error: "bad_date" });
  });

  it("refuses a date with an unresolved conflict, whatever the currency; a resolved one is fine", async () => {
    await conflict("GBP", "2026-10-30");
    expect(await loadRateTableExactly(db, "2026-10-30", ["USD"])).toEqual({
      ok: false,
      error: "unresolved_conflict",
      currencies: ["GBP"],
    });
    // another date is not affected
    expect((await loadRateTableExactly(db, "2026-11-02", ["USD"])).ok).toBe(true);
    await db.prepare("DELETE FROM fx_rate_conflicts").run();
    await conflict("GBP", "2026-10-30", true);
    expect((await loadRateTableExactly(db, "2026-10-30", ["USD"])).ok).toBe(true);
  });
});

describe("currenciesWithoutRate", () => {
  it("lists the currencies a conversion on that date could not price", async () => {
    await put("USD", "2026-11-10", "1.1");
    await put("RUB", "2026-01-02", "90");
    expect(
      await currenciesWithoutRate(db, ["USD", "EUR", "RUB", "CHF", "CHF", "AUD"], "2026-11-10"),
    ).toEqual(["AUD", "CHF", "RUB"]);
    expect(await currenciesWithoutRate(db, ["USD", "EUR"], "2026-11-10")).toEqual([]);
    expect(await currenciesWithoutRate(db, [], "2026-11-10")).toEqual([]);
    // before any rate exists everything foreign is missing, EUR never is
    expect(await currenciesWithoutRate(db, ["USD", "EUR"], "2026-11-09")).toEqual(["USD"]);
  });
});
