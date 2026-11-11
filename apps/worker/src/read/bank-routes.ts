/**
 * Read-only bank API (Phase 5, task R3a, ADR 0033). Shapes are fixed in packages/core api-types
 * (BankAccountsResponse, BankTransactionsResponse, BankTransactionDetail); the Bank screen (R3b)
 * builds against them.
 *
 *  GET /api/bank/accounts
 *  GET /api/bank/transactions?account=<id>&state=pending|completed|declined|failed|reverted|all
 *        &direction=in|out|all&from=YYYY-MM-DD&to=YYYY-MM-DD&q=&limit=&cursor=
 *  GET /api/bank/transactions/:id
 *
 * Any signed-in role may read. Responses are no-store (json()). IBANs are masked everywhere (first
 * and last 4 characters); a full IBAN is never selected for a response and is not searchable, and
 * no provider counterparty id is returned. Lists are keyset-paged on (created_at desc, id desc)
 * with an opaque cursor that is validated strictly. `from` / `to` are Amsterdam calendar days,
 * both inclusive. Freshness is the last COMPLETE read of the Revolut sync (revolut_sync_state),
 * not the last run, and is stale after 2 hours.
 */
import {
  likePatterns,
  maskIban,
  amsterdamParts,
  toCalendarDate,
  type BankAccountDto,
  type BankAccountsResponse,
  type BankTransactionDetail,
  type BankTransactionDto,
  type BankTransactionsResponse,
  type BankTxState,
  type Freshness,
  type FreshnessEntity,
} from "@camelthorn/core";
import { json, type Ctx, type Router } from "../router";
import { loadRevolutConnection } from "../revolut/store";
import { ANY_ROLE, BadRequest, guarded, positiveIntParam } from "./routes";

export const BANK_STALE_AFTER_HOURS = 2;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const STATES = ["pending", "completed", "declined", "failed", "reverted"] as const;

// ---- freshness ----------------------------------------------------------------------------------

async function bankFreshness(
  db: D1Database,
  connectionId: number | null,
  entity: "accounts" | "transactions",
  nowMs: number,
): Promise<Freshness> {
  const basis: FreshnessEntity = entity === "accounts" ? "bank_accounts" : "bank_transactions";
  const row =
    connectionId === null
      ? null
      : await db
          .prepare(
            `SELECT last_completed_at FROM revolut_sync_state
             WHERE connection_id = ?1 AND entity = ?2`,
          )
          .bind(connectionId, entity)
          .first<{ last_completed_at: string | null }>();
  const at = row?.last_completed_at ?? null;
  const lastCompletedAt = at !== null && !Number.isNaN(Date.parse(at)) ? at : null;
  const age = lastCompletedAt === null ? Infinity : nowMs - Date.parse(lastCompletedAt);
  return {
    lastCompletedAt,
    basis: [basis],
    stale: !(age <= BANK_STALE_AFTER_HOURS * 3_600_000),
    staleAfterHours: BANK_STALE_AFTER_HOURS,
  };
}

// ---- DTO mapping --------------------------------------------------------------------------------

interface TxSqlRow {
  id: number;
  external_id: string;
  leg_id: string;
  bank_account_id: number | null;
  account_name: string | null;
  type: string | null;
  state: string;
  is_final: number;
  created_at: string;
  completed_at: string | null;
  amount_minor: number;
  currency: string;
  reference: string | null;
  description: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  leg_count: number;
}

// leg_count: every stored leg of the same Revolut transaction, whatever the filter or page (a
// lookup on the unique (connection_id, external_id, leg_id) index).
const TX_SELECT = `SELECT t.id, t.external_id, t.leg_id, t.bank_account_id, a.name AS account_name,
  t.type, t.state, t.is_final, t.created_at, t.completed_at, t.amount_minor, t.currency,
  t.reference, t.description, t.counterparty_name, t.counterparty_iban,
  (SELECT COUNT(*) FROM bank_transactions l
    WHERE l.connection_id = t.connection_id AND l.external_id = t.external_id) AS leg_count
  FROM bank_transactions t LEFT JOIN bank_accounts a ON a.id = t.bank_account_id`;

