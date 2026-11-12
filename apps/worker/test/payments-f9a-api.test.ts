/**
 * F9a (ADR 0052), the routes:
 *
 *  S1   POST /api/payments/:id/alert/ack (finance, admin; audited), alert columns for the DQ rules
 *  S3   the provisional (sandbox-only) verification mark for the staging drill
 *  S7   Preview payment never hashes or audits the counterparty body
 *  S11  the settings PATCH compare-and-swap compares with the value the patch was computed on
 *  N6   changing the draft expiry needs a fresh sign-in
 */
import {
  PAYMENTS_ENABLE_PHRASE,
  PAYMENTS_VERIFY_CHECKS,
  PAYMENTS_VERIFY_PHRASE,
  sha256Hex,
} from "@camelthorn/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { paymentBodyMismatch } from "../src/payments/gate-request";
import { paymentWritesOpen } from "../src/payments/gate-flag";
import { setSubmitterForTests } from "../src/payments/submit";
import { addSession } from "./helpers";
import {
  anotherBill,
  db,
  execWorld,
  onEnv,
  readyBatch,
  readyPayment,
  rowOf,
  type ExecWorld,
} from "./payments-exec-helpers";
import { setSetting } from "./matching-helpers";
import { SUPPLIER_IBAN } from "./payments-helpers";
import { revolutGate, rreq } from "./revolut-helpers";

type Who = keyof ExecWorld["tokens"];
let w: ExecWorld;
let e: Env = onEnv();
let auditFrom = 0;

