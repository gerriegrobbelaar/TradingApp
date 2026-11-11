import { describe, expect, it, vi } from "vitest";
import { ApiError, getFxRates } from "../api";
import { fxNever, fxOutage, fxRates, fxStale } from "../test-fixtures-fx";
import { parseFxRatesResponse } from "./fx-response";

const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(fxRates()));

describe("parseFxRatesResponse (S2)", () => {
  it("accepts every realistic answer", () => {
    for (const r of [fxRates(), fxStale(), fxNever(), fxOutage()]) {
      expect(parseFxRatesResponse(JSON.parse(JSON.stringify(r)))).toEqual(r);
    }
    // an older Worker without lastImportCode
    const old = clone();
    delete old["lastImportCode"];
    expect(parseFxRatesResponse(old)).not.toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "<html>502</html>"],
    ["an array", []],
    ["an empty object", {}],
  ])("rejects %s", (_n, v) => {
    expect(parseFxRatesResponse(v)).toBeNull();
  });

  const mutate = (name: string, fn: (o: Record<string, unknown>) => void) =>
    it(`rejects: ${name}`, () => {
      const o = clone();
      fn(o);
      expect(parseFxRatesResponse(o)).toBeNull();
    });
  const rate0 = (o: Record<string, unknown>) =>
    (o["rates"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  mutate("rates is not an array", (o) => (o["rates"] = { USD: "1.08" }));
  mutate("rates missing", (o) => delete o["rates"]);
  mutate("a rate entry that is not an object", (o) => (o["rates"] = [null]));
  mutate("a lower-case currency", (o) => (rate0(o)["currency"] = "usd"));
  mutate("a four-letter currency", (o) => (rate0(o)["currency"] = "USDX"));
  mutate("a numeric currency", (o) => (rate0(o)["currency"] = 840));
  mutate("EUR in the table", (o) => (rate0(o)["currency"] = "EUR"));
  mutate("a number as rate", (o) => (rate0(o)["rate"] = 1.08));
  mutate("a comma-decimal rate", (o) => (rate0(o)["rate"] = "1,08"));
  mutate("a zero rate", (o) => (rate0(o)["rate"] = "0"));
  mutate("a negative rate", (o) => (rate0(o)["rate"] = "-1.2"));
  mutate("a rate in exponent form", (o) => (rate0(o)["rate"] = "1e3"));
  mutate("a rate that is not a number", (o) => (rate0(o)["rate"] = "abc"));
  mutate("a rate date that is not a date", (o) => (rate0(o)["rateDate"] = "10/11/2026"));
  mutate("an impossible rate date", (o) => (rate0(o)["rateDate"] = "2026-02-30"));
  mutate("a duplicate currency", (o) => {
    const list = o["rates"] as Record<string, unknown>[];
    list.push({ ...list[0] });
  });
  mutate("asOf that is not a date", (o) => (o["asOf"] = "yesterday"));
  mutate("asOf undefined", (o) => delete o["asOf"]);
  mutate("base not EUR", (o) => (o["base"] = "USD"));
  mutate("stale as a string", (o) => (o["stale"] = "false"));
  mutate("an unknown stale reason", (o) => (o["staleReason"] = "because"));
  mutate("workingDaysOld negative", (o) => (o["workingDaysOld"] = -1));
  mutate("workingDaysOld fractional", (o) => (o["workingDaysOld"] = 1.5));
  mutate("workingDaysOld a string", (o) => (o["workingDaysOld"] = "3"));
  mutate("notice missing", (o) => delete o["notice"]);
  mutate("lastImportAt a number", (o) => (o["lastImportAt"] = 5));
  mutate("lastImportCode a number", (o) => (o["lastImportCode"] = 5));
});

describe("getFxRates (S2)", () => {
  const answer = (body: unknown) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  it("returns a valid answer", async () => {
    answer(fxRates());
    await expect(getFxRates()).resolves.toEqual(fxRates());
    vi.restoreAllMocks();
  });

  it("turns a malformed answer into an ApiError (the 'rates could not be read' state)", async () => {
    answer({ rates: "oops" });
    await expect(getFxRates()).rejects.toBeInstanceOf(ApiError);
    answer(null);
    await expect(getFxRates()).rejects.toMatchObject({ code: "bad_response" });
    vi.restoreAllMocks();
  });
});
