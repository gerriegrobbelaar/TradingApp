/**
 * Fixtures for the Phase 5 review Q1 tests: raw API rows (bad rows, rich legs), a counterparty
 * endpoint, and a wrapper that adds them to the shared fake Revolut API without changing it.
 */
import { env } from "cloudflare:test";
import type { JobContext } from "../src/jobs/types";
import { runRevolutBackfill, runRevolutSync } from "../src/revolut/sync";
import type { ApiCall } from "./revolut-helpers";
import { ACC_EUR, type FakeRevolut } from "./revolut-r3-helpers";

export type RawRow = Record<string, unknown>;

export const rawLeg = (legId: string, over: RawRow = {}): RawRow => ({
  leg_id: legId,
  account_id: ACC_EUR,
  amount: -25.5,
  currency: "EUR",
  counterparty: { id: "cp-1", account_type: "external", account_id: "cpa-1", name: "Acme B.V." },
  ...over,
});

export const rawTx = (
  id: string,
  createdAt: string,
  legs: RawRow[] = [rawLeg(`${id}-l1`)],
  over: RawRow = {},
): RawRow => ({
  id,
  type: "transfer",
  request_id: `req-${id}`,
  state: "completed",
  created_at: createdAt,
  updated_at: createdAt,
  completed_at: createdAt,
  reference: "Invoice 2026001",
  legs,
  ...over,
});

export interface RawApi {
  /** Extra rows served by /transactions (and by /transaction/{id} when `byId` has the id). */
  rows: RawRow[];
  /** Counterparty answers: a record, or an HTTP status for an error. */
  counterparties: Map<string, RawRow | number>;
  /** Paths of every /counterparty/ call, in order. */
  counterpartyCalls: string[];
  /** Job ids seen on the counterparty calls come from the gate; here only the paths. */
  handle: (c: ApiCall) => Promise<Response>;
}

/** Wraps a FakeRevolut: raw rows are merged into the transaction list; counterparties are served. */
export function rawApi(base: FakeRevolut): RawApi {
  const api: RawApi = {
    rows: [],
    counterparties: new Map(),
    counterpartyCalls: [],
    handle: async (c) => {
      const path = c.url.pathname;
      const cp = /^\/api\/1\.0\/counterparty\/(.+)$/.exec(path);
      if (cp) {
        const id = decodeURIComponent(cp[1] as string);
        api.counterpartyCalls.push(id);
        const v = api.counterparties.get(id);
        if (v === undefined) return Response.json({ message: "not found" }, { status: 404 });
        if (typeof v === "number") {
          return Response.json({ message: "no NL91ABNA0417164300" }, { status: v });
        }
        return Response.json(v);
      }
      const one = /^\/api\/1\.0\/transaction\/(.+)$/.exec(path);
      if (one) {
        const id = decodeURIComponent(one[1] as string);
        const raw = api.rows.find((r) => r["id"] === id);
        if (raw) return Response.json(raw);
        return base.handle(c);
      }
      if (path === "/api/1.0/transactions") {
        const res = base.handle(c);
        if (!res.ok) return res;
        const baseRows = (await res.json()) as RawRow[];
        const q = c.url.searchParams;
        const from = q.get("from");
        const to = q.get("to");
        const ms = (v: unknown): number => Date.parse(String(v));
        const inWindow = api.rows.filter((r) => {
          const t = ms(r["created_at"]);
          // A zone-less timestamp parses as local time; keep such rows in every window.
          return (
            Number.isNaN(t) || ((from === null || t >= ms(from)) && (to === null || t <= ms(to)))
          );
        });
        const merged = [...baseRows, ...inWindow].sort(
          (a, b) => (ms(b["created_at"]) || 0) - (ms(a["created_at"]) || 0),
        );
        return Response.json(merged.slice(0, Number(q.get("count") ?? "100")));
      }
      return base.handle(c);
    },
  };
  return api;
}

/** A counterparty record as Revolut sends it (shape assumed, ADR 0030). */
export const cpRecord = (
  id: string,
  accounts: { id?: string; iban?: string; currency?: string }[],
  name = "Acme B.V.",
): RawRow => ({
  id,
  name,
  profile_type: "business",
  state: "created",
  accounts: accounts.map((a) => ({ type: "revolut", ...a })),
});

export const HOUR = 3_600_000;
export const ago = (hours: number, from = Date.now()): string =>
  new Date(from - hours * HOUR).toISOString();

export function ctxFor(handler: string, over: Partial<JobContext> = {}): JobContext {
  const t = Date.now();
  return {
    env,
    job: { id: 1, name: handler, handler, exactBudget: 0 },
    run: { id: 1, attempt: 1, scheduledFor: new Date(t).toISOString(), requestedBy: "system" },
    trigger: "schedule",
    budget: 0,
    deadlineMs: t + 10 * 60_000,
    signal: new AbortController().signal,
    log: () => undefined,
    now: () => Date.now(),
    ...over,
  };
}

export const sync = (over: Partial<JobContext> = {}) =>
  runRevolutSync(ctxFor("revolut.sync", over));
export const backfill = (over: Partial<JobContext> = {}) =>
  runRevolutBackfill(ctxFor("revolut.backfill", over));

/** A context whose clock is `offsetMs` ahead of the real one (retry waits are in hours). */
export const later = (offsetMs: number): Partial<JobContext> => ({
  now: () => Date.now() + offsetMs,
  deadlineMs: Date.now() + offsetMs + 10 * 60_000,
});
