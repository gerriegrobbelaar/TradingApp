import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { decryptToken, encryptToken } from "../src/crypto/token-crypto";
import type { ExactGate } from "../src/exact/gate";
import { getExactGate } from "../src/exact/gate-transport";
import { aad } from "../src/exact/store";
import type { ExactRequest } from "@camelthorn/exact";

export const db = env.DB;
const KEYS = [env.TOKEN_ENC_KEY];

export interface ApiCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface ExactStub {
  tokenCalls: URLSearchParams[];
  apiCalls: ApiCall[];
  /** Answer for POST /api/oauth2/token. Default: rotate to acc-N / ref-N. */
  token: (form: URLSearchParams, n: number) => Response | Promise<Response>;
  /** Answer for API calls. Default: 200 {"d":{"results":[]}}. */
  api: (call: ApiCall, n: number) => Response | Promise<Response>;
  restore: () => void;
}

export const tokenOk = (n: number): Response =>
  Response.json({
    access_token: `acc-${n}`,
    refresh_token: `ref-${n}`,
    token_type: "bearer",
    expires_in: "600",
  });

export function stubExact(): ExactStub {
  const stub: ExactStub = {
    tokenCalls: [],
    apiCalls: [],
    token: (_f, n) => tokenOk(n),
    api: () => Response.json({ d: { results: [] } }),
    restore: () => undefined,
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.host !== "start.exactonline.nl") throw new Error(`unexpected fetch ${url.host}`);
    if (url.pathname === "/api/oauth2/token") {
      const form = new URLSearchParams(String(init?.body));
      stub.tokenCalls.push(form);
      return stub.token(form, stub.tokenCalls.length);
    }
    const call: ApiCall = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    stub.apiCalls.push(call);
    return stub.api(call, stub.apiCalls.length);
  });
  stub.restore = () => spy.mockRestore();
  return stub;
}

/** Wipes Exact-related rows (audit_log is append-only and left alone). */
export async function resetExact(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM user_prefs"),
    db.prepare("DELETE FROM sync_locks"),
    db.prepare("DELETE FROM sync_state"),
    db.prepare("DELETE FROM open_items"),
    db.prepare("DELETE FROM gl_balances"),
    db.prepare("DELETE FROM gl_budgets"),
    db.prepare("DELETE FROM gl_accounts"),
    db.prepare("DELETE FROM gl_sync_years"),
    db.prepare("DELETE FROM relation_bank_accounts"),
    db.prepare("DELETE FROM relations"),
    db.prepare("DELETE FROM divisions"),
    db.prepare("DELETE FROM exact_usage"),
    db.prepare("DELETE FROM connections"),
    db.prepare("DELETE FROM job_runs"),
    db.prepare("DELETE FROM jobs"),
    db.prepare("DELETE FROM settings WHERE key = 'seed.default_jobs'"),
    db.prepare("DELETE FROM settings WHERE key = 'exact.incremental_open_items'"),
    db.prepare("DELETE FROM idempotency_keys WHERE scope = 'exact.flow'"),
  ]);
}

export async function seedConnection(
  opts: {
    status?: string;
    access?: string;
    refresh?: string;
    expiresInMs?: number;
  } = {},
): Promise<number> {
  const r = await db
    .prepare("INSERT INTO connections (kind, name, status) VALUES ('exact', 'exact', 'pending')")
    .run();
  const id = r.meta.last_row_id;
  const key = env.TOKEN_ENC_KEY;
  await db
    .prepare(
      `UPDATE connections SET status = ?2, access_token_enc = ?3, refresh_token_enc = ?4, expires_at = ?5,
         connected_by = 'gerrie@camelthorncapital.com' WHERE id = ?1`,
    )
    .bind(
      id,
      opts.status ?? "active",
      await encryptToken(key, opts.access ?? "acc-0", aad(id, "access")),
      await encryptToken(key, opts.refresh ?? "ref-0", aad(id, "refresh")),
      new Date(Date.now() + (opts.expiresInMs ?? 3600_000)).toISOString(),
    )
    .run();
  return id;
}

export async function storedTokens(id: number): Promise<{
  access: string | null;
  refresh: string | null;
  status: string;
  lastError: string | null;
}> {
  const row = await db
    .prepare(
      "SELECT status, access_token_enc, refresh_token_enc, last_error FROM connections WHERE id = ?1",
    )
    .bind(id)
    .first<{
      status: string;
      access_token_enc: string | null;
      refresh_token_enc: string | null;
      last_error: string | null;
    }>();
  if (!row) throw new Error("no connection");
  return {
    status: row.status,
    lastError: row.last_error,
    access: row.access_token_enc
      ? await decryptToken(KEYS, row.access_token_enc, aad(id, "access"))
      : null,
    refresh: row.refresh_token_enc
      ? await decryptToken(KEYS, row.refresh_token_enc, aad(id, "refresh"))
      : null,
  };
}

let nextDivision = 700_000;
export const freshDivision = (): number => ++nextDivision;

export const gateStub = (name: string): DurableObjectStub<ExactGate> => getExactGate(env, name);

export interface FakeClock {
  t: number;
  sleeps: number[];
}

/** Gives the division gate a controllable clock whose sleeps just advance time. */
export async function fakeClock(name: string): Promise<FakeClock> {
  const clock: FakeClock = { t: Date.now(), sleeps: [] };
  await runInDurableObject(gateStub(name), (gate: ExactGate) => {
    gate.now = () => clock.t;
    gate.sleep = async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    };
    gate.limits.flushIntervalMs = 0;
  });
  return clock;
}

export const req = (division: number, over: Partial<ExactRequest> = {}): ExactRequest => ({
  method: "GET",
  path: "/crm/Accounts",
  division,
  priority: "user",
  jobId: "test",
  api: "rest",
  ...over,
});

export async function auditActions(action: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1")
    .bind(action)
    .first<{ n: number }>();
  return r?.n ?? 0;
}
