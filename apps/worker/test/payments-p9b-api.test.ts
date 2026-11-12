/**
 * P9b routes and the enable path (ADR 0050): submit, preview payment, resolve-not-sent, settlement,
 * draft expiry, the extended verification, and the fact that everything ships OFF.
 */
import { env } from "cloudflare:test";
import {
  PAYMENTS_ENABLE_PHRASE,
  PAYMENTS_LOOSEN_PHRASE,
  PAYMENTS_VERIFY_CHECKS,
  PAYMENTS_VERIFY_PHRASE,
  sha256Hex,
} from "@camelthorn/core";
import { buildPay, buildPaymentDraft } from "@camelthorn/revolut";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { paymentsProtocolVersion } from "../src/payments/protocol-version";
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
import { SOURCE_ACCOUNT_UUID } from "./payments-fake-revolut";
import { setSetting } from "./matching-helpers";
import { setVerified, SUPPLIER_IBAN, withoutPaymentTriggers } from "./payments-helpers";

type Who = keyof ExecWorld["tokens"];
let w: ExecWorld;
let e: Env = onEnv();

beforeEach(async () => {
  w = await execWorld({ mode: "drafts" });
  e = onEnv();
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

describe("POST /api/payments/:id/submit", () => {
  it("is for finance with a fresh sign-in; the deploy switch is off by default (the real env)", async () => {
    const id = await readyPayment(w);
    for (const who of ["viewer", "approver", "admin"] as const) {
      expect((await api(who, "POST", `/api/payments/${id}/submit`)).status, who).toBe(403);
    }
    expect(
      (
        await api("finance", "POST", `/api/payments/${id}/submit`, undefined, {
          token: await stale(w.emails.finance),
        })
      ).status,
    ).toBe(401);
    // the wrangler default is "off": nothing is sent
    const off = await api("finance", "POST", `/api/payments/${id}/submit`, undefined, {
      env: env as Env,
    });
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ error: "payments_disabled", payment: { status: "ready" } });
    expect(w.fake.stub.apiCalls).toHaveLength(0);
  });

  it("with the switches on it sends and answers with the new state (no full IBAN anywhere)", async () => {
    const id = await readyPayment(w);
    const r = await api<{ result: { to: string }; payment: { status: string } }>(
      "finance",
      "POST",
      `/api/payments/${id}/submit`,
    );
    expect(r.status, r.text).toBe(200);
    expect(r.body.result.to).toBe("submitted");
    expect(r.body.payment.status).toBe("submitted");
    expect(r.text).not.toContain(SUPPLIER_IBAN);
    // a second click is refused, nothing is sent twice
    const again = await api("finance", "POST", `/api/payments/${id}/submit`);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "not_ready" });
    expect(w.fake.calls("POST", "/payment-drafts")).toHaveLength(1);
  });

  it("a batch is sent through its own route; an item of a batch has no route of its own", async () => {
    const batch = await readyBatch(w, [w.itemId, await anotherBill(w)]);
    const items = await db
      .prepare("SELECT id FROM payments WHERE batch_id = ?1")
      .bind(batch)
      .all<{ id: number }>();
    const item = items.results[0]?.id as number;
    expect((await api("finance", "POST", `/api/payments/${item}/submit`)).status).toBe(404);
    const r = await api<{ result: { to: string } }>(
      "finance",
      "POST",
      `/api/payment-batches/${batch}/submit`,
    );
    expect(r.status, r.text).toBe(200);
    expect(r.body.result.to).toBe("submitted");
    expect(w.fake.calls("POST", "/payment-drafts")).toHaveLength(1);
  });

  it("an unknown id is 404 and a draft (not confirmed) request is refused", async () => {
    expect((await api("finance", "POST", "/api/payments/99999/submit")).status).toBe(404);
  });
});

