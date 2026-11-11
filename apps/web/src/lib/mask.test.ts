import { describe, expect, it } from "vitest";
import { maskDeep, maskIbanLike } from "./mask";

describe("maskIbanLike", () => {
  it("masks IBANs in free text, grouped or not, any case", () => {
    for (const raw of [
      "Paid from NL91ABNA0417164300 thanks",
      "Paid from NL91 ABNA 0417 1643 00 thanks",
      "iban nl91abna0417164300",
      "DE89370400440532013000",
    ]) {
      const out = maskIbanLike(raw);
      expect(out).not.toMatch(/0417164300|0417 1643 00|0532013000/i);
    }
  });
  it("leaves ordinary text and null alone", () => {
    expect(maskIbanLike("INV-2026-001 Acme BV")).toBe("INV-2026-001 Acme BV");
    expect(maskIbanLike(null)).toBeNull();
    expect(maskIbanLike(undefined)).toBeNull();
  });
});

describe("maskDeep", () => {
  it("masks every nested string and keeps numbers, booleans and null", () => {
    const out = maskDeep({
      a: "NL91ABNA0417164300",
      n: 12_345,
      b: true,
      z: null,
      list: [{ explanation: ["From DE89370400440532013000 to us"] }],
    });
    expect(JSON.stringify(out)).not.toMatch(/0417164300|0532013000/);
    expect(out.n).toBe(12_345);
    expect(out.b).toBe(true);
    expect(out.z).toBeNull();
  });
});
