import { env } from "cloudflare:test";
import type { ExactRequest, ExactResponse, ExactTransport } from "@camelthorn/exact";
import type { DivisionRef, JobGate } from "../src/exact/sync";

export const db = env.DB;
export const HOST = "start.exactonline.nl";

export const guid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

export interface FakeAccount {
  n: number;
  name: string;
  ts: number;
  supplier?: boolean;
  customer?: boolean;
  email?: string | null;
  country?: string;
}
export interface FakeBank {
  n: number;
  account: number;
  iban: string | null;
  main?: boolean;
}
export interface FakeItem {
  n: number;
  account: number;
  name: string;
  /** JSON number as Exact would send it (decimal major units). */
  amount: number;
  currency: string;
  invoiceNumber: number | null;
  ts: number;
  /** Sync rows only: invoice total (TransactionAmountFC), open in division currency, rate. */
  original?: number;
  amountDc?: number;
  rate?: number;
  fullyPaid?: boolean;
  /** List rows only, and only when `$select` asks for them (ADR 0038 option 1). */
  listAmountDc?: number;
  listRate?: number;
}

/** A chart account as Exact's financial/GLAccounts would send it. */
export interface FakeGlAccount {
  n: number;
  code: string;
  name: string;
  type?: number;
  typeDescription?: string;
  side?: "D" | "C";
  bt?: "B" | "W";
  blocked?: boolean;
}
/** A reporting balance row; `amount` is a JSON number in major units (debit - credit). */
export interface FakeBalance {
  account: number;
  year: number;
  period: number;
  amount: number;
  bt?: "B" | "W";
  status?: string | null;
  costcenter?: string | null;
  costunit?: string | null;
}
/**
 * A purchase entry as Exact's purchaseentry/PurchaseEntries would send it. Times are epoch ms.
 * `doc`: true = a document is attached, false = none, undefined = the row has no Document field.
 */
export interface FakePurchase {
  n: number;
  supplier?: number | null;
  name?: string | null;
  amount: number;
  currency?: string;
  amountDc?: number | null;
  status: number | null;
  entryDate: number;
  dueDate?: number | null;
  created?: number;
  modified: number;
  doc?: boolean;
  entryNumber?: number | null;
}

export interface FakeBudget {
  account: number;
  year: number;
  period: number;
  amount: number;
  scenario?: string | null;
}

const date = (ms: number): string => `/Date(${ms})/`;

/**
 * A scripted Exact. It serves the fixtures through the real client, with paging (`__next`) and the
 * Timestamp cursor filter on the sync endpoints, and records every call. `beforeCall` can throw to
 * simulate a gate error (budget, rate limit, auth) on the n-th call.
 */
export class FakeExact {
  divisions = [{ code: 1000001, description: "Camelthorn Advisory B.V." }] as {
    code: number;
    description: string | null;
    currency?: string | null;
  }[];
  accounts: FakeAccount[] = [];
  banks: FakeBank[] = [];
  receivables: FakeItem[] = [];
  payables: FakeItem[] = [];
  glAccounts: FakeGlAccount[] = [];
  glBalances: FakeBalance[] = [];
  glBudgets: FakeBudget[] = [];
  purchases: FakePurchase[] = [];
  pageSize = 2;
  /** Page sizes per endpoint family when set (Exact: about 60 on list endpoints, 1,000 on sync). */
  listPageSize: number | undefined;
  syncPageSize: number | undefined;
  calls: ExactRequest[] = [];
  beforeCall: (n: number, req: ExactRequest) => void = () => undefined;
  /** Per-path override: return a response instead of data. */
  override: Record<string, () => ExactResponse> = {};
  /** Answers 400 (Exact's refusal of a bad $select) when the list $select contains this field. */
  rejectSelect: string | undefined;

  constructor(private readonly division: number) {}

