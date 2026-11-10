export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  INITIAL_ADMIN_EMAIL: string;
  ALLOWED_HD: string;
  /** Workers var: OAuth client ID of the Google Cloud project (empty placeholder until set). */
  GOOGLE_CLIENT_ID: string;
  /** Workers var: absolute callback URL, e.g. https://app.example.com/api/auth/callback. */
  OAUTH_REDIRECT_URI: string;
  /** Workers secret. */
  GOOGLE_CLIENT_SECRET: string;
  /** Workers secret: HMAC key for the sign-in round-trip cookie (at least 32 characters). */
  SESSION_SECRET: string;
}
