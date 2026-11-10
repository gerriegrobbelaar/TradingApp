import type { ExactGate } from "./exact/gate";

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
  /** Workers var: OAuth client ID of the Exact app registration (empty placeholder until set). */
  EXACT_CLIENT_ID: string;
  /** Workers var: absolute callback URL, https://<app host>/api/connections/exact/callback. */
  EXACT_REDIRECT_URI: string;
  /** Workers secret: Exact app client secret. */
  EXACT_CLIENT_SECRET: string;
  /** Workers secret: 32-byte base64 key that encrypts stored Exact tokens (AES-GCM). */
  TOKEN_ENC_KEY: string;
  /** Workers secret, optional: previous TOKEN_ENC_KEY, accepted for decryption during rotation. */
  TOKEN_ENC_KEY_PREVIOUS?: string;
  /** One instance per Exact division ("exact:<division>"), plus token authorities. */
  EXACT_GATE: DurableObjectNamespace<ExactGate>;
  /**
   * TEST ONLY. workerd (Miniflare) does not implement Durable Object jurisdictions, so the vitest
   * config sets this to "1" to skip `.jurisdiction("eu")`. Never set it in wrangler.toml or as a
   * Workers variable: the deploy guard refuses a config that mentions it (docs/decisions/0018).
   */
  DO_JURISDICTION_DISABLED?: string;
}