  readonly transport: ExactTransport = async (req) => {
    this.calls.push(req);
    this.beforeCall(this.calls.length, req);
    const over = this.override[req.path];
    if (over) return over();
    if (
      this.rejectSelect !== undefined &&
      req.path.startsWith("/read/financial/") &&
      (req.query?.["$select"] ?? "").split(",").includes(this.rejectSelect)
    ) {
      return {
        status: 400,
        headers: {},
        body: '{"error":{"code":"","message":{"lang":"","value":"bad $select"}}}',
      };
    }
    const rows = this.rows(req);
    const offset = Number(req.query?.["$skiptoken"] ?? 0);
    const size =
      (req.path.startsWith("/sync/") ? this.syncPageSize : this.listPageSize) ?? this.pageSize;
    const page = rows.slice(offset, offset + size);
    const more = offset + size < rows.length;
    const next = more
      ? `,"__next":"https://${HOST}/api/v1/${this.division}${req.path}?$skiptoken=${offset + size}"`
      : "";
    return {
      status: 200,
      headers: {},
      body: `{"d":{"results":[${page.map((r) => JSON.stringify(r)).join(",")}]${next}}}`,
    };
  };

  pathsCalled(): string[] {
    return this.calls.map((c) => c.path);
  }

  private yearOf(req: ExactRequest): number {
    const m = /ReportingYear eq (\d+)/.exec(req.query?.["$filter"] ?? "");
    return m ? Number(m[1]) : 0;
  }

  private cursorOf(req: ExactRequest): number {
    const m = /Timestamp gt (\d+)L/.exec(req.query?.["$filter"] ?? "");
    return m ? Number(m[1]) : 0;
  }

  private rows(req: ExactRequest): unknown[] {
    switch (req.path) {
      case "/system/Divisions":
        return this.divisions.map((d) => ({
          Code: d.code,
          Description: d.description,
          Country: "NL",
          ...(d.currency === undefined ? {} : { Currency: d.currency }),
          Status: 1,
          Main: true,
        }));
      case "/sync/CRM/Accounts": {
        const c = this.cursorOf(req);
        return this.accounts
          .filter((a) => a.ts > c)
          .sort((a, b) => a.ts - b.ts)
          .map((a) => ({
            ID: guid(a.n),
            Code: String(a.n),
            Name: a.name,
            Email: a.email ?? null,
            VATNumber: null,
            Country: a.country ?? "NL",
            IsSupplier: a.supplier ?? false,
            IsSales: a.customer ?? false,
            Status: "",
            Timestamp: a.ts,
          }));
      }
      case "/crm/BankAccounts":
        return this.banks.map((b) => ({
          ID: guid(900 + b.n),
          Account: guid(b.account),
          BankAccount: b.iban,
          BICCode: null,
          BankName: null,
          Main: b.main ?? true,
        }));
      case "/read/financial/ReceivablesList":
        return this.receivables.map((i) => this.listRow(i, req));
      case "/read/financial/PayablesList":
        return this.payables.map((i) => this.listRow(i, req));
      case "/sync/Cashflow/Receivables": {
        const c = this.cursorOf(req);
        return this.receivables
          .filter((i) => i.ts > c)
          .sort((a, b) => a.ts - b.ts)
          .map((i) => this.syncRow(i));
      }
      case "/sync/Cashflow/Payables": {
        const c = this.cursorOf(req);
        return this.payables
          .filter((i) => i.ts > c)
          .sort((a, b) => a.ts - b.ts)
          .map((i) => this.syncRow(i));
      }
      case "/financial/GLAccounts":
        return this.glAccounts.map((a) => ({
          ID: guid(7000 + a.n),
          Code: `  ${a.code}`,
          Description: a.name,
          Type: a.type ?? null,
          TypeDescription: a.typeDescription ?? null,
          BalanceSide: a.side ?? null,
          BalanceType: a.bt ?? "B",
          Blocked: a.blocked ?? false,
        }));
      case "/financial/ReportingBalance": {
        const year = this.yearOf(req);
        return this.glBalances
          .filter((b) => b.year === year)
          .map((b) => ({
            GLAccount: guid(7000 + b.account),
            GLAccountCode: String(b.account),
            ReportingYear: b.year,
            ReportingPeriod: b.period,
            Amount: b.amount,
            AmountDebit: b.amount > 0 ? b.amount : 0,
            AmountCredit: b.amount < 0 ? -b.amount : 0,
            BalanceType: b.bt ?? "B",
            Status: b.status ?? null,
            CostCenterCode: b.costcenter ?? null,
            CostUnitCode: b.costunit ?? null,
          }));
      }
      case "/budget/Budgets": {
        const year = this.yearOf(req);
        return this.glBudgets
          .filter((b) => b.year === year)
          .map((b) => ({
            GLAccount: guid(7000 + b.account),
            GLAccountCode: String(b.account),
            ReportingYear: b.year,
            ReportingPeriod: b.period,
            AmountDC: b.amount,
            BudgetScenario: b.scenario ?? null,
            Costcenter: null,
            Costunit: null,
          }));
      }
      case "/purchaseentry/PurchaseEntries":
        return this.purchaseRows(req);
      default:
        throw new Error(`FakeExact: unexpected path ${req.path}`);
    }
  }

