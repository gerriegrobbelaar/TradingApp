import type { FxHistoryResponse, FxRatesResponse } from "@camelthorn/core";
import type { JobsResponse, JobView } from "./api";
import { ONE_DIVISION } from "./test-fixtures";
import type { DivisionsResponse } from "./api";

export const NOTICE =
  "ECB reference rates are for information only. Confirm them with your accountant before booking.";

const RATE = (currency: string, rate: string, rateDate = "2026-11-10") => ({
  currency,
  rate,
  rateDate,
  source: "ECB" as const,
});

/** Fresh rates of 10 Nov 2026: USD 1.0853, GBP 0.872 (a week older), JPY 165.5, KWD 0.3333. */
export function fxRates(over: Partial<FxRatesResponse> = {}): FxRatesResponse {
  return {
    base: "EUR",
    asOf: "2026-11-10",
    rates: [
      RATE("GBP", "0.872", "2026-11-06"),
      RATE("JPY", "165.5"),
      RATE("KWD", "0.3333"),
      RATE("USD", "1.0853"),
    ],
    stale: false,
    staleReason: null,
    workingDaysOld: 0,
    lastImportAt: "2026-11-10T15:16:00.000Z",
    lastImportStatus: "ok",
    notice: NOTICE,
    ...over,
  };
}

/** Rates without GBP (the currency is simply missing). */
export function fxRatesNoGbp(over: Partial<FxRatesResponse> = {}): FxRatesResponse {
  const base = fxRates(over);
  return { ...base, rates: base.rates.filter((r) => r.currency !== "GBP") };
}

export function fxStale(): FxRatesResponse {
  return fxRates({
    asOf: "2026-11-06",
    rates: fxRates().rates.map((r) => ({ ...r, rateDate: "2026-11-06" })),
    stale: true,
    staleReason: "older_than_one_working_day",
    workingDaysOld: 1,
  });
}

export function fxNever(): FxRatesResponse {
  return fxRates({
    asOf: null,
    rates: [],
    stale: true,
    staleReason: "never_imported",
    workingDaysOld: null,
    lastImportAt: null,
    lastImportStatus: null,
  });
}

export function fxHistory(currency = "USD", n = 5): FxHistoryResponse {
  const base = ["1.0712", "1.0790", "1.0953", "1.0820", "1.0853"];
  return {
    currency,
    base: "EUR",
    points: Array.from({ length: n }, (_, i) => ({
      rateDate: `2026-11-0${i + 2}`,
      rate: base[i % base.length] as string,
    })),
  };
}

export const GBP_DIVISION: DivisionsResponse = {
  selectedId: 1,
  divisions: [
    { ...(ONE_DIVISION.divisions[0] as DivisionsResponse["divisions"][number]), currency: "GBP" },
  ],
};

export function importJob(over: Partial<JobView> = {}): JobView {
  return {
    id: 9,
    name: "ecb.fx_import",
    title: "ECB exchange rates",
    description: "Imports the daily ECB reference rates.",
    implemented: true,
    phase: null,
    usesExact: false,
    schedule: { kind: "cron", expr: "15 16 * * *", workingDaysOnly: true },
    scheduleText: "Working days at 16:15",
    enabled: true,
    exactBudget: 0,
    runRoles: ["admin", "finance"],
    stepUpToRun: false,
    maxLatenessMinutes: 75,
    scheduleRules: { minIntervalMinutes: 60, allowedIntervalMinutes: null, workingDaysOnly: true },
    defaultEnabled: true,
    rev: "r1",
    nextRunAt: null,
    running: false,
    lastRun: null,
    ...over,
  } as JobView;
}

export function jobsResponse(jobs: JobView[] = [importJob()]): JobsResponse {
  return {
    scheduler: {
      queueConfigured: true,
      lastTickAt: new Date().toISOString(),
      now: new Date().toISOString(),
    },
    maxExactBudget: 1000,
    maxProjectedExactCallsPerDay: 3000,
    jobs,
  };
}
