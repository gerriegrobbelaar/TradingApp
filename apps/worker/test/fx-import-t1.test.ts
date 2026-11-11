/**
 * Phase 6 review S10 and N2 (ADR 0036 addendum): fx_import_state stays truthful (a skip never hides
 * a failure; an empty manual answer is no_data, not ok) and a first import that is too large for
 * the 5 MiB cap is retried in the same run with 120 and then 30 days. Fixed clocks only.
 */
import { addDaysIso } from "@camelthorn/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ECB_MAX_BYTES } from "../src/fx/ecb-fetch";
import { runEcbImport } from "../src/fx/ecb-import";
import {
  csvOf,
  csvResponse,
  ctxAt,
  db,
  fxRows,
  resetFx,
  stubEcb,
  type FakeEcb,
} from "./fx-helpers";

let ecb: FakeEcb;
beforeEach(async () => {
  await resetFx();
  ecb = stubEcb();
});
afterEach(() => ecb.restore());

interface StateRow {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_status: string | null;
  last_error_code: string | null;
  rows_inserted: number;
}
const state = () =>
  db.prepare("SELECT * FROM fx_import_state WHERE id = 1").first<StateRow>() as Promise<StateRow>;

const HOLIDAY_SLOT = "2026-05-01T14:15:00.000Z"; // 1 May: TARGET closed
const TUE_SLOT = "2026-11-10T15:15:00.000Z";
const CURRENCIES = { USD: 1.1, GBP: 0.86 };

describe("a skip does not hide a failure (S10)", () => {
  it("keeps a previous error status, code and attempt time", async () => {
    // A scheduled run at 17:35 that cannot find the slot's rate: error / rate_not_published.
    ecb.respond = () => csvResponse("KEY,CURRENCY,TIME_PERIOD,OBS_VALUE\n");
    const failed = await runEcbImport(
      ctxAt(TUE_SLOT, { now: Date.parse("2026-11-10T16:20:00.000Z"), attempt: 8 }),
    );
    expect(failed).toMatchObject({ status: "error", code: "rate_not_published" });
    const before = await state();
    expect(before).toMatchObject({ last_status: "error", last_error_code: "rate_not_published" });

    const skipped = await runEcbImport(
      ctxAt(HOLIDAY_SLOT, { now: Date.parse("2026-05-01T14:16:00.000Z") }),
    );
    expect(skipped).toMatchObject({ status: "skipped", code: "non_working_day" });
    expect(await state()).toEqual(before);
  });

  it("still records a skip over an ok, a partial or a clean state", async () => {
    for (const prior of ["ok", "partial", null]) {
      await db
        .prepare(
          `UPDATE fx_import_state SET last_status = ?1, last_error_code = NULL,
             last_attempt_at = '2026-04-30T15:20:00.000Z'`,
        )
        .bind(prior)
        .run();
      await runEcbImport(ctxAt(HOLIDAY_SLOT));
      expect(await state(), String(prior)).toMatchObject({
        last_status: "skipped",
        last_error_code: "non_working_day",
        last_attempt_at: "2026-05-01T14:15:00.000Z",
      });
    }
  });

  it("the next real run after the skip replaces the error as before", async () => {
    await db
      .prepare(
        "UPDATE fx_import_state SET last_status = 'error', last_error_code = 'ecb_network' WHERE id = 1",
      )
      .run();
    await runEcbImport(ctxAt(HOLIDAY_SLOT)); // protected
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-10");
    expect(await runEcbImport(ctxAt(TUE_SLOT))).toMatchObject({ status: "ok" });
    expect(await state()).toMatchObject({ last_status: "ok", last_error_code: null });
  });
});

