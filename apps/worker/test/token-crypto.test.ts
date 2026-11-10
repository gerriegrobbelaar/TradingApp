import { describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  isValidEncKey,
  keyring,
  TokenCryptoError,
} from "../src/crypto/token-crypto";

const key = (fill: number): string => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const K1 = key(1);
const K2 = key(2);

describe("token crypto", () => {
  it("round-trips and never stores plaintext", async () => {
    const blob = await encryptToken(K1, "super-secret-refresh-token", "exact:1:refresh");
    expect(blob).not.toContain("super-secret");
    expect(blob.startsWith("v1.")).toBe(true);
    expect(await decryptToken([K1], blob, "exact:1:refresh")).toBe("super-secret-refresh-token");
  });

  it("uses a fresh IV per value", async () => {
    const a = await encryptToken(K1, "same", "x");
    const b = await encryptToken(K1, "same", "x");
    expect(a).not.toBe(b);
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]);
  });

  it("detects tampering in any part", async () => {
    const blob = await encryptToken(K1, "token", "ctx");
    const [v, id, iv, ct] = blob.split(".") as [string, string, string, string];
    const flip = (s: string): string => (s.startsWith("A") ? "B" : "A") + s.slice(1);
    for (const bad of [
      [v, id, iv, flip(ct)],
      [v, id, flip(iv), ct],
      [v, id, iv, ct.slice(0, -4)],
      ["v2", id, iv, ct],
      [v, id, iv],
    ]) {
      await expect(decryptToken([K1], bad.join("."), "ctx")).rejects.toBeInstanceOf(
        TokenCryptoError,
      );
    }
  });

  it("fails closed with a wrong key or a different context", async () => {
    const blob = await encryptToken(K1, "token", "exact:1:access");
    await expect(decryptToken([K2], blob, "exact:1:access")).rejects.toThrow("no matching key");
    await expect(decryptToken([K1], blob, "exact:1:refresh")).rejects.toThrow("decryption failed");
    await expect(decryptToken([K1], blob, "exact:2:access")).rejects.toThrow("decryption failed");
    // a value forged under another key id but with the right key id string is still rejected
    const forged = blob.replace(/^v1\.[0-9a-f]{8}\./, "v1.00000000.");
    await expect(decryptToken([K1], forged, "exact:1:access")).rejects.toThrow("no matching key");
  });

  it("accepts the previous key during rotation", async () => {
    const old = await encryptToken(K1, "token", "ctx");
    expect(await decryptToken([K2, K1], old, "ctx")).toBe("token");
    const fresh = await encryptToken(K2, "token", "ctx");
    expect(fresh.split(".")[1]).not.toBe(old.split(".")[1]);
  });

  it("never leaks plaintext or key in error messages", async () => {
    const blob = await encryptToken(K1, "plain-secret", "ctx");
    try {
      await decryptToken([K2], blob, "ctx");
    } catch (e) {
      expect(String(e)).not.toContain("plain-secret");
      expect(String(e)).not.toContain(K1);
      expect(String(e)).not.toContain(K2);
    }
  });

  it("rejects keys that are not 32 bytes of base64", async () => {
    expect(isValidEncKey(K1)).toBe(true);
    expect(isValidEncKey("")).toBe(false);
    expect(isValidEncKey(undefined)).toBe(false);
    expect(isValidEncKey("not base64!!")).toBe(false);
    expect(isValidEncKey(btoa("short"))).toBe(false);
    await expect(encryptToken(btoa("short"), "x", "y")).rejects.toBeInstanceOf(TokenCryptoError);
    expect(keyring({ TOKEN_ENC_KEY: K1, TOKEN_ENC_KEY_PREVIOUS: "" })).toEqual([K1]);
  });
});

describe("review E2: TOKEN_ENC_KEY format", () => {
  it("accepts only standard padded base64 of exactly 32 bytes", async () => {
    const { isValidEncKey } = await import("../src/crypto/token-crypto");
    const good = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    expect(isValidEncKey(good)).toBe(true);
    expect(isValidEncKey(` ${good}\n`)).toBe(true); // surrounding whitespace from `wrangler secret put`
    expect(isValidEncKey(good.slice(0, -1))).toBe(false); // unpadded
    expect(isValidEncKey(good.replace("AAEC", "AA EC"))).toBe(false); // inner space
    expect(isValidEncKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8-")).toBe(false); // base64url
    expect(isValidEncKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHg==")).toBe(false); // 31 bytes
    expect(isValidEncKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gIQ==")).toBe(false); // 34 bytes
  });
});
