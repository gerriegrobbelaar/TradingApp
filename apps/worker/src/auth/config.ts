import type { Env } from "../env";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  redirectUri: string;
  /** Origin of the app, derived from OAUTH_REDIRECT_URI; used for the CSRF Origin check. */
  appOrigin: string;
  allowedHd: string;
}

export type ConfigResult = { ok: true; config: AuthConfig } | { ok: false; missing: string[] };

/**
 * Fails closed: any missing or malformed setting makes every non-public route answer 500
 * instead of silently running with weaker checks. Only variable names are reported.
 */
export function loadAuthConfig(env: Partial<Env>): ConfigResult {
  const missing: string[] = [];
  const need = (name: keyof Env, value: string | undefined): string => {
    const v = (value ?? "").trim();
    if (v === "") missing.push(name);
    return v;
  };
  const clientId = need("GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID);
  const clientSecret = need("GOOGLE_CLIENT_SECRET", env.GOOGLE_CLIENT_SECRET);
  const sessionSecret = need("SESSION_SECRET", env.SESSION_SECRET);
  const redirectUri = need("OAUTH_REDIRECT_URI", env.OAUTH_REDIRECT_URI);
  const allowedHd = need("ALLOWED_HD", env.ALLOWED_HD).toLowerCase();
  if (sessionSecret !== "" && sessionSecret.length < 32) missing.push("SESSION_SECRET(length)");
  let appOrigin = "";
  if (redirectUri !== "") {
    try {
      const u = new URL(redirectUri);
      appOrigin = u.origin;
      if (u.protocol !== "https:" && u.hostname !== "localhost") {
        missing.push("OAUTH_REDIRECT_URI(https)");
      }
    } catch {
      missing.push("OAUTH_REDIRECT_URI(url)");
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: { clientId, clientSecret, sessionSecret, redirectUri, appOrigin, allowedHd },
  };
}
