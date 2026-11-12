/**
 * The database's own enforcement of the payment rules (migration 0028, ADR 0049). These tests go
 * AROUND the application code on purpose: if a bug in the store ever tried to skip an approval, move a
 * state backwards or edit an approved payload, the triggers must refuse.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { PAYMENT_STATUSES, PAYMENT_TRANSITIONS, paymentConfirmPhrase } from "@camelthorn/core";
import { createPayment, confirmRequest, decideRequest } from "../src/payments/store";
import { loadPaymentsState } from "../src/payments/settings";
import {
  addBill,
  db,
  payWorld,
  setSwitch,
  withoutPaymentTriggers,
  type PayWorld,
  TEST_IBAN_KEY,
} from "./payments-helpers";

const NOW = Date.parse("2026-07-15T10:00:00Z");
let w: PayWorld;
let seq = 0;

beforeEach(async () => {
  w = await payWorld({ nowMs: NOW });
});

async function draft(o: { itemId?: number; settings?: boolean } = {}): Promise<number> {
  const r = await createPayment(db, {
    nowMs: NOW,
    actor: w.emails.finance,
    state: await loadPaymentsState(db, TEST_IBAN_KEY),
    ibanKey: TEST_IBAN_KEY,
    openItemId: o.itemId ?? w.itemId,
    sourceAccountId: w.accountId,
    clientKey: `db-key-${++seq}-0123456789`,
  });
  if (r.blocked) throw new Error(`blocked: ${r.blocks.join(",")}`);
  return r.payment.id;
}

async function fails(sql: string, ...binds: (string | number | null)[]): Promise<string> {
  try {
    await db
      .prepare(sql)
      .bind(...binds)
      .run();
  } catch (e) {
    return `${(e as Error).message} ${String((e as Error).cause ?? "")}`;
  }
  return "";
}
const refused = (msg: string, code: string): void => {
  expect(msg, `expected payment_err:${code}`).toContain(`payment_err:${code}`);
};

async function triggerSql(names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const n of names) {
    const r = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1")
      .bind(n)
      .first<{ sql: string }>();
    if (r === null) throw new Error(`no trigger ${n}`);
    out.push(r.sql);
  }
  return out;
}

describe("states only move forward", () => {
  // Written out by hand, NOT read from core: the trigger is checked against an independent table.
  const LEGAL: Record<string, string[]> = {
    draft: ["pending_approval", "ready", "cancelled", "expired"],
    pending_approval: ["ready", "rejected", "cancelled", "expired"],
    ready: ["submitting", "cancelled", "expired"],
    submitting: ["submitted", "rejected", "outcome_unknown"],
    submitted: ["paid", "failed"],
    outcome_unknown: ["submitted", "paid", "failed", "rejected"],
    paid: [],
    failed: [],
    rejected: [],
    cancelled: [],
    expired: [],
  };

  it("the core table equals the independent one", () => {
    for (const s of PAYMENT_STATUSES)
      expect([...PAYMENT_TRANSITIONS[s]].sort()).toEqual([...(LEGAL[s] ?? [])].sort());
  });

  it("accepts exactly the legal moves (full 11 x 11 matrix)", async () => {
    const id = await draft();
    const STATUS = ["payments_guard_status", "payments_guard_final"];
    const SECONDARY = [
      "payments_guard_confirm",
      "payments_guard_approved",
      "payments_guard_rejected",
      "payments_guard_submitting",
      // P9b (migration 0029): outcome_unknown -> rejected needs a lookup that found nothing;
      // tested on its own in payments-execution.test.ts.
      "payments_guard_unknown_reject",
    ];
    const statusSql = await triggerSql(STATUS);
    const secondarySql = await triggerSql(SECONDARY);
    const setStatus = (to: string) =>
      db.prepare("UPDATE payments SET status = ?2 WHERE id = ?1").bind(id, to);
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        // put the row into `from` with the state guards lifted (one transaction)
        await db.batch([
          ...STATUS.map((n) => db.prepare(`DROP TRIGGER ${n}`)),
          ...SECONDARY.map((n) => db.prepare(`DROP TRIGGER ${n}`)),
          setStatus(from),
          ...statusSql.map((s) => db.prepare(s)),
          ...secondarySql.map((s) => db.prepare(s)),
        ]);
        // try the move with only the secondary guards lifted: the state table alone decides
        let ok = true;
        try {
          await db.batch([
            ...SECONDARY.map((n) => db.prepare(`DROP TRIGGER ${n}`)),
            setStatus(to),
            ...secondarySql.map((s) => db.prepare(s)),
          ]);
        } catch {
          ok = false;
        }
        // setting the state a row already has is not a move (but a final row refuses every update)
        expect(ok, `${from} -> ${to}`).toBe(
          from === to ? LEGAL[from]?.length !== 0 : LEGAL[from]?.includes(to) === true,
        );
      }
    }
    // the matrix left every trigger in place
    expect((await triggerSql([...STATUS, ...SECONDARY])).length).toBe(
      STATUS.length + SECONDARY.length,
    );
  });
});

describe("what never changes", () => {
  it("request_id, the payload hash and everything it covers are immutable, also in draft", async () => {
    const id = await draft();
    refused(
      await fails(
        "UPDATE payments SET request_id = ?2 WHERE id = ?1",
        id,
        "22222222-2222-4222-8222-222222222222",
      ),
      "request_id_immutable",
    );
    refused(
      await fails("UPDATE payments SET payload_hash = ?2 WHERE id = ?1", id, "a".repeat(64)),
      "payload_immutable",
    );
    refused(
      await fails("UPDATE payments SET amount_minor = amount_minor + 1 WHERE id = ?1", id),
      "payload_immutable",
    );
    refused(
      await fails("UPDATE payments SET currency = 'USD' WHERE id = ?1", id),
      "payload_immutable",
    );
    refused(
      await fails(
        "UPDATE payments SET beneficiary_iban = ?2 WHERE id = ?1",
        id,
        "DE89370400440532013000",
      ),
      "payload_immutable",
    );
    refused(
      await fails("UPDATE payments SET iban_fingerprint = ?2 WHERE id = ?1", id, "b".repeat(64)),
      "payload_immutable",
    );
    refused(
      await fails("UPDATE payments SET reference = 'Other' WHERE id = ?1", id),
      "payload_immutable",
    );
    refused(
      await fails("UPDATE payments SET bank_account_id = bank_account_id + 1 WHERE id = ?1", id),
      "payload_immutable",
    );
    refused(
      await fails("UPDATE payments SET open_item_id = open_item_id + 1 WHERE id = ?1", id),
      "payload_immutable",
    );
    refused(
      await fails("UPDATE payments SET approvals_required = '[]' WHERE id = ?1", id),
      "payload_immutable",
    );
    refused(
      await fails("UPDATE payments SET requested_by = 'x@y.nl' WHERE id = ?1", id),
      "payload_immutable",
    );
    refused(
      await fails("UPDATE payments SET expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?1", id),
      "payload_immutable",
    );
    refused(await fails("UPDATE payments SET mode = 'pay' WHERE id = ?1", id), "payload_immutable");
    // setting a column to the value it already has is not a change
    expect(
      await fails(
        "UPDATE payments SET amount_minor = amount_minor, request_id = request_id WHERE id = ?1",
        id,
      ),
    ).toBe("");
  });

  it("a payment row is never deleted", async () => {
    const id = await draft();
    refused(await fails("DELETE FROM payments WHERE id = ?1", id), "no_delete");
  });

  it("a final state is final: nothing about the row changes any more", async () => {
    const id = await draft();
    await db
      .prepare("UPDATE payments SET status = 'cancelled', status_reason = 'x' WHERE id = ?1")
      .bind(id)
      .run();
    refused(await fails("UPDATE payments SET status_reason = 'y' WHERE id = ?1", id), "final");
    refused(await fails("UPDATE payments SET provider_id = 'p' WHERE id = ?1", id), "final");
    refused(await fails("UPDATE payments SET status = 'draft' WHERE id = ?1", id), "final");
  });

  it("paid and failed are terminal too", async () => {
    for (const end of ["paid", "failed"]) {
      const id = await draft({ itemId: (await addBill(w)).itemId });
      await withoutPaymentTriggers(["payments_guard_status", "payments_guard_final"], async () => {
        await db.prepare("UPDATE payments SET status = ?2 WHERE id = ?1").bind(id, end).run();
      });
      refused(await fails("UPDATE payments SET status = 'submitted' WHERE id = ?1", id), "final");
      refused(await fails("UPDATE payments SET provider_id = 'late' WHERE id = ?1", id), "final");
    }
  });

  it("events, approvals, verifications and claims are append-only", async () => {
    const id = await draft();
    refused(await fails("UPDATE payment_events SET code = 'x'"), "append_only");
    refused(await fails("DELETE FROM payment_events"), "append_only");
    refused(
      await fails("UPDATE supplier_iban_verifications SET verified_by = 'x@y.nl'"),
      "append_only",
    );
    refused(await fails("DELETE FROM supplier_iban_verifications"), "append_only");
    expect(id).toBeGreaterThan(0);
  });
});

describe("what can be inserted", () => {
  const base = (over: Record<string, string | number | null> = {}) => {
    const cols = {
      request_id: "33333333-3333-4333-8333-333333333333",
      division_id: w.divisionId,
      open_item_id: w.itemId,
      bank_account_id: w.accountId,
      mode: "drafts",
      amount_minor: 100_000,
      currency: "EUR",
      beneficiary_name: "Acme",
      beneficiary_iban: "NL91ABNA0417164300",
      iban_fingerprint: "c".repeat(64),
      reference: "Invoice 1",
      payload_hash: "d".repeat(64),
      requested_by: w.emails.finance,
      expires_at: "2026-07-16T10:00:00.000Z",
      ...over,
    };
    const keys = Object.keys(cols);
    return {
      sql: `INSERT INTO payments (${keys.join(", ")}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(", ")})`,
      binds: Object.values(cols),
    };
  };
  const tryInsert = (over: Record<string, string | number | null>) => {
    const { sql, binds } = base(over);
    return fails(sql, ...binds);
  };

  it("accepts a well-formed draft", async () => {
    expect(await tryInsert({})).toBe("");
  });

  it("refuses anything that does not start as a draft", async () => {
    refused(await tryInsert({ status: "ready" }), "bad_insert");
    refused(await tryInsert({ status: "paid" }), "bad_insert");
    refused(await tryInsert({ submit_attempts: 1 }), "bad_insert");
    refused(await tryInsert({ provider_id: "p" }), "bad_insert");
    refused(await tryInsert({ confirmed_at: "2026-07-15T10:00:00.000Z" }), "bad_insert");
  });

  it("refuses bad amounts, ids and currencies by CHECK", async () => {
    for (const amount of [0, -1, 2 ** 53])
      expect(await tryInsert({ amount_minor: amount }), String(amount)).not.toBe("");
    expect(await tryInsert({ request_id: "not-a-uuid" })).not.toBe("");
    expect(await tryInsert({ request_id: "33333333-3333-1333-8333-333333333333" })).not.toBe(""); // v1
    expect(await tryInsert({ request_id: "33333333-3333-4333-c333-333333333333" })).not.toBe(""); // variant
    expect(await tryInsert({ request_id: "33333333-3333-4333-8333-33333333333G" })).not.toBe("");
    expect(await tryInsert({ currency: "eur" })).not.toBe("");
    expect(await tryInsert({ beneficiary_iban: "nl91abna0417164300" })).not.toBe("");
    expect(await tryInsert({ reference: "" })).not.toBe("");
    expect(await tryInsert({ reference: "R".repeat(141) })).not.toBe("");
    expect(await tryInsert({ requested_by: "Finance@Camelthorncapital.com" })).not.toBe("");
    expect(await tryInsert({ payload_hash: "short" })).not.toBe("");
  });

  it("refuses a payable that is not an open bill big enough, or an account of another currency", async () => {
    refused(await tryInsert({ amount_minor: 100_001 }), "bad_insert");
    const inv = await db
      .prepare("UPDATE open_items SET kind = 'invoice' WHERE id = ?1")
      .bind(w.itemId)
      .run();
    expect(inv.meta.changes).toBe(1);
    refused(await tryInsert({}), "bad_insert");
    await db.prepare("UPDATE open_items SET kind = 'bill' WHERE id = ?1").bind(w.itemId).run();
    refused(await tryInsert({ currency: "USD" }), "bad_insert");
  });

  it("refuses everything while the payments switch is off", async () => {
    await setSwitch(false);
    refused(await tryInsert({}), "payments_disabled");
    await db.prepare("DELETE FROM settings WHERE key = 'payments.enabled'").run();
    refused(await tryInsert({}), "payments_disabled");
    await db
      .prepare("INSERT INTO settings (key, value_json) VALUES ('payments.enabled', '\"true\"')")
      .run();
    refused(await tryInsert({}), "payments_disabled");
  });

  it("allows one open request per invoice, and a new one once the first ended", async () => {
    expect(await tryInsert({})).toBe("");
    const dup = await tryInsert({ request_id: "44444444-4444-4444-8444-444444444444" });
    expect(dup).toContain("UNIQUE constraint failed");
    await db
      .prepare(
        "UPDATE payments SET status = 'cancelled' WHERE request_id = '33333333-3333-4333-8333-333333333333'",
      )
      .run();
    expect(await tryInsert({ request_id: "44444444-4444-4444-8444-444444444444" })).toBe("");
    // the request id is unique forever
    expect(await tryInsert({ request_id: "44444444-4444-4444-8444-444444444444" })).toContain(
      "UNIQUE",
    );
  });
});

describe("four-eyes in the database", () => {
  const SECONDARY_ONLY = ["payments_guard_approved"];

  async function pending(): Promise<number> {
    const id = await draft();
    await confirmRequest(db, {
      kind: "payment",
      id,
      nowMs: NOW,
      actor: w.emails.finance,
      authAtMs: NOW,
      state: await loadPaymentsState(db, TEST_IBAN_KEY),
      ibanKey: TEST_IBAN_KEY,
      phrase: paymentConfirmPhrase(100_000, "EUR", "4300"),
    });
    return id;
  }

  it("pending_approval -> ready without an approval is refused", async () => {
    const id = await pending();
    refused(await fails("UPDATE payments SET status = 'ready' WHERE id = ?1", id), "not_approved");
  });

  it("draft -> ready is refused when a second person is required; and the confirmation must be recorded", async () => {
    const id = await draft();
    refused(
      await fails("UPDATE payments SET status = 'pending_approval' WHERE id = ?1", id),
      "not_confirmed",
    );
    refused(
      await fails(
        "UPDATE payments SET status = 'ready', confirmed_at = ?2, requester_auth_at = ?2 WHERE id = ?1",
        id,
        "2026-07-15T10:00:00.000Z",
      ),
      "approval_required",
    );
  });

  it("an approval row needs a different person who holds the approver role, for a pending request and its exact hash", async () => {
    const id = await pending();
    const hash = (
      await db
        .prepare("SELECT payload_hash FROM payments WHERE id = ?1")
        .bind(id)
        .first<{ payload_hash: string }>()
    )?.payload_hash as string;
    const ins = (by: string, h = hash, req = w.emails.finance, pid = id) =>
      fails(
        `INSERT INTO payment_approvals (payment_id, decision, payload_hash, requested_by, decided_by, approver_auth_at)
         VALUES (?1, 'approved', ?2, ?3, ?4, '2026-07-15T10:00:00.000Z')`,
        pid,
        h,
        req,
        by,
      );
    // requester = approver: refused (the trigger and the CHECK both say no)
    expect(await ins(w.emails.finance)).not.toBe("");
    // no approver role
    refused(await ins(w.emails.finance2), "approver_role");
    refused(await ins(w.emails.admin), "approver_role");
    // a user that does not exist
    refused(await ins("ghost@camelthorncapital.com"), "approver_role");
    // a disabled approver
    await db
      .prepare("UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE email = ?1")
      .bind(w.emails.approver2)
      .run();
    refused(await ins(w.emails.approver2), "approver_role");
    // wrong hash, wrong requester
    refused(await ins(w.emails.approver, "e".repeat(64)), "approval_subject");
    refused(await ins(w.emails.approver, hash, w.emails.finance2), "approval_subject");
    // the good one
    expect(await ins(w.emails.approver)).toBe("");
    // one decision per request, ever
    expect(await ins(w.emails.approver)).not.toBe("");
    // and a decision is never edited or removed
    refused(await fails("UPDATE payment_approvals SET decision = 'rejected'"), "append_only");
    refused(await fails("UPDATE payment_approvals SET note = 'x'"), "append_only");
    refused(await fails("DELETE FROM payment_approvals"), "append_only");
  });

  it("a requester who also holds the approver role still cannot approve or reject their own request", async () => {
    const id = await pending();
    const hash = (
      await db
        .prepare("SELECT payload_hash FROM payments WHERE id = ?1")
        .bind(id)
        .first<{ payload_hash: string }>()
    )?.payload_hash as string;
    await db
      .prepare(
        "INSERT INTO user_roles (user_id, role) VALUES ((SELECT id FROM users WHERE email = ?1), 'approver')",
      )
      .bind(w.emails.finance)
      .run();
    for (const decision of ["approved", "rejected"]) {
      const msg = await fails(
        `INSERT INTO payment_approvals (payment_id, decision, payload_hash, requested_by, decided_by, approver_auth_at)
         VALUES (?1, ?4, ?2, ?3, ?3, '2026-07-15T10:00:00.000Z')`,
        id,
        hash,
        w.emails.finance,
        decision,
      );
      expect(msg).toContain("CHECK constraint failed");
    }
    // the same person under another casing is no other person: the stored columns are lower case
    const casing = await fails(
      `INSERT INTO payment_approvals (payment_id, decision, payload_hash, requested_by, decided_by, approver_auth_at)
       VALUES (?1, 'approved', ?2, ?3, ?4, '2026-07-15T10:00:00.000Z')`,
      id,
      hash,
      w.emails.finance,
      w.emails.finance.toUpperCase(),
    );
    expect(casing).not.toBe("");
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM payment_approvals").first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it("an approval for a request that is not waiting is refused", async () => {
    const id = await draft();
    const hash = (
      await db
        .prepare("SELECT payload_hash FROM payments WHERE id = ?1")
        .bind(id)
        .first<{ payload_hash: string }>()
    )?.payload_hash as string;
    refused(
      await fails(
        `INSERT INTO payment_approvals (payment_id, decision, payload_hash, requested_by, decided_by, approver_auth_at)
         VALUES (?1, 'approved', ?2, ?3, ?4, '2026-07-15T10:00:00.000Z')`,
        id,
        hash,
        w.emails.finance,
        w.emails.approver,
      ),
      "approval_subject",
    );
  });

  it("ready needs an approval that matches the payload AND whose approver still holds the role", async () => {
    const id = await pending();
    const res = await decideRequest(db, {
      kind: "payment",
      id,
      nowMs: NOW,
      actor: w.emails.approver,
      roles: ["approver"],
      authAtMs: NOW,
      seenPayloadHash: (
        await db
          .prepare("SELECT payload_hash FROM payments WHERE id = ?1")
          .bind(id)
          .first<{ payload_hash: string }>()
      )?.payload_hash as string,
      decision: "approved",
      note: null,
    });
    expect(res.status).toBe("ready");
    // now a ready -> submitting claim: the approver lost the role in between
    await db
      .prepare("DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE email = ?1)")
      .bind(w.emails.approver)
      .run();
    await db
      .prepare(
        "INSERT INTO payment_claims (payment_id, owner, claimed_at, lease_until) VALUES (?1, 'job', '2026-07-15T10:00:00.000Z', '2026-07-15T10:10:00.000Z')",
      )
      .bind(id)
      .run();
    refused(
      await fails("UPDATE payments SET status = 'submitting' WHERE id = ?1", id),
      "not_approved",
    );
    expect(SECONDARY_ONLY).toHaveLength(1);
  });

  it("submitting needs the switch, a live claim and nothing else is enough", async () => {
    // use a request that needs no approval
    const w2 = await payWorld({ nowMs: NOW, settings: { requireApprovalForNewIban: false } });
    w = w2;
    const id = await draft();
    await confirmRequest(db, {
      kind: "payment",
      id,
      nowMs: NOW,
      actor: w.emails.finance,
      authAtMs: NOW,
      state: await loadPaymentsState(db, TEST_IBAN_KEY),
      ibanKey: TEST_IBAN_KEY,
      phrase: paymentConfirmPhrase(100_000, "EUR", "4300"),
    });
    expect(
      (
        await db
          .prepare("SELECT status FROM payments WHERE id = ?1")
          .bind(id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("ready");
    refused(await fails("UPDATE payments SET status = 'submitting' WHERE id = ?1", id), "no_claim");
    await db
      .prepare(
        "INSERT INTO payment_claims (payment_id, owner, claimed_at, lease_until) VALUES (?1, 'job', '2026-07-15T10:00:00.000Z', '2026-07-15T10:10:00.000Z')",
      )
      .bind(id)
      .run();
    refused(await fails("DELETE FROM payment_claims"), "append_only");
    refused(await fails("UPDATE payment_claims SET owner = 'someone-else'"), "append_only");
    // a second live claim for the same request is impossible
    expect(
      await fails(
        "INSERT INTO payment_claims (payment_id, owner, claimed_at, lease_until) VALUES (?1, 'job2', 'a', 'b')",
        id,
      ),
    ).toContain("UNIQUE");
    await setSwitch(false);
    refused(
      await fails("UPDATE payments SET status = 'submitting' WHERE id = ?1", id),
      "payments_disabled",
    );
    await setSwitch(true);
    expect(
      await fails(
        "UPDATE payments SET status = 'submitting', submit_attempts = 1 WHERE id = ?1",
        id,
      ),
    ).toBe("");
  });

  it("a claim can only be taken for a request that is ready", async () => {
    const id = await draft();
    refused(
      await fails(
        "INSERT INTO payment_claims (payment_id, owner, claimed_at, lease_until) VALUES (?1, 'job', 'a', 'b')",
        id,
      ),
      "claim_subject",
    );
  });
});
