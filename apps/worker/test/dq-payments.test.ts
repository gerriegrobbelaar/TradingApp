/**
 * The payment DQ rules on D1 (Phase 9 final review S1, ADR 0053): the single loader, the job run,
 * the instant alert path, the not-available semantics, caps and query plans.
 */
import { MAX_ISSUES_PER_RULE } from "@camelthorn/core";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runAlerts } from "../src/dq/alerts";
import {
  alertSchema,
  alertsSql,
  DRAFTS_WAITING_SQL,
  IN_FLIGHT_SQL,
  OUTCOME_UNKNOWN_SQL,
  PAID_NOT_BOOKED_SQL,
  PaymentsSchemaError,
  READY_SQL,
  RECONCILE_COLUMNS_SQL,
  loadPayments,
} from "../src/dq/load-payments";
import { paymentSettlement } from "../src/payments/reconcile";
import { ctxAt, emailRows, fakeSender } from "./dq-notify-helpers";
import { db, flakyDb, issues, NOW, resetDq, ruleStatus, runDq } from "./dq-helpers";
import { addEvent, addReconcile, rawBatch, rawPayment } from "./dq-payments-helpers";
import { addTx } from "./matching-helpers";
import { withoutTriggers } from "./booking-helpers";
import { anotherBill } from "./payments-exec-helpers";
import {
  payWorld,
  setSwitch,
  SUPPLIER_IBAN,
  withoutPaymentTriggers,
  type PayWorld,
} from "./payments-helpers";

let w: PayWorld;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (agoMs: number): string => new Date(NOW - agoMs).toISOString();
const RULES = [
  "payments.outcome_unknown_old",
  "payments.alert_open",
  "payments.paid_not_booked",
  "payments.ready_not_sent",
  "payments.draft_waiting_long",
  "payments.disabled_with_inflight",
];
/** The column read as if only migration 0029 were applied (true here, and after 0030 too). */
const LEGACY_COLUMNS_SQL = `${RECONCILE_COLUMNS_SQL} WHERE name NOT IN ('alert_kind', 'alert_ack_at', 'alert_ack_by')`;
const open = async (rule: string) =>
  (await issues(`rule_id = '${rule}' AND status = 'open'`)).sort((a, b) => a.id - b.id);

/** A request in `status` since `agoMs`, with its entering event. */
async function request(
  status: string,
  agoMs: number,
  o: { batch?: boolean; mode?: "drafts" | "pay"; item?: number } = {},
): Promise<number> {
  const itemId = o.item ?? (await anotherBill(w));
  const t = at(agoMs);
  const id = o.batch
    ? await rawBatch(w, {
        status,
        mode: o.mode ?? "drafts",
        createdAt: at(agoMs + HOUR),
        updatedAt: t,
      })
    : await rawPayment(w, {
        status,
        mode: o.mode ?? "drafts",
        itemId,
        createdAt: at(agoMs + HOUR),
        updatedAt: t,
      });
  await addEvent(o.batch ? { batch: id } : { payment: id }, status, t);
  return id;
}

beforeEach(async () => {
  await resetDq();
  w = await payWorld({ nowMs: NOW });
});

describe("with no payment rows", () => {
  it("every payment rule is ok (never not_available) and nothing is opened", async () => {
    const res = await runDq();
    expect(res.status).toBe("ok");
    for (const r of RULES) {
      const s = await ruleStatus(r, 0);
      expect(s?.status, r).toBe("ok");
      expect(s?.issue_count, r).toBe(0);
    }
    expect(await issues("rule_id LIKE 'payments.%'")).toEqual([]);
  });
});

