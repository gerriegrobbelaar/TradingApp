import { asRow, badData, optStr, parseJsonRawNumbers, reqStr } from "./json";

/** Revolut Business production endpoints (verify with credentials, see the ADR). */
export const REVOLUT_AUTHORIZE_URL = "https://business.revolut.com/app-confirm";
export const REVOLUT_TOKEN_URL = "https://b2b.revolut.com/api/1.0/auth/token";
export const REVOLUT_CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

// ---- base64url -------------------------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

// ---- private key -----------------------------------------------------------------------------

/** PEM text to DER bytes. Only unencrypted PKCS#8 is accepted; other forms fail with advice. */
export function pkcs8PemToDer(pem: string): Uint8Array<ArrayBuffer> {
  if (typeof pem !== "string") throw new RangeError("The private key must be a PKCS#8 PEM");
  // Secrets are often stored on one line with literal "\n" (or "\r\n") sequences, or with CRLF.
  const text = pem
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (/-----BEGIN RSA PRIVATE KEY-----/.test(text)) {
    throw new RangeError(
      "The private key is PKCS#1 (BEGIN RSA PRIVATE KEY). Convert it to PKCS#8 with: " +
        "openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem",
    );
  }
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) {
    throw new RangeError("The private key is encrypted; store an unencrypted PKCS#8 key");
  }
  if (/-----BEGIN (?:EC|DSA|OPENSSH) PRIVATE KEY-----/.test(text)) {
    throw new RangeError("The private key must be an RSA key in PKCS#8 form (BEGIN PRIVATE KEY)");
  }
  const m = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/.exec(text);
  if (!m) throw new RangeError("The private key must be a PKCS#8 PEM (BEGIN PRIVATE KEY)");
  let bin: string;
  try {
    bin = atob((m[1] ?? "").replace(/\s+/g, ""));
  } catch {
    throw new RangeError("The private key PEM is not valid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** RSA keys below this size are refused (NIST SP 800-57: 2048 bits minimum). */
export const MIN_RSA_MODULUS_BITS = 2048;

async function importSigningKey(pem: string): Promise<CryptoKey> {
  const der = pkcs8PemToDer(pem);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    // The engine error can describe the key; say only what is useful. EC and Ed25519 PKCS#8
    // keys end up here too.
    throw new RangeError(
      "The private key could not be imported as an RSA PKCS#8 key (EC and Ed25519 keys are not supported)",
    );
  }
  const bits = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
  if (!(bits >= MIN_RSA_MODULUS_BITS)) {
    throw new RangeError(`The RSA private key must be at least ${MIN_RSA_MODULUS_BITS} bits`);
  }
  return key;
}

/** Hostname labels (letters, digits, inner hyphens), optional port. No scheme, path or user. */
const HOST_RE =
  /^(?=.{1,253}(?::|$))[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?$/;
/** Printable ASCII only: values that go into JSON claims, URLs and HTTP headers. */
const PRINTABLE_RE = /^[\x21-\x7E]+$/;

// ---- client assertion ------------------------------------------------------------------------

export interface ClientAssertionOptions {
  /**
   * The `iss` claim. Revolut requires the host of the redirect URI registered with the API
   * certificate (for example "app.example.com", no scheme, no path). Verify with credentials.
   */
  issuer: string;
  clientId: string;
  privateKeyPem: string;
  /** Default 'https://revolut.com'. */
  audience?: string;
  /** Epoch milliseconds. */
  now: number;
  /** Default 300. */
  ttlSeconds?: number;
  /** Test hook; default is crypto.randomUUID(). */
  jti?: string;
}

/**
 * Compact JWS (RS256) used as `client_assertion` in the token calls. Claims: iss, sub (client
 * id), aud, iat, exp, jti. Pure WebCrypto: runs in Workers. Errors never contain key material.
 */
export async function buildClientAssertion(opts: ClientAssertionOptions): Promise<string> {
  if (!HOST_RE.test(opts.issuer)) {
    throw new RangeError("issuer must be the redirect URI host only (no scheme, no path)");
  }
  if (!PRINTABLE_RE.test(opts.clientId)) throw new RangeError("clientId is required");
  if (opts.jti !== undefined && !PRINTABLE_RE.test(opts.jti)) {
    throw new RangeError("jti must be printable ASCII");
  }
  const ttl = opts.ttlSeconds ?? 300;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600) {
    throw new RangeError("ttlSeconds must be an integer between 1 and 3600");
  }
  if (!Number.isFinite(opts.now)) throw new RangeError("now must be epoch milliseconds");
  const key = await importSigningKey(opts.privateKeyPem);
  const iat = Math.floor(opts.now / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: opts.issuer,
    sub: opts.clientId,
    aud: opts.audience ?? "https://revolut.com",
    iat,
    exp: iat + ttl,
    jti: opts.jti ?? crypto.randomUUID(),
  };
  const signingInput = `${utf8ToBase64Url(JSON.stringify(header))}.${utf8ToBase64Url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

// ---- authorize URL and token calls -------------------------------------------------------------

/**
 * The consent URL. `state` is included for our own CSRF check; Revolut's consent flow may not
 * echo it back (verify with credentials), in which case bind the flow to the signed-in session.
 */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  if (!isSafeHttpsUrl(opts.redirectUri)) {
    throw new RangeError("redirectUri must be an https URL (no credentials, no fragment)");
  }
  if (!PRINTABLE_RE.test(opts.clientId)) throw new RangeError("clientId is required");
  // Any printable text is fine (it is percent-encoded); no control characters, no lone
  // surrogates (encodeURIComponent would throw a URIError), bounded length.
  if (
    opts.state === "" ||
    opts.state.length > 1024 ||
    hasControlChar(opts.state) ||
    !encodable(opts.state)
  ) {
    throw new RangeError("state is required and must be printable");
  }
  const q = [
    ["client_id", opts.clientId],
    ["redirect_uri", opts.redirectUri],
    ["response_type", "code"],
    ["state", opts.state],
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v ?? "")}`)
    .join("&");
  return `${REVOLUT_AUTHORIZE_URL}?${q}`;
}

function hasControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function encodable(v: string): boolean {
  try {
    encodeURIComponent(v);
    return true;
  } catch {
    return false;
  }
}

function isSafeHttpsUrl(v: string): boolean {
  if (!/^https:\/\/[\x21-\x7E]+$/.test(v)) return false;
  try {
    const u = new URL(v);
    return (
      u.protocol === "https:" &&
      u.hostname !== "" &&
      u.username === "" &&
      u.password === "" &&
      !v.includes("#")
    );
  } catch {
    return false;
  }
}

/** Form body for POST /auth/token (authorization_code or refresh_token grant). */
export function buildTokenRequestBody(
  opts:
    | { grant: "authorization_code"; code: string; clientId: string; clientAssertion: string }
    | { grant: "refresh_token"; refreshToken: string; clientId: string; clientAssertion: string },
): string {
  const p = new URLSearchParams();
  p.set("grant_type", opts.grant);
  if (opts.grant === "authorization_code") p.set("code", opts.code);
  else p.set("refresh_token", opts.refreshToken);
  p.set("client_id", opts.clientId);
  p.set("client_assertion_type", REVOLUT_CLIENT_ASSERTION_TYPE);
  p.set("client_assertion", opts.clientAssertion);
  return p.toString();
}

/** A token lifetime beyond a week is not plausible for Revolut (about 40 minutes); refuse it. */
const MAX_TOKEN_LIFETIME_SECONDS = 604_800;

export interface RevolutTokens {
  accessToken: string;
  tokenType: "bearer";
  expiresInSeconds: number;
  /** Absent on refresh responses; keep the stored one then. */
  refreshToken?: string;
}

/**
 * Parse the token endpoint response. Errors say what is wrong, never include the body (it holds
 * tokens). The caller must store the tokens encrypted and never log this object.
 */
export function parseTokenResponse(body: string): RevolutTokens {
  const fail = (): never => {
    throw badData("Revolut returned an unusable token response", "BAD_TOKEN_RESPONSE");
  };
  let row;
  try {
    row = asRow(parseJsonRawNumbers(body));
  } catch {
    return fail();
  }
  try {
    const accessToken = reqStr(row, "access_token");
    // Lenient on a missing token_type (verify with credentials), strict on any other value.
    const tokenType = (optStr(row, "token_type") ?? "bearer").toLowerCase();
    const expRaw = reqStr(row, "expires_in");
    const exp = /^\d{1,7}$/.test(expRaw) ? Number(expRaw) : Number.NaN;
    if (
      tokenType !== "bearer" ||
      !PRINTABLE_RE.test(accessToken) ||
      !(exp >= 1 && exp <= MAX_TOKEN_LIFETIME_SECONDS)
    ) {
      return fail();
    }
    const out: RevolutTokens = { accessToken, tokenType: "bearer", expiresInSeconds: exp };
    const refresh = optStr(row, "refresh_token");
    if (refresh !== undefined) {
      if (!PRINTABLE_RE.test(refresh)) return fail();
      out.refreshToken = refresh;
    }
    return out;
  } catch {
    return fail();
  }
}
