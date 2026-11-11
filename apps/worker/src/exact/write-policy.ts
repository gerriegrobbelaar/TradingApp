/**
 * What the ExactGate lets through besides GET (task M7c, ADR 0044): defence in depth behind the
 * writer's own guard. The gate refuses EVERY non-GET request except two, and those only when
 *  - the job id is exactly `exact-booking` at priority `job`,
 *  - the shape is exact (no extra query, no PUT/DELETE/PATCH, no other XML topic or path),
 *  - the body has the shape our builders produce (a bank entry JSON object with only the known
 *    fields; one eExact document with MatchSets only: no other topic smuggled under this one),
 *  - and, checked by the gate itself at call time (not trusted from the caller), EVERY booking
 *    precondition holds: the switch is on, the verification mark matches the current protocol
 *    version, the Exact connection is active and the Revolut connection decided who creates the
 *    bank entries.
 *
 * Allowed writes: POST REST `/financialtransaction/BankEntries` and the XML upload for topic
 * `MatchSets`. Nothing else, whatever the settings say. Writes are never retried by the gate.
 */
import { EXACT_WRITE_NAMES, type ExactRequest } from "@camelthorn/exact";
import { bookingMayRun, loadBookingState } from "../booking/settings";

/** The only job id that may write. The gate budget and the allow-list use the same literal. */
export const BOOKING_JOB_ID = "exact-booking";

export type WriteRefusal = "write_not_allowed" | "writes_disabled";

/** True for any request that can change data in Exact. Unknown methods count as writes. */
export const isWrite = (req: Pick<ExactRequest, "method">): boolean => req.method !== "GET";

/** Shape check, no I/O: is this one of the two writes the gate could ever allow? */
export function allowedWriteShape(req: ExactRequest): boolean {
  if (req.method !== "POST") return false;
  if (req.priority !== "job" || req.jobId !== BOOKING_JOB_ID) return false;
  if (typeof req.body !== "string" || req.body === "") return false;
  // Only the content headers our writer sets (no method override or anything else).
  if (Object.keys(req.headers ?? {}).some((h) => !WRITE_HEADERS.has(h.toLowerCase()))) return false;
  const query = Object.keys(req.query ?? {});
  if (req.api === "rest") {
    return (
      req.path === EXACT_WRITE_NAMES.rest.bankEntryPath &&
      query.length === 0 &&
      bankEntryBodyShape(req.body)
    );
  }
  if (req.api === "xml") {
    return (
      req.path === EXACT_WRITE_NAMES.xml.uploadPath &&
      query.length === 1 &&
      req.query?.["Topic"] === EXACT_WRITE_NAMES.xml.topic &&
      matchSetBodyShape(req.body)
    );
  }
  return false;
}

const WRITE_HEADERS: ReadonlySet<string> = new Set(["content-type", "accept"]);
const ENTRY_KEYS: ReadonlySet<string> = new Set(Object.values(EXACT_WRITE_NAMES.rest.entry));
const LINE_KEYS: ReadonlySet<string> = new Set(Object.values(EXACT_WRITE_NAMES.rest.line));
const MAX_LINES = 50;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A JSON object with only bank entry fields, and 1..50 lines with only line fields. */
export function bankEntryBodyShape(body: string): boolean {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return false;
  }
  if (!isPlainObject(v)) return false;
  if (Object.keys(v).some((k) => !ENTRY_KEYS.has(k))) return false;
  const lines = v[EXACT_WRITE_NAMES.rest.entry.lines];
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES) return false;
  return lines.every((l) => isPlainObject(l) && Object.keys(l).every((k) => LINE_KEYS.has(k)));
}

/**
 * Exactly the envelope our builder writes around ONE `<MatchSets>` element whose children are
 * `<MatchSet>` elements only: no DOCTYPE, entity, processing instruction, CDATA or comment, no
 * second topic in the document.
 */
export function matchSetBodyShape(body: string): boolean {
  const x = EXACT_WRITE_NAMES.xml;
  const head = /^<\?xml version="1\.0" encoding="utf-8"\?>\n<eExact(?: [^<>]*)?>/;
  const m = head.exec(body);
  if (m === null) return false;
  if (/<!|<\?|\]\]>/.test(body.slice(m[0].length))) return false;
  const inner = body.slice(m[0].length);
  const open = `<${x.topic}>`;
  const close = `</${x.topic}></eExact>`;
  if (!inner.startsWith(open) || !inner.endsWith(close)) return false;
  const sets = inner.slice(open.length, inner.length - close.length);
  if (sets.includes(`<${x.topic}`) || sets.includes("<eExact") || sets.includes("</eExact")) {
    return false;
  }
  // Remove each <MatchSet>...</MatchSet>: nothing may be left between them.
  const rest = sets.split(`</${x.matchSet}>`);
  if (rest.pop() !== "") return false;
  return (
    rest.length > 0 &&
    rest.every((r) => r.startsWith(`<${x.matchSet}>`) && !r.slice(1).includes(`<${x.matchSet}>`))
  );
}

/**
 * Full decision for a write: shape first (cheap, no I/O), then the switch and the verification
 * mark from D1 right now. `null` = allowed.
 */
export async function refuseWrite(db: D1Database, req: ExactRequest): Promise<WriteRefusal | null> {
  if (!allowedWriteShape(req)) return "write_not_allowed";
  const state = await loadBookingState(db).catch(() => null);
  if (state === null || !bookingMayRun(state)) return "writes_disabled";
  return null;
}

/** Reads never need the switch, but only GET may pass without it: this is the GET-side shape rule. */
export function allowedReadShape(req: ExactRequest): boolean {
  if (req.method !== "GET") return false;
  // The XML upload endpoint takes no GET: it exists for MatchSets only, behind the write rules.
  if (req.api === "xml" && req.path === EXACT_WRITE_NAMES.xml.uploadPath) return false;
  return true;
}
