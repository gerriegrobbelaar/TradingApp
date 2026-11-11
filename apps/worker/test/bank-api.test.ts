/**
 * The read-only bank API (task R3a): GET /api/bank/accounts, /api/bank/transactions, /:id.
 * Shapes are pinned to packages/core api-types, IBANs are masked, pagination is keyset.
 */
import { env } from "cloudflare:test";
import { mapTransaction, parseJsonRawNumbers } from "@camelthorn/revolut";
import {
  type BankAccountDto,
  type BankAccountsResponse,
  type BankTransactionDetail,
  type BankTransactionDto,
  type BankTransactionsResponse,
  type Freshness,
} from "@camelthorn/core";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeTxCursor, encodeTxCursor, amsterdamDayStart } from "../src/read/bank-routes";
import { upsertTransaction } from "../src/revolut/ingest";
import { addSession, addUser, authed, call, db, resetDb } from "./helpers";
import { resetRevolut, seedRevolut } from "./revolut-helpers";
import {
  ACC_EUR,
  ACC_USD,
  CP_IBAN,
  OUR_IBAN,
  simpleTx,
  txJson,
  type FakeTransaction,
} from "./revolut-r3-helpers";

const keysOf =
  <T>() =>
  <const K extends readonly (keyof T)[]>(
    k: K & ([keyof T] extends [K[number]] ? unknown : "missing keys"),
  ): string[] =>
    [...k].map(String).sort();

const ACCOUNT = keysOf<BankAccountDto>()([
  "id",
  "name",
  "currency",
  "balanceMinor",
  "balanceAt",
  "state",
  "ibanMasked",
  "isActive",
]);
const TX = keysOf<BankTransactionDto>()([
  "id",
  "externalId",
  "legId",
  "accountId",
  "accountName",
  "type",
  "state",
  "isFinal",
  "createdAt",
  "completedAt",
  "amountMinor",
  "currency",
  "reference",
  "description",
  "counterpartyName",
  "counterpartyIbanMasked",
]);
const DETAIL = keysOf<BankTransactionDetail>()([
  "id",
  "externalId",
  "legId",
  "accountId",
  "accountName",
  "type",
  "state",
  "isFinal",
  "createdAt",
  "completedAt",
  "amountMinor",
  "currency",
  "reference",
  "description",
  "counterpartyName",
  "counterpartyIbanMasked",
  "legs",
  "firstSeenAt",
  "lastEventAt",
  "source",
]);
const ACCOUNTS = keysOf<BankAccountsResponse>()([
  "connection",
  "accounts",
  "totalsByCurrency",
  "freshness",
  "available",
]);
const TXS = keysOf<BankTransactionsResponse>()([
  "items",
  "nextCursor",
  "total",
  "totalsByCurrency",
  "freshness",
  "available",
]);
const FRESH = keysOf<Freshness>()(["lastCompletedAt", "basis", "stale", "staleAfterHours"]);

let connId: number;
let tokens: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  await resetRevolut();
  connId = await seedRevolut({ status: "active" });
  tokens = {};
  for (const role of ["admin", "finance", "approver", "viewer"] as const) {
    tokens[role] = await addSession(await addUser(`${role}@camelthorncapital.com`, [role]));
  }
});

const get = async <T>(
  path: string,
  role = "viewer",
): Promise<{ status: number; body: T; res: Response }> => {
  const res = await authed(path, tokens[role] as string);
  return { status: res.status, body: (await res.json()) as T, res };
};

const ingest = (t: FakeTransaction, source: "webhook" | "poll" | "backfill" = "poll") =>
  upsertTransaction(
    { DB: db },
    connId,
    mapTransaction(parseJsonRawNumbers(JSON.stringify(txJson(t)))),
    source,
  );

