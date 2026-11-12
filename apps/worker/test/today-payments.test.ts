/**
 * Payment items in the Today queue (Phase 9 final review S2, ADR 0053): who sees what, own requests,
 * expiry, batches, ranking and cursor stability, no duplicate with the DQ issue of the same
 * payment, bounded cost, no IBAN, and a mutation self-check of the invariants.
 */
import { type TodayItemDto, type TodayResponse } from "@camelthorn/core";
import { beforeEach, describe, expect, it } from "vitest";
import { addSession, addUser, authed } from "./helpers";
import { db, resetDq } from "./dq-helpers";
import { rawBatch, rawPayment } from "./dq-payments-helpers";
import { anotherBill } from "./payments-exec-helpers";
import { payWorld, SUPPLIER_IBAN, withoutPaymentTriggers, type PayWorld } from "./payments-helpers";
import {
  DQ_COUNT_SQL,
  DQ_SQL,
  PAYMENT_APPROVAL_COUNT_SQL,
  PAYMENT_APPROVAL_SQL,
  PAYMENT_READY_COUNT_SQL,
  PAYMENT_READY_SQL,
  TODAY_SOURCE_CAP,
} from "../src/today/routes";

let w: PayWorld;
let both: string;
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const get = async (token: string, extra = ""): Promise<{ status: number; body: TodayResponse }> => {
  const res = await authed(`/api/today?division=${w.divisionId}${extra}`, token);
  return { status: res.status, body: (await res.json()) as TodayResponse };
};
const ids = (r: TodayResponse, kind?: string): string[] =>
  r.items.filter((i) => kind === undefined || i.kind === kind).map((i) => i.id);

async function pending(o: { by?: string; ageMs?: number; batch?: boolean } = {}): Promise<number> {
  const created = ago(o.ageMs ?? HOUR);
  const status = "pending_approval";
  return o.batch
    ? rawBatch(w, { status, createdAt: created, requestedBy: o.by ?? w.emails.finance })
    : rawPayment(w, {
        status,
        createdAt: created,
        requestedBy: o.by ?? w.emails.finance,
        itemId: await anotherBill(w),
      });
}
async function ready(o: { ageMs?: number; batch?: boolean } = {}): Promise<number> {
  const created = ago(o.ageMs ?? 6 * HOUR);
  return o.batch
    ? rawBatch(w, { status: "ready", createdAt: created })
    : rawPayment(w, { status: "ready", createdAt: created, itemId: await anotherBill(w) });
}

let n = 0;
async function addIssue(o: {
  rule: string;
  payload?: string;
  severity?: "warning" | "critical";
}): Promise<number> {
  n += 1;
  const r = await db
    .prepare(
      `INSERT INTO dq_issues (division_id, rule_id, fingerprint, area, severity, status, subject, message, fix,
         payload_json, first_seen_at, last_seen_at)
       VALUES (0, ?1, ?2, 'bank', ?3, 'open', 'Payment', 'An issue', 'payments', ?4, ?5, ?5)`,
    )
    .bind(o.rule, `${o.rule}:${n}`, o.severity ?? "warning", o.payload ?? "{}", ago(2 * HOUR))
    .run();
  return r.meta.last_row_id;
}

beforeEach(async () => {
  await resetDq();
  w = await payWorld();
  both = await addSession(await addUser("both@camelthorncapital.com", ["finance", "approver"]));
});

