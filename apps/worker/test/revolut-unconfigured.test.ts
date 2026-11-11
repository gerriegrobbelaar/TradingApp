/**
 * Revolut is optional as a whole (review S5): a deployment with none of the Revolut settings must
 * stay sane. The admin routes answer a JSON error (start and callback: 500 server_misconfigured;
 * disconnect stays a working no-op), the webhook endpoint answers the same uniform 401 as on a
 * configured deployment, the bank API answers available: false, the connections list reports
 * revolutConfigured: false, and the jobs skip with revolut_not_configured without logging, touching
 * the database or the network.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { HANDLERS, whenRevolutConfigured } from "../src/jobs/handlers";
import type { JobContext } from "../src/jobs/types";
import { addSession, addUser, db, ORIGIN, resetDb } from "./helpers";
import { resetRevolut } from "./revolut-helpers";

const ADMIN = "gerrie.grobbelaar@camelthorncapital.com";
const BLANK = {
  REVOLUT_CLIENT_ID: "",
  REVOLUT_REDIRECT_URI: "",
  REVOLUT_ISSUER: "",
  REVOLUT_PRIVATE_KEY: "",
};
const unconfigured = { ...env, ...BLANK };

let adminTok: string;

beforeEach(async () => {
  await resetDb();
  await resetRevolut();
  adminTok = await addSession(await addUser(ADMIN, ["admin"]));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const req = (method: string, path: string, body?: unknown) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie: `__Host-session=${adminTok}`,
        "x-requested-with": "fetch",
        origin: ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    unconfigured,
  );

describe("Revolut routes without Revolut settings", () => {
  it("start answers 500 server_misconfigured (names only in the log)", async () => {
    const res = await req(
      "GET",
      "/api/connections/revolut/start?environment=production&creates_bank_entries=0&payments_mode=drafts",
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("the other Revolut routes answer with a defined status and a JSON body, never a crash", async () => {
    const calls: [string, string, number, unknown?][] = [
      ["GET", "/api/connections/revolut/callback?code=x&state=y", 500],
      [
        "POST",
        "/api/connections/revolut/confirm",
        400,
        { createsBankEntries: false, paymentsMode: "drafts" },
      ],
      ["POST", "/api/connections/revolut/webhook/register", 400],
      // Disconnect must keep working (to clean up after the settings were removed): a no-op.
      ["POST", "/api/connections/revolut/disconnect", 200],
      ["PATCH", "/api/connections/revolut/settings", 404, { paymentsMode: "drafts" }],
    ];
    const seen: string[] = [];
    for (const [method, path, , body] of calls) {
      const res = await req(method, path, body);
      seen.push(`${method} ${path.split("?")[0]} ${res.status}`);
      expect(res.headers.get("content-type"), `${method} ${path}`).toMatch(/json/);
      const b = (await res.json()) as { error?: string; ok?: boolean };
      // An error code, or (disconnect, which must work to clean up) a plain no-op answer.
      expect(typeof b.error === "string" || b.ok === true, `${method} ${path}`).toBe(true);
    }
    expect(seen).toEqual(calls.map(([m, p, st]) => `${m} ${p.split("?")[0]} ${st}`));
  });

  it("the webhook endpoint answers the uniform 401, identical to any unsigned delivery", async () => {
    const hit = (e: typeof env) =>
      worker.fetch(
        new Request(`${ORIGIN}/api/webhooks/revolut`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "revolut-request-timestamp": String(Date.now()),
            "revolut-signature": "v1=00",
          },
          body: '{"event":"TransactionCreated","data":{"id":"x"}}',
        }),
        e,
      );
    const off = await hit(unconfigured);
    const on = await hit(env);
    expect(off.status).toBe(401);
    expect(on.status).toBe(401);
    // Nothing about the configuration leaks: same body, same headers as a configured deployment.
    expect(await off.text()).toBe(await on.text());
    expect([...off.headers.entries()]).toEqual([...on.headers.entries()]);
    // Nothing was recorded.
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM webhook_events").first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it("the bank API says there is no Revolut data instead of failing", async () => {
    const accounts = await req("GET", "/api/bank/accounts");
    expect(accounts.status).toBe(200);
    expect(await accounts.json()).toMatchObject({
      connection: null,
      accounts: [],
      available: false,
    });
    const txs = await req("GET", "/api/bank/transactions");
    expect(txs.status).toBe(200);
    expect(await txs.json()).toMatchObject({ items: [], total: 0, available: false });
    expect((await req("GET", "/api/bank/transactions/1")).status).toBe(404);
  });

  it("the connections list says Revolut is not configured, and still answers", async () => {
    const res = await req("GET", "/api/connections");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revolutConfigured: boolean; connections: unknown[] };
    expect(body.revolutConfigured).toBe(false);
    expect(body.connections).toEqual([]);
  });
});

describe("Revolut jobs without Revolut settings", () => {
  const ctx = (handler: string): JobContext => {
    const t = Date.now();
    return {
      env: unconfigured,
      job: { id: 1, name: handler, handler, exactBudget: 0 },
      run: { id: 1, attempt: 1, scheduledFor: new Date(t).toISOString(), requestedBy: "system" },
      trigger: "schedule",
      budget: 0,
      deadlineMs: t + 60_000,
      signal: new AbortController().signal,
      log: () => undefined,
      now: () => Date.now(),
    };
  };

  it.each(["revolut.sync", "revolut.backfill"])(
    "%s is skipped with revolut_not_configured and writes nothing",
    async (name) => {
      const before = await db
        .prepare("SELECT COUNT(*) AS n FROM revolut_sync_state")
        .first<{ n: number }>();
      const run = HANDLERS[name]?.run;
      expect(run).toBeDefined();
      const errors = vi.spyOn(console, "error");
      const warns = vi.spyOn(console, "warn");
      const r = await run?.(ctx(name));
      // A skip is a normal outcome on a deployment without Revolut: no error or warning lines.
      expect(errors).not.toHaveBeenCalled();
      expect(warns).not.toHaveBeenCalled();
      expect(r?.status).toBe("skipped");
      expect(r?.code).toBe("revolut_not_configured");
      // Names of the missing settings, never values.
      expect(JSON.stringify(r?.summary)).toContain("REVOLUT_CLIENT_ID");
      expect(JSON.stringify(r?.summary)).not.toContain("PRIVATE KEY");
      const after = await db
        .prepare("SELECT COUNT(*) AS n FROM revolut_sync_state")
        .first<{ n: number }>();
      expect(after?.n).toBe(before?.n);
    },
  );

  it("whitespace-only or non-string settings count as not configured, without throwing", async () => {
    const wrapped = whenRevolutConfigured(async () => ({ status: "ok", summary: {} }));
    const blank = await wrapped({
      ...ctx("revolut.sync"),
      env: { ...env, REVOLUT_CLIENT_ID: "   ", REVOLUT_ISSUER: "\t" },
    });
    expect(blank.code).toBe("revolut_not_configured");
    expect(blank.summary).toEqual({
      missing: ["REVOLUT_CLIENT_ID", "REVOLUT_ISSUER"],
    });
    const odd = await wrapped({
      ...ctx("revolut.sync"),
      env: { ...env, REVOLUT_CLIENT_ID: 42 as unknown as string },
    });
    expect(odd.code).toBe("revolut_not_configured");
    expect(JSON.stringify(odd.summary)).toContain("REVOLUT_CLIENT_ID");
  });

  it("an unreadable app origin counts as not configured", async () => {
    let ran = false;
    const wrapped = whenRevolutConfigured(async () => {
      ran = true;
      return { status: "ok", summary: {} };
    });
    const r = await wrapped({
      ...ctx("revolut.sync"),
      env: { ...env, OAUTH_REDIRECT_URI: "nope" },
    });
    expect(r.code).toBe("revolut_not_configured");
    expect(ran).toBe(false);
  });

  it("runs the real handler when the settings are complete", async () => {
    let ran = false;
    const wrapped = whenRevolutConfigured(async () => {
      ran = true;
      return { status: "ok", summary: {} };
    });
    const r = await wrapped({ ...ctx("revolut.sync"), env });
    expect(r.status).toBe("ok");
    expect(ran).toBe(true);
  });
});