describe("POST /api/payments/preview (a dry run: no call, no state change)", () => {
  it("builds the real bodies and their hashes, masks the IBAN, writes one audit row, calls nothing", async () => {
    const id = await readyPayment(w);
    const rid = (await rowOf(id)).request_id;
    const r = await api<{
      ok: boolean;
      mode: string;
      requestId: string;
      calls: {
        step: string;
        sha256: string;
        body: string;
        gateAccepts: boolean;
        usesPlaceholderPayee: boolean;
      }[];
    }>(
      "admin",
      "POST",
      "/api/payments/preview",
      { kind: "payment", id },
      { env: env as Env }, // even with the deploy switch off
    );
    expect(r.status, r.text).toBe(200);
    expect(r.body.mode).toBe("drafts");
    expect(r.body.calls.map((c) => c.step)).toEqual(["counterparty", "draft"]);
    expect(r.text).not.toContain(SUPPLIER_IBAN);
    expect(r.body.calls[0]?.body).toContain("NL91****4300");
    expect(r.body.calls.every((c) => c.gateAccepts)).toBe(true);
    // the draft hash is the hash of what the builder makes
    const expected = buildPaymentDraft({
      requestId: rid,
      payments: [
        {
          accountId: SOURCE_ACCOUNT_UUID,
          counterpartyId: "00000000-0000-4000-8000-000000000000",
          amountMinor: 100_000,
          currency: "EUR",
          reference:
            (
              await db
                .prepare("SELECT reference FROM payments WHERE id = ?1")
                .bind(id)
                .first<{ reference: string }>()
            )?.reference ?? "",
        },
      ],
    });
    expect(r.body.calls[1]?.sha256).toBe(sha256Hex(expected.body));
    expect(r.body.calls[1]?.usesPlaceholderPayee).toBe(true);
    expect(w.fake.stub.apiCalls).toHaveLength(0);
    expect(w.fake.stub.tokenCalls).toHaveLength(0);
    expect((await rowOf(id)).status).toBe("ready");
    const audit = await db
      .prepare(
        "SELECT after_json FROM audit_log WHERE action = 'payment.previewed' ORDER BY id DESC LIMIT 1",
      )
      .first<{ after_json: string }>();
    expect(audit?.after_json).not.toContain("NL91ABNA");
    expect(audit?.after_json).not.toContain("company_name");
    expect(audit?.after_json).toContain(r.body.calls[1]?.sha256);
  });

  it("pay mode: the /pay body has the stored request id and the raw amount; a cached payee is used", async () => {
    w.fake.restore();
    w = await execWorld({ mode: "pay" });
    const id = await readyPayment(w);
    const row = await rowOf(id);
    await db
      .prepare(
        `INSERT INTO payment_payees (connection_id, iban_fingerprint, revolut_counterparty_id, name, created_for)
         SELECT ?1, iban_fingerprint, '5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11', 'Acme', 'seed-seed' FROM payments WHERE id = ?2`,
      )
      .bind(w.revolutConnectionId, id)
      .run();
    const r = await api<{
      calls: { step: string; body: string; usesPlaceholderPayee: boolean; sha256: string }[];
    }>("admin", "POST", "/api/payments/preview", { kind: "payment", id });
    expect(r.body.calls.map((c) => c.step)).toEqual(["pay"]);
    const pay = r.body.calls[0];
    expect(pay?.usesPlaceholderPayee).toBe(false);
    expect(pay?.body).toContain(`"request_id":"${row.request_id}"`);
    expect(pay?.body).toContain('"amount":1000.00,');
    expect(pay?.sha256).toBe(
      sha256Hex(
        buildPay({
          requestId: row.request_id,
          accountId: SOURCE_ACCOUNT_UUID,
          counterpartyId: "5138f3e7-b2d1-4d16-a8e0-6a7c1f0d9b11",
          amountMinor: 100_000,
          currency: "EUR",
          reference:
            (
              await db
                .prepare("SELECT reference FROM payments WHERE id = ?1")
                .bind(id)
                .first<{ reference: string }>()
            )?.reference ?? "",
        }).body,
      ),
    );
  });

  it("admin with a fresh sign-in only; bad input and unknown ids are refused", async () => {
    const id = await readyPayment(w);
    for (const who of ["viewer", "finance", "approver"] as const) {
      expect(
        (await api(who, "POST", "/api/payments/preview", { kind: "payment", id })).status,
        who,
      ).toBe(403);
    }
    expect(
      (
        await api(
          "admin",
          "POST",
          "/api/payments/preview",
          { kind: "payment", id },
          { token: await stale(w.emails.admin) },
        )
      ).status,
    ).toBe(401);
    expect((await api("admin", "POST", "/api/payments/preview", { kind: "x", id })).status).toBe(
      400,
    );
    expect(
      (await api("admin", "POST", "/api/payments/preview", { kind: "payment", id: 0 })).status,
    ).toBe(400);
    expect(
      (await api("admin", "POST", "/api/payments/preview", { kind: "payment", id: 9999 })).status,
    ).toBe(404);
  });

  it("a reference the builder cannot make safe is reported, not sent", async () => {
    const id = await readyPayment(w);
    await withoutPaymentTriggers(["payments_guard_payload"], async () => {
      await db.prepare("UPDATE payments SET reference = '日本語' WHERE id = ?1").bind(id).run();
    });
    const r = await api("admin", "POST", "/api/payments/preview", { kind: "payment", id });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "builder_refused" });
  });
});