describe("who sees what", () => {
  it("an approver sees the requests of others waiting for approval, never their own, and no ready items", async () => {
    const others = await pending();
    const own = await pending({ by: w.emails.approver });
    await ready();
    const r = (await get(w.tokens.approver)).body;
    expect(ids(r, "payment_approval")).toEqual([`payment_approval:${others}`]);
    expect(ids(r)).not.toContain(`payment_approval:${own}`);
    expect(ids(r, "payment_ready")).toEqual([]);
    expect(r.counts.payment_approval).toBe(1);
    expect(r.counts.payment_ready).toBe(0);
    // the same request is a candidate for the other approver
    expect(ids((await get(w.tokens.approver2)).body, "payment_approval").sort()).toEqual(
      [`payment_approval:${others}`, `payment_approval:${own}`].sort(),
    );
  });

  it("finance sees ready requests (payments and batches), approvers' items stay hidden from them", async () => {
    const p = await ready();
    const b = await ready({ batch: true });
    await pending();
    const r = (await get(w.tokens.finance)).body;
    expect(ids(r, "payment_ready").sort()).toEqual(
      [`payment_ready:${p}`, `payment_ready:batch-${b}`].sort(),
    );
    expect(ids(r, "payment_approval")).toEqual([]);
    expect(r.counts.payment_ready).toBe(2);
  });

  it("admin and viewer see neither; a user with both roles sees both", async () => {
    const a = await pending();
    const b = await ready();
    for (const t of [w.tokens.admin, w.tokens.viewer]) {
      const r = (await get(t)).body;
      expect(ids(r).filter((i) => i.startsWith("payment_"))).toEqual([]);
      expect(r.counts.payment_approval + r.counts.payment_ready).toBe(0);
    }
    const r = (await get(both)).body;
    expect(ids(r, "payment_approval")).toEqual([`payment_approval:${a}`]);
    expect(ids(r, "payment_ready")).toEqual([`payment_ready:${b}`]);
  });

  it("their own request is excluded for a user with both roles too", async () => {
    await pending({ by: "both@camelthorncapital.com" });
    expect(ids((await get(both)).body, "payment_approval")).toEqual([]);
  });

  it("actions follow the role: open for the approver and for finance", async () => {
    await pending();
    await ready();
    const a = (await get(w.tokens.approver)).body.items.find((i) => i.kind === "payment_approval");
    expect(a?.actions).toEqual(["open"]);
    const f = (await get(w.tokens.finance)).body.items.find((i) => i.kind === "payment_ready");
    expect(f?.actions).toEqual(["open"]);
    expect(a?.fixPath).toBe("/purchases/approvals?tab=payments");
    expect(f?.fixPath).toBe("/treasury/bank?tab=payments");
  });

  it("another administration's requests never show", async () => {
    await db
      .prepare(
        "INSERT INTO divisions (connection_id, exact_division, name, sync_enabled) SELECT id, 777, 'Other', 0 FROM connections WHERE kind = 'exact' LIMIT 1",
      )
      .run();
    const other = (await db
      .prepare("SELECT id FROM divisions WHERE exact_division = 777")
      .first<{ id: number }>())!.id;
    await rawPayment(w, {
      status: "pending_approval",
      divisionId: other,
      itemId: await anotherBill(w),
      createdAt: ago(HOUR),
    });
    expect(ids((await get(w.tokens.approver)).body, "payment_approval")).toEqual([]);
  });
});

