import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hmacSha256Hex, sha256Hex } from "./sha256";

describe("sha256Hex", () => {
  it("matches the FIPS 180-4 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("agrees with node:crypto across block boundaries and multi-byte text", () => {
    const samples = ["é", "€ 0,00", "😀x", "\ud800", "a\udc00b"];
    for (let n = 0; n <= 130; n++) samples.push("x".repeat(n));
    for (const s of samples) {
      const expected = createHash("sha256")
        .update(Buffer.from(new TextEncoder().encode(s)))
        .digest("hex");
      expect(sha256Hex(s), JSON.stringify(s)).toBe(expected);
    }
  });
});

describe("hmacSha256Hex", () => {
  it("matches RFC 4231 test case 2 and node:crypto for short, block-sized and long keys", () => {
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    for (const key of ["k", "x".repeat(63), "y".repeat(64), "z".repeat(65), "é€".repeat(40)]) {
      for (const msg of ["", "iban-fp-v2:NL91ABNA0417164300", "m".repeat(200)]) {
        const expected = createHmac("sha256", Buffer.from(new TextEncoder().encode(key)))
          .update(Buffer.from(new TextEncoder().encode(msg)))
          .digest("hex");
        expect(hmacSha256Hex(key, msg), `${key.length}/${msg.length}`).toBe(expected);
      }
    }
  });
});
