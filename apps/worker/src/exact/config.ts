import type { Env } from "../env";
import { isValidEncKey } from "../crypto/token-crypto";

export const EXACT_CALLBACK_PATH = "/api/connections/exact/callback";
export const DEFAULT_EXACT_HOST = "start.exactonline.nl";

/**
 * Exact serves each country from its own host. Only these may ever be called or stored, so a
 * poisoned `region_host` can never make the Worker send a bearer token to another site.
 */
const EXACT_HOSTS: ReadonlySet<string> = new Set([
  "start.exactonline.nl",
  "start.exactonline.be",
  "start.exactonline.de",
  "start.exactonline.fr",
  "start.exactonline.es",
  "start.exactonline.co.uk",
  "start.exactonline.com",
]);

export const isExactHost = (host: string): boolean => EXACT_HOSTS.has(host);

export interface ExactConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type ExactConfigResult =
  { ok: true; config: ExactConfig } | { ok: false; missing: string[] };

/** Fails closed; reports names of missing settings only, never values. */
export function loadExactConfig(env: Partial<Env>, appOrigin: string): ExactConfigResult {
  const missing: string[] = [];
  const need = (name: string, v: string | undefined): string => {
    const t = (v ?? "").trim();
    if (t === "") missing.push(name);
    return t;
  };
  const clientId = need("EXACT_CLIENT_ID", env.EXACT_CLIENT_ID);
  const clientSecret = need("EXACT_CLIENT_SECRET", env.EXACT_CLIENT_SECRET);
  const redirectUri = need("EXACT_REDIRECT_URI", env.EXACT_REDIRECT_URI);
  if (!isValidEncKey(env.TOKEN_ENC_KEY)) missing.push("TOKEN_ENC_KEY");
  if (env.TOKEN_ENC_KEY_PREVIOUS && !isValidEncKey(env.TOKEN_ENC_KEY_PREVIOUS)) {
    missing.push("TOKEN_ENC_KEY_PREVIOUS");
  }
  if (redirectUri !== "") {
    try {
      const u = new URL(redirectUri);
      if (u.origin !== appOrigin || u.pathname !== EXACT_CALLBACK_PATH) {
        missing.push("EXACT_REDIRECT_URI(origin/path)");
      }
    } catch {
      missing.push("EXACT_REDIRECT_URI(url)");
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { clientId, clientSecret, redirectUri } };
}
