/**
 * The payments API (P9a, ADR 0049): requests, confirmation, four-eyes, cancel, lists. NOTHING sends
 * money: the fetch spy proves no outbound call is made by any route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentConfirmPhrase } from "@camelthorn/core";
import { addSession, addUser, authed, call } from "./helpers";
import {
  addBill,
  db,
  OTHER_IBAN,
  payWorld,
  putPaymentSettings,
  setMappingVerified,
  setSwitch,
  setVerified,
  SUPPLIER_IBAN,
  type PayWorld,
} from "./payments-helpers";

type Who = keyof PayWorld["tokens"];
let w: PayWorld;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let auditFloor = 0;

beforeEach(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  w = await payWorld();
  auditFloor =
    (await db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM audit_log").first<{ n: number }>())
      ?.n ?? 0;
});
afterEach(() => {
  // No route may talk to the outside: not Revolut, not Exact, nothing.
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

async function send<T = Record<string, unknown>>(
  who: Who,
  method: string,
  path: string,
  json?: unknown,
  token?: string,
): Promise<{ status: number; body: T; text: string }> {
  const res = await authed(path, token ?? w.tokens[who], {
    method,
    ...(json !== undefined ? { json } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as T, text };
}

interface Payment {
  id: number;
  status: string;
  payloadHash: string;
  approvalsRequired: string[];
  confirmPhrase: string | null;
  ibanMasked: string;
  amountMinor: number;
  reference: string;
  requestedBy: string;
}
const KEY = (n: number | string): string => `test-key-${n}-0123456789`;

async function create(
  o: { item?: number; amount?: number; key?: string; who?: Who } = {},
): Promise<{
  status: number;
  body: {
    payment?: Payment;
    blocks?: string[];
    error?: string;
    warnings?: string[];
    replayed?: boolean;
  };
  text: string;
}> {
  return send(o.who ?? "finance", "POST", "/api/payments", {
    openItemId: o.item ?? w.itemId,
    sourceAccountId: w.accountId,
    ...(o.amount !== undefined ? { amountMinor: o.amount } : {}),
    clientKey: o.key ?? KEY(Math.random()),
  });
}

async function created(o: Parameters<typeof create>[0] = {}): Promise<Payment> {
  const r = await create(o);
  expect(r.status, r.text).toBe(201);
  return r.body.payment as Payment;
}

async function confirm(p: Payment, who: Who = "finance", token?: string) {
  return send<{ payment?: Payment; error?: string }>(
    who,
    "POST",
    `/api/payments/${p.id}/confirm`,
    { confirm: paymentConfirmPhrase(p.amountMinor, "EUR", "4300") },
    token,
  );
}
const approve = (p: Payment, who: Who = "approver", hash = p.payloadHash, token?: string) =>
  send<{ payment?: Payment; error?: string }>(
    who,
    "POST",
    `/api/payments/${p.id}/approve`,
    { payloadHash: hash },
    token,
  );

const statusOf = async (id: number): Promise<string> =>
  (
    await db
      .prepare("SELECT status FROM payments WHERE id = ?1")
      .bind(id)
      .first<{ status: string }>()
  )?.status ?? "";
const count = async (table: string): Promise<number> =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;
const audits = async (like = "payment%"): Promise<string[]> =>
  (
    await db
      .prepare("SELECT action FROM audit_log WHERE action LIKE ?1 AND id > ?2 ORDER BY id")
      .bind(like, auditFloor)
      .all<{ action: string }>()
  ).results.map((r) => r.action);

describe("who may do what", () => {
  it("is default-deny: no session 401, no CSRF header 403, wrong role 403", async () => {
    expect((await call("/api/payments")).status).toBe(401);
    const noHeader = await call("/api/payments", {
      method: "POST",
      headers: { cookie: `__Host-session=${w.tokens.finance}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(noHeader.status).toBe(403);
    for (const who of ["viewer", "approver", "admin"] as const) {
      expect((await create({ who })).status, who).toBe(403);
    }
    const p = await created();
    expect((await confirm(p, "viewer")).status).toBe(403);
    expect(
      (
        await send("finance", "POST", `/api/payments/${p.id}/approve`, {
          payloadHash: p.payloadHash,
        })
      ).status,
    ).toBe(403);
    expect((await send("viewer", "GET", "/api/payments")).status).toBe(200);
  });

  it("lists and reads for every role, without full IBANs", async () => {
    const p = await created();
    for (const who of ["viewer", "finance", "approver", "admin"] as const) {
      const l = await send<{ items: Payment[]; nextCursor: string | null }>(
        who,
        "GET",
        "/api/payments",
      );
      expect(l.status).toBe(200);
      expect(l.body.items.map((i) => i.id)).toEqual([p.id]);
      expect(l.text).not.toContain(SUPPLIER_IBAN);
      const one = await send<{ payment: Payment }>(who, "GET", `/api/payments/${p.id}`);
      expect(one.text).not.toContain(SUPPLIER_IBAN);
      expect(one.body.payment.ibanMasked).toBe("NL91****4300");
    }
  });
});

describe("creating a request", () => {
  it("returns the confirmation sheet: supplier, masked IBAN, amount, reference, source account, approvals", async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.text).not.toContain(SUPPLIER_IBAN);
    const p = r.body.payment as Payment & Record<string, unknown>;
    expect(p).toMatchObject({
      status: "draft",
      kind: "payment",
      supplierName: "Acme Supplies B.V.",
      ibanMasked: "NL91****4300",
      amountMinor: 100_000,
      currency: "EUR",
      reference: expect.stringMatching(/^Invoice INV-/) as string,
      sourceAccountId: w.accountId,
      sourceAccountName: "Main EUR",
      mode: "drafts",
      approvalsRequired: ["new_or_changed_iban"],
      requestedBy: w.emails.finance,
      confirmPhrase: "PAY 1000.00 EUR TO 4300",
    });
    expect(p["payloadHash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(p["ibanFingerprintShort"]).toHaveLength(16);
    expect(await audits()).toEqual(["payment.created"]);
    const ev = await db.prepare("SELECT from_status, to_status, actor FROM payment_events").all();
    expect(ev.results).toEqual([
      { from_status: null, to_status: "draft", actor: w.emails.finance },
    ]);
  });

  it("blocks with every applicable code and writes nothing", async () => {
    await setSwitch(false);
    const off = await create();
    expect(off.status).toBe(422);
    expect(off.body.blocks).toEqual(["payments_disabled"]);
    await setSwitch(true);
    expect(await count("payments")).toBe(0);

    await setMappingVerified(false);
    expect((await create()).body.blocks).toEqual(["approval_mapping_unverified"]);
    await setMappingVerified(true);

    const pending = await addBill(w, { approved: false });
    expect((await create({ item: pending.itemId })).body.blocks).toEqual(["invoice_not_approved"]);

    expect(await count("payments")).toBe(0);
  });

  it("never trusts an IBAN that no approver confirmed, nor one that changed since", async () => {
    const bare = await payWorld({ verifyIban: false });
    w = bare;
    expect((await create()).body.blocks).toEqual(["iban_unverified"]);
    // an approver confirms THAT IBAN ...
    const st = await send<{ iban: { ibanFingerprint: string; state: string } }>(
      "approver",
      "GET",
      `/api/payments/ibans/${w.relationRowId}`,
    );
    expect(st.body.iban.state).toBe("unverified");
    const v = await send("approver", "POST", "/api/payments/ibans/verify", {
      relationId: w.relationRowId,
      fingerprint: st.body.iban.ibanFingerprint,
      lastFour: "4300",
    });
    expect(v.status, v.text).toBe(200);
    expect((await create()).status).toBe(201);
    // ... then Exact changes it: unverified again (changed)
    await db
      .prepare("UPDATE relations SET iban = ?2 WHERE id = ?1")
      .bind(w.relationRowId, OTHER_IBAN)
      .run();
    await db
      .prepare("UPDATE relation_bank_accounts SET iban = ?2 WHERE relation_id = ?1")
      .bind(w.relationRowId, OTHER_IBAN)
      .run();
    const other = await addBill(w);
    expect((await create({ item: other.itemId })).body.blocks).toEqual(["iban_changed"]);
  });

  it("refuses an IBAN read that is older than three days", async () => {
    await db
      .prepare("UPDATE relation_bank_accounts SET last_seen_at = ?2 WHERE relation_id = ?1")
      .bind(w.relationRowId, new Date(w.nowMs - 4 * 24 * 3600_000).toISOString())
      .run();
    expect((await create()).body.blocks).toEqual(["iban_cache_stale"]);
  });

  it("blocks a second request for the same invoice and a paid-but-not-yet-synced one", async () => {
    await created();
    const again = await create();
    expect(again.status).toBe(422);
    expect(again.body.blocks).toEqual(["already_in_request"]);
    expect(await count("payments")).toBe(1);
  });

  it("is idempotent per client key and refuses a key reused for another invoice", async () => {
    const k = KEY("fixed");
    const a = await create({ key: k });
    const b = await create({ key: k });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.payment?.id).toBe(a.body.payment?.id);
    expect(await count("payments")).toBe(1);
    const other = await addBill(w);
    const reuse = await create({ key: k, item: other.itemId });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error).toBe("client_key_reused");
    // another user may use the same key text
    expect(await count("payments")).toBe(1);
  });

  it("checks amounts: open balance by default, partial by setting, never floats or junk", async () => {
    expect((await create({ amount: 50_000 })).body.blocks).toEqual(["amount_not_open_balance"]);
    for (const bad of [0, -5, 1.5, "100" as unknown as number, null as unknown as number]) {
      const r = await create({ amount: bad });
      expect([400, 422], String(bad)).toContain(r.status);
    }
    expect((await create({ amount: 2 ** 53 })).status).toBe(400);
    await putPaymentSettings({ allowPartial: true });
    const p = await created({ amount: 50_000 });
    expect(p.amountMinor).toBe(50_000);
    expect(p.confirmPhrase).toBe("PAY 500.00 EUR TO 4300");
  });

  it("validates the body strictly", async () => {
    const bad: unknown[] = [
      {},
      { openItemId: "1", sourceAccountId: w.accountId, clientKey: KEY(1) },
      { openItemId: w.itemId, sourceAccountId: w.accountId, clientKey: "short" },
      { openItemId: w.itemId, sourceAccountId: w.accountId, clientKey: KEY(1), extra: 1 },
      { openItemId: 0, sourceAccountId: w.accountId, clientKey: KEY(1) },
    ];
    for (const b of bad)
      expect((await send("finance", "POST", "/api/payments", b)).status).toBe(400);
    const raw = await authed("/api/payments", w.tokens.finance, {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    expect(raw.status).toBe(400);
  });

  it("warns, but does not block, when the balance is low", async () => {
    await db
      .prepare("UPDATE bank_accounts SET balance_minor = 10 WHERE id = ?1")
      .bind(w.accountId)
      .run();
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.warnings).toContain("balance_below_amount");
    await putPaymentSettings({ blockOnInsufficientBalance: true });
    const other = await addBill(w);
    expect((await create({ item: other.itemId })).body.blocks).toEqual(["insufficient_balance"]);
  });

  it("does not put an unknown supplier, unknown account or foreign currency through", async () => {
    const r = await send("finance", "POST", "/api/payments", {
      openItemId: w.itemId,
      sourceAccountId: 9999,
      clientKey: KEY("x"),
    });
    expect(r.body).toMatchObject({ blocks: ["source_account_unknown"] });
    const usd = await addBill(w, { currency: "USD" });
    expect((await create({ item: usd.itemId })).body.blocks).toEqual([
      "currency_not_supported",
      "currency_mismatch_source",
      "no_eur_rate",
    ]);
    expect((await create({ item: 987654 })).body.blocks).toContain("payable_not_found");
  });
});

describe("confirming", () => {
  it("needs the typed phrase with the amount, from the requester, with a fresh sign-in", async () => {
    const p = await created();
    const wrong = await send("finance", "POST", `/api/payments/${p.id}/confirm`, {
      confirm: "PAY 1000.00 eur",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: "confirmation_required" });
    expect(
      (
        await send("finance", "POST", `/api/payments/${p.id}/confirm`, {
          confirm: "PAY 999.99 EUR",
        })
      ).status,
    ).toBe(400);
    expect((await send("finance", "POST", `/api/payments/${p.id}/confirm`, {})).status).toBe(400);

    const stale = await addSession(
      (
        await db
          .prepare("SELECT id FROM users WHERE email = ?1")
          .bind(w.emails.finance)
          .first<{ id: number }>()
      )?.id as number,
      { lastAuthAgoMs: 20 * 60_000 },
    );
    expect((await confirm(p, "finance", stale)).status).toBe(401);

    expect((await confirm(p, "finance2")).status).toBe(403); // somebody else's request
    expect(await statusOf(p.id)).toBe("draft");
  });

  it("moves to pending_approval when a second person is needed and NEVER sends", async () => {
    const p = await created();
    const c = await confirm(p);
    expect(c.status, c.text).toBe(200);
    expect(c.body.payment?.status).toBe("pending_approval");
    expect(await audits()).toEqual(["payment.created", "payment.confirmed"]);
    const row = await db
      .prepare("SELECT confirmed_at, requester_auth_at, status_reason FROM payments")
      .first<Record<string, string | null>>();
    expect(row?.["confirmed_at"]).toBeTruthy();
    expect(row?.["requester_auth_at"]).toBeTruthy();
    expect(row?.["status_reason"]).toBe("confirmed_needs_approval");
    // a second confirm is a conflict, not a second move
    expect((await confirm(p)).status).toBe(409);
  });

  it("goes straight to ready when nothing needs a second person", async () => {
    await putPaymentSettings({ requireApprovalForNewIban: false });
    const p = await created();
    expect(p.approvalsRequired).toEqual([]);
    const c = await confirm(p);
    expect(c.body.payment?.status).toBe("ready");
    expect(await count("payment_claims")).toBe(0);
  });

  it("re-checks on today's facts: a change since the sheet blocks the confirmation", async () => {
    const p = await created();
    await db.prepare("UPDATE open_items SET open_minor = 90000 WHERE id = ?1").bind(w.itemId).run();
    const c = await confirm(p);
    expect(c.status).toBe(422);
    expect(await statusOf(p.id)).toBe("draft");
    await db
      .prepare("UPDATE open_items SET open_minor = 100000 WHERE id = ?1")
      .bind(w.itemId)
      .run();
    await setSwitch(false);
    expect((await confirm(p)).status).toBe(422);
    await setSwitch(true);
    await setVerified(false);
    expect((await confirm(p)).status).toBe(422);
    await setVerified(true);
    expect((await confirm(p)).status).toBe(200);
  });

  it("refuses when the controls got stricter since the sheet (new reasons)", async () => {
    await putPaymentSettings({ requireApprovalForNewIban: false });
    const p = await created();
    await putPaymentSettings({ fourEyesLimitMinor: 50_000 });
    const c = await confirm(p);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("controls_changed");
  });
});

describe("four-eyes approval", () => {
  async function pending(): Promise<Payment> {
    const p = await created();
    expect((await confirm(p)).status).toBe(200);
    return p;
  }

  it("a different approver, with a fresh sign-in and the same payload, makes it ready", async () => {
    const p = await pending();
    const a = await approve(p);
    expect(a.status, a.text).toBe(200);
    expect(a.body.payment?.status).toBe("ready");
    expect(a.body.payment).toMatchObject({
      decision: { decision: "approved", by: w.emails.approver },
    });
    expect(await audits()).toEqual(["payment.created", "payment.confirmed", "payment.approved"]);
    const row = await db
      .prepare("SELECT decision, requested_by, decided_by, payload_hash FROM payment_approvals")
      .first<Record<string, string>>();
    expect(row).toMatchObject({
      decision: "approved",
      requested_by: w.emails.finance,
      decided_by: w.emails.approver,
      payload_hash: p.payloadHash,
    });
    // never sent: still no claim, no provider id
    expect(await count("payment_claims")).toBe(0);
    expect(await db.prepare("SELECT provider_id, submit_attempts FROM payments").first()).toEqual({
      provider_id: null,
      submit_attempts: 0,
    });
  });

  it("an approver can never approve their own request", async () => {
    // a user holding both roles requests and tries to approve
    const both = await addUser("both@camelthorncapital.com", ["finance", "approver"]);
    const token = await addSession(both);
    const r = await send(
      "finance",
      "POST",
      "/api/payments",
      { openItemId: w.itemId, sourceAccountId: w.accountId, clientKey: KEY("both") },
      token,
    );
    expect(r.status, r.text).toBe(201);
    const p = (r.body as unknown as { payment: Payment }).payment;
    expect((await confirm(p, "finance", token)).status).toBe(200);
    const self = await approve(p, "approver", p.payloadHash, token);
    expect(self.status).toBe(403);
    expect(self.body.error).toBe("self_approval");
    expect(await statusOf(p.id)).toBe("pending_approval");
    expect(await count("payment_approvals")).toBe(0);
    // ... and rejecting your own is refused the same way (use cancel)
    const rej = await send(
      "approver",
      "POST",
      `/api/payments/${p.id}/reject`,
      { payloadHash: p.payloadHash, note: "no thanks" },
      token,
    );
    expect(rej.status).toBe(403);
  });

  it("needs the approver role (admin and finance do not count) and a fresh sign-in", async () => {
    const p = await pending();
    expect((await approve(p, "admin")).status).toBe(403);
    expect((await approve(p, "finance2")).status).toBe(403);
    const id = (
      await db
        .prepare("SELECT id FROM users WHERE email = ?1")
        .bind(w.emails.approver)
        .first<{ id: number }>()
    )?.id as number;
    const stale = await addSession(id, { lastAuthAgoMs: 16 * 60_000 });
    const r = await approve(p, "approver", p.payloadHash, stale);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("step_up_required");
    expect(await statusOf(p.id)).toBe("pending_approval");
  });

  it("is bound to the payload the approver saw", async () => {
    const p = await pending();
    const r = await approve(p, "approver", "0".repeat(64));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("payload_changed");
    expect(
      (await send("approver", "POST", `/api/payments/${p.id}/approve`, { payloadHash: "zz" }))
        .status,
    ).toBe(400);
    expect((await send("approver", "POST", `/api/payments/${p.id}/approve`, {})).status).toBe(400);
    expect(await count("payment_approvals")).toBe(0);
  });

  it("cannot be approved twice, before confirming, or after cancelling", async () => {
    const d = await created();
    expect((await approve(d)).status).toBe(409); // still a draft
    expect((await confirm(d)).status).toBe(200);
    expect((await approve(d)).status).toBe(200);
    const again = await approve(d, "approver2");
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("not_pending");
    expect(await count("payment_approvals")).toBe(1);
  });

  it("a removed approver role stops the approval at once; the roles are checked inside the write", async () => {
    const p = await pending();
    await db
      .prepare("DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE email = ?1)")
      .bind(w.emails.approver)
      .run();
    expect((await approve(p)).status).toBe(403);
    expect(await statusOf(p.id)).toBe("pending_approval");
  });

  it("a rejection needs a reason, ends the request and cannot be undone", async () => {
    const p = await pending();
    const noNote = await send("approver", "POST", `/api/payments/${p.id}/reject`, {
      payloadHash: p.payloadHash,
    });
    expect(noNote.status).toBe(400);
    const r = await send<{ payment: Payment }>("approver", "POST", `/api/payments/${p.id}/reject`, {
      payloadHash: p.payloadHash,
      note: "Wrong supplier",
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.payment.status).toBe("rejected");
    expect(await audits()).toContain("payment.rejected");
    expect((await approve(p)).status).toBe(409);
    expect((await send("finance", "POST", `/api/payments/${p.id}/cancel`, {})).status).toBe(409);
    // the invoice is free again
    expect((await create()).status).toBe(201);
  });
});

describe("cancelling", () => {
  it("lets the requester or an admin cancel before anything was sent", async () => {
    const a = await created();
    expect((await send("finance2", "POST", `/api/payments/${a.id}/cancel`, {})).status).toBe(403);
    const c = await send<{ payment: Payment }>("finance", "POST", `/api/payments/${a.id}/cancel`, {
      reason: "paid by card",
    });
    expect(c.body.payment.status).toBe("cancelled");
    const row = await db
      .prepare("SELECT status_reason FROM payments WHERE id = ?1")
      .bind(a.id)
      .first<{ status_reason: string }>();
    expect(row?.status_reason).toBe("cancelled_by_requester");
    const b = await created();
    await confirm(b);
    const byAdmin = await send<{ payment: Payment }>(
      "admin",
      "POST",
      `/api/payments/${b.id}/cancel`,
      {},
    );
    expect(byAdmin.body.payment.status).toBe("cancelled");
    expect(await audits()).toContain("payment.cancelled");
    expect((await send("finance", "POST", `/api/payments/${a.id}/cancel`, {})).status).toBe(409);
  });
});

describe("lists", () => {
  it("filters by status and owner and pages with a cursor", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await addBill(w);
      ids.push((await created({ item: b.itemId })).id);
    }
    await send("finance", "POST", `/api/payments/${ids[0]}/cancel`, {});
    const open = await send<{ items: Payment[]; nextCursor: string | null }>(
      "viewer",
      "GET",
      "/api/payments?status=open&limit=1",
    );
    expect(open.body.items.map((i) => i.id)).toEqual([ids[2]]);
    expect(open.body.nextCursor).toBe(String(ids[2]));
    const next = await send<{ items: Payment[]; nextCursor: string | null }>(
      "viewer",
      "GET",
      `/api/payments?status=open&limit=1&cursor=${open.body.nextCursor}`,
    );
    expect(next.body.items.map((i) => i.id)).toEqual([ids[1]]);
    expect(next.body.nextCursor).toBeNull();
    const cancelled = await send<{ items: Payment[] }>(
      "viewer",
      "GET",
      "/api/payments?status=cancelled",
    );
    expect(cancelled.body.items.map((i) => i.id)).toEqual([ids[0]]);
    expect(
      (await send<{ items: Payment[] }>("viewer", "GET", "/api/payments?status=all")).body.items,
    ).toHaveLength(3);
    expect(
      (await send<{ items: Payment[] }>("approver", "GET", "/api/payments?mine=1")).body.items,
    ).toHaveLength(0);
    for (const q of ["status=nope", "limit=0", "limit=abc", "limit=1000", "cursor=-1"]) {
      expect((await send("viewer", "GET", `/api/payments?${q}`)).status, q).toBe(400);
    }
    expect((await send("viewer", "GET", "/api/payments/abc")).status).toBe(404);
    expect((await send("viewer", "GET", "/api/payments/999999")).status).toBe(404);
  });
});
