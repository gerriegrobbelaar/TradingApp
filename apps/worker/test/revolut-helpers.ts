import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import type { RevolutRequest } from "@camelthorn/revolut";
import { decryptToken, encryptToken } from "../src/crypto/token-crypto";
import type { RevolutGate } from "../src/revolut/gate";
import { getRevolutGate } from "../src/revolut/gate-transport";
import { aad } from "../src/revolut/store";

export const db = env.DB;
const KEYS = [env.TOKEN_ENC_KEY];

export interface ApiCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface RevolutStub {
  tokenCalls: URLSearchParams[];
  apiCalls: ApiCall[];
  /** Hosts the stub accepts; any other host fails the test (SSRF check). */
  hosts: Set<string>;
  /** Answer for POST /api/1.0/auth/token. Default: a refresh without rotation. */
  token: (form: URLSearchParams, n: number) => Response | Promise<Response>;
  /** Answer for API calls. Default: 200 []. */
  api: (call: ApiCall, n: number) => Response | Promise<Response>;
  restore: () => void;
}

/** A refresh answer: new access token, no new refresh token (the documented behaviour, assumed). */
export const refreshOk = (n: number): Response =>
  Response.json({ access_token: `racc-${n}`, token_type: "bearer", expires_in: 2400 });

/** An answer that also rotates the refresh token. */
export const rotatedOk = (n: number): Response =>
  Response.json({
    access_token: `racc-${n}`,
    refresh_token: `rref-${n}`,
    token_type: "bearer",
    expires_in: 2400,
  });

export function stubRevolut(): RevolutStub {
  const stub: RevolutStub = {
    tokenCalls: [],
    apiCalls: [],
    hosts: new Set(["b2b.revolut.com"]),
    token: (_f, n) => refreshOk(n),
    api: () => Response.json([]),
    restore: () => undefined,
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (!stub.hosts.has(url.host)) throw new Error(`unexpected fetch ${url.host}`);
    if (url.pathname === "/api/1.0/auth/token") {
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

/** Wipes Revolut-related rows (audit_log is append-only and left alone). */
export async function resetRevolut(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM webhook_events"),
    db.prepare("DELETE FROM match_suggestions"),
    db.prepare("DELETE FROM matches"),
    db.prepare("DELETE FROM bank_transactions"),
    db.prepare("DELETE FROM bank_accounts"),
    db.prepare("DELETE FROM connections WHERE kind = 'revolut'"),
    db.prepare("DELETE FROM idempotency_keys WHERE scope = 'revolut.flow'"),
  ]);
}

export async function seedRevolut(
  opts: {
    status?: string;
    access?: string;
    refresh?: string;
    expiresInMs?: number;
    environment?: string;
    createsBankEntries?: boolean;
    paymentsMode?: string;
    webhookId?: string;
    /** Staging window of a 'pending' row (default: 15 minutes from now). */
    pendingUntilMs?: number;
  } = {},
): Promise<number> {
  const r = await db
    .prepare(
      "INSERT INTO connections (kind, name, status, creates_bank_entries) VALUES ('revolut', 'revolut', 'pending', 0)",
    )
    .run();
  const id = r.meta.last_row_id;
  const key = env.TOKEN_ENC_KEY;
  await db
    .prepare(
      `UPDATE connections SET status = ?2, access_token_enc = ?3, refresh_token_enc = ?4, expires_at = ?5,
         revolut_environment = ?6, creates_bank_entries = ?7, payments_mode = ?8,
         bank_entries_decided_at = '2026-01-01T00:00:00.000Z', webhook_id = ?9,
         pending_until = ?10, pending_ref = ?11,
         connected_by = 'gerrie.grobbelaar@camelthorncapital.com' WHERE id = ?1`,
    )
    .bind(
      id,
      opts.status ?? "active",
      await encryptToken(key, opts.access ?? "racc-0", aad(id, "access")),
      await encryptToken(key, opts.refresh ?? "rref-0", aad(id, "refresh")),
      new Date(Date.now() + (opts.expiresInMs ?? 3600_000)).toISOString(),
      opts.environment ?? "production",
      opts.createsBankEntries ? 1 : 0,
      opts.paymentsMode ?? "drafts",
      opts.webhookId ?? null,
      opts.status === "pending"
        ? new Date(Date.now() + (opts.pendingUntilMs ?? 15 * 60_000)).toISOString()
        : null,
      opts.status === "pending" ? "test-ref" : null,
    )
    .run();
  return id;
}

export async function storedRevolut(id: number): Promise<{
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

export const revolutGate = (id: number): DurableObjectStub<RevolutGate> => getRevolutGate(env, id);

export interface FakeClock {
  t: number;
  sleeps: number[];
}

/** Gives the gate a controllable clock whose sleeps just advance time. */
export async function fakeRevolutClock(id: number): Promise<FakeClock> {
  const clock: FakeClock = { t: Date.now(), sleeps: [] };
  await runInDurableObject(revolutGate(id), (gate: RevolutGate) => {
    gate.now = () => clock.t;
    gate.sleep = async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    };
  });
  return clock;
}

export const rreq = (id: number, over: Partial<RevolutRequest> = {}): RevolutRequest => ({
  method: "GET",
  path: "/accounts",
  connectionId: id,
  priority: "user",
  jobId: "test",
  ...over,
});

export async function auditActions(action: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1")
    .bind(action)
    .first<{ n: number }>();
  return r?.n ?? 0;
}
