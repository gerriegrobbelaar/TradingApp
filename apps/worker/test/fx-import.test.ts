/**
 * The ECB import job (task F2, ADR 0035): fetch hardening, idempotent storage, conflicts, the
 * working-day and 17:30 rules, and the retry chain through the real runner.
 */
import { nextRun, type Schedule } from "@camelthorn/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ECB_MAX_BYTES, ECB_TIMEOUT_MS, fetchEcb, isAllowedEcbUrl } from "../src/fx/ecb-fetch";
import { ECB_MAX_ATTEMPTS, runEcbImport } from "../src/fx/ecb-import";
import { DEFAULT_JOBS } from "../src/jobs/defaults";
import { HANDLERS } from "../src/jobs/handlers";
import { executeRun } from "../src/jobs/runner";
import type { HandlerDef } from "../src/jobs/types";
import {
  csvResponse,
  ctxAt,
  db,
  auditOf,
  fxRows,
  resetFx,
  stubEcb,
  type FakeEcb,
} from "./fx-helpers";
import { FakeQueue, addJob, addRun, envWith } from "./job-helpers";

// Tuesday 10 November 2026. 16:15 CET = 15:15 UTC.
const SLOT = "2026-11-10T15:15:00.000Z";
const MIN = 60_000;
const CURRENCIES = { USD: 1.1, GBP: 0.86, JPY: 160 };
let ecb: FakeEcb;

beforeEach(async () => {
  await resetFx();
  ecb = stubEcb();
});
afterEach(() => {
  ecb.restore();
  vi.useRealTimers();
});

const run = (o: Parameters<typeof ctxAt>[1] = {}, slot = SLOT) => runEcbImport(ctxAt(slot, o));
const stateRow = () =>
  db.prepare("SELECT * FROM fx_import_state WHERE id = 1").first<Record<string, unknown>>();

