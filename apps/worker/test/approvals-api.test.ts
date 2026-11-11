import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addDays,
  amsterdamParts,
  type ApprovalDetail,
  type ApprovalItemDto,
  type ApprovalStatus,
  type ApprovalStatusCodesResponse,
  type ApprovalsResponse,
  type Freshness,
} from "@camelthorn/core";
import { buildCountsQuery, buildListQuery } from "../src/read/approvals-routes";
import { addSession, addUser, authed, call, resetDb } from "./helpers";
import { resetExact, seedConnection } from "./exact-helpers";

const db = env.DB;
const tokens: Record<string, string> = {};
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
const todayDate = (): string => amsterdamParts(Date.now()).date;

let divA = 0;
let divB = 0;
let divOff = 0;
let relA = 0;

const G = (n: number): string => `00000000-0000-0000-0000-${String(8000 + n).padStart(12, "0")}`;
const SUPPLIER = "00000000-0000-0000-0000-000000000777";

async function addDivision(connection: number, name: string): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO divisions (connection_id, exact_division, name, base_currency, sync_enabled,
         base_currency_read_at) VALUES (?1, ?2, ?3, 'EUR', 1, '2026-01-01T00:00:00.000Z')`,
    )
    .bind(connection, Math.floor(Math.random() * 1e9), name)
    .run();
  return r.meta.last_row_id;
}

interface E {
  division?: number;
  number?: string | null;
  relation?: string | null;
  name?: string | null;
  currency?: string;
  amount?: number;
  entryDate?: string | null;
  dueDate?: string | null;
  code?: number | null;
  status?: ApprovalStatus;
  submittedAt?: string | null;
  pdf?: number | null;
  dc?: number | null;
}
async function addEntry(k: number, e: E = {}): Promise<number> {
  const name = e.name === undefined ? `Supplier ${k}` : e.name;
  const number = e.number === undefined ? String(70000 + k) : e.number;
  const r = await db
    .prepare(
      `INSERT INTO purchase_entries (division_id, exact_id, entry_number, relation_id, relation_name,
         currency, amount_minor, amount_dc_minor, dc_currency, entry_date, due_date, status_code,
         status, submitted_at, modified_at, has_pdf, search_text, synced_at, last_seen_sync_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 3)`,
    )
    .bind(
      e.division ?? divA,
      G(k),
      number,
      e.relation === undefined ? null : e.relation,
      name,
      e.currency ?? "EUR",
      e.amount ?? 10000 + k,
      e.dc ?? null,
      e.dc === null || e.dc === undefined ? null : "EUR",
      e.entryDate === undefined ? addDays(todayDate(), -k) : e.entryDate,
      e.dueDate === undefined ? null : e.dueDate,
      e.code === undefined ? 5 : e.code,
      e.status ?? "pending_approval",
      e.submittedAt === undefined ? null : e.submittedAt,
      "2026-07-01T00:00:00.000Z",
      e.pdf === undefined ? 1 : e.pdf,
      [number, name]
        .filter((v): v is string => v !== null)
        .map((v) =>
          v
            .normalize("NFKD")
            .replace(/\p{M}+/gu, "")
            .toLowerCase(),
        )
        .join("\n"),
      "2026-07-01T00:00:00.000Z",
    )
    .run();
  return r.meta.last_row_id;
}

async function markSynced(
  division: number,
  completedAt: string | null = hoursAgo(1),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (division_id, entity, mode, last_status, last_completed_at)
       VALUES (?1, 'purchase_entries', 'full', 'ok', ?2)`,
    )
    .bind(division, completedAt)
    .run();
}

const get = async <T>(path: string, who = "admin"): Promise<{ status: number; body: T }> => {
  const res = await authed(path, tokens[who] as string);
  return { status: res.status, body: (await res.json()) as T };
};

