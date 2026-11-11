import type { ExactGate } from "./exact/gate";
import type { JobMessage } from "./jobs/types";
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
  /** One instance per Exact division ("exact:<division>"), plus token authorities. */
  EXACT_GATE: DurableObjectNamespace<ExactGate>;
  /** One JobLock per job name ("job:<name>"): the no-overlap lease (CLAUDE.md 4.1). */
  JOB_LOCK: DurableObjectNamespace<JobLock>;
  /** Cloudflare Queue the cron tick and "Run now" enqueue job runs on; the Worker consumes it. */
  JOBS_QUEUE: Queue<JobMessage>;
}
