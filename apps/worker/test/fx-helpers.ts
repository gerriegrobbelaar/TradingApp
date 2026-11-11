/**
 * Shared fixtures for the ECB import and rates API tests (task F2): a fake ECB Data Portal behind
 * a fetch spy, a CSV writer, and a job context builder.
 */
import { env } from "cloudflare:test";
import { addDaysIso, isTargetWorkingDay } from "@camelthorn/core";
import { vi } from "vitest";
import type { JobContext } from "../src/jobs/types";

export const db = env.DB;

export const CSV_HEAD =
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE";

export function csvOf(rows: { currency: string; date: string; rate: string }[]): string {
  const lines = rows.map(
    (r) =>
      `EXR.D.${r.currency}.EUR.SP00.A,D,${r.currency},EUR,SP00,A,${r.date},${r.rate},A,"ECB reference rate, ${r.currency}/EUR"`,
  );
  return [CSV_HEAD, ...lines].join("\n") + "\n";
}

export interface EcbCall {
  url: URL;
  init: RequestInit | undefined;
}

export interface FakeEcb {
  /** key `${currency}|${date}` -> rate */
  data: Map<string, string>;
  calls: EcbCall[];
  /** Overrides the answer (default: the data filtered by startPeriod, as text/csv). */
  respond: ((call: EcbCall) => Response | Promise<Response>) | null;
  restore: () => void;
  set: (currency: string, date: string, rate: string) => void;
  /** All TARGET working days from..to (inclusive) for the currencies, rate = base + day index. */
  fill: (currencies: Record<string, number>, from: string, to: string) => void;
}

export function stubEcb(): FakeEcb {
  const fake: FakeEcb = {
    data: new Map(),
    calls: [],
    respond: null,
    restore: () => spy.mockRestore(),
    set: (currency, date, rate) => fake.data.set(`${currency}|${date}`, rate),
    fill: (currencies, from, to) => {
      let i = 0;
      for (let d = from; d <= to; d = addDaysIso(d, 1)) {
        if (!isTargetWorkingDay(d)) continue;
        i++;
        for (const [c, base] of Object.entries(currencies)) {
          fake.set(c, d, (base + (i % 50) / 10000).toFixed(4));
        }
      }
    },
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: EcbCall = { url: new URL(raw), init };
    if (call.url.host !== "data-api.ecb.europa.eu")
      throw new Error(`unexpected fetch ${call.url.host}`);
    fake.calls.push(call);
    if (fake.respond) return fake.respond(call);
    const start = call.url.searchParams.get("startPeriod") ?? "0000-00-00";
    const rows = [...fake.data.entries()]
      .map(([k, rate]) => {
        const [currency, date] = k.split("|") as [string, string];
        return { currency, date, rate };
      })
      .filter((r) => r.date >= start)
      .sort((a, b) => (a.currency + a.date).localeCompare(b.currency + b.date));
    return new Response(csvOf(rows), {
      status: 200,
      headers: { "content-type": "text/csv; charset=utf-8" },
    });
  });
  return fake;
}

export function csvResponse(
  text: string,
  status = 200,
  type = "text/csv; charset=utf-8",
): Response {
  return new Response(text, { status, headers: { "content-type": type } });
}

/** audit_log is append-only: tests compare audit counts before and after instead of clearing it. */
export async function resetFx(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM fx_rates"),
    db.prepare(
      `UPDATE fx_import_state SET last_attempt_at = NULL, last_success_at = NULL, last_status = NULL,
         last_error_code = NULL, newest_rate_date = NULL, rows_inserted = 0`,
    ),
  ]);
}

export function ctxAt(
  slotIso: string,
  o: {
    now?: number;
    attempt?: number;
    trigger?: JobContext["trigger"];
    signal?: AbortSignal;
  } = {},
): JobContext {
  const slot = Date.parse(slotIso);
  const now = o.now ?? slot;
  return {
    env,
    job: { id: 1, name: "ecb.fx_import", handler: "ecb.fx_import", exactBudget: 0 },
    run: {
      id: 1,
      attempt: o.attempt ?? 1,
      scheduledFor: new Date(slot).toISOString(),
      requestedBy: o.trigger === "manual" ? "admin@camelthorncapital.com" : "system",
    },
    trigger: o.trigger ?? "schedule",
    budget: 0,
    deadlineMs: now + 13 * 60_000,
    signal: o.signal ?? new AbortController().signal,
    log: () => undefined,
    now: () => now,
  };
}

export async function fxRows(): Promise<{ currency: string; rate_date: string; rate: string }[]> {
  return (
    await db
      .prepare("SELECT currency, rate_date, rate FROM fx_rates ORDER BY rate_date, currency")
      .all<{ currency: string; rate_date: string; rate: string }>()
  ).results;
}

export async function auditOf(
  action: string,
): Promise<{ entity_id: string | null; after_json: string | null }[]> {
  return (
    await db
      .prepare("SELECT entity_id, after_json FROM audit_log WHERE action = ?1 ORDER BY id")
      .bind(action)
      .all<{ entity_id: string | null; after_json: string | null }>()
  ).results;
}
