import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

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
