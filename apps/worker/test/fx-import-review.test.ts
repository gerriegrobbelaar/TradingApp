/**
 * Review of task F2 (ADR 0036): the retry chain through the real runner with realistic queue
 * drift and handler time, DST days and TARGET holidays; a late ECB publication healed by the next
 * working day's run; import safety (canonical rates, conflict audits beyond the per-run cap,
 * partial batch failure, crash paths); fetch details (Retry-After, body timeout, content types,
 * query allow-list); the parser's error codes. Fixed clocks only, no real waits.
 */
import { env } from "cloudflare:test";
import { ecbRequestUrl, nextRun, type Schedule } from "@camelthorn/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ECB_TIMEOUT_MS, fetchEcb, parseRetryAfter } from "../src/fx/ecb-fetch";
import {
  ECB_MAX_ATTEMPTS,
  ECB_RETRY_MARGIN_MS,
  INSERT_CHUNK,
  runEcbImport,
  storeObservations,
} from "../src/fx/ecb-import";
import { fxStaleness } from "../src/fx/staleness";
import { DEFAULT_JOBS } from "../src/jobs/defaults";
import { HANDLERS } from "../src/jobs/handlers";
import { executeRun } from "../src/jobs/runner";
import type { HandlerDef, JobContext } from "../src/jobs/types";
import {
  auditOf,
  csvResponse,
  ctxAt,
  db,
  fxRows,
  resetFx,
  stubEcb,
  type FakeEcb,
} from "./fx-helpers";
import { FakeQueue, addJob, addRun, envWith } from "./job-helpers";

const MIN = 60_000;
const CURRENCIES = { USD: 1.1, GBP: 0.86, JPY: 160 };
const ECB_DEF = HANDLERS["ecb.fx_import"] as HandlerDef;
let ecb: FakeEcb;
let jobSeq = 0;

beforeEach(async () => {
  await resetFx();
  ecb = stubEcb();
});
afterEach(() => {
  ecb.restore();
  vi.useRealTimers();
});

const stateRow = () =>
  db
    .prepare("SELECT * FROM fx_import_state WHERE id = 1")
    .first<{ last_status: string | null; last_error_code: string | null }>();

/** Deterministic 0..1 sequence (LCG), so "random" drift is the same on every run. */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

interface ChainRow {
  status: string;
  error_code: string | null;
  attempt: number;
  started_at: string | null;
}

/**
 * Drives one slot's whole chain through the real runner: every attempt executes at `clock`, the
 * fetch itself takes `fetchMs()` (the clock moves during the handler), and the next attempt is
 * delivered `delaySeconds` after the finish plus `queueDelayMs()`.
 */
async function chain(
  slotIso: string,
  queueDelayMs: () => number,
  fetchMs: () => number = () => 0,
): Promise<{ rows: ChainRow[]; startsMin: number[] }> {
  const slot = Date.parse(slotIso);
  let clock = slot;
  const q = new FakeQueue(() => clock);
  const e = envWith(q);
  const id = await addJob({ name: `ecb-review-${++jobSeq}`, handler: "ecb" });
  const handlers = { ecb: ECB_DEF };
  const prev = ecb.respond;
  ecb.respond = async (call) => {
    clock += fetchMs();
    if (prev) return prev(call);
    const start = call.url.searchParams.get("startPeriod") ?? "0000-00-00";
    const rows = [...ecb.data.entries()]
      .map(([k, rate]) => {
        const [currency, date] = k.split("|") as [string, string];
        return { currency, date, rate };
      })
      .filter((r) => r.date >= start);
    return csvResponse(
      [
        "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
        ...rows.map(
          (r) => `EXR.D.${r.currency}.EUR.SP00.A,D,${r.currency},EUR,SP00,A,${r.date},${r.rate}`,
        ),
      ].join("\r\n"),
    );
  };
  let runId: number | undefined = await addRun(id, { scheduledFor: slotIso });
  const startsMin: number[] = [];
  let guard = 0;
  while (runId !== undefined && guard++ < 20) {
    startsMin.push((clock - slot) / MIN);
    await executeRun(e, runId, { handlers, now: () => clock });
    const next = q.sent.shift();
    if (!next) break;
    clock += next.delaySeconds * 1000 + queueDelayMs();
    runId = next.body.runId;
  }
  ecb.respond = prev;
  const rows = (
    await db
      .prepare(
        "SELECT status, error_code, attempt, started_at FROM job_runs WHERE job_id = ?1 ORDER BY attempt",
      )
      .bind(id)
      .all<ChainRow>()
  ).results;
  return { rows, startsMin };
}