beforeEach(async () => {
  w = await execWorld({ mode: "drafts" });
  e = onEnv();
  auditFrom =
    (await db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM audit_log").first<{ n: number }>())
      ?.n ?? 0;
});
afterEach(() => {
  setSubmitterForTests(null);
  w.fake.restore();
});

async function api<T = Record<string, unknown>>(
  who: Who,
  method: string,
  path: string,
  json?: unknown,
  opts: { token?: string; env?: Env } = {},
) {
  const res = await worker.fetch(
    new Request(`https://app.test${path}`, {
      method,
      headers: {
        cookie: `__Host-session=${opts.token ?? w.tokens[who]}`,
        "x-requested-with": "fetch",
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    }),
    opts.env ?? e,
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as T, text };
}
const stale = async (email: string): Promise<string> =>
  addSession(
    (await db.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first<{ id: number }>())
      ?.id as number,
    { lastAuthAgoMs: 20 * 60_000 },
  );
const audits = async (
  like: string,
): Promise<{ action: string; actor_email: string; after_json: string | null }[]> =>
  (
    await db
      .prepare(
        "SELECT action, actor_email, after_json FROM audit_log WHERE action LIKE ?1 AND id > ?2 ORDER BY id",
      )
      .bind(like, auditFrom)
      .all<{ action: string; actor_email: string; after_json: string | null }>()
  ).results;

async function raise(kind: "payment" | "batch", id: number, alertKind = "mismatch"): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO payment_reconcile (subject_kind, subject_id, first_checked_at, last_checked_at, last_result, alert_at, alert_kind)
       VALUES (?1, ?2, ?3, ?3, 'mismatch', ?3, ?4)`,
    )
    .bind(kind, id, now, alertKind)
    .run();
}

// ---- S1 -------------------------------------------------------------------------------------------

describe("S1: POST /api/payments/:id/alert/ack", () => {
  it("is for finance and admin only", async () => {
    const id = await readyPayment(w);
    await raise("payment", id);
    for (const who of ["viewer", "approver"] as const) {
      expect((await api(who, "POST", `/api/payments/${id}/alert/ack`, {})).status, who).toBe(403);
    }
    expect((await api("finance", "POST", `/api/payments/${id}/alert/ack`, {})).status).toBe(200);
  });

  it("records who and when, audited under the user's email; moves nothing", async () => {
    const id = await readyPayment(w);
    await raise("payment", id, "draft_gone");
    const before = await rowOf(id);
    const r = await api<{ acknowledged: boolean; alertKind: string }>(
      "admin",
      "POST",
      `/api/payments/${id}/alert/ack`,
      { note: "Looked in the Revolut app" },
    );
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ acknowledged: true, alertKind: "draft_gone" });
    expect(
      await db
        .prepare("SELECT alert_ack_by FROM payment_reconcile WHERE subject_id = ?1")
        .bind(id)
        .first(),
    ).toMatchObject({
      alert_ack_by: w.emails.admin,
    });
    expect(await rowOf(id)).toEqual(before);
    const a = await audits("payment.alert_acknowledged");
    expect(a).toHaveLength(1);
    expect(a[0]?.actor_email).toBe(w.emails.admin);
    expect(a[0]?.after_json).toContain("Looked in the Revolut app");
  });

  it("answers 404 for an unknown payment, 409 when there is no alert or it was acknowledged already", async () => {
    const id = await readyPayment(w);
    expect((await api("finance", "POST", "/api/payments/999999/alert/ack", {})).status).toBe(404);
    const none = await api("finance", "POST", `/api/payments/${id}/alert/ack`, {});
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ error: "no_alert" });
    await raise("payment", id);
    expect((await api("finance", "POST", `/api/payments/${id}/alert/ack`, {})).status).toBe(200);
    const again = await api("admin", "POST", `/api/payments/${id}/alert/ack`, {});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "already_acknowledged" });
    expect((await audits("payment.alert_acknowledged")).length).toBe(1);
  });

  it("works for a batch under /api/payment-batches, and rejects an unknown body key or a bad note", async () => {
    const batch = await readyBatch(w, [w.itemId, await anotherBill(w)]);
    await raise("batch", batch, "approved_after_expiry");
    expect(
      (await api("finance", "POST", `/api/payment-batches/${batch}/alert/ack`, { x: 1 })).status,
    ).toBe(400);
    expect(
      (await api("finance", "POST", `/api/payment-batches/${batch}/alert/ack`, { note: "" }))
        .status,
    ).toBe(400);
    const ok = await api("finance", "POST", `/api/payment-batches/${batch}/alert/ack`, {});
    expect(ok.status, ok.text).toBe(200);
    expect((await audits("payment_batch.alert_acknowledged")).length).toBe(1);
  });

  it("the alert state is plain columns a rule can read: open = alert_at set and alert_ack_at null", async () => {
    const id = await readyPayment(w);
    await raise("payment", id);
    const open = () =>
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM payment_reconcile WHERE alert_at IS NOT NULL AND alert_ack_at IS NULL AND subject_id = ?1",
        )
        .bind(id)
        .first<{ n: number }>();
    expect((await open())?.n).toBe(1);
    await api("finance", "POST", `/api/payments/${id}/alert/ack`, {});
    expect((await open())?.n).toBe(0);
  });
});

// ---- S7 -------------------------------------------------------------------------------------------

describe("S7: Preview payment does not hash the counterparty body", () => {
  it("the counterparty step has no hash, its IBAN is masked, and the audit row carries only the payment hash", async () => {
    const id = await readyPayment(w);
    const r = await api<{
      calls: { step: string; body: string; sha256: string | null }[];
    }>("admin", "POST", "/api/payments/preview", { kind: "payment", id });
    expect(r.status, r.text).toBe(200);
    const cp = r.body.calls.find((c) => c.step === "counterparty");
    const draft = r.body.calls.find((c) => c.step === "draft");
    expect(cp?.sha256).toBeNull();
    expect(cp?.body).not.toContain(SUPPLIER_IBAN);
    expect(r.text).not.toContain(SUPPLIER_IBAN);
    expect(draft?.sha256).toBe(sha256Hex(draft?.body ?? ""));
    const a = await audits("payment.previewed");
    const row = a.at(-1)?.after_json ?? "";
    expect(row).toContain(draft?.sha256 ?? "never");
    expect(JSON.parse(row).hashes.map((h: { step: string }) => h.step)).toEqual(["draft"]);
    // nowhere a hash of the counterparty body, keyed or not: the unkeyed one would be brute-forceable
    const unkeyed = sha256Hex(
      `{"company_name":"Acme Supplies B.V.","bank_country":"NL","currency":"EUR","iban":"${SUPPLIER_IBAN}"}`,
    );
    expect(r.text).not.toContain(unkeyed);
    expect(row).not.toContain(unkeyed);
  });
});

// ---- S11 ------------------------------------------------------------------------------------------

/** A D1 whose first write of the payments settings is preceded by somebody else's write. */
function racingDb(beforeWrite: () => Promise<void>): D1Database {
  const sqlOf = new WeakMap<object, string>();
  const rawOf = new WeakMap<object, D1PreparedStatement>();
  let fired = false;
  const wrap = (raw: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p = new Proxy(raw, {
      get(t, k) {
        if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a), sql);
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    sqlOf.set(p, sql);
    rawOf.set(p, raw);
    return p;
  };
  return new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
      if (k === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const isPatch = stmts.some((x) => /INSERT INTO settings/.test(sqlOf.get(x) ?? ""));
          if (isPatch && !fired) {
            fired = true;
            await beforeWrite();
          }
          return t.batch(stmts.map((x) => rawOf.get(x) ?? x));
        };
      }
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
}

describe("S11: the settings PATCH is a compare-and-swap against what the patch was computed on", () => {
  const stored = async (): Promise<string | null> =>
    (
      await db
        .prepare("SELECT value_json FROM settings WHERE key = 'payments.settings'")
        .first<{ value_json: string }>()
    )?.value_json ?? null;

  it("somebody else changed the settings between the read and the write: 409 conflict, their value stays", async () => {
    await setSetting("payments.settings", { fourEyesLimitMinor: 200_000 });
    const race = {
      ...e,
      DB: racingDb(async () => setSetting("payments.settings", { fourEyesLimitMinor: 50_000 })),
    };
    const r = await api(
      "admin",
      "PATCH",
      "/api/settings/payments",
      { fourEyesLimitMinor: 100_000 },
      { env: race as Env },
    );
    expect(r.status, r.text).toBe(409);
    expect(r.body).toMatchObject({ error: "conflict" });
    expect(JSON.parse((await stored()) ?? "{}")).toEqual({ fourEyesLimitMinor: 50_000 });
    expect(await audits("payments.settings_changed")).toHaveLength(0);
  });

  it("also when nothing was stored at the read and somebody stored settings before the write", async () => {
    await db.prepare("DELETE FROM settings WHERE key = 'payments.settings'").run();
    const race = {
      ...e,
      DB: racingDb(async () => setSetting("payments.settings", { allowPartial: false })),
    };
    const r = await api(
      "admin",
      "PATCH",
      "/api/settings/payments",
      { fourEyesLimitMinor: 100_000 },
      { env: race as Env },
    );
    expect(r.status, r.text).toBe(409);
    expect(JSON.parse((await stored()) ?? "{}")).toEqual({ allowPartial: false });
  });

  it("control: without a race the patch is written once, audited, and a second patch builds on it", async () => {
    await setSetting("payments.settings", { fourEyesLimitMinor: 200_000 });
    expect(
      (await api("admin", "PATCH", "/api/settings/payments", { fourEyesLimitMinor: 100_000 }))
        .status,
    ).toBe(200);
    expect(JSON.parse((await stored()) ?? "{}").fourEyesLimitMinor).toBe(100_000);
    expect(
      (await api("admin", "PATCH", "/api/settings/payments", { fourEyesLimitMinor: 90_000 }))
        .status,
    ).toBe(200);
    expect(JSON.parse((await stored()) ?? "{}").fourEyesLimitMinor).toBe(90_000);
    expect(await audits("payments.settings_changed")).toHaveLength(2);
    // nothing stored at all: the first patch creates the row
    await db.prepare("DELETE FROM settings WHERE key = 'payments.settings'").run();
    expect(
      (await api("admin", "PATCH", "/api/settings/payments", { fourEyesLimitMinor: 80_000 }))
        .status,
    ).toBe(200);
    expect(JSON.parse((await stored()) ?? "{}").fourEyesLimitMinor).toBe(80_000);
  });
});

// ---- N6 -------------------------------------------------------------------------------------------

describe("N6: the draft expiry needs a fresh sign-in", () => {
  it("a session older than 15 minutes is asked to sign in again; a fresh one changes it, audited", async () => {
    const old = await api(
      "admin",
      "PUT",
      "/api/settings/payments/draft-expiry",
      { days: 3 },
      { token: await stale(w.emails.admin) },
    );
    expect(old.status).toBe(401);
    expect(await audits("payments.draft_expiry_changed")).toHaveLength(0);
    expect(
      (await api("finance", "PUT", "/api/settings/payments/draft-expiry", { days: 3 })).status,
    ).toBe(403);
    expect(
      (await api("admin", "PUT", "/api/settings/payments/draft-expiry", { days: 3 })).status,
    ).toBe(200);
    expect(await audits("payments.draft_expiry_changed")).toHaveLength(1);
  });
});

// ---- S3: the provisional (sandbox) mark ------------------------------------------------------------

describe("S3: the provisional verification mark for the staging drill", () => {
  const body = (checks: string[], note = "Sandbox drill, pass one of two") => ({
    confirm: PAYMENTS_VERIFY_PHRASE,
    checks,
    note,
    provisional: true,
  });
  const mark = async () =>
    JSON.parse(
      (
        await db
          .prepare("SELECT value_json FROM settings WHERE key = 'payments.verified'")
          .first<{ value_json: string }>()
      )?.value_json ?? "null",
    ) as { provisional?: boolean; checks: string[] } | null;
  const setEnv = (env: "sandbox" | "production") =>
    db
      .prepare("UPDATE connections SET revolut_environment = ?2 WHERE id = ?1")
      .bind(w.revolutConnectionId, env)
      .run();

  it("is refused where money could move: the deploy var is off, or the connection is production (or unknown)", async () => {
    await setEnv("sandbox");
    const off = await api("admin", "POST", "/api/settings/payments/verify", body([]), {
      env: { ...e, REVOLUT_PAYMENTS_EXECUTION: "off" } as Env,
    });
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ error: "provisional_not_allowed" });
    for (const env of ["production"] as const) {
      await setEnv(env);
      const r = await api("admin", "POST", "/api/settings/payments/verify", body([]));
      expect(r.body, env).toMatchObject({ error: "provisional_not_allowed" });
    }
    await db
      .prepare("UPDATE connections SET revolut_environment = NULL WHERE id = ?1")
      .bind(w.revolutConnectionId)
      .run();
    expect((await api("admin", "POST", "/api/settings/payments/verify", body([]))).status).toBe(
      409,
    );
    expect((await mark())?.provisional).not.toBe(true);
  });

  it("on the sandbox it takes any subset of known checks, switches payments OFF, and is audited as provisional", async () => {
    await setEnv("sandbox");
    const r = await api<{
      verifiedProvisional: boolean;
      enabled: boolean;
      verified: { checks: string[] };
    }>(
      "admin",
      "POST",
      "/api/settings/payments/verify",
      body(["revolut_plan_known", "amount_format_probe"]),
    );
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ verifiedProvisional: true, enabled: false });
    expect(r.body.verified.checks).toEqual(["revolut_plan_known", "amount_format_probe"]);
    expect((await audits("payments.verified_provisional")).length).toBe(1);
    expect(await audits("payments.verified")).toHaveLength(0);
    // bad lists: unknown code, duplicate, non-string
    for (const checks of [["nope"], ["revolut_plan_known", "revolut_plan_known"], [1]]) {
      const bad = await api(
        "admin",
        "POST",
        "/api/settings/payments/verify",
        body(checks as string[]),
      );
      expect(bad.body, JSON.stringify(checks)).toMatchObject({ error: "bad_checks" });
    }
    // it needs the fresh sign-in and the phrase like any verification
    expect(
      (
        await api("admin", "POST", "/api/settings/payments/verify", body([]), {
          token: await stale(w.emails.admin),
        })
      ).status,
    ).toBe(401);
    expect(
      (await api("admin", "POST", "/api/settings/payments/verify", { ...body([]), confirm: "yes" }))
        .status,
    ).toBe(400);
  });

  it("with it the drill works on the sandbox: switch on, a draft goes out, and a payment body is checked", async () => {
    await setEnv("sandbox");
    w.fake.stub.hosts.add("sandbox-b2b.revolut.com"); // the sandbox connection talks to the sandbox host
    await api("admin", "POST", "/api/settings/payments/verify", body([]));
    const on = await api("admin", "PUT", "/api/settings/payments/switch", {
      enabled: true,
      confirm: PAYMENTS_ENABLE_PHRASE,
    });
    expect(on.status, on.text).toBe(200);
    const id = await readyPayment(w);
    const sent = await api<{ result: { to: string } }>(
      "finance",
      "POST",
      `/api/payments/${id}/submit`,
    );
    expect(sent.status, sent.text).toBe(200);
    expect(sent.body.result.to, JSON.stringify(await rowOf(id))).toBe("submitted");
    expect(w.fake.calls("POST", "/payment-drafts")).toHaveLength(1);
  });

  it("the same mark opens NOTHING once a connection is production: settings, submit and the gate all say not verified", async () => {
    await setEnv("sandbox");
    await api("admin", "POST", "/api/settings/payments/verify", body([]));
    expect(
      (
        await api("admin", "PUT", "/api/settings/payments/switch", {
          enabled: true,
          confirm: PAYMENTS_ENABLE_PHRASE,
        })
      ).status,
    ).toBe(200);
    const id = await readyPayment(w);
    await setEnv("production"); // the connection was switched to the real bank
    const view = await api<{ blockers: string[]; verified: unknown; verifiedProvisional: boolean }>(
      "admin",
      "GET",
      "/api/settings/payments",
    );
    expect(view.body.blockers).toContain("not_verified");
    expect(view.body.verified).toBeNull();
    expect(view.body.verifiedProvisional).toBe(false);
    // the gate reads D1 itself and refuses
    expect(await paymentWritesOpen({ DB: db, REVOLUT_PAYMENTS_EXECUTION: "on" })).toEqual({
      open: false,
      reason: "not_verified",
    });
    const lease = await revolutGate(w.revolutConnectionId).acquirePaymentLease(
      w.revolutConnectionId,
      "t",
    );
    expect(lease).toMatchObject({ ok: false, code: "payments_not_verified" });
    // the route
    const sent = await api("finance", "POST", `/api/payments/${id}/submit`);
    expect(sent.status).toBe(409);
    expect(w.fake.calls("POST", "/payment-drafts")).toHaveLength(0);
    // and the switch cannot be turned on again against production with a provisional mark
    await db
      .prepare("UPDATE settings SET value_json = 'false' WHERE key = 'payments.enabled'")
      .run();
    const again = await api("admin", "PUT", "/api/settings/payments/switch", {
      enabled: true,
      confirm: PAYMENTS_ENABLE_PHRASE,
    });
    expect(again.status).toBe(409);
    expect(
      await db.prepare("SELECT value_json FROM settings WHERE key = 'payments.enabled'").first(),
    ).toMatchObject({ value_json: "false" });
  });

  it("even the enabling SQL refuses a provisional mark against a production connection (blockers bypassed)", async () => {
    await setEnv("sandbox");
    await api("admin", "POST", "/api/settings/payments/verify", body([]));
    await db
      .prepare("UPDATE settings SET value_json = 'false' WHERE key = 'payments.enabled'")
      .run();
    await setEnv("production");
    // the state reads as not verified, so the route refuses; the SQL guard is the second fence
    const r = await api("admin", "PUT", "/api/settings/payments/switch", {
      enabled: true,
      confirm: PAYMENTS_ENABLE_PHRASE,
    });
    expect(r.status).toBe(409);
  });

  it("a COMPLETE verification replaces a provisional one: no flag, payments off, covers the modes by its list", async () => {
    await setEnv("sandbox");
    await api("admin", "POST", "/api/settings/payments/verify", body([]));
    const full = await api<{ verifiedProvisional: boolean }>(
      "admin",
      "POST",
      "/api/settings/payments/verify",
      {
        confirm: PAYMENTS_VERIFY_PHRASE,
        checks: [...PAYMENTS_VERIFY_CHECKS],
        note: "Both passes done, all checks ticked",
      },
    );
    expect(full.status, full.text).toBe(200);
    expect(full.body.verifiedProvisional).toBe(false);
    expect((await mark())?.provisional).toBeUndefined();
    // an incomplete list WITHOUT the flag is still refused
    const part = await api("admin", "POST", "/api/settings/payments/verify", {
      confirm: PAYMENTS_VERIFY_PHRASE,
      checks: ["revolut_plan_known"],
      note: "Not everything is done yet",
    });
    expect(part.body).toMatchObject({ error: "checks_incomplete" });
  });

  it("a stored mark with provisional set but junk checks is no mark at all", async () => {
    await setEnv("sandbox");
    await setSetting("payments.verified", {
      at: "2026-07-01T00:00:00.000Z",
      by: "a@camelthorncapital.com",
      note: "n",
      protocolVersion: (await import("../src/payments/protocol-version")).paymentsProtocolVersion(),
      checks: ["not_a_check"],
      provisional: true,
    });
    expect(await paymentWritesOpen({ DB: db, REVOLUT_PAYMENTS_EXECUTION: "on" })).toEqual({
      open: false,
      reason: "not_verified",
    });
  });
});

// ---- N7 at the pure level ---------------------------------------------------------------------------

describe("N7: the pure body check", () => {
  const req = (path: string, body: string, ref: string) =>
    rreq(w.revolutConnectionId, {
      method: "POST",
      path,
      body,
      jobId: "revolut-payment",
      paymentRef: ref,
      headers: { "Content-Type": "application/json" },
    });
  it("a body that is not JSON, and a path it does not judge", async () => {
    expect(await paymentBodyMismatch(db, req("/pay", "nope", "x"))).toBe("payment_body_unreadable");
    expect(await paymentBodyMismatch(db, req("/pay", "[]", "x"))).toBe("payment_body_unreadable");
    expect(await paymentBodyMismatch(db, req("/counterparty", "{}", "cp-x"))).toBeNull();
    expect(await paymentBodyMismatch(db, req("/payment-drafts", "{}", "x"))).toBe(
      "payment_unknown_request",
    );
  });
});
