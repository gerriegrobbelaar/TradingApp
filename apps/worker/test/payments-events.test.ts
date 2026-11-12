/**
 * P9c: the detail read carries the status history (payment_events) for the Payments screen.
 * Read-only: oldest first, states, a stable code and the actor, no request data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentConfirmPhrase, type SupplierIbanStatusDto } from "@camelthorn/core";
import type { IbanStatusDto } from "../src/payments/iban-verify";
import { authed } from "./helpers";
import { payWorld, SUPPLIER_IBAN, type PayWorld } from "./payments-helpers";

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

// The web reads the supplier IBAN status through core's copy of this shape: they must not drift.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
describe("shared types", () => {
  it("core's SupplierIbanStatusDto is the worker's IbanStatusDto", () => {
    const same: Equal<IbanStatusDto, SupplierIbanStatusDto> = true;
    expect(same).toBe(true);
  });
});
