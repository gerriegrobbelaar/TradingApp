/**
 * The matching API (task M7b, ADR 0042): access rules, manual match validation, undo, ignore,
 * configuration, account map, patterns, stats, shapes, IBAN masking and audit rows.
 */
import {
  type MatchAccountMapResponse,
  type MatchAutoResponse,
  type MatchCandidateDto,
  type MatchConfigResponse,
  type MatchCreateResponse,
  type MatchDetailResponse,
  type MatchDto,
  type MatchIgnoreResponse,
  type MatchItemBalancesResponse,
  type MatchPatternDto,
  type MatchQueueResponse,
  type MatchStatsResponse,
  type MatchTxDto,
  type MatchUndoResponse,
} from "@camelthorn/core";
import { beforeEach, describe, expect, it } from "vitest";
import { buildRouter } from "../src/app-router";
import { runMatching } from "../src/matching/run";
import { auditRows } from "./sync-helpers";
import { addSession, addUser, authed, call, db, resetDb } from "./helpers";
import {
  addItem,
  addRelation,
  addTx,
  CUSTOMER_IBAN,
  jobContext,
  liveMatches,
  NOW,
  OUR_IBAN,
  SUPPLIER_IBAN,
  txStatus,
  resetWorld,
  enableAuto,
  setSetting,
  SETTING_AUTO,
  SETTING_CONFIG,
  type World,
} from "./matching-helpers";

type Role = "admin" | "finance" | "approver" | "viewer";
let w: World;
const tokens = {} as Record<Role | "staleAdmin", string>;

beforeEach(async () => {
  await resetDb();
  w = await resetWorld();
  for (const role of ["admin", "finance", "approver", "viewer"] as const) {
    tokens[role] = await addSession(await addUser(`${role}@camelthorncapital.com`, [role]));
  }
  tokens.staleAdmin = await addSession(await addUser("stale@camelthorncapital.com", ["admin"]), {
    lastAuthAgoMs: 20 * 60_000,
  });
});

const tx = (o: Partial<Parameters<typeof addTx>[0]> & { amountMinor: number }) =>
  addTx({ accountId: w.accountId, connectionId: w.revolutConnectionId, ...o });

async function get<T>(
  role: Role | "staleAdmin",
  path: string,
): Promise<{ status: number; body: T }> {
  const res = await authed(path, tokens[role]);
  return { status: res.status, body: (await res.json()) as T };
}
async function send<T = Record<string, unknown>>(
  role: Role | "staleAdmin",
  method: string,
  path: string,
  json?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await authed(path, tokens[role], { method, ...(json !== undefined ? { json } : {}) });
  return { status: res.status, body: (await res.json()) as T };
}

const err = (r: { body: unknown }): unknown => (r.body as { error?: unknown }).error;

/** A relation + invoice + exactly matching bank line, then one matching run (automatic matching stays off). */
async function seedPerfect(amount = 12_345): Promise<{ itemId: number; txId: number }> {
  const rel = await addRelation({
    divisionId: w.divisionId,
    ibans: [CUSTOMER_IBAN],
    name: "Acme B.V.",
  });
  const itemId = await addItem({
    divisionId: w.divisionId,
    invoiceNumber: "INV-2026-0042",
    openMinor: amount,
    relationExactId: rel.exactId,
    relationName: "Acme B.V.",
  });
  const txId = await tx({
    amountMinor: amount,
    reference: `Payment INV-2026-0042 from ${CUSTOMER_IBAN}`,
    counterpartyIban: CUSTOMER_IBAN,
    counterpartyName: "Acme B.V.",
  });
  return { itemId, txId };
}

describe("access rules", () => {
  const routes: {
    method: string;
    path: string;
    body?: unknown;
    roles: Role[];
    stepUp?: true;
  }[] = [
    {
      method: "GET",
      path: "/api/matching/queue",
      roles: ["admin", "finance", "approver", "viewer"],
    },
    {
      method: "GET",
      path: "/api/matching/auto",
      roles: ["admin", "finance", "approver", "viewer"],
    },
    {
      method: "GET",
      path: "/api/matching/stats",
      roles: ["admin", "finance", "approver", "viewer"],
    },
    {
      method: "GET",
      path: "/api/matching/transactions/1",
      roles: ["admin", "finance", "approver", "viewer"],
    },
    {
      method: "GET",
      path: "/api/matching/items",
      roles: ["admin", "finance", "approver", "viewer"],
    },
    { method: "POST", path: "/api/matching/matches", body: {}, roles: ["admin", "finance"] },
    { method: "POST", path: "/api/matching/matches/1/undo", body: {}, roles: ["admin", "finance"] },
    {
      method: "POST",
      path: "/api/matching/transactions/1/ignore",
      body: {},
      roles: ["admin", "finance"],
    },
    {
      method: "POST",
      path: "/api/matching/transactions/1/unignore",
      body: {},
      roles: ["admin", "finance"],
    },
    {
      method: "POST",
      path: "/api/matching/transactions/1/clear-conflict",
      body: {},
      roles: ["admin"],
      stepUp: true,
    },
    // Switching automatic matching off: admin, no step-up (the safe direction).
    { method: "POST", path: "/api/matching/auto/disable", body: {}, roles: ["admin"] },
    { method: "GET", path: "/api/matching/config", roles: ["admin"] },
    { method: "PUT", path: "/api/matching/config", body: {}, roles: ["admin"], stepUp: true },
    { method: "GET", path: "/api/matching/account-map", roles: ["admin"] },
    { method: "PUT", path: "/api/matching/account-map", body: {}, roles: ["admin"], stepUp: true },
    { method: "GET", path: "/api/matching/patterns", roles: ["admin"] },
    { method: "POST", path: "/api/matching/patterns", body: {}, roles: ["admin"], stepUp: true },
    { method: "PUT", path: "/api/matching/patterns/1", body: {}, roles: ["admin"], stepUp: true },
    { method: "DELETE", path: "/api/matching/patterns/1", roles: ["admin"], stepUp: true },
  ];

  it("every matching route is registered with exactly these rules (default deny)", () => {
    const described = buildRouter()
      .describe()
      .filter((r) => r.pattern.includes(" /api/matching/"));
    expect(described.map((r) => r.pattern).sort()).toEqual(
      routes.map((r) => `${r.method} ${r.path.replace(/\/\d+/g, "/:id")}`).sort(),
    );
    for (const r of routes) {
      const d = described.find(
        (x) => x.pattern === `${r.method} ${r.path.replace(/\/\d+/g, "/:id")}`,
      );
      expect([...(d?.access.roles ?? [])].sort(), r.path).toEqual([...r.roles].sort());
      expect(d?.access.stepUp === true, `${r.path} step-up`).toBe(r.stepUp === true);
      expect(d?.access.public, r.path).toBeUndefined();
    }
  });

  for (const r of routes) {
    const label = `${r.method} ${r.path}`;
    it(`${label}: 401 without a session, 403 without the CSRF header, 403 for other roles`, async () => {
      const anon = await call(r.path, {
        method: r.method,
        headers: { "x-requested-with": "fetch" },
      });
      expect(anon.status).toBe(401);
      if (r.method !== "GET") {
        // Without the header even an anonymous request is refused first (CSRF is checked before login).
        expect((await call(r.path, { method: r.method })).status).toBe(403);
        const noCsrf = await call(r.path, {
          method: r.method,
          headers: { cookie: `__Host-session=${tokens.admin}`, "content-type": "application/json" },
          body: JSON.stringify(r.body ?? {}),
        });
        expect(noCsrf.status).toBe(403);
        expect(((await noCsrf.json()) as { error: string }).error).toBe("csrf");
      }
      for (const role of ["admin", "finance", "approver", "viewer"] as const) {
        const res = await send(role, r.method, r.path, r.body);
        if (r.roles.includes(role)) expect(res.status, `${label} ${role}`).not.toBe(403);
        else expect(res.status, `${label} ${role}`).toBe(403);
        expect(res.status).not.toBe(401);
      }
      if (r.stepUp) {
        const stale = await send("staleAdmin", r.method, r.path, r.body);
        expect(stale.status).toBe(401);
        expect(err(stale)).toBe("step_up_required");
      }
    });
  }
});