describe("payments.outcome_unknown_old", () => {
  it("opens a critical issue after 30 minutes only, for payments and batches, not for batch items", async () => {
    const old = await request("outcome_unknown", 45 * MIN);
    const exactly = await request("outcome_unknown", 30 * MIN);
    const fresh = await request("outcome_unknown", 10 * MIN);
    const batch = await request("outcome_unknown", 2 * HOUR, { batch: true });
    const item = await rawPayment(w, {
      status: "outcome_unknown",
      itemId: await anotherBill(w),
      batchId: batch,
      createdAt: at(3 * HOUR),
      updatedAt: at(2 * HOUR),
    });
    await runDq();
    const rows = await open("payments.outcome_unknown_old");
    expect(rows.map((r) => r.subject).sort()).toEqual([`Batch ${batch}`, `Payment ${old}`].sort());
    expect(rows.every((r) => r.severity === "critical" && r.division_id === 0)).toBe(true);
    expect(rows.every((r) => r.amount_minor !== null && r.currency === "EUR")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(`Payment ${exactly}"`);
    expect([fresh, item].length).toBe(2);
    expect(JSON.stringify(rows)).not.toContain(SUPPLIER_IBAN);
  });

  it("resolves itself once the request leaves the state, and a rerun changes nothing", async () => {
    const id = await request("outcome_unknown", 90 * MIN);
    await runDq();
    const first = await open("payments.outcome_unknown_old");
    expect(first).toHaveLength(1);
    await runDq();
    expect((await open("payments.outcome_unknown_old")).map((r) => r.id)).toEqual([first[0]?.id]);
    await withoutPaymentTriggers(["payments_guard_status", "payments_guard_final"], async () => {
      await db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?1").bind(id).run();
    });
    await runDq();
    expect(await open("payments.outcome_unknown_old")).toEqual([]);
  });

  it("dates the state from its event, not from the row's last touch", async () => {
    // Updated a minute ago (any update bumps updated_at) but unknown for two hours.
    const itemId = await anotherBill(w);
    const id = await rawPayment(w, {
      status: "outcome_unknown",
      itemId,
      createdAt: at(5 * HOUR),
      updatedAt: at(MIN),
    });
    await addEvent({ payment: id }, "outcome_unknown", at(2 * HOUR));
    await runDq();
    expect(await open("payments.outcome_unknown_old")).toHaveLength(1);
  });
});

describe("payments.alert_open", () => {
  it("opens one critical issue per open alert, with the alert kind in the subject", async () => {
    const kinds = ["approved_after_expiry", "reverted_after_paid", "mismatch", "duplicate"];
    const ids: number[] = [];
    for (const k of kinds) {
      const id = await request("failed", DAY);
      ids.push(id);
      await addReconcile("payment", id, k, at(HOUR));
    }
    const quiet = await request("submitted", DAY);
    await addReconcile("payment", quiet, "pending", at(HOUR)); // alert_at set earlier, result moved on
    const noAlert = await request("submitted", DAY);
    await addReconcile("payment", noAlert, "mismatch", null);
    const batch = await request("outcome_unknown", DAY, { batch: true });
    await addReconcile("batch", batch, "mismatch", at(HOUR));
    // The 0029 meaning, also once 0030 is applied (the column read is made to see 0029 only).
    await runDq({}, { ...env, DB: schemaDb(LEGACY_COLUMNS_SQL) });
    const rows = await open("payments.alert_open");
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.severity === "critical")).toBe(true);
    const text = rows.map((r) => r.subject).join("|");
    for (const label of [
      "approved after expiry",
      "reverted after paid",
      "does not match",
      "duplicate",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toContain(`Batch ${batch}`);
    expect(JSON.stringify(rows)).not.toContain(SUPPLIER_IBAN);
    expect(JSON.stringify(rows)).not.toMatch(/[A-Z]{2}\d{2}[A-Z0-9]{10,}/);
  });

  it("reads the alert schema of the database", async () => {
    expect(["legacy", "acknowledged"]).toContain(await alertSchema(db));
    expect(await alertSchema(schemaDb(LEGACY_COLUMNS_SQL))).toBe("legacy");
  });
});

/** The database as if a column of payment_reconcile were missing (or one were added). */
function schemaDb(rewrite: string): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => target.prepare(sql === RECONCILE_COLUMNS_SQL ? rewrite : sql);
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

describe("review F9b: the alert columns are read, never assumed", () => {
  const ACK_COLS = ["alert_kind", "alert_ack_at", "alert_ack_by"];
  /** Adds the 0030 (F9a) columns when they are not there yet; drops them again afterwards. */
  async function withAckColumns(fn: () => Promise<void>): Promise<void> {
    const before = await alertSchema(db);
    if (before === "legacy") {
      for (const c of ACK_COLS)
        await db.prepare(`ALTER TABLE payment_reconcile ADD COLUMN ${c} TEXT`).run();
    }
    try {
      expect(await alertSchema(db)).toBe("acknowledged");
      await fn();
    } finally {
      if (before === "legacy") {
        await db.prepare("DELETE FROM payment_reconcile").run();
        for (const c of ACK_COLS)
          await db.prepare(`ALTER TABLE payment_reconcile DROP COLUMN ${c}`).run();
      }
    }
  }

  it.each([
    ["alert_at missing", `${RECONCILE_COLUMNS_SQL} WHERE name <> 'alert_at'`],
    ["last_result missing", `${RECONCILE_COLUMNS_SQL} WHERE name <> 'last_result'`],
    ["the table missing", "SELECT name FROM pragma_table_info('no_such_table')"],
    ["only one 0030 column", `${LEGACY_COLUMNS_SQL} UNION ALL SELECT 'alert_ack_at'`],
    ["only the other 0030 column", `${LEGACY_COLUMNS_SQL} UNION ALL SELECT 'alert_kind'`],
  ])(
    "%s: the loader refuses, the rules are not_available and open issues stay",
    async (_n, sql) => {
      const id = await request("failed", DAY);
      await addReconcile("payment", id, "mismatch", at(HOUR));
      await runDq();
      expect(await open("payments.alert_open")).toHaveLength(1);
      await expect(loadPayments(schemaDb(sql), NOW)).rejects.toBeInstanceOf(PaymentsSchemaError);
      const res = await runDq({}, { ...env, DB: schemaDb(sql) });
      expect(res.status).toBe("partial");
      for (const r of RULES) {
        const s = await ruleStatus(r, 0);
        expect(s?.status, r).toBe("not_available");
        expect(s?.reason, r).toBe("payments_not_loaded");
      }
      expect(await open("payments.alert_open")).toHaveLength(1);
    },
  );

  it("with the 0030 columns an alert is open until acknowledged, whatever the last result says", async () => {
    await withAckColumns(async () => {
      const gone = await request("submitted", DAY);
      const moved = await request("submitted", DAY);
      const acked = await request("failed", DAY);
      const future = await request("failed", DAY);
      const set = (id: number, last: string, kind: string | null, ack: string | null) =>
        db
          .prepare(
            `INSERT INTO payment_reconcile (subject_kind, subject_id, first_checked_at, last_checked_at, last_result,
               alert_at, alert_kind, alert_ack_at)
             VALUES ('payment', ?1, ?2, ?2, ?3, ?2, ?4, ?5)`,
          )
          .bind(id, at(HOUR), last, kind, ack)
          .run();
      await set(gone, "not_found", "draft_gone", null); // last_result is no alert result
      await set(moved, "error", "mismatch", null); // a later transient error does not close it
      await set(acked, "approved_after_expiry", "approved_after_expiry", at(MIN));
      await set(future, "mismatch", "some_new_kind", null); // a kind without a label
      await runDq();
      const rows = await open("payments.alert_open");
      const text = rows.map((r) => r.subject).join("|");
      expect(rows).toHaveLength(3);
      expect(text).toContain(`Payment ${gone} · draft no longer in Revolut`);
      expect(text).toContain(`Payment ${moved} · bank data does not match`);
      expect(text).toContain(`Payment ${future} · alert that needs a look`);
      expect(text).not.toContain(`Payment ${acked} `);
      // acknowledging resolves the issue on the next run
      await db
        .prepare("UPDATE payment_reconcile SET alert_ack_at = ?2 WHERE subject_id = ?1")
        .bind(gone, at(0))
        .run();
      await runDq();
      expect((await open("payments.alert_open")).map((r) => r.subject).join("|")).not.toContain(
        `Payment ${gone} `,
      );
      expect(await open("payments.alert_open")).toHaveLength(2);
    });
  });

  it("the alert query plan is the same in both schemas (one scan of payment_reconcile only)", async () => {
    for (const schema of ["legacy", "acknowledged"] as const) {
      expect(alertsSql(schema)).toContain("payment_reconcile r");
    }
    expect(alertsSql("acknowledged")).toContain("alert_ack_at IS NULL");
    expect(alertsSql("legacy")).not.toContain("alert_ack_at");
  });
});

describe("payments.paid_not_booked", () => {
  it("lists a payment paid more than three days ago whose Exact side is not booked, with its stage", async () => {
    const noLine = await request("paid", 4 * DAY);
    const recent = await request("paid", 2 * DAY);
    await runDq();
    const rows = await open("payments.paid_not_booked");
    expect(rows.map((r) => r.subject)).toEqual([`Payment ${noLine}`]);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({ stage: "awaiting_bank_line" });
    expect(rows[0]?.severity).toBe("warning");
    expect(recent).toBeGreaterThan(0);
  });

  it("agrees with paymentSettlement on every stage, match_other_invoice included (booked is the only one left out)", async () => {
    const mk = async (): Promise<{ id: number; txId: number; item: number }> => {
      const item = await anotherBill(w);
      const id = await rawPayment(w, {
        status: "paid",
        itemId: item,
        amountMinor: 100_000,
        createdAt: at(9 * DAY),
      });
      await addEvent({ payment: id }, "paid", at(5 * DAY));
      const txId = await addTx({
        connectionId: w.revolutConnectionId,
        accountId: w.accountId,
        amountMinor: -100_000,
      });
      return { id, txId, item };
    };
    const link = (p: { id: number; txId: number }) =>
      db
        .prepare(
          "INSERT INTO payment_bank_links (payment_id, bank_transaction_id, via) VALUES (?1, ?2, 'request_id')",
        )
        .bind(p.id, p.txId)
        .run();
    const match = async (p: { txId: number; item: number }, state?: string) => {
      const m = await db
        .prepare(
          "INSERT INTO matches (bank_transaction_id, division_id, source, amount_minor, currency, created_by) VALUES (?1, ?2, 'manual', 100000, 'EUR', 'x@camelthorncapital.com')",
        )
        .bind(p.txId, w.divisionId)
        .run();
      await db
        .prepare(
          "INSERT INTO match_allocations (match_id, open_item_id, allocated_minor, currency) VALUES (?1, ?2, 100000, 'EUR')",
        )
        .bind(m.meta.last_row_id, p.item)
        .run();
      if (state !== undefined) {
        await withoutTriggers(
          [
            "matches_guard_exact_state",
            "matches_guard_update",
            "matches_guard_booked_at",
            "matches_guard_manually_booked",
          ],
          async () => {
            await db
              .prepare("UPDATE matches SET exact_state = ?2 WHERE id = ?1")
              .bind(m.meta.last_row_id, state)
              .run();
          },
        );
      }
    };
    const a = await mk(); // no bank line
    const b = await mk(); // line, no match
    await link(b);
    const c = await mk(); // line + match not in Exact
    await link(c);
    await match(c);
    const d = await mk(); // booked
    await link(d);
    await match(d, "matched_in_exact");
    const e = await mk(); // line matched (and booked) to ANOTHER invoice (review F9b)
    await link(e);
    await match({ txId: e.txId, item: await anotherBill(w) }, "matched_in_exact");
    expect(await paymentSettlement(db, a.id)).toBe("awaiting_bank_line");
    expect(await paymentSettlement(db, b.id)).toBe("awaiting_match");
    expect(await paymentSettlement(db, c.id)).toBe("awaiting_booking");
    expect(await paymentSettlement(db, d.id)).toBe("booked");
    expect(await paymentSettlement(db, e.id)).toBe("match_other_invoice");
    const loaded = await loadPayments(db, NOW);
    const byId = new Map(loaded.paidNotBooked.map((r) => [r.id, r.stage]));
    expect(byId.get(a.id)).toBe("awaiting_bank_line");
    expect(byId.get(b.id)).toBe("awaiting_match");
    expect(byId.get(c.id)).toBe("awaiting_booking");
    expect(byId.has(d.id)).toBe(false);
    expect(byId.get(e.id)).toBe("match_other_invoice");
    await runDq();
    const msg = (await open("payments.paid_not_booked")).find(
      (r) => r.subject === `Payment ${e.id}`,
    );
    expect(msg?.message).toContain("matched to another invoice");
  });
});

describe("payments.ready_not_sent and payments.draft_waiting_long", () => {
  it("flags a ready request after four hours and shows how long it still lives", async () => {
    const late = await request("ready", 5 * HOUR);
    await request("ready", 3 * HOUR);
    await runDq();
    const rows = await open("payments.ready_not_sent");
    expect(rows.map((r) => r.subject)).toEqual([`Payment ${late}`]);
    expect(rows[0]?.message).toMatch(
      /^5 hours: EUR 1250\.00 approved but not sent, expires in \d+ hours?\./,
    );
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      subjectKind: "payment",
      subjectId: late,
    });
  });

  it("flags a submitted draft past half of the expiry (info), past 80 percent as a warning; pay mode never", async () => {
    const half = await request("submitted", 3 * DAY);
    const most = await request("submitted", 4.5 * DAY);
    await request("submitted", 1 * DAY);
    await request("submitted", 4.5 * DAY, { mode: "pay" });
    await runDq();
    const rows = await open("payments.draft_waiting_long");
    expect(rows.map((r) => [r.subject, r.severity]).sort()).toEqual(
      [
        [`Payment ${half}`, "info"],
        [`Payment ${most}`, "warning"],
      ].sort(),
    );
  });

  it("follows payments.draft_expiry_days", async () => {
    await db
      .prepare(
        "INSERT INTO settings (key, value_json, updated_by) VALUES ('payments.draft_expiry_days', '2', 't')",
      )
      .run();
    await request("submitted", 1.5 * DAY);
    await runDq();
    expect(await open("payments.draft_waiting_long")).toHaveLength(1);
  });
});

