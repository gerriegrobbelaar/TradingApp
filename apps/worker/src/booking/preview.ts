/**
 * Booking PREVIEW, a dry run (Phase 7 review S8, ADR 0044 `preview_matches_manual_payload`).
 *
 * For up to three matches it runs the READ-ONLY steps the executor runs before any write (probe,
 * journal balance, item read-back) and then builds the REAL bank entry body and MatchSet XML with
 * the REAL builders. It returns the bodies and their hashes so an admin can compare them with what
 * was posted by hand (curl) on the test division. It cannot write:
 *  - its writer is created with `writeEnabled: false` (the writer refuses every POST), and
 *  - its calls carry the job id `exact-booking-preview` at priority `user`, which the ExactGate
 *    accepts for GET only (exact/write-policy.ts), whatever the booking switch says.
 * It stores nothing: no outbox row, no state change, no idempotency key. One audit row with match
 * ids and hashes (no bodies) is written.
 */
import { sha256Hex } from "@camelthorn/core";
import {
  buildBankEntryPayload,
  createExactWriter,
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  type ExactTransport,
  type ExactWriter,
} from "@camelthorn/exact";
import type { BookingPreviewItem, BookingPreviewResponse } from "@camelthorn/core";
import { auditStatement } from "../db/audit";
import type { Env } from "../env";
import { createGateTransport } from "../exact/gate-transport";
import { BOOKING_PREVIEW_JOB_ID } from "../exact/write-policy";
import { loadCandidateForPreview } from "./executor";
import { buildMatchsetFromPlan, modeDeferral, planMatch, type Candidate } from "./plan";
import { preflightFromVerdict, type Preflight } from "./preflight";
import { readItemsBack } from "./readback";
import { loadBookingState } from "./settings";

/** A body longer than this is not returned (the compare is meant for single matches). */
export const PREVIEW_BODY_CAP = 20_000;
export const PREVIEW_MAX_MATCHES = 3;
/** The bank line number used in the MatchSet XML while the line is not in Exact yet. */
export const PREVIEW_PLACEHOLDER_ENTRY_NUMBER = 999_999_999;

type TransportFor = (env: Pick<Env, "EXACT_GATE">, exactDivision: number) => ExactTransport;
let transportFor: TransportFor = createGateTransport;

/** TEST SEAM: replaces the gate transport of the preview (the real one always goes via the gate). */
export function setPreviewTransportForTests(fn: TransportFor | undefined): void {
  transportFor = fn ?? createGateTransport;
}

function readErrorCode(e: unknown): string {
  if (e instanceof ExactRateLimitedError) return "rate_limited";
  if (e instanceof ExactAuthError) return "exact_auth";
  if (e instanceof ExactBudgetExhaustedError) return "gate_budget";
  if (e instanceof ExactApiError && e.code !== undefined && /^[a-z0-9_]{1,40}$/.test(e.code)) {
    return e.code;
  }
  return "read_failed";
}

const empty = (matchId: number, wouldDefer: string | null): BookingPreviewItem => ({
  matchId,
  mode: null,
  wouldDefer: wouldDefer === null ? null : { code: wouldDefer },
  bankEntryBody: null,
  matchSetXml: null,
  bankEntryHash: null,
  matchSetHash: null,
  matchSetBankLinePlaceholder: false,
  reads: {
    probeHits: null,
    closingBalanceMinor: null,
    openingBalanceSource: null,
    preflight: null,
    readError: null,
  },
});

/** Why a match is not even a candidate (the loader found nothing). */
async function notBookableCode(db: D1Database, matchId: number): Promise<string> {
  const m = await db
    .prepare(
      `SELECT m.undone_at, m.exact_state, m.review_reason, t.is_final, t.state, t.state_conflict
       FROM matches m JOIN bank_transactions t ON t.id = m.bank_transaction_id WHERE m.id = ?1`,
    )
    .bind(matchId)
    .first<{
      undone_at: string | null;
      exact_state: string;
      review_reason: string | null;
      is_final: number;
      state: string;
      state_conflict: number;
    }>();
  if (m === null) return "match_not_found";
  if (m.undone_at !== null) return "match_undone";
  if (m.exact_state !== "not_booked") return "match_already_claimed";
  if (m.review_reason !== null) return "match_flagged";
  if (m.is_final !== 1 || m.state !== "completed" || m.state_conflict !== 0) return "tx_not_final";
  return "match_not_bookable";
}