/** A stored state as the API reports it ('created' is pending; anything unexpected is unknown). */
export function apiState(s: string): BankTxState {
  if (s === "created") return "pending";
  return (STATES as readonly string[]).includes(s) ? (s as BankTxState) : "unknown";
}

function toTxDto(r: TxSqlRow): BankTransactionDto {
  return {
    id: r.id,
    externalId: r.external_id,
    legId: r.leg_id,
    accountId: r.bank_account_id,
    accountName: r.account_name,
    type: r.type,
    state: apiState(r.state),
    isFinal: r.is_final === 1,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    amountMinor: r.amount_minor,
    currency: r.currency,
    reference: r.reference,
    description: r.description,
    counterpartyName: r.counterparty_name,
    counterpartyIbanMasked: r.counterparty_iban === null ? null : maskIban(r.counterparty_iban),
    legCount: r.leg_count,
  };
}

// ---- accounts -----------------------------------------------------------------------------------

interface AccountSqlRow {
  id: number;
  name: string;
  currency: string;
  balance_minor: number | null;
  balance_at: string | null;
  state: string | null;
  iban: string | null;
  is_active: number;
}

async function accountsHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const conn = await loadRevolutConnection(db);
  const freshness = await bankFreshness(db, conn?.id ?? null, "accounts", ctx.nowMs);
  if (!conn) {
    const empty: BankAccountsResponse = {
      connection: null,
      accounts: [],
      totalsByCurrency: [],
      freshness,
      available: false,
    };
    return json(empty);
  }
  const rows = (
    await db
      .prepare(
        `SELECT id, name, currency, balance_minor, balance_at, state, iban, is_active
         FROM bank_accounts WHERE connection_id = ?1
         ORDER BY is_active DESC, currency, name COLLATE NOCASE, id`,
      )
      .bind(conn.id)
      .all<AccountSqlRow>()
  ).results;
  const accounts: BankAccountDto[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    currency: r.currency,
    balanceMinor: r.balance_minor,
    balanceAt: r.balance_at,
    state: r.state,
    ibanMasked: r.iban === null ? null : maskIban(r.iban),
    isActive: r.is_active === 1,
  }));
  const totals = new Map<string, { balanceMinor: number; accounts: number }>();
  for (const a of accounts) {
    if (!a.isActive || a.balanceMinor === null) continue;
    const t = totals.get(a.currency) ?? { balanceMinor: 0, accounts: 0 };
    t.balanceMinor += a.balanceMinor;
    t.accounts += 1;
    totals.set(a.currency, t);
  }
  const body: BankAccountsResponse = {
    connection: {
      id: conn.id,
      status: conn.status,
      createsBankEntries:
        conn.bank_entries_decided_at === null ? null : conn.creates_bank_entries === 1,
      paymentsMode: conn.payments_mode,
    },
    accounts,
    totalsByCurrency: [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, t]) => ({ currency, ...t })),
    freshness,
    available: freshness.lastCompletedAt !== null,
  };
  return json(body);
}

// ---- transactions -------------------------------------------------------------------------------

interface TxCursor {
  createdAt: string;
  id: number;
}

// Ingest stores created_at as toISOString() (milliseconds, Z); rows migrated by 0013 kept their
// booked_at text, so the cursor accepts any ISO-8601 instant we may have stored.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

