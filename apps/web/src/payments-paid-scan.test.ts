/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * F9c (ADR 0054, CLAUDE.md 4.3): "Paid" needs the bank's confirmation AND the match booked in Exact.
 * `payment.status === "paid"` is the bank's word alone. A source scan of every screen file: nothing
 * outside lib/payment-labels.ts may compare a status with the paid value or say "Paid" about a
 * request; the label comes from displayStatus(), which looks at the settlement.
 */
const all = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Blank comments so only code and strings are scanned. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const LABELS = "./lib/payment-labels.ts";
/** Files where the bank-paid value legitimately appears: the label module, and the list filter's wire value. */
const MAY_NAME_PAID_VALUE = new Set([LABELS, "./components/payments/PaymentsList.tsx"]);

describe("no screen calls a payment Paid on the bank's word alone", () => {
  it("finds the sources", () => {
    expect(Object.keys(all).length).toBeGreaterThan(100);
    expect(all[LABELS]).toBeTruthy();
  });

  it("no comparison of a status with the paid value outside the label module", () => {
    const bad: string[] = [];
    for (const [name, src] of Object.entries(all)) {
      if (name === LABELS) continue;
      const c = code(src);
      if (/status\s*[!=]==?\s*["'`]paid["'`]/.test(c)) bad.push(`${name}: status === "paid"`);
      if (/["'`]paid["'`]\s*[!=]==?\s*[\w.?]*status/i.test(c))
        bad.push(`${name}: "paid" === status`);
      if (/case\s+["'`]paid["'`]/.test(c)) bad.push(`${name}: case "paid"`);
      if (/\.includes\(\s*\w*\.?status\s*\)/.test(c) && /["'`]paid["'`]/.test(c)) {
        bad.push(`${name}: includes(status) with a paid list`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the paid value is named only where it is allowed", () => {
    const named = Object.entries(all)
      .filter(([, src]) => /["'`]paid["'`]/.test(code(src)))
      .map(([n]) => n)
      .filter((n) => !MAY_NAME_PAID_VALUE.has(n))
      // other features keep their own `paid` words (open-item filters, bank direction); not payments
      .filter((n) => /payment|Payment|pay-|Pay/.test(n));
    expect(named).toEqual([]);
    // PaymentsList only through the exported constant, never as a literal
    expect(code(all["./components/payments/PaymentsList.tsx"] ?? "")).not.toMatch(/["'`]paid["'`]/);
  });

  it("PAID_STATUS and isBooked are imported nowhere but where they are allowed", () => {
    const users = Object.entries(all)
      .filter(([n, src]) => n !== LABELS && /\bPAID_STATUS\b/.test(code(src)))
      .map(([n]) => n);
    expect(users).toEqual(["./components/payments/PaymentsList.tsx"]);
  });

  it("the payment screens get their status words from displayStatus, never from STATUS_TEXT or statusText", () => {
    const users = Object.entries(all)
      .filter(([n]) => n.startsWith("./components/payments/") || n.startsWith("./pages/"))
      .filter(([, src]) => /\b(STATUS_TEXT|statusText)\b/.test(code(src)))
      .map(([n]) => n);
    expect(users).toEqual([]);
  });

  it("no payment screen hard-codes the word Paid as a label", () => {
    const bad: string[] = [];
    for (const [name, src] of Object.entries(all)) {
      if (!(name.startsWith("./components/payments/") || name === "./pages/PaymentsSettings.tsx")) {
        continue;
      }
      const c = code(src);
      if (/label:\s*"Paid"|>\s*Paid\s*</.test(c)) bad.push(name);
    }
    expect(bad).toEqual([]);
  });

  it("the stored status text for `paid` is never plain Paid; only the booked settlement is", async () => {
    const { STATUS_TEXT, SETTLEMENT_TEXT } = await import("./lib/payment-labels");
    expect(STATUS_TEXT.paid.label).not.toBe("Paid");
    const plain = Object.entries(SETTLEMENT_TEXT).filter(([, t]) => t.label === "Paid");
    expect(plain.map(([k]) => k)).toEqual(["booked"]);
  });
});