describe("payments.disabled_with_inflight", () => {
  it("is raised only with the switch off and requests in flight", async () => {
    await request("ready", HOUR);
    await runDq();
    expect(await open("payments.disabled_with_inflight")).toEqual([]);
    await setSwitch(false);
    await runDq();
    const rows = await open("payments.disabled_with_inflight");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toMatch(/^1 payment request is in flight/);
    await setSwitch(true);
    await runDq();
    expect(await open("payments.disabled_with_inflight")).toEqual([]);
  });

  it("is quiet with the switch off and nothing in flight (final states do not count)", async () => {
    await request("paid", 5 * DAY);
    await request("failed", 5 * DAY);
    await setSwitch(false);
    await runDq();
    expect(await open("payments.disabled_with_inflight")).toEqual([]);
    expect((await ruleStatus("payments.disabled_with_inflight", 0))?.status).toBe("ok");
  });
});

describe("failure and caps", () => {
  it("a failing read makes the rules not_available, the run partial, and resolves nothing", async () => {
    await request("outcome_unknown", 2 * HOUR);
    await runDq();
    expect(await open("payments.outcome_unknown_old")).toHaveLength(1);
    const res = await runDq({}, { ...env, DB: flakyDb("payment_events") });
    expect(res.status).toBe("partial");
    for (const r of RULES) {
      const s = await ruleStatus(r, 0);
      expect(s?.status, r).toBe("not_available");
      expect(s?.reason, r).toBe("payments_not_loaded");
    }
    expect(await open("payments.outcome_unknown_old")).toHaveLength(1);
  });

  it("reads at most the cap per list and reports the cut", async () => {
    await withoutPaymentTriggers(["payments_guard_insert"], async () => {
      await db
        .prepare(
          `INSERT INTO payments (request_id, division_id, open_item_id, bank_account_id, status, mode, amount_minor,
             currency, beneficiary_name, beneficiary_iban, iban_fingerprint, reference, payload_hash, requested_by,
             expires_at, created_at)
           WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_ISSUES_PER_RULE + 20})
           SELECT '00000000-0000-4000-9000-' || printf('%012d', i), ?1, ?2, ?3, 'paid', 'drafts', 1000, 'EUR', 'X',
                  ?4, ?5, 'r', ?6, 'f@camelthorncapital.com', '2026-01-02T00:00:00.000Z',
                  strftime('%Y-%m-%dT%H:%M:%fZ', ?7, '-' || i || ' seconds')
           FROM n`,
        )
        .bind(
          w.divisionId,
          w.itemId,
          w.accountId,
          SUPPLIER_IBAN,
          "c".repeat(64),
          "d".repeat(64),
          at(5 * DAY),
        )
        .run();
    });
    const loaded = await loadPayments(db, NOW);
    expect(loaded.paidNotBooked).toHaveLength(MAX_ISSUES_PER_RULE);
    expect(loaded.capped.paidNotBooked).toBe(true);
    expect(loaded.capped.ready).toBe(false);
    await runDq();
    const s = await ruleStatus("payments.paid_not_booked", 0);
    expect(s?.status).toBe("issues");
    expect(s?.issue_count).toBe(MAX_ISSUES_PER_RULE);
  });

  it("every query is index-backed: status and time, never a scan of the payment tables", async () => {
    const plan = async (sql: string, ...binds: string[]): Promise<string> =>
      (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...binds)
          .all<{ detail: string }>()
      ).results
        .map((r) => r.detail)
        .join("\n");
    for (const [name, sql, binds] of [
      ["outcome unknown", OUTCOME_UNKNOWN_SQL, []],
      ["ready", READY_SQL, []],
      ["drafts", DRAFTS_WAITING_SQL, []],
      ["paid", PAID_NOT_BOOKED_SQL, ["2026-01-01T00:00:00.000Z"]],
      ["in flight", IN_FLIGHT_SQL, []],
    ] as const) {
      const p = await plan(sql, ...binds);
      expect(p, name).toContain("idx_payments_status");
      expect(p, name).not.toMatch(/SCAN (payments|payment_batches)\b/);
    }
    expect(await plan(OUTCOME_UNKNOWN_SQL)).toContain("idx_payment_batches_status");
    // The one deliberate scan: payment_reconcile (one row per request that was ever sent, no index on
    // alert_at and no migration allowed); its subqueries are primary-key lookups.
    const alerts = await plan(alertsSql("legacy"));
    expect(alerts).toMatch(/SCAN r\b/);
    expect(alerts).not.toMatch(/SCAN (payments|payment_batches)\b/);
  });
});