export function encodeTxCursor(c: TxCursor): string {
  return btoa(JSON.stringify(["d", c.createdAt, c.id]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Null for anything that is not a cursor we issued. */
export function decodeTxCursor(raw: string): TxCursor | null {
  try {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return null;
    const v: unknown = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
    if (!Array.isArray(v) || v.length !== 3 || v[0] !== "d") return null;
    const [, createdAt, id] = v as unknown[];
    if (typeof createdAt !== "string" || !ISO_RE.test(createdAt)) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** Start (UTC ISO) of an Amsterdam calendar day. */
export function amsterdamDayStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  for (const hours of [2, 1]) {
    const t = utcMidnight - hours * 3_600_000;
    const p = amsterdamParts(t);
    if (p.date === date && p.hour === 0) return new Date(t).toISOString();
  }
  return new Date(utcMidnight - 3_600_000).toISOString();
}

const nextDay = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

function dayParam(raw: string | null, name: string): string | null {
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new BadRequest(`bad_${name}`);
  try {
    return toCalendarDate(raw);
  } catch {
    throw new BadRequest(`bad_${name}`);
  }
}

interface Filter {
  where: string;
  binds: (string | number)[];
}

function buildFilter(ctx: Ctx, connectionId: number): Filter {
  const q = ctx.url.searchParams;
  const where: string[] = ["t.connection_id = ?1"];
  const binds: (string | number)[] = [connectionId];
  const add = (sql: string, ...values: (string | number)[]): void => {
    let s = sql;
    for (const v of values) {
      binds.push(v);
      s = s.replace("?", `?${binds.length}`);
    }
    where.push(s);
  };

  const account = positiveIntParam(q.get("account"), "account");
  if (account !== null) add("t.bank_account_id = ?", account);

  const state = q.get("state") ?? "all";
  if (state !== "all") {
    if (!(STATES as readonly string[]).includes(state)) throw new BadRequest("bad_state");
    if (state === "pending") where.push("t.state IN ('pending', 'created')");
    else add("t.state = ?", state);
  }
  const direction = q.get("direction") ?? "all";
  if (direction === "in") where.push("t.amount_minor > 0");
  else if (direction === "out") where.push("t.amount_minor < 0");
  else if (direction !== "all") throw new BadRequest("bad_direction");

  const from = dayParam(q.get("from"), "from");
  const to = dayParam(q.get("to"), "to");
  if (from !== null && to !== null && from > to) throw new BadRequest("bad_range");
  if (from !== null) add("t.created_at >= ?", amsterdamDayStart(from));
  if (to !== null) add("t.created_at < ?", amsterdamDayStart(nextDay(to)));

  const text = (q.get("q") ?? "").trim();
  if (text.length > 100) throw new BadRequest("bad_q");
  let patterns: string[];
  try {
    patterns = likePatterns(text);
  } catch {
    throw new BadRequest("bad_q");
  }
  for (const p of patterns) {
    // Reference, description and name only: never the IBAN (it is not returned in full).
    add(
      `lower(COALESCE(t.reference, '') || char(10) || COALESCE(t.description, '') || char(10) ||
             COALESCE(t.counterparty_name, '')) LIKE ? ESCAPE '\\'`,
      p,
    );
  }
  return { where: where.join(" AND "), binds };
}

interface TotalsSqlRow {
  currency: string;
  in_minor: number;
  out_minor: number;
  n: number;
}

async function transactionsHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const conn = await loadRevolutConnection(db);
  const freshness = await bankFreshness(db, conn?.id ?? null, "transactions", ctx.nowMs);
  const q = ctx.url.searchParams;
  const limitRaw = q.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const n = positiveIntParam(limitRaw, "limit");
    if (n === null || n > MAX_LIMIT) throw new BadRequest("bad_limit");
    limit = n;
  }
  const cursorRaw = q.get("cursor");
  const cursor = cursorRaw === null ? null : decodeTxCursor(cursorRaw);
  if (cursorRaw !== null && cursor === null) throw new BadRequest("bad_cursor");
  const accountId = positiveIntParam(q.get("account"), "account");

  if (!conn) {
    const empty: BankTransactionsResponse = {
      items: [],
      nextCursor: null,
      total: 0,
      totalsByCurrency: [],
      freshness,
      available: false,
    };
    // Still validate the query so a typo is a 400 whether or not a connection exists.
    buildFilter(ctx, 0);
    return json(empty);
  }
  if (accountId !== null) {
    const known = await db
      .prepare("SELECT 1 AS x FROM bank_accounts WHERE id = ?1 AND connection_id = ?2")
      .bind(accountId, conn.id)
      .first();
    if (!known) throw new BadRequest("unknown_account", 404);
  }
  const f = buildFilter(ctx, conn.id);

  let pageWhere = f.where;
  const pageBinds = [...f.binds];
  if (cursor) {
    pageBinds.push(cursor.createdAt, cursor.id);
    pageWhere += ` AND (t.created_at < ?${pageBinds.length - 1}
                   OR (t.created_at = ?${pageBinds.length - 1} AND t.id < ?${pageBinds.length}))`;
  }
  const rows = (
    await db
      .prepare(
        `${TX_SELECT} WHERE ${pageWhere} ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit + 1}`,
      )
      .bind(...pageBinds)
      .all<TxSqlRow>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeTxCursor({ createdAt: last.created_at, id: last.id })
      : null;

  const total =
    (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM bank_transactions t WHERE ${f.where}`)
        .bind(...f.binds)
        .first<{ n: number }>()
    )?.n ?? 0;
  // Money in and out of rows that moved (or will move) money: pending and completed. Declined,
  // failed and reverted rows are listed but not summed.
  const totals = (
    await db
      .prepare(
        `SELECT t.currency,
                COALESCE(SUM(CASE WHEN t.amount_minor > 0 THEN t.amount_minor ELSE 0 END), 0) AS in_minor,
                COALESCE(SUM(CASE WHEN t.amount_minor < 0 THEN -t.amount_minor ELSE 0 END), 0) AS out_minor,
                COUNT(*) AS n
         FROM bank_transactions t
         WHERE ${f.where} AND t.state IN ('pending', 'created', 'completed')
         GROUP BY t.currency ORDER BY t.currency`,
      )
      .bind(...f.binds)
      .all<TotalsSqlRow>()
  ).results;

  const body: BankTransactionsResponse = {
    items: page.map(toTxDto),
    nextCursor,
    total,
    totalsByCurrency: totals.map((t) => ({
      currency: t.currency,
      inMinor: t.in_minor,
      outMinor: t.out_minor,
      count: t.n,
    })),
    freshness,
    available: freshness.lastCompletedAt !== null,
  };
  return json(body);
}

async function detailHandler(ctx: Ctx): Promise<Response> {
  const id = positiveIntParam(ctx.params["id"] ?? null, "id");
  if (id === null) throw new BadRequest("bad_id");
  const db = ctx.env.DB;
  const row = await db.prepare(`${TX_SELECT} WHERE t.id = ?1`).bind(id).first<TxSqlRow>();
  if (!row) throw new BadRequest("not_found", 404);
  const meta = await db
    .prepare(
      "SELECT connection_id, first_seen_at, last_event_at, source FROM bank_transactions WHERE id = ?1",
    )
    .bind(id)
    .first<{
      connection_id: number;
      first_seen_at: string;
      last_event_at: string | null;
      source: "webhook" | "poll" | "backfill";
    }>();
  if (!meta) throw new BadRequest("not_found", 404);
  const legs = (
    await db
      .prepare(
        `${TX_SELECT} WHERE t.connection_id = ?1 AND t.external_id = ?2 ORDER BY t.leg_id, t.id`,
      )
      .bind(meta.connection_id, row.external_id)
      .all<TxSqlRow>()
  ).results;
  const body: BankTransactionDetail = {
    ...toTxDto(row),
    legs: legs.map(toTxDto),
    firstSeenAt: meta.first_seen_at,
    lastEventAt: meta.last_event_at,
    source: meta.source,
  };
  return json(body);
}

export function registerBankRoutes(router: Router): void {
  router.add("GET", "/api/bank/accounts", ANY_ROLE, guarded(accountsHandler));
  router.add("GET", "/api/bank/transactions", ANY_ROLE, guarded(transactionsHandler));
  router.add("GET", "/api/bank/transactions/:id", ANY_ROLE, guarded(detailHandler));
}