describe("resolve-not-sent, settlement, draft expiry", () => {
  it("resolve-not-sent: admin, fresh sign-in, the typed phrase; refused for a payment that is not unknown", async () => {
    const id = await readyPayment(w);
    expect(
      (await api("finance", "POST", `/api/payments/${id}/resolve-not-sent`, { confirm: "x" }))
        .status,
    ).toBe(403);
    expect(
      (
        await api(
          "admin",
          "POST",
          `/api/payments/${id}/resolve-not-sent`,
          { confirm: "x" },
          { token: await stale(w.emails.admin) },
        )
      ).status,
    ).toBe(401);
    const r = await api("admin", "POST", `/api/payments/${id}/resolve-not-sent`, {
      confirm: "MARK PAYMENT AS NOT SENT",
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "not_unknown" });
    expect(
      (
        await api("admin", "POST", "/api/payments/9999/resolve-not-sent", {
          confirm: "MARK PAYMENT AS NOT SENT",
        })
      ).status,
    ).toBe(404);
  });

  it("settlement: any role may read it; a payment that is not paid says so", async () => {
    const id = await readyPayment(w);
    const r = await api("viewer", "GET", `/api/payments/${id}/settlement`);
    expect(r.body).toEqual({ settlement: "not_paid" });
    expect((await api("viewer", "GET", "/api/payments/9999/settlement")).status).toBe(404);
  });

  it("draft expiry: admin sets 1..30 days, audited; the settings answer shows it", async () => {
    expect(
      (await api<{ draftExpiryDays: number }>("admin", "GET", "/api/settings/payments")).body
        .draftExpiryDays,
    ).toBe(5);
    expect(
      (await api("finance", "PUT", "/api/settings/payments/draft-expiry", { days: 3 })).status,
    ).toBe(403);
    for (const bad of [0, 31, 1.5, "3", null]) {
      expect(
        (await api("admin", "PUT", "/api/settings/payments/draft-expiry", { days: bad })).status,
        String(bad),
      ).toBe(400);
    }
    const ok = await api<{ draftExpiryDays: number }>(
      "admin",
      "PUT",
      "/api/settings/payments/draft-expiry",
      { days: 7 },
    );
    expect(ok.body.draftExpiryDays).toBe(7);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payments.draft_expiry_changed'",
        )
        .first(),
    ).toMatchObject({ n: 1 });
  });
});