describe("retry chain through the real runner: realistic drift, DST, 17:30", () => {
  const SLOTS = [
    "2026-11-10T15:15:00.000Z", // Tuesday, CET
    "2026-03-30T14:15:00.000Z", // first Monday of CEST (after the spring switch)
    "2026-03-27T15:15:00.000Z", // last Friday of CET before the switch
    "2026-10-26T15:15:00.000Z", // first Monday of CET (after the autumn switch)
    "2026-10-23T14:15:00.000Z", // last Friday of CEST
  ];

  // 3.9 s alone: 4 slots x 4 drift patterns x full chains. Under the parallel suite it crossed the
  // 5 s default and the leftover chain broke the next two tests, so it gets its own bound.
  it(
    "ends error / rate_not_published before 17:30 for queue drift 0-2 min and fetch time 0-15 s",
    { timeout: 60_000 },
    async () => {
      for (const slotIso of SLOTS) {
        const day = new Date(Date.parse(slotIso)).toISOString().slice(0, 10);
        ecb.data.clear();
        ecb.fill(CURRENCIES, "2026-01-01", "2026-12-31");
        // Nothing on the slot day: the ECB is late.
        for (const c of Object.keys(CURRENCIES)) ecb.data.delete(`${c}|${day}`);
        for (const [seed, label] of [
          [0, "none"],
          [1, "max"],
          [7, "random-a"],
          [12345, "random-b"],
        ] as const) {
          await resetFx();
          const r = lcg(seed);
          const drift =
            label === "none"
              ? () => 0
              : label === "max"
                ? () => 2 * MIN
                : () => Math.round(r() * 2 * MIN);
          const fetch = label === "none" ? () => 0 : () => Math.round(r() * 15_000);
          const { rows, startsMin } = await chain(slotIso, drift, fetch);
          const tag = `${slotIso} ${label}`;
          const last = rows.at(-1);
          expect(last, tag).toMatchObject({ status: "error", error_code: "rate_not_published" });
          expect(
            rows.some((x) => x.error_code === "too_late"),
            tag,
          ).toBe(false);
          expect(
            rows
              .slice(0, -1)
              .every((x) => x.status === "partial" && x.error_code === "not_yet_published"),
            tag,
          ).toBe(true);
          // Every attempt started by 17:30 local (slot + 75 minutes), and the chain was not cut
          // short: it ran until the next attempt could no longer be due by 17:27.
          expect(Math.max(...startsMin), tag).toBeLessThanOrEqual(75);
          expect(rows.length, tag).toBeGreaterThanOrEqual(6);
          expect(rows.length, tag).toBeLessThanOrEqual(ECB_MAX_ATTEMPTS);
          const lastStart = startsMin.at(-1) as number;
          // The last attempt did not ask for more because 10 more minutes + margin passed 17:30.
          if (rows.length < ECB_MAX_ATTEMPTS) {
            expect(lastStart * MIN + 10 * MIN + ECB_RETRY_MARGIN_MS, tag).toBeGreaterThan(75 * MIN);
          }
          expect(await stateRow(), tag).toMatchObject({
            last_status: "error",
            last_error_code: "rate_not_published",
          });
        }
      }
    },
  );

  it("drift beyond the margin is recorded error / too_late (an alertable failure), and the state row says so", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-09");
    // On time until 17:15, whose retry is due at 17:25; that delivery comes 6 minutes late.
    let hop = 0;
    const { rows, startsMin } = await chain("2026-11-10T15:15:00.000Z", () =>
      ++hop < 7 ? 0 : 6 * MIN,
    );
    expect(startsMin).toEqual([0, 10, 20, 30, 40, 50, 60, 76]);
    const last = rows.at(-1);
    expect(last).toMatchObject({ status: "error", error_code: "too_late" });
    expect(rows.filter((x) => x.status === "skipped")).toEqual([]);
    expect(await stateRow()).toMatchObject({ last_status: "error", last_error_code: "too_late" });
  });

  it("other jobs keep the plain skipped / too_late", () => {
    for (const [name, d] of Object.entries(HANDLERS)) {
      if (name !== "ecb.fx_import") expect(d.tooLateIsFailure, name).toBeUndefined();
    }
  });

  it("publication on attempt 4 ends the chain ok with nothing queued", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-09");
    let calls = 0;
    ecb.respond = () => {
      calls++;
      if (calls === 4) ecb.fill(CURRENCIES, "2026-11-10", "2026-11-10");
      const rows = [...ecb.data.entries()].map(([k, rate]) => {
        const [currency, date] = k.split("|") as [string, string];
        return `EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${date},${rate}`;
      });
      return csvResponse(
        [
          "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
          ...rows,
        ].join("\n"),
      );
    };
    const { rows } = await chain("2026-11-10T15:15:00.000Z", () => MIN);
    expect(rows.map((x) => x.status)).toEqual(["partial", "partial", "partial", "ok"]);
    expect(await stateRow()).toMatchObject({ last_status: "ok", last_error_code: null });
  });
});

