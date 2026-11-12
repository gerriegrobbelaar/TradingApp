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

describe("maskDeep keeps identifiers exact (review P9c)", () => {
  // 64 hex characters starting with two letters and two digits: looks like an IBAN to maskIbans.
  const HASH = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
  it("leaves hashes, fingerprints, request ids and cursors byte for byte", () => {
    // A base64url cursor whose "-" is followed by an IBAN-like run (two letters, two digits).
    const cursor = "WyJkIiwiMjAyNi0xMS0x-AB12CDEFGHIJKLMNOP";
    expect(maskIbanLike(cursor)).not.toBe(cursor); // the plain mask would corrupt it
    const out = maskDeep({
      payloadHash: HASH,
      ibanFingerprint: HASH,
      ibanFingerprintShort: HASH.slice(0, 16),
      protocolVersion: HASH,
      bankEntryHash: HASH,
      matchSetHash: HASH,
      requestId: "ab12cd34-ef56-4000-8000-000000000000",
      nextCursor: cursor,
      items: [{ payloadHash: HASH }],
    });
    expect(out.payloadHash).toBe(HASH);
    expect(out.ibanFingerprint).toBe(HASH);
    expect(out.ibanFingerprintShort).toBe(HASH.slice(0, 16));
    expect(out.protocolVersion).toBe(HASH);
    expect(out.bankEntryHash).toBe(HASH);
    expect(out.matchSetHash).toBe(HASH);
    expect(out.requestId).toBe("ab12cd34-ef56-4000-8000-000000000000");
    expect(out.nextCursor).toBe(cursor);
    expect(out.items[0]?.payloadHash).toBe(HASH);
  });
  it("still masks a full IBAN that lands in an identifier field or any other field", () => {
    const FULL = "NL91ABNA0417164300";
    const out = maskDeep({
      payloadHash: FULL,
      ibanFingerprint: `${FULL} x`,
      requestId: FULL,
      providerId: FULL,
      reference: HASH, // not an identifier field: masked like text
      note: [FULL],
    });
    expect(JSON.stringify(out)).not.toContain(FULL);
    expect(out.reference).not.toBe(HASH);
  });
  it("does not trust a key inherited from the prototype", () => {
    expect(maskDeep({ toString: "NL91ABNA0417164300" }).toString).not.toContain("0417164300");
  });
});