describe("import window and storage", () => {
  it("first import reads 400 days, the next run only a short window", async () => {
    ecb.fill(CURRENCIES, "2025-08-01", "2026-11-10");
    const first = await run();
    expect(first.status).toBe("ok");
    expect(ecb.calls).toHaveLength(1);
    expect(ecb.calls[0]?.url.searchParams.get("startPeriod")).toBe("2025-10-06");
    expect(ecb.calls[0]?.url.searchParams.get("format")).toBe("csvdata");
    const rows = await fxRows();
    expect(rows.length).toBe(first.summary["inserted"]);
    expect(rows.every((r) => r.rate_date >= "2025-10-06")).toBe(true);
    expect(first.summary).toMatchObject({ firstImport: true, conflicts: 0 });

    // The next working day: incremental window, a handful of new rows.
    ecb.fill(CURRENCIES, "2026-11-11", "2026-11-11");
    const next = await run({ trigger: "manual" }, "2026-11-11T15:15:00.000Z");
    expect(ecb.calls[1]?.url.searchParams.get("startPeriod")).toBe("2026-11-01");
    expect(next.summary).toMatchObject({ firstImport: false, inserted: 3 });
  });

  it("after a long outage the window reaches back to the newest stored date", async () => {
    ecb.fill(CURRENCIES, "2026-09-01", "2026-09-30");
    await run({ trigger: "manual" }, "2026-09-30T15:15:00.000Z");
    ecb.fill(CURRENCIES, "2026-10-01", "2026-11-10");
    await run({ trigger: "manual" });
    // newest stored was 2026-09-30, so the window starts 3 days earlier, not 10 days before today.
    expect(ecb.calls[1]?.url.searchParams.get("startPeriod")).toBe("2026-09-27");
    expect((await fxRows()).some((r) => r.rate_date === "2026-10-15")).toBe(true);
  });

  it("running twice stores nothing twice and the second scheduled run is already_current", async () => {
    ecb.fill(CURRENCIES, "2026-10-01", "2026-11-10");
    const a = await run();
    const n = (await fxRows()).length;
    const b = await run();
    expect(a.status).toBe("ok");
    expect(b).toMatchObject({ status: "ok", code: "already_current" });
    expect(ecb.calls).toHaveLength(1); // already_current made no request
    expect((await fxRows()).length).toBe(n);
    const c = await run({ trigger: "manual" }); // a manual run fetches again but stores nothing
    expect(c.summary).toMatchObject({ inserted: 0, conflicts: 0 });
    expect((await fxRows()).length).toBe(n);
    expect(await stateRow()).toMatchObject({ last_status: "ok", newest_rate_date: "2026-11-10" });
  });

  it("keeps the stored value when the ECB shows a different one, counts it and audits once", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-10");
    ecb.set("USD", "2026-11-03", "1.1111");
    await run();
    const stored = (await fxRows()).find(
      (r) => r.currency === "USD" && r.rate_date === "2026-11-03",
    );
    expect(stored?.rate).toBe("1.1111");
    const before = (await auditOf("fx.rate_conflict")).length;

    ecb.set("USD", "2026-11-03", "1.2222");
    const again = await run({ trigger: "manual" });
    expect(again.summary).toMatchObject({ conflicts: 1, inserted: 0 });
    const kept = (await fxRows()).find((r) => r.currency === "USD" && r.rate_date === "2026-11-03");
    expect(kept?.rate).toBe("1.1111");
    const audits = await auditOf("fx.rate_conflict");
    expect(audits).toHaveLength(before + 1);
    expect(audits.at(-1)).toMatchObject({ entity_id: "USD@2026-11-03" });
    expect(JSON.parse(audits.at(-1)?.after_json ?? "{}")).toEqual({
      stored: "1.1111",
      ecb: "1.2222",
    });
    // The same disagreement tomorrow is counted but not audited again.
    await run({ trigger: "manual" });
    expect(await auditOf("fx.rate_conflict")).toHaveLength(before + 1);
    // 1.1111 vs 1.11110 is the same number, not a conflict.
    ecb.set("USD", "2026-11-03", "1.11110");
    expect((await run({ trigger: "manual" })).summary).toMatchObject({ conflicts: 0 });
  });

  it("ignores rows with a bad currency, a bad rate, a duplicate or a future date", async () => {
    ecb.respond = () =>
      csvResponse(
        [
          "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE",
          "k,D,USD,EUR,SP00,A,2026-11-10,1.1000,A,t",
          "k,D,USD,EUR,SP00,A,2026-11-10,1.2000,A,t",
          "k,D,EUR,EUR,SP00,A,2026-11-10,1.0000,A,t",
          "k,D,GBP,EUR,SP00,A,2026-11-10,0,A,t",
          "k,D,CHF,EUR,SP00,A,2026-11-10,abc,A,t",
          "k,D,JPY,EUR,SP00,A,2026-12-01,160.1,A,t",
        ].join("\n"),
      );
    const r = await run({ trigger: "manual" });
    expect(r.status).toBe("ok");
    expect(await fxRows()).toEqual([{ currency: "USD", rate_date: "2026-11-10", rate: "1.1000" }]);
    expect(r.summary["skipped"]).toBeGreaterThanOrEqual(4);
  });

  it("stores 100+ rows in chunks", async () => {
    ecb.fill({ USD: 1.1 }, "2026-01-01", "2026-11-10");
    const r = await run({ trigger: "manual" });
    expect(r.summary["inserted"]).toBeGreaterThan(200);
    expect((await fxRows()).length).toBe(r.summary["inserted"]);
  });

  it("partial publication: some currencies today, the rest later the same day", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-09");
    ecb.set("USD", "2026-11-10", "1.1200");
    const first = await run();
    expect(first).toMatchObject({ status: "ok" });
    expect(first.summary).toMatchObject({ currenciesToday: 1, missingToday: 2 });
    // Not complete, so a later scheduled run fetches again instead of saying already_current.
    ecb.set("GBP", "2026-11-10", "0.8700");
    ecb.set("JPY", "2026-11-10", "161.0");
    const second = await run();
    expect(second.code).toBeUndefined();
    expect(second.summary).toMatchObject({ inserted: 2, currenciesToday: 3 });
    expect(second.summary["missingToday"]).toBeUndefined();
    expect((await run()).code).toBe("already_current");
  });

  it("records the attempt in fx_import_state", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-10");
    await run();
    const s = await stateRow();
    expect(s).toMatchObject({
      last_status: "ok",
      last_error_code: null,
      newest_rate_date: "2026-11-10",
      rows_inserted: 21,
    });
    expect(s?.["last_attempt_at"]).toBe(SLOT);
    expect(s?.["last_success_at"]).toBe(SLOT);
  });
});