describe("TARGET calendar for the schedule and the handler", () => {
  const sched = DEFAULT_JOBS.find((j) => j.name === "ecb.fx_import")?.schedule as Schedule;
  const nextAfter = (iso: string) =>
    new Date(nextRun(sched, Date.parse(iso)) as number).toISOString();

  it("the schedule skips Good Friday, Easter Monday, 1 May, 25/26 December and 1 January", () => {
    // Thursday 2 April 2026 after the slot: next is Tuesday 7 April (CEST, 14:15 UTC).
    expect(nextAfter("2026-04-02T14:16:00.000Z")).toBe("2026-04-07T14:15:00.000Z");
    // Thursday 30 April 2026: Friday 1 May is a holiday, next is Monday 4 May.
    expect(nextAfter("2026-04-30T14:16:00.000Z")).toBe("2026-05-04T14:15:00.000Z");
    // Wednesday 24 December 2025: 25 and 26 are holidays, next is Monday 29 December (CET).
    expect(nextAfter("2025-12-24T15:16:00.000Z")).toBe("2025-12-29T15:15:00.000Z");
    // Wednesday 31 December 2025: 1 January is a holiday, next is Friday 2 January 2026.
    expect(nextAfter("2025-12-31T15:16:00.000Z")).toBe("2026-01-02T15:15:00.000Z");
  });

  it("a scheduled run on those days is skipped / non_working_day with no request", async () => {
    for (const slot of [
      "2026-05-01T14:15:00.000Z",
      "2025-12-25T15:15:00.000Z",
      "2025-12-26T15:15:00.000Z",
      "2026-01-01T15:15:00.000Z",
    ]) {
      expect(await runEcbImport(ctxAt(slot)), slot).toMatchObject({
        status: "skipped",
        code: "non_working_day",
      });
    }
    expect(ecb.calls).toHaveLength(0);
    expect(await stateRow()).toMatchObject({ last_status: "skipped" });
  });

  it("Run now on a non-working day goes through the real runner and imports", async () => {
    ecb.fill(CURRENCIES, "2026-03-20", "2026-04-02");
    const q = new FakeQueue();
    const id = await addJob({ name: `ecb-review-${++jobSeq}`, handler: "ecb" });
    const runId = await addRun(id, {
      trigger: "manual",
      scheduledFor: "2026-04-03T10:00:00.000Z", // Good Friday
      requestedBy: "admin@camelthorncapital.com",
    });
    const clock = Date.parse("2026-04-03T10:00:00.000Z");
    await executeRun(envWith(q), runId, { handlers: { ecb: ECB_DEF }, now: () => clock });
    const r = await db
      .prepare("SELECT status FROM job_runs WHERE id = ?1")
      .bind(runId)
      .first<{ status: string }>();
    expect(r?.status).toBe("ok");
    expect((await fxRows()).some((x) => x.rate_date === "2026-04-02")).toBe(true);
  });
});

