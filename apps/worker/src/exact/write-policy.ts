/**
 * What the ExactGate lets through besides GET (task M7c, ADR 0043): defence in depth behind the
 * writer's own guard. The gate refuses EVERY non-GET request except two, and those only when
 *  - the job id is exactly `exact-booking` at priority `job`,
 *  - the shape is exact (no extra query, no PUT/DELETE/PATCH, no other XML topic or path),
 *  - and, checked by the gate itself at call time (not trusted from the caller), the fail-closed
 *    switch is on and the verification mark matches the current protocol version.
 *
 * Allowed writes: POST REST `/financialtransaction/BankEntries` and the XML upload for topic
 * `MatchSets`. Nothing else, whatever the settings say. Writes are never retried by the gate.
 */
import { EXACT_WRITE_NAMES, type ExactRequest } from "@camelthorn/exact";
import { loadBookingState, writesPermitted } from "../booking/settings";

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
  const query = Object.keys(req.query ?? {});
  if (req.api === "rest") {
    return req.path === EXACT_WRITE_NAMES.rest.bankEntryPath && query.length === 0;
  }
  if (req.api === "xml") {
    return (
      req.path === EXACT_WRITE_NAMES.xml.uploadPath &&
      query.length === 1 &&
      req.query?.["Topic"] === EXACT_WRITE_NAMES.xml.topic
    );
  }
  return false;
}

/**
 * Full decision for a write: shape first (cheap, no I/O), then the switch and the verification
 * mark from D1 right now. `null` = allowed.
 */
export async function refuseWrite(db: D1Database, req: ExactRequest): Promise<WriteRefusal | null> {
  if (!allowedWriteShape(req)) return "write_not_allowed";
  const state = await loadBookingState(db).catch(() => null);
  if (state === null || !writesPermitted(state)) return "writes_disabled";
  return null;
}

/** Reads never need the switch, but only GET may pass without it: this is the GET-side shape rule. */
export function allowedReadShape(req: ExactRequest): boolean {
  if (req.method !== "GET") return false;
  // The XML upload endpoint takes no GET: it exists for MatchSets only, behind the write rules.
  if (req.api === "xml" && req.path === EXACT_WRITE_NAMES.xml.uploadPath) return false;
  return true;
}
