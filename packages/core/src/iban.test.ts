import { describe, expect, it } from "vitest";
import { hasValidIbanChecksum, isPlausibleIban, maskIban, normalizeIban } from "./iban";

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

  it("folds compatibility forms and drops invisible characters", () => {
    // Full-width letters and digits, a non-breaking space, a zero-width space and a BOM.
    expect(normalizeIban("ＮＬ９１ ABNA​0417﻿164300")).toBe("NL91ABNA0417164300");
    expect(isPlausibleIban(normalizeIban("NL91 ABNA​ 0417 1643 00"))).toBe(true);
  });

  it("does not fold lookalikes from other scripts: they stay implausible", () => {
    // Cyrillic capital A (U+0410) instead of Latin A.
    const n = normalizeIban("NL91 АBNA 0417 1643 00");
    expect(n).not.toBe("NL91ABNA0417164300");
    expect(isPlausibleIban(n)).toBe(false);
  });

  it("verifies the mod-97 checksum", () => {
    expect(hasValidIbanChecksum("NL91ABNA0417164300")).toBe(true);
    expect(hasValidIbanChecksum("DE89370400440532013000")).toBe(true);
    expect(hasValidIbanChecksum("GB82WEST12345698765432")).toBe(true);
    expect(hasValidIbanChecksum("NL92ABNA0417164300")).toBe(false);
    expect(hasValidIbanChecksum("NL91ABNA0417164301")).toBe(false);
    expect(hasValidIbanChecksum("nl91abna0417164300")).toBe(false);
    expect(hasValidIbanChecksum("NL91")).toBe(false);
  });

  it("checks the shape only", () => {
    expect(isPlausibleIban("NL91ABNA0417164300")).toBe(true);
    expect(isPlausibleIban("NL91")).toBe(false);
    expect(isPlausibleIban("nl91abna0417164300")).toBe(false);
    expect(isPlausibleIban("NL91-ABNA")).toBe(false);
    expect(isPlausibleIban("9191ABNA0417164300")).toBe(false);
  });
});
