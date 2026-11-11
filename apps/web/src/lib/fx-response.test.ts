import { describe, expect, it, vi } from "vitest";
import { ApiError, getFxRates } from "../api";
import { fxNever, fxOutage, fxRates, fxStale } from "../test-fixtures-fx";
import { MAX_FX_RATES, parseFxRatesResponse } from "./fx-response";

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

describe("parseFxRatesResponse, review of T2", () => {
  const rate0 = (o: Record<string, unknown>) =>
    (o["rates"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  const rejects = (fn: (o: Record<string, unknown>) => void) => {
    const o = clone();
    fn(o);
    return parseFxRatesResponse(o);
  };

  it("tolerates fields it does not know (forward compatible: unresolvedConflicts)", () => {
    const o = clone();
    o["unresolvedConflicts"] = 2;
    o["somethingNew"] = { nested: true };
    rate0(o)["source"] = "ECB";
    rate0(o)["extra"] = "x";
    expect(parseFxRatesResponse(o)).not.toBeNull();
  });

  it.each([
    ["trailing zero", "1.0850"],
    ["leading zero", "01.0853"],
    ["leading space", " 1.0853"],
  ])("rejects a rate that is not canonical (%s)", (_n, rate) => {
    expect(rejects((o) => (rate0(o)["rate"] = rate))).toBeNull();
  });

  it("rejects a huge rate string without walking it", () => {
    expect(rejects((o) => (rate0(o)["rate"] = "1".repeat(5_000_000)))).toBeNull();
    expect(rejects((o) => (rate0(o)["currency"] = "U".repeat(5_000_000)))).toBeNull();
    expect(rejects((o) => (o["notice"] = "x".repeat(5_000)))).toBeNull();
    expect(rejects((o) => (o["lastImportStatus"] = "x".repeat(5_000)))).toBeNull();
  });

  it("rejects more than MAX_FX_RATES entries, accepts exactly that many", () => {
    const codes: string[] = [];
    for (let a = 65; a < 91 && codes.length < MAX_FX_RATES + 1; a++) {
      for (let b = 65; b < 91 && codes.length < MAX_FX_RATES + 1; b++) {
        const c = `Q${String.fromCharCode(a)}${String.fromCharCode(b)}`;
        codes.push(c);
      }
    }
    const make = (n: number) =>
      codes.slice(0, n).map((currency) => ({ currency, rate: "1.5", rateDate: "2026-11-10" }));
    expect(rejects((o) => (o["rates"] = make(MAX_FX_RATES)))).not.toBeNull();
    expect(rejects((o) => (o["rates"] = make(MAX_FX_RATES + 1)))).toBeNull();
  });

  it("rejects a rate dated after asOf, and rates without asOf", () => {
    expect(rejects((o) => (rate0(o)["rateDate"] = "2026-11-11"))).toBeNull();
    expect(rejects((o) => (o["asOf"] = null))).toBeNull();
  });

  it("rejects never_imported with an age or not stale", () => {
    const never = (): Record<string, unknown> => JSON.parse(JSON.stringify(fxNever()));
    const a = never();
    a["workingDaysOld"] = 3;
    expect(parseFxRatesResponse(a)).toBeNull();
    const b = never();
    b["stale"] = false;
    expect(parseFxRatesResponse(b)).toBeNull();
  });

  it("rejects an unsafe integer age", () => {
    expect(rejects((o) => (o["workingDaysOld"] = 2 ** 60))).toBeNull();
  });

  it("prototype keys do not confuse it and never throw", () => {
    const hostile = JSON.parse(
      '{"__proto__":{"base":"EUR"},"constructor":{"prototype":{"x":1}},"rates":[]}',
    ) as unknown;
    expect(() => parseFxRatesResponse(hostile)).not.toThrow();
    expect(parseFxRatesResponse(hostile)).toBeNull();
    const o = clone();
    (o["rates"] as unknown[]).push(
      JSON.parse('{"__proto__":{"currency":"CHF","rate":"0.95","rateDate":"2026-11-10"}}'),
    );
    expect(parseFxRatesResponse(o)).toBeNull();
    expect(({} as Record<string, unknown>)["base"]).toBeUndefined();
  });
});
