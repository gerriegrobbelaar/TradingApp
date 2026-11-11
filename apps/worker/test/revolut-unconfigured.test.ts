/**
 * Revolut is optional as a whole (review S5): a deployment with none of the Revolut settings must
 * stay sane. Routes answer server_misconfigured (never throw), the connections list reports
 * revolutConfigured: false, the jobs skip with revolut_not_configured without touching the
 * database or the network, and the Exact side is unaffected.
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

  it("the other Revolut routes answer with JSON errors and never throw", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/connections/revolut/callback?code=x&state=y"],
      [
        "POST",
        "/api/connections/revolut/confirm",
        { createsBankEntries: false, paymentsMode: "drafts" },
      ],
      ["POST", "/api/connections/revolut/webhook/register"],
      ["POST", "/api/connections/revolut/disconnect"],
      ["PATCH", "/api/connections/revolut/settings", { paymentsMode: "drafts" }],
    ];
    const statuses: string[] = [];
    for (const [method, path, body] of calls) {
      const res = await req(method, path, body);
      expect(res.status, `${method} ${path}`).toBeLessThan(500 + 1);
      statuses.push(`${method} ${res.status}`);
      // A body that is JSON or a redirect, never an unhandled exception page.
      if (res.status !== 302) expect(res.headers.get("content-type")).toMatch(/json/);
    }
    expect(statuses).toHaveLength(calls.length);
  });

  it("the webhook route does not accept anything without a connection", async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/webhooks/revolut`, { method: "POST", body: "{}" }),
      unconfigured,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
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
      const r = await run?.(ctx(name));
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
