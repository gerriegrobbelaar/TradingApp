import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addDays,
  amsterdamParts,
  drilldownForRelation,
  type AgeingReportResponse,
  type OpenItemDetail,
  type OpenItemListResponse,
  type OverviewResponse,
  type RelationSummary,
} from "@camelthorn/core";
import worker from "../src/index";
import { buildListQuery, buildTotalsQuery } from "../src/read/queries";
import { BadRequest, fillSearchText, freshnessOf, resolveAsOf } from "../src/read/routes";
import { addSession, addUser, authed, call, ORIGIN, resetDb } from "./helpers";
import { resetExact, seedConnection } from "./exact-helpers";

const db = env.DB;
const ADMIN = "gerrie.grobbelaar@camelthorncapital.com";
const tokens: Record<string, string> = {};
const userIds: Record<string, number> = {};
const today = (): string => amsterdamParts(Date.now()).date;

let divA = 0;
let divB = 0;
let divOff = 0;

async function addDivision(
  connection: number,
  name: string,
  opts: { currency?: string; read?: boolean } = {},
): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO divisions (connection_id, exact_division, name, base_currency, sync_enabled,
         base_currency_read_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5)`,
    )
    .bind(
      connection,
      Math.floor(Math.random() * 1e9),
      name,
      opts.currency ?? "EUR",
      opts.read === false ? null : "2026-01-01T00:00:00.000Z",
    )
    .run();
  return r.meta.last_row_id;
}

let seq = 0;
interface ItemSpec {
  division?: number;
  kind?: "invoice" | "bill";
  relation?: string | null;
  name?: string | null;
  number?: string | null;
  entry?: number | null;
  currency?: string;
  open?: number;
  original?: number | null;
  dc?: number | null;
  dcCurrency?: string | null;
  due?: string | null;
  status?: "open" | "closed";
  ref?: string | null;
  source?: "list" | "sync" | null;
  iban?: string | null;
  syncedAt?: string;
  missed?: number;
}

function itemStmt(s: ItemSpec): D1PreparedStatement {
  seq++;
  const open = s.open ?? 1000;
  return db
    .prepare(
      `INSERT INTO open_items (division_id, exact_id, kind, relation_id, relation_name, relation_iban,
         invoice_number, reference, currency, stored_minor, open_minor, invoice_date, due_date, status,
         synced_at, entry_number, original_minor, open_dc_minor, dc_currency, source, last_seen_sync_id,
         missed_cycles)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '2026-01-01', ?12, ?13, ?14, ?15, ?16, ?17,
         ?18, ?19, 7, ?20)`,
    )
    .bind(
      s.division ?? divA,
      `exact-${seq}`,
      s.kind ?? "invoice",
      s.relation === undefined ? "rel-1" : s.relation,
      s.name === undefined ? "Acme BV" : s.name,
      s.iban ?? null,
      s.number === undefined ? `2026${String(seq).padStart(4, "0")}` : s.number,
      s.ref ?? null,
      s.currency ?? "EUR",
      s.original ?? open,
      s.status === "closed" ? 0 : open,
      s.due === undefined ? today() : s.due,
      s.status ?? "open",
      s.syncedAt ?? new Date().toISOString(),
      s.entry === undefined ? seq : s.entry,
      s.original === undefined ? null : s.original,
      s.dc === undefined ? null : s.dc,
      s.dcCurrency ?? null,
      s.source === undefined ? "sync" : s.source,
      s.missed ?? 1,
    );
}

async function addItems(specs: ItemSpec[]): Promise<void> {
  for (let i = 0; i < specs.length; i += 400) {
    await db.batch(specs.slice(i, i + 400).map(itemStmt));
  }
}

async function addRelation(
  division: number,
  exactId: string,
  name: string,
  over: { email?: string | null; vat?: string | null; iban?: string | null } = {},
): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO relations (division_id, exact_id, code, name, is_supplier, is_customer, email,
         vat_number, country, iban, updated_at)
       VALUES (?1, ?2, '100', ?3, 1, 1, ?4, ?5, 'NL', ?6, '2026-01-02T00:00:00.000Z')`,
    )
    .bind(division, exactId, name, over.email ?? null, over.vat ?? null, over.iban ?? null)
    .run();
  return r.meta.last_row_id;
}

const get = async <T>(path: string, who = "admin"): Promise<{ status: number; body: T }> => {
  const res = await authed(path, tokens[who] as string);
  return { status: res.status, body: (await res.json()) as T };
};

