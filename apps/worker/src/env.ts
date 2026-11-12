import type { ExactGate } from "./exact/gate";
import type { RevolutGate } from "./revolut/gate";
import type { QueueMessage } from "./jobs/types";
import type { JobLock } from "./jobs/job-lock";

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
  /** Workers var: client ID of the Revolut Business API certificate (empty placeholder until set). */
  REVOLUT_CLIENT_ID: string;
  /** Workers var: `iss` of the client assertion, the HOST of REVOLUT_REDIRECT_URI. */
  REVOLUT_ISSUER: string;
  /** Workers var: absolute callback URL, https://<app host>/api/connections/revolut/callback. */
  REVOLUT_REDIRECT_URI: string;
  /** Workers secret: PKCS#8 PEM private key whose certificate is registered with Revolut. */
  REVOLUT_PRIVATE_KEY: string;
  /**
   * Workers secret, optional until payments are switched on: the key of the keyed IBAN fingerprint
   * (HMAC-SHA-256, at least 32 characters, ADR 0049). Missing = payments stay blocked
   * (`iban_key_missing`). Rotating it voids every supplier IBAN verification (fail closed).
   */
  PAYMENTS_IBAN_KEY?: string;
  /** Workers secret, optional: API key of the transactional e-mail provider (ADR 0046). */
  EMAIL_API_KEY?: string;
  /** One instance per Revolut connection ("revolut:<connection id>"). */
  REVOLUT_GATE: DurableObjectNamespace<RevolutGate>;
  /** One instance per Exact division ("exact:<division>"), plus token authorities. */
  EXACT_GATE: DurableObjectNamespace<ExactGate>;
  /** One JobLock per job name ("job:<name>"): the no-overlap lease (CLAUDE.md 4.1). */
  JOB_LOCK: DurableObjectNamespace<JobLock>;
  /** Cloudflare Queue the cron tick and "Run now" enqueue job runs on; the Worker consumes it. */
  JOBS_QUEUE: Queue<QueueMessage>;
}
