import { describe, expect, it } from "vitest";
import { maskIbans, sanitizeForMessage } from "./redact";

describe("maskIbans", () => {
  it("masks compact, spaced and lowercase IBANs", () => {
    expect(maskIbans("NL91ABNA0417164300")).toBe("NL91****4300");
    expect(maskIbans("NL91 ABNA 0417 1643 00")).toBe("NL91****4300");
    expect(maskIbans("nl91abna0417164300")).toBe("NL91****4300");
    expect(maskIbans("GB29 NWBK 6016 1331 9268 19")).toBe("GB29****6819");
    expect(maskIbans("NO9386011117947")).toBe("NO93****7947"); // shortest (15)
    expect(maskIbans("LC55HEMM000100010012001200023015")).toBe("LC55****3015"); // 32
    expect(maskIbans("NL91 ABNA 0417 1643 00")).toBe("NL91****4300");
  });

  it("does not swallow the words after an IBAN (the old over-match)", () => {
    expect(maskIbans("pay NL91 ABNA 0417 1643 00 then stop")).toBe("pay NL91****4300 then stop");
    expect(maskIbans("NL91ABNA0417164300 is not valid")).toBe("NL91****4300 is not valid");
    expect(maskIbans("NL91 ABNA 0417 1643 00 code word")).toBe("NL91****4300 code word");
  });

  it("masks two IBANs in a row separately", () => {
    expect(maskIbans("NL91 ABNA 0417 1643 00 DE89 3704 0044 0532 0130 00")).toBe(
      "NL91****4300 DE89****3000",
    );
    expect(maskIbans("NL91ABNA0417164300,DE89370400440532013000")).toBe(
      "NL91****4300,DE89****3000",
    );
  });

  it("masks IBANs next to punctuation and underscores", () => {
    expect(maskIbans("iban:NL91ABNA0417164300.")).toBe("iban:NL91****4300.");
    expect(maskIbans("account_NL91ABNA0417164300")).toBe("account_NL91****4300");
    expect(maskIbans('"NL91ABNA0417164300"')).toBe('"NL91****4300"');
    expect(maskIbans("NL91ABNA0417164300ABC")).toBe("NL91****4300ABC");
  });

  it("masks truncated IBANs and unknown-country lookalikes conservatively", () => {
    expect(maskIbans("NL91ABNA04171643")).toBe("NL91****1643");
    expect(maskIbans("XX12ABCD1234EFGH")).toBe("XX12****EFGH");
    expect(maskIbans("XX12 ABCD 1234 rest")).toBe("XX12****REST"); // over-mask is the safe side
  });

  it("leaves ordinary text, invoice numbers and short tokens alone", () => {
    for (const s of [
      "INV2024000123",
      "invoice 2024-000123 for EUR 12.50",
      "AB12 CD",
      "id 1234 5678",
      "XX12 ab cd ef gh ij", // unknown country, not shaped like an IBAN
    ]) {
      expect(maskIbans(s)).toBe(s);
    }
  });
});

describe("sanitizeForMessage", () => {
  it("masks IBANs, tokens and secrets", () => {
    const s = sanitizeForMessage(
      `pay NL91 ABNA 0417 1643 00 and GB29NWBK60161331926819 with Bearer tok.en-1 "refresh_token":"abc123" client_secret=zzz signing_secret: wsk_1 code=authcode1 client_assertion=a.b.c`,
    );
    expect(s).not.toMatch(/ABNA 0417|NWBK6016|tok\.en|abc123|zzz|wsk_1|authcode1|a\.b\.c/);
    expect(s).toContain("NL91****4300 and GB29****6819");
  });

  it("does not treat error_code as an authorisation code", () => {
    expect(sanitizeForMessage("error_code=3000")).toBe("error_code=3000");
  });

  it("redacts JWTs, PEM blocks, base64 key bodies and v1 signatures", () => {
    expect(sanitizeForMessage("token eyJhbGciOi.eyJzdWIiOiIx.c2ln here")).toBe(
      "token [redacted] here",
    );
    expect(
      sanitizeForMessage("k -----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY----- x"),
    ).toBe("k [redacted key] x");
    expect(sanitizeForMessage("k -----BEGIN PRIVATE KEY-----\\nMIIabc")).toBe("k [redacted key]");
    expect(sanitizeForMessage(`blob ${"QUJDa1".repeat(20)} end`)).toBe("blob [redacted] end");
    expect(sanitizeForMessage(`sig v1=${"ab".repeat(32)}`)).toBe("sig v1=[redacted]");
  });

  it("truncates", () => {
    expect(sanitizeForMessage("x".repeat(500)).length).toBe(303);
    expect(sanitizeForMessage("abc", 2)).toBe("ab...");
  });
});