describe("working days, publication and the 17:30 rule", () => {
  it("skips weekends and TARGET holidays (Good Friday, Easter Monday) without a request", async () => {
    for (const slot of [
      "2026-11-14T15:15:00.000Z", // Saturday
      "2026-11-15T15:15:00.000Z", // Sunday
      "2026-04-03T14:15:00.000Z", // Good Friday 2026
      "2026-04-06T14:15:00.000Z", // Easter Monday 2026
      "2026-12-25T15:15:00.000Z",
      "2027-01-01T15:15:00.000Z",
    ]) {
      const r = await run({}, slot);
      expect(r, slot).toMatchObject({ status: "skipped", code: "non_working_day" });
    }
    expect(ecb.calls).toHaveLength(0);
  });

  it("a manual run on a non-working day still refreshes and backfills", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-13");
    const r = await run({ trigger: "manual" }, "2026-11-14T10:00:00.000Z"); // Saturday
    expect(r.status).toBe("ok");
    expect(ecb.calls).toHaveLength(1);
    expect(r.summary["inserted"]).toBeGreaterThan(0);
  });

  it("not published yet: partial with a 10-minute retry while it still fits", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-09");
    const r = await run();
    expect(r).toMatchObject({
      status: "partial",
      code: "not_yet_published",
      retry: { delaySeconds: 600 },
    });
    expect(await stateRow()).toMatchObject({ last_status: "partial" });
  });

  it("the last attempt that fits ends error / rate_not_published instead of a retry", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-09");
    const slot = Date.parse(SLOT);
    // 17:15 (60 min): the next attempt at 17:25 still fits.
    expect((await runEcbImport(ctxAt(SLOT, { now: slot + 60 * MIN, attempt: 7 }))).status).toBe(
      "partial",
    );
    // 17:25 (70 min): 17:35 would be too late.
    expect(await runEcbImport(ctxAt(SLOT, { now: slot + 70 * MIN, attempt: 8 }))).toMatchObject({
      status: "error",
      code: "rate_not_published",
    });
    // Exactly on the edge: a retry at 17:30 is still allowed (the runner allows lateness == 75).
    expect((await runEcbImport(ctxAt(SLOT, { now: slot + 65 * MIN, attempt: 7 }))).status).toBe(
      "partial",
    );
    // One second over the edge is the end.
    expect(
      (await runEcbImport(ctxAt(SLOT, { now: slot + 65 * MIN + 1000, attempt: 7 }))).code,
    ).toBe("rate_not_published");
    // The attempt count also bounds the chain.
    expect((await runEcbImport(ctxAt(SLOT, { now: slot, attempt: ECB_MAX_ATTEMPTS }))).code).toBe(
      "rate_not_published",
    );
  });

  it("the retry chain through the real runner ends at 17:30 with an error, never too_late", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-09");
    const slot = Date.parse(SLOT);
    for (const drift of [0, 11]) {
      let clock = slot;
      const q = new FakeQueue(() => clock);
      const e = envWith(q);
      const id = await addJob({ name: `ecb-${drift}`, handler: "ecb" });
      const handlers = { ecb: HANDLERS["ecb.fx_import"] as HandlerDef };
      const first = await addRun(id, { scheduledFor: SLOT });
      let runId: number | undefined = first;
      const starts: number[] = [];
      while (runId !== undefined) {
        starts.push((clock - slot) / MIN);
        await executeRun(e, runId, { handlers, now: () => clock });
        clock += drift === 0 ? 10 * MIN : drift * MIN;
        runId = q.sent.shift()?.body.runId;
      }
      const rows = (
        await db
          .prepare(
            "SELECT status, error_code, attempt FROM job_runs WHERE job_id = ?1 ORDER BY attempt",
          )
          .bind(id)
          .all<{ status: string; error_code: string | null; attempt: number }>()
      ).results;
      const last = rows.at(-1);
      expect(last, `drift ${drift}`).toMatchObject({
        status: "error",
        error_code: "rate_not_published",
      });
      expect(rows.some((r) => r.error_code === "too_late")).toBe(false);
      expect(rows.slice(0, -1).every((r) => r.error_code === "not_yet_published")).toBe(true);
      expect(Math.max(...starts)).toBeLessThanOrEqual(75);
      if (drift === 0) expect(starts).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
      else expect(starts).toEqual([0, 11, 22, 33, 44, 55, 66]);
    }
  });

  it("publishes on the third attempt: ok, nothing further queued", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-09");
    const slot = Date.parse(SLOT);
    expect((await runEcbImport(ctxAt(SLOT, { now: slot, attempt: 1 }))).status).toBe("partial");
    expect((await runEcbImport(ctxAt(SLOT, { now: slot + 10 * MIN, attempt: 2 }))).status).toBe(
      "partial",
    );
    ecb.fill(CURRENCIES, "2026-11-10", "2026-11-10");
    const r = await runEcbImport(ctxAt(SLOT, { now: slot + 20 * MIN, attempt: 3 }));
    expect(r.status).toBe("ok");
    expect(r.retry).toBeUndefined();
  });

  it("the daylight saving days keep the 16:15 slot and the 17:30 cut-off in local time", async () => {
    const sched = DEFAULT_JOBS.find((j) => j.name === "ecb.fx_import")?.schedule as Schedule;
    // After Friday's slot (CET): the next one is Monday 30 March, already CEST (UTC+2).
    const fri = Date.parse("2026-03-27T15:16:00.000Z");
    const mon = nextRun(sched, fri);
    expect(new Date(mon as number).toISOString()).toBe("2026-03-30T14:15:00.000Z");
    // Autumn: Friday 23 Oct 2026 is CEST; Monday 26 Oct is CET (UTC+1).
    const monAutumn = nextRun(sched, Date.parse("2026-10-23T14:16:00.000Z"));
    expect(new Date(monAutumn as number).toISOString()).toBe("2026-10-26T15:15:00.000Z");

    // The cut-off is slot + 75 minutes in absolute time, which is 17:30 local on both days.
    ecb.fill(CURRENCIES, "2026-03-20", "2026-03-27");
    const slot = Date.parse("2026-03-30T14:15:00.000Z");
    expect(
      (await runEcbImport(ctxAt("2026-03-30T14:15:00.000Z", { now: slot + 65 * MIN, attempt: 7 })))
        .status,
    ).toBe("partial"); // 17:20 local, a retry at 17:30 fits
    expect(
      (await runEcbImport(ctxAt("2026-03-30T14:15:00.000Z", { now: slot + 66 * MIN, attempt: 7 })))
        .code,
    ).toBe("rate_not_published");
  });
});