beforeEach(async () => {
  await resetDb();
  await resetExact();
  for (const [key, email, roles] of [
    ["admin", "gerrie.grobbelaar@camelthorncapital.com", ["admin"]],
    ["finance", "fin@camelthorncapital.com", ["finance"]],
    ["viewer", "v@camelthorncapital.com", ["viewer"]],
    ["approver", "ap@camelthorncapital.com", ["approver"]],
  ] as const) {
    tokens[key] = await addSession(await addUser(email, [...roles]));
  }
  const conn = await seedConnection();
  const off = await db
    .prepare(
      "INSERT INTO connections (kind, name, status) VALUES ('exact', 'exact-off', 'disabled')",
    )
    .run();
  divA = await addDivision(conn, "Alpha BV");
  divB = await addDivision(conn, "Beta BV");
  divOff = await addDivision(off.meta.last_row_id, "Gamma BV");
  // A supplier with an email and an IBAN: neither may ever appear in the approvals API.
  const rel = await db
    .prepare(
      `INSERT INTO relations (division_id, exact_id, code, name, is_supplier, email, iban, vat_number,
         updated_at) VALUES (?1, ?2, '1', 'Linked Supplier BV', 1, 'secret.person@supplier.example',
         'NL91ABNA0417164300', 'NL123456789B01', '2026-01-01T00:00:00Z')`,
    )
    .bind(divA, SUPPLIER)
    .run();
  relA = rel.meta.last_row_id;
});

describe("access and validation", () => {
  it("rejects anonymous callers on both routes", async () => {
    expect((await call("/api/approvals")).status).toBe(401);
    expect((await call("/api/approvals/1")).status).toBe(401);
  });

  it("lets every role read, with no-store", async () => {
    await markSynced(divA);
    const id = await addEntry(1);
    for (const who of ["admin", "finance", "viewer", "approver"]) {
      for (const p of [`/api/approvals?division=${divA}`, `/api/approvals/${id}`]) {
        const res = await authed(p, tokens[who] as string);
        expect(res.status, `${who} ${p}`).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    }
  });

  it("is read-only: other methods are not routed", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await authed(`/api/approvals`, tokens["admin"] as string, { method });
      expect([404, 405], method).toContain(res.status);
    }
  });

  it("answers 400 for malformed parameters with a stable code", async () => {
    await markSynced(divA);
    const bad: [string, string][] = [
      ["status=unknown", "bad_status"],
      ["status=nonsense", "bad_status"],
      ["status=", "bad_status"],
      ["status=PENDING_APPROVAL", "bad_status"],
      ["limit=0", "bad_limit"],
      ["limit=101", "bad_limit"],
      ["limit=abc", "bad_limit"],
      ["limit=-1", "bad_limit"],
      ["limit=1.5", "bad_limit"],
      ["cursor=garbage!", "bad_cursor"],
      ["cursor=e30", "bad_cursor"],
      [`q=${"x".repeat(101)}`, "bad_q"],
      ["q=a b c d e f g h i", "bad_q"],
      ["division=abc", "bad_division"],
      ["division=0", "bad_division"],
      ["division=1;DROP", "bad_division"],
    ];
    for (const [qs, code] of bad) {
      const r = await get<{ error: string }>(`/api/approvals?${qs}`);
      expect([qs, r.status, r.body.error]).toEqual([qs, 400, code]);
    }
    expect((await get<{ error: string }>("/api/approvals/abc")).body.error).toBe("bad_id");
    expect((await get<{ error: string }>("/api/approvals/0")).status).toBe(400);
  });

  it("answers 404 for an unknown or disabled division and a missing row", async () => {
    expect((await get(`/api/approvals?division=999999`)).status).toBe(404);
    expect((await get(`/api/approvals?division=${divOff}`)).status).toBe(404);
    expect((await get(`/api/approvals/999999`)).status).toBe(404);
  });

  it("does not show rows of another or a disabled division (IDOR)", async () => {
    await markSynced(divA);
    await markSynced(divB);
    const mine = await addEntry(1, { division: divA });
    const theirs = await addEntry(2, { division: divB });
    const hidden = await addEntry(3, { division: divOff });
    const a = await get<ApprovalsResponse>(`/api/approvals?division=${divA}`);
    expect(a.body.items.map((i) => i.id)).toEqual([mine]);
    const b = await get<ApprovalsResponse>(`/api/approvals?division=${divB}`);
    expect(b.body.items.map((i) => i.id)).toEqual([theirs]);
    expect(b.body.division).toEqual({ id: divB, name: "Beta BV" });
    // the detail route takes the division from the row, so a row of a disabled one is a 404
    expect((await get(`/api/approvals/${hidden}`)).status).toBe(404);
    expect((await get<ApprovalDetail>(`/api/approvals/${theirs}`)).body.division.id).toBe(divB);
  });
});