describe("an empty manual answer is no_data, not ok (S10)", () => {
  const MANUAL = "2026-11-10T09:00:00.000Z";
  const SUCCESS = "2026-11-09T16:20:00.000Z";

  beforeEach(async () => {
    ecb.fill(CURRENCIES, "2026-10-26", "2026-11-09");
    await runEcbImport(ctxAt(TUE_SLOT, { trigger: "manual", now: Date.parse(SUCCESS) }));
    expect(await state()).toMatchObject({ last_status: "ok", last_success_at: SUCCESS });
  });

  it.each([
    ["404", () => csvResponse("No results found", 404, "text/plain")],
    ["204", () => new Response(null, { status: 204 })],
    [
      "a header-only CSV",
      () =>
        csvResponse("KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\n"),
    ],
  ])("%s: state no_data, last_success_at unchanged", async (_name, respond) => {
    ecb.respond = respond;
    const r = await runEcbImport(ctxAt(TUE_SLOT, { trigger: "manual", now: Date.parse(MANUAL) }));
    expect(r).toMatchObject({ status: "partial", code: "no_data" });
    expect(await state()).toMatchObject({
      last_status: "no_data",
      last_error_code: "no_data",
      last_attempt_at: MANUAL,
      last_success_at: SUCCESS,
      rows_inserted: 0,
    });
  });

  it("a manual run that finds rates is ok again and moves last_success_at", async () => {
    ecb.respond = null;
    ecb.fill(CURRENCIES, "2026-11-10", "2026-11-10");
    const r = await runEcbImport(ctxAt(TUE_SLOT, { trigger: "manual", now: Date.parse(MANUAL) }));
    expect(r.status).toBe("ok");
    expect(await state()).toMatchObject({ last_status: "ok", last_success_at: MANUAL });
  });

  it("a manual run whose window holds only rates we already have is ok (nothing new is not no data)", async () => {
    const r = await runEcbImport(ctxAt(TUE_SLOT, { trigger: "manual", now: Date.parse(MANUAL) }));
    expect(r).toMatchObject({ status: "ok", summary: { inserted: 0 } });
    expect(await state()).toMatchObject({ last_status: "ok", last_success_at: MANUAL });
  });
});

describe("first import falls back to a shorter window when the answer is too large (N2)", () => {
  const NOW = Date.parse(TUE_SLOT);
  const today = "2026-11-10";
  const tooLarge = () =>
    new Response("x", {
      status: 200,
      headers: { "content-type": "text/csv", "content-length": String(ECB_MAX_BYTES + 1) },
    });
  const startOf = (call: { url: URL }) => call.url.searchParams.get("startPeriod") as string;

  /** Too large unless the window starts on or after `from`. */
  const limited = (from: string) => {
    ecb.fill(CURRENCIES, "2026-01-02", today);
    ecb.respond = (call) => {
      if (startOf(call) < from) return tooLarge();
      const rows = [...ecb.data.entries()]
        .map(([k, rate]) => {
          const [currency, date] = k.split("|") as [string, string];
          return { currency, date, rate };
        })
        .filter((r) => r.date >= startOf(call));
      return csvResponse(csvOf(rows));
    };
  };

  it("400 days too large, 120 days fits: one run, two requests, the 120-day window stored", async () => {
    limited(addDaysIso(today, -120));
    const r = await runEcbImport(ctxAt(TUE_SLOT, { trigger: "manual", now: NOW }));
    expect(r).toMatchObject({ status: "ok", summary: { firstImport: true, windowDays: 120 } });
    expect(ecb.calls.map(startOf)).toEqual([addDaysIso(today, -400), addDaysIso(today, -120)]);
    const rows = await fxRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.rate_date >= addDaysIso(today, -120))).toBe(true);
  });

  it("120 days too large as well: 30 days", async () => {
    limited(addDaysIso(today, -30));
    const r = await runEcbImport(ctxAt(TUE_SLOT, { trigger: "manual", now: NOW }));
    expect(r).toMatchObject({ status: "ok", summary: { windowDays: 30 } });
    expect(ecb.calls.map(startOf)).toEqual([
      addDaysIso(today, -400),
      addDaysIso(today, -120),
      addDaysIso(today, -30),
    ]);
  });

  it("even 30 days too large: error response_too_large after three requests, nothing stored", async () => {
    ecb.respond = tooLarge;
    const r = await runEcbImport(ctxAt(TUE_SLOT, { trigger: "manual", now: NOW }));
    expect(r).toMatchObject({ status: "error", code: "response_too_large" });
    expect(ecb.calls).toHaveLength(3);
    expect(await fxRows()).toEqual([]);
    expect(await state()).toMatchObject({
      last_status: "error",
      last_error_code: "response_too_large",
    });
  });

  it("only the first import falls back: a later run reports response_too_large after one request", async () => {
    await db
      .prepare(
        "INSERT INTO fx_rates (currency, rate_date, rate) VALUES ('USD', '2026-11-09', '1.1')",
      )
      .run();
    ecb.respond = tooLarge;
    const r = await runEcbImport(ctxAt(TUE_SLOT, { trigger: "manual", now: NOW }));
    expect(r).toMatchObject({ status: "error", code: "response_too_large" });
    expect(ecb.calls).toHaveLength(1);
  });

  it("other permanent errors do not fall back", async () => {
    ecb.respond = () => csvResponse("", 400, "text/plain");
    const r = await runEcbImport(ctxAt(TUE_SLOT, { trigger: "manual", now: NOW }));
    expect(r).toMatchObject({ status: "error", code: "bad_status" });
    expect(ecb.calls).toHaveLength(1);
  });
});

