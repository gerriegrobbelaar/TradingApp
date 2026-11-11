import { describe, expect, it } from "vitest";
import { norm } from "../test-norm";
import {
  amountText,
  checkAllocations,
  parseAmount,
  settlesDirection,
  suggestAllocation,
  toSafeNumber,
  type AllocItem,
} from "./allocation";

const it1 = (over: Partial<AllocItem> = {}): AllocItem => {
  const base = {
    openItemId: 1,
    kind: "invoice" as const,
    currency: "EUR",
    openMinor: 123400n,
    text: "1234,00",
    ...over,
  };
  const abs = base.openMinor < 0n ? -base.openMinor : base.openMinor;
  return { ...base, freeMinor: "freeMinor" in over ? (over.freeMinor ?? null) : abs };
};

describe("parseAmount", () => {
  it("reads decimal text at the currency's scale", () => {
    expect(parseAmount("1234,50", "EUR")).toEqual({ ok: true, minor: 123450n });
    expect(parseAmount("1234.5", "EUR")).toEqual({ ok: true, minor: 123450n });
    expect(parseAmount(" 12 ", "EUR")).toEqual({ ok: true, minor: 1200n });
    expect(parseAmount("0.01", "EUR")).toEqual({ ok: true, minor: 1n });
    expect(parseAmount("12,", "EUR")).toEqual({ ok: true, minor: 1200n });
  });

  it("JPY has no decimals and KWD has three", () => {
    expect(parseAmount("5000", "JPY")).toEqual({ ok: true, minor: 5000n });
    expect(parseAmount("5000,5", "JPY")).toEqual({ ok: false, error: "decimals" });
    expect(parseAmount("1.234", "KWD")).toEqual({ ok: true, minor: 1234n });
    expect(parseAmount("1.2345", "KWD")).toEqual({ ok: false, error: "decimals" });
    expect(parseAmount("1,5", "KWD")).toEqual({ ok: true, minor: 1500n });
  });

  it("refuses anything that is not plain digits", () => {
    for (const bad of [
      "1.234,56",
      "1,234.56",
      "-5",
      "+5",
      "1e3",
      "abc",
      "1 000",
      "0x10",
      ".5",
      ",",
    ]) {
      const r = parseAmount(bad, "EUR");
      expect(r.ok, bad).toBe(false);
    }
    expect(parseAmount("", "EUR")).toEqual({ ok: false, error: "empty" });
    expect(parseAmount("0", "EUR")).toEqual({ ok: false, error: "zero" });
    expect(parseAmount("0,00", "EUR")).toEqual({ ok: false, error: "zero" });
  });

  it("keeps every digit and refuses what a JSON number cannot hold (2^53)", () => {
    // 2^53 - 1 = 9007199254740991 minor units
    expect(parseAmount("90071992547409,91", "EUR")).toEqual({
      ok: true,
      minor: 9007199254740991n,
    });
    // 2^53 + 1 would round to 2^53 as a float: refused, never silently changed
    expect(parseAmount("90071992547409,93", "EUR")).toEqual({ ok: false, error: "too_large" });
    expect(parseAmount("99999999999999999999", "EUR")).toEqual({ ok: false, error: "too_large" });
  });
});

