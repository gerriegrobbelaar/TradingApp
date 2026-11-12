/**
 * The submit boundary (P9a, ADR 0049): claim before the call, one call, unknown is never retried.
 * Uses FAKE submitters only. In production `getSubmitter()` is the disabled one and nothing calls
 * `runSubmission` (test/payments-scan.test.ts).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { paymentConfirmPhrase, batchConfirmPhrase } from "@camelthorn/core";
import { loadPaymentsState } from "../src/payments/settings";
import {
  cancelRequest,
  confirmRequest,
  createBatch,
  createPayment,
  decideRequest,
  expireStale,
} from "../src/payments/store";
import {
  DisabledSubmitter,
  getSubmitter,
  markStaleSubmissions,
  runSubmission,
  SUBMIT_LEASE_MS,
  type PaymentSubmitter,
  type SubmitOutcome,
  type SubmitRequest,
} from "../src/payments/submit";
import {
  OTHER_IBAN,
  SUPPLIER_IBAN,
  addBill,
  db,
  payWorld,
  putPaymentSettings,
  setMappingVerified,
  setSwitch,
  setVerified,
  withoutPaymentTriggers,
  type PayWorld,
} from "./payments-helpers";

const NOW = Date.parse("2026-07-15T10:00:00Z");
let w: PayWorld;
let seq = 0;

beforeEach(async () => {
  w = await payWorld({ nowMs: NOW });
});

const fake = (
  respond: (r: SubmitRequest) => SubmitOutcome | Promise<SubmitOutcome> | never,
): PaymentSubmitter & { calls: SubmitRequest[] } => {
  const calls: SubmitRequest[] = [];
  return {
    available: true,
    calls,
    submit: (r) => {
      calls.push(r);
      return Promise.resolve().then(() => respond(r));
    },
  };
};

async function ready(o: { approval?: boolean; itemId?: number } = {}): Promise<number> {
  const state = await loadPaymentsState(db);
  const r = await createPayment(db, {
    nowMs: NOW,
    actor: w.emails.finance,
    state,
    openItemId: o.itemId ?? w.itemId,
    sourceAccountId: w.accountId,
    clientKey: `submit-key-${++seq}-012345`,
  });
  if (r.blocked) throw new Error(r.blocks.join(","));
  const p = r.payment;
  await confirmRequest(db, {
    kind: "payment",
    id: p.id,
    nowMs: NOW,
    actor: w.emails.finance,
    authAtMs: NOW,
    state,
    phrase: paymentConfirmPhrase(p.amountMinor, p.currency),
  });
  if (o.approval !== false) {
    const row = await db
      .prepare("SELECT status FROM payments WHERE id = ?1")
      .bind(p.id)
      .first<{ status: string }>();
    if (row?.status === "pending_approval") {
      await decideRequest(db, {
        kind: "payment",
        id: p.id,
        nowMs: NOW,
        actor: w.emails.approver,
        roles: ["approver"],
        authAtMs: NOW,
        seenPayloadHash: p.payloadHash,
        decision: "approved",
        note: null,
      });
    }
  }
  return p.id;
}

const row = async (id: number) =>
  (await db
    .prepare(
      "SELECT status, status_reason, provider_id, submit_attempts FROM payments WHERE id = ?1",
    )
    .bind(id)
    .first<{
      status: string;
      status_reason: string;
      provider_id: string | null;
      submit_attempts: number;
    }>()) as {
    status: string;
    status_reason: string;
    provider_id: string | null;
    submit_attempts: number;
  };
const run = (id: number, s: PaymentSubmitter, nowMs = NOW) =>
  runSubmission(db, s, { kind: "payment", id, nowMs, owner: "job-1" });
const claims = async (): Promise<number> =>
  (await db.prepare("SELECT COUNT(*) AS n FROM payment_claims").first<{ n: number }>())?.n ?? -1;
const events = async (id: number): Promise<string[]> =>
  (
    await db
      .prepare(
        "SELECT to_status || ':' || COALESCE(code, '') AS e FROM payment_events WHERE payment_id = ?1 ORDER BY id",
      )
      .bind(id)
      .all<{ e: string }>()
  ).results.map((r) => r.e);

describe("the default submitter cannot send", () => {
  it("is not available and refuses before it claims anything", async () => {
    const id = await ready();
    expect(getSubmitter()).toBe(DisabledSubmitter);
    expect(DisabledSubmitter.available).toBe(false);
    expect(await DisabledSubmitter.submit({} as SubmitRequest)).toEqual({
      kind: "rejected",
      code: "payments_disabled",
    });
    expect(await run(id, DisabledSubmitter)).toEqual({
      status: "refused",
      code: "payments_disabled",
    });
    expect(await run(id, getSubmitter())).toEqual({ status: "refused", code: "payments_disabled" });
    expect(await claims()).toBe(0);
    expect((await row(id)).status).toBe("ready");
    expect((await row(id)).submit_attempts).toBe(0);
  });
});

describe("one claim, one call", () => {
  it("accepted: submitted with the provider id; the claim is released; every step is recorded", async () => {
    const id = await ready();
    const s = fake(() => ({ kind: "accepted", providerId: "rev-123" }));
    const r = await run(id, s);
    expect(r).toEqual({ status: "done", to: "submitted", code: "accepted" });
    expect(await row(id)).toMatchObject({
      status: "submitted",
      provider_id: "rev-123",
      submit_attempts: 1,
    });
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0] as SubmitRequest;
    expect(call).toMatchObject({
      kind: "payment",
      id,
      mode: "drafts",
      currency: "EUR",
      totalMinor: 100_000,
      sourceAccountId: w.accountId,
    });
    expect(call.items).toHaveLength(1);
    expect(call.items[0]?.requestId).toBe(call.requestId);
    // the request handed to the bank layer carries no IBAN at all (it reads the one it needs itself)
    expect(JSON.stringify(call)).not.toContain(SUPPLIER_IBAN);
    expect(await events(id)).toEqual([
      "draft:created",
      "pending_approval:confirmed_needs_approval",
      "ready:approved",
      "submitting:claimed",
      "submitted:accepted",
    ]);
    const claim = await db
      .prepare("SELECT owner, released_at, release_reason FROM payment_claims")
      .first<Record<string, string>>();
    expect(claim).toMatchObject({ owner: "job-1", release_reason: "finished" });
    expect(claim?.["released_at"]).toBeTruthy();
    const acts = (
      await db
        .prepare(
          "SELECT action FROM audit_log WHERE entity = 'payment' AND action LIKE 'payment.%' ORDER BY id DESC LIMIT 2",
        )
        .all<{ action: string }>()
    ).results.map((a) => a.action);
    expect(acts).toEqual(["payment.submitted", "payment.submitting"]);
  });

  it("rejected: nothing was paid, the code is kept (sanitised)", async () => {
    const id = await ready();
    const r = await run(
      id,
      fake(() => ({ kind: "rejected", code: "Insufficient Funds!!" })),
    );
    expect(r).toMatchObject({ status: "done", to: "rejected" });
    expect(await row(id)).toMatchObject({
      status: "rejected",
      status_reason: "provider_rejected:InsufficientFunds",
    });
  });

  it("unknown, a throw and a garbage answer all end outcome_unknown and are NEVER called again", async () => {
    const answers: (() => SubmitOutcome)[] = [
      () => ({ kind: "unknown" }),
      () => {
        throw new Error("socket hang up");
      },
      () => ({ kind: "accepted" }) as unknown as SubmitOutcome,
      () => ({ kind: "accepted", providerId: "" }),
      () => ({ kind: "rejected", code: "" }),
      () => ({ kind: "paid" }) as unknown as SubmitOutcome,
      () => null as unknown as SubmitOutcome,
    ];
    for (const a of answers) {
      w = await payWorld({ nowMs: NOW });
      const id = await ready();
      const s = fake(a);
      const r = await run(id, s);
      expect(r).toMatchObject({ status: "done", to: "outcome_unknown" });
      expect((await row(id)).status).toBe("outcome_unknown");
      // retry attempts, also much later: refused, the bank is not asked again
      expect(await run(id, s)).toEqual({ status: "refused", code: "not_ready" });
      expect(await run(id, s, NOW + 3 * 3600_000)).toEqual({
        status: "refused",
        code: "not_ready",
      });
      expect(s.calls).toHaveLength(1);
      expect((await row(id)).submit_attempts).toBe(1);
      // the claim stays as evidence; it is not released
      expect(
        (
          await db
            .prepare("SELECT released_at FROM payment_claims")
            .first<{ released_at: string | null }>()
        )?.released_at,
      ).toBeNull();
    }
  });

  it("two runs at once: exactly one reaches the bank", async () => {
    const id = await ready();
    const s = fake(async () => ({ kind: "accepted", providerId: "p1" }));
    const results = await Promise.all([run(id, s), run(id, s), run(id, s)]);
    expect(s.calls).toHaveLength(1);
    expect(results.filter((r) => r.status === "done")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status !== "done")
        .every((r) => r.status === "already_claimed" || r.status === "refused"),
    ).toBe(true);
    expect((await row(id)).submit_attempts).toBe(1);
  });

  it("a paid or submitted request cannot be sent again", async () => {
    const id = await ready();
    const s = fake(() => ({ kind: "accepted", providerId: "p1" }));
    await run(id, s);
    expect(await run(id, s)).toEqual({ status: "refused", code: "not_ready" });
    expect(s.calls).toHaveLength(1);
  });

  it("works without a second approver when none is needed", async () => {
    w = await payWorld({ nowMs: NOW, settings: { requireApprovalForNewIban: false } });
    const id = await ready();
    expect((await row(id)).status).toBe("ready");
    expect(
      await run(
        id,
        fake(() => ({ kind: "accepted", providerId: "p" })),
      ),
    ).toMatchObject({ status: "done", to: "submitted" });
  });
});

describe("what stops a send (all re-checked at the moment of sending)", () => {
  const never = fake(() => {
    throw new Error("must not be called");
  });
  async function refusedWith(id: number, code: string): Promise<void> {
    expect(await run(id, never)).toEqual({ status: "refused", code });
    expect(never.calls).toHaveLength(0);
    expect(await claims()).toBe(0);
    expect((await row(id)).status).toBe("ready");
  }

  it("the switch, the verification, the protocol version, the mapping, the approvers", async () => {
    const id = await ready();
    await setSwitch(false);
    await refusedWith(id, "payments_disabled");
    await setSwitch(true);
    await setVerified(false);
    await refusedWith(id, "payments_disabled");
    await setVerified(true, "f".repeat(64));
    await refusedWith(id, "payments_disabled");
    await setVerified(true);
    await setMappingVerified(false);
    await refusedWith(id, "payments_disabled");
    await setMappingVerified(true);
    await db.prepare("UPDATE connections SET status = 'disabled' WHERE kind = 'revolut'").run();
    await refusedWith(id, "payments_disabled");
    await db.prepare("UPDATE connections SET status = 'active' WHERE kind = 'revolut'").run();
    expect(
      await run(
        id,
        fake(() => ({ kind: "accepted", providerId: "p" })),
      ),
    ).toMatchObject({ status: "done" });
  });

  it("an expired request", async () => {
    const id = await ready();
    expect(await run(id, never, NOW + 24 * 3600_000)).toEqual({
      status: "refused",
      code: "expired",
    });
    expect(never.calls).toHaveLength(0);
  });

  it("a payload that changed after approval (tamper)", async () => {
    const id = await ready();
    await withoutPaymentTriggers(["payments_guard_payload"], async () => {
      await db
        .prepare("UPDATE payments SET reference = 'Invoice HACKED' WHERE id = ?1")
        .bind(id)
        .run();
    });
    await refusedWith(id, "payload_tampered");
    await withoutPaymentTriggers(["payments_guard_payload"], async () => {
      await db
        .prepare(
          "UPDATE payments SET amount_minor = 5, reference = 'Invoice INV-7001' WHERE id = ?1",
        )
        .bind(id)
        .run();
    });
    expect((await run(id, never)).status).toBe("refused");
  });

  it("an approver who lost the role or was disabled after approving", async () => {
    let id = await ready();
    await db
      .prepare("DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE email = ?1)")
      .bind(w.emails.approver)
      .run();
    await refusedWith(id, "approval_approver_lacks_role");
    w = await payWorld({ nowMs: NOW });
    id = await ready();
    await db
      .prepare("UPDATE users SET disabled_at = '2026-07-01T00:00:00.000Z' WHERE email = ?1")
      .bind(w.emails.approver)
      .run();
    await refusedWith(id, "approval_approver_inactive");
  });

  it("a missing approval where one is needed", async () => {
    const id = await ready();
    await withoutPaymentTriggers(["payment_approvals_guard_delete"], async () => {
      await db.prepare("DELETE FROM payment_approvals").run();
    });
    await refusedWith(id, "not_approved");
  });

  it("an approval older than 24 hours", async () => {
    const id = await ready();
    await withoutPaymentTriggers(
      ["payments_guard_payload", "payment_approvals_guard_update"],
      async () => {
        await db
          .prepare("UPDATE payments SET expires_at = '2026-07-20T00:00:00.000Z' WHERE id = ?1")
          .bind(id)
          .run();
        await db
          .prepare("UPDATE payment_approvals SET decided_at = '2026-07-14T09:00:00.000Z'")
          .run();
      },
    );
    await refusedWith(id, "approval_approval_expired");
  });

  it("an unknown request, and a batch item sent on its own", async () => {
    expect(await run(99999, never)).toEqual({ status: "refused", code: "not_found" });
  });
});

describe("a crashed run", () => {
  it("a claim past its lease becomes outcome_unknown, not a retry", async () => {
    const id = await ready();
    // the worker died after claiming: claim + `submitting` exist, no answer was recorded
    await db.batch([
      db
        .prepare(
          "INSERT INTO payment_claims (payment_id, owner, claimed_at, lease_until) VALUES (?1, 'dead-job', ?2, ?3)",
        )
        .bind(id, new Date(NOW).toISOString(), new Date(NOW + SUBMIT_LEASE_MS).toISOString()),
      db
        .prepare("UPDATE payments SET status = 'submitting', submit_attempts = 1 WHERE id = ?1")
        .bind(id),
    ]);
    expect(await markStaleSubmissions(db, NOW + SUBMIT_LEASE_MS - 1)).toBe(0);
    expect((await row(id)).status).toBe("submitting");
    expect(await markStaleSubmissions(db, NOW + SUBMIT_LEASE_MS)).toBe(1);
    expect(await row(id)).toMatchObject({
      status: "outcome_unknown",
      status_reason: "lease_expired",
    });
    expect(await markStaleSubmissions(db, NOW + 2 * SUBMIT_LEASE_MS)).toBe(0);
    const s = fake(() => ({ kind: "accepted", providerId: "p" }));
    expect((await run(id, s, NOW + 2 * SUBMIT_LEASE_MS)).status).toBe("refused");
    expect(s.calls).toHaveLength(0);
  });
});

describe("expiry", () => {
  it("drafts, waiting and ready requests expire after 24 hours and cannot be approved or confirmed then", async () => {
    const draftId = await ready({ approval: false }); // pending_approval
    const state = await loadPaymentsState(db);
    const other = await createPayment(db, {
      nowMs: NOW,
      actor: w.emails.finance,
      state,
      openItemId: (await addBill(w)).itemId,
      sourceAccountId: w.accountId,
      clientKey: "expiry-key-draft-0001",
    });
    if (other.blocked) throw new Error("blocked");
    await expireStale(db, NOW + 24 * 3600_000 - 1);
    expect((await row(draftId)).status).toBe("pending_approval");
    await expireStale(db, NOW + 24 * 3600_000);
    expect((await row(draftId)).status).toBe("expired");
    expect((await row(other.payment.id)).status).toBe("expired");
    expect(await events(draftId)).toContain("expired:expired");
    const acts = (
      await db
        .prepare("SELECT actor_email FROM audit_log WHERE action = 'payment.expired'")
        .all<{ actor_email: string }>()
    ).results;
    expect(acts.length).toBeGreaterThanOrEqual(2);
    // approving / confirming an expired request fails; the invoice is free again
    await expect(
      decideRequest(db, {
        kind: "payment",
        id: draftId,
        nowMs: NOW + 25 * 3600_000,
        actor: w.emails.approver,
        roles: ["approver"],
        authAtMs: NOW + 25 * 3600_000,
        seenPayloadHash: "0".repeat(64),
        decision: "approved",
        note: null,
      }),
    ).rejects.toMatchObject({ code: "not_pending" });
    await expect(
      confirmRequest(db, {
        kind: "payment",
        id: other.payment.id,
        nowMs: NOW + 25 * 3600_000,
        actor: w.emails.finance,
        authAtMs: NOW + 25 * 3600_000,
        state,
        phrase: paymentConfirmPhrase(100_000, "EUR"),
      }),
    ).rejects.toMatchObject({ code: "not_draft" });
  });

  it("an expiry race: approving exactly at the expiry instant writes nothing", async () => {
    const id = await ready({ approval: false });
    const hash = (
      await db
        .prepare("SELECT payload_hash FROM payments WHERE id = ?1")
        .bind(id)
        .first<{ payload_hash: string }>()
    )?.payload_hash as string;
    await expect(
      decideRequest(db, {
        kind: "payment",
        id,
        nowMs: NOW + 24 * 3600_000,
        actor: w.emails.approver,
        roles: ["approver"],
        authAtMs: NOW + 24 * 3600_000,
        seenPayloadHash: hash,
        decision: "approved",
        note: null,
      }),
    ).rejects.toMatchObject({ code: "not_pending" });
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM payment_approvals").first<{ n: number }>())?.n,
    ).toBe(0);
  });
});

describe("batches", () => {
  async function batch(
    extra: { id: number; amount?: number }[] = [],
    sourceAccountId = w.accountId,
  ) {
    const a = await addBill(w);
    const b = await addBill(w);
    const items = [
      { openItemId: a.itemId },
      { openItemId: b.itemId },
      ...extra.map((e) => ({ openItemId: e.id, amountMinor: e.amount })),
    ];
    return createBatch(db, {
      nowMs: NOW,
      actor: w.emails.finance,
      state: await loadPaymentsState(db),
      sourceAccountId,
      items,
      clientKey: `batch-key-${++seq}-0123456`,
    });
  }
  const BASE = { nowMs: NOW, authAtMs: NOW };

  it("creates one batch with its items, binds one hash, needs the batch phrase and one approval", async () => {
    const r = await batch();
    if (r.blocked) throw new Error(JSON.stringify(r));
    const b = r.batch;
    expect(b).toMatchObject({
      kind: "batch",
      status: "draft",
      itemCount: 2,
      totalMinor: 200_000,
      currency: "EUR",
      approvalsRequired: ["new_or_changed_iban"],
      confirmPhrase: "PAY BATCH 2 INVOICES 2000.00 EUR",
    });
    expect(b.items).toHaveLength(2);
    expect(JSON.stringify(b)).not.toContain(SUPPLIER_IBAN);
    const state = await loadPaymentsState(db);
    await expect(
      confirmRequest(db, {
        ...BASE,
        actor: w.emails.finance,
        kind: "batch",
        id: b.id,
        state,
        phrase: "PAY 2000.00 EUR",
      }),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    const c = await confirmRequest(db, {
      ...BASE,
      actor: w.emails.finance,
      kind: "batch",
      id: b.id,
      state,
      phrase: batchConfirmPhrase(2, 200_000, "EUR"),
    });
    expect(c.status).toBe("pending_approval");
    const items = await db
      .prepare("SELECT status FROM payments WHERE batch_id = ?1")
      .bind(b.id)
      .all<{ status: string }>();
    expect(items.results.map((i) => i.status)).toEqual(["pending_approval", "pending_approval"]);
    const ap = await decideRequest(db, {
      kind: "batch",
      id: b.id,
      nowMs: NOW,
      actor: w.emails.approver,
      roles: ["approver"],
      authAtMs: NOW,
      seenPayloadHash: b.payloadHash,
      decision: "approved",
      note: null,
    });
    expect(ap.status).toBe("ready");
    expect(
      (
        await db
          .prepare("SELECT status FROM payments WHERE batch_id = ?1")
          .bind(b.id)
          .all<{ status: string }>()
      ).results.map((i) => i.status),
    ).toEqual(["ready", "ready"]);
    // item-level events exist for every step
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM payment_events WHERE payment_id IN (SELECT id FROM payments WHERE batch_id = ?1)",
          )
          .bind(b.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(6);
  });

  it("items follow their batch and cannot move alone", async () => {
    const r = await batch();
    if (r.blocked) throw new Error("blocked");
    const item = r.batch.items[0] as { id: number };
    const err = await db
      .prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?1")
      .bind(item.id)
      .run()
      .then(
        () => "",
        (e: Error) => e.message + String(e.cause),
      );
    expect(err).toContain("payment_err:batch_item");
    // a batch item has no request page of its own
    await expect(
      confirmRequest(db, {
        ...BASE,
        actor: w.emails.finance,
        kind: "payment",
        id: item.id,
        state: await loadPaymentsState(db),
        phrase: "x",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      cancelRequest(db, {
        kind: "payment",
        id: item.id,
        nowMs: NOW,
        actor: w.emails.finance,
        isAdmin: false,
        reason: null,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const c = await cancelRequest(db, {
      kind: "batch",
      id: r.batch.id,
      nowMs: NOW,
      actor: w.emails.finance,
      isAdmin: false,
      reason: "wrong run",
    });
    expect(c.status).toBe("cancelled");
    expect(
      (
        await db
          .prepare("SELECT status FROM payments WHERE batch_id = ?1")
          .bind(r.batch.id)
          .all<{ status: string }>()
      ).results.map((i) => i.status),
    ).toEqual(["cancelled", "cancelled"]);
  });

  it("is blocked as a whole by any blocked item, a duplicate, the limits and a missing account", async () => {
    const pendingBill = await addBill(w, { approved: false });
    const good = await addBill(w);
    const mk = async (items: { openItemId: number }[], source = w.accountId) =>
      createBatch(db, {
        nowMs: NOW,
        actor: w.emails.finance,
        state: await loadPaymentsState(db),
        sourceAccountId: source,
        items,
        clientKey: `blk-key-${++seq}-0123456789`,
      });
    const blocked = async (items: { openItemId: number }[], source = w.accountId) => {
      const r = await mk(items, source);
      if (!r.blocked) throw new Error("expected blocked");
      return r;
    };
    expect(
      (await blocked([{ openItemId: good.itemId }, { openItemId: pendingBill.itemId }])).blocks,
    ).toContain("batch_item_blocked");
    expect(
      (await blocked([{ openItemId: good.itemId }, { openItemId: pendingBill.itemId }])).itemBlocks,
    ).toEqual([{ openItemId: pendingBill.itemId, blocks: ["invoice_not_approved"] }]);
    expect(
      (await blocked([{ openItemId: good.itemId }, { openItemId: good.itemId }])).blocks,
    ).toContain("batch_duplicate_invoice");
    expect((await blocked([])).blocks).toContain("batch_empty");
    expect((await blocked([{ openItemId: good.itemId }], 99999)).blocks).toContain(
      "batch_item_blocked",
    );
    await putPaymentSettings({ maxRequestMinor: 150_000 });
    const two = await blocked([
      { openItemId: good.itemId },
      { openItemId: (await addBill(w)).itemId },
    ]);
    expect(two.blocks).toEqual(["batch_over_request_limit"]);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM payment_batches").first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it("an invoice already in a request or another batch cannot join a batch", async () => {
    const first = await batch();
    if (first.blocked) throw new Error("blocked");
    const again = await createBatch(db, {
      nowMs: NOW,
      actor: w.emails.finance,
      state: await loadPaymentsState(db),
      sourceAccountId: w.accountId,
      items: [{ openItemId: (first.batch.items[0] as { openItemId: number }).openItemId }],
      clientKey: "second-batch-key-0001",
    });
    expect(again.blocked).toBe(true);
    if (again.blocked) expect(again.itemBlocks[0]?.blocks).toEqual(["already_in_batch"]);
  });

  it("is idempotent per client key", async () => {
    const a = await addBill(w);
    const b = await addBill(w);
    const args = {
      nowMs: NOW,
      actor: w.emails.finance,
      state: await loadPaymentsState(db),
      sourceAccountId: w.accountId,
      items: [{ openItemId: a.itemId }, { openItemId: b.itemId }],
      clientKey: "batch-replay-key-0001",
    };
    const one = await createBatch(db, args);
    const two = await createBatch(db, args);
    if (one.blocked || two.blocked) throw new Error("blocked");
    expect(two.replayed).toBe(true);
    expect(two.batch.id).toBe(one.batch.id);
    await expect(
      createBatch(db, { ...args, items: [{ openItemId: a.itemId }] }),
    ).rejects.toMatchObject({ code: "client_key_reused" });
  });

  it("four-eyes judges the total AND each item", async () => {
    await putPaymentSettings({ requireApprovalForNewIban: false });
    w = { ...w };
    const mk = async (amounts: number[]) => {
      const items = [];
      for (const a of amounts)
        items.push({ openItemId: (await addBill(w, { openMinor: a })).itemId });
      const r = await createBatch(db, {
        nowMs: NOW,
        actor: w.emails.finance,
        state: await loadPaymentsState(db),
        sourceAccountId: w.accountId,
        items,
        clientKey: `sum-key-${++seq}-0123456789`,
      });
      if (r.blocked) throw new Error(JSON.stringify(r));
      return r.batch.approvalsRequired;
    };
    expect(await mk([100_000, 100_000])).toEqual([]);
    expect(await mk([125_000, 125_000])).toEqual([]); // total exactly at the limit
    expect(await mk([125_000, 125_001])).toEqual(["batch_total_above_limit"]);
    expect(await mk([300_000])).toEqual(["batch_total_above_limit", "batch_item_above_limit"]);
  });

  it("is sent by one call with all its items, and the items follow the answer", async () => {
    w = await payWorld({ nowMs: NOW, settings: { requireApprovalForNewIban: false } });
    const r = await batch();
    if (r.blocked) throw new Error("blocked");
    await confirmRequest(db, {
      ...BASE,
      actor: w.emails.finance,
      kind: "batch",
      id: r.batch.id,
      state: await loadPaymentsState(db),
      phrase: r.batch.confirmPhrase as string,
    });
    const s = fake(() => ({ kind: "accepted", providerId: "bulk-1" }));
    const out = await runSubmission(db, s, {
      kind: "batch",
      id: r.batch.id,
      nowMs: NOW,
      owner: "job-1",
    });
    expect(out).toMatchObject({ status: "done", to: "submitted" });
    expect(s.calls).toHaveLength(1);
    expect((s.calls[0] as SubmitRequest).items).toHaveLength(2);
    expect(
      (
        await db
          .prepare("SELECT status FROM payments WHERE batch_id = ?1")
          .bind(r.batch.id)
          .all<{ status: string }>()
      ).results.map((i) => i.status),
    ).toEqual(["submitted", "submitted"]);
    // a batch item is never sent on its own
    const item = r.batch.items[0] as { id: number };
    expect(await run(item.id, s)).toEqual({ status: "refused", code: "batch_item" });
    expect(s.calls).toHaveLength(1);
    // the bank's per-item answers arrive once the batch was submitted
    await db.batch([db.prepare("UPDATE payments SET status = 'paid' WHERE id = ?1").bind(item.id)]);
    expect(OTHER_IBAN).toBeTruthy();
  });
});