describe("after a shortened first import, older history is backfilled in bounded steps (N2)", () => {
  const today = "2026-11-10";
  const startOf = (call: { url: URL }) => call.url.searchParams.get("startPeriod") as string;
  const endOf = (call: { url: URL }) => call.url.searchParams.get("endPeriod");
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const backfillState = () =>
    db
      .prepare(
        "SELECT backfill_target AS t, backfill_cursor AS c FROM fx_import_state WHERE id = 1",
      )
      .first<{ t: string | null; c: string | null }>();

  /** The answer is too large when the window spans more than 120 days, whatever its start. */
  const sizeLimited = () => {
    ecb.fill(CURRENCIES, addDaysIso(today, -420), today);
    ecb.respond = (call) => {
      const end = endOf(call) ?? today;
      if (days(startOf(call), end) > 120) {
        return new Response("x", {
          status: 200,
          headers: { "content-type": "text/csv", "content-length": String(ECB_MAX_BYTES + 1) },
        });
      }
      const rows = [...ecb.data.entries()]
        .map(([k, rate]) => {
          const [currency, date] = k.split("|") as [string, string];
          return { currency, date, rate };
        })
        .filter((r) => r.date >= startOf(call) && r.date <= end);
      return csvResponse(csvOf(rows));
    };
  };
  const manualAt = (hoursLater: number) =>
    runEcbImport(
      ctxAt(TUE_SLOT, { trigger: "manual", now: Date.parse(TUE_SLOT) + hoursLater * 3600_000 }),
    );

  it("records the target and walks back 60 days per run until the 400-day floor, then stops", async () => {
    sizeLimited();
    const first = await manualAt(0);
    expect(first).toMatchObject({ status: "ok", summary: { windowDays: 120, backfillPending: 1 } });
    expect(await backfillState()).toEqual({
      t: addDaysIso(today, -400),
      c: addDaysIso(today, -120),
    });

    const steps: string[] = [];
    for (let run = 1; run <= 8; run++) {
      ecb.calls.length = 0;
      const r = await manualAt(run);
      expect(r.status, `run ${run}`).toBe("ok");
      const extra = ecb.calls.filter((c) => endOf(c) !== null);
      // at most ONE extra request per run
      expect(extra.length, `run ${run}`).toBeLessThanOrEqual(1);
      for (const c of extra) {
        steps.push(`${startOf(c)}..${endOf(c)}`);
        expect(days(startOf(c), endOf(c) as string)).toBeLessThan(60);
      }
    }
    expect(steps).toEqual([
      `${addDaysIso(today, -180)}..${addDaysIso(today, -121)}`,
      `${addDaysIso(today, -240)}..${addDaysIso(today, -181)}`,
      `${addDaysIso(today, -300)}..${addDaysIso(today, -241)}`,
      `${addDaysIso(today, -360)}..${addDaysIso(today, -301)}`,
      `${addDaysIso(today, -400)}..${addDaysIso(today, -361)}`,
    ]);
    expect(await backfillState()).toEqual({ t: null, c: null });
    // every date the fake holds from the floor on is stored now, nothing older
    const stored = new Set((await fxRows()).map((x) => `${x.currency}|${x.rate_date}`));
    const want = [...ecb.data.keys()].filter(
      (k) => (k.split("|")[1] as string) >= addDaysIso(today, -400),
    );
    expect(want.every((k) => stored.has(k))).toBe(true);
    expect([...stored].every((k) => (k.split("|")[1] as string) >= addDaysIso(today, -400))).toBe(
      true,
    );
  });

  it("a failed step does not fail the run and is repeated by the next one", async () => {
    sizeLimited();
    await manualAt(0);
    const normal = ecb.respond;
    ecb.respond = (call) =>
      endOf(call) !== null
        ? new Response("busy", { status: 503 })
        : (normal as NonNullable<typeof normal>)(call);
    const r = await manualAt(1);
    expect(r).toMatchObject({ status: "ok" });
    expect(r.summary).toMatchObject({ backfillError: expect.any(String) });
    expect(await backfillState()).toMatchObject({ c: addDaysIso(today, -120) });
    ecb.respond = normal;
    await manualAt(2);
    expect(await backfillState()).toMatchObject({ c: addDaysIso(today, -180) });
  });

  it("a first import that fits needs no backfill", async () => {
    ecb.fill(CURRENCIES, addDaysIso(today, -30), today);
    await manualAt(0);
    expect(await backfillState()).toEqual({ t: null, c: null });
    ecb.calls.length = 0;
    await manualAt(1);
    expect(ecb.calls).toHaveLength(1);
  });
});
