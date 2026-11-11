/**
 * Request validation and URL building for RevolutGate. The caller-supplied `path` is untrusted
 * (it may be built from data that came from Revolut), so a request must match an entry of a
 * strict allow-list (method + path shape + API version) and the final URL is verified to stay on
 * the connection's Revolut API host. Anything not listed is refused: that includes the token
 * endpoint (only the gate talks to it) and every payment endpoint (/pay, /payment-drafts,
 * /transfer, /counterparty creation): payments are Phase 9, behind four-eyes controls.
 */
import { RevolutApiError, type RevolutRequest } from "@camelthorn/revolut";
import { revolutApiHost, type RevolutEnvironment } from "./config";

export const JOB_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

const UUID = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";
/** A transaction id or a client-chosen request id (Revolut accepts both on /transaction/{id}). */
const TX_ID = "[A-Za-z0-9_-]{1,100}";

interface Allowed {
  version: "1.0" | "2.0";
  methods: readonly string[];
  re: RegExp;
}

const ALLOWED: readonly Allowed[] = [
  { version: "1.0", methods: ["GET"], re: /^\/accounts$/ },
  { version: "1.0", methods: ["GET"], re: new RegExp(`^/accounts/${UUID}$`) },
  { version: "1.0", methods: ["GET"], re: new RegExp(`^/accounts/${UUID}/bank-details$`) },
  { version: "1.0", methods: ["GET"], re: /^\/transactions$/ },
  { version: "1.0", methods: ["GET"], re: new RegExp(`^/transaction/${TX_ID}$`) },
  { version: "1.0", methods: ["GET"], re: /^\/counterparties$/ },
  // Webhooks (API 2.0): list, create, read, delete, rotate the signing secret, failed deliveries.
  { version: "2.0", methods: ["GET", "POST"], re: /^\/webhooks$/ },
  { version: "2.0", methods: ["GET", "DELETE"], re: new RegExp(`^/webhooks/${UUID}$`) },
  {
    version: "2.0",
    methods: ["POST"],
    re: new RegExp(`^/webhooks/${UUID}/rotate-signing-secret$`),
  },
  { version: "2.0", methods: ["GET"], re: new RegExp(`^/webhooks/${UUID}/failed-events$`) },
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
  const entry = ALLOWED.find((a) => a.version === version && a.re.test(req.path));
  if (!entry) throw bad("path");
  if (!entry.methods.includes(req.method)) throw bad("method");
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
