import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addDays,
  AGEING_BUCKETS,
  amsterdamParts,
  type AgeingReportResponse,
  type AgeingReportRow,
  type AgeingReportTotals,
  type CurrencyKpisDto,
  type CurrencyTotal,
  type DivisionRef,
  type DrilldownHint,
  type Freshness,
  type KpiAmountDto,
  type OpenItemDetail,
  type OpenItemListResponse,
  type OpenItemRow,
  type OverviewResponse,
  type RelationRef,
  type RelationSummary,
  type SyncFreshnessEntry,
} from "@camelthorn/core";
import { addSession, addUser, authed, resetDb } from "./helpers";
import { resetExact, seedConnection } from "./exact-helpers";

/**
 * The read API's responses have EXACTLY the keys of the types in packages/core/src/api-types.ts,
 * so the web app (K3) can rely on them. `keysOf<T>()` fails to compile when a key of T is missing
 * from the list; the runtime check fails when a response has a key the list (and so the type)
 * does not, or lacks one.
 */
const keysOf =
  <T>() =>
  <const K extends readonly (keyof T)[]>(
    k: K & ([keyof T] extends [K[number]] ? unknown : "missing keys"),
  ): string[] =>
    [...k].map(String).sort();

const DIVISION = keysOf<DivisionRef>()(["id", "name", "currency", "currencyVerified"]);
const RELATION_REF = keysOf<RelationRef>()(["id", "name"]);
const ROW = keysOf<OpenItemRow>()([
  "id",
  "exactId",
  "kind",
  "status",
  "invoiceNumber",
  "entryNumber",
  "reference",
  "relation",
  "invoiceDate",
  "dueDate",
  "currency",
  "originalMinor",
  "openMinor",
  "dcMinor",
  "dcCurrency",
  "bucket",
  "daysOverdue",
  "source",
  "lastSeenAt",
  "possiblyPaid",
]);
const TOTAL = keysOf<CurrencyTotal>()([
  "currency",
  "count",
  "openMinor",
  "dcMinor",
  "dcMissing",
  "dcComplete",
  "possiblyPaid",
]);
const LIST = keysOf<OpenItemListResponse>()([
  "division",
  "asOf",
  "items",
  "nextCursor",
  "limit",
  "total",
  "totalsByCurrency",
  "freshness",
]);
const DETAIL = keysOf<OpenItemDetail>()([
  "division",
  "asOf",
  "item",
  "amountMinor",
  "rate",
  "closedAt",
  "openDcMinor",
  "storedDcCurrency",
  "relation",
  "provenance",
  "exactLink",
]);
const PROVENANCE = keysOf<OpenItemDetail["provenance"]>()([
  "lastSeenAt",
  "lastSeenSyncId",
  "missedCycles",
  "source",
]);
const RELATION = keysOf<RelationSummary>()([
  "id",
  "divisionId",
  "exactId",
  "code",
  "name",
  "isCustomer",
  "isSupplier",
  "country",
  "hasVatNumber",
  "hasEmail",
  "updatedAt",
]);
const HINT = keysOf<DrilldownHint>()(["path", "query"]);
const AGEING = keysOf<AgeingReportResponse>()([
  "division",
  "kind",
  "asOf",
  "currencies",
  "totalsByCurrency",
  "freshness",
]);
const AGEING_ROW = keysOf<AgeingReportRow>()([
  "relation",
  "buckets",
  "bucketCounts",
  "totalMinor",
  "count",
  "dcMinor",
  "dcComplete",
]);
const AGEING_TOTALS = keysOf<AgeingReportTotals>()([
  "currency",
  "buckets",
  "bucketCounts",
  "totalMinor",
  "count",
  "dcMinor",
  "dcComplete",
  "drilldown",
]);
const FRESHNESS = keysOf<Freshness>()(["lastCompletedAt", "basis", "stale", "staleAfterHours"]);
const KPI_AMOUNT = keysOf<KpiAmountDto>()(["count", "minor", "dcMinor", "dcComplete"]);
const KPIS = keysOf<CurrencyKpisDto>()([
  "currency",
  "total",
  "overdue",
  "due7",
  "due30",
  "noDueDate",
  "avgDaysOverdue",
  "drilldown",
]);
const OVERVIEW = keysOf<OverviewResponse>()([
  "division",
  "asOf",
  "stale",
  "freshness",
  "kpis",
  "lastSync",
]);
const SYNC_ENTRY = keysOf<SyncFreshnessEntry>()([
  "entity",
  "status",
  "completedAt",
  "finishedAt",
  "error",
]);
const BUCKETS = [...AGEING_BUCKETS].sort();