beforeEach(async () => {
  await resetDb();
  await resetExact();
  await db.batch([db.prepare("DELETE FROM relations")]);
  seq = 0;
  for (const [key, email, roles] of [
    ["admin", ADMIN, ["admin"]],
    ["finance", "fin@camelthorncapital.com", ["finance"]],
    ["viewer", "v@camelthorncapital.com", ["viewer"]],
    ["approver", "ap@camelthorncapital.com", ["approver"]],
  ] as const) {
    userIds[key] = await addUser(email, [...roles]);
    tokens[key] = await addSession(userIds[key] as number);
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
});

const cur = (v: unknown[]): string =>
  btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("access and validation", () => {
  const paths = [
    "/api/invoices",
    "/api/bills",
    "/api/overview",
    "/api/reports/ageing?kind=receivable",
    "/api/open-items/1",
    "/api/relations/1",
  ];

  it("rejects anonymous callers", async () => {
    for (const p of paths) expect((await call(p)).status, p).toBe(401);
  });

  it("lets every role read, with no-store", async () => {
    for (const who of ["admin", "finance", "viewer", "approver"]) {
      for (const p of [
        "/api/invoices",
        "/api/bills",
        "/api/overview",
        "/api/reports/ageing?kind=payable",
      ]) {
        const res = await authed(p, tokens[who] as string);
        expect(res.status, `${who} ${p}`).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    }
  });

  it("answers 400 or 404 for bad input", async () => {
    const bad: [string, number, string][] = [
      ["/api/invoices?division=abc", 400, "bad_division"],
      ["/api/invoices?division=0", 400, "bad_division"],
      ["/api/invoices?division=1.5", 400, "bad_division"],
      ["/api/invoices?division=999999", 404, "unknown_division"],
      [`/api/invoices?division=${divOff}`, 404, "unknown_division"],
      [`/api/overview?division=${divOff}`, 404, "unknown_division"],
      [`/api/reports/ageing?kind=receivable&division=${divOff}`, 404, "unknown_division"],
      ["/api/invoices?status=bogus", 400, "bad_status"],
      ["/api/invoices?limit=101", 400, "bad_limit"],
      ["/api/invoices?limit=0", 400, "bad_limit"],
      ["/api/invoices?limit=x", 400, "bad_limit"],
      ["/api/invoices?sort=amount", 400, "bad_sort"],
      ["/api/invoices?cursor=garbage!", 400, "bad_cursor"],
      ["/api/invoices?cursor=e30", 400, "bad_cursor"],
      ["/api/invoices?currency=EURO", 400, "bad_currency"],
      ["/api/invoices?dueBefore=2026-13-01", 400, "bad_due_before"],
      ["/api/invoices?dueAfter=yesterday", 400, "bad_due_after"],
      ["/api/invoices?overdue=yes", 400, "bad_overdue"],
      ["/api/invoices?relationId=-1", 400, "bad_relation_id"],
      ["/api/invoices?asOf=2001-01-01", 400, "as_of_in_past"],
      [`/api/invoices?asOf=${addDays(today(), 1)}`, 400, "as_of_in_future"],
      [`/api/invoices?asOf=${today()}`, 200, ""],
      ["/api/invoices?q=a%20b%20c%20d%20e%20f%20g%20h%20i", 400, "bad_q"],
      ["/api/invoices?q=a%20b%20c%20d%20e%20f%20g%20h", 200, ""],
      // Well-formed base64 of tampered cursors: id as a string, SQL in the key, negative id,
      // unsafe id, extra element; and a valid one for the other direction.
      [`/api/invoices?cursor=${cur(["a", "2026-01-01", "1"])}`, 400, "bad_cursor"],
      [`/api/invoices?cursor=${cur(["a", "' OR 1=1 --", 1])}`, 400, "bad_cursor"],
      [`/api/invoices?cursor=${cur(["a", "2026-01-01", -1])}`, 400, "bad_cursor"],
      [`/api/invoices?cursor=${cur(["a", "2026-01-01", 2 ** 60])}`, 400, "bad_cursor"],
      [`/api/invoices?cursor=${cur(["a", "2026-01-01", 1, 2])}`, 400, "bad_cursor"],
      [`/api/invoices?cursor=${cur(["d", "2026-01-01", 1])}`, 400, "bad_cursor"],
      [`/api/invoices?cursor=${cur(["a", "2026-01-01", 1])}`, 200, ""],
      ["/api/invoices?cursor=a", 400, "bad_cursor"],
      ["/api/invoices?sort=due;DROP%20TABLE%20open_items", 400, "bad_sort"],
      ["/api/invoices?currency=E'R", 400, "bad_currency"],
      ["/api/invoices?asOf=2026-02-30", 400, "bad_as_of"],
      [`/api/invoices?q=${"x".repeat(101)}`, 400, "bad_q"],
      ["/api/reports/ageing", 400, "bad_kind"],
      ["/api/reports/ageing?kind=both", 400, "bad_kind"],
      ["/api/open-items/abc", 400, "bad_id"],
      ["/api/open-items/999999", 404, "not_found"],
      ["/api/relations/999999", 404, "not_found"],
    ];
    for (const [path, status, code] of bad) {
      const r = await get<{ error?: string }>(path);
      expect([path, r.status, r.body.error ?? ""]).toEqual([path, status, code]);
    }
  });

  it("answers 404 when there is no division at all", async () => {
    await db.batch([db.prepare("DELETE FROM divisions")]);
    const r = await get<{ error: string }>("/api/overview");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("no_division");
  });
});

describe("division selection and isolation", () => {
  it("defaults to the user's saved division, else the first", async () => {
    await addItems([
      { division: divA, number: "A-1" },
      { division: divB, number: "B-1" },
    ]);
    const first = await get<OpenItemListResponse>("/api/invoices");
    expect(first.body.division.id).toBe(divA);
    await db
      .prepare("INSERT INTO user_prefs (user_id, division_id, updated_at) VALUES (?1, ?2, 'x')")
      .bind(userIds["finance"], divB)
      .run();
    const saved = await get<OpenItemListResponse>("/api/invoices", "finance");
    expect(saved.body.division.id).toBe(divB);
    expect(saved.body.items.map((i) => i.invoiceNumber)).toEqual(["B-1"]);
    const explicit = await get<OpenItemListResponse>(`/api/invoices?division=${divA}`, "finance");
    expect(explicit.body.items.map((i) => i.invoiceNumber)).toEqual(["A-1"]);
  });

  it("never mixes divisions, and hides disabled-connection divisions everywhere", async () => {
    const relA = await addRelation(divA, "rel-1", "Acme BV", { email: "a@acme.test" });
    const relOff = await addRelation(divOff, "rel-1", "Hidden BV");
    await addItems([
      { division: divA, number: "A-1" },
      { division: divB, number: "B-1" },
      { division: divOff, number: "OFF-1" },
    ]);
    const a = await get<OpenItemListResponse>(`/api/invoices?division=${divA}`);
    expect(a.body.items.map((i) => i.invoiceNumber)).toEqual(["A-1"]);
    expect(a.body.total).toBe(1);
    // A relation id of another division is refused, so a shared link cannot pose as an empty
    // list (review K3a); the same relation in its own division works.
    for (const path of ["/api/invoices", "/api/bills"]) {
      const cross = await get<{ error: string }>(`${path}?division=${divB}&relationId=${relA}`);
      expect(cross.status).toBe(404);
      expect(cross.body).toEqual({ error: "unknown_relation" });
    }
    expect((await get(`/api/invoices?relationId=99999`)).status).toBe(404);
    const own = await get<OpenItemListResponse>(
      `/api/invoices?division=${divA}&relationId=${relA}`,
    );
    expect(own.status).toBe(200);
    expect(own.body.items.map((i) => i.invoiceNumber)).toEqual(["A-1"]);
    const ids = (
      await db
        .prepare("SELECT id, division_id FROM open_items")
        .all<{ id: number; division_id: number }>()
    ).results;
    const offId = ids.find((r) => r.division_id === divOff)?.id;
    expect((await get(`/api/open-items/${offId}`)).status).toBe(404);
    expect((await get(`/api/relations/${relOff}`)).status).toBe(404);
    const bId = ids.find((r) => r.division_id === divB)?.id;
    expect((await get(`/api/open-items/${bId}`)).status).toBe(200);
    // Overview of A does not include B's or the hidden division's items.
    const o = await get<OverviewResponse>(`/api/overview?division=${divA}`);
    expect(o.body.kpis.receivable[0]?.total.count).toBe(1);
  });
});

describe("possibly paid (review S8)", () => {
  it("flags open rows the last full read missed, in rows, totals and the detail, not closed rows", async () => {
    await addItems([
      { number: "seen", missed: 0, open: 100 },
      { number: "missed", missed: 2, open: 200 },
      { number: "closed-missed", missed: 1, status: "closed" },
    ]);
    const all = await get<OpenItemListResponse>("/api/invoices?status=all");
    const by = Object.fromEntries(all.body.items.map((i) => [i.invoiceNumber, i.possiblyPaid]));
    expect(by).toEqual({ seen: false, missed: true, "closed-missed": false });
    expect(all.body.totalsByCurrency[0]?.possiblyPaid).toBe(1);
    const open = await get<OpenItemListResponse>("/api/invoices");
    expect(open.body.totalsByCurrency[0]).toMatchObject({ count: 2, possiblyPaid: 1 });
    const id = all.body.items.find((i) => i.invoiceNumber === "missed")?.id;
    const d = await get<{ item: { possiblyPaid: boolean } }>(`/api/open-items/${id}`);
    expect(d.body.item.possiblyPaid).toBe(true);
  });
});

describe("lists", () => {
  it("separates invoices from bills and open from closed", async () => {
    await addItems([
      { number: "I-open" },
      { number: "I-closed", status: "closed" },
      { number: "B-open", kind: "bill" },
    ]);
    const inv = await get<OpenItemListResponse>("/api/invoices");
    expect(inv.body.items.map((i) => i.invoiceNumber)).toEqual(["I-open"]);
    const all = await get<OpenItemListResponse>("/api/invoices?status=all");
    expect(all.body.items.map((i) => i.invoiceNumber).sort()).toEqual(["I-closed", "I-open"]);
    const closed = await get<OpenItemListResponse>("/api/invoices?status=closed");
    expect(closed.body.items).toHaveLength(1);
    expect(closed.body.items[0]).toMatchObject({
      status: "closed",
      bucket: null,
      daysOverdue: null,
      openMinor: 0,
    });
    const bills = await get<OpenItemListResponse>("/api/bills");
    expect(bills.body.items.map((i) => i.invoiceNumber)).toEqual(["B-open"]);
  });

  it("returns the documented row shape and never IBANs or emails", async () => {
    const rel = await addRelation(divA, "rel-1", "Acme BV", {
      email: "secret@acme.test",
      iban: "NL91ABNA0417164300",
    });
    await addItems([
      {
        number: "2026001",
        iban: "NL91ABNA0417164300",
        original: 5000,
        open: 1200,
        dc: 1200,
        dcCurrency: "EUR",
        due: addDays(today(), -3),
        ref: "ref",
        source: "list",
      },
    ]);
    const res = await authed("/api/invoices", tokens["admin"] as string);
    const text = await res.text();
    expect(text).not.toContain("NL91");
    expect(text).not.toContain("secret@");
    expect(text).not.toContain("relation_iban");
    const row = (JSON.parse(text) as OpenItemListResponse).items[0];
    expect(row).toMatchObject({
      invoiceNumber: "2026001",
      relation: { id: rel, name: "Acme BV" },
      currency: "EUR",
      originalMinor: 5000,
      openMinor: 1200,
      dcMinor: 1200,
      dcCurrency: "EUR",
      bucket: "d1_30",
      daysOverdue: 3,
      source: "list",
      status: "open",
    });
    expect(row?.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports an unknown invoice total as null, not as the open balance", async () => {
    await addItems([{ open: 700, original: null }]);
    const r = await get<OpenItemListResponse>("/api/invoices");
    expect(r.body.items[0]).toMatchObject({ originalMinor: null, openMinor: 700 });
    // stored_minor holds the open balance here (review N4); the detail says so.
    const d = await get<OpenItemDetail>(`/api/open-items/${r.body.items[0]?.id}`);
    expect(d.body.storedMinor).toBe(700);
    expect(d.body.item.originalMinor).toBeNull();
  });

  it("filters: q (case and diacritics), relation, currency, dates, overdue, no due date", async () => {
    const t = today();
    const rel2 = await addRelation(divA, "rel-2", "Müller & Zonen");
    await addItems([
      { number: "INV-100", name: "Café Élan", relation: "rel-9", due: addDays(t, -10) },
      {
        number: "INV-200",
        name: "Müller & Zonen",
        relation: "rel-2",
        currency: "USD",
        due: addDays(t, 5),
      },
      { number: "INV-300", name: "Müller & Zonen", relation: "rel-2", due: null },
      { number: "INV-400", name: "Zed", relation: "rel-3", ref: "Order 77", due: t },
    ]);
    const nums = async (qs: string): Promise<string[]> =>
      (await get<OpenItemListResponse>(`/api/invoices?${qs}`)).body.items.map(
        (i) => i.invoiceNumber ?? "",
      );
    expect(await nums("q=cafe%20elan")).toEqual(["INV-100"]);
    expect(await nums("q=MULLER")).toEqual(["INV-200", "INV-300"]);
    expect(await nums("q=inv-200")).toEqual(["INV-200"]);
    expect(await nums("q=order%2077")).toEqual(["INV-400"]);
    expect(await nums("q=zzz")).toEqual([]);
    expect(await nums(`relationId=${rel2}`)).toEqual(["INV-200", "INV-300"]);
    expect(await nums(`relationId=${rel2}&currency=usd`)).toEqual(["INV-200"]);
    expect(await nums("overdue=1")).toEqual(["INV-100"]);
    expect(await nums(`dueBefore=${t}`)).toEqual(["INV-100"]);
    expect(await nums(`dueAfter=${t}`)).toEqual(["INV-200"]);
    expect(await nums(`dueAfter=${addDays(t, -11)}&dueBefore=${addDays(t, 6)}`)).toEqual([
      "INV-100",
      "INV-400",
      "INV-200",
    ]);
    expect(await nums("noDueDate=1")).toEqual(["INV-300"]);
    // Ordering: due date ascending, unknown due date last; descending reverses it.
    expect(await nums("")).toEqual(["INV-100", "INV-400", "INV-200", "INV-300"]);
    expect(await nums("sort=-due")).toEqual(["INV-300", "INV-200", "INV-400", "INV-100"]);
    // Combined with a search, totals follow the search.
    const both = await get<OpenItemListResponse>(`/api/invoices?q=muller&currency=EUR`);
    expect(both.body.total).toBe(1);
    expect(both.body.totalsByCurrency).toHaveLength(1);
  });

  it("assigns the ageing buckets at the boundaries", async () => {
    const t = today();
    const days = [-1, 0, 1, 30, 31, 60, 61, 90, 91];
    await addItems(days.map((d) => ({ number: `D${d}`, due: addDays(t, -d) })));
    await addItems([{ number: "NODUE", due: null }]);
    const r = await get<OpenItemListResponse>("/api/invoices?limit=100");
    const by = Object.fromEntries(
      r.body.items.map((i) => [i.invoiceNumber, [i.bucket, i.daysOverdue]]),
    );
    expect(by).toEqual({
      "D-1": ["not_due", -1],
      D0: ["not_due", 0],
      D1: ["d1_30", 1],
      D30: ["d1_30", 30],
      D31: ["d31_60", 31],
      D60: ["d31_60", 60],
      D61: ["d61_90", 61],
      D90: ["d61_90", 90],
      D91: ["d90_plus", 91],
      NODUE: ["no_due_date", null],
    });
  });

  it("sums per currency exactly and flags missing division-currency amounts", async () => {
    await addItems([
      ...Array.from({ length: 300 }, () => ({ open: 10, currency: "EUR" })),
      { open: 5, currency: "USD", dc: 4, dcCurrency: "EUR" },
      { open: 6, currency: "USD", dc: null },
      { open: -2500, currency: "GBP" },
      { open: 123, currency: "JPY" },
    ]);
    const r = await get<OpenItemListResponse>("/api/invoices?limit=5");
    expect(r.body.total).toBe(304);
    expect(r.body.totalsByCurrency).toEqual([
      {
        currency: "EUR",
        count: 300,
        openMinor: 3000,
        dcMinor: 3000,
        dcMissing: 0,
        dcComplete: true,
        possiblyPaid: 300,
      },
      {
        currency: "GBP",
        count: 1,
        openMinor: -2500,
        dcMinor: 0,
        dcMissing: 1,
        dcComplete: false,
        possiblyPaid: 1,
      },
      {
        currency: "JPY",
        count: 1,
        openMinor: 123,
        dcMinor: 0,
        dcMissing: 1,
        dcComplete: false,
        possiblyPaid: 1,
      },
      {
        currency: "USD",
        count: 2,
        openMinor: 11,
        dcMinor: 4,
        dcMissing: 1,
        dcComplete: false,
        possiblyPaid: 2,
      },
    ]);
  });

  it("does not infer division-currency amounts while the division currency is unverified", async () => {
    const unverified = await addDivision(await seedConnectionFor(), "Delta BV", { read: false });
    await addItems([{ division: unverified, open: 100 }]);
    const r = await get<OpenItemListResponse>(`/api/invoices?division=${unverified}`);
    expect(r.body.division.currencyVerified).toBe(false);
    expect(r.body.items[0]?.dcMinor).toBeNull();
    expect(r.body.totalsByCurrency[0]).toMatchObject({ dcMinor: 0, dcComplete: false });
  });

  it("keeps SQL totals and per-row amounts in agreement", async () => {
    await addItems([
      { open: 100, currency: "EUR" },
      { open: 50, currency: "USD", dc: 45, dcCurrency: "EUR" },
      { open: 70, currency: "USD", dc: 60, dcCurrency: "GBP" },
      { open: 80, currency: "EUR", dc: 79, dcCurrency: "EUR" },
    ]);
    const all = await get<OpenItemListResponse>("/api/invoices?limit=100");
    const rows = all.body.items;
    const viaQ = await get<OpenItemListResponse>("/api/invoices?q=2026&limit=100");
    expect(viaQ.body.totalsByCurrency).toEqual(all.body.totalsByCurrency);
    for (const t of all.body.totalsByCurrency) {
      const mine = rows.filter((r) => r.currency === t.currency);
      expect(t.dcMinor).toBe(mine.reduce((n, r) => n + (r.dcMinor ?? 0), 0));
      expect(t.dcMissing).toBe(mine.filter((r) => r.dcMinor === null).length);
    }
  });

  async function seedConnectionFor(): Promise<number> {
    const r = await db
      .prepare("INSERT INTO connections (kind, name, status) VALUES ('exact', ?1, 'active')")
      .bind(`exact-${Math.random()}`)
      .run();
    return r.meta.last_row_id;
  }
});

describe("text search", () => {
  it("treats LIKE wildcards and backslashes as text", async () => {
    await addItems([
      { number: "A-1", ref: "Discount 100% now" },
      { number: "A-2", ref: "a_b c\\d" },
      { number: "A-3", ref: "plain" },
    ]);
    const nums = async (q: string): Promise<string[]> =>
      (await get<OpenItemListResponse>(`/api/invoices?q=${encodeURIComponent(q)}`)).body.items.map(
        (i) => i.invoiceNumber ?? "",
      );
    expect(await nums("%")).toEqual(["A-1"]);
    expect(await nums("100%")).toEqual(["A-1"]);
    expect(await nums("_")).toEqual(["A-2"]);
    expect(await nums("a_b")).toEqual(["A-2"]);
    expect(await nums("c\\d")).toEqual(["A-2"]);
    expect(await nums("\\")).toEqual(["A-2"]);
    expect(await nums("'; DROP TABLE open_items; --")).toEqual([]);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM open_items").first<{ n: number }>())?.n,
    ).toBe(3);
  });

  it("fills missing search text per division, in chunks, and asks to retry when there is too much", async () => {
    await addItems([
      ...Array.from({ length: 5 }, (_, i) => ({ division: divA, number: `A-${i}` })),
      { division: divB, number: "B-1" },
    ]);
    const pending = async (division: number): Promise<number> =>
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM open_items WHERE division_id = ?1 AND search_text IS NULL",
          )
          .bind(division)
          .first<{ n: number }>()
      )?.n ?? 0;
    const err = await fillSearchText(db, divA, 2, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequest);
    expect((err as BadRequest).status).toBe(503);
    expect(await pending(divA)).toBe(1);
    await fillSearchText(db, divA, 2, 2);
    expect(await pending(divA)).toBe(0);
    // Exactly used up: no false "still building".
    await addItems([
      { division: divA },
      { division: divA },
      { division: divA },
      { division: divA },
    ]);
    await fillSearchText(db, divA, 2, 2);
    expect(await pending(divA)).toBe(0);
    expect(await pending(divB)).toBe(1);
    // The text written equals what the sync writes; a row that has text is never overwritten.
    await db
      .prepare("UPDATE open_items SET search_text = 'kept' WHERE invoice_number = 'A-0'")
      .run();
    await db.prepare("UPDATE open_items SET search_text = NULL WHERE invoice_number = 'A-1'").run();
    await fillSearchText(db, divA);
    const t = await db
      .prepare(
        "SELECT invoice_number, search_text FROM open_items WHERE invoice_number IN ('A-0', 'A-1') ORDER BY 1",
      )
      .all<{ search_text: string }>();
    expect(t.results.map((r) => r.search_text)).toEqual(["kept", "a-1\n2\nacme bv"]);
  });
});