describe("queue, auto list, detail and stats", () => {
  it("lists lines to review with their top candidates, plain-English explanations and no full IBAN", async () => {
    const { itemId, txId } = await seedPerfect();
    await runMatching(jobContext());
    const q = await get<MatchQueueResponse>("viewer", "/api/matching/queue");
    expect(q.status).toBe(200);
    expect(q.body.total).toBe(1);
    expect(q.body.autoEnabled).toBe(false);
    const item = q.body.items[0];
    expect(item?.transaction).toMatchObject({
      id: txId,
      matchStatus: "suggested",
      mapped: true,
      divisionId: w.divisionId,
      stateConflict: false,
      amountMinor: 12_345,
      counterpartyIbanMasked: "NL91****4300",
      ignore: null,
    });
    const c = item?.candidates[0] as MatchCandidateDto;
    expect(c).toMatchObject({
      rank: 1,
      rule: 1,
      kind: "full",
      autoEligible: true,
      ledgerAccountCode: null,
    });
    expect(c.allocations).toEqual([
      expect.objectContaining({
        openItemId: itemId,
        invoiceNumber: "INV-2026-0042",
        relationName: "Acme B.V.",
        allocatedMinor: 12_345,
      }),
    ]);
    expect(c.explanation[0]).toContain("equals the open balance of INV-2026-0042");
    expect(c.reasonCodes).toContain("invoice_number_in_reference");
    // The IBAN written inside the payer's reference is masked too.
    expect(item?.transaction.reference).toContain("NL91****4300");
    expect(JSON.stringify(q.body)).not.toContain(CUSTOMER_IBAN);
  });

  it("maps blocked codes to plain English (auto off or blocked)", async () => {
    await addItem({ divisionId: w.divisionId, openMinor: 4_321, invoiceNumber: "INV-2026-1111" });
    await tx({ amountMinor: 4_321 });
    await runMatching(jobContext());
    const q = await get<MatchQueueResponse>("finance", "/api/matching/queue");
    const c = q.body.items[0]?.candidates[0] as MatchCandidateDto;
    expect(c.rule).toBe(3);
    expect(c.blocked.map((b) => b.code)).toContain("suggestion_only");
    expect(c.blocked.find((b) => b.code === "suggestion_only")?.text).toBe(
      "A match on amount alone is a suggestion only, so it goes to review",
    );
  });

  it("cleans explanation text that came from outside before returning it", async () => {
    const { txId } = await seedPerfect();
    await runMatching(jobContext());
    await db
      .prepare(
        "UPDATE match_suggestions SET explanation_json = ?2, blocked_json = ?3 WHERE bank_transaction_id = ?1",
      )
      .bind(
        txId,
        JSON.stringify([`Pay\u200b ment \u202e${CUSTOMER_IBAN} ${"x".repeat(900)}`, 42, "ok"]),
        JSON.stringify(["x\u0000y", "made_up_code"]),
      )
      .run();
    const q = await get<MatchQueueResponse>("viewer", "/api/matching/queue");
    const c = q.body.items[0]?.candidates[0] as MatchCandidateDto;
    const text = JSON.stringify(c);
    expect(text).not.toContain(CUSTOMER_IBAN);
    expect(text).not.toContain("\\u200b");
    expect(text).not.toContain("\\u202e");
    expect(c.explanation.every((l) => l.length <= 243)).toBe(true);
    expect(c.explanation).toHaveLength(2);
    expect(c.blocked.every((b) => b.text.length < 200)).toBe(true);
  });

  it("filters by status, account and text, and pages with a keyset cursor", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await tx({
          amountMinor: 100 + i,
          reference: i === 3 ? "special needle" : `ref ${i}`,
          createdAt: `2026-07-1${i}T08:00:00.000Z`,
        }),
      );
    }
    const ig = await tx({ amountMinor: 999, matchStatus: "ignored" });
    await db
      .prepare(
        "UPDATE bank_transactions SET ignored_reason = 'other', ignored_by = 'a@b.c', ignored_at = '2026-07-15T00:00:00Z' WHERE id = ?1",
      )
      .bind(ig)
      .run();
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r: { body: MatchQueueResponse } = await get<MatchQueueResponse>(
        "viewer",
        `/api/matching/queue?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(r.body.total).toBe(5);
      seen.push(...r.body.items.map((i) => i.transaction.id));
      cursor = r.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual([...ids].reverse());
    expect(
      (
        await get<MatchQueueResponse>("viewer", "/api/matching/queue?status=ignored")
      ).body.items.map((i) => i.transaction.id),
    ).toEqual([ig]);
    expect(
      (await get<MatchQueueResponse>("viewer", "/api/matching/queue?status=ignored")).body.items[0]
        ?.transaction.ignore,
    ).toMatchObject({ reason: "other", by: "a@b.c" });
    expect(
      (await get<MatchQueueResponse>("viewer", "/api/matching/queue?status=all")).body.total,
    ).toBe(6);
    expect(
      (await get<MatchQueueResponse>("viewer", "/api/matching/queue?q=needle")).body.items.map(
        (i) => i.transaction.id,
      ),
    ).toEqual([ids[3]]);
    expect(
      (await get<MatchQueueResponse>("viewer", `/api/matching/queue?account=${w.accountId + 99}`))
        .body.total,
    ).toBe(0);
    for (const bad of [
      "status=nope",
      "limit=0",
      "limit=101",
      "limit=x",
      "cursor=%25%25",
      "account=-1",
      `q=${"a".repeat(101)}`,
    ]) {
      const r = await get("viewer", `/api/matching/queue?${bad}`);
      expect(r.status, bad).toBe(400);
    }
  });

  it("detail lists every candidate and the live match; unknown ids are 404", async () => {
    const { txId } = await seedPerfect();
    await runMatching(jobContext());
    const d = await get<MatchDetailResponse>("approver", `/api/matching/transactions/${txId}`);
    expect(d.body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(d.body.match).toBeNull();
    expect((await get("viewer", "/api/matching/transactions/99999")).status).toBe(404);
    expect((await get("viewer", "/api/matching/transactions/abc")).status).toBe(404);
  });

  it("auto list: recent automatic matches with undo availability, newest first, paged", async () => {
    await enableAuto();
    for (let i = 0; i < 3; i++) {
      const rel = await addRelation({
        divisionId: w.divisionId,
        ibans: [`NL${10 + i}ABNA041716430${i}`],
      });
      await addItem({
        divisionId: w.divisionId,
        invoiceNumber: `INV-2026-10${i}`,
        openMinor: 1_000 + i,
        relationExactId: rel.exactId,
      });
      await tx({
        amountMinor: 1_000 + i,
        reference: `INV-2026-10${i}`,
        counterpartyIban: `NL${10 + i}ABNA041716430${i}`,
      });
    }
    await runMatching(jobContext());
    expect(await liveMatches()).toBe(3);
    await db
      .prepare("UPDATE matches SET created_at = '2026-07-15T10:00:0' || (id % 10) || '.000Z'")
      .run();
    const first = await get<MatchAutoResponse>("viewer", "/api/matching/auto?limit=2");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await get<MatchAutoResponse>(
      "viewer",
      `/api/matching/auto?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const all = [...first.body.items, ...second.body.items];
    expect(new Set(all.map((i) => i.match.id)).size).toBe(3);
    expect(
      all.every(
        (i) => i.match.source === "auto" && i.match.undoAvailable && i.match.status === "live",
      ),
    ).toBe(true);
    expect((all[0]?.match.createdAt ?? "") >= (all[1]?.match.createdAt ?? "")).toBe(true);
    const id = all[0]?.match.id as number;
    await send("finance", "POST", `/api/matching/matches/${id}/undo`, { reason: "wrong customer" });
    const after = await get<MatchAutoResponse>("viewer", "/api/matching/auto?limit=100");
    expect(after.body.items.find((i) => i.match.id === id)?.match).toMatchObject({
      status: "undone",
      undoAvailable: false,
      undoReason: "wrong customer",
    });
  });

  it("stats: counts, the oldest open line and the lines older than five days", async () => {
    const NOW = Date.now();
    const iso = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
    await tx({ amountMinor: 1, createdAt: iso(9) });
    await tx({ amountMinor: 2, createdAt: iso(6), matchStatus: "suggested" });
    await tx({ amountMinor: 3, createdAt: iso(1) });
    await tx({ amountMinor: 4, matchStatus: "matched" });
    await tx({ amountMinor: 5, matchStatus: "ignored" });
    await tx({ amountMinor: 6, state: "pending" });
    const s = await get<MatchStatsResponse>("viewer", "/api/matching/stats");
    expect(s.body).toMatchObject({
      unmatched: 2,
      suggested: 1,
      matched: 1,
      ignored: 1,
      oldestUnmatchedAt: iso(9),
      oldestUnmatchedDays: 9,
      unmatchedOverFiveDays: 2,
      liveAutoMatches: 0,
      matchesNeedingReview: 0,
      enabled: true,
      autoEnabled: false,
      unmappedAccounts: 0,
    });
  });
});

