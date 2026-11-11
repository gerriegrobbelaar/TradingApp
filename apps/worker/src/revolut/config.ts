import type { Env } from "../env";
import { isValidEncKey } from "../crypto/token-crypto";

export const REVOLUT_CALLBACK_PATH = "/api/connections/revolut/callback";
/** Where Revolut delivers webhooks (derived from the app origin; task R3 serves it). */
export const REVOLUT_WEBHOOK_PATH = "/api/webhooks/revolut";
export const revolutWebhookUrl = (appOrigin: string): string =>
  `${appOrigin}${REVOLUT_WEBHOOK_PATH}`;

export type RevolutEnvironment = "production" | "sandbox";

export const isRevolutEnvironment = (v: unknown): v is RevolutEnvironment =>
  v === "production" || v === "sandbox";

/**
 * The only hosts a Revolut bearer token, client assertion or refresh token may ever be sent to,
 * chosen by the connection's environment. A poisoned column value can never pick another host.
 */
const HOSTS: Record<RevolutEnvironment, { api: string; consent: string }> = {
  production: { api: "b2b.revolut.com", consent: "business.revolut.com" },
  sandbox: { api: "sandbox-b2b.revolut.com", consent: "sandbox-business.revolut.com" },
};

export const revolutApiHost = (e: RevolutEnvironment): string => HOSTS[e].api;
export const revolutConsentHost = (e: RevolutEnvironment): string => HOSTS[e].consent;

export interface RevolutConfig {
  clientId: string;
  privateKeyPem: string;
  /** `iss` of the client assertion: the host of the redirect URI (Revolut's rule). */
  issuer: string;
  redirectUri: string;
}

export type RevolutConfigResult =
  { ok: true; config: RevolutConfig } | { ok: false; missing: string[] };

/** Fails closed; reports names of missing settings only, never values. */
export function loadRevolutConfig(env: Partial<Env>, appOrigin: string): RevolutConfigResult {
  const missing: string[] = [];
  const need = (name: string, v: unknown): string => {
    // A non-string (a [vars] value written as a number or a table) is missing, never a crash.
    const t = typeof v === "string" ? v.trim() : "";
    if (t === "") missing.push(name);
    return t;
  };
  const clientId = need("REVOLUT_CLIENT_ID", env.REVOLUT_CLIENT_ID);
  const privateKeyPem = need("REVOLUT_PRIVATE_KEY", env.REVOLUT_PRIVATE_KEY);
  const issuer = need("REVOLUT_ISSUER", env.REVOLUT_ISSUER);
  const redirectUri = need("REVOLUT_REDIRECT_URI", env.REVOLUT_REDIRECT_URI);
  // PKCS#8 only (`openssl pkcs8 -topk8 -nocrypt`): the client assertion signer imports PKCS#8.
  if (privateKeyPem !== "" && !/-----BEGIN PRIVATE KEY-----/.test(privateKeyPem)) {
    missing.push("REVOLUT_PRIVATE_KEY(pkcs8)");
  }
  if (!isValidEncKey(env.TOKEN_ENC_KEY)) missing.push("TOKEN_ENC_KEY");
  if (env.TOKEN_ENC_KEY_PREVIOUS && !isValidEncKey(env.TOKEN_ENC_KEY_PREVIOUS)) {
    missing.push("TOKEN_ENC_KEY_PREVIOUS");
  }
  if (redirectUri !== "") {
    try {
      const u = new URL(redirectUri);
      // R1's consent URL builder refuses anything but https (Revolut's rule too).
      if (u.protocol !== "https:") {
        missing.push("REVOLUT_REDIRECT_URI(https)");
      } else if (u.origin !== appOrigin || u.pathname !== REVOLUT_CALLBACK_PATH) {
        missing.push("REVOLUT_REDIRECT_URI(origin/path)");
      } else if (issuer !== "" && issuer !== u.host) {
        missing.push("REVOLUT_ISSUER(host)");
      }
    } catch {
      missing.push("REVOLUT_REDIRECT_URI(url)");
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { clientId, privateKeyPem, issuer, redirectUri } };
}
