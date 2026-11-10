import { describe, expect, it } from "vitest";
import { isPlausibleIban, maskIban, normalizeIban } from "./iban";

describe("iban helpers", () => {
  it("normalises case and whitespace", () => {
    expect(normalizeIban(" nl91 abna\t0417 1643 00 ")).toBe("NL91ABNA0417164300");
  });

  it("masks to country, check digits and the last four", () => {
    expect(maskIban("NL91 ABNA 0417 1643 00")).toBe("NL91****4300");
    expect(maskIban("de89370400440532013000")).toBe("DE89****3000");
  });

  it("hides short input completely", () => {
    expect(maskIban("NL91")).toBe("****");
    expect(maskIban("NL91ABNA")).toBe("****");
    expect(maskIban("NL91ABNA0")).toBe("NL91****BNA0");
  });

  it("checks the shape only", () => {
    expect(isPlausibleIban("NL91ABNA0417164300")).toBe(true);
    expect(isPlausibleIban("NL91")).toBe(false);
    expect(isPlausibleIban("nl91abna0417164300")).toBe(false);
    expect(isPlausibleIban("NL91-ABNA")).toBe(false);
    expect(isPlausibleIban("9191ABNA0417164300")).toBe(false);
  });
});