async function seedAccounts(completedAt: string | null = new Date().toISOString()) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO bank_accounts (connection_id, external_id, name, iban, currency, balance_minor, balance_at, state, is_active)
         VALUES (?1, ?2, 'Main EUR', ?3, 'EUR', 123450, '2026-07-10T08:00:00.000Z', 'active', 1)`,
      )
      .bind(connId, ACC_EUR, OUR_IBAN),
    db
      .prepare(
        `INSERT INTO bank_accounts (connection_id, external_id, name, currency, balance_minor, balance_at, state, is_active)
         VALUES (?1, ?2, 'Dollars', 'USD', 1000, '2026-07-10T08:00:00.000Z', 'active', 1)`,
      )
      .bind(connId, ACC_USD),
    db
      .prepare(
        `INSERT INTO bank_accounts (connection_id, external_id, name, currency, balance_minor, state, is_active)
         VALUES (?1, 'closed-1', 'Old EUR', 'EUR', 999, 'inactive', 0)`,
      )
      .bind(connId),
    db
      .prepare(
        `INSERT INTO revolut_sync_state (connection_id, entity, last_completed_at, last_status)
         VALUES (?1, 'accounts', ?2, 'ok'), (?1, 'transactions', ?2, 'ok')`,
      )
      .bind(connId, completedAt),
  ]);
}

describe("access", () => {
  it("every signed-in role reads; anonymous is 401; responses are never cached", async () => {
    await seedAccounts();
    for (const role of ["admin", "finance", "approver", "viewer"]) {
      for (const path of ["/api/bank/accounts", "/api/bank/transactions"]) {
        const r = await get(path, role);
        expect(r.status, `${role} ${path}`).toBe(200);
        expect(r.res.headers.get("cache-control")).toBe("no-store");
      }
    }
    for (const path of [
      "/api/bank/accounts",
      "/api/bank/transactions",
      "/api/bank/transactions/1",
    ]) {
      expect((await call(path)).status).toBe(401);
    }
  });

  it("is read-only", async () => {
    const res = await authed("/api/bank/accounts", tokens["admin"] as string, {
      method: "POST",
      json: {},
    });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/bank/accounts", () => {
  it("before the first sync: connection known, nothing available", async () => {
    const { body } = await get<BankAccountsResponse>("/api/bank/accounts");
    expect(Object.keys(body).sort()).toEqual(ACCOUNTS);
    expect(body).toMatchObject({
      available: false,
      accounts: [],
      totalsByCurrency: [],
      connection: {
        id: connId,
        status: "active",
        createsBankEntries: false,
        paymentsMode: "drafts",
      },
    });
    expect(Object.keys(body.freshness).sort()).toEqual(FRESH);
    expect(body.freshness).toMatchObject({
      lastCompletedAt: null,
      basis: ["bank_accounts"],
      stale: true,
    });
  });

  it("without any connection it is empty and available false", async () => {
    await resetRevolut();
    const { body } = await get<BankAccountsResponse>("/api/bank/accounts");
    expect(body).toMatchObject({ connection: null, accounts: [], available: false });
  });

  it("lists accounts with masked IBANs and totals of active accounts per currency", async () => {
    await seedAccounts();
    const { body } = await get<BankAccountsResponse>("/api/bank/accounts");
    expect(body.available).toBe(true);
    expect(body.freshness).toMatchObject({ stale: false, basis: ["bank_accounts"] });
    for (const a of body.accounts) expect(Object.keys(a).sort()).toEqual(ACCOUNT);
    const eur = body.accounts.find((a) => a.name === "Main EUR");
    expect(eur).toMatchObject({
      balanceMinor: 123450,
      currency: "EUR",
      ibanMasked: "GB33****5678",
      isActive: true,
    });
    expect(body.accounts.find((a) => a.name === "Dollars")?.ibanMasked).toBeNull();
    expect(body.accounts.find((a) => a.name === "Old EUR")?.isActive).toBe(false);
    expect(body.totalsByCurrency).toEqual([
      { currency: "EUR", balanceMinor: 123450, accounts: 1 },
      { currency: "USD", balanceMinor: 1000, accounts: 1 },
    ]);
    expect(JSON.stringify(body)).not.toContain(OUR_IBAN);
    expect(JSON.stringify(body)).not.toContain(ACC_EUR); // no provider ids
  });

  it("is stale when the last complete read is old", async () => {
    await seedAccounts(new Date(Date.now() - 3 * 3_600_000).toISOString());
    const { body } = await get<BankAccountsResponse>("/api/bank/accounts");
    expect(body.freshness.stale).toBe(true);
    expect(body.freshness.staleAfterHours).toBe(2);
    expect(body.available).toBe(true);
  });
});

describe("GET /api/bank/transactions", () => {
  beforeEach(async () => {
    await seedAccounts();
  });

  async function seedMany() {
    await ingest(
      simpleTx("a1", {
        createdAt: "2026-07-10T08:00:00.000Z",
        reference: "INV 100",
        legs: [{ legId: "a1-l", amount: -100 }],
      }),
    );
    await ingest(
      simpleTx("a2", {
        createdAt: "2026-07-10T09:00:00.000Z",
        reference: "Salary",
        legs: [{ legId: "a2-l", amount: 2500, counterpartyName: "Employer" }],
      }),
    );
    await ingest(
      simpleTx("a3", {
        createdAt: "2026-07-10T09:00:00.000Z",
        state: "pending",
        legs: [{ legId: "a3-l", amount: -5 }],
      }),
    );
    await ingest(
      simpleTx("a4", {
        createdAt: "2026-07-11T09:00:00.000Z",
        state: "declined",
        legs: [{ legId: "a4-l", amount: -7 }],
      }),
    );
    await ingest(
      simpleTx("a5", {
        createdAt: "2026-07-12T09:00:00.000Z",
        state: "reverted",
        legs: [{ legId: "a5-l", amount: -9, accountId: ACC_USD, currency: "USD" }],
      }),
    );
    await ingest(
      simpleTx("a6", {
        createdAt: "2026-07-12T10:00:00.000Z",
        type: "exchange",
        legs: [
          { legId: "a6-out", amount: -50 },
          { legId: "a6-in", amount: 54, currency: "USD", accountId: ACC_USD },
        ],
      }),
    );
  }

  it("has the exact response shape, newest first, signed amounts and masked IBANs only", async () => {
    await seedMany();
    const { body } = await get<BankTransactionsResponse>("/api/bank/transactions");
    expect(Object.keys(body).sort()).toEqual(TXS);
    expect(Object.keys(body.freshness).sort()).toEqual(FRESH);
    expect(body.freshness.basis).toEqual(["bank_transactions"]);
    expect(body.available).toBe(true);
    expect(body.total).toBe(7);
    for (const t of body.items) expect(Object.keys(t).sort()).toEqual(TX);
    const dates = body.items.map((t) => t.createdAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    const a1 = body.items.find((t) => t.externalId === "a1");
    expect(a1).toMatchObject({
      legId: "a1-l",
      amountMinor: -10000,
      currency: "EUR",
      state: "completed",
      isFinal: true,
      accountName: "Main EUR",
      reference: "INV 100",
      counterpartyName: "Acme B.V.",
      counterpartyIbanMasked: "NL91****4300",
    });
    expect(body.items.find((t) => t.externalId === "a3")).toMatchObject({
      state: "pending",
      isFinal: false,
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(CP_IBAN);
    expect(text).not.toContain("cp-secret-id");
    expect(text).not.toMatch(/counterparty_iban|counterpartyIban"/);
  });

  it("pages with a keyset cursor: every row once, ties broken by id, stable", async () => {
    await seedMany();
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `/api/bank/transactions?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const { body } = await get<BankTransactionsResponse>(q);
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((t) => t.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(pages).toBe(4);
    // A new row arriving at the top while paging does not shift the following pages.
    const first = await get<BankTransactionsResponse>("/api/bank/transactions?limit=2");
    await ingest(simpleTx("new", { createdAt: "2026-07-20T09:00:00.000Z" }));
    const next = await get<BankTransactionsResponse>(
      `/api/bank/transactions?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(next.body.items.map((t) => t.id)).toEqual(seen.slice(2, 4));
  });

  it("filters by state, direction, account, dates (Amsterdam days) and text", async () => {
    await seedMany();
    const ids = async (q: string) =>
      (await get<BankTransactionsResponse>(`/api/bank/transactions?${q}`)).body.items
        .map((t) => t.externalId)
        .sort();
    expect(await ids("state=pending")).toEqual(["a3"]);
    expect(await ids("state=declined")).toEqual(["a4"]);
    expect(await ids("state=reverted")).toEqual(["a5"]);
    expect(await ids("state=completed")).toEqual(["a1", "a2", "a6", "a6"].sort());
    expect(await ids("direction=in")).toEqual(["a2", "a6"]);
    expect(await ids("direction=out")).toEqual(["a1", "a3", "a4", "a5", "a6"]);
    const usd = (await get<BankAccountsResponse>("/api/bank/accounts")).body.accounts.find(
      (a) => a.name === "Dollars",
    );
    expect(await ids(`account=${usd?.id}`)).toEqual(["a5", "a6"]);
    expect(await ids("from=2026-07-11&to=2026-07-11")).toEqual(["a4"]);
    expect(await ids("from=2026-07-12")).toEqual(["a5", "a6", "a6"]);
    expect(await ids("q=salary")).toEqual(["a2"]);
    expect(await ids("q=employer")).toEqual(["a2"]);
    expect(await ids("q=inv%20100")).toEqual(["a1"]);
    // The IBAN is not searchable (it is never shown in full).
    expect(await ids(`q=${CP_IBAN}`)).toEqual([]);
    expect(await ids("q=NL91")).toEqual([]);
    // Wildcards are literal.
    expect(await ids("q=%25")).toEqual([]);
  });

  it("totals per currency count money in and out of pending and completed rows only", async () => {
    await seedMany();
    const { body } = await get<BankTransactionsResponse>("/api/bank/transactions");
    // a1 -100, a2 +2500, a3 -5 (pending), a6 EUR -50 | a6 USD +54; declined a4 and reverted a5 are listed, not summed.
    expect(body.totalsByCurrency).toEqual([
      { currency: "EUR", inMinor: 250000, outMinor: 15500, count: 4 },
      { currency: "USD", inMinor: 5400, outMinor: 0, count: 1 },
    ]);
    expect(body.total).toBe(7);
    const filtered = await get<BankTransactionsResponse>(
      "/api/bank/transactions?direction=out&limit=1",
    );
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.totalsByCurrency[0]).toMatchObject({ currency: "EUR", inMinor: 0 });
  });

  it("day filters follow Amsterdam time", async () => {
    // 2026-07-09 22:30 UTC is 2026-07-10 00:30 in Amsterdam (CEST).
    await ingest(simpleTx("late", { createdAt: "2026-07-09T22:30:00.000Z" }));
    const ids = async (q: string) =>
      (await get<BankTransactionsResponse>(`/api/bank/transactions?${q}`)).body.items.map(
        (t) => t.externalId,
      );
    expect(await ids("from=2026-07-10")).toEqual(["late"]);
    expect(await ids("to=2026-07-09")).toEqual([]);
    expect(await ids("to=2026-07-10")).toEqual(["late"]);
    expect(amsterdamDayStart("2026-07-10")).toBe("2026-07-09T22:00:00.000Z");
    expect(amsterdamDayStart("2026-01-10")).toBe("2026-01-09T23:00:00.000Z");
    expect(amsterdamDayStart("2026-03-29")).toBe("2026-03-28T23:00:00.000Z"); // spring-forward day starts in CET
    expect(amsterdamDayStart("2026-10-25")).toBe("2026-10-24T22:00:00.000Z");
  });

  it("validates every parameter and an unknown account is 404", async () => {
    for (const q of [
      "state=open",
      "direction=sideways",
      "from=2026-13-40",
      "to=yesterday",
      "from=2026-07-12&to=2026-07-01",
      "limit=0",
      "limit=101",
      "limit=abc",
      "account=abc",
      "account=-1",
      "cursor=not-a-cursor",
      `q=${"x".repeat(101)}`,
      "q=a b c d e f g h i",
    ]) {
      const r = await get<{ error: string }>(`/api/bank/transactions?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error).toMatch(/^bad_/);
    }
    expect((await get("/api/bank/transactions?account=999999")).status).toBe(404);
  });

  it("without a connection it is empty, still validating the query", async () => {
    await resetRevolut();
    const ok = await get<BankTransactionsResponse>("/api/bank/transactions");
    expect(ok.body).toMatchObject({ items: [], nextCursor: null, total: 0, available: false });
    expect((await get("/api/bank/transactions?state=nope")).status).toBe(400);
  });
});