describe("availability and freshness", () => {
  it("is unavailable until the entity completed once, whatever rows exist", async () => {
    await addEntry(1);
    const none = await get<ApprovalsResponse>(`/api/approvals?division=${divA}`);
    expect(none.body).toMatchObject({
      available: false,
      items: [],
      total: 0,
      nextCursor: null,
      countsByStatus: { pending_approval: 0, approved: 0, rejected: 0, unknown: 0 },
    });
    expect(none.body.freshness).toEqual({
      lastCompletedAt: null,
      basis: ["purchase_entries"],
      stale: true,
      staleAfterHours: 36,
    });
    await markSynced(divA, null);
    expect((await get<ApprovalsResponse>(`/api/approvals?division=${divA}`)).body.available).toBe(
      false,
    );
  });

  it("is available after a complete read and reports its age", async () => {
    await markSynced(divA, hoursAgo(2));
    await addEntry(1);
    const r = await get<ApprovalsResponse>(`/api/approvals?division=${divA}`);
    expect(r.body.available).toBe(true);
    expect(r.body.freshness).toMatchObject({ stale: false, basis: ["purchase_entries"] });
    expect(r.body.freshness.lastCompletedAt).not.toBeNull();
  });

  it("marks a read older than 36 hours as stale but keeps the items", async () => {
    await markSynced(divA, hoursAgo(40));
    await addEntry(1);
    const r = await get<ApprovalsResponse>(`/api/approvals?division=${divA}`);
    expect(r.body.available).toBe(true);
    expect(r.body.freshness.stale).toBe(true);
    expect(r.body.items).toHaveLength(1);
  });

  it("an empty administration is available with zero everywhere", async () => {
    await markSynced(divA);
    const r = await get<ApprovalsResponse>(`/api/approvals?division=${divA}`);
    expect(r.body).toMatchObject({ available: true, items: [], total: 0, nextCursor: null });
  });
});

