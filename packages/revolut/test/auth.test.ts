import { createPrivateKey, generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REVOLUT_CLIENT_ASSERTION_TYPE,
  buildAuthorizeUrl,
  buildClientAssertion,
  buildTokenRequestBody,
  parseTokenResponse,
  pkcs8PemToDer,
} from "../src/auth";
import { sanitizeForMessage } from "../src/redact";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const NOW = Date.UTC(2024, 4, 1, 12, 0, 0);

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("buildClientAssertion", () => {
  it("builds a compact RS256 JWS that verifies with the public key", async () => {
    const jwt = await buildClientAssertion({
      issuer: "app.example.com",
      clientId: "client-123",
      privateKeyPem: pkcs8,
      now: NOW,
      jti: "jti-1",
    });
    const [h, p, s] = jwt.split(".");
    expect(jwt.split(".")).toHaveLength(3);
    expect(decode(h ?? "")).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(p ?? "")).toEqual({
      iss: "app.example.com",
      sub: "client-123",
      aud: "https://revolut.com",
      iat: NOW / 1000,
      exp: NOW / 1000 + 300,
      jti: "jti-1",
    });
    expect(jwt).not.toMatch(/[+/=]/);
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicPem, Buffer.from(s ?? "", "base64url"))).toBe(true);
    // WebCrypto verify as well, independent of node's verifier.
    const key = await crypto.subtle.importKey(
      "spki",
      Buffer.from(publicPem.replace(/-----[A-Z ]+-----|\s/g, ""), "base64"),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        Buffer.from(s ?? "", "base64url"),
        new TextEncoder().encode(`${h}.${p}`),
      ),
    ).toBe(true);
  });

  it("honours audience and ttl, generates a unique jti, accepts escaped newlines", async () => {
    const a = await buildClientAssertion({
      issuer: "host.example:8443",
      clientId: "c",
      privateKeyPem: pkcs8.replace(/\n/g, "\\n"),
      audience: "https://other",
      now: NOW + 1500,
      ttlSeconds: 60,
    });
    const b = await buildClientAssertion({
      issuer: "h.example",
      clientId: "c",
      privateKeyPem: pkcs8,
      now: NOW,
    });
    const claims = decode(a.split(".")[1] ?? "");
    expect(claims).toMatchObject({
      aud: "https://other",
      iat: NOW / 1000 + 1,
      exp: NOW / 1000 + 61,
    });
    expect(decode(b.split(".")[1] ?? "")["jti"]).not.toBe(claims["jti"]);
  });

  it("tells the user to convert a PKCS#1 key and never echoes key material", async () => {
    const err = await buildClientAssertion({
      issuer: "a.example",
      clientId: "c",
      privateKeyPem: pkcs1,
      now: NOW,
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/openssl pkcs8 -topk8/);
    expect(String(err)).not.toContain(pkcs1.split("\n")[1] ?? "never");
  });

  it("rejects bad keys and bad options with safe messages", async () => {
    const body = pkcs8.split("\n")[1] ?? "";
    const opts = { issuer: "a.example", clientId: "c", now: NOW };
    const cases: [string, RegExp][] = [
      [
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----",
        /encrypted/,
      ],
      ["not a pem", /PKCS#8 PEM/],
      ["-----BEGIN PRIVATE KEY-----\n@@@@\n-----END PRIVATE KEY-----", /PKCS#8 PEM/],
      ["-----BEGIN PRIVATE KEY-----\nAAA=A\n-----END PRIVATE KEY-----", /not valid base64/],
      ["-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", /could not be imported/],
    ];
    for (const [pem, re] of cases) {
      const err = await buildClientAssertion({ ...opts, privateKeyPem: pem }).catch(
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(re);
      expect(String(err)).not.toContain(body);
    }
    const ok = pkcs8;
    await expect(
      buildClientAssertion({ ...opts, issuer: "https://a.example", privateKeyPem: ok }),
    ).rejects.toThrow(/host only/);
    await expect(
      buildClientAssertion({ ...opts, issuer: "a.example/path", privateKeyPem: ok }),
    ).rejects.toThrow(/host only/);
    await expect(
      buildClientAssertion({ ...opts, clientId: " ", privateKeyPem: ok }),
    ).rejects.toThrow(/clientId/);
    await expect(
      buildClientAssertion({ ...opts, ttlSeconds: 0, privateKeyPem: ok }),
    ).rejects.toThrow(/ttlSeconds/);
    await expect(
      buildClientAssertion({ ...opts, ttlSeconds: 4000, privateKeyPem: ok }),
    ).rejects.toThrow(/ttlSeconds/);
    await expect(
      buildClientAssertion({ ...opts, now: Number.NaN, privateKeyPem: ok }),
    ).rejects.toThrow(/now/);
  });

  it("imports the same key node exports (sanity check of the DER path)", () => {
    const der = pkcs8PemToDer(pkcs8);
    expect(
      createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" }).asymmetricKeyType,
    ).toBe("rsa");
  });
});

describe("authorize url and token request", () => {
  it("builds the consent url with an encoded state", () => {
    const url = buildAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://app.example.com/cb?x=1",
      state: "a b&c",
    });
    expect(url).toBe(
      "https://business.revolut.com/app-confirm?client_id=cid&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb%3Fx%3D1&response_type=code&state=a%20b%26c",
    );
    expect(() => buildAuthorizeUrl({ clientId: "c", redirectUri: "http://x", state: "s" })).toThrow(
      /https/,
    );
    expect(() =>
      buildAuthorizeUrl({ clientId: " ", redirectUri: "https://x.y", state: "s" }),
    ).toThrow(/clientId/);
    expect(() =>
      buildAuthorizeUrl({ clientId: "c", redirectUri: "https://x.y", state: "" }),
    ).toThrow(/state/);
  });

  it("builds token request bodies for both grants", () => {
    const a = new URLSearchParams(
      buildTokenRequestBody({
        grant: "authorization_code",
        code: "co",
        clientId: "cid",
        clientAssertion: "jwt",
      }),
    );
    expect(Object.fromEntries(a)).toEqual({
      grant_type: "authorization_code",
      code: "co",
      client_id: "cid",
      client_assertion_type: REVOLUT_CLIENT_ASSERTION_TYPE,
      client_assertion: "jwt",
    });
    const r = new URLSearchParams(
      buildTokenRequestBody({
        grant: "refresh_token",
        refreshToken: "rt",
        clientId: "cid",
        clientAssertion: "jwt",
      }),
    );
    expect(r.get("grant_type")).toBe("refresh_token");
    expect(r.get("refresh_token")).toBe("rt");
    expect(r.has("code")).toBe(false);
  });
});