describe("fetch hardening and failure classification", () => {
  it("sends one plain GET: Accept text/csv, no credentials, redirects refused, no extra headers", async () => {
    ecb.fill(CURRENCIES, "2026-11-09", "2026-11-10");
    await run();
    const call = ecb.calls[0];
    expect(call?.url.origin).toBe("https://data-api.ecb.europa.eu");
    expect(call?.url.pathname.startsWith("/service/data/EXR/")).toBe(true);
    expect(call?.init?.method).toBe("GET");
    expect(call?.init?.redirect).toBe("manual");
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(call?.init?.headers).toEqual({ accept: "text/csv" });
    expect(call?.init?.body).toBeUndefined();
    expect(Object.keys(call?.init ?? {}).sort()).toEqual([
      "headers",
      "method",
      "redirect",
      "signal",
    ]);
  });

  it("allow-lists the URL again before fetching", async () => {
    for (const bad of [
      "http://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A",
      "https://evil.example/service/data/EXR/D..EUR.SP00.A",
      "https://data-api.ecb.europa.eu.evil.example/service/data/EXR/x",
      "https://user:pw@data-api.ecb.europa.eu/service/data/EXR/x",
      "https://data-api.ecb.europa.eu:8443/service/data/EXR/x",
      "https://data-api.ecb.europa.eu/other/path",
      "https://data-api.ecb.europa.eu/service/data/EXR/x#frag",
      "not a url",
    ]) {
      expect(isAllowedEcbUrl(bad), bad).toBe(false);
      expect(await fetchEcb(bad)).toEqual({ kind: "permanent", code: "url_not_allowed" });
    }
    expect(
      isAllowedEcbUrl("https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?x=1"),
    ).toBe(true);
    expect(ecb.calls).toHaveLength(0);
  });

  it("refuses a redirect: error, no retry, nothing stored", async () => {
    ecb.respond = () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
    const r = await run();
    expect(r).toMatchObject({ status: "error", code: "redirect_refused" });
    expect(r.retry).toBeUndefined();
    expect(ecb.calls).toHaveLength(1); // the redirect target was never requested
    expect(await fxRows()).toEqual([]);
  });

  it("refuses a response over 5 MB, declared or streamed", async () => {
    const big = "x".repeat(ECB_MAX_BYTES + 10);
    ecb.respond = () => csvResponse(big);
    const streamed = await run();
    expect(streamed).toMatchObject({ status: "error", code: "response_too_large" });
    ecb.respond = () =>
      new Response("small", {
        status: 200,
        headers: { "content-type": "text/csv", "content-length": String(ECB_MAX_BYTES + 1) },
      });
    expect(await run()).toMatchObject({ code: "response_too_large" });
    expect(await fxRows()).toEqual([]);
  });

  it("a streamed body that grows past the cap is cut off without reading it all", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    ecb.respond = () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled++;
            c.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-type": "text/csv" } },
      );
    expect(await run()).toMatchObject({ code: "response_too_large" });
    expect(pulled).toBeLessThanOrEqual(8);
  });

  it("an HTML page is not data: 200 text/html is bad_content_type, csv-typed HTML is bad_response", async () => {
    ecb.respond = () => csvResponse("<html><body>Maintenance</body></html>", 200, "text/html");
    expect(await run()).toMatchObject({ status: "error", code: "bad_content_type" });
    ecb.respond = () => csvResponse("<html><body>Maintenance</body></html>");
    const r = await run();
    expect(r).toMatchObject({ status: "error", code: "bad_response" });
    expect(r.retry).toBeUndefined();
    ecb.respond = () =>
      csvResponse("KEY,FREQ,CURRENCY,TIME_PERIOD,OBS_VALUE\nk,D,USD,2026-11-10,bad\n");
    expect(await run()).toMatchObject({ status: "error", code: "bad_response" });
    expect(await fxRows()).toEqual([]);
  });

  it("5xx, 429 and network errors are transient: partial with a retry; the last one is an error", async () => {
    for (const make of [
      () => csvResponse("<html>down</html>", 503, "text/html"),
      () => csvResponse("slow down", 429, "text/plain"),
      () => {
        throw new TypeError("fetch failed https://data-api.ecb.europa.eu/secret-path");
      },
    ]) {
      ecb.respond = make;
      const r = await run();
      expect(r.status).toBe("partial");
      expect(r.retry).toEqual({ delaySeconds: 600 });
      expect(["ecb_unavailable", "ecb_network"]).toContain(r.code);
      const last = await runEcbImport(
        ctxAt(SLOT, { now: Date.parse(SLOT) + 70 * MIN, attempt: 8 }),
      );
      expect(last.status).toBe("error");
      const manual = await run({ trigger: "manual" });
      expect(manual.status).toBe("error");
    }
  });

  it("a 4xx other than 404 is permanent; 404 and 204 mean no observations", async () => {
    ecb.respond = () => csvResponse("", 400, "text/plain");
    expect(await run()).toMatchObject({ status: "error", code: "bad_status" });
    ecb.respond = () => csvResponse("No results found", 404, "text/plain");
    expect(await run()).toMatchObject({ status: "partial", code: "not_yet_published" });
    ecb.respond = () => new Response(null, { status: 204 });
    expect((await run({ trigger: "manual" })).status).toBe("ok");
  });

  it("times out after 15 seconds as a transient failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ecb.respond = (call) =>
      new Promise<Response>((_, reject) => {
        call.init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const p = fetchEcb("https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A");
    await vi.advanceTimersByTimeAsync(ECB_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ kind: "transient", code: "ecb_timeout" });
  });

  it("the run's own abort (deadline) is rethrown, not retried as a timeout", async () => {
    const ac = new AbortController();
    ecb.respond = (call) =>
      new Promise<Response>((_, reject) => {
        call.init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        ac.abort();
      });
    await expect(
      fetchEcb("https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A", ac.signal),
    ).rejects.toThrow();
  });

  it("never logs a response body or URL, and results and audit rows carry none", async () => {
    const MARK = "BODY-MARKER-7f3a";
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.join(" "))),
    );
    try {
      const results = [];
      ecb.respond = () => csvResponse(`<html>${MARK}</html>`, 200, "text/html");
      results.push(await run());
      ecb.respond = () => csvResponse(`<html>${MARK}</html>`, 503, "text/html");
      results.push(await run());
      ecb.respond = () => csvResponse(`not,a,csv\n${MARK},1,2\n`);
      results.push(await run());
      ecb.respond = () => {
        throw new TypeError(`${MARK} https://data-api.ecb.europa.eu/x`);
      };
      results.push(await run());
      const text = JSON.stringify(results) + logs.join("\n");
      expect(text).not.toContain(MARK);
      expect(text).not.toContain("ecb.europa.eu");
      const audits = JSON.stringify(await auditOf("fx.import"));
      expect(audits).not.toContain(MARK);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe("audit", () => {
  it("writes a summary row on change and on error, none for already_current or a quiet wait", async () => {
    ecb.fill(CURRENCIES, "2026-11-02", "2026-11-10");
    const n0 = (await auditOf("fx.import")).length;
    await run(); // inserted rows
    const n1 = (await auditOf("fx.import")).length;
    expect(n1).toBe(n0 + 1);
    await run(); // already_current
    expect((await auditOf("fx.import")).length).toBe(n1);
    await run({ trigger: "manual" }); // nothing new
    expect((await auditOf("fx.import")).length).toBe(n1);
    ecb.respond = () => csvResponse("x", 400, "text/html");
    await run({ trigger: "manual" }); // error
    expect((await auditOf("fx.import")).length).toBe(n1 + 1);
    const last = (await auditOf("fx.import")).at(-1);
    expect(JSON.parse(last?.after_json ?? "{}")).toMatchObject({ status: "error" });
  });
});
