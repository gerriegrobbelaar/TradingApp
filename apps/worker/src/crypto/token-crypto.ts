/**
 * Token encryption at rest: AES-256-GCM with a random 96-bit IV per value.
 *
 * Stored form: `v1.<keyId>.<iv>.<ciphertext+tag>` (base64url parts). `keyId` is the first 4 bytes
 * of SHA-256 over the raw key, so a rotated key is recognised and a value is never decrypted with
 * the wrong key by accident. Rotation: set the new key as TOKEN_ENC_KEY and keep the old one in
 * TOKEN_ENC_KEY_PREVIOUS until every token has been rewritten (tokens are rewritten on each
 * refresh, so one Exact refresh cycle migrates them).
 *
 * `aad` (additional authenticated data) binds a value to its place, for example
 * `exact:3:access`, so a stolen blob cannot be swapped into another column or connection.
 * Everything fails closed with TokenCryptoError, whose message never contains key or data.
 */
import { fromBase64Url, toBase64Url } from "../auth/crypto";

const VERSION = "v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

export class TokenCryptoError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`token crypto: ${reason}`);
    this.name = "TokenCryptoError";
    this.reason = reason;
  }
}

interface LoadedKey {
  id: string;
  key: CryptoKey;
}

/** Standard base64 of exactly 32 bytes: 43 characters plus one "=" (`openssl rand -base64 32`). */
const KEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;

function rawKey(b64: string): Uint8Array {
  const t = b64.trim();
  if (!KEY_B64_RE.test(t)) throw new TokenCryptoError("key must be 32 bytes of base64");
  let bytes: Uint8Array;
  try {
    const bin = atob(t);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    throw new TokenCryptoError("key is not base64");
  }
  if (bytes.length !== 32) throw new TokenCryptoError("key must be 32 bytes");
  return bytes;
}

/** True when the value is a base64 string that decodes to exactly 32 bytes. */
export function isValidEncKey(b64: string | undefined): boolean {
  if (!b64) return false;
  try {
    rawKey(b64);
    return true;
  } catch {
    return false;
  }
}

async function loadKey(b64: string): Promise<LoadedKey> {
  const raw = rawKey(b64);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const id = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { id, key };
}

export async function encryptToken(
  keyB64: string,
  plaintext: string,
  aad: string,
): Promise<string> {
  const { id, key } = await loadKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
      key,
      enc.encode(plaintext),
    ),
  );
  return [VERSION, id, toBase64Url(iv), toBase64Url(ct)].join(".");
}

/**
 * `keysB64`: current key first, then any previous keys still accepted for decryption.
 * Throws TokenCryptoError for a malformed value, an unknown key, a wrong key or tampering.
 */
export async function decryptToken(
  keysB64: readonly string[],
  blob: string,
  aad: string,
): Promise<string> {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new TokenCryptoError("bad format");
  const [, keyId, ivPart, ctPart] = parts as [string, string, string, string];
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    iv = fromBase64Url(ivPart);
    ct = fromBase64Url(ctPart);
  } catch {
    throw new TokenCryptoError("bad format");
  }
  if (iv.length !== 12 || ct.length < 16) throw new TokenCryptoError("bad format");
  for (const k of keysB64) {
    if (!k) continue;
    const loaded = await loadKey(k);
    if (loaded.id !== keyId) continue;
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
        loaded.key,
        ct,
      );
      return dec.decode(pt);
    } catch {
      throw new TokenCryptoError("decryption failed");
    }
  }
  throw new TokenCryptoError("no matching key");
}

/** Keys to try when decrypting, current first. */
export function keyring(env: {
  TOKEN_ENC_KEY?: string;
  TOKEN_ENC_KEY_PREVIOUS?: string;
}): string[] {
  return [env.TOKEN_ENC_KEY, env.TOKEN_ENC_KEY_PREVIOUS].filter(
    (k): k is string => typeof k === "string" && k !== "",
  );
}