describe("list", () => {
  beforeEach(async () => {
    await markSynced(divA);
  });

  it("defaults to pending, oldest first, with age in Amsterdam calendar days", async () => {
    const today = todayDate();
    await addEntry(1, { entryDate: addDays(today, -2) });
    await addEntry(2, { entryDate: addDays(today, -9), submittedAt: null });
    await addEntry(3, { entryDate: addDays(today, -1), status: "approved", code: 50 });
    await addEntry(4, {
      entryDate: addDays(today, -20),
      // submitted five days ago (Amsterdam), which wins over the entry date
      submittedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const r = await get<ApprovalsResponse>(`/api/approvals?division=${divA}`);
    expect(r.body.items.map((i) => i.entryNumber)).toEqual(["70004", "70002", "70001"]);
    expect(r.body.items.map((i) => i.ageDays)).toEqual([5, 9, 2]);
    expect(r.body.total).toBe(3);
  });

  it("filters by status, newest first, with ageDays only for pending items", async () => {
    const today = todayDate();
    await addEntry(1, { status: "approved", code: 50, entryDate: addDays(today, -3) });
    await addEntry(2, { status: "approved", code: 50, entryDate: addDays(today, -1) });
    await addEntry(3, { status: "rejected", code: 40 });
    await addEntry(4, { status: "unknown", code: 77 });
    const approved = await get<ApprovalsResponse>(
      `/api/approvals?division=${divA}&status=approved`,
    );
    expect(approved.body.items.map((i) => i.entryNumber)).toEqual(["70002", "70001"]);
    expect(approved.body.items.every((i) => i.ageDays === null)).toBe(true);
    expect(approved.body.total).toBe(2);
    const rejected = await get<ApprovalsResponse>(
      `/api/approvals?division=${divA}&status=rejected`,
    );
    expect(rejected.body.items.map((i) => i.status)).toEqual(["rejected"]);
    const all = await get<ApprovalsResponse>(`/api/approvals?division=${divA}&status=all`);
    expect(all.body.items).toHaveLength(4);
    expect(all.body.total).toBe(4);
    expect(all.body.items.find((i) => i.status === "unknown")).toBeDefined();
  });

  it("counts every status, following the search but not the status filter", async () => {
    await addEntry(1, { name: "Müller Verpackung" });
    await addEntry(2, { name: "Muller Transport", status: "approved", code: 50 });
    await addEntry(3, { name: "Other BV", status: "approved", code: 50 });
    await addEntry(4, { name: "Muller Rent", status: "unknown", code: 3 });
    const base = await get<ApprovalsResponse>(`/api/approvals?division=${divA}&status=approved`);
    expect(base.body.countsByStatus).toEqual({
      pending_approval: 1,
      approved: 2,
      rejected: 0,
      unknown: 1,
    });
    expect(base.body.total).toBe(2);
    const q = await get<ApprovalsResponse>(
      `/api/approvals?division=${divA}&status=approved&q=${encodeURIComponent("MULLER")}`,
    );
    expect(q.body.countsByStatus).toEqual({
      pending_approval: 1,
      approved: 1,
      rejected: 0,
      unknown: 1,
    });
    expect(q.body.total).toBe(1);
    expect(q.body.items.map((i) => i.entryNumber)).toEqual(["70002"]);
  });

  it("searches entry number and supplier name, ignoring case and diacritics, all words must match", async () => {
    await addEntry(1, { name: "Café Zürich AG" });
    await addEntry(2, { name: "Zürich Rent" });
    const find = async (q: string): Promise<string[]> =>
      (
        await get<ApprovalsResponse>(
          `/api/approvals?division=${divA}&status=all&q=${encodeURIComponent(q)}`,
        )
      ).body.items
        .map((i) => i.entryNumber ?? "")
        .sort();
    expect(await find("zurich")).toEqual(["70001", "70002"]);
    expect(await find("CAFE zurich")).toEqual(["70001"]);
    expect(await find("70002")).toEqual(["70002"]);
    expect(await find("nothing")).toEqual([]);
    // LIKE wildcards in the query are literals
    expect(await find("%")).toEqual([]);
    expect(await find("_")).toEqual([]);
    expect(await find("' OR 1=1 --")).toEqual([]);
  });

  it("pages with a stable cursor: no duplicates or gaps, also when rows are added meanwhile", async () => {
    const same = addDays(todayDate(), -4);
    for (let k = 1; k <= 7; k++) await addEntry(k, { entryDate: same });
    await addEntry(8, { entryDate: null });
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { body: ApprovalsResponse } = await get<ApprovalsResponse>(
        `/api/approvals?division=${divA}&limit=3${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      seen.push(...r.body.items.map((i) => i.id));
      if (pages === 0) expect(r.body.total).toBe(8);
      cursor = r.body.nextCursor;
      if (pages === 0) {
        // a new entry with the newest date lands after the cursor in the pending order
        await addEntry(9, { entryDate: addDays(todayDate(), -1) });
        // and one older than everything lands before it: it must not show up as a duplicate
        await addEntry(10, { entryDate: addDays(todayDate(), -400) });
      }
      pages++;
    } while (cursor !== null && pages < 10);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(9); // the 8 from the start plus the newer one
    expect(pages).toBe(3);
    // the first 3 of the walk are the oldest: the undated one first, then equal dates by id
    const ids = await db
      .prepare("SELECT id FROM purchase_entries WHERE exact_id IN (?1, ?2, ?3) ORDER BY id")
      .bind(G(8), G(1), G(2))
      .all<{ id: number }>();
    expect(seen.slice(0, 3)).toEqual([ids.results[2]?.id, ids.results[0]?.id, ids.results[1]?.id]);
  });

  it("walks status=all newest first to the end", async () => {
    for (let k = 1; k <= 5; k++) await addEntry(k, { status: "approved", code: 50 });
    const first = await get<ApprovalsResponse>(
      `/api/approvals?division=${divA}&status=all&limit=2`,
    );
    expect(first.body.items.map((i) => i.entryNumber)).toEqual(["70001", "70002"]);
    const second = await get<ApprovalsResponse>(
      `/api/approvals?division=${divA}&status=all&limit=2&cursor=${first.body.nextCursor}`,
    );
    const third = await get<ApprovalsResponse>(
      `/api/approvals?division=${divA}&status=all&limit=2&cursor=${second.body.nextCursor}`,
    );
    expect(second.body.items.map((i) => i.entryNumber)).toEqual(["70003", "70004"]);
    expect(third.body.items.map((i) => i.entryNumber)).toEqual(["70005"]);
    expect(third.body.nextCursor).toBeNull();
  });

  it("refuses a cursor issued for the other sort direction", async () => {
    for (let k = 1; k <= 4; k++) await addEntry(k);
    const pending = await get<ApprovalsResponse>(`/api/approvals?division=${divA}&limit=2`);
    const r = await get<{ error: string }>(
      `/api/approvals?division=${divA}&status=all&cursor=${pending.body.nextCursor}`,
    );
    expect([r.status, r.body.error]).toEqual([400, "bad_cursor"]);
  });

  it("returns exactly the documented fields and links the relation row when it exists", async () => {
    await addEntry(1, {
      relation: SUPPLIER,
      name: "Entry-time name",
      currency: "USD",
      amount: -12345,
      dueDate: "2026-08-01",
      pdf: 0,
    });
    await addEntry(2, { relation: null, name: null, pdf: null });
    await addEntry(3, { relation: SUPPLIER, name: null });
    const r = await get<ApprovalsResponse>(`/api/approvals?division=${divA}&status=all`);
    const byNr = (nr: string): ApprovalItemDto =>
      r.body.items.find((i) => i.entryNumber === nr) as ApprovalItemDto;
    expect(byNr("70001")).toMatchObject({
      exactId: G(1),
      relation: { id: relA, name: "Entry-time name" },
      currency: "USD",
      amountMinor: -12345,
      dueDate: "2026-08-01",
      hasPdf: false,
      status: "pending_approval",
    });
    expect(byNr("70002").relation).toBeNull();
    expect(byNr("70002").hasPdf).toBeNull();
    // no name on the entry: the relation row's name
    expect(byNr("70003").relation).toEqual({ id: relA, name: "Linked Supplier BV" });
  });

  it("never returns an IBAN, an email address or a VAT number", async () => {
    await addEntry(1, { relation: SUPPLIER });
    const list = await authed(
      `/api/approvals?division=${divA}&status=all`,
      tokens["admin"] as string,
    );
    const id = (await db.prepare("SELECT id FROM purchase_entries").first<{ id: number }>())?.id;
    const detail = await authed(`/api/approvals/${id}`, tokens["admin"] as string);
    for (const res of [list, detail]) {
      const text = await res.text();
      expect(text).not.toMatch(/NL91|secret\.person|supplier\.example|NL123456789|iban|email|vat/i);
    }
  });
});

describe("detail", () => {
  it("adds the raw status code, the division amount and the provenance", async () => {
    await markSynced(divA);
    const id = await addEntry(1, { code: 77, status: "unknown", dc: 9000, pdf: 1 });
    const r = await get<ApprovalDetail>(`/api/approvals/${id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      division: { id: divA, name: "Alpha BV" },
      item: { id, status: "unknown", hasPdf: true, ageDays: null },
      statusCode: 77,
      amountDcMinor: 9000,
      dcCurrency: "EUR",
      modifiedAt: "2026-07-01T00:00:00.000Z",
      provenance: { lastSeenAt: "2026-07-01T00:00:00.000Z", lastSeenSyncId: 3, missedCycles: 0 },
    });
  });
});

describe("response shapes", () => {
  const keysOf =
    <T>() =>
    <const K extends readonly (keyof T)[]>(
      k: K & ([keyof T] extends [K[number]] ? unknown : "missing keys"),
    ): string[] =>
      [...k].map(String).sort();
  const ITEM = keysOf<ApprovalItemDto>()([
    "id",
    "exactId",
    "entryNumber",
    "relation",
    "currency",
    "amountMinor",
    "dueDate",
    "entryDate",
    "status",
    "submittedAt",
    "ageDays",
    "hasPdf",
  ]);
  const LIST = keysOf<ApprovalsResponse>()([
    "division",
    "items",
    "nextCursor",
    "total",
    "countsByStatus",
    "freshness",
    "available",
  ]);
  const DETAIL = keysOf<ApprovalDetail>()([
    "division",
    "item",
    "statusCode",
    "amountDcMinor",
    "dcCurrency",
    "modifiedAt",
    "provenance",
  ]);
  const FRESH = keysOf<Freshness>()(["lastCompletedAt", "basis", "stale", "staleAfterHours"]);
  const sorted = (o: object): string[] => Object.keys(o).sort();

  it("has exactly the keys of the types in api-types.ts", async () => {
    await markSynced(divA);
    const id = await addEntry(1, { relation: SUPPLIER, dueDate: "2026-08-01" });
    const list = await get<ApprovalsResponse>(`/api/approvals?division=${divA}`);
    expect(sorted(list.body)).toEqual(LIST);
    expect(sorted(list.body.division)).toEqual(["id", "name"]);
    expect(sorted(list.body.freshness)).toEqual(FRESH);
    expect(sorted(list.body.countsByStatus)).toEqual(
      ["approved", "pending_approval", "rejected", "unknown"].sort(),
    );
    expect(sorted(list.body.items[0] as ApprovalItemDto)).toEqual(ITEM);
    expect(sorted((list.body.items[0] as ApprovalItemDto).relation as object)).toEqual([
      "id",
      "name",
    ]);
    const detail = await get<ApprovalDetail>(`/api/approvals/${id}`);
    expect(sorted(detail.body)).toEqual(DETAIL);
    expect(sorted(detail.body.item)).toEqual(ITEM);
    expect(sorted(detail.body.provenance)).toEqual([
      "lastSeenAt",
      "lastSeenSyncId",
      "missedCycles",
    ]);
    // the unavailable answer has the same keys
    const off = await get<ApprovalsResponse>(`/api/approvals?division=${divB}`);
    expect(sorted(off.body)).toEqual(LIST);
    expect(sorted(off.body.freshness)).toEqual(FRESH);
  });
});

describe("list query plan", () => {
  it("uses the list index for a status filter and the all-index otherwise", async () => {
    const plan = async (b: { sql: string; binds: (string | number)[] }): Promise<string> =>
      (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${b.sql}`)
          .bind(...b.binds)
          .all<{ detail: string }>()
      ).results
        .map((r) => r.detail)
        .join("\n");
    const filtered = await plan(buildListQuery(1, "pending_approval", [], "asc", null, 51));
    expect(filtered).toContain("idx_purchase_entries_list");
    expect(filtered).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    const all = await plan(buildListQuery(1, "all", [], "desc", null, 51));
    expect(all).toContain("idx_purchase_entries_list_all");
    expect(all).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    const counts = await plan(buildCountsQuery(1, []));
    expect(counts).toMatch(/purchase_entries/);
  });
});

describe("status codes for verifying the mapping (review K4)", () => {
  it("is admin only and counts cached entries per raw code, stored and mapped status", async () => {
    await markSynced(divA);
    await addEntry(1, { code: 5, status: "pending_approval" });
    await addEntry(2, { code: 5, status: "pending_approval" });
    await addEntry(3, { code: 50, status: "approved" });
    await addEntry(4, { code: 77, status: "unknown" });
    await addEntry(5, { code: null, status: "unknown" });
    // a row derived under an older table: stored and mapped status differ
    await addEntry(6, { code: 20, status: "rejected" });
    await addEntry(7, { code: 5, division: divB });

    expect((await call("/api/approvals/status-codes")).status).toBe(401);
    for (const who of ["finance", "viewer", "approver"]) {
      expect((await get(`/api/approvals/status-codes?division=${divA}`, who)).status, who).toBe(
        403,
      );
    }
    const r = await get<ApprovalStatusCodesResponse>(
      `/api/approvals/status-codes?division=${divA}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.division).toEqual({ id: divA, name: "Alpha BV" });
    expect(r.body.table).toEqual([
      { statusCode: 5, status: "pending_approval" },
      { statusCode: 50, status: "approved" },
    ]);
    expect(
      r.body.codes.map((c) => [c.statusCode, c.storedStatus, c.mappedStatus, c.count]),
    ).toEqual([
      [5, "pending_approval", "pending_approval", 2],
      [20, "rejected", "unknown", 1],
      [50, "approved", "approved", 1],
      [77, "unknown", "unknown", 1],
      [null, "unknown", "unknown", 1],
    ]);
    expect(r.body.codes[0]?.lastSeenAt).toBe("2026-07-01T00:00:00.000Z");
    // counts only: nothing about suppliers, amounts or bank details
    const text = JSON.stringify(r.body);
    for (const leak of ["Supplier", "NL91", "@", "10001"]) expect(text).not.toContain(leak);
    expect((await get(`/api/approvals/status-codes?division=${divOff}`)).status).toBe(404);
    expect((await get(`/api/approvals/status-codes?division=abc`)).status).toBe(400);
  });
});