describe("a publication after 17:30 is healed by the next working day's run", () => {
  it("Tuesday's rate published at 18:00 is stored by Wednesday's 16:15 run, with Wednesday's", async () => {
    ecb.fill(CURRENCIES, "2026-10-20", "2026-11-09");
    const tue = Date.parse("2026-11-10T15:15:00.000Z");
    const last = await runEcbImport(
      ctxAt("2026-11-10T15:15:00.000Z", { now: tue + 70 * MIN, attempt: 8 }),
    );
    expect(last.code).toBe("rate_not_published");
    // 18:00 Tuesday: the ECB publishes late; the feed reads stale.
    ecb.fill(CURRENCIES, "2026-11-10", "2026-11-10");
    expect(fxStaleness("2026-11-09", Date.parse("2026-11-10T17:00:00Z")).stale).toBe(true);
    // Wednesday 16:15: both days.
    ecb.fill(CURRENCIES, "2026-11-11", "2026-11-11");
    const wed = await runEcbImport(ctxAt("2026-11-11T15:15:00.000Z"));
    expect(wed.status).toBe("ok");
    expect(ecb.calls.at(-1)?.url.searchParams.get("startPeriod")).toBe("2026-11-01");
    const dates = new Set((await fxRows()).map((r) => r.rate_date));
    expect(dates.has("2026-11-10")).toBe(true);
    expect(dates.has("2026-11-11")).toBe(true);
    expect(fxStaleness("2026-11-11", Date.parse("2026-11-11T17:00:00Z")).stale).toBe(false);
  });

  it("Maundy Thursday published late is healed on the Tuesday after Easter", async () => {
    ecb.fill(CURRENCIES, "2026-03-16", "2026-04-01");
    const thu = Date.parse("2026-04-02T14:15:00.000Z");
    await runEcbImport(ctxAt("2026-04-02T14:15:00.000Z", { now: thu + 70 * MIN, attempt: 8 }));
    ecb.fill(CURRENCIES, "2026-04-02", "2026-04-07");
    const tue = await runEcbImport(ctxAt("2026-04-07T14:15:00.000Z"));
    expect(tue.status).toBe("ok");
    const dates = new Set((await fxRows()).map((r) => r.rate_date));
    expect(dates.has("2026-04-02") && dates.has("2026-04-07")).toBe(true);
  });
});

