/**
 * A scripted fake of the Revolut Business API for the payment tests (P9b, ADR 0050). It sits behind
 * the REAL RevolutGate (fetch is stubbed by stubRevolut), so every test goes through the real
 * allow-list, lease, ledger and client. THE ANSWERS ARE ASSUMED SHAPES (see packages/revolut/test/
 * payment-fixtures.ts), not recordings.
 */
import { runInDurableObject } from "cloudflare:test";
import type { RevolutGate } from "../src/revolut/gate";
import { db, revolutGate, stubRevolut, type ApiCall, type RevolutStub } from "./revolut-helpers";

export const SOURCE_ACCOUNT_UUID = "bdab1c20-8d8c-430d-b967-87ac01af060c";

export type Fault = Response | Error | ((c: ApiCall) => Response | Promise<Response>);

export interface FakeTx {
  id: string;
  requestId: string;
  state: string;
  amount: string;
  currency: string;
  accountId: string;
}

export class FakeRevolut {
  stub: RevolutStub;
  counterparties: { id: string; name: string; iban: string }[] = [];
  transactions = new Map<string, FakeTx>();
  drafts: { id: string; title: string; state: string; txId?: string }[] = [];
  /** Per "METHOD /path" queue of faults consumed once each. */
  faults = new Map<string, Fault[]>();
  private seq = 0;

  constructor() {
    this.stub = stubRevolut();
    this.stub.api = (c) => this.handle(c);
  }

  restore(): void {
    this.stub.restore();
  }

  calls(method: string, path: string): ApiCall[] {
    const full = `/api/1.0${path}`;
    return this.stub.apiCalls.filter(
      (c) =>
        c.method === method && (c.url.pathname === full || c.url.pathname.startsWith(`${full}/`)),
    );
  }

  fail(key: string, ...f: Fault[]): void {
    this.faults.set(key, [...(this.faults.get(key) ?? []), ...f]);
  }

  /** The next call to `key` answers with this status (the Response is built inside the request). */
  failStatus(key: string, status: number, body: unknown = { message: "fault" }): void {
    this.fail(key, () => Response.json(body, { status }));
  }

  private id(): string {
    this.seq++;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  private async handle(c: ApiCall): Promise<Response> {
    const path = c.url.pathname.replace("/api/1.0", "");
    const key = `${c.method} ${path.replace(/\/[0-9a-f-]{36}$/, "/:id")}`;
    const queued = this.faults.get(key)?.shift();
    if (queued !== undefined) {
      if (queued instanceof Error) throw queued;
      return typeof queued === "function" ? queued(c) : queued;
    }
    return this.process(c);
  }

  /** The normal (unfaulted) behaviour; a fault function may call it to let Revolut act. */
  process(c: ApiCall): Response {
    const path = c.url.pathname.replace("/api/1.0", "");
    if (c.method === "POST" && path === "/counterparty") {
      const b = JSON.parse(c.body ?? "{}") as { company_name: string; iban: string };
      const cp = { id: this.id(), name: b.company_name, iban: b.iban };
      this.counterparties.push(cp);
      return Response.json({
        id: cp.id,
        name: cp.name,
        state: "created",
        accounts: [{ id: this.id(), currency: "EUR", type: "external", iban: cp.iban }],
      });
    }
    if (c.method === "GET" && path === "/counterparties") {
      return Response.json(
        this.counterparties.map((cp) => ({
          id: cp.id,
          name: cp.name,
          accounts: [{ id: `${cp.id.slice(0, -1)}9`, iban: cp.iban, currency: "EUR" }],
        })),
      );
    }
    if (c.method === "POST" && path === "/pay") {
      // The body is read as text so the amount keeps its digits.
      const text = c.body ?? "";
      const b = JSON.parse(text) as { request_id: string; account_id: string; currency: string };
      if ([...this.transactions.values()].some((t) => t.requestId === b.request_id)) {
        return Response.json({ message: "Request ID already used", code: 3000 }, { status: 409 });
      }
      const amount = /"amount":([0-9.]+)/.exec(text)?.[1] ?? "0";
      const tx: FakeTx = {
        id: this.id(),
        requestId: b.request_id,
        state: "pending",
        amount,
        currency: b.currency,
        accountId: b.account_id,
      };
      this.transactions.set(tx.id, tx);
      return Response.json({ id: tx.id, state: tx.state, created_at: "2026-11-12T10:00:00Z" });
    }
    if (c.method === "POST" && path === "/payment-drafts") {
      const b = JSON.parse(c.body ?? "{}") as { title: string };
      const d = { id: this.id(), title: b.title, state: "pending" };
      this.drafts.push(d);
      return Response.json({ id: d.id });
    }
    if (c.method === "GET" && path === "/payment-drafts") {
      return Response.json(this.drafts.map((d) => this.draftJson(d)));
    }
    if (c.method === "GET" && path.startsWith("/payment-drafts/")) {
      const d = this.drafts.find((x) => path.endsWith(x.id));
      return d
        ? Response.json(this.draftJson(d))
        : Response.json({ message: "no" }, { status: 404 });
    }
    if (c.method === "GET" && path.startsWith("/transaction/")) {
      const rid = decodeURIComponent(path.slice("/transaction/".length));
      const tx =
        c.url.searchParams.get("id_type") === "request_id"
          ? [...this.transactions.values()].find((t) => t.requestId === rid)
          : this.transactions.get(rid);
      return tx
        ? Response.json(this.txJson(tx))
        : Response.json({ message: "no" }, { status: 404 });
    }
    return Response.json({ message: "unexpected" }, { status: 500 });
  }

  draftJson(d: { id: string; title: string; state: string; txId?: string }): unknown {
    return {
      id: d.id,
      title: d.title,
      payments: [{ state: d.state, ...(d.txId ? { transaction_id: d.txId } : {}) }],
    };
  }

  txJson(t: FakeTx): unknown {
    return {
      id: t.id,
      type: "transfer",
      request_id: t.requestId,
      state: t.state,
      created_at: "2026-11-12T10:00:00Z",
      legs: [
        {
          leg_id: `${t.id.slice(0, -1)}1`,
          amount: `-${t.amount}`,
          currency: t.currency,
          account_id: t.accountId,
        },
      ],
    };
  }
}

/** Makes this connection's gate see the deploy switch as "on" (the DO has its own env copy). */
export async function gateExecution(connectionId: number, on: boolean): Promise<void> {
  await runInDurableObject(revolutGate(connectionId), (gate: RevolutGate) => {
    const g = gate as unknown as { env: Record<string, unknown> };
    g.env = { ...g.env, REVOLUT_PAYMENTS_EXECUTION: on ? "on" : "off" };
  });
}

/** The source account gets a Revolut-shaped (uuid) external id, like a real one. */
export async function useUuidAccount(accountId: number): Promise<void> {
  await db
    .prepare("UPDATE bank_accounts SET external_id = ?2 WHERE id = ?1")
    .bind(accountId, SOURCE_ACCOUNT_UUID)
    .run();
}
