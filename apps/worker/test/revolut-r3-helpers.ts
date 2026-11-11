/**
 * Shared fixtures for the Revolut webhook, ingest and sync tests (task R3a): a fake Revolut API
 * behind the fetch stub (accounts, one transaction, the transaction list, bank details, webhooks), a
 * recording queue, and a signer for webhook deliveries.
 */
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { saveWebhookSecret } from "../src/revolut/store";
import type { ApiCall } from "./revolut-helpers";

export const ADMIN = "gerrie.grobbelaar@camelthorncapital.com";
export const ACC_EUR = "0f1e2d3c-4b5a-4968-8776-655443322110";
export const ACC_USD = "1f1e2d3c-4b5a-4968-8776-655443322111";
export const WEBHOOK_ID = "123e4567-e89b-12d3-a456-426614174000";
export const WEBHOOK_SECRET = "wsk_test_0123456789abcdef";
export const OUR_IBAN = "GB33REVO00996912345678";
export const CP_IBAN = "NL91ABNA0417164300";

export class EventQueue {
  sent: QueueMessage[] = [];
  fail = false;
  async send(body: QueueMessage): Promise<void> {
    if (this.fail) throw new Error("queue down");
    this.sent.push(body);
  }
}

export function envWithQueue(queue: EventQueue): Env {
  return Object.create(env, { JOBS_QUEUE: { value: queue, enumerable: true } }) as Env;
}

// ---- transactions -----------------------------------------------------------------------------

export interface FakeLeg {
  legId: string;
  accountId?: string;
  /** Decimal as Revolut sends it. */
  amount: number;
  currency?: string;
  counterpartyIban?: string;
  counterpartyName?: string;
  description?: string;
}

export interface FakeTransaction {
  id: string;
  state?: string;
  type?: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  reference?: string;
  legs: FakeLeg[];
}

export function txJson(t: FakeTransaction): Record<string, unknown> {
  return {
    id: t.id,
    type: t.type ?? "transfer",
    request_id: `req-${t.id}`,
    state: t.state ?? "completed",
    created_at: t.createdAt,
    updated_at: t.updatedAt ?? t.createdAt,
    ...(t.completedAt ? { completed_at: t.completedAt } : {}),
    reference: t.reference ?? "Invoice 2026001",
    legs: t.legs.map((l) => ({
      leg_id: l.legId,
      account_id: l.accountId ?? ACC_EUR,
      amount: l.amount,
      currency: l.currency ?? "EUR",
      ...(l.description ? { description: l.description } : {}),
      counterparty: {
        id: "cp-secret-id",
        account_type: "external",
        name: l.counterpartyName ?? "Acme B.V.",
        iban: l.counterpartyIban ?? CP_IBAN,
      },
    })),
  };
}

export const simpleTx = (id: string, over: Partial<FakeTransaction> = {}): FakeTransaction => ({
  id,
  createdAt: "2026-07-10T08:00:00.000Z",
  legs: [{ legId: `${id}-l1`, amount: -100.5 }],
  ...over,
});

// ---- the fake API -----------------------------------------------------------------------------

export interface FakeRevolut {
  transactions: FakeTransaction[];
  accounts: { id: string; name: string; currency: string; balance: number; state: string }[];
  /** ids that answer 404 */
  missing: Set<string>;
  /** Make every call fail with this status (e.g. 500, 429). */
  failAll: number | null;
  /** Status for POST /webhooks; 201 creates, anything else fails. */
  webhookCreate: { status: number; id: string; secret: string };
  /** Subscriptions GET /webhooks lists. */
  webhooks: { id: string; url: string; events: string[] }[];
  /** Cap on rows per /transactions call (server side). */
  maxCount: number | null;
  handle: (c: ApiCall) => Response;
  txCalls: () => ApiCall[];
}