describe("import safety", () => {
  const NOW_ISO = "2026-11-10T15:20:00.000Z";

  it("compares and stores canonical rates: '1.10', '1.1' and '1.1000' are one value", async () => {
    await db
      .prepare(
        "INSERT INTO fx_rates (currency, rate_date, rate) VALUES ('USD', '2026-11-09', '1.10')",
      )
      .run();
    const r = await storeObservations(
      db,
      [
        { currency: "USD", rateDate: "2026-11-09", rate: "1.1000" },
        { currency: "USD", rateDate: "2026-11-10", rate: "01.2500" },
      ],
      "2026-11-01",
      "2026-11-10",
      NOW_ISO,
    );
    expect(r).toEqual({ inserted: 1, conflicts: 0, skipped: 0 });
    expect(await fxRows()).toEqual([
      { currency: "USD", rate_date: "2026-11-09", rate: "1.10" }, // never rewritten
      { currency: "USD", rate_date: "2026-11-10", rate: "1.25" },
    ]);
  });

  it("audits every conflict exactly once, even beyond the per-run cap of 25", async () => {
    const days: string[] = [];
    for (let d = 1; d <= 30; d++) days.push(`2026-10-${String(d).padStart(2, "0")}`);
    const stored = days.map((d) => ({ currency: "USD", rateDate: d, rate: "1.1" }));
    await storeObservations(db, stored, "2026-09-01", "2026-11-10", NOW_ISO);
    const changed = days.map((d) => ({ currency: "USD", rateDate: d, rate: "1.2" }));
    const before = (await auditOf("fx.rate_conflict")).length;
    const a = await storeObservations(db, changed, "2026-09-01", "2026-11-10", NOW_ISO);
    expect(a.conflicts).toBe(30);
    expect((await auditOf("fx.rate_conflict")).length).toBe(before + 25);
    await storeObservations(db, changed, "2026-09-01", "2026-11-10", NOW_ISO);
    expect((await auditOf("fx.rate_conflict")).length).toBe(before + 30);
    await storeObservations(db, changed, "2026-09-01", "2026-11-10", NOW_ISO);
    const audits = (await auditOf("fx.rate_conflict")).slice(before);
    expect(audits).toHaveLength(30);
    expect(new Set(audits.map((x) => x.entity_id)).size).toBe(30);
    // A third value for the same day is a new disagreement: audited once more.
    await storeObservations(
      db,
      [{ currency: "USD", rateDate: "2026-10-01", rate: "1.3" }],
      "2026-09-01",
      "2026-11-10",
      NOW_ISO,
    );
    expect((await auditOf("fx.rate_conflict")).length).toBe(before + 31);
    expect((await fxRows()).every((r) => r.rate === "1.1")).toBe(true);
  });

  it("a failure in the third INSERT keeps the first two (oldest first); the next run completes", async () => {
    const obs = [];
    for (let i = 0; i < 260; i++) {
      const d = new Date(Date.parse("2026-01-01T00:00:00Z") + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      obs.push({ currency: "USD", rateDate: d, rate: "1.1" });
    }
    obs.reverse(); // the store must not depend on the input order
    let inserts = 0;
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            const st = target.prepare(sql);
            if (sql.includes("INSERT INTO fx_rates") && ++inserts === 3) {
              return {
                bind: () => ({
                  run: () => Promise.reject(new Error("D1_ERROR: simulated")),
                }),
              };
            }
            return st;
          };
        }
        const v: unknown = Reflect.get(target, key);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as D1Database;
    await expect(
      storeObservations(flaky, obs, "2025-01-01", "2026-11-10", NOW_ISO),
    ).rejects.toThrow("simulated");
    const partial = await fxRows();
    expect(partial).toHaveLength(2 * INSERT_CHUNK);
    expect(partial.at(-1)?.rate_date).toBe(obs[obs.length - 2 * INSERT_CHUNK]?.rateDate);
    const done = await storeObservations(db, obs, "2025-01-01", "2026-11-10", NOW_ISO);
    expect(done.inserted).toBe(260 - 2 * INSERT_CHUNK);
    expect(await fxRows()).toHaveLength(260);
  });

  it("a crash inside the handler still records error in fx_import_state, then rethrows", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-10");
    const broken = new Proxy(db, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            if (sql.includes("INSERT INTO fx_rates")) throw new Error("D1_ERROR: simulated");
            return target.prepare(sql);
          };
        }
        const v: unknown = Reflect.get(target, key);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as D1Database;
    const ctx: JobContext = {
      ...ctxAt("2026-11-10T15:15:00.000Z"),
      env: Object.create(env, { DB: { value: broken } }) as JobContext["env"],
    };
    await expect(runEcbImport(ctx)).rejects.toThrow("simulated");
    expect(await stateRow()).toMatchObject({
      last_status: "error",
      last_error_code: "handler_error",
    });
  });

  it("the first import's URL is exactly core ecbRequestUrl with a 400-day start", async () => {
    ecb.fill(CURRENCIES, "2026-11-09", "2026-11-10");
    await runEcbImport(ctxAt("2026-11-10T15:15:00.000Z"));
    expect(ecb.calls[0]?.url.href).toBe(ecbRequestUrl({ startDate: "2025-10-06" }));
  });
});