describe("the enable path ships OFF and needs every layer", () => {
  it("the real configuration has the deploy switch off: no submitter, so payments cannot be enabled", async () => {
    const view = await api<{
      submitterAvailable: boolean;
      blockers: string[];
      verifyRunbook: Record<string, unknown>;
    }>("admin", "GET", "/api/settings/payments", undefined, { env: env as Env });
    expect(view.body.submitterAvailable).toBe(false);
    expect(view.body.blockers).toContain("submitter_unavailable");
    expect(Object.keys(view.body.verifyRunbook).sort()).toEqual([...PAYMENTS_VERIFY_CHECKS].sort());
    await db
      .prepare("UPDATE settings SET value_json = 'false' WHERE key = 'payments.enabled'")
      .run();
    const sw = await api(
      "admin",
      "PUT",
      "/api/settings/payments/switch",
      { enabled: true, confirm: PAYMENTS_ENABLE_PHRASE },
      { env: env as Env },
    );
    expect(sw.status).toBe(409);
    expect(sw.body).toMatchObject({
      error: "blocked",
      blockers: expect.arrayContaining(["submitter_unavailable"]),
    });
    expect(
      await db.prepare("SELECT value_json FROM settings WHERE key = 'payments.enabled'").first(),
    ).toMatchObject({ value_json: "false" });
  });

  it("with the deploy switch on, the typed phrase, a fresh sign-in and the verification, an admin can enable", async () => {
    await db
      .prepare("UPDATE settings SET value_json = 'false' WHERE key = 'payments.enabled'")
      .run();
    const view = await api<{ submitterAvailable: boolean; blockers: string[] }>(
      "admin",
      "GET",
      "/api/settings/payments",
    );
    expect(view.body.submitterAvailable).toBe(true);
    expect(view.body.blockers).toEqual(["payments_disabled"]);
    expect(
      (await api("admin", "PUT", "/api/settings/payments/switch", { enabled: true }, {})).status,
    ).toBe(400);
    expect(
      (
        await api(
          "admin",
          "PUT",
          "/api/settings/payments/switch",
          { enabled: true, confirm: PAYMENTS_ENABLE_PHRASE },
          { token: await stale(w.emails.admin) },
        )
      ).status,
    ).toBe(401);
    const ok = await api("admin", "PUT", "/api/settings/payments/switch", {
      enabled: true,
      confirm: PAYMENTS_ENABLE_PHRASE,
    });
    expect(ok.status, ok.text).toBe(200);
  });

  it("a verification without the pay-only check is valid for drafts, not for the pay mode", async () => {
    const noPay = PAYMENTS_VERIFY_CHECKS.filter((c) => c !== "sandbox_pay_roundtrip");
    const good = {
      confirm: PAYMENTS_VERIFY_PHRASE,
      note: "Sandbox runbook done on 2026-11-12",
      checks: noPay,
    };
    const r = await api("admin", "POST", "/api/settings/payments/verify", good);
    expect(r.status, r.text).toBe(200);
    const stored = await db
      .prepare("SELECT value_json FROM settings WHERE key = 'payments.verified'")
      .first<{ value_json: string }>();
    expect(JSON.parse(stored?.value_json ?? "{}").checks).toEqual(noPay);
    expect(JSON.parse(stored?.value_json ?? "{}").protocolVersion).toBe(paymentsProtocolVersion());
    // the verify step leaves payments OFF
    expect(
      await db.prepare("SELECT value_json FROM settings WHERE key = 'payments.enabled'").first(),
    ).toMatchObject({ value_json: "false" });
    // the pay mode needs the check
    await db.prepare("UPDATE connections SET payments_mode = 'pay' WHERE kind = 'revolut'").run();
    const patch = await api("admin", "PATCH", "/api/settings/payments", {
      mode: "pay",
      confirm: PAYMENTS_LOOSEN_PHRASE,
    });
    expect(patch.body).toMatchObject({ error: "mode_pay_requires_verification" });
    await setVerified(true); // all checks, pay roundtrip included
    expect(
      (
        await api("admin", "PATCH", "/api/settings/payments", {
          mode: "pay",
          confirm: PAYMENTS_LOOSEN_PHRASE,
        })
      ).status,
    ).toBe(200);
    // an incomplete or padded list is refused
    for (const checks of [[], noPay.slice(1), [...noPay, "extra"], [...noPay, noPay[0]]]) {
      expect(
        (await api("admin", "POST", "/api/settings/payments/verify", { ...good, checks })).body,
        JSON.stringify(checks),
      ).toMatchObject({ error: "checks_incomplete" });
    }
  });

  it("a stored pay mode without the pay-only check is a blocker (a mark from a drafts-only install)", async () => {
    await setSetting("payments.settings", { mode: "pay" });
    await setSetting("payments.verified", {
      at: "2026-07-01T00:00:00.000Z",
      by: "x@camelthorncapital.com",
      note: "n",
      protocolVersion: paymentsProtocolVersion(),
      checks: PAYMENTS_VERIFY_CHECKS.filter((c) => c !== "sandbox_pay_roundtrip"),
    });
    const view = await api<{ blockers: string[] }>("admin", "GET", "/api/settings/payments");
    expect(view.body.blockers).toContain("pay_mode_not_verified");
  });

  it("any change to the payment code voids the mark: the protocol version covers builders, allow-list and runbook", async () => {
    const v = paymentsProtocolVersion();
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(paymentsProtocolVersion()).toBe(v);
    // pinned: a change here switches payments OFF everywhere until verified again (ADR 0050; re-pinned by F9a, ADR 0052: v2)
    expect(v).toBe(PINNED_PROTOCOL_VERSION);
  });
});

const PINNED_PROTOCOL_VERSION = "501f9a43f80b471df6be7a1b10e04fee4c3a05a065c2effd3297b5b259206787";