describe("manual match", () => {
  const post = (body: unknown, role: Role = "finance") =>
    send<MatchCreateResponse>(role, "POST", "/api/matching/matches", body);

  it("matches a bank line to an invoice atomically and audits it under the user's email", async () => {
    const { itemId, txId } = await seedPerfect();
    const auditBefore = (await auditRows("match.manual")).length;
    const r = await post({
      transactionId: txId,
      allocations: [{ openItemId: itemId, allocatedMinor: 12_345 }],
      note: "checked with customer",
    });
    expect(r.status).toBe(201);
    expect(r.body.match).toMatchObject({
      transactionId: txId,
      source: "manual",
      status: "live",
      createdBy: "finance@camelthorncapital.com",
      score: null,
      note: "checked with customer",
      undoAvailable: true,
      exactState: "not_booked",
      allocations: [
        expect.objectContaining({
          openItemId: itemId,
          allocatedMinor: 12_345,
          remainingMinorAfter: 0,
        }),
      ],
    });
    expect(await txStatus(txId)).toBe("matched");
    const audit = (await auditRows("match.manual")).slice(auditBefore);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_email).toBe("finance@camelthorncapital.com");
    expect(audit[0]?.entity_id).toBe(String(r.body.match.id));
    // A second attempt is a conflict, not a second match.
    expect(
      err(
        await post({
          transactionId: txId,
          allocations: [{ openItemId: itemId, allocatedMinor: 12_345 }],
        }),
      ),
    ).toBe("already_matched");
    expect(await liveMatches()).toBe(1);
  });

  it("settles several invoices with one payment, and a part payment leaves the rest open", async () => {
    const a = await addItem({ divisionId: w.divisionId, openMinor: 3_000 });
    const b = await addItem({ divisionId: w.divisionId, openMinor: 5_000 });
    const t = await tx({ amountMinor: 8_000 });
    const r = await post({
      transactionId: t,
      allocations: [
        { openItemId: a, allocatedMinor: 3_000 },
        { openItemId: b, allocatedMinor: 5_000 },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.match.allocations).toHaveLength(2);
    const c = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const t2 = await tx({ amountMinor: 4_000 });
    const part = await post({
      transactionId: t2,
      allocations: [{ openItemId: c, allocatedMinor: 4_000 }],
    });
    expect(part.body.match.allocations[0]?.remainingMinorAfter).toBe(6_000);
    const t3 = await tx({ amountMinor: 7_000 });
    expect(
      err(
        await post({ transactionId: t3, allocations: [{ openItemId: c, allocatedMinor: 7_000 }] }),
      ),
    ).toBe("allocation_exceeds_open");
  });

  it("matches a line to a ledger account (bank fee) without invoices", async () => {
    const t = await tx({ amountMinor: -250, type: "fee" });
    const r = await post({ transactionId: t, ledgerAccountCode: "4510" });
    expect(r.status).toBe(201);
    expect(r.body.match).toMatchObject({
      source: "ledger",
      ledgerAccountCode: "4510",
      allocations: [],
    });
    expect(await txStatus(t)).toBe("matched");
  });

  it("rejects every invalid request with a fixed code and writes nothing", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 1_000 });
    const bill = await addItem({ divisionId: w.divisionId, kind: "bill", openMinor: 1_000 });
    const usd = await addItem({ divisionId: w.divisionId, openMinor: 1_000, currency: "USD" });
    const closed = await addItem({ divisionId: w.divisionId, openMinor: 1_000, status: "closed" });
    const other = await resetOtherDivisionItem();
    const t = await tx({ amountMinor: 1_000 });
    const out = await tx({ amountMinor: -1_000 });
    const pending = await tx({ amountMinor: 1_000, state: "pending" });
    const ignored = await tx({ amountMinor: 1_000, matchStatus: "ignored" });
    const conflict = await tx({ amountMinor: 1_000, stateConflict: true });
    const alloc = (id: number, n: number) => ({ openItemId: id, allocatedMinor: n });
    const cases: [string, unknown, number, string][] = [
      ["no body fields", {}, 400, "bad_transaction"],
      [
        "unknown key",
        { transactionId: t, ledgerAccountCode: "4500", extra: 1 },
        400,
        "bad_request",
      ],
      [
        "both targets",
        { transactionId: t, ledgerAccountCode: "4500", allocations: [alloc(item, 1_000)] },
        400,
        "allocations_or_ledger",
      ],
      ["neither target", { transactionId: t }, 400, "allocations_or_ledger"],
      [
        "bad ledger code",
        { transactionId: t, ledgerAccountCode: "45 00" },
        400,
        "bad_ledger_account",
      ],
      ["empty allocations", { transactionId: t, allocations: [] }, 400, "bad_allocations"],
      ["zero amount", { transactionId: t, allocations: [alloc(item, 0)] }, 400, "bad_allocations"],
      [
        "fractional amount",
        { transactionId: t, allocations: [alloc(item, 10.5)] },
        400,
        "bad_allocations",
      ],
      [
        "string amount",
        { transactionId: t, allocations: [{ openItemId: item, allocatedMinor: "1000" }] },
        400,
        "bad_allocations",
      ],
      [
        "extra allocation key",
        { transactionId: t, allocations: [{ openItemId: item, allocatedMinor: 1000, x: 1 }] },
        400,
        "bad_allocations",
      ],
      [
        "note with control characters",
        { transactionId: t, allocations: [alloc(item, 1_000)], note: "a\u0000b" },
        400,
        "bad_note",
      ],
      [
        "note too long",
        { transactionId: t, allocations: [alloc(item, 1_000)], note: "x".repeat(201) },
        400,
        "bad_note",
      ],
      [
        "too many allocations",
        { transactionId: t, allocations: Array.from({ length: 21 }, (_, i) => alloc(i + 1, 1)) },
        400,
        "bad_allocations",
      ],
      ["unknown line", { transactionId: 987654, ledgerAccountCode: "4500" }, 404, "not_found"],
      [
        "line not completed",
        { transactionId: pending, allocations: [alloc(item, 1_000)] },
        422,
        "tx_not_final",
      ],
      [
        "ignored line",
        { transactionId: ignored, allocations: [alloc(item, 1_000)] },
        409,
        "tx_ignored",
      ],
      [
        "state conflict",
        { transactionId: conflict, allocations: [alloc(item, 1_000)] },
        409,
        "tx_state_conflict",
      ],
      [
        "duplicate item",
        { transactionId: t, allocations: [alloc(item, 500), alloc(item, 500)] },
        422,
        "duplicate_item",
      ],
      [
        "unknown item",
        { transactionId: t, allocations: [alloc(999999, 1_000)] },
        422,
        "item_not_found",
      ],
      [
        "item of another division",
        { transactionId: t, allocations: [alloc(other, 1_000)] },
        422,
        "item_wrong_division",
      ],
      [
        "closed item",
        { transactionId: t, allocations: [alloc(closed, 1_000)] },
        422,
        "item_closed",
      ],
      [
        "currency mismatch",
        { transactionId: t, allocations: [alloc(usd, 1_000)] },
        422,
        "currency_mismatch",
      ],
      [
        "money in cannot pay a bill",
        { transactionId: t, allocations: [alloc(bill, 1_000)] },
        422,
        "direction_mismatch",
      ],
      [
        "money out cannot pay an invoice",
        { transactionId: out, allocations: [alloc(item, 1_000)] },
        422,
        "direction_mismatch",
      ],
      [
        "more than the open balance",
        { transactionId: t, allocations: [alloc(item, 1_001)] },
        422,
        "allocation_exceeds_open",
      ],
      [
        "sum differs from the bank amount",
        { transactionId: t, allocations: [alloc(item, 900)] },
        422,
        "allocation_sum_mismatch",
      ],
    ];
    for (const [name, body, status, code] of cases) {
      const r = await post(body);
      expect([r.status, err(r)], name).toEqual([status, code]);
    }
    expect(await liveMatches()).toBe(0);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM match_allocations").first<{ n: number }>())?.n,
    ).toBe(0);
    // Unmapped account.
    await db.prepare("DELETE FROM bank_account_exact_map").run();
    expect(err(await post({ transactionId: t, allocations: [alloc(item, 1_000)] }))).toBe(
      "account_not_mapped",
    );
    // Non-JSON.
    const raw = await authed("/api/matching/matches", tokens.finance, {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    expect(raw.status).toBe(400);
  });

  it("an item already covered by an earlier match cannot be matched again", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 1_000 });
    const a = await tx({ amountMinor: 1_000 });
    const b = await tx({ amountMinor: 1_000 });
    expect(
      (await post({ transactionId: a, allocations: [{ openItemId: item, allocatedMinor: 1_000 }] }))
        .status,
    ).toBe(201);
    expect(
      err(
        await post({
          transactionId: b,
          allocations: [{ openItemId: item, allocatedMinor: 1_000 }],
        }),
      ),
    ).toBe("allocation_exceeds_open");
  });

  it("no response of the matching API contains a full IBAN", async () => {
    const { itemId, txId } = await seedPerfect();
    await db
      .prepare("UPDATE bank_transactions SET description = ?2 WHERE id = ?1")
      .bind(txId, `from ${SUPPLIER_IBAN} to ${OUR_IBAN}`)
      .run();
    await runMatching(jobContext());
    const bodies: unknown[] = [];
    for (const p of [
      "queue?status=all",
      "auto",
      "stats",
      `transactions/${txId}`,
      "config",
      "account-map",
      "patterns",
    ]) {
      bodies.push((await get("admin", `/api/matching/${p}`)).body);
    }
    bodies.push(
      (
        await post({
          transactionId: txId,
          allocations: [{ openItemId: itemId, allocatedMinor: 12_345 }],
        })
      ).body,
    );
    bodies.push((await get("admin", `/api/matching/transactions/${txId}`)).body);
    bodies.push((await get("admin", "/api/matching/queue?status=all")).body);
    const text = JSON.stringify(bodies);
    for (const iban of [CUSTOMER_IBAN, SUPPLIER_IBAN, OUR_IBAN]) {
      expect(text).not.toContain(iban);
      expect(text.replace(/\s/g, "")).not.toContain(iban);
    }
    expect(text).toContain("NL02****6789");
  });
});

async function resetOtherDivisionItem(): Promise<number> {
  const { addDivision } = await import("./sync-helpers");
  const d = await addDivision();
  return addItem({ divisionId: d.id, openMinor: 1_000 });
}

