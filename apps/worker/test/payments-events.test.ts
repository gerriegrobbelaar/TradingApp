/**
 * P9c: the detail read carries the status history (payment_events) for the Payments screen.
 * Read-only: oldest first, states, a stable code and the actor, no request data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchConfirmPhrase,
  paymentConfirmPhrase,
  type SupplierIbanStatusDto,
} from "@camelthorn/core";
import type { IbanStatusDto } from "../src/payments/iban-verify";
import { authed } from "./helpers";
import { addBill, payWorld, SUPPLIER_IBAN, type PayWorld } from "./payments-helpers";

let w: PayWorld;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  w = await payWorld();
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

async function send<T>(
  who: keyof PayWorld["tokens"],
  method: string,
  path: string,
  json?: unknown,
): Promise<{ status: number; body: T; text: string }> {
  const res = await authed(path, w.tokens[who], {
    method,
    ...(json !== undefined ? { json } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as T, text };
}

interface Events {
  payment: { id: number; amountMinor: number };
  events: {
    fromStatus: string | null;
    toStatus: string;
    code: string | null;
    actor: string;
    at: string;
  }[];
}

describe("GET /api/payments/:id history", () => {
  it("lists the moves oldest first for every role, without an IBAN", async () => {
    const c = await send<{ payment: Events["payment"] }>("finance", "POST", "/api/payments", {
      openItemId: w.itemId,
      sourceAccountId: w.accountId,
      clientKey: "events-key-0123456789",
    });
    expect(c.status, c.text).toBe(201);
    const id = c.body.payment.id;
    const done = await send("finance", "POST", `/api/payments/${id}/confirm`, {
      confirm: paymentConfirmPhrase(c.body.payment.amountMinor, "EUR", "4300"),
    });
    expect(done.status, done.text).toBe(200);
    for (const who of ["viewer", "finance", "approver", "admin"] as const) {
      const r = await send<Events>(who, "GET", `/api/payments/${id}`);
      expect(r.status).toBe(200);
      expect(r.text).not.toContain(SUPPLIER_IBAN);
      expect(r.body.events.map((e) => [e.fromStatus, e.toStatus, e.code])).toEqual([
        [null, "draft", "created"],
        ["draft", "pending_approval", "confirmed_needs_approval"],
      ]);
      expect(
        r.body.events.every((e) => e.actor.length > 0 && !Number.isNaN(Date.parse(e.at))),
      ).toBe(true);
      expect(Object.keys(r.body.events[0] ?? {}).sort()).toEqual([
        "actor",
        "at",
        "code",
        "fromStatus",
        "toStatus",
      ]);
    }
  });

  it("is a 404 for a request that does not exist", async () => {
    expect((await send("viewer", "GET", "/api/payments/99999")).status).toBe(404);
  });
});

describe("GET /api/payment-batches/:id history", () => {
  it("lists the batch's own moves (not its items') for every role, without an IBAN", async () => {
    const second = await addBill(w);
    const c = await send<{ batch: { id: number; totalMinor: number; itemCount: number } }>(
      "finance",
      "POST",
      "/api/payment-batches",
      {
        sourceAccountId: w.accountId,
        items: [{ openItemId: w.itemId }, { openItemId: second.itemId }],
        clientKey: "events-batch-key-0123456789",
      },
    );
    expect(c.status, c.text).toBe(201);
    const id = c.body.batch.id;
    const done = await send("finance", "POST", `/api/payment-batches/${id}/confirm`, {
      confirm: batchConfirmPhrase(c.body.batch.itemCount, c.body.batch.totalMinor, "EUR"),
    });
    expect(done.status, done.text).toBe(200);
    for (const who of ["viewer", "finance", "approver", "admin"] as const) {
      const r = await send<{ batch: { id: number }; events: Events["events"] }>(
        who,
        "GET",
        `/api/payment-batches/${id}`,
      );
      expect(r.status, r.text).toBe(200);
      expect(r.body.batch.id).toBe(id);
      expect(r.text).not.toContain(SUPPLIER_IBAN);
      expect(r.text).not.toMatch(/NL\d{2}[A-Z]{4}\d{10}/);
      const moves = r.body.events.map((e) => [e.fromStatus, e.toStatus]);
      expect(moves[0]).toEqual([null, "draft"]);
      expect(moves.at(-1)?.[1]).toBe("pending_approval");
      // one row per move of the batch, not one per bill in it
      expect(moves).toHaveLength(2);
    }
  });

  it("an unauthenticated read is refused", async () => {
    const res = await authed("/api/payment-batches/1", "");
    expect([401, 403]).toContain(res.status);
  });
});

// The web reads the supplier IBAN status through core's copy of this shape: they must not drift.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
describe("shared types", () => {
  it("core's SupplierIbanStatusDto is the worker's IbanStatusDto", () => {
    const same: Equal<IbanStatusDto, SupplierIbanStatusDto> = true;
    expect(same).toBe(true);
  });
});