async function previewOne(
  env: Pick<Env, "EXACT_GATE">,
  db: D1Database,
  matchId: number,
  createsBankEntries: boolean | null,
  nowMs: number,
): Promise<BookingPreviewItem> {
  const cand: Candidate | null = await loadCandidateForPreview(db, matchId);
  if (cand === null) return empty(matchId, await notBookableCode(db, matchId));
  if (createsBankEntries === null) return empty(matchId, "bank_entries_undecided");
  const item = empty(matchId, null);

  let wouldDefer: string | null = modeDeferral(cand, createsBankEntries);
  const plan = planMatch(cand);
  if (!plan.ok) {
    return { ...item, wouldDefer: { code: wouldDefer ?? plan.code } };
  }
  item.mode = plan.mode;
  if (plan.mode === "ledger" && !createsBankEntries) {
    // The feed owns the bank line: the executor books nothing for a ledger match here.
    return { ...item, wouldDefer: { code: wouldDefer ?? "ledger_booking_with_feed_manual" } };
  }

  const writer: ExactWriter = createExactWriter(transportFor(env, cand.exactDivision), {
    // A preview can never write: the writer refuses every POST, and the gate refuses this job id.
    writeEnabled: false,
    division: cand.exactDivision,
    jobId: BOOKING_PREVIEW_JOB_ID,
    priority: "user",
    now: () => nowMs,
  });
  const reads = item.reads;
  let bankEntryNumber: number = PREVIEW_PLACEHOLDER_ENTRY_NUMBER;
  let placeholder = true;

  try {
    if (createsBankEntries) {
      let opening: number | null = null;
      try {
        const balance = await writer.readLatestClosingBalance({
          journalCode: cand.map.journalCode,
          currency: cand.currency,
        });
        reads.closingBalanceMinor = balance;
        if (balance !== null) {
          opening = balance;
          reads.openingBalanceSource = "exact";
        } else if (
          cand.map.openingBalanceMinor !== null &&
          Number.isSafeInteger(cand.map.openingBalanceMinor)
        ) {
          opening = cand.map.openingBalanceMinor;
          reads.openingBalanceSource = "admin_opening_balance";
        } else {
          wouldDefer ??= "bank_balance_unknown";
        }
      } catch (e) {
        reads.readError = readErrorCode(e);
      }
      if (opening !== null) {
        const input = {
          ...plan.bankEntry,
          openingBalanceMinor: opening,
          closingBalanceMinor: opening + cand.tx.amountMinor,
        };
        const built = buildBankEntryPayload(input);
        if (!built.ok) {
          wouldDefer ??= `build_${built.error}`;
        } else {
          if (built.body.length <= PREVIEW_BODY_CAP) {
            item.bankEntryBody = built.body;
            item.bankEntryHash = sha256Hex(built.body);
          } else {
            reads.readError = "body_too_large";
          }
          try {
            reads.probeHits = (
              await writer.findBankEntryLineByRef({
                journalCode: cand.map.journalCode,
                yourRef: built.yourRefs[0] ?? "",
              })
            ).length;
          } catch (e) {
            reads.readError ??= readErrorCode(e);
          }
        }
      }
    } else if (/^[A-Za-z0-9_-]{1,64}$/.test(cand.tx.externalId)) {
      // Feed mode: the bank line is created by Revolut's own Exact integration. Show whether it is there.
      try {
        const hits = await writer.findBankEntryLineByRef({
          journalCode: cand.map.journalCode,
          yourRef: cand.tx.externalId,
        });
        reads.probeHits = hits.length;
        const one = hits.length === 1 ? hits[0] : undefined;
        if (one !== undefined && one.entryNumber !== null) {
          bankEntryNumber = one.entryNumber;
          placeholder = false;
        }
      } catch (e) {
        reads.readError = readErrorCode(e);
      }
    }

    if (plan.mode === "matched") {
      try {
        const pf: Preflight = preflightFromVerdict(await readItemsBack(writer, plan.matchset));
        reads.preflight = pf;
        if (pf !== "open_as_expected") wouldDefer ??= `preflight_${pf}`;
      } catch (e) {
        reads.readError ??= readErrorCode(e);
      }
      const xml = buildMatchsetFromPlan({ ...plan.matchset, bankEntryNumber });
      if (xml.ok) {
        if (xml.built.xml.length <= PREVIEW_BODY_CAP) {
          item.matchSetXml = xml.built.xml;
          item.matchSetHash = xml.hash;
          item.matchSetBankLinePlaceholder = placeholder;
        } else {
          reads.readError ??= "body_too_large";
        }
      } else {
        wouldDefer ??= `build_${xml.code}`;
      }
    }
  } catch (e) {
    reads.readError ??= readErrorCode(e);
  }
  // `wouldDefer` also names the refusals of v1 (a rule, not a configuration gap): same field.
  item.wouldDefer = wouldDefer === null ? null : { code: wouldDefer };
  return item;
}

/** The dry run for 1 to 3 matches; one audit row with ids and hashes only. Nothing else is written. */
export async function runPreview(
  env: Pick<Env, "EXACT_GATE">,
  db: D1Database,
  matchIds: readonly number[],
  actorEmail: string,
  nowMs: number,
): Promise<BookingPreviewResponse> {
  const state = await loadBookingState(db);
  const items: BookingPreviewItem[] = [];
  for (const id of matchIds) {
    items.push(await previewOne(env, db, id, state.createsBankEntries, nowMs));
  }
  await db.batch([
    auditStatement(db, {
      actorEmail,
      action: "booking.preview",
      entity: "match",
      entityId: matchIds.join(","),
      after: {
        matchIds: [...matchIds],
        hashes: items.map((i) => ({
          matchId: i.matchId,
          bankEntryHash: i.bankEntryHash,
          matchSetHash: i.matchSetHash,
          wouldDefer: i.wouldDefer?.code ?? null,
        })),
      },
    }),
  ]);
  return { items };
}