describe("the instant alert path", () => {
  it("mails the critical payment issues to admin and finance, without an IBAN", async () => {
    const id = await request("outcome_unknown", 2 * HOUR);
    const failed = await request("failed", DAY);
    await addReconcile("payment", failed, "reverted_after_paid", at(HOUR));
    await request("ready", 6 * HOUR); // a warning: no instant mail
    await runDq();
    const s = fakeSender();
    const out = await runAlerts(ctxAt(), 1, { sender: s });
    expect(out.skipped).toBeNull();
    const body = JSON.stringify(s.sent);
    expect(body).toContain("unknown outcome");
    expect(body).toContain("reverted after paid");
    expect(body).not.toContain("approved but not sent");
    expect(body).not.toContain(SUPPLIER_IBAN);
    expect(body).toContain("tab=payments");
    expect((await emailRows()).length).toBeGreaterThan(0);
    expect(id).toBeGreaterThan(0);
  });
});

describe("review F9b: one mail per payment alert, no IBAN, keyed per issue row", () => {
  it("reruns of the checks and the alerts never mail the same issue twice", async () => {
    const unknown = await request("outcome_unknown", 2 * HOUR);
    const mism = await request("submitted", DAY);
    await addReconcile("payment", mism, "mismatch", at(HOUR));
    await runDq();
    const s = fakeSender();
    await runAlerts(ctxAt(), 1, { sender: s });
    const firstCalls = s.calls;
    expect(firstCalls).toBeGreaterThan(0);
    const keys = (await emailRows()).map((r) => r.idempotency_key);
    const rows = [
      ...(await open("payments.outcome_unknown_old")),
      ...(await open("payments.alert_open")),
    ];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const n = await db
        .prepare("SELECT notified_at FROM dq_issues WHERE id = ?1")
        .bind(r.id)
        .first<{ notified_at: string | null }>();
      expect(n?.notified_at, `issue ${r.id} marked`).not.toBeNull();
      expect(keys.some((k) => k.startsWith(`dq-alert:${r.id}:`))).toBe(true);
    }
    for (let i = 0; i < 3; i++) {
      await runDq();
      await runAlerts(ctxAt(), 2 + i, { sender: s });
    }
    expect(s.calls).toBe(firstCalls);
    const body = JSON.stringify(s.sent);
    expect(body).not.toContain(SUPPLIER_IBAN);
    expect(body).not.toMatch(/NL\d{2}[A-Z]{4}\d{6,}/);
    expect(body).not.toContain("Acme Supplies");
    expect(body).not.toContain("Invoice 1");
    expect(unknown).toBeGreaterThan(0);
  });
});
