/**
 * Request validation and URL building for RevolutGate. The caller-supplied `path` is untrusted
 * (it may be built from data that came from Revolut), so a request must match an entry of a
 * strict allow-list (method + path shape + API version) and the final URL is verified to stay on
 * the connection's Revolut API host. Anything not listed is refused: that includes the token
 * endpoint (only the gate talks to it), every payment endpoint (/pay, /payment-drafts,
 * /transfer, /counterparty creation: payments are Phase 9, behind four-eyes controls) and every
 * webhook call except creating and deleting the subscription (and listing them, for one job id).
 */
import { RevolutApiError, JOB_ID_RE, type RevolutRequest } from "@camelthorn/revolut";
import { revolutApiHost, type RevolutEnvironment } from "./config";

const UUID = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";
/** A transaction id or a client-chosen request id (Revolut accepts both on /transaction/{id}). */
const TX_ID = "[A-Za-z0-9_-]{1,100}";

/** The one job id that may list webhook subscriptions (see ALLOWED). */
export const WEBHOOK_RECOVER_JOB_ID = "revolut-webhook-recover";
/**
 * The one job id that may read a counterparty (`GET /counterparty/{id}`, review S6, ADR 0034). The
 * response holds a name and IBANs: only the sync's lazy lookup uses it, with its own small call
 * budget, and keeps nothing but the cache row.
 */
export const COUNTERPARTY_LOOKUP_JOB_ID = "revolut-counterparty-lookup";

interface Allowed {
  version: "1.0" | "2.0";
  methods: readonly string[];
  re: RegExp;
  /** When set, only these job ids may use the entry. */
  onlyJobs?: readonly string[];
  /** When set, only this priority may use the entry. */
  onlyPriority?: "user" | "job";
}

const ALLOWED: readonly Allowed[] = [
  { version: "1.0", methods: ["GET"], re: /^\/accounts$/ },
  { version: "1.0", methods: ["GET"], re: new RegExp(`^/accounts/${UUID}$`) },
  { version: "1.0", methods: ["GET"], re: new RegExp(`^/accounts/${UUID}/bank-details$`) },
  { version: "1.0", methods: ["GET"], re: /^\/transactions$/ },
  { version: "1.0", methods: ["GET"], re: new RegExp(`^/transaction/${TX_ID}$`) },
  { version: "1.0", methods: ["GET"], re: /^\/counterparties$/ },
  // One counterparty by id, for the sync's lazy IBAN lookup only (job priority, one job id).
  {
    version: "1.0",
    methods: ["GET"],
    re: new RegExp("^/counterparty/" + TX_ID + "$"),
    onlyJobs: [COUNTERPARTY_LOOKUP_JOB_ID],
    onlyPriority: "job",
  },
  // Webhooks (API 2.0): create our one subscription and delete it, nothing else (review R2).
  // Reading a webhook returns its signing secret, and rotation is not built yet; a later task
  // that needs them adds them here with a review. The gate also checks that a created
  // subscription points at this app's own webhook URL.
  { version: "2.0", methods: ["POST"], re: /^\/webhooks$/ },
  // Listing subscriptions exists for ONE purpose (review R2, task R3a): recovering from a lost
  // creation response, where Revolut has a subscription for our URL whose signing secret we never
  // received. Only the admin-triggered recovery (job id above, priority 'user') may call it, and
  // its caller keeps ids and URLs only: a response may carry signing secrets and is never stored
  // or logged.
  {
    version: "2.0",
    methods: ["GET"],
    re: /^\/webhooks$/,
    onlyJobs: [WEBHOOK_RECOVER_JOB_ID],
    onlyPriority: "user",
  },
  { version: "2.0", methods: ["DELETE"], re: new RegExp(`^/webhooks/${UUID}$`) },
];

const QUERY_KEY_RE = /^[A-Za-z0-9_$.]{1,64}$/;
/** Headers a caller may set; Authorization, Host and Cookie are the gate's business. */
const ALLOWED_HEADERS: ReadonlySet<string> = new Set(["content-type", "accept"]);
const MAX_QUERY_VALUE = 1000;
const MAX_BODY = 1_000_000;

const bad = (code: string): RevolutApiError =>
  new RevolutApiError(400, "invalid revolut request", code);

/** The API version of a request (default 1.0). */
export const versionOf = (req: Pick<RevolutRequest, "apiVersion">): "1.0" | "2.0" =>
  req.apiVersion ?? "1.0";

export function validateRequest(req: RevolutRequest): void {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
    // PATCH exists in the type for later phases; nothing allowed uses it yet.
    throw bad("method");
  }
  if (!Number.isSafeInteger(req.connectionId) || req.connectionId < 1) throw bad("connection");
  if (req.priority !== "user" && req.priority !== "job") throw bad("priority");
  if (typeof req.jobId !== "string" || !JOB_ID_RE.test(req.jobId)) throw bad("job_id");
  if (req.apiVersion !== undefined && req.apiVersion !== "1.0" && req.apiVersion !== "2.0") {
    throw bad("api_version");
  }
  if (typeof req.path !== "string" || req.path.length > 300) throw bad("path");
  const version = versionOf(req);
  const byPath = ALLOWED.filter((a) => a.version === version && a.re.test(req.path));
  if (byPath.length === 0) throw bad("path");
  const entry = byPath.find((a) => a.methods.includes(req.method));
  if (!entry) throw bad("method");
  if (entry.onlyJobs && !entry.onlyJobs.includes(req.jobId)) throw bad("job_id");
  if (entry.onlyPriority && req.priority !== entry.onlyPriority) throw bad("job_id");
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (!QUERY_KEY_RE.test(k) || typeof v !== "string" || v.length > MAX_QUERY_VALUE) {
      throw bad("query");
    }
  }
  for (const k of Object.keys(req.headers ?? {})) {
    if (!ALLOWED_HEADERS.has(k.toLowerCase())) throw bad("header");
  }
  if (req.body !== undefined) {
    if (typeof req.body !== "string" || req.body.length > MAX_BODY || req.method === "GET") {
      throw bad("body");
    }
  }
}

/** Builds the absolute URL. Throws RevolutApiError if the result left the connection's host. */
export function buildUrl(environment: RevolutEnvironment, req: RevolutRequest): URL {
  const host = revolutApiHost(environment);
  const version = versionOf(req);
  const url = new URL(`https://${host}/api/${version}${req.path}`);
  url.search = new URLSearchParams(req.query ?? {}).toString();
  if (
    url.protocol !== "https:" ||
    url.host !== host ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(`/api/${version}/`) ||
    url.pathname.includes("..")
  ) {
    throw bad("path");
  }
  return url;
}