describe("as-of date and freshness helpers", () => {
  it("uses the Amsterdam calendar day, also around midnight UTC and on DST days", () => {
    const cases: [string, string][] = [
      ["2026-03-28T23:30:00Z", "2026-03-29"], // 00:30 CET, the spring-forward day
      ["2026-03-29T21:59:59Z", "2026-03-29"], // 23:59:59 CEST
      ["2026-03-29T22:00:00Z", "2026-03-30"],
      ["2026-10-24T22:30:00Z", "2026-10-25"], // 00:30 CEST, the fall-back day
      ["2026-10-25T22:59:59Z", "2026-10-25"], // 23:59:59 CET
      ["2026-12-31T23:00:00Z", "2027-01-01"],
      ["2026-12-31T22:59:59Z", "2026-12-31"],
    ];
    for (const [utc, local] of cases) {
      const ms = Date.parse(utc);
      expect([utc, resolveAsOf(null, ms)]).toEqual([utc, local]);
      expect(resolveAsOf(local, ms)).toBe(local);
      // The UTC date is refused when it is not the Amsterdam date.
      if (utc.slice(0, 10) !== local) {
        expect(() => resolveAsOf(utc.slice(0, 10), ms)).toThrow("as_of_in_past");
      }
    }
    expect(() => resolveAsOf("2026-13-01", Date.now())).toThrow("bad_as_of");
    expect(() => resolveAsOf("2026-01-01T00:00:00Z", Date.now())).toThrow("bad_as_of");
  });

  it("takes the oldest complete read, ignores the run row, and treats bad dates as missing", () => {
    const now = Date.parse("2026-06-30T12:00:00Z");
    const row = (entity: string, at: string | null) => ({
      entity,
      last_status: "ok",
      last_completed_at: at,
      last_finished_at: at,
      last_error: null,
    });
    const rows = [
      row("run", "2026-06-30T11:00:00Z"),
      row("receivables", "2026-06-29T00:00:00Z"),
      row("payables", "2026-06-28T23:59:59Z"),
    ];
    expect(freshnessOf(rows, ["receivables", "payables"], now)).toEqual({
      lastCompletedAt: "2026-06-28T23:59:59Z",
      basis: ["receivables", "payables"],
      stale: true,
      staleAfterHours: 36,
    });
    expect(freshnessOf(rows, ["receivables"], now).stale).toBe(false);
    // Exactly 36 hours is still fresh; a millisecond more is stale.
    expect(freshnessOf([row("payables", "2026-06-29T00:00:00Z")], ["payables"], now).stale).toBe(
      false,
    );
    expect(
      freshnessOf([row("payables", "2026-06-28T23:59:59.999Z")], ["payables"], now).stale,
    ).toBe(true);
    expect(freshnessOf([row("payables", "garbage")], ["payables"], now)).toMatchObject({
      lastCompletedAt: null,
      stale: true,
    });
    expect(freshnessOf([row("run", "2026-06-30T11:00:00Z")], ["payables"], now).stale).toBe(true);
  });
});