describe("cursor encoding", () => {
  it("round-trips and rejects anything else", () => {
    const c = { createdAt: "2026-07-10T08:00:00.000Z", id: 42 };
    expect(decodeTxCursor(encodeTxCursor(c))).toEqual(c);
    const forge = (v: unknown): string => btoa(JSON.stringify(v)).replace(/=+$/, "");
    for (const bad of [
      "",
      "x",
      forge(["d", "2026-07-10", 1]),
      forge(["a", c.createdAt, 1]),
      forge(["d", c.createdAt, 0]),
      forge(["d", c.createdAt, "1"]),
      forge(["d", c.createdAt]),
      forge({}),
      "a".repeat(300),
    ]) {
      expect(decodeTxCursor(bad), bad).toBeNull();
    }
  });
});

describe("GET /api/bank/transactions/:id", () => {
  beforeEach(async () => {
    await seedAccounts();
  });

  it("returns the transaction with all legs of the same Revolut transaction", async () => {
    await ingest(
      simpleTx("x1", {
        type: "exchange",
        legs: [
          { legId: "x1-out", amount: -50 },
          { legId: "x1-in", amount: 54, currency: "USD", accountId: ACC_USD },
        ],
      }),
      "webhook",
    );
    await ingest(simpleTx("other"));
    const list = await get<BankTransactionsResponse>("/api/bank/transactions");
    const one = list.body.items.find((t) => t.legId === "x1-out");
    const { status, body } = await get<BankTransactionDetail>(`/api/bank/transactions/${one?.id}`);
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(DETAIL);
    expect(body.legs.map((l) => l.legId)).toEqual(["x1-in", "x1-out"]);
    expect(body.legs.map((l) => l.currency).sort()).toEqual(["EUR", "USD"]);
    for (const l of body.legs) expect(Object.keys(l).sort()).toEqual(TX);
    expect(body).toMatchObject({ source: "webhook", externalId: "x1" });
    expect(typeof body.firstSeenAt).toBe("string");
    expect(JSON.stringify(body)).not.toContain(CP_IBAN);
  });

  it("404 for an unknown id, 400 for a malformed one", async () => {
    expect((await get("/api/bank/transactions/99999")).status).toBe(404);
    expect((await get("/api/bank/transactions/abc")).status).toBe(400);
    expect((await get("/api/bank/transactions/0")).status).toBe(400);
  });
});

describe("environment", () => {
  it("uses the real binding the tests run against", () => {
    expect(env.DB).toBeDefined();
  });
});