describe("undo", () => {
  async function autoMatched(): Promise<{ matchId: number; txId: number; itemId: number }> {
    const { itemId, txId } = await seedPerfect();
    await enableAuto();
    await runMatching(jobContext());
    const m = await db
      .prepare("SELECT id FROM matches WHERE bank_transaction_id = ?1")
      .bind(txId)
      .first<{ id: number }>();
    return { matchId: m?.id as number, txId, itemId };
  }

  it("undoes while not booked: frees the item, reopens the line, recomputes suggestions, audits", async () => {
    const { matchId, txId, itemId } = await autoMatched();
    expect(await txStatus(txId)).toBe("matched");
    const auditBefore = (await auditRows("match.undo")).length;
    const r = await send<MatchUndoResponse>(
      "finance",
      "POST",
      `/api/matching/matches/${matchId}/undo`,
      { reason: "paid by another customer" },
    );
    expect(r.status).toBe(200);
    expect(r.body.match).toMatchObject({
      status: "undone",
      undoneBy: "finance@camelthorncapital.com",
      undoReason: "paid by another customer",
      undoAvailable: false,
    });
    expect(await txStatus(txId)).toBe("unmatched");
    expect(await liveMatches()).toBe(0);
    const audit = (await auditRows("match.undo")).slice(auditBefore);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_email).toBe("finance@camelthorncapital.com");
    expect(JSON.parse(audit[0]?.after_json ?? "{}")).toMatchObject({
      status: "undone",
      reason: "paid by another customer",
    });
    // The item is free again and the next run suggests (auto is on, so it matches again).
    const [it] = (
      await db
        .prepare(
          "SELECT 1 FROM match_allocations a JOIN matches m ON m.id = a.match_id WHERE a.open_item_id = ?1 AND m.undone_at IS NULL",
        )
        .bind(itemId)
        .all()
    ).results;
    expect(it).toBeUndefined();
    await db.prepare("DELETE FROM settings WHERE key = 'matching.auto_enabled'").run();
    await runMatching(jobContext());
    expect(await txStatus(txId)).toBe("suggested");
    // Undoing twice is a conflict.
    const again = await send("finance", "POST", `/api/matching/matches/${matchId}/undo`, {
      reason: "again",
    });
    expect([again.status, err(again)]).toEqual([409, "already_undone"]);
  });

  it("refuses once Exact has booked it, and validates the request", async () => {
    const { matchId } = await autoMatched();
    expect(err(await send("finance", "POST", `/api/matching/matches/${matchId}/undo`, {}))).toBe(
      "bad_reason",
    );
    expect(
      err(await send("finance", "POST", `/api/matching/matches/${matchId}/undo`, { reason: "  " })),
    ).toBe("bad_reason");
    expect(
      err(
        await send("finance", "POST", `/api/matching/matches/${matchId}/undo`, {
          reason: "x".repeat(201),
        }),
      ),
    ).toBe("bad_reason");
    expect(
      err(
        await send("finance", "POST", `/api/matching/matches/${matchId}/undo`, {
          reason: "ok",
          extra: 1,
        }),
      ),
    ).toBe("bad_request");
    expect(
      (await send("finance", "POST", "/api/matching/matches/987654/undo", { reason: "ok" })).status,
    ).toBe(404);
    await db
      .prepare("UPDATE matches SET exact_state = 'booking' WHERE id = ?1")
      .bind(matchId)
      .run();
    const r = await send("admin", "POST", `/api/matching/matches/${matchId}/undo`, {
      reason: "too late",
    });
    expect([r.status, err(r)]).toEqual([409, "already_booked_in_exact"]);
    expect(await liveMatches()).toBe(1);
    const list = await get<MatchAutoResponse>("viewer", "/api/matching/auto");
    expect(list.body.items[0]?.match.undoAvailable).toBe(false);
  });

  it("undo racing with undo: exactly one succeeds", async () => {
    const { matchId } = await autoMatched();
    const [a, b] = await Promise.all([
      send("finance", "POST", `/api/matching/matches/${matchId}/undo`, { reason: "one" }),
      send("admin", "POST", `/api/matching/matches/${matchId}/undo`, { reason: "two" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});

describe("ignore and unignore", () => {
  it("ignores a line (not selected by the job any more) and brings it back", async () => {
    const { txId } = await seedPerfect();
    await runMatching(jobContext());
    expect(await txStatus(txId)).toBe("suggested");
    const auditBefore = (await auditRows("bank_transaction.ignore")).length;
    const r = await send<MatchIgnoreResponse>(
      "finance",
      "POST",
      `/api/matching/transactions/${txId}/ignore`,
      { reason: "internal_transfer", note: "own account" },
    );
    expect(r.status).toBe(200);
    expect(r.body.transaction).toMatchObject({
      matchStatus: "ignored",
      ignore: {
        reason: "internal_transfer",
        note: "own account",
        by: "finance@camelthorncapital.com",
      },
    });
    expect((await auditRows("bank_transaction.ignore")).length - auditBefore).toBe(1);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM match_suggestions").first<{ n: number }>())?.n,
    ).toBe(0);
    await runMatching(jobContext({ now: () => NOW + 700_000 }));
    expect(await txStatus(txId)).toBe("ignored");
    expect(
      err(
        await send("finance", "POST", `/api/matching/transactions/${txId}/ignore`, {
          reason: "other",
        }),
      ),
    ).toBe("already_ignored");
    // A manual match of an ignored line is refused until it is un-ignored.
    expect(
      err(
        await send("finance", "POST", "/api/matching/matches", {
          transactionId: txId,
          ledgerAccountCode: "4500",
        }),
      ),
    ).toBe("tx_ignored");
    const back = await send<MatchIgnoreResponse>(
      "finance",
      "POST",
      `/api/matching/transactions/${txId}/unignore`,
      {},
    );
    expect(back.body.transaction).toMatchObject({ matchStatus: "unmatched", ignore: null });
    expect(
      err(await send("finance", "POST", `/api/matching/transactions/${txId}/unignore`, {})),
    ).toBe("not_ignored");
    await runMatching(jobContext({ now: () => NOW + 1_400_000 }));
    expect(await txStatus(txId)).toBe("suggested");
  });

  it("validates the request and refuses a matched or pending line", async () => {
    const t = await tx({ amountMinor: 100 });
    expect(
      err(
        await send("finance", "POST", `/api/matching/transactions/${t}/ignore`, {
          reason: "because",
        }),
      ),
    ).toBe("bad_reason");
    expect(err(await send("finance", "POST", `/api/matching/transactions/${t}/ignore`, {}))).toBe(
      "bad_reason",
    );
    expect(
      err(
        await send("finance", "POST", `/api/matching/transactions/${t}/ignore`, {
          reason: "other",
          note: "x".repeat(201),
        }),
      ),
    ).toBe("bad_note");
    expect(
      (
        await send("finance", "POST", "/api/matching/transactions/987654/ignore", {
          reason: "other",
        })
      ).status,
    ).toBe(404);
    const pending = await tx({ amountMinor: 100, state: "pending" });
    expect(
      err(
        await send("finance", "POST", `/api/matching/transactions/${pending}/ignore`, {
          reason: "other",
        }),
      ),
    ).toBe("not_ignorable");
    expect(
      (
        await send("finance", "POST", "/api/matching/matches", {
          transactionId: t,
          ledgerAccountCode: "4500",
        })
      ).status,
    ).toBe(201);
    expect(
      err(
        await send("finance", "POST", `/api/matching/transactions/${t}/ignore`, {
          reason: "other",
        }),
      ),
    ).toBe("already_matched");
  });

  it("a state conflict is cleared by an admin with a fresh sign-in and a note, audited", async () => {
    const t = await tx({ amountMinor: 100, stateConflict: true });
    const path = `/api/matching/transactions/${t}/clear-conflict`;
    // Finance may not clear it; an admin needs a note.
    expect((await send("finance", "POST", path, { note: "checked" })).status).toBe(403);
    for (const body of [
      {},
      { note: "" },
      { note: "   " },
      { note: 5 },
      { note: "x".repeat(201) },
    ]) {
      const r = await send("admin", "POST", path, body);
      expect([r.status, err(r)], JSON.stringify(body)).toEqual([400, "bad_note"]);
    }
    const stale = await send("staleAdmin", "POST", path, { note: "checked" });
    expect([stale.status, err(stale)]).toEqual([401, "step_up_required"]);
    const r = await send<MatchIgnoreResponse>("admin", "POST", path, {
      note: "Revolut confirmed the amount",
    });
    expect(r.status).toBe(200);
    expect(r.body.transaction.stateConflict).toBe(false);
    expect(err(await send("admin", "POST", path, { note: "again" }))).toBe("no_conflict");
    const audit = await auditRows("bank_transaction.conflict_cleared", t);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_email).toBe("admin@camelthorncapital.com");
    expect(JSON.parse(audit[0]?.after_json ?? "{}")).toEqual({
      stateConflict: 0,
      note: "Revolut confirmed the amount",
    });
  });
});

describe("configuration", () => {
  it("returns the defaults, with auto matching off", async () => {
    const r = await get<MatchConfigResponse>("admin", "/api/matching/config");
    expect(r.body).toMatchObject({
      enabled: true,
      autoEnabled: false,
      configErrors: [],
      autoConfirmPhrase: "ENABLE AUTOMATIC MATCHING",
      config: {
        autoMatchMinScore: 95,
        autoMatchMinGap: 20,
        maxCandidates: 5,
        autoLedgerPatterns: false,
      },
    });
    expect(r.body.config).toEqual(r.body.defaults);
  });

  it("changes tunables, audits before and after, and validates with the engine's rules", async () => {
    const auditBefore = (await auditRows("matching.config_changed")).length;
    const ok = await send<MatchConfigResponse>("admin", "PUT", "/api/matching/config", {
      config: { autoMatchMinGap: 30, autoTxTypes: ["transfer"] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.config).toMatchObject({
      autoMatchMinGap: 30,
      autoTxTypes: ["transfer"],
      autoMatchMinScore: 95,
    });
    expect(ok.body.updatedBy).toBe("admin@camelthorncapital.com");
    const audit = (await auditRows("matching.config_changed")).slice(auditBefore);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.before_json ?? "{}")).toMatchObject({ autoMatchMinGap: 20 });
    expect(JSON.parse(audit[0]?.after_json ?? "{}")).toMatchObject({ autoMatchMinGap: 30 });
    const bad: unknown[] = [
      { autoMatchMinScore: 90 },
      { autoMatchMinGap: 0 },
      { autoMatchMinGap: 1.5 },
      { maxCandidates: 51 },
      { amountToleranceMinor: 101 },
      { autoTxTypes: ["exchange"] },
      { autoTxTypes: ["BAD TYPE"] },
      { autoLedgerPatterns: "yes" },
      { patterns: [] },
      { ownIbans: ["NL91ABNA0417164300"] },
    ];
    for (const config of bad) {
      const r = await send("admin", "PUT", "/api/matching/config", { config });
      expect([r.status, err(r)], JSON.stringify(config)).toEqual([422, "bad_config"]);
    }
    expect(
      (await get<MatchConfigResponse>("admin", "/api/matching/config")).body.config.autoMatchMinGap,
    ).toBe(30);
    expect((await send("admin", "PUT", "/api/matching/config", { nope: 1 })).status).toBe(400);
    expect((await send("admin", "PUT", "/api/matching/config", { enabled: "yes" })).status).toBe(
      400,
    );
  });

  it("switching automatic matching on needs the typed phrase; switching it off does not", async () => {
    const no = await send("admin", "PUT", "/api/matching/config", { autoEnabled: true });
    expect([no.status, err(no)]).toEqual([422, "confirmation_required"]);
    const wrong = await send("admin", "PUT", "/api/matching/config", {
      autoEnabled: true,
      confirm: "yes",
    });
    expect(err(wrong)).toBe("confirmation_required");
    expect((await get<MatchConfigResponse>("admin", "/api/matching/config")).body.autoEnabled).toBe(
      false,
    );
    const auditBefore = (await auditRows("matching.auto_changed")).length;
    const on = await send<MatchConfigResponse>("admin", "PUT", "/api/matching/config", {
      autoEnabled: true,
      confirm: "ENABLE AUTOMATIC MATCHING",
    });
    expect(on.body.autoEnabled).toBe(true);
    const audit = (await auditRows("matching.auto_changed")).slice(auditBefore);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_email).toBe("admin@camelthorncapital.com");
    const off = await send<MatchConfigResponse>("admin", "PUT", "/api/matching/config", {
      autoEnabled: false,
    });
    expect(off.body.autoEnabled).toBe(false);
    // The emergency switch: an admin WITHOUT a fresh sign-in can turn it off (never on), audited.
    await send("admin", "PUT", "/api/matching/config", {
      autoEnabled: true,
      confirm: "ENABLE AUTOMATIC MATCHING",
    });
    const staleOn = await send("staleAdmin", "PUT", "/api/matching/config", {
      autoEnabled: true,
      confirm: "ENABLE AUTOMATIC MATCHING",
    });
    expect([staleOn.status, err(staleOn)]).toEqual([401, "step_up_required"]);
    const n = (await auditRows("matching.auto_changed")).length;
    const stop = await send<MatchConfigResponse>(
      "staleAdmin",
      "POST",
      "/api/matching/auto/disable",
    );
    expect([stop.status, stop.body.autoEnabled]).toEqual([200, false]);
    const stopAudit = (await auditRows("matching.auto_changed")).slice(n);
    expect(stopAudit.map((a) => [a.actor_email, a.before_json, a.after_json])).toEqual([
      ["stale@camelthorncapital.com", "true", "false"],
    ]);
    // Already off: nothing changes, nothing is audited.
    expect((await send("staleAdmin", "POST", "/api/matching/auto/disable")).status).toBe(200);
    expect((await auditRows("matching.auto_changed")).length).toBe(n + 1);
    expect((await send("finance", "POST", "/api/matching/auto/disable")).status).toBe(403);
    // Disabling and enabling suggestions.
    expect(
      (await send<MatchConfigResponse>("admin", "PUT", "/api/matching/config", { enabled: false }))
        .body.enabled,
    ).toBe(false);
  });
});

describe("configuration while automatic matching is on (S3)", () => {
  const PHRASE = "ENABLE AUTOMATIC MATCHING";
  const put = (body: unknown) =>
    send<MatchConfigResponse>("admin", "PUT", "/api/matching/config", body);
  const gapOf = async (): Promise<number> =>
    (await get<MatchConfigResponse>("admin", "/api/matching/config")).body.config.autoMatchMinGap;

  it("loosening needs the phrase again, tightening and unrelated changes do not", async () => {
    await put({ config: { autoMatchMinGap: 30 } });
    await put({ autoEnabled: true, confirm: PHRASE });
    const loosening: Record<string, unknown>[] = [
      { autoMatchMinGap: 29 },
      { blockAutoOnRecentIbanChangeDays: 60 },
      { autoLedgerPatterns: true },
      { autoIncomingUnknownIban: true },
      { amountToleranceMinor: 1 },
      { autoTxTypes: ["transfer", "topup", "card_payment", "atm"] },
    ];
    for (const config of loosening) {
      const r = await put({ config });
      expect([r.status, err(r)], JSON.stringify(config)).toEqual([422, "confirmation_required"]);
    }
    expect(await gapOf()).toBe(30);
    const wrong = await put({ config: { autoMatchMinGap: 25 }, confirm: "yes" });
    expect(err(wrong)).toBe("confirmation_required");
    const ok = await put({ config: { autoMatchMinGap: 25 }, confirm: PHRASE });
    expect(ok.status).toBe(200);
    expect(await gapOf()).toBe(25);
    // Tightening and an unrelated change: no phrase.
    expect((await put({ config: { autoMatchMinGap: 40 } })).status).toBe(200);
    expect((await put({ config: { maxCandidates: 7 } })).status).toBe(200);
    expect((await put({ config: { autoIncomingUnknownIban: false } })).status).toBe(200);
    // Turning auto off in the same request lets a loosening through.
    const both = await put({ autoEnabled: false, config: { autoMatchMinGap: 12 } });
    expect([both.status, both.body.autoEnabled]).toEqual([200, false]);
  });

  it("with automatic matching off, loosening needs no phrase", async () => {
    const r = await put({ config: { autoMatchMinGap: 11, autoIncomingUnknownIban: true } });
    expect(r.status).toBe(200);
    expect(r.body.config.autoIncomingUnknownIban).toBe(true);
  });

  it("a stored config below the floors is invalid, and repairing it while auto is on needs the phrase", async () => {
    await setSetting(SETTING_CONFIG, { autoMatchMinGap: 5 });
    await setSetting(SETTING_AUTO, true);
    const r = await get<MatchConfigResponse>("admin", "/api/matching/config");
    expect(r.body.configErrors.length).toBeGreaterThan(0);
    const no = await put({ config: { autoMatchMinGap: 20 } });
    expect(err(no)).toBe("confirmation_required");
    expect((await put({ config: { autoMatchMinGap: 20 }, confirm: PHRASE })).status).toBe(200);
  });

  it("removing a no-match type or an own-account type while auto is on needs the phrase", async () => {
    await put({ autoEnabled: true, confirm: PHRASE });
    for (const config of [{ noMatchTxTypes: [] }, { internalAccountTypes: [] }]) {
      const r = await put({ config });
      expect([r.status, err(r)], JSON.stringify(config)).toEqual([422, "confirmation_required"]);
    }
    // Adding to them tightens.
    expect((await put({ config: { noMatchTxTypes: ["exchange", "fee"] } })).status).toBe(200);
  });

  it("switching auto ON and loosening in one request: the enable phrase covers both", async () => {
    const no = await put({ autoEnabled: true, config: { autoMatchMinGap: 10 } });
    expect(err(no)).toBe("confirmation_required");
    expect(await gapOf()).toBe(20);
    const ok = await put({ autoEnabled: true, config: { autoMatchMinGap: 10 }, confirm: PHRASE });
    expect([ok.status, ok.body.autoEnabled, ok.body.config.autoMatchMinGap]).toEqual([
      200,
      true,
      10,
    ]);
  });

  it("the API refuses values below the floors whatever the phrase", async () => {
    for (const config of [{ autoMatchMinGap: 9 }, { blockAutoOnRecentIbanChangeDays: 29 }]) {
      const r = await put({ config, confirm: PHRASE });
      expect([r.status, err(r)]).toEqual([422, "bad_config"]);
    }
  });

  it("rev: a stale client gets 409 and nothing is written; the current rev works", async () => {
    const first = await get<MatchConfigResponse>("admin", "/api/matching/config");
    expect(first.body.rev).toBeNull();
    const a = await put({ config: { autoMatchMinGap: 30 }, rev: null });
    expect(a.status).toBe(200);
    expect(typeof a.body.rev).toBe("string");
    const stale = await put({ config: { autoMatchMinGap: 40 }, rev: null });
    expect([stale.status, err(stale)]).toEqual([409, "conflict"]);
    expect(await gapOf()).toBe(30);
    const ok = await put({ config: { autoMatchMinGap: 40 }, rev: a.body.rev });
    expect(ok.status).toBe(200);
    expect(ok.body.rev).not.toBe(a.body.rev);
    expect((await put({ config: {}, rev: 5 })).status).toBe(400);
    // Switching auto off (the safe direction) also moves the rev.
    await put({ autoEnabled: true, confirm: PHRASE });
    const before = (await get<MatchConfigResponse>("admin", "/api/matching/config")).body.rev;
    await send("admin", "POST", "/api/matching/auto/disable", {});
    const after = (await get<MatchConfigResponse>("admin", "/api/matching/config")).body.rev;
    expect(after).not.toBe(before);
  });

  it("race: a loosening checked while auto was off cannot land after auto went on", async () => {
    // Request L (auto off, loosening, no phrase needed) reads the settings; request E switches
    // auto on before L writes. Simulated by changing the rev between L's read and its batch.
    await put({ config: { autoMatchMinGap: 30 } });
    const realBatch = db.batch.bind(db);
    let raced = false;
    (db as { batch: typeof db.batch }).batch = async (stmts) => {
      if (!raced) {
        raced = true;
        await realBatch([
          db.prepare("UPDATE settings SET value_json = '\"other\"' WHERE key = 'matching.rev'"),
          db.prepare(
            `INSERT INTO settings (key, value_json, updated_at) VALUES ('matching.auto_enabled', 'true', 'x')
               ON CONFLICT (key) DO UPDATE SET value_json = 'true'`,
          ),
        ]);
      }
      return realBatch(stmts);
    };
    let r: { status: number; body: unknown };
    const auditsBefore = (await auditRows("matching.config_changed")).length;
    try {
      r = await put({ config: { autoMatchMinGap: 10 } });
    } finally {
      (db as { batch: typeof db.batch }).batch = realBatch;
    }
    expect([r.status, err(r)]).toEqual([409, "conflict"]);
    expect(await gapOf()).toBe(30);
    expect((await auditRows("matching.config_changed")).length).toBe(auditsBefore);
  });
});

describe("ledger patterns while automatic ledger matching is on (S3)", () => {
  const PHRASE = "ENABLE AUTOMATIC MATCHING";
  const pattern = {
    name: "Bank fees",
    ledgerAccountCode: "4510",
    counterpartyNameRegex: "^revolut",
    type: "fee",
    direction: "out",
    maxAmountMinor: 5_000,
  };
  const post = (body: unknown) => send("admin", "POST", "/api/matching/patterns", body);

  it("a new or changed enabled pattern needs the phrase; renaming, disabling and deleting do not", async () => {
    // Auto on, ledger patterns off: no phrase.
    await send("admin", "PUT", "/api/matching/config", { autoEnabled: true, confirm: PHRASE });
    const p0 = await post(pattern);
    expect(p0.status).toBe(201);
    await send("admin", "PUT", "/api/matching/config", {
      config: { autoLedgerPatterns: true },
      confirm: PHRASE,
    });
    const no = await post({ ...pattern, name: "Card fees" });
    expect([no.status, err(no)]).toEqual([422, "confirmation_required"]);
    expect((await post({ ...pattern, name: "Card fees", enabled: false })).status).toBe(201);
    expect((await post({ ...pattern, name: "Card fees", confirm: PHRASE })).status).toBe(201);
    const id = (p0.body as { pattern: MatchPatternDto }).pattern.id;
    const put = (body: unknown) => send("admin", "PUT", `/api/matching/patterns/${id}`, body);
    expect((await put({ ...pattern, name: "Renamed" })).status).toBe(200);
    const wider = await put({ ...pattern, counterpartyNameRegex: "revolut" });
    expect([wider.status, err(wider)]).toEqual([422, "confirmation_required"]);
    const bigger = await put({ ...pattern, maxAmountMinor: 50_000 });
    expect(err(bigger)).toBe("confirmation_required");
    expect((await put({ ...pattern, enabled: false })).status).toBe(200);
    // Re-enabling a disabled pattern is a new automatic rule.
    expect(err(await put({ ...pattern }))).toBe("confirmation_required");
    expect((await put({ ...pattern, confirm: PHRASE })).status).toBe(200);
    expect((await send("admin", "DELETE", `/api/matching/patterns/${id}`)).status).toBe(200);
  });

  it("with automatic matching off nothing needs the phrase", async () => {
    await send("admin", "PUT", "/api/matching/config", { config: { autoLedgerPatterns: true } });
    expect((await post(pattern)).status).toBe(201);
  });
});

describe("account map", () => {
  it("shows accounts with their mapping and the administrations to choose from", async () => {
    const r = await get<MatchAccountMapResponse>("admin", "/api/matching/account-map");
    expect(r.body.accounts).toHaveLength(1);
    expect(r.body.accounts[0]).toMatchObject({
      bankAccountId: w.accountId,
      ibanMasked: "NL02****6789",
      divisionId: w.divisionId,
      journalCode: "90",
      bankGlAccountCode: "1210",
    });
    expect(r.body.divisions.map((d) => d.id)).toEqual([w.divisionId]);
  });

  it("sets, changes and removes a mapping with audit rows, and validates every field", async () => {
    await db.prepare("DELETE FROM bank_account_exact_map").run();
    const put = (body: unknown) =>
      send<MatchAccountMapResponse>("admin", "PUT", "/api/matching/account-map", body);
    const auditBefore = (await auditRows("matching.account_map_set")).length;
    const r = await put({
      bankAccountId: w.accountId,
      divisionId: w.divisionId,
      journalCode: "91",
      bankGlAccountCode: "1220",
    });
    expect(r.status).toBe(200);
    expect(r.body.accounts[0]).toMatchObject({
      journalCode: "91",
      bankGlAccountCode: "1220",
      updatedBy: "admin@camelthorncapital.com",
    });
    expect((await auditRows("matching.account_map_set")).length - auditBefore).toBe(1);
    const changed = await put({
      bankAccountId: w.accountId,
      divisionId: w.divisionId,
      journalCode: "92",
      bankGlAccountCode: "1220",
    });
    expect(changed.body.accounts[0]?.journalCode).toBe("92");
    expect((await auditRows("matching.account_map_changed")).length).toBeGreaterThan(0);
    const cases: [unknown, number, string][] = [
      [{ divisionId: w.divisionId }, 400, "bad_account"],
      [
        {
          bankAccountId: 99999,
          divisionId: w.divisionId,
          journalCode: "90",
          bankGlAccountCode: "1",
        },
        404,
        "unknown_account",
      ],
      [
        {
          bankAccountId: w.accountId,
          divisionId: 99999,
          journalCode: "90",
          bankGlAccountCode: "1",
        },
        422,
        "unknown_division",
      ],
      [
        {
          bankAccountId: w.accountId,
          divisionId: w.divisionId,
          journalCode: "bad code",
          bankGlAccountCode: "1",
        },
        400,
        "bad_journal_code",
      ],
      [
        { bankAccountId: w.accountId, divisionId: w.divisionId, journalCode: "90" },
        400,
        "bad_gl_account",
      ],
      [
        {
          bankAccountId: w.accountId,
          divisionId: w.divisionId,
          journalCode: "12345678901",
          bankGlAccountCode: "1",
        },
        400,
        "bad_journal_code",
      ],
      [
        { bankAccountId: w.accountId, divisionId: "1", journalCode: "90", bankGlAccountCode: "1" },
        400,
        "bad_division",
      ],
      [
        {
          bankAccountId: w.accountId,
          divisionId: w.divisionId,
          journalCode: "90",
          bankGlAccountCode: "1",
          x: 1,
        },
        400,
        "bad_request",
      ],
    ];
    for (const [body, status, code] of cases) {
      const x = await put(body);
      expect([x.status, err(x)], JSON.stringify(body)).toEqual([status, code]);
    }
    const removed = await put({ bankAccountId: w.accountId, divisionId: null });
    expect(removed.body.accounts[0]).toMatchObject({ divisionId: null, journalCode: null });
    expect((await auditRows("matching.account_map_removed")).length).toBeGreaterThan(0);
  });

  it("refuses an administration that is disabled or not synced", async () => {
    const { addDivision } = await import("./sync-helpers");
    const off = await addDivision({ status: "disabled" });
    const r = await send("admin", "PUT", "/api/matching/account-map", {
      bankAccountId: w.accountId,
      divisionId: off.id,
      journalCode: "90",
      bankGlAccountCode: "1210",
    });
    expect(err(r)).toBe("unknown_division");
    const notSynced = await addDivision();
    await db
      .prepare("UPDATE divisions SET sync_enabled = 0 WHERE id = ?1")
      .bind(notSynced.id)
      .run();
    expect(
      err(
        await send("admin", "PUT", "/api/matching/account-map", {
          bankAccountId: w.accountId,
          divisionId: notSynced.id,
          journalCode: "90",
          bankGlAccountCode: "1210",
        }),
      ),
    ).toBe("unknown_division");
  });

  it("will not change or remove the mapping of an account that has live matches", async () => {
    const { addDivision } = await import("./sync-helpers");
    const t = await tx({ amountMinor: 100 });
    expect(
      (
        await send("finance", "POST", "/api/matching/matches", {
          transactionId: t,
          ledgerAccountCode: "4500",
        })
      ).status,
    ).toBe(201);
    const other = await addDivision();
    const move = await send("admin", "PUT", "/api/matching/account-map", {
      bankAccountId: w.accountId,
      divisionId: other.id,
      journalCode: "90",
      bankGlAccountCode: "1210",
    });
    expect([move.status, err(move)]).toEqual([409, "has_live_matches"]);
    const del = await send("admin", "PUT", "/api/matching/account-map", {
      bankAccountId: w.accountId,
      divisionId: null,
    });
    expect(err(del)).toBe("has_live_matches");
    // Changing only the journal is fine.
    expect(
      (
        await send("admin", "PUT", "/api/matching/account-map", {
          bankAccountId: w.accountId,
          divisionId: w.divisionId,
          journalCode: "95",
          bankGlAccountCode: "1210",
        })
      ).status,
    ).toBe(200);
  });
});

describe("ledger patterns", () => {
  const post = (body: unknown) =>
    send<{ pattern: MatchPatternDto }>("admin", "POST", "/api/matching/patterns", body);

  it("creates, lists, updates and deletes a pattern, audited; the engine then suggests it", async () => {
    const created = await post({
      name: "Bank fees",
      ledgerAccountCode: "4510",
      counterpartyNameRegex: "^revolut",
      type: "fee",
      direction: "out",
      maxAmountMinor: 5_000,
    });
    expect(created.status).toBe(201);
    expect(created.body.pattern).toMatchObject({
      name: "Bank fees",
      ledgerAccountCode: "4510",
      enabled: true,
      createdBy: "admin@camelthorncapital.com",
      maxAmountMinor: 5_000,
    });
    const id = created.body.pattern.id;
    expect(await auditRows("matching.pattern_created", id)).toHaveLength(1);
    const t = await tx({
      amountMinor: -300,
      type: "fee",
      counterpartyName: "Revolut Business",
      accountType: "revolut",
    });
    await runMatching(jobContext());
    const q = await get<MatchQueueResponse>("viewer", "/api/matching/queue");
    const c = q.body.items.find((i) => i.transaction.id === t)?.candidates[0];
    expect(c).toMatchObject({ rule: 4, kind: "ledger", ledgerAccountCode: "4510" });
    expect(c?.blocked.map((b) => b.code)).toContain("ledger_auto_disabled");
    const list = await get<{ patterns: MatchPatternDto[] }>("admin", "/api/matching/patterns");
    expect(list.body.patterns.map((p) => p.id)).toEqual([id]);
    const upd = await send<{ pattern: MatchPatternDto }>(
      "admin",
      "PUT",
      `/api/matching/patterns/${id}`,
      { name: "Bank fees", ledgerAccountCode: "4511", type: "fee", enabled: false },
    );
    expect(upd.body.pattern).toMatchObject({
      ledgerAccountCode: "4511",
      enabled: false,
      counterpartyNameRegex: null,
    });
    expect(await auditRows("matching.pattern_updated", id)).toHaveLength(1);
    expect((await send("admin", "DELETE", `/api/matching/patterns/${id}`)).status).toBe(200);
    expect(await auditRows("matching.pattern_deleted", id)).toHaveLength(1);
    expect((await send("admin", "DELETE", `/api/matching/patterns/${id}`)).status).toBe(404);
    expect(
      (
        await send("admin", "PUT", `/api/matching/patterns/${id}`, {
          name: "x",
          ledgerAccountCode: "1",
          type: "fee",
        })
      ).status,
    ).toBe(404);
  });

  it("refuses regexes outside the safe subset and every malformed field", async () => {
    const base = { name: "p", ledgerAccountCode: "4510" };
    const cases: [unknown, number, string][] = [
      [{ ...base, referenceRegex: "(a+)+$" }, 422, "pattern_not_allowed"],
      [{ ...base, referenceRegex: "(a|b)*c" }, 422, "pattern_not_allowed"],
      [{ ...base, counterpartyNameRegex: "(?=x)y" }, 422, "pattern_not_allowed"],
      [{ ...base, counterpartyNameRegex: "(a)\\1" }, 422, "pattern_not_allowed"],
      [{ ...base, referenceRegex: "[a-" }, 422, "pattern_not_allowed"],
      [{ ...base, referenceRegex: "x".repeat(201) }, 400, "bad_reference_regex"],
      [{ ...base }, 422, "pattern_not_allowed"],
      [{ name: "", ledgerAccountCode: "4510", type: "fee" }, 400, "bad_name"],
      [{ ...base, type: "Fee Type" }, 400, "bad_type"],
      [{ ...base, type: "fee", direction: "sideways" }, 400, "bad_direction"],
      [{ ...base, type: "fee", maxAmountMinor: 0 }, 400, "bad_max_amount"],
      [{ ...base, type: "fee", maxAmountMinor: 1.5 }, 400, "bad_max_amount"],
      [{ ...base, type: "fee", enabled: "yes" }, 400, "bad_enabled"],
      [{ name: "p", ledgerAccountCode: "bad code", type: "fee" }, 400, "bad_ledger_account"],
      [{ ...base, type: "fee", extra: 1 }, 400, "bad_request"],
    ];
    for (const [body, status, code] of cases) {
      const r = await post(body);
      expect([r.status, err(r)], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(
      (await get<{ patterns: unknown[] }>("admin", "/api/matching/patterns")).body.patterns,
    ).toEqual([]);
  });
});

describe("response shapes", () => {
  const keys = (o: object): string[] => Object.keys(o).sort();

  it("pins the keys of the documented types", async () => {
    const { itemId, txId } = await seedPerfect();
    await runMatching(jobContext());
    const queue = (await get<MatchQueueResponse>("admin", "/api/matching/queue")).body;
    expect(keys(queue)).toEqual(["autoEnabled", "items", "nextCursor", "total"]);
    expect(keys(queue.items[0] as object)).toEqual(["candidates", "transaction"]);
    const txKeys: (keyof MatchTxDto)[] = [
      "id",
      "accountId",
      "accountName",
      "createdAt",
      "completedAt",
      "amountMinor",
      "currency",
      "type",
      "reference",
      "description",
      "counterpartyName",
      "counterpartyIbanMasked",
      "matchStatus",
      "mapped",
      "divisionId",
      "stateConflict",
      "ignore",
    ];
    expect(keys(queue.items[0]?.transaction as object)).toEqual([...txKeys].sort());
    const candKeys: (keyof MatchCandidateDto)[] = [
      "rank",
      "rule",
      "kind",
      "score",
      "allocatedMinor",
      "remainingMinor",
      "surplusMinor",
      "autoEligible",
      "blocked",
      "explanation",
      "reasonCodes",
      "ledgerAccountCode",
      "groupId",
      "allocations",
      "computedAt",
    ];
    expect(keys(queue.items[0]?.candidates[0] as object)).toEqual([...candKeys].sort());
    const created = (
      await send<MatchCreateResponse>("finance", "POST", "/api/matching/matches", {
        transactionId: txId,
        allocations: [{ openItemId: itemId, allocatedMinor: 12_345 }],
      })
    ).body;
    const matchKeys: (keyof MatchDto)[] = [
      "id",
      "transactionId",
      "divisionId",
      "source",
      "status",
      "ledgerAccountCode",
      "score",
      "rule",
      "note",
      "createdBy",
      "createdAt",
      "undoneBy",
      "undoneAt",
      "undoReason",
      "exactState",
      "reviewReason",
      "undoAvailable",
      "allocations",
    ];
    expect(keys(created.match)).toEqual([...matchKeys].sort());
    expect(keys((await get<MatchStatsResponse>("admin", "/api/matching/stats")).body)).toEqual([
      "autoEnabled",
      "enabled",
      "ignored",
      "liveAutoMatches",
      "matched",
      "matchesNeedingReview",
      "oldestUnmatchedAt",
      "oldestUnmatchedDays",
      "staleSettlements",
      "suggested",
      "unmappedAccounts",
      "unmatched",
      "unmatchedOverFiveDays",
    ]);
    expect(keys((await get<MatchConfigResponse>("admin", "/api/matching/config")).body)).toEqual([
      "autoConfirmPhrase",
      "autoEnabled",
      "config",
      "configErrors",
      "defaults",
      "enabled",
      "rev",
      "updatedAt",
      "updatedBy",
    ]);
    expect(
      keys((await get<MatchAccountMapResponse>("admin", "/api/matching/account-map")).body),
    ).toEqual(["accounts", "divisions"]);
    expect(
      keys((await get<MatchDetailResponse>("admin", `/api/matching/transactions/${txId}`)).body),
    ).toEqual(["candidates", "match", "transaction"]);
    expect(keys((await get<MatchAutoResponse>("admin", "/api/matching/auto")).body)).toEqual([
      "items",
      "nextCursor",
    ]);
  });
});

describe("transaction administration (review M7d)", () => {
  it("queue, detail and auto list carry the mapped administration", async () => {
    const { txId } = await seedPerfect();
    await runMatching(jobContext());
    const q = await get<MatchQueueResponse>("viewer", "/api/matching/queue");
    expect(q.body.items[0]?.transaction.divisionId).toBe(w.divisionId);
    const d = await get<MatchDetailResponse>("viewer", `/api/matching/transactions/${txId}`);
    expect(d.body.transaction.divisionId).toBe(w.divisionId);
    await enableAuto();
    await runMatching(jobContext());
    const auto = await get<MatchAutoResponse>("viewer", "/api/matching/auto");
    expect(auto.body.items.length).toBeGreaterThan(0);
    for (const it of auto.body.items) expect(it.transaction.divisionId).toBe(w.divisionId);
  });
  it("is null when the bank account is not mapped", async () => {
    const t = await tx({ amountMinor: 777 });
    await db.prepare("DELETE FROM bank_account_exact_map").run();
    const after = await get<MatchDetailResponse>("viewer", `/api/matching/transactions/${t}`);
    expect(after.body.transaction).toMatchObject({ mapped: false, divisionId: null });
    const q = await get<MatchQueueResponse>("viewer", "/api/matching/queue");
    expect(q.body.items.length).toBeGreaterThan(0);
    for (const it of q.body.items) {
      expect(it.transaction).toMatchObject({ mapped: false, divisionId: null });
    }
  });
});

describe("GET /api/matching/items: free balances for the manual editor (review M7d)", () => {
  it("returns open minus live allocations, any role, refuses bad ids", async () => {
    const a = await addItem({ divisionId: w.divisionId, openMinor: 3_000 });
    const credit = await addItem({ divisionId: w.divisionId, openMinor: -400 });
    const closed = await addItem({ divisionId: w.divisionId, openMinor: 1_000, status: "closed" });
    const t = await tx({ amountMinor: 1_200 });
    const made = await send("finance", "POST", "/api/matching/matches", {
      transactionId: t,
      allocations: [{ openItemId: a, allocatedMinor: 1_200 }],
    });
    expect(made.status).toBe(201);
    const r = await get<MatchItemBalancesResponse>(
      "viewer",
      `/api/matching/items?ids=${a},${credit},${closed},999999`,
    );
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([
      expect.objectContaining({
        openItemId: a,
        openMinor: 3_000,
        matchedMinor: 1_200,
        freeMinor: 1_800,
      }),
      expect.objectContaining({
        openItemId: credit,
        openMinor: -400,
        matchedMinor: 0,
        freeMinor: 400,
      }),
      expect.objectContaining({ openItemId: closed, status: "closed", freeMinor: 0 }),
    ]);
    // The free amount is exactly what the server accepts: one minor unit more is refused.
    const t2 = await tx({ amountMinor: 1_801 });
    const over = await send("finance", "POST", "/api/matching/matches", {
      transactionId: t2,
      allocations: [{ openItemId: a, allocatedMinor: 1_801 }],
    });
    expect([over.status, err(over)]).toEqual([422, "allocation_exceeds_open"]);
    for (const bad of ["", "?ids=", "?ids=0", "?ids=1,x", "?ids=-1", `?ids=${"1,".repeat(20)}1`]) {
      const res = await get("viewer", `/api/matching/items${bad}`);
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("manual match: relation check and administration state (review)", () => {
  async function twoRelations(): Promise<{ ownItem: number; otherItem: number; txId: number }> {
    const own = await addRelation({
      divisionId: w.divisionId,
      ibans: [CUSTOMER_IBAN],
      name: "Acme",
    });
    const other = await addRelation({
      divisionId: w.divisionId,
      ibans: [SUPPLIER_IBAN],
      name: "Beta",
    });
    const ownItem = await addItem({
      divisionId: w.divisionId,
      openMinor: 500,
      relationExactId: own.exactId,
    });
    const otherItem = await addItem({
      divisionId: w.divisionId,
      openMinor: 500,
      relationExactId: other.exactId,
    });
    const txId = await tx({ amountMinor: 500, counterpartyIban: CUSTOMER_IBAN });
    return { ownItem, otherItem, txId };
  }

  it("an item of another relation than the IBAN's needs confirmDifferentRelation, audited", async () => {
    const { otherItem, txId } = await twoRelations();
    const body = {
      transactionId: txId,
      allocations: [{ openItemId: otherItem, allocatedMinor: 500 }],
    };
    const r = await send("finance", "POST", "/api/matching/matches", body);
    expect([r.status, err(r)]).toEqual([409, "different_relation"]);
    expect(await liveMatches()).toBe(0);
    const bad = await send("finance", "POST", "/api/matching/matches", {
      ...body,
      confirmDifferentRelation: "yes",
    });
    expect([bad.status, err(bad)]).toEqual([400, "bad_confirm"]);
    const ok = await send<MatchCreateResponse>("finance", "POST", "/api/matching/matches", {
      ...body,
      confirmDifferentRelation: true,
    });
    expect(ok.status).toBe(201);
    const audit = await auditRows("match.manual", ok.body.match.id);
    expect(JSON.parse(audit[0]?.after_json ?? "{}")).toMatchObject({
      differentRelationConfirmed: true,
    });
  });

  it("the IBAN's own relation needs no confirmation; an unknown IBAN gives no signal", async () => {
    const { ownItem, txId } = await twoRelations();
    const auditBefore = (await auditRows("match.manual")).length;
    const ok = await send("finance", "POST", "/api/matching/matches", {
      transactionId: txId,
      allocations: [{ openItemId: ownItem, allocatedMinor: 500 }],
    });
    expect(ok.status).toBe(201);
    const item = await addItem({ divisionId: w.divisionId, openMinor: 70 });
    const t2 = await tx({ amountMinor: 70, counterpartyIban: "FR7630006000011234567890189" });
    const r = await send("finance", "POST", "/api/matching/matches", {
      transactionId: t2,
      allocations: [{ openItemId: item, allocatedMinor: 70 }],
    });
    expect(r.status).toBe(201);
    // The audit row of the plain match carries no confirmation flag.
    const audit = (await auditRows("match.manual")).slice(auditBefore);
    expect(audit).toHaveLength(2);
    expect(audit.some((a) => (a.after_json ?? "").includes("differentRelationConfirmed"))).toBe(
      false,
    );
  });

  it("an administration that is no longer synced refuses manual matches", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 70 });
    const t = await tx({ amountMinor: 70 });
    await db
      .prepare("UPDATE divisions SET sync_enabled = 0 WHERE id = ?1")
      .bind(w.divisionId)
      .run();
    const r = await send("finance", "POST", "/api/matching/matches", {
      transactionId: t,
      ledgerAccountCode: "4500",
    });
    expect([r.status, err(r)]).toEqual([422, "division_inactive"]);
    void item;
  });

  it("explanations that quote Exact data never carry a full IBAN", async () => {
    const rel = await addRelation({
      divisionId: w.divisionId,
      ibans: [CUSTOMER_IBAN],
      name: `Acme ${CUSTOMER_IBAN}`,
    });
    await addItem({
      divisionId: w.divisionId,
      invoiceNumber: "INV-55",
      openMinor: 555,
      relationExactId: rel.exactId,
      relationName: `Acme ${CUSTOMER_IBAN}`,
    });
    const t = await tx({ amountMinor: 555, reference: "INV-55", counterpartyIban: CUSTOMER_IBAN });
    await runMatching(jobContext());
    const stored = await db
      .prepare("SELECT explanation_json FROM match_suggestions WHERE bank_transaction_id = ?1")
      .bind(t)
      .all<{ explanation_json: string }>();
    expect(stored.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored.results)).not.toContain(CUSTOMER_IBAN);
    const d = await get<MatchDetailResponse>("viewer", `/api/matching/transactions/${t}`);
    expect(JSON.stringify(d.body)).not.toContain(CUSTOMER_IBAN);
  });

  it("stats count matches that need review", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 300 });
    const t = await tx({ amountMinor: 300 });
    expect(
      (
        await send("finance", "POST", "/api/matching/matches", {
          transactionId: t,
          allocations: [{ openItemId: item, allocatedMinor: 300 }],
        })
      ).status,
    ).toBe(201);
    await db.prepare("UPDATE open_items SET open_minor = 100 WHERE id = ?1").bind(item).run();
    await runMatching(jobContext());
    const s = await get<MatchStatsResponse>("viewer", "/api/matching/stats");
    expect(s.body.matchesNeedingReview).toBe(1);
    const m = await get<MatchDetailResponse>("viewer", `/api/matching/transactions/${t}`);
    expect(m.body.match).toMatchObject({ reviewReason: "over_allocated", undoAvailable: true });
  });
});