const keys = (v: unknown): string[] => Object.keys(v as object).sort();
const isInt = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkRow(r: OpenItemRow): void {
  expect(keys(r)).toEqual(ROW);
  expect(keys(r.relation)).toEqual(RELATION_REF);
  for (const v of [r.id, r.openMinor]) expect(isInt(v)).toBe(true);
  for (const v of [r.originalMinor, r.dcMinor, r.daysOverdue, r.entryNumber]) {
    expect(v === null || isInt(v)).toBe(true);
  }
  for (const d of [r.dueDate, r.invoiceDate]) expect(d === null || DATE.test(d)).toBe(true);
}

function checkHints(h: Record<string, DrilldownHint>, want: string[]): void {
  expect(keys(h)).toEqual(want);
  for (const x of Object.values(h)) {
    expect(keys(x)).toEqual(HINT);
    for (const v of Object.values(x.query)) expect(typeof v).toBe("string");
  }
}

const db = env.DB;
let token = "";
let division = 0;

beforeEach(async () => {
  await resetDb();
  await resetExact();
  await db.batch([db.prepare("DELETE FROM relations")]);
  token = await addSession(await addUser("v@camelthorncapital.com", ["viewer"]));
  const conn = await seedConnection();
  division = (
    await db
      .prepare(
        `INSERT INTO divisions (connection_id, exact_division, name, base_currency, sync_enabled,
           base_currency_read_at) VALUES (?1, 1, 'Alpha BV', 'EUR', 1, '2026-01-01T00:00:00.000Z')`,
      )
      .bind(conn)
      .run()
  ).meta.last_row_id;
  const t = amsterdamParts(Date.now()).date;
  await db.batch([
    db
      .prepare(
        `INSERT INTO relations (division_id, exact_id, code, name, is_supplier, is_customer, email,
           vat_number, country, iban, updated_at)
         VALUES (?1, 'rel-1', '100', 'Acme BV', 1, 1, 'a@acme.test', 'NL1', 'NL',
           'NL91ABNA0417164300', '2026-01-02T00:00:00.000Z')`,
      )
      .bind(division),
    ...[
      ["invoice", "rel-1", addDays(t, -40), 1000, "EUR"],
      ["invoice", "rel-1", null, -250, "EUR"],
      ["invoice", null, addDays(t, 3), 500, "USD"],
      ["bill", "rel-1", addDays(t, -2), 700, "EUR"],
    ].map(([kind, rel, due, open, currency], i) =>
      db
        .prepare(
          `INSERT INTO open_items (division_id, exact_id, kind, relation_id, relation_name,
             relation_iban, invoice_number, currency, amount_minor, open_minor, due_date, status,
             synced_at, source)
           VALUES (?1, ?2, ?3, ?4, ?5, 'NL91ABNA0417164300', ?6, ?7, ?8, ?8, ?9, 'open',
             '2026-01-01T00:00:00.000Z', 'list')`,
        )
        .bind(
          division,
          `x-${i}`,
          kind,
          rel,
          rel === null ? null : "Acme BV",
          `N-${i}`,
          currency,
          open,
          due,
        ),
    ),
    db
      .prepare(
        `INSERT INTO sync_state (division_id, entity, last_status, last_completed_at)
         VALUES (?1, 'receivables', 'ok', ?2)`,
      )
      .bind(division, new Date().toISOString()),
  ]);
});

const get = async <T>(path: string): Promise<T> => {
  const res = await authed(path, token);
  expect(res.status, path).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("NL91");
  expect(text).not.toContain("a@acme");
  return JSON.parse(text) as T;
};