  /** Understands the two filters of the client (purchaseEntryFilterExpr) and $orderby=Modified. */
  private purchaseRows(req: ExactRequest): unknown[] {
    const filter = req.query?.["$filter"] ?? "";
    const dt = (s: string): number => Date.parse(`${s}Z`);
    const ms = [...filter.matchAll(/datetime'([^']+)'/g)].map((m) => dt(m[1] as string));
    const from = ms[0] ?? 0;
    const codes = [...filter.matchAll(/Status eq (\d+)/g)].map((m) => Number(m[1]));
    const windowed = filter.startsWith("EntryDate ge");
    return this.purchases
      .filter((p) =>
        windowed
          ? p.entryDate >= from ||
            p.modified >= from ||
            (p.status !== null && codes.includes(p.status))
          : p.modified >= from,
      )
      .sort((a, b) => a.modified - b.modified || a.n - b.n)
      .map((p) => ({
        EntryID: guid(8000 + p.n),
        EntryNumber: p.entryNumber === undefined ? 70000 + p.n : p.entryNumber,
        Supplier: p.supplier === null ? null : guid(p.supplier ?? 1),
        SupplierName: p.name === undefined ? `Supplier ${p.supplier ?? 1}` : p.name,
        Currency: p.currency ?? "EUR",
        AmountFC: p.amount,
        AmountDC: p.amountDc ?? null,
        EntryDate: date(p.entryDate),
        DueDate: p.dueDate === undefined || p.dueDate === null ? null : date(p.dueDate),
        Status: p.status,
        Created: date(p.created ?? p.entryDate),
        Modified: date(p.modified),
        ...(p.doc === undefined ? {} : { Document: p.doc ? guid(9000 + p.n) : null }),
      }));
  }

  private listRow(i: FakeItem, req: ExactRequest): unknown {
    const wanted = (req.query?.["$select"] ?? "").split(",");
    return {
      ...(wanted.includes("AmountDC") && i.listAmountDc !== undefined
        ? { AmountDC: i.listAmountDc }
        : {}),
      ...(wanted.includes("RateFC") && i.listRate !== undefined ? { RateFC: i.listRate } : {}),
      ID: guid(i.n),
      AccountId: guid(i.account),
      AccountCode: String(i.account),
      AccountName: i.name,
      Amount: i.amount,
      CurrencyCode: i.currency,
      Description: `Invoice ${i.invoiceNumber ?? ""}`,
      DueDate: date(1_700_000_000_000),
      EntryNumber: 1000 + i.n,
      InvoiceDate: date(1_697_500_800_000),
      InvoiceNumber: i.invoiceNumber,
    };
  }