describe("fetch details", () => {
  const URL_OK = ecbRequestUrl({ startDate: "2026-11-01" });

  it("Retry-After: delta seconds and HTTP dates, bounded to an hour", () => {
    const now = Date.parse("2026-11-10T15:15:00Z");
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter("999999", now)).toBe(3600);
    expect(parseRetryAfter("Tue, 10 Nov 2026 15:30:00 GMT", now)).toBe(900);
    expect(parseRetryAfter("Tue, 10 Nov 2026 15:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });

  it("a 429 waits at least Retry-After; one that no longer fits before 17:30 ends the chain", async () => {
    ecb.respond = () =>
      new Response("slow down", { status: 429, headers: { "retry-after": "900" } });
    const r = await runEcbImport(ctxAt("2026-11-10T15:15:00.000Z"));
    expect(r).toMatchObject({
      status: "partial",
      code: "ecb_rate_limited",
      retry: { delaySeconds: 900 },
      summary: { httpStatus: 429, retryAfterSeconds: 900 },
    });
    ecb.respond = () => new Response("slow down", { status: 429, headers: { "retry-after": "5" } });
    expect((await runEcbImport(ctxAt("2026-11-10T15:15:00.000Z"))).retry).toEqual({
      delaySeconds: 600,
    });
    ecb.respond = () =>
      new Response("slow down", { status: 429, headers: { "retry-after": "3600" } });
    // 16:35 + 60 minutes is past 17:30.
    const late = Date.parse("2026-11-10T15:15:00.000Z") + 20 * MIN;
    expect(await runEcbImport(ctxAt("2026-11-10T15:15:00.000Z", { now: late }))).toMatchObject({
      status: "error",
      code: "ecb_rate_limited",
    });
  });

  it("the 15 s timeout also stops a body that trickles in after the headers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let cancelled = false;
    ecb.respond = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("KEY,FREQ,CURRENCY\n"));
          },
          pull() {
            return new Promise<void>(() => undefined); // never sends more
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "text/csv" } },
      );
    const p = fetchEcb(URL_OK);
    await vi.advanceTimersByTimeAsync(ECB_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ kind: "transient", code: "ecb_timeout" });
    expect(cancelled).toBe(true);
  });

  it("content types: csv with parameters and the SDMX-CSV type are accepted, others refused", async () => {
    const body = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\n";
    for (const t of [
      "text/csv",
      "text/csv; charset=utf-8",
      "TEXT/CSV;charset=UTF-8",
      "application/vnd.sdmx.data+csv;version=1.0.0",
    ]) {
      ecb.respond = () => csvResponse(body, 200, t);
      expect((await fetchEcb(URL_OK)).kind, t).toBe("ok");
    }
    for (const t of ["text/csvx", "application/json", "text/html", "", "text/plain; x=text/csv"]) {
      ecb.respond = () => csvResponse(body, 200, t);
      expect(await fetchEcb(URL_OK), t).toMatchObject({
        kind: "permanent",
        code: "bad_content_type",
      });
    }
  });

  it("the byte cap counts UTF-8 bytes, not characters", async () => {
    // 2-byte characters: 2.7 M characters are 5.4 MB (over 5 MiB) but only 2.7 M UTF-16 units.
    ecb.respond = () => csvResponse("é".repeat(2_700_000));
    expect(await fetchEcb(URL_OK)).toEqual({ kind: "permanent", code: "response_too_large" });
  });
});

describe("parser outcomes (core parseEcbCsv)", () => {
  const head = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE";

  it("a header-only CSV (no_observations) is 'nothing in the window', not a bad response", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-09");
    await runEcbImport(ctxAt("2026-11-09T15:15:00.000Z", { trigger: "manual" }));
    ecb.respond = () => csvResponse(`${head}\r\n`);
    expect(await runEcbImport(ctxAt("2026-11-10T15:15:00.000Z"))).toMatchObject({
      status: "partial",
      code: "not_yet_published",
    });
    expect(
      await runEcbImport(ctxAt("2026-11-10T15:15:00.000Z", { trigger: "manual" })),
    ).toMatchObject({
      // S10: an empty answer is not a success (state no_data, last_success_at unchanged)
      status: "partial",
      code: "no_data",
      summary: { inserted: 0, received: 0 },
    });
  });

  it("rows that are all refused, an unclosed quote or duplicated columns are bad_response", async () => {
    for (const [text, code] of [
      [`${head}\nk,M,USD,EUR,SP00,A,2026-11,1.1\n`, "no_observations"],
      [`${head}\nk,D,USD,EUR,SP00,A,2026-11-10,"1.1\n`, "malformed_csv"],
      [
        "KEY,CURRENCY,CURRENCY,TIME_PERIOD,OBS_VALUE\nk,USD,USD,2026-11-10,1.1\n",
        "ambiguous_columns",
      ],
      ["<html><body>Maintenance</body></html>", "missing_columns"],
    ] as const) {
      ecb.respond = () => csvResponse(text);
      const r = await runEcbImport(ctxAt("2026-11-10T15:15:00.000Z"));
      expect(r, code).toMatchObject({
        status: "error",
        code: "bad_response",
        summary: { parseError: code },
      });
      expect(r.retry).toBeUndefined();
    }
    expect(await fxRows()).toEqual([]);
  });
});