describe("what an item says", () => {
  it("leads with the age, counts down the 24 hour validity, and carries minor units and currency", async () => {
    const id = await pending({ ageMs: 2 * HOUR });
    const r = (await get(w.tokens.approver)).body;
    const item = r.items.find((i) => i.id === `payment_approval:${id}`) as TodayItemDto;
    expect(item.title).toBe("2 hours waiting for a second approver");
    expect(item.subtitle).toBe(`Payment ${id} · expires in 22 hours`);
    expect(item.amountMinor).toBe(125_000);
    expect(item.currency).toBe("EUR");
    expect(item.priority).toBe(85);
    expect(item.severity).toBe("warning");
    expect(item.issueId).toBeNull();
    const rid = await ready({ ageMs: 5 * HOUR });
    const f = (await get(w.tokens.finance)).body.items.find((i) => i.id === `payment_ready:${rid}`);
    expect(f?.title).toBe("5 hours since approval, not sent");
    expect(f?.priority).toBe(70);
  });

  it("does not list an expired request, nor the items of a batch, and says so for a batch", async () => {
    const expired = await rawPayment(w, {
      status: "pending_approval",
      createdAt: ago(30 * HOUR),
      expiresAt: ago(6 * HOUR),
      itemId: await anotherBill(w),
    });
    const batch = await pending({ batch: true });
    await rawPayment(w, {
      status: "pending_approval",
      batchId: batch,
      createdAt: ago(HOUR),
      itemId: await anotherBill(w),
    });
    const r = (await get(w.tokens.approver)).body;
    expect(ids(r, "payment_approval")).toEqual([`payment_approval:batch-${batch}`]);
    expect(ids(r)).not.toContain(`payment_approval:${expired}`);
    expect(r.items[0]?.subtitle).toMatch(/^Batch \d+ · expires in 23 hours$/);
  });

  it("no IBAN, fingerprint or requester e-mail leaves the endpoint", async () => {
    await pending();
    await ready();
    for (const t of [w.tokens.approver, w.tokens.finance, both]) {
      const text = JSON.stringify((await get(t)).body);
      expect(text).not.toContain(SUPPLIER_IBAN);
      expect(text).not.toContain("NL91");
      expect(text).not.toContain("c".repeat(64));
      expect(text).not.toContain("camelthorncapital.com");
    }
  });
});

describe("one payment, one item (no DQ duplicate)", () => {
  const issue = (kind: "payment" | "batch", id: number) =>
    addIssue({
      rule: "payments.ready_not_sent",
      payload: JSON.stringify({ subjectKind: kind, subjectId: id }),
    });

  it("hides the ready-not-sent issue from the viewer of the payment item only", async () => {
    const p = await ready();
    const b = await ready({ batch: true });
    const ip = await issue("payment", p);
    const ib = await issue("batch", b);
    const fin = (await get(w.tokens.finance)).body;
    expect(ids(fin, "payment_ready")).toHaveLength(2);
    expect(ids(fin, "dq")).toEqual([]);
    expect(fin.counts.dq).toBe(0);
    for (const t of [w.tokens.viewer, w.tokens.approver, w.tokens.admin]) {
      const r = (await get(t)).body;
      expect(ids(r, "dq").sort(), "no payment item for this role").toEqual(
        [`dq:${ip}`, `dq:${ib}`].sort(),
      );
      expect(r.counts.dq).toBe(2);
    }
  });

  it("keeps the issue when its payment is not a ready item (paid, or another one)", async () => {
    const paid = await rawPayment(w, { status: "paid", createdAt: ago(9 * HOUR) });
    const i1 = await issue("payment", paid);
    const i2 = await issue("payment", 99_999);
    const i3 = await addIssue({ rule: "payments.ready_not_sent" }); // no readable subject
    const r = (await get(w.tokens.finance)).body;
    expect(ids(r, "dq").sort()).toEqual([`dq:${i1}`, `dq:${i2}`, `dq:${i3}`].sort());
  });

  it("other payment issues are not hidden", async () => {
    const id = await ready();
    const unknown = await addIssue({
      rule: "payments.outcome_unknown_old",
      severity: "critical",
      payload: JSON.stringify({ subjectKind: "payment", subjectId: id }),
    });
    const r = (await get(w.tokens.finance)).body;
    expect(ids(r, "dq")).toEqual([`dq:${unknown}`]);
    expect(ids(r, "payment_ready")).toEqual([`payment_ready:${id}`]);
  });
});