  private syncRow(i: FakeItem): unknown {
    return {
      ID: guid(i.n),
      Account: guid(i.account),
      AccountCode: String(i.account),
      AccountName: i.name,
      AmountFC: i.amount,
      AmountDC: i.amountDc ?? null,
      TransactionAmountFC: i.original ?? null,
      RateFC: i.rate ?? null,
      IsFullyPaid: i.fullyPaid ?? false,
      Currency: i.currency,
      Description: `Invoice ${i.invoiceNumber ?? ""}`,
      DueDate: date(1_700_000_000_000),
      EntryNumber: 1000 + i.n,
      InvoiceDate: date(1_697_500_800_000),
      InvoiceNumber: i.invoiceNumber,
      Timestamp: i.ts,
    };
  }
}

export interface FakeGate extends JobGate {
  started: { jobId: string; budget: number | undefined }[];
  ended: string[];
}

export function fakeGate(over: Partial<JobGate> = {}): FakeGate {
  const g: FakeGate = {
    started: [],
    ended: [],
    startJob: async (jobId, budget) => {
      g.started.push({ jobId, budget });
    },
    endJob: async (jobId) => {
      g.ended.push(jobId);
      return { used: 7 };
    },
    ...over,
  };
  return g;
}

let nextExact = 5_000_000;

/** Wipes sync-related rows (audit_log is append-only and left alone). */
export async function resetSync(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM user_prefs"),
    db.prepare("DELETE FROM sync_locks"),
    db.prepare("DELETE FROM sync_state"),
    db.prepare("DELETE FROM purchase_entries"),
    db.prepare("DELETE FROM gl_balances"),
    db.prepare("DELETE FROM gl_budgets"),
    db.prepare("DELETE FROM gl_accounts"),
    db.prepare("DELETE FROM gl_sync_years"),
    db.prepare("DELETE FROM match_allocations"),
    db.prepare("DELETE FROM matches"),
    db.prepare("DELETE FROM bank_account_exact_map"),
    db.prepare("DELETE FROM open_items"),
    db.prepare("DELETE FROM relation_bank_accounts"),
    db.prepare("DELETE FROM relations"),
    db.prepare("DELETE FROM exact_usage"),
    db.prepare("DELETE FROM divisions"),
    db.prepare("DELETE FROM connections"),
    db.prepare("DELETE FROM job_runs"),
    db.prepare("DELETE FROM jobs"),
    db.prepare("DELETE FROM settings WHERE key = 'seed.default_jobs'"),
    // Most sync tests exercise incremental open-item reads, which are OFF by default in
    // production (ADR 0017); the default has its own tests, which delete this row.
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_by) VALUES ('exact.incremental_open_items', 'true', 'test')
       ON CONFLICT (key) DO UPDATE SET value_json = 'true'`,
    ),
  ]);
}

export async function addDivision(
  opts: { status?: string; name?: string; exact?: number } = {},
): Promise<DivisionRef & { name: string }> {
  const exact = opts.exact ?? ++nextExact;
  const c = await db
    .prepare("INSERT INTO connections (kind, name, status) VALUES ('exact', ?1, ?2)")
    .bind(`exact-${exact}`, opts.status ?? "active")
    .run();
  const name = opts.name ?? `Division ${exact}`;
  const d = await db
    .prepare(
      "INSERT INTO divisions (connection_id, exact_division, name, sync_enabled) VALUES (?1, ?2, ?3, 1)",
    )
    .bind(c.meta.last_row_id, exact, name)
    .run();
  return { id: d.meta.last_row_id, connectionId: c.meta.last_row_id, exactDivision: exact, name };
}

export interface AuditRow {
  actor_email: string;
  entity_id: string | null;
  before_json: string | null;
  after_json: string | null;
}

export async function auditRows(action: string, entityId?: string | number): Promise<AuditRow[]> {
  return (
    await db
      .prepare(
        `SELECT actor_email, entity_id, before_json, after_json FROM audit_log
         WHERE action = ?1 AND (?2 IS NULL OR entity_id = ?2) ORDER BY id`,
      )
      .bind(action, entityId === undefined ? null : String(entityId))
      .all<AuditRow>()
  ).results;
}
