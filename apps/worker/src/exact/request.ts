/**
 * Request validation and URL building for ExactGate. The caller-supplied `path` is untrusted
 * (it may be built from data that came from Exact), so it is checked against a strict allow-list
 * and the final URL is verified to stay on the Exact host under /api/v1 (or the two XML endpoints).
 */
import { ExactApiError, JOB_ID_RE, type ExactRequest } from "@camelthorn/exact";
import { isExactHost } from "./config";

const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
/** OData paths such as /crm/Accounts or /crm/Accounts(guid'...'): no %, ?, #, \, @, :, spaces. */
const PATH_RE = /^\/[A-Za-z0-9_\-./()',]*$/;
const QUERY_KEY_RE = /^[A-Za-z0-9_$.]{1,64}$/;
const XML_PATHS: ReadonlySet<string> = new Set(["/docs/XMLUpload.aspx", "/docs/XMLDownload.aspx"]);
/** Headers a caller may set; Authorization, Host, Cookie and friends are the gate's business. */
const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "accept",
  "prefer",
  "if-match",
  "if-none-match",
]);
const MAX_QUERY_VALUE = 4000;
const MAX_BODY = 5_000_000;

const bad = (code: string): ExactApiError => new ExactApiError(400, "invalid exact request", code);

export function validateRequest(req: ExactRequest): void {
  if (!METHODS.has(req.method)) throw bad("method");
  if (!Number.isSafeInteger(req.division) || req.division < 0) throw bad("division");
  if (req.api !== "rest" && req.api !== "xml") throw bad("api");
  if (req.priority !== "user" && req.priority !== "job") throw bad("priority");
  if (typeof req.jobId !== "string" || !JOB_ID_RE.test(req.jobId)) throw bad("job_id");
  if (typeof req.path !== "string" || req.path.length > 500) throw bad("path");
  if (
    !PATH_RE.test(req.path) ||
    req.path.includes("..") ||
    req.path.includes("//") ||
    req.path.includes("./") // also rejects "/./" and "/.hidden" style segments
  ) {
    throw bad("path");
  }
  if (req.api === "xml") {
    if (!XML_PATHS.has(req.path)) throw bad("path");
    if (req.division < 1) throw bad("division");
  } else if (req.division === 0 && (req.path !== "/Me" || req.method !== "GET")) {
    // Division 0 ("current") exists only for GET /current/Me.
    throw bad("division");
  }
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (!QUERY_KEY_RE.test(k) || typeof v !== "string" || v.length > MAX_QUERY_VALUE) {
      throw bad("query");
    }
    if (k.toLowerCase() === "_division_") throw bad("query");
  }
  for (const k of Object.keys(req.headers ?? {})) {
    if (!ALLOWED_HEADERS.has(k.toLowerCase())) throw bad("header");
  }
  if (req.body !== undefined && (typeof req.body !== "string" || req.body.length > MAX_BODY)) {
    throw bad("body");
  }
}

/** Builds the absolute URL. Throws ExactApiError if the result left the Exact host. */
export function buildUrl(host: string, req: ExactRequest): URL {
  if (!isExactHost(host)) throw new ExactApiError(500, "bad exact host", "host");
  const params = new URLSearchParams(req.query ?? {});
  let url: URL;
  if (req.api === "xml") {
    // Exact's XML interface takes the division as a query parameter, not in the path.
    params.set("_Division_", String(req.division));
    url = new URL(`https://${host}${req.path}`);
  } else {
    const div = req.division === 0 ? "current" : String(req.division);
    url = new URL(`https://${host}/api/v1/${div}${req.path}`);
  }
  url.search = params.toString();
  const okPath =
    req.api === "xml" ? XML_PATHS.has(url.pathname) : url.pathname.startsWith("/api/v1/");
  if (url.protocol !== "https:" || url.host !== host || url.username || url.password || !okPath) {
    throw bad("path");
  }
  return url;
}