describe("ranking and cursor stability", () => {
  it("orders by priority, oldest first, and pages without gaps or repeats when new items arrive", async () => {
    const crit = await addIssue({ rule: "payments.alert_open", severity: "critical" });
    const warn = await addIssue({ rule: "payments.paid_not_booked" });
    for (let i = 0; i < 7; i++) await pending({ ageMs: (20 - i) * HOUR + i * 1000 });
    for (let i = 0; i < 4; i++) await ready({ ageMs: (12 - i) * HOUR });
    const all = (await get(both, "&limit=50")).body;
    const order = ids(all);
    expect(order[0]).toBe(`dq:${crit}`); // 90
    expect(order.slice(1, 8).every((i) => i.startsWith("payment_approval:"))).toBe(true); // 85
    expect(order.slice(8, 12).every((i) => i.startsWith("payment_ready:"))).toBe(true); // 70
    expect(order[12]).toBe(`dq:${warn}`); // 60
    // oldest first inside a kind
    const sinces = all.items.filter((i) => i.kind === "payment_approval").map((i) => i.since);
    expect(sinces).toEqual([...sinces].sort());
    for (const size of [1, 2, 3, 5]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 30; guard++) {
        const q: string = `&limit=${size}${cursor === null ? "" : `&cursor=${cursor}`}`;
        const page: TodayResponse = (await get(both, q)).body;
        seen.push(...ids(page));
        cursor = page.nextCursor;
        if (cursor === null) break;
        if (guard === 0 && size === 2) await pending({ ageMs: 40 * HOUR }); // oldest of all arrives
      }
      expect(new Set(seen).size, `size ${size}: no repeats`).toBe(seen.length);
      for (const id of order) expect(seen, `size ${size}`).toContain(id);
    }
  });

  it("reads at most the cap, reports the cut, and serves a true prefix", async () => {
    await withoutPaymentTriggers(["payment_batches_guard_insert"], async () => {
      await db
        .prepare(
          `INSERT INTO payment_batches (request_id, division_id, bank_account_id, status, mode, currency,
             total_minor, item_count, payload_hash, requested_by, expires_at, created_at)
           WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${TODAY_SOURCE_CAP + 15})
           SELECT '00000000-0000-4000-9000-' || printf('%012d', i), ?1, ?2, 'pending_approval', 'drafts', 'EUR',
                  1000, 2, ?3, 'f@camelthorncapital.com', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+20 hours'),
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours', '-' || i || ' seconds')
           FROM n`,
        )
        .bind(w.divisionId, w.accountId, "e".repeat(64))
        .run();
    });
    const first = (await get(w.tokens.approver, "&limit=50")).body;
    expect(first.counts.payment_approval).toBe(TODAY_SOURCE_CAP + 15);
    expect(first.capped).toBe(true);
    expect(first.cappedKinds).toContain("payment_approval");
    let seen: string[] = ids(first);
    let cursor = first.nextCursor;
    for (let guard = 0; cursor !== null && guard < 10; guard++) {
      const page = (await get(w.tokens.approver, `&limit=50&cursor=${cursor}`)).body;
      seen = seen.concat(ids(page));
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(TODAY_SOURCE_CAP);
    expect(new Set(seen).size).toBe(TODAY_SOURCE_CAP);
  });
});

describe("cost", () => {
  const plan = async (sql: string, ...binds: (number | string)[]): Promise<string> =>
    (
      await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...binds)
        .all<{ detail: string }>()
    ).results
      .map((r) => r.detail)
      .join("\n");

  it("finds requests by status and time through the existing indexes; only that set is sorted", async () => {
    const t = "2026-01-01T00:00:00.000Z";
    for (const [name, sql, binds] of [
      ["approval", PAYMENT_APPROVAL_SQL, [1, "a@b.nl", t]],
      ["approval count", PAYMENT_APPROVAL_COUNT_SQL, [1, "a@b.nl", t]],
      ["ready", PAYMENT_READY_SQL, [1, t]],
      ["ready count", PAYMENT_READY_COUNT_SQL, [1, t]],
    ] as const) {
      const p = await plan(sql, ...binds);
      expect(p, name).toContain("idx_payments_status");
      expect(p, name).toContain("idx_payment_batches_status");
      expect(p, name).not.toMatch(/SCAN (payments|payment_batches)\b/);
    }
  });

  it("the DQ query still uses its index with the payment skip", async () => {
    const p = await plan(DQ_SQL, 1, 1, "2026-01-01T00:00:00.000Z");
    expect(p).toContain("idx_dq_issues_list");
    expect(await plan(DQ_COUNT_SQL, 1, 1, "2026-01-01T00:00:00.000Z")).toContain(
      "idx_dq_issues_list",
    );
  });
});