describe("parseAmount: hostile text (review M7d)", () => {
  it("refuses non-ASCII digits, direction marks, inner spaces and exponent forms", () => {
    for (const bad of [
      "١٢٣", // Arabic-Indic
      "１２３", // full-width
      "12\u200f34",
      "\u200e1234",
      "\u202e1234",
      "12\u00a034",
      "1e3",
      "1E3",
      "Infinity",
      "NaN",
      "1_000",
      "1'000",
      "12..5",
      "12,,5",
      "1,2,3",
      "١,٥",
    ]) {
      expect(parseAmount(bad, "EUR").ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("ignores surrounding whitespace (incl. no-break space) only", () => {
    expect(parseAmount("\u00a0 12,50 \t", "EUR")).toEqual({ ok: true, minor: 1250n });
  });
  it("refuses very long text before any BigInt work", () => {
    expect(parseAmount("1".repeat(100_000), "EUR")).toEqual({ ok: false, error: "too_large" });
    expect(parseAmount("0".repeat(30) + "1", "EUR")).toEqual({ ok: false, error: "too_large" });
  });
  it("documents the grouping rule: 1,500 is refused for EUR and JPY, 1.5 for KWD", () => {
    expect(parseAmount("1,500", "EUR")).toEqual({ ok: false, error: "decimals" });
    expect(parseAmount("1.500", "EUR")).toEqual({ ok: false, error: "decimals" });
    expect(parseAmount("1,500", "JPY")).toEqual({ ok: false, error: "decimals" });
    expect(parseAmount("1,500", "KWD")).toEqual({ ok: true, minor: 1500n });
  });
});

describe("checkAllocations: free balance from the server (review M7d)", () => {
  it("caps each amount at what is still free, not at the Exact open balance", () => {
    const c = checkAllocations(100000, "EUR", [
      it1({ openMinor: 150000n, freeMinor: 90000n, text: "1000" }),
    ]);
    expect(c.request).toBeNull();
    expect(norm(c.rows[0]?.error ?? "")).toMatch(
      /still free .*open in Exact.*already matched here/,
    );
    const ok = checkAllocations(90000, "EUR", [
      it1({ openMinor: 150000n, freeMinor: 90000n, text: "900" }),
    ]);
    expect(ok.request).toEqual([{ openItemId: 1, allocatedMinor: 90000 }]);
    const oneOver = checkAllocations(90001, "EUR", [
      it1({ openMinor: 150000n, freeMinor: 90000n, text: "900,01" }),
    ]);
    expect(oneOver.request).toBeNull();
  });
  it("submits nothing while a free balance is still being checked", () => {
    const c = checkAllocations(123400, "EUR", [it1({ freeMinor: null })]);
    expect(c.request).toBeNull();
    expect(c.message).toMatch(/Checking/);
  });
  it("a closed item takes no amount", () => {
    const c = checkAllocations(123400, "EUR", [it1({ status: "closed", freeMinor: 0n })]);
    expect(c.request).toBeNull();
    expect(c.rows[0]?.error).toMatch(/closed/);
  });
  it("a credit note's free balance is a magnitude", () => {
    const c = checkAllocations(-20000, "EUR", [
      it1({ kind: "invoice", openMinor: -30000n, freeMinor: 20000n, text: "200" }),
    ]);
    expect(c.request).toEqual([{ openItemId: 1, allocatedMinor: 20000 }]);
  });
  it("sums above 2^53 across rows are exact in BigInt and refused", () => {
    const max = 9007199254740991n;
    const c = checkAllocations(9007199254740991, "EUR", [
      it1({ openItemId: 1, openMinor: max, text: "90071992547409,91" }),
      it1({ openItemId: 2, openMinor: max, text: "0,01" }),
    ]);
    expect(c.sumMinor).toBe(max + 1n);
    expect(c.differenceMinor).toBe(-1n);
    expect(c.request).toBeNull();
  });
});

describe("amountText", () => {
  it("is exact for any size and round-trips through parseAmount", () => {
    expect(amountText(123450n, "EUR")).toBe("1234.50");
    expect(amountText(-5n, "EUR")).toBe("0.05");
    expect(amountText(1234n, "KWD")).toBe("1.234");
    expect(amountText(5000n, "JPY")).toBe("5000");
    expect(amountText(9007199254740991n, "EUR")).toBe("90071992547409.91");
    expect(parseAmount(amountText(9007199254740991n, "EUR"), "EUR")).toEqual({
      ok: true,
      minor: 9007199254740991n,
    });
  });
});

describe("settlesDirection", () => {
  it("invoices and supplier credit notes are paid by money in", () => {
    expect(settlesDirection("invoice", 100n)).toBe("in");
    expect(settlesDirection("bill", -100n)).toBe("in");
    expect(settlesDirection("bill", 100n)).toBe("out");
    expect(settlesDirection("invoice", -100n)).toBe("out");
  });
});

describe("checkAllocations", () => {
  it("accepts one invoice that equals the payment", () => {
    const c = checkAllocations(123400, "EUR", [it1()]);
    expect(c.message).toBeNull();
    expect(c.differenceMinor).toBe(0n);
    expect(c.request).toEqual([{ openItemId: 1, allocatedMinor: 123400 }]);
  });

  it("splits one payment over several invoices and shows what is left", () => {
    const items = [
      it1({ openItemId: 1, text: "1000,00" }),
      it1({ openItemId: 2, text: "200,00", openMinor: 50000n }),
    ];
    const c = checkAllocations(123400, "EUR", items);
    expect(c.request).toBeNull();
    expect(c.differenceMinor).toBe(3400n);
    expect(norm(c.message)).toBe("€ 34,00 still to allocate.");
    const ok = checkAllocations(123400, "EUR", [
      it1({ openItemId: 1, text: "1000,00" }),
      it1({ openItemId: 2, text: "234,00", openMinor: 50000n }),
    ]);
    expect(ok.request).toEqual([
      { openItemId: 1, allocatedMinor: 100000 },
      { openItemId: 2, allocatedMinor: 23400 },
    ]);
  });

  it("says when the total is too much", () => {
    const c = checkAllocations(123400, "EUR", [
      it1({ openItemId: 1, text: "1234,00" }),
      it1({ openItemId: 2, text: "0,01", openMinor: 50000n }),
    ]);
    expect(norm(c.message)).toBe("€ 0,01 too much. The amounts must add up to € 1.234,00.");
    expect(c.request).toBeNull();
  });

  it("a payment out is a negative amount; the sum is on the magnitude", () => {
    const c = checkAllocations(-50000, "EUR", [
      it1({ kind: "bill", openMinor: 50000n, text: "500" }),
    ]);
    expect(c.request).toEqual([{ openItemId: 1, allocatedMinor: 50000 }]);
  });

  it("never allocates more than what is open", () => {
    const c = checkAllocations(100000, "EUR", [it1({ openMinor: 99999n, text: "1000" })]);
    expect(norm(c.rows[0]?.error)).toBe("More than the € 999,99 still open.");
    expect(c.request).toBeNull();
  });

  it("credit notes: only a payment in the other direction settles them", () => {
    // customer credit note (invoice, negative open) is settled by money OUT
    const out = checkAllocations(-20000, "EUR", [
      it1({ kind: "invoice", openMinor: -20000n, text: "200" }),
    ]);
    expect(out.request).toEqual([{ openItemId: 1, allocatedMinor: 20000 }]);
    // ... and not by money in
    const wrong = checkAllocations(20000, "EUR", [
      it1({ kind: "invoice", openMinor: -20000n, text: "200" }),
    ]);
    expect(wrong.request).toBeNull();
    expect(wrong.rows[0]?.error).toBe(
      "A credit note is settled by a payment in the other direction.",
    );
    // a plain invoice cannot be paid by money out
    const inv = checkAllocations(-20000, "EUR", [it1({ openMinor: 20000n, text: "200" })]);
    expect(inv.rows[0]?.error).toMatch(/other direction/);
    // supplier credit note (bill, negative open) is settled by money IN
    const sup = checkAllocations(20000, "EUR", [
      it1({ kind: "bill", openMinor: -20000n, text: "200" }),
    ]);
    expect(sup.request).toEqual([{ openItemId: 1, allocatedMinor: 20000 }]);
  });

  it("refuses another currency", () => {
    const c = checkAllocations(100000, "EUR", [it1({ currency: "USD", text: "1000" })]);
    expect(c.rows[0]?.error).toBe("This invoice is in USD but the payment is in EUR.");
    expect(c.request).toBeNull();
  });

  it("refuses a duplicate item and an empty list", () => {
    const c = checkAllocations(200000, "EUR", [
      it1({ openItemId: 1, text: "1000" }),
      it1({ openItemId: 1, text: "1000" }),
    ]);
    expect(c.rows[1]?.error).toBe("This invoice is listed twice.");
    expect(c.request).toBeNull();
    const e = checkAllocations(100000, "EUR", []);
    expect(e.message).toBe("Add at least one invoice.");
    expect(e.request).toBeNull();
  });

  it("JPY: whole numbers only, and the sum is in yen", () => {
    const ok = checkAllocations(5000, "JPY", [
      it1({ currency: "JPY", openMinor: 5000n, text: "5000" }),
    ]);
    expect(ok.request).toEqual([{ openItemId: 1, allocatedMinor: 5000 }]);
    const frac = checkAllocations(5000, "JPY", [
      it1({ currency: "JPY", openMinor: 5000n, text: "5000,5" }),
    ]);
    expect(frac.rows[0]?.error).toBe("JPY has no decimals. Type a whole number.");
    expect(frac.message).not.toBeNull();
  });

  it("KWD: three decimals", () => {
    const ok = checkAllocations(1234, "KWD", [
      it1({ currency: "KWD", openMinor: 1234n, text: "1,234" }),
    ]);
    expect(ok.request).toEqual([{ openItemId: 1, allocatedMinor: 1234 }]);
    const bad = checkAllocations(1234, "KWD", [
      it1({ currency: "KWD", openMinor: 1234n, text: "1,2345" }),
    ]);
    expect(bad.rows[0]?.error).toBe("KWD has at most 3 decimals.");
  });

  it("sums beyond 2^53 are exact in BigInt, and the request is refused rather than rounded", () => {
    // Two amounts each below 2^53 whose sum is above it: the payment itself cannot be one JSON
    // number, so the server could never have sent it; the maths stays exact regardless.
    const half = 9007199254740991n;
    const c = checkAllocations(BigInt(Number.MAX_SAFE_INTEGER), "EUR", [
      it1({ openItemId: 1, openMinor: half, text: amountText(half, "EUR") }),
    ]);
    expect(c.differenceMinor).toBe(0n);
    expect(c.request).toEqual([{ openItemId: 1, allocatedMinor: Number.MAX_SAFE_INTEGER }]);
    const big = checkAllocations(BigInt(Number.MAX_SAFE_INTEGER), "EUR", [
      it1({ openItemId: 1, openMinor: 2n * half, text: "90071992547409,91" }),
      it1({ openItemId: 2, openMinor: 2n * half, text: "0,01" }),
    ]);
    expect(big.sumMinor).toBe(half + 1n);
    expect(big.differenceMinor).toBe(-1n);
    expect(big.request).toBeNull();
  });

  it("toSafeNumber refuses what a number cannot hold", () => {
    expect(toSafeNumber(5n)).toBe(5);
    expect(() => toSafeNumber(9007199254740993n)).toThrow(RangeError);
  });
});

describe("suggestAllocation", () => {
  it("prefills the smaller of what is open and what is left", () => {
    expect(suggestAllocation(123400, "EUR", 50000n, [])).toBe("500.00");
    expect(suggestAllocation(123400, "EUR", 900000n, [50000n])).toBe("734.00");
    expect(suggestAllocation(123400, "EUR", 900000n, [123400n])).toBe("");
    expect(suggestAllocation(-123400, "EUR", -900000n, [])).toBe("1234.00");
  });
});