describe("pagination", () => {
  async function walk(qs: string): Promise<{ ids: number[]; pages: number }> {
    const ids: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/invoices?${qs}&limit=7${cursor ? `&cursor=${cursor}` : ""}`;
      const r: { body: OpenItemListResponse } = await get<OpenItemListResponse>(url);
      ids.push(...r.body.items.map((i) => i.id));
      cursor = r.body.nextCursor;
      pages++;
      if (pages === 2) {
        // Rows inserted while paging: one sorting before the cursor, one after, one with a null due date.
        await addItems([
          { number: "NEW-EARLY", due: "2000-01-01" },
          { number: "NEW-LATE", due: "2999-01-01" },
          { number: "NEW-NULL", due: null },
        ]);
      }
    } while (cursor && pages < 50);
    return { ids, pages };
  }

  for (const sort of ["due", "-due"]) {
    for (const q of ["", "&q=INV"]) {
      it(`is stable under inserts (sort ${sort}${q})`, async () => {
        const t = today();
        const specs = Array.from({ length: 30 }, (_, i) => ({
          number: `INV-${i}`,
          due: i % 9 === 0 ? null : addDays(t, (i % 6) - 3),
        }));
        await addItems(specs);
        const before = (
          await db.prepare("SELECT id FROM open_items ORDER BY id").all<{ id: number }>()
        ).results.map((r) => r.id);
        const { ids, pages } = await walk(`sort=${sort}${q}`);
        expect(pages).toBeGreaterThan(3);
        expect(new Set(ids).size).toBe(ids.length); // no duplicates
        for (const id of before) expect(ids).toContain(id); // nothing skipped
        // Rows the page walk returned are in key order.
        const rows = (
          await db
            .prepare("SELECT id, COALESCE(due_date, '9999-12-31') AS k FROM open_items")
            .all<{ id: number; k: string }>()
        ).results;
        const key = new Map(rows.map((r) => [r.id, r.k] as const));
        for (let i = 1; i < ids.length; i++) {
          const a = key.get(ids[i - 1] as number) as string;
          const b = key.get(ids[i] as number) as string;
          const ok =
            sort === "due"
              ? a < b || (a === b && (ids[i - 1] as number) < (ids[i] as number))
              : a > b || (a === b && (ids[i - 1] as number) > (ids[i] as number));
          expect(ok).toBe(true);
        }
      });
    }
  }

  it("rejects a cursor from the other sort direction", async () => {
    await addItems(Array.from({ length: 5 }, () => ({})));
    const page = await get<OpenItemListResponse>("/api/invoices?limit=2");
    expect(page.body.nextCursor).not.toBeNull();
    const r = await get<{ error: string }>(
      `/api/invoices?limit=2&sort=-due&cursor=${page.body.nextCursor}`,
    );
    expect(r.status).toBe(400);
  });

  it("ends with a null cursor on the last page and an exact total", async () => {
    await addItems(Array.from({ length: 4 }, () => ({})));
    const r = await get<OpenItemListResponse>("/api/invoices?limit=4");
    expect(r.body.nextCursor).toBeNull();
    expect(r.body.total).toBe(4);
    const r3 = await get<OpenItemListResponse>("/api/invoices?limit=3");
    expect(r3.body.nextCursor).not.toBeNull();
    expect(r3.body.total).toBe(4);
  });
});

describe("ageing report", () => {
  it("aggregates per relation, bucket and currency, and drill-downs reproduce every cell", async () => {
    const t = today();
    const acme = await addRelation(divA, "rel-1", "Acme BV");
    const zed = await addRelation(divA, "rel-2", "Zed BV");
    const specs = [
      ...[-3, 0, 1, 30, 31, 60, 61, 90, 91].map((d, i) => ({
        relation: "rel-1",
        name: "Acme BV",
        open: 100 + i,
        due: addDays(t, -d),
        dc: 100 + i,
        dcCurrency: "EUR",
      })),
      { relation: "rel-2", name: "Zed BV", open: 5000, due: addDays(t, -45) },
      { relation: "rel-2", name: "Zed BV", open: 7, due: null },
      { relation: "rel-2", name: "Zed BV", open: 900, currency: "USD", due: addDays(t, -2) },
      {
        relation: "rel-2",
        name: "Zed BV",
        open: 40,
        due: addDays(t, -2),
        status: "closed" as const,
      },
      { relation: "rel-2", name: "Zed BV", kind: "bill" as const, open: 77, due: addDays(t, -2) },
    ];
    await addItems(specs);
    const r = await get<AgeingReportResponse>("/api/reports/ageing?kind=receivable");
    expect(r.status).toBe(200);
    expect(r.body.asOf).toBe(t);
    expect(r.body.currencies.map((c) => c.currency)).toEqual(["EUR", "USD"]);
    const eur = r.body.currencies[0]!;
    // Largest outstanding first: Zed (5007) before Acme.
    expect(eur.rows.map((x) => x.relation.name)).toEqual(["Zed BV", "Acme BV"]);
    expect(eur.rows[0]!.buckets).toMatchObject({ d31_60: 5000, no_due_date: 7 });
    // EUR items in a verified EUR division need no conversion: their DC amount is the open balance.
    expect(eur.rows[0]!.dcComplete).toBe(true);
    expect(r.body.currencies[1]!.totals).toMatchObject({
      currency: "USD",
      dcComplete: false,
      dcMinor: 0,
    });
    expect(eur.totals.totalMinor).toBe(5007 + 100 + 101 + 102 + 103 + 104 + 105 + 106 + 107 + 108);
    expect(r.body.totalsByCurrency.map((x) => x.currency)).toEqual(["EUR", "USD"]);
    expect(r.body.freshness.stale).toBe(true);

    // Every cell's drill-down returns exactly that cell's count and amount.
    const forRelation = (id: number) =>
      Object.fromEntries(
        Object.entries(eur.totals.drilldown).map(([b, h]) => [b, drilldownForRelation(h, id)]),
      ) as typeof eur.totals.drilldown;
    const cells = [
      ...eur.rows.map((row) => ({
        buckets: row.buckets,
        counts: row.bucketCounts,
        dd: forRelation(row.relation.id!),
        total: row.totalMinor,
      })),
      {
        buckets: eur.totals.buckets,
        counts: eur.totals.bucketCounts,
        dd: eur.totals.drilldown,
        total: eur.totals.totalMinor,
      },
    ];
    let checked = 0;
    for (const cell of cells) {
      for (const b of [...Object.keys(cell.buckets), "total"] as (
        keyof typeof cell.buckets | "total"
      )[]) {
        const hint = cell.dd[b];
        const qs = new URLSearchParams({ ...hint.query, limit: "100" });
        const list = await get<OpenItemListResponse>(`${hint.path}?${qs}`);
        const wantCount =
          b === "total" ? Object.values(cell.counts).reduce((x, y) => x + y, 0) : cell.counts[b];
        const wantMinor = b === "total" ? cell.total : cell.buckets[b];
        expect([b, list.body.total]).toEqual([b, wantCount]);
        expect([b, list.body.totalsByCurrency[0]?.openMinor ?? 0]).toEqual([b, wantMinor]);
        checked++;
      }
    }
    expect(checked).toBe(21);
    expect(eur.rows[1]!.relation.id).toBe(acme);
    expect(eur.rows[0]!.relation.id).toBe(zed);

    const pay = await get<AgeingReportResponse>("/api/reports/ageing?kind=payable");
    expect(pay.body.totalsByCurrency).toHaveLength(1);
    expect(pay.body.totalsByCurrency[0]).toMatchObject({ currency: "EUR", totalMinor: 77 });
    expect(pay.body.totalsByCurrency[0]?.drilldown["total"].path).toBe("/api/bills");

    const usdOnly = await get<AgeingReportResponse>(
      "/api/reports/ageing?kind=receivable&currency=usd",
    );
    expect(usdOnly.body.currencies.map((c) => c.currency)).toEqual(["USD"]);
  });

  it("accepts only today as the as-of date", async () => {
    const t = today();
    await addItems([{ due: addDays(t, -10) }]);
    const ok = await get<AgeingReportResponse>(`/api/reports/ageing?kind=receivable&asOf=${t}`);
    expect(ok.body.totalsByCurrency[0]?.buckets.d1_30).toBe(1000);
    for (const [d, code] of [
      [addDays(t, -1), "as_of_in_past"],
      [addDays(t, 1), "as_of_in_future"],
    ] as const) {
      const r = await get<{ error: string }>(`/api/reports/ageing?kind=receivable&asOf=${d}`);
      expect([r.status, r.body.error]).toEqual([400, code]);
    }
  });

  it("gives an unresolved relation a null id, and credit notes sort last as credits", async () => {
    await addRelation(divA, "rel-1", "Acme BV");
    await addItems([
      { relation: "never-synced", name: "Ghost", open: 300 },
      { relation: null, name: null, open: 200 },
      { relation: "rel-1", name: "Acme BV", open: -500, due: addDays(today(), -40) },
    ]);
    const r = await get<AgeingReportResponse>("/api/reports/ageing?kind=receivable");
    const c = r.body.currencies[0]!;
    expect(c.rows.map((x) => [x.relation.name, x.relation.id === null, x.totalMinor])).toEqual([
      ["Ghost", true, 300],
      [null, true, 200],
      ["Acme BV", false, -500],
    ]);
    expect(c.totals).toMatchObject({ totalMinor: 0, count: 3 });
    expect(c.totals.buckets.d31_60).toBe(-500);
    expect(c.totals.drilldown["total"].query["status"]).toBe("open");
    expect(c.totals.drilldown["total"].query).not.toHaveProperty("asOf");
  });
});

describe("overview", () => {
  const syncState = async (
    division: number,
    entity: string,
    completedAt: string | null,
    status = "ok",
    error: string | null = null,
  ): Promise<void> => {
    await db
      .prepare(
        `INSERT INTO sync_state (division_id, entity, last_status, last_completed_at, last_finished_at, last_error)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)`,
      )
      .bind(division, entity, status, completedAt, error)
      .run();
  };

  it("computes KPIs per currency", async () => {
    const t = today();
    await addItems([
      { open: 1000, due: addDays(t, -10), dc: 1000, dcCurrency: "EUR" },
      { open: 3000, due: addDays(t, -20) },
      { open: 500, due: addDays(t, 3) },
      { open: 250, due: addDays(t, 20), currency: "USD" },
      { open: 100, kind: "bill", due: addDays(t, -1) },
      { open: 999, status: "closed" },
    ]);
    const r = await get<OverviewResponse>("/api/overview");
    expect(r.body.asOf).toBe(t);
    const eur = r.body.kpis.receivable.find((k) => k.currency === "EUR")!;
    expect(eur.total).toMatchObject({ count: 3, minor: 4500 });
    expect(eur.overdue).toMatchObject({ count: 2, minor: 4000 });
    expect(eur.due7).toMatchObject({ count: 1, minor: 500 });
    // (10*1000 + 20*3000) / 4000 = 17.5 -> 18
    expect(eur.avgDaysOverdue).toBe(18);
    expect(r.body.kpis.receivable.find((k) => k.currency === "USD")?.due30.minor).toBe(250);
    expect(r.body.kpis.payable[0]).toMatchObject({ currency: "EUR", total: { minor: 100 } });
  });

  it("flags stale data when open items were not read completely within 36 hours", async () => {
    const now = Date.now();
    const iso = (h: number): string => new Date(now - h * 3_600_000).toISOString();
    expect((await get<OverviewResponse>("/api/overview")).body.stale).toBe(true);
    // An hourly run that completes without reading open items does not make them fresh.
    await syncState(divA, "run", iso(0.5));
    await syncState(divA, "relations", iso(0.5));
    await syncState(divA, "receivables", iso(37), "partial", "rate_limited");
    await syncState(divA, "payables", iso(2));
    const stale = await get<OverviewResponse>("/api/overview");
    expect(stale.body.stale).toBe(true);
    expect(stale.body.freshness).toMatchObject({
      lastCompletedAt: iso(37),
      basis: ["receivables", "payables"],
      staleAfterHours: 36,
    });
    expect(stale.body.lastSync.map((l) => l.entity)).toEqual([
      "payables",
      "receivables",
      "relations",
      "run",
    ]);
    expect(stale.body.lastSync[1]).toMatchObject({ status: "partial", error: "rate_limited" });
    // The ageing report looks at its own kind only.
    const pay = await get<AgeingReportResponse>("/api/reports/ageing?kind=payable");
    expect(pay.body.freshness).toMatchObject({ stale: false, lastCompletedAt: iso(2) });
    const rec = await get<AgeingReportResponse>("/api/reports/ageing?kind=receivable");
    expect(rec.body.freshness.stale).toBe(true);
    // Both read within 36 hours: fresh. One never read: stale with a null date.
    await db
      .prepare("UPDATE sync_state SET last_completed_at = ?1 WHERE entity = 'receivables'")
      .bind(iso(35))
      .run();
    const fresh = await get<OverviewResponse>("/api/overview");
    expect(fresh.body).toMatchObject({ stale: false, freshness: { lastCompletedAt: iso(35) } });
    await db.prepare("DELETE FROM sync_state WHERE entity = 'payables'").run();
    const missing = await get<OverviewResponse>("/api/overview");
    expect(missing.body).toMatchObject({ stale: true, freshness: { lastCompletedAt: null } });
    // Freshness is per division.
    expect((await get<OverviewResponse>(`/api/overview?division=${divB}`)).body.stale).toBe(true);
  });

  it("gives each list the freshness of its own kind (review K3a)", async () => {
    const now = Date.now();
    const iso = (h: number): string => new Date(now - h * 3_600_000).toISOString();
    await addItems([{ number: "A-1" }, { number: "B-1", kind: "bill" }]);
    // Never read: null and stale, even though rows exist.
    const never = await get<OpenItemListResponse>("/api/invoices");
    expect(never.body.freshness).toEqual({
      lastCompletedAt: null,
      basis: ["receivables"],
      stale: true,
      staleAfterHours: 36,
    });
    // A completed run or another entity does not make the list fresh.
    await syncState(divA, "run", iso(0.1));
    await syncState(divA, "receivables", iso(40), "partial", "rate_limited");
    await syncState(divA, "payables", iso(1));
    const inv = await get<OpenItemListResponse>("/api/invoices?status=all&q=a");
    expect(inv.body.freshness).toMatchObject({
      lastCompletedAt: iso(40),
      basis: ["receivables"],
      stale: true,
    });
    const bills = await get<OpenItemListResponse>("/api/bills");
    expect(bills.body.freshness).toMatchObject({
      lastCompletedAt: iso(1),
      basis: ["payables"],
      stale: false,
    });
    // Per division.
    const other = await get<OpenItemListResponse>(`/api/bills?division=${divB}`);
    expect(other.body.freshness).toMatchObject({ lastCompletedAt: null, stale: true });
  });

  it("gives every KPI a drill-down that returns exactly its items", async () => {
    const t = today();
    await addItems([
      ...[-40, -1, 0, 1, 7, 8, 30, 31].map((d, i) => ({ due: addDays(t, d), open: 10 + i })),
      { due: null, open: 3 },
      { due: addDays(t, -5), open: -4 },
      { due: addDays(t, -5), open: 50, currency: "USD" },
      { due: addDays(t, -5), open: 60, kind: "bill" as const },
    ]);
    const o = await get<OverviewResponse>("/api/overview");
    let checked = 0;
    for (const list of [o.body.kpis.receivable, o.body.kpis.payable]) {
      for (const k of list) {
        for (const f of ["total", "overdue", "due7", "due30", "noDueDate"] as const) {
          const hint = k.drilldown[f];
          const qs = new URLSearchParams({ ...hint.query, limit: "100" });
          const r = await get<OpenItemListResponse>(`${hint.path}?${qs}`);
          expect([k.currency, f, r.body.total]).toEqual([k.currency, f, k[f].count]);
          const minor = r.body.totalsByCurrency[0]?.openMinor ?? 0;
          expect([k.currency, f, minor]).toEqual([k.currency, f, k[f].minor]);
          checked++;
        }
      }
    }
    expect(checked).toBe(15);
  });
});

describe("detail and relation", () => {
  it("returns the stored entry with provenance, and no IBAN", async () => {
    const rel = await addRelation(divA, "rel-1", "Acme BV", {
      email: "secret@acme.test",
      vat: "NL123456789B01",
      iban: "NL91ABNA0417164300",
    });
    await addItems([
      {
        number: "2026001",
        original: 9000,
        open: 4000,
        iban: "NL91ABNA0417164300",
        due: addDays(today(), 5),
        source: "list",
      },
    ]);
    const id = (await db.prepare("SELECT id FROM open_items").first<{ id: number }>())!.id;
    const res = await authed(`/api/open-items/${id}`, tokens["viewer"] as string);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("NL91");
    expect(text).not.toContain("secret@");
    expect(text).not.toContain("NL123456789B01");
    const d = JSON.parse(text) as OpenItemDetail;
    expect(d.item).toMatchObject({ id, originalMinor: 9000, openMinor: 4000 });
    expect(d.storedMinor).toBe(9000);
    expect(d.provenance).toMatchObject({ lastSeenSyncId: 7, missedCycles: 1, source: "list" });
    expect(d.exactLink).toBeNull();
    expect(d.relation).toMatchObject({
      id: rel,
      name: "Acme BV",
      hasEmail: true,
      hasVatNumber: true,
    });
  });

  it("returns relation flags as presence booleans only", async () => {
    const full = await addRelation(divA, "r1", "Full", { email: "x@y.test", vat: "NL1" });
    const bare = await addRelation(divA, "r2", "Bare", { email: "  ", vat: null });
    const a = await get<RelationSummary>(`/api/relations/${full}`);
    expect(a.body).toMatchObject({
      name: "Full",
      hasEmail: true,
      hasVatNumber: true,
      country: "NL",
      isCustomer: true,
      isSupplier: true,
    });
    expect(JSON.stringify(a.body)).not.toContain("x@y.test");
    const b = await get<RelationSummary>(`/api/relations/${bare}`);
    expect(b.body).toMatchObject({ hasEmail: false, hasVatNumber: false });
    expect(Object.keys(a.body)).not.toContain("iban");
    expect(Object.keys(a.body)).not.toContain("email");
  });
});

describe("query plans and volume", () => {
  const filterOf = (over: Partial<Parameters<typeof buildListQuery>[0]> = {}) => ({
    divisionId: divA,
    kind: "invoice" as const,
    status: "open" as const,
    asOf: "2026-06-30",
    overdue: false,
    currency: null,
    relationId: null,
    dueBefore: null,
    dueAfter: null,
    noDueDate: false,
    search: [] as string[],
    ...over,
  });

  async function plan(q: { sql: string; binds: (string | number)[] }): Promise<string> {
    const rows = (
      await db
        .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
        .bind(...q.binds)
        .all<{ detail: string }>()
    ).results;
    return rows.map((r) => r.detail).join("\n");
  }

  it("uses the list indexes, not a table scan or a sort, for the main list query", async () => {
    for (const status of ["open", "closed", "all"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        for (const cursor of [null, { dir, key: "2026-06-30", id: 5 }]) {
          for (const search of [[], ["%acme%", "%2026%"]]) {
            const p = await plan(buildListQuery(filterOf({ status, search }), dir, cursor, 51));
            const label = `${status} ${dir} ${cursor ? "cursor" : "first"}: ${p}`;
            expect(p, label).toMatch(/USING (COVERING )?INDEX idx_open_items_list(_all)?\b/);
            expect(p, label).not.toMatch(/SCAN oi\b|SCAN open_items/);
            expect(p, label).not.toMatch(/TEMP B-TREE/);
          }
        }
      }
    }
  });

  it("uses an index for the totals, relation filter and ageing queries", async () => {
    const totals = await plan(buildTotalsQuery(filterOf(), { currency: "EUR", known: true }));
    expect(totals).toMatch(/USING (COVERING )?INDEX idx_open_items/);
    expect(totals).not.toMatch(/SCAN oi\b|SCAN open_items/);
    const rel = await plan(buildListQuery(filterOf({ relationId: 3 }), "asc", null, 51));
    expect(rel).not.toMatch(/SCAN oi\b|SCAN open_items/);
    const ageing = await plan({
      sql: `SELECT oi.currency, r.id, r.name FROM open_items oi
            LEFT JOIN relations r ON r.division_id = oi.division_id AND r.exact_id = oi.relation_id
            WHERE oi.division_id = ?1 AND oi.kind = ?2 AND oi.status = 'open'`,
      binds: [divA, "invoice"],
    });
    expect(ageing).not.toMatch(/SCAN oi\b|SCAN open_items/);
    expect(ageing).toMatch(/SEARCH r USING (COVERING )?INDEX/);
  });

  it("pages 5,000 rows with a small, row-independent number of queries", async () => {
    const t = today();
    await addItems(
      Array.from({ length: 5000 }, (_, i) => ({
        number: `V-${i}`,
        relation: `rel-${i % 50}`,
        name: `Customer ${i % 50}`,
        due: addDays(t, (i % 120) - 30),
        open: 1000 + i,
        currency: i % 7 === 0 ? "USD" : "EUR",
      })),
    );
    let calls = 0;
    const wrap = (inner: D1Database): D1Database =>
      new Proxy(inner, {
        get(target, prop) {
          if (prop === "prepare" || prop === "batch" || prop === "exec") {
            return (...args: unknown[]) => {
              calls++;
              return (target[prop as "prepare"] as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );
            };
          }
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    const countingEnv = { ...env, DB: wrap(env.DB) } as typeof env;
    const run = (path: string): Promise<Response> =>
      worker.fetch(
        new Request(`${ORIGIN}${path}`, {
          headers: { cookie: `__Host-session=${tokens["admin"]}`, "x-requested-with": "fetch" },
        }),
        countingEnv,
      );

    const started = Date.now();
    await (await run("/api/invoices?limit=1")).json(); // warm-up: one-time seeding queries
    calls = 0;
    const res = await run("/api/invoices?limit=100");
    const page = (await res.json()) as OpenItemListResponse;
    expect(page.items).toHaveLength(100);
    expect(page.total).toBe(5000);
    // Session and user lookups, divisions, preference, one batch (list + totals + the list's
    // freshness row, review K3a): a fixed number of prepares, still one round trip for the data.
    expect(calls).toBeLessThanOrEqual(9);
    const listCalls = calls;
    calls = 0;
    await (await run("/api/invoices?limit=1")).json();
    expect(calls).toBe(listCalls);

    // The first search fills the search text of the 5,000 rows written without it (as before
    // migration 0009): ceil(5000 / 2000) = 3 chunks of one SELECT and one UPDATE, then an empty SELECT
    // is not needed because the last chunk was short.
    calls = 0;
    const firstSearch = (await (
      await run("/api/invoices?limit=100&q=CUSTOMER")
    ).json()) as OpenItemListResponse;
    expect(calls).toBe(listCalls + 6);
    // Every row matches: the worst case for a search.
    expect(firstSearch.total).toBe(5000);
    const pending = await db
      .prepare("SELECT COUNT(*) AS n FROM open_items WHERE search_text IS NULL")
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);
    // Afterwards a search costs the same as a plain list plus the one (empty) pending check.
    calls = 0;
    const search = (await (
      await run("/api/invoices?limit=100&q=CUSTOMER")
    ).json()) as OpenItemListResponse;
    expect(calls).toBe(listCalls + 1);
    expect(search.total).toBe(5000);
    expect(search.totalsByCurrency).toEqual(page.totalsByCurrency);
    expect(search.items).toHaveLength(100);
    expect(search.nextCursor).not.toBeNull();

    calls = 0;
    const ageing = (await (
      await run("/api/reports/ageing?kind=receivable")
    ).json()) as AgeingReportResponse;
    expect(calls).toBeLessThanOrEqual(8);
    expect(ageing.totalsByCurrency.reduce((n, x) => n + x.count, 0)).toBe(5000);
    expect(ageing.currencies.find((c) => c.currency === "EUR")!.rows).toHaveLength(50);

    calls = 0;
    await (await run("/api/overview")).json();
    expect(calls).toBeLessThanOrEqual(8);
    expect(listCalls).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