export function fakeRevolut(): FakeRevolut {
  const f: FakeRevolut = {
    transactions: [],
    accounts: [
      { id: ACC_EUR, name: "Main EUR", currency: "EUR", balance: 1234.5, state: "active" },
      { id: ACC_USD, name: "Dollars", currency: "USD", balance: 10, state: "active" },
    ],
    missing: new Set(),
    failAll: null,
    webhookCreate: { status: 201, id: WEBHOOK_ID, secret: WEBHOOK_SECRET },
    webhooks: [],
    maxCount: null,
    handle: () => new Response("", { status: 500 }),
    txCalls: () => [],
  };
  const calls: ApiCall[] = [];
  f.txCalls = () => calls;
  f.handle = (c) => {
    calls.push(c);
    if (f.failAll !== null) {
      return new Response(JSON.stringify({ message: "boom" }), {
        status: f.failAll,
        headers: f.failAll === 429 ? { "retry-after": "1" } : {},
      });
    }
    const path = c.url.pathname;
    if (path === "/api/1.0/accounts") {
      return Response.json(
        f.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          currency: a.currency,
          balance: a.balance,
          state: a.state,
        })),
      );
    }
    const details = /^\/api\/1\.0\/accounts\/([^/]+)\/bank-details$/.exec(path);
    if (details) {
      return Response.json(
        details[1] === ACC_EUR
          ? [
              {
                iban: OUR_IBAN,
                bic: "REVOGB21",
                beneficiary: "Camelthorn Advisory B.V.",
                schemes: [],
              },
            ]
          : [],
      );
    }
    const one = /^\/api\/1\.0\/transaction\/(.+)$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1] as string);
      const t = f.transactions.find((x) => x.id === id);
      if (!t || f.missing.has(id)) return Response.json({ message: "not found" }, { status: 404 });
      return Response.json(txJson(t));
    }
    if (path === "/api/1.0/transactions") {
      const q = c.url.searchParams;
      const from = q.get("from");
      const to = q.get("to");
      const asked = Number(q.get("count") ?? "100");
      const count = f.maxCount === null ? asked : Math.min(asked, f.maxCount);
      const ms = (iso: string): number => Date.parse(iso);
      const rows = f.transactions
        .filter(
          (t) =>
            (from === null || ms(t.createdAt) >= ms(from)) &&
            (to === null || ms(t.createdAt) <= ms(to)),
        )
        .sort((a, b) => ms(b.createdAt) - ms(a.createdAt) || (a.id < b.id ? -1 : 1))
        .slice(0, count);
      return Response.json(rows.map(txJson));
    }
    if (path === "/api/2.0/webhooks" && c.method === "POST") {
      if (f.webhookCreate.status !== 201) {
        return Response.json({ message: "no" }, { status: f.webhookCreate.status });
      }
      const body = JSON.parse(c.body ?? "{}") as { url: string; events: string[] };
      return Response.json({
        id: f.webhookCreate.id,
        url: body.url,
        events: body.events,
        signing_secret: f.webhookCreate.secret,
      });
    }
    if (path === "/api/2.0/webhooks" && c.method === "GET") {
      // A real response may carry signing secrets: the app must never store them.
      return Response.json(f.webhooks.map((w) => ({ ...w, signing_secret: "wsk_LEAK_FROM_LIST" })));
    }
    if (/^\/api\/2\.0\/webhooks\/[^/]+$/.test(path) && c.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: "unexpected" }, { status: 404 });
  };
  return f;
}

// ---- webhook deliveries -----------------------------------------------------------------------

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const eventBody = (event: string, id: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    data: { id, request_id: `req-${id}`, ...extra },
  });

export interface Delivery {
  body: string;
  secret?: string;
  timestampMs?: number;
  /** Replace the computed signature header. */
  signature?: string;
  omitSignature?: boolean;
  omitTimestamp?: boolean;
  method?: string;
  headers?: Record<string, string>;
}

export async function deliveryRequest(d: Delivery, origin = "https://app.test"): Promise<Request> {
  const ts = String(d.timestampMs ?? Date.now());
  const headers = new Headers({ "content-type": "application/json", ...(d.headers ?? {}) });
  if (!d.omitTimestamp) headers.set("revolut-request-timestamp", ts);
  if (!d.omitSignature) {
    headers.set(
      "revolut-signature",
      d.signature ?? `v1=${await hmacHex(d.secret ?? WEBHOOK_SECRET, `v1.${ts}.${d.body}`)}`,
    );
  }
  const method = d.method ?? "POST";
  return new Request(`${origin}/api/webhooks/revolut`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: d.body }),
  });
}

export async function storeWebhookSecret(connectionId: number, secret = WEBHOOK_SECRET) {
  await saveWebhookSecret(env, connectionId, WEBHOOK_ID, secret, ADMIN);
}

export async function rowsOf(table: string, where = "1"): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all())
    .results as Record<string, unknown>[];
}