describe("read API response shapes match api-types.ts exactly", () => {
  it("lists", async () => {
    for (const path of ["/api/invoices?status=all", "/api/bills", "/api/invoices?q=acme"]) {
      const r = await get<OpenItemListResponse>(path);
      expect(keys(r)).toEqual(LIST);
      expect(keys(r.division)).toEqual(DIVISION);
      expect(keys(r.freshness)).toEqual(FRESHNESS);
      expect(r.freshness.basis).toEqual([
        path.startsWith("/api/bills") ? "payables" : "receivables",
      ]);
      expect(r.items.length).toBeGreaterThan(0);
      r.items.forEach(checkRow);
      for (const t of r.totalsByCurrency) {
        expect(keys(t)).toEqual(TOTAL);
        for (const v of [t.count, t.openMinor, t.dcMinor, t.dcMissing]) {
          expect(isInt(v)).toBe(true);
        }
      }
    }
  });

  it("detail and relation", async () => {
    const list = await get<OpenItemListResponse>("/api/invoices?q=N-0");
    const d = await get<OpenItemDetail>(`/api/open-items/${list.items[0]!.id}`);
    expect(keys(d)).toEqual(DETAIL);
    expect(keys(d.provenance)).toEqual(PROVENANCE);
    checkRow(d.item);
    expect(keys(d.relation)).toEqual(RELATION);
    const rel = await get<RelationSummary>(`/api/relations/${d.relation!.id}`);
    expect(keys(rel)).toEqual(RELATION);
    // Without a synced relation the detail has relation null.
    const ghost = await get<OpenItemListResponse>("/api/invoices?currency=USD");
    const g = await get<OpenItemDetail>(`/api/open-items/${ghost.items[0]!.id}`);
    expect(g.relation).toBeNull();
    expect(g.item.relation).toEqual({ id: null, name: null });
  });

  it("ageing report", async () => {
    for (const kind of ["receivable", "payable"]) {
      const r = await get<AgeingReportResponse>(`/api/reports/ageing?kind=${kind}`);
      expect(keys(r)).toEqual(AGEING);
      expect(keys(r.freshness)).toEqual(FRESHNESS);
      expect(r.currencies.length).toBeGreaterThan(0);
      for (const c of r.currencies) {
        expect(keys(c)).toEqual(["currency", "rows", "totals"]);
        for (const t of [c.totals, ...r.totalsByCurrency]) {
          expect(keys(t)).toEqual(AGEING_TOTALS);
          expect(keys(t.buckets)).toEqual(BUCKETS);
          expect(keys(t.bucketCounts)).toEqual(BUCKETS);
          checkHints(t.drilldown, [...BUCKETS, "total"].sort());
        }
        for (const row of c.rows) {
          expect(keys(row)).toEqual(AGEING_ROW);
          expect(keys(row.relation)).toEqual(RELATION_REF);
          expect(keys(row.buckets)).toEqual(BUCKETS);
          for (const v of Object.values(row.buckets)) expect(isInt(v)).toBe(true);
        }
      }
    }
  });

  it("overview", async () => {
    const o = await get<OverviewResponse>("/api/overview");
    expect(keys(o)).toEqual(OVERVIEW);
    expect(keys(o.freshness)).toEqual(FRESHNESS);
    expect(keys(o.kpis)).toEqual(["payable", "receivable"]);
    expect(o.kpis.receivable.map((k) => k.currency)).toEqual(["EUR", "USD"]);
    for (const k of [...o.kpis.receivable, ...o.kpis.payable]) {
      expect(keys(k)).toEqual(KPIS);
      for (const f of ["total", "overdue", "due7", "due30", "noDueDate"] as const) {
        expect(keys(k[f])).toEqual(KPI_AMOUNT);
      }
      checkHints(k.drilldown, ["due30", "due7", "noDueDate", "overdue", "total"]);
    }
    expect(o.lastSync.length).toBe(1);
    for (const e of o.lastSync) expect(keys(e)).toEqual(SYNC_ENTRY);
  });
});