describe("parseTokenResponse", () => {
  it("parses the token response", () => {
    expect(
      parseTokenResponse(
        '{"access_token":"at","token_type":"bearer","expires_in":2399,"refresh_token":"rt"}',
      ),
    ).toEqual({
      accessToken: "at",
      tokenType: "bearer",
      expiresInSeconds: 2399,
      refreshToken: "rt",
    });
    expect(
      parseTokenResponse('{"access_token":"at","token_type":"Bearer","expires_in":"60"}'),
    ).toEqual({
      accessToken: "at",
      tokenType: "bearer",
      expiresInSeconds: 60,
    });
    expect(parseTokenResponse('{"access_token":"at","expires_in":60}').tokenType).toBe("bearer");
  });

  it("fails without leaking the body", () => {
    for (const body of [
      "not json access_token=SECRETTOKEN",
      "[1]",
      '{"access_token":"SECRETTOKEN"}',
      '{"access_token":"SECRETTOKEN","expires_in":0}',
      '{"access_token":"SECRETTOKEN","expires_in":1.5}',
      '{"access_token":"SECRETTOKEN","expires_in":60,"token_type":"mac"}',
      '{"expires_in":60}',
    ]) {
      let msg = "";
      try {
        parseTokenResponse(body);
      } catch (e) {
        msg = String(e);
      }
      expect(msg, body).toMatch(/unusable token response/);
      expect(msg).not.toContain("SECRETTOKEN");
    }
  });
});

describe("sanitizeForMessage", () => {
  it("redacts PEM blocks, JWTs, v1 signatures and truncates", () => {
    const text = `${pkcs8} eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2ln v1=${"ab".repeat(32)} client_assertion=abc.def`;
    const out = sanitizeForMessage(text);
    expect(out).toContain("[redacted key]");
    expect(out).not.toContain("eyJhbGci");
    expect(out).toContain("v1=[redacted]");
    expect(out).not.toContain("abcdef");
    expect(sanitizeForMessage("x".repeat(500), 10)).toBe("xxxxxxxxxx...");
    expect(sanitizeForMessage("-----BEGIN PRIVATE KEY-----\nAAAA")).toBe("[redacted key]");
  });
});