describe("mutation self-check: the invariants fail when the guard is removed", () => {
  // Rows: one good request and one that breaks each invariant.
  async function seed(): Promise<
    Record<"good" | "own" | "expired" | "batchItem" | "elsewhere", number>
  > {
    const good = await pending();
    const own = await pending({ by: w.emails.approver });
    const expired = await rawPayment(w, {
      status: "pending_approval",
      createdAt: ago(30 * HOUR),
      expiresAt: ago(HOUR),
      itemId: await anotherBill(w),
    });
    const batch = await pending({ batch: true });
    const batchItem = await rawPayment(w, {
      status: "pending_approval",
      batchId: batch,
      createdAt: ago(HOUR),
      itemId: await anotherBill(w),
    });
    await db
      .prepare(
        "INSERT INTO divisions (connection_id, exact_division, name, sync_enabled) SELECT id, 777, 'Other', 0 FROM connections WHERE kind = 'exact' LIMIT 1",
      )
      .run();
    const other = (await db
      .prepare("SELECT id FROM divisions WHERE exact_division = 777")
      .first<{ id: number }>())!.id;
    const elsewhere = await rawPayment(w, {
      status: "pending_approval",
      divisionId: other,
      createdAt: ago(HOUR),
      itemId: await anotherBill(w),
    });
    return { good, own, expired, batchItem, elsewhere };
  }
  const run = async (sql: string): Promise<number[]> =>
    (
      await db
        .prepare(sql)
        .bind(w.divisionId, w.emails.approver, new Date().toISOString())
        .all<{ kind: string; id: number }>()
    ).results
      .filter((r) => r.kind === "payment")
      .map((r) => r.id);

  const mutants: [string, string, string, "own" | "expired" | "batchItem" | "elsewhere"][] = [
    ["own request excluded", "AND p.requested_by <> ?2", "", "own"],
    ["expired excluded", "AND p.expires_at > ?3", "", "expired"],
    ["batch items excluded", "AND p.batch_id IS NULL", "", "batchItem"],
    ["administration bound", "p.division_id = ?1", "1 = 1", "elsewhere"],
  ];

  it("the real query holds all four invariants", async () => {
    const s = await seed();
    const got = await run(PAYMENT_APPROVAL_SQL);
    expect(got).toContain(s.good);
    for (const bad of [s.own, s.expired, s.batchItem, s.elsewhere]) expect(got).not.toContain(bad);
  });

  it.each(mutants)(
    "%s: removing the guard lets the bad row through",
    async (_n, from, to, which) => {
      const s = await seed();
      const mutated = PAYMENT_APPROVAL_SQL.replace(from, to);
      expect(mutated, "the mutation must change the query").not.toBe(PAYMENT_APPROVAL_SQL);
      expect(await run(mutated)).toContain(s[which]);
    },
  );

  it("the duplicate skip: removing it shows the DQ issue of a payment that is already an item", async () => {
    const id = await ready();
    const issueId = await addIssue({
      rule: "payments.ready_not_sent",
      payload: JSON.stringify({ subjectKind: "payment", subjectId: id }),
    });
    const cutoff = new Date(Date.now() - 7 * 24 * HOUR).toISOString();
    const run2 = async (sql: string): Promise<number[]> =>
      (await db.prepare(sql).bind(0, w.divisionId, cutoff).all<{ id: number }>()).results.map(
        (r) => r.id,
      );
    expect(await run2(DQ_SQL)).not.toContain(issueId);
    const mutated = DQ_SQL.replaceAll("'payments.ready_not_sent'", "'x.never'");
    expect(mutated).not.toBe(DQ_SQL);
    expect(await run2(mutated)).toContain(issueId);
  });
});
