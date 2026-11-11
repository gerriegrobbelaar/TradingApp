/**
 * The booking executor, job `exact.book_matches` (task M7c, ADR 0043; handler contract ADR 0021).
 *
 * Writes the matches of the review queue to Exact: a bank entry (REST, unless Revolut's own Exact
 * feed already created the line) and then a MatchSet (XML), verified by reading Exact back. Every
 * write goes through the ExactGate with job id `exact-booking`, which refuses it unless the
 * fail-closed switch and the verification mark say so (checked again here, before every POST).
 *
 * Rules that hold everywhere in this file:
 *  - The outbox row (full payload, idempotency key) is written in the batch that claims the match,
 *    BEFORE any network call; `sending` is stored before the POST.
 *  - Before every POST of a bank entry the line is probed by its YourRef; before every POST of a
 *    MatchSet the items are read back. A POST is NEVER repeated blindly: after a thrown error, a
 *    timeout, a 5xx or an unreadable answer the row is `outcome_unknown` and only an admin `retry`
 *    (which makes the next run probe first) can move it on.
 *  - Every state change is audited in the same batch (actor `system`), codes and counts only.
 */
import { amsterdamParts, sha256Hex } from "@camelthorn/core";
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  ExactWriteAuthRetryRefused,
  ExactWriteDisabledError,
  ExactWritePayloadError,
  buildBankEntryPayload,
  createExactWriter,
  verifyMatchSetApplied,
  type BankEntryLineHit,
  type ExactTransport,
  type ExactWriter,
  type ReadBackVerdict,
} from "@camelthorn/exact";
import { getExactGate, createGateTransport, gateName } from "../exact/gate-transport";
import { BOOKING_JOB_ID } from "../exact/write-policy";
import type { HandlerResult, JobContext } from "../jobs/types";
import { bookingMayRun, blockersOf, loadBookingState, writesPermitted } from "./settings";
import {
  claimAndEnqueue,
  completeKeyStatement,
  GUARD,
  leaseRow,
  OUTBOX_COLUMNS,
  safeCode,
  transition,
  type OutboxRow,
  type OutboxStatus,
  type Transition,
} from "./outbox";
import {
  buildMatchsetFromPlan,
  type Candidate,
  type CandidateItem,
  type MatchsetPlanInput,
  asBankEntryDoc,
  asMatchsetDoc,
  parseDoc,
  type MatchsetDoc,
  planFailureKey,
  planMatch,
  rebuildBankEntry,
  rebuildMatchset,
  serializeDoc,
  type BankEntryDoc,
} from "./plan";

export const MAX_MATCHES_PER_RUN = 10;
export const MAX_CALLS_PER_RUN = 30;
/** Calls this job may spend in any 24 hours (all administrations together): see dailyExactCallCap. */
export const DAILY_BOOKING_CALL_CAP = 400;
/** A match must be at least this old before it is booked: the window in which Undo is easy. */
export const BOOKING_DELAY_MS = 10 * 60_000;
export const MAX_AUTO_RETRIES = 3;
const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 3600_000];
export const WAIT_FOR_LINE_MS = 48 * 3600_000;
/** An answer we accepted but could not verify for this long becomes `outcome_unknown`. */
export const UNVERIFIED_MAX_MS = 6 * 3600_000;
const ROW_LIMIT = 20;
const DAY_MS = 24 * 3600_000;

/** Ends the whole run (budget, deadline, switch off, gate or connection trouble). */
export class RunStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RunStop";
  }
}

// ---------------------------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------------------------

export type WriteFailure =
  /** Provably nothing was sent (the gate or the writer refused before the call). */
  | { kind: "not_sent"; code: string }
  /** Exact (or the gate's queue) answered 429. Not applied; probe before sending again. */
  | { kind: "rate_limited" }
  /** Exact answered with a definite 4xx: our payload was refused. Repeating it is pointless. */
  | { kind: "rejected"; code: string }
  /** Anything else after the call was made: timeout, 5xx, lost or unreadable answer, 401. */
  | { kind: "unknown"; code: string };

const NOT_SENT_GATE_CODES: ReadonlySet<string> = new Set([
  "writes_disabled",
  "write_not_allowed",
  "method",
  "division",
  "api",
  "priority",
  "job_id",
  "path",
  "query",
  "header",
  "body",
  "division_mismatch",
  "host",
  "token_refresh_retry",
  "wrong_token_authority",
  "not_connected",
  "needs_reauth",
]);

export function classifyWriteError(e: unknown): WriteFailure {
  if (e instanceof RunStop) return { kind: "not_sent", code: e.code };
  if (e instanceof ExactBudgetExhaustedError) return { kind: "not_sent", code: "gate_budget" };
  if (e instanceof ExactWriteDisabledError) return { kind: "not_sent", code: "writes_disabled" };
  if (e instanceof ExactWritePayloadError) return { kind: "rejected", code: "payload_refused" };
  if (e instanceof ExactAuthError) return { kind: "not_sent", code: "exact_auth" };
  if (e instanceof ExactWriteAuthRetryRefused)
    return { kind: "unknown", code: "auth_retry_refused" };
  if (e instanceof ExactRateLimitedError) return { kind: "rate_limited" };
  if (e instanceof ExactApiError) {
    if (e.code !== undefined) {
      return NOT_SENT_GATE_CODES.has(e.code)
        ? { kind: "not_sent", code: e.code }
        : { kind: "unknown", code: e.code === "network" ? "network" : "gate_error" };
    }
    // A real HTTP answer from Exact (the writer throws these for non-2xx).
    if (e.status >= 400 && e.status < 500 && e.status !== 408) {
      return { kind: "rejected", code: `exact_rejected_${e.status}` };
    }
    return { kind: "unknown", code: `exact_http_${e.status}` };
  }
  return { kind: "unknown", code: "write_error" };
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

interface CandidateSql {
  match_id: number;
  division_id: number;
  source: "auto" | "manual" | "ledger";
  ledger_account_code: string | null;
  amount_minor: number;
  currency: string;
  tx_id: number;
  external_id: string;
  connection_id: number;
  tx_amount: number;
  booked_at: string;
  counterparty_name: string | null;
  reference: string | null;
  description: string | null;
  journal_code: string;
  receivable_gl_account_code: string | null;
  payable_gl_account_code: string | null;
  exact_division: number;
  base_currency: string;
  ledger_gl_id: string | null;
}

interface ItemSql {
  id: number;
  exact_id: string;
  kind: "invoice" | "bill";
  relation_id: string | null;
  relation_code: string | null;
  entry_number: number | null;
  open_minor: number;
  allocated_minor: number;
  currency: string;
  status: string;
  invoice_number: string | null;
}

async function loadCandidates(
  db: D1Database,
  cutoffIso: string,
  limit: number,
): Promise<Candidate[]> {
  const rows = (
    await db
      .prepare(
        `SELECT m.id AS match_id, m.division_id, m.source, m.ledger_account_code, m.amount_minor, m.currency,
                t.id AS tx_id, t.external_id, t.connection_id, t.amount_minor AS tx_amount, t.booked_at,
                t.counterparty_name, t.reference, t.description,
                mp.journal_code, mp.receivable_gl_account_code, mp.payable_gl_account_code,
                d.exact_division, d.base_currency,
                (SELECT g.exact_id FROM gl_accounts g WHERE g.division_id = m.division_id
                    AND TRIM(g.code) = m.ledger_account_code AND g.is_active = 1 LIMIT 1) AS ledger_gl_id
         FROM matches m
           JOIN bank_transactions t ON t.id = m.bank_transaction_id
           JOIN bank_account_exact_map mp ON mp.bank_account_id = t.bank_account_id
                                         AND mp.division_id = m.division_id
           JOIN divisions d ON d.id = m.division_id AND d.sync_enabled = 1
           JOIN connections c ON c.id = d.connection_id AND c.status = 'active'
         WHERE m.undone_at IS NULL AND m.exact_state = 'not_booked' AND m.review_reason IS NULL
           AND m.created_at <= ?1 AND t.is_final = 1 AND t.state = 'completed' AND t.state_conflict = 0
         ORDER BY m.created_at, m.id LIMIT ?2`,
      )
      .bind(cutoffIso, limit)
      .all<CandidateSql>()
  ).results;
  const out: Candidate[] = [];
  for (const r of rows) {
    const items = (
      await db
        .prepare(
          `SELECT oi.id, oi.exact_id, oi.kind, oi.relation_id, oi.entry_number, oi.open_minor, oi.currency,
                  oi.status, oi.invoice_number, a.allocated_minor,
                  (SELECT rel.code FROM relations rel WHERE rel.division_id = oi.division_id
                      AND rel.exact_id = oi.relation_id) AS relation_code
           FROM match_allocations a JOIN open_items oi ON oi.id = a.open_item_id
           WHERE a.match_id = ?1 ORDER BY oi.id`,
        )
        .bind(r.match_id)
        .all<ItemSql>()
    ).results;
    out.push({
      matchId: r.match_id,
      divisionId: r.division_id,
      exactDivision: r.exact_division,
      baseCurrency: r.base_currency,
      source: r.source,
      ledgerAccountCode: r.ledger_account_code,
      ledgerGlId: r.ledger_gl_id,
      currency: r.currency,
      tx: {
        id: r.tx_id,
        externalId: r.external_id,
        connectionId: r.connection_id,
        amountMinor: r.tx_amount,
        bookedAt: r.booked_at,
        counterpartyName: r.counterparty_name,
        reference: r.reference,
        description: r.description,
      },
      map: {
        journalCode: r.journal_code,
        receivableGl: r.receivable_gl_account_code,
        payableGl: r.payable_gl_account_code,
      },
      items: items.map((i): CandidateItem => ({
        id: i.id,
        exactId: i.exact_id,
        kind: i.kind,
        relationId: i.relation_id,
        relationCode: i.relation_code,
        entryNumber: i.entry_number,
        openMinor: i.open_minor,
        allocatedMinor: i.allocated_minor,
        currency: i.currency,
        status: i.status,
        invoiceNumber: i.invoice_number,
      })),
    });
  }
  return out;
}

interface WorkRow extends OutboxRow {
  exact_state: string;
  undone_at: string | null;
  tx_id: number;
  tx_external_id: string;
  tx_amount: number;
  tx_currency: string;
  tx_booked_at: string;
  tx_account_id: number;
  exact_division: number;
  map_journal: string | null;
}

const WORK_SELECT = `SELECT ${OUTBOX_COLUMNS.split(",")
  .map((c) => `o.${c.trim()}`)
  .join(", ")},
       m.exact_state, m.undone_at, t.id AS tx_id, t.external_id AS tx_external_id,
       t.amount_minor AS tx_amount, t.currency AS tx_currency, t.booked_at AS tx_booked_at,
       t.bank_account_id AS tx_account_id, d.exact_division, mp.journal_code AS map_journal
     FROM exact_write_outbox o
       JOIN matches m ON m.id = o.match_id
       JOIN bank_transactions t ON t.id = m.bank_transaction_id
       JOIN divisions d ON d.id = o.division_id
       LEFT JOIN bank_account_exact_map mp ON mp.bank_account_id = t.bank_account_id`;

async function loadWork(db: D1Database, id: number): Promise<WorkRow | null> {
  return db.prepare(`${WORK_SELECT} WHERE o.id = ?1`).bind(id).first<WorkRow>();
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

interface Counters {
  claimed: number;
  verified: number;
  failed: number;
  outcomeUnknown: number;
  manualRequired: number;
  waiting: number;
  deferred: number;
  reverted: number;
}

interface DivisionRuntime {
  writer: ExactWriter;
  endJob: () => Promise<void>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export async function runBookMatches(ctx: JobContext): Promise<HandlerResult> {
  const { env } = ctx;
  const db = env.DB;
  const deps = ctx.syncDeps ?? {};
  const clock = deps.now ?? ctx.now;

  // Fail closed, and again inside the handler (the gate re-checks on every write as well).
  const state0 = await loadBookingState(db);
  if (!bookingMayRun(state0)) {
    return {
      status: "skipped",
      code: "booking_disabled",
      summary: { blockers: blockersOf(state0) },
      callsUsed: 0,
    };
  }
  const createsBankEntries = state0.createsBankEntries === true;
  // A daily cap of its own (the budget projection of the schedules relies on it): calls of the last
  // 24 hours of this job, finished runs only.
  const usedToday =
    (
      await db
        .prepare(
          "SELECT COALESCE(SUM(calls_used), 0) AS n FROM job_runs WHERE job_id = ?1 AND started_at >= ?2",
        )
        .bind(ctx.job.id, iso(clock() - DAY_MS))
        .first<{ n: number }>()
    )?.n ?? 0;
  const remainingToday = DAILY_BOOKING_CALL_CAP - usedToday;
  if (remainingToday <= 0) {
    return {
      status: "skipped",
      code: "daily_cap_reached",
      summary: { used: usedToday },
      callsUsed: 0,
    };
  }
  const budget = Math.min(
    ctx.budget > 0 ? ctx.budget : MAX_CALLS_PER_RUN,
    MAX_CALLS_PER_RUN,
    remainingToday,
  );

  const counters: Counters = {
    claimed: 0,
    verified: 0,
    failed: 0,
    outcomeUnknown: 0,
    manualRequired: 0,
    waiting: 0,
    deferred: 0,
    reverted: 0,
  };
  let calls = 0;
  let stop: string | null = null;
  const divisions = new Map<number, DivisionRuntime>();

  const nowMs = (): number => clock();
  const nowIso = (): string => iso(nowMs());

  async function division(divisionId: number, exactDivision: number): Promise<DivisionRuntime> {
    const known = divisions.get(divisionId);
    if (known) return known;
    const base: ExactTransport = deps.transport ?? createGateTransport(env, exactDivision);
    const gate =
      deps.gate ??
      (() => {
        const stub = getExactGate(env, gateName(exactDivision));
        return {
          startJob: (id: string, b?: number) => stub.startJob(id, b),
          endJob: (id: string) => stub.endJob(id),
        };
      })();
    try {
      await gate.startJob(BOOKING_JOB_ID, budget);
    } catch {
      throw new RunStop("gate_unavailable");
    }
    const transport: ExactTransport = async (req) => {
      if (ctx.signal.aborted || nowMs() >= ctx.deadlineMs) throw new RunStop("time_limit");
      if (calls >= budget) throw new RunStop("call_budget");
      calls++;
      return base(req);
    };
    const writer = createExactWriter(transport, {
      writeEnabled: writesPermitted(state0),
      division: exactDivision,
      jobId: BOOKING_JOB_ID,
      priority: "job",
      now: nowMs,
    });
    const rt: DivisionRuntime = {
      writer,
      endJob: async () => {
        await gate.endJob(BOOKING_JOB_ID).catch(() => undefined);
      },
    };
    divisions.set(divisionId, rt);
    return rt;
  }

  /** The switch is re-read right before every POST: turning it off mid-run stops the writes. */
  async function assertStillEnabled(): Promise<void> {
    const s = await loadBookingState(db);
    if (!bookingMayRun(s)) throw new RunStop("writes_disabled");
  }

  async function note(
    w: WorkRow,
    token: string,
    t: Omit<Transition, "rowId" | "matchId" | "token" | "nowIso" | "actor" | "from"> & {
      from?: readonly OutboxStatus[];
    },
  ): Promise<boolean> {
    return transition(db, {
      ...t,
      rowId: w.id,
      matchId: w.match_id,
      from: t.from ?? [w.status],
      token,
      nowIso: nowIso(),
      actor: "system",
    });
  }

  /** Reads that fail for transient reasons leave the row alone; auth and run-level stops end the run. */
  async function readOr<T>(
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof RunStop) throw e;
      if (e instanceof ExactAuthError) throw new RunStop("exact_auth");
      if (e instanceof ExactBudgetExhaustedError) throw new RunStop("gate_budget");
      if (e instanceof ExactApiError && e.code === "writes_disabled")
        throw new RunStop("writes_disabled");
      return {
        ok: false,
        code: e instanceof ExactRateLimitedError ? "rate_limited" : "read_failed",
      };
    }
  }

  // -- helpers shared by the two row kinds --------------------------------------------------------

  function count(key: keyof Counters): void {
    counters[key]++;
  }

  async function giveUpToManual(
    w: WorkRow,
    token: string,
    code: string,
    from?: readonly OutboxStatus[],
  ): Promise<void> {
    const ok = await note(w, token, {
      ...(from !== undefined ? { from } : {}),
      to: "manual_required",
      errorCode: code,
      needsProbe: false,
      match: { from: w.exact_state, to: "manual_required", note: code },
      action: "booking.manual_required",
      audit: { code, kind: w.kind },
    });
    if (ok) count("manualRequired");
  }

  async function applyFailure(w: WorkRow, token: string, f: WriteFailure): Promise<void> {
    if (f.kind === "not_sent") {
      await note(w, token, {
        from: ["sending"],
        to: "pending",
        errorCode: f.code,
        attemptsDelta: -1,
        action: "booking.not_sent",
        audit: { code: f.code, kind: w.kind },
      });
      count("reverted");
      throw f.code === "writes_disabled" ||
        f.code === "call_budget" ||
        f.code === "time_limit" ||
        f.code === "gate_unavailable" ||
        f.code === "exact_auth"
        ? new RunStop(f.code)
        : new RunStop("write_not_sent");
    }
    if (f.kind === "rate_limited") {
      await note(w, token, {
        from: ["sending"],
        to: "pending",
        errorCode: "rate_limited",
        needsProbe: true,
        nextAttemptAt: iso(nowMs() + RETRY_BACKOFF_MS[0]!),
        action: "booking.rate_limited",
        audit: { kind: w.kind },
      });
      count("reverted");
      return;
    }
    if (f.kind === "rejected") {
      const ok = await note(w, token, {
        from: ["sending"],
        to: "failed",
        errorCode: f.code,
        // A definite refusal is not retried automatically: the same payload would be refused again.
        nextAttemptAt: null,
        match: { from: w.exact_state, to: "booking_failed", note: f.code },
        action: "booking.failed",
        audit: { code: f.code, kind: w.kind },
      });
      if (ok) count("failed");
      return;
    }
    const ok = await note(w, token, {
      from: ["sending"],
      to: "outcome_unknown",
      errorCode: f.code,
      needsProbe: true,
      match: { from: w.exact_state, to: "outcome_unknown", note: f.code },
      action: "booking.outcome_unknown",
      audit: { code: f.code, kind: w.kind },
    });
    if (ok) count("outcomeUnknown");
  }

  /** Reads the items of a MatchSet back from Exact (one or two calls). */
  async function readBack(rt: DivisionRuntime, p: MatchsetPlanInput): Promise<ReadBackVerdict> {
    const expected = p.items.map((i) => ({
      entryNumber: i.entryNumber,
      currency: p.currency,
      openBeforeMinor: i.openBeforeMinor,
    }));
    const numbers = p.items.map((i) => i.entryNumber);
    const primary = await rt.writer.readOpenItemLines({
      kind: p.kind,
      accountId: p.relationId,
      entryNumbers: numbers,
    });
    const absent = numbers.filter((n) => !primary.some((r) => r.entryNumber === n));
    const fullyPaid =
      absent.length > 0
        ? await rt.writer.readOpenItemLines({
            kind: p.kind,
            accountId: p.relationId,
            entryNumbers: absent,
            fullyPaidOnly: true,
          })
        : undefined;
    return verifyMatchSetApplied(primary, expected, fullyPaid);
  }

  /** The matchset row is verified: both rows are done and the match is booked. */
  async function finishMatchset(w: WorkRow, token: string, via: string): Promise<void> {
    const at = nowIso();
    const ok = await note(w, token, {
      from: [
        "pending",
        "sending",
        "sent_unverified",
        "failed",
        "outcome_unknown",
        "waiting_for_bank_line",
      ],
      to: "verified",
      errorCode: null,
      needsProbe: false,
      nextAttemptAt: null,
      match: { from: w.exact_state, to: "matched_in_exact", note: null, bookedAt: at },
      action: "booking.matched",
      audit: { via, kind: w.kind },
      after: (d) => [completeKeyStatement(d, "matchset", w.idempotency_key, via, at)],
    });
    if (ok) count("verified");
  }

  // -- bank entry row ------------------------------------------------------------------------------

  async function verifiedBankEntry(
    w: WorkRow,
    token: string,
    doc: BankEntryDoc,
    hit: { entryId: string | null; entryNumber: number | null },
    via: string,
  ): Promise<void> {
    const at = nowIso();
    const ref = hit.entryNumber !== null ? String(hit.entryNumber) : hit.entryId;
    const txUpdate = (d: D1Database): D1PreparedStatement =>
      d
        .prepare(
          `UPDATE bank_transactions SET exact_entry_id = ?2 WHERE id = ?1 AND ?2 IS NOT NULL AND ${GUARD}`,
        )
        .bind(w.tx_id, hit.entryId);
    const fromStates = [
      "pending",
      "sending",
      "sent_unverified",
      "failed",
      "outcome_unknown",
    ] as const;
    if (doc.then === null) {
      // A ledger match: the bank entry IS the booking.
      const ok = await note(w, token, {
        from: fromStates,
        to: "verified",
        exactRef: ref,
        errorCode: null,
        needsProbe: false,
        nextAttemptAt: null,
        match: { from: w.exact_state, to: "matched_in_exact", note: null, bookedAt: at },
        action: "booking.matched",
        audit: { via, kind: w.kind },
        after: (d) => [
          txUpdate(d),
          completeKeyStatement(d, "bank_entry", w.idempotency_key, via, at),
        ],
      });
      if (ok) count("verified");
      return;
    }
    if (hit.entryNumber === null) {
      // The bank line exists but we cannot name it in a MatchSet: a person matches it in Exact.
      const ok = await note(w, token, {
        from: fromStates,
        to: "verified",
        exactRef: ref,
        errorCode: "bank_entry_number_unknown",
        needsProbe: false,
        nextAttemptAt: null,
        match: { from: w.exact_state, to: "manual_required", note: "bank_entry_number_unknown" },
        action: "booking.manual_required",
        audit: { via, kind: w.kind, code: "bank_entry_number_unknown" },
        after: (d) => [
          txUpdate(d),
          completeKeyStatement(d, "bank_entry", w.idempotency_key, via, at),
        ],
      });
      if (ok) count("manualRequired");
      return;
    }
    // The bank line exists: store the full MatchSet row (payload and key) in the same batch, so it
    // is on disk before the MatchSet is ever sent.
    const nextKey = doc.then.matchsetKey;
    const plan: MatchsetPlanInput = { ...doc.then.matchset, bankEntryNumber: hit.entryNumber };
    const built = buildMatchsetFromPlan(plan);
    if (!built.ok) {
      await giveUpToManual(w, token, built.code, fromStates);
      return;
    }
    const msDoc = serializeDoc({
      v: 1,
      stage: "built",
      kind: "matchset",
      input: plan,
      builtHash: built.hash,
    });
    const ok = await note(w, token, {
      from: fromStates,
      to: "verified",
      exactRef: ref,
      errorCode: null,
      needsProbe: false,
      nextAttemptAt: null,
      match: { from: w.exact_state, to: "bank_entry_created", note: null },
      action: "booking.bank_entry_verified",
      audit: { via, kind: w.kind },
      after: (d) => [
        d
          .prepare(
            `INSERT INTO exact_write_outbox (match_id, division_id, journal_code, kind, idempotency_key,
               payload_json, payload_hash, status, needs_probe, created_at, updated_at)
             SELECT ?1, ?2, NULL, 'matchset', ?3, ?4, ?5, 'pending', 0, ?6, ?6 WHERE ${GUARD}`,
          )
          .bind(w.match_id, w.division_id, nextKey, msDoc.json, msDoc.hash, at),
        d
          .prepare(
            `INSERT INTO idempotency_keys (scope, key) SELECT 'exact.write.matchset', ?1 WHERE ${GUARD}
             ON CONFLICT (scope, key) DO NOTHING`,
          )
          .bind(nextKey),
        txUpdate(d),
        completeKeyStatement(d, "bank_entry", w.idempotency_key, via, at),
      ],
    });
    if (ok) count("claimed");
  }

  /** Classifies the probe hits: the one line that is ours, none, or a mess a person must look at. */
  function ourLine(
    hits: BankEntryLineHit[],
    yourRef: string,
  ): { kind: "none" } | { kind: "found"; hit: BankEntryLineHit } | { kind: "ambiguous" } {
    if (hits.length === 0) return { kind: "none" };
    const first = hits[0];
    if (
      hits.length === 1 &&
      first !== undefined &&
      first.yourRef?.toLowerCase() === yourRef.toLowerCase()
    ) {
      return { kind: "found", hit: first };
    }
    return { kind: "ambiguous" };
  }

  async function processBankEntry(w: WorkRow, token: string): Promise<void> {
    const doc = asBankEntryDoc(parseDoc(w.payload_json, w.payload_hash));
    if (doc === null) {
      return giveUpToManual(w, token, "payload_invalid");
    }
    const rebuilt = rebuildBankEntry(doc);
    if (!rebuilt.ok) return giveUpToManual(w, token, rebuilt.code);
    const built = rebuilt.built;
    const rt = await division(w.division_id, w.exact_division);
    const yourRef = built.yourRefs[0] ?? "";

    // 1. Probe: is the line already in Exact? (always, before every POST)
    const probe = await readOr(() =>
      rt.writer.findBankEntryLineByRef({ journalCode: built.journalCode, yourRef }),
    );
    if (!probe.ok) {
      await releaseLease(w.id, token);
      count("deferred");
      return;
    }
    const found = ourLine(probe.value, yourRef);
    if (found.kind === "ambiguous") return giveUpToManual(w, token, "probe_ambiguous");
    if (found.kind === "found") {
      return verifiedBankEntry(
        w,
        token,
        doc,
        found.hit,
        w.status === "sent_unverified" ? "verified_by_probe" : "found_by_probe",
      );
    }
    // Not found.
    if (w.status === "sent_unverified") {
      // We saw Exact accept it but the probe cannot see it (yet). Never post again; give it time.
      if (nowMs() - Date.parse(w.updated_at) > UNVERIFIED_MAX_MS) {
        await note(w, token, {
          from: ["sent_unverified"],
          to: "outcome_unknown",
          errorCode: "not_visible_after_post",
          needsProbe: true,
          match: { from: w.exact_state, to: "outcome_unknown", note: "not_visible_after_post" },
          action: "booking.outcome_unknown",
          audit: { code: "not_visible_after_post", kind: w.kind },
        });
        count("outcomeUnknown");
      } else {
        await releaseLease(w.id, token);
      }
      return;
    }

    // 2. POST (switch re-read first; `sending` stored first).
    await assertStillEnabled();
    const sent = await note(w, token, {
      from: ["pending", "failed"],
      to: "sending",
      keepLease: true,
      attemptsDelta: 1,
      errorCode: null,
      needsProbe: false,
      nextAttemptAt: null,
      ...(w.exact_state === "booking_failed"
        ? { match: { from: "booking_failed", to: "booking", note: null } }
        : {}),
      action: "booking.sending",
      audit: { kind: w.kind, attempt: w.attempts + 1 },
    });
    if (!sent) return;
    const sendingRow: WorkRow = {
      ...w,
      status: "sending",
      attempts: w.attempts + 1,
      exact_state: "booking",
    };
    let resp: Awaited<ReturnType<ExactWriter["createBankEntry"]>>;
    try {
      resp = await rt.writer.createBankEntry(built);
    } catch (e) {
      return applyFailure(sendingRow, token, classifyWriteError(e));
    }
    if (!resp.ok) {
      return applyFailure(sendingRow, token, { kind: "unknown", code: `bank_entry_${resp.error}` });
    }
    const afterPost = await note(sendingRow, token, {
      from: ["sending"],
      to: "sent_unverified",
      keepLease: true,
      exactRef: resp.entryNumber !== null ? String(resp.entryNumber) : resp.entryId,
      action: "booking.sent_unverified",
      audit: { kind: w.kind },
    });
    if (!afterPost) return;

    // 3. Verify by probing again (a second look, never a second POST).
    const verify = await readOr(() =>
      rt.writer.findBankEntryLineByRef({ journalCode: built.journalCode, yourRef }),
    );
    const seen = verify.ok ? ourLine(verify.value, yourRef) : ({ kind: "none" } as const);
    if (seen.kind === "found") {
      return verifiedBankEntry(
        { ...sendingRow, status: "sent_unverified" },
        token,
        doc,
        {
          entryId: seen.hit.entryId ?? resp.entryId,
          entryNumber: seen.hit.entryNumber ?? resp.entryNumber,
        },
        "posted",
      );
    }
    if (seen.kind === "ambiguous") {
      return giveUpToManual({ ...sendingRow, status: "sent_unverified" }, token, "probe_ambiguous");
    }
    // Accepted but not visible yet: stays `sent_unverified`; the next run probes again.
    await releaseLease(w.id, token);
  }

  async function releaseLease(rowId: number, token: string): Promise<void> {
    await db
      .prepare(
        `UPDATE exact_write_outbox SET claimed_at = NULL, lease_expires_at = NULL
         WHERE id = ?1 AND claimed_at = ?2`,
      )
      .bind(rowId, token)
      .run();
  }

  // -- matchset row --------------------------------------------------------------------------------

  /** Finds the bank line Revolut's own Exact feed created (creates_bank_entries = 0). */
  async function locateBankLine(
    w: WorkRow,
    token: string,
    doc: MatchsetDoc,
    rt: DivisionRuntime,
  ): Promise<WorkRow | null> {
    const journal = w.map_journal;
    if (journal === null) {
      await giveUpToManual(w, token, "journal_unknown");
      return null;
    }
    // The feed may use the Revolut transaction id as YourRef; an id the probe cannot quote safely
    // is simply not searched for (the amount and date probe below still applies).
    const byRef = /^[A-Za-z0-9_-]{1,64}$/.test(w.tx_external_id)
      ? await readOr(() =>
          rt.writer.findBankEntryLineByRef({ journalCode: journal, yourRef: w.tx_external_id }),
        )
      : ({ ok: true, value: [] } as const);
    if (!byRef.ok) {
      await releaseLease(w.id, token);
      count("deferred");
      return null;
    }
    let entryNumber: number | null = null;
    if (byRef.value.length > 0) {
      const one = byRef.value.length === 1 ? byRef.value[0] : undefined;
      if (one === undefined || one.entryNumber === null) {
        await giveUpToManual(w, token, "bank_line_ambiguous");
        return null;
      }
      entryNumber = one.entryNumber;
    } else {
      const day = (ms: number): string => amsterdamParts(ms).date;
      const t = Date.parse(w.tx_booked_at);
      const byAmount = await readOr(() =>
        rt.writer.findBankLineByAmount({
          journalCode: journal,
          amountMinor: w.tx_amount,
          currency: w.tx_currency,
          dateFrom: day(t - DAY_MS),
          dateTo: day(t + 3 * DAY_MS),
        }),
      );
      if (!byAmount.ok) {
        await releaseLease(w.id, token);
        count("deferred");
        return null;
      }
      if (byAmount.value.length === 0) {
        if (nowMs() - Date.parse(w.created_at) > WAIT_FOR_LINE_MS) {
          await giveUpToManual(w, token, "bank_line_not_found", [
            "pending",
            "waiting_for_bank_line",
          ]);
          return null;
        }
        if (w.status === "waiting_for_bank_line") {
          await releaseLease(w.id, token);
        } else {
          await note(w, token, {
            from: ["pending"],
            to: "waiting_for_bank_line",
            errorCode: "bank_line_not_found",
            action: "booking.waiting_for_bank_line",
            audit: { kind: w.kind },
          });
        }
        count("waiting");
        return null;
      }
      // One line by amount and date is only trusted when it cannot belong to another payment of ours.
      const one = byAmount.value.length === 1 ? byAmount.value[0] : undefined;
      const twins = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM bank_transactions
           WHERE bank_account_id = ?1 AND amount_minor = ?2 AND currency = ?3 AND booked_at >= ?4 AND booked_at <= ?5`,
        )
        .bind(
          w.tx_account_id,
          w.tx_amount,
          w.tx_currency,
          iso(Date.parse(w.tx_booked_at) - 4 * DAY_MS),
          iso(Date.parse(w.tx_booked_at) + 4 * DAY_MS),
        )
        .first<{ n: number }>();
      if (one === undefined || one.entryNumber === null || (twins?.n ?? 0) !== 1) {
        await giveUpToManual(w, token, "bank_line_ambiguous");
        return null;
      }
      entryNumber = one.entryNumber;
    }
    // Another MatchSet of ours must not already use this bank line.
    const used = await db
      .prepare(
        `SELECT 1 AS x FROM exact_write_outbox
         WHERE kind = 'matchset' AND division_id = ?1 AND match_id <> ?2
           AND json_extract(payload_json, '$.input.bankEntryNumber') = ?3 AND status <> 'given_up' LIMIT 1`,
      )
      .bind(w.division_id, w.match_id, entryNumber)
      .first();
    if (used !== null) {
      await giveUpToManual(w, token, "bank_line_in_use");
      return null;
    }
    const plan: MatchsetPlanInput = { ...doc.input, bankEntryNumber: entryNumber };
    const built = buildMatchsetFromPlan(plan);
    if (!built.ok) {
      await giveUpToManual(w, token, built.code);
      return null;
    }
    const next = serializeDoc({
      v: 1,
      stage: "built",
      kind: "matchset",
      input: plan,
      builtHash: built.hash,
    });
    const ok = await note(w, token, {
      from: ["pending", "waiting_for_bank_line"],
      to: "pending",
      keepLease: true,
      errorCode: null,
      payload: { json: next.json, hash: next.hash, journalCode: null },
      exactRef: String(entryNumber),
      action: "booking.bank_line_found",
      audit: { kind: w.kind },
    });
    if (!ok) return null;
    return { ...w, status: "pending", payload_json: next.json, payload_hash: next.hash };
  }

  async function processMatchset(w0: WorkRow, token: string): Promise<void> {
    let w = w0;
    const doc0 = asMatchsetDoc(parseDoc(w.payload_json, w.payload_hash));
    if (doc0 === null) {
      return giveUpToManual(w, token, "payload_invalid");
    }
    const rt = await division(w.division_id, w.exact_division);
    let doc: MatchsetDoc = doc0;
    if (doc.stage === "plan") {
      const located = await locateBankLine(w, token, doc, rt);
      if (located === null) return;
      w = located;
      const reparsed = asMatchsetDoc(parseDoc(w.payload_json, w.payload_hash));
      if (reparsed === null) return;
      doc = reparsed;
    }
    const rebuilt = rebuildMatchset(doc);
    if (!rebuilt.ok) return giveUpToManual(w, token, rebuilt.code);

    // Read first: a MatchSet is posted only when the items are provably still unmatched.
    const before = await readOr(() => readBack(rt, doc.input));
    if (!before.ok) {
      await releaseLease(w.id, token);
      count("deferred");
      return;
    }
    const verdict = before.value;
    if (verdict.outcome === "verified") return finishMatchset(w, token, "already_matched");
    if (verdict.outcome === "inconclusive")
      return giveUpToManual(w, token, "readback_inconclusive");
    // not_applied from here on.

    await assertStillEnabled();
    const sent = await note(w, token, {
      from: ["pending", "failed"],
      to: "sending",
      keepLease: true,
      attemptsDelta: 1,
      errorCode: null,
      needsProbe: false,
      nextAttemptAt: null,
      ...(w.exact_state === "booking_failed"
        ? { match: { from: "booking_failed", to: "booking", note: null } }
        : {}),
      action: "booking.sending",
      audit: { kind: w.kind, attempt: w.attempts + 1 },
    });
    if (!sent) return;
    const sendingRow: WorkRow = {
      ...w,
      status: "sending",
      attempts: w.attempts + 1,
      exact_state: w.exact_state === "booking_failed" ? "booking" : w.exact_state,
    };
    try {
      await rt.writer.submitMatchSet(rebuilt.built);
    } catch (e) {
      return applyFailure(sendingRow, token, classifyWriteError(e));
    }
    // The answer is never proof: read back, whatever it said.
    const stored = await note(sendingRow, token, {
      from: ["sending"],
      to: "sent_unverified",
      keepLease: true,
      action: "booking.sent_unverified",
      audit: { kind: w.kind },
    });
    if (!stored) return;
    const sentRow: WorkRow = { ...sendingRow, status: "sent_unverified" };
    const check = await readOr(() => readBack(rt, doc.input));
    if (!check.ok) {
      await releaseLease(w.id, token);
      return;
    }
    return decideAfterPost(sentRow, token, check.value);
  }

  async function decideAfterPost(w: WorkRow, token: string, v: ReadBackVerdict): Promise<void> {
    if (v.outcome === "verified") return finishMatchset(w, token, "posted");
    if (v.outcome === "inconclusive") {
      const ok = await note(w, token, {
        from: ["sent_unverified"],
        to: "outcome_unknown",
        errorCode: "readback_inconclusive",
        needsProbe: true,
        match: { from: w.exact_state, to: "outcome_unknown", note: "readback_inconclusive" },
        action: "booking.outcome_unknown",
        audit: { code: "readback_inconclusive", kind: w.kind },
      });
      if (ok) count("outcomeUnknown");
      return;
    }
    // Exact accepted nothing: not applied. Retry later, at most MAX_AUTO_RETRIES times in all.
    const retry = w.attempts < MAX_AUTO_RETRIES;
    const ok = await note(w, token, {
      from: ["sent_unverified"],
      to: "failed",
      errorCode: "matchset_not_applied",
      nextAttemptAt: retry
        ? iso(
            nowMs() +
              (RETRY_BACKOFF_MS[Math.min(Math.max(w.attempts - 1, 0), 2)] ?? RETRY_BACKOFF_MS[2]!),
          )
        : null,
      match: { from: w.exact_state, to: "booking_failed", note: "matchset_not_applied" },
      action: "booking.failed",
      audit: { code: "matchset_not_applied", kind: w.kind, attempts: w.attempts, retry },
    });
    if (ok) count("failed");
  }

  /** A `sent_unverified` MatchSet row of an earlier run: read back and decide. */
  async function verifyUnverifiedMatchset(w: WorkRow, token: string): Promise<void> {
    const doc = asMatchsetDoc(parseDoc(w.payload_json, w.payload_hash));
    if (doc === null || doc.stage !== "built") {
      return giveUpToManual(w, token, "payload_invalid");
    }
    const rt = await division(w.division_id, w.exact_division);
    const r = await readOr(() => readBack(rt, doc.input));
    if (!r.ok) {
      if (nowMs() - Date.parse(w.updated_at) > UNVERIFIED_MAX_MS) {
        await note(w, token, {
          from: ["sent_unverified"],
          to: "outcome_unknown",
          errorCode: "not_visible_after_post",
          needsProbe: true,
          match: { from: w.exact_state, to: "outcome_unknown", note: "not_visible_after_post" },
          action: "booking.outcome_unknown",
          audit: { code: "not_visible_after_post", kind: w.kind },
        });
        count("outcomeUnknown");
      } else {
        await releaseLease(w.id, token);
      }
      return;
    }
    return decideAfterPost(w, token, r.value);
  }

  // -- the loop --------------------------------------------------------------------------------------

  async function processRow(id: number, statuses: readonly OutboxStatus[]): Promise<void> {
    const token = await leaseRow(db, id, statuses, nowMs());
    if (token === null) return; // another run holds it
    try {
      const w = await loadWork(db, id);
      if (w === null || w.undone_at !== null) return await releaseLease(id, token);
      if (w.kind === "bank_entry") return await processBankEntry(w, token);
      if (w.status === "sent_unverified") return await verifyUnverifiedMatchset(w, token);
      return await processMatchset(w, token);
    } catch (e) {
      // A run-level stop (switch off, budget, deadline) or an unexpected error: give the row back,
      // unless a POST may be in flight (`sending` keeps its lease; the stale check handles it).
      await db
        .prepare(
          `UPDATE exact_write_outbox SET claimed_at = NULL, lease_expires_at = NULL
           WHERE id = ?1 AND claimed_at = ?2 AND status <> 'sending'`,
        )
        .bind(id, token)
        .run()
        .catch(() => undefined);
      throw e;
    }
  }

  /** After a bank entry was verified: its MatchSet row (created in the same batch) is next. */
  async function continueWithMatchset(matchId: number): Promise<void> {
    const next = await db
      .prepare(
        `SELECT id FROM exact_write_outbox WHERE match_id = ?1 AND kind = 'matchset' AND status = 'pending'`,
      )
      .bind(matchId)
      .first<{ id: number }>();
    if (next !== null) await processRow(next.id, ["pending"]);
  }

  try {
    // 1. Rows whose POST may have been in flight when an executor died: never re-posted.
    const stale = (
      await db
        .prepare(
          `SELECT o.id, o.match_id, m.exact_state FROM exact_write_outbox o JOIN matches m ON m.id = o.match_id
           WHERE o.status = 'sending' AND o.lease_expires_at < ?1 ORDER BY o.id LIMIT ?2`,
        )
        .bind(nowIso(), ROW_LIMIT)
        .all<{ id: number; match_id: number; exact_state: string }>()
    ).results;
    for (const s of stale) {
      const ok = await transition(db, {
        rowId: s.id,
        matchId: s.match_id,
        from: ["sending"],
        to: "outcome_unknown",
        token: null,
        nowIso: nowIso(),
        errorCode: "stale_sending",
        needsProbe: true,
        match: { from: s.exact_state, to: "outcome_unknown", note: "stale_sending" },
        actor: "system",
        action: "booking.outcome_unknown",
        audit: { code: "stale_sending" },
      });
      if (ok) counters.outcomeUnknown++;
    }

    // 2. Rows waiting for work (oldest first).
    const now = nowIso();
    const rows = (
      await db
        .prepare(
          `SELECT id, status, kind, match_id FROM exact_write_outbox
           WHERE (lease_expires_at IS NULL OR lease_expires_at < ?1)
             AND ((status IN ('pending', 'waiting_for_bank_line') AND (next_attempt_at IS NULL OR next_attempt_at <= ?1))
               OR status = 'sent_unverified'
               OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?1 AND attempts < ?2))
           ORDER BY created_at, id LIMIT ?3`,
        )
        .bind(now, MAX_AUTO_RETRIES, ROW_LIMIT)
        .all<{ id: number; status: OutboxStatus; kind: string; match_id: number }>()
    ).results;
    for (const r of rows) {
      if (ctx.signal.aborted || nowMs() >= ctx.deadlineMs) throw new RunStop("time_limit");
      await processRow(r.id, [r.status]);
      // A bank entry that was just verified created the MatchSet row: carry on with it right away.
      if (r.kind === "bank_entry") await continueWithMatchset(r.match_id);
    }

    // 3. New matches.
    const candidates = await loadCandidates(
      db,
      iso(nowMs() - BOOKING_DELAY_MS),
      MAX_MATCHES_PER_RUN,
    );
    for (const cand of candidates) {
      if (ctx.signal.aborted || nowMs() >= ctx.deadlineMs) throw new RunStop("time_limit");
      await startMatch(cand);
    }
  } catch (e) {
    if (e instanceof RunStop) stop = e.code;
    else throw e;
  } finally {
    for (const rt of divisions.values()) await rt.endJob();
  }

  async function startMatch(cand: Candidate): Promise<void> {
    const plan = planMatch(cand);
    const matchedKind = createsBankEntries ? "bank_entry" : "matchset";
    const manual = async (code: string, kind: "bank_entry" | "matchset"): Promise<void> => {
      const doc = serializeDoc({ v: 1, stage: "none", reason: safeCode(code) });
      const r = await claimAndEnqueue(db, {
        matchId: cand.matchId,
        divisionId: cand.divisionId,
        journalCode: null,
        kind,
        idempotencyKey: planFailureKey(cand.matchId),
        payloadJson: doc.json,
        payloadHash: doc.hash,
        status: "manual_required",
        errorCode: code,
        nowIso: nowIso(),
      });
      if (r === "claimed") {
        counters.claimed++;
        counters.manualRequired++;
      }
    };
    if (!plan.ok) {
      return manual(
        plan.code,
        plan.mode === "ledger" || createsBankEntries ? "bank_entry" : "matchset",
      );
    }
    if (plan.mode === "ledger" && !createsBankEntries) {
      // Revolut's feed owns the bank line; a ledger booking would need to edit it.
      return manual("ledger_booking_with_feed_manual", "bank_entry");
    }
    const rt = await division(cand.divisionId, cand.exactDivision);

    if (plan.mode === "matched" && !createsBankEntries) {
      // Revolut's own Exact feed creates the bank line: no bank entry, only the MatchSet.
      const doc = serializeDoc({
        v: 1,
        stage: "plan",
        kind: "matchset",
        input: plan.matchset,
        builtHash: null,
      });
      const r = await claimAndEnqueue(db, {
        matchId: cand.matchId,
        divisionId: cand.divisionId,
        journalCode: null,
        kind: matchedKind === "matchset" ? "matchset" : "bank_entry",
        idempotencyKey: plan.matchsetKey,
        payloadJson: doc.json,
        payloadHash: doc.hash,
        status: "pending",
        errorCode: null,
        nowIso: nowIso(),
      });
      if (r === "lost") return;
      counters.claimed++;
      return runClaimed(cand.matchId, ["matchset"]);
    }

    // A bank entry is needed. One in flight per journal: its closing balance is the next opening.
    const busy = await db
      .prepare(
        `SELECT 1 AS x FROM exact_write_outbox
         WHERE division_id = ?1 AND journal_code = ?2 AND kind = 'bank_entry'
           AND status NOT IN ('verified', 'resolved_manually', 'given_up') LIMIT 1`,
      )
      .bind(cand.divisionId, cand.map.journalCode)
      .first();
    if (busy !== null) {
      counters.deferred++;
      return;
    }
    const balance = await readOr(() =>
      rt.writer.readLatestClosingBalance({
        journalCode: cand.map.journalCode,
        currency: cand.currency,
      }),
    );
    if (!balance.ok) {
      counters.deferred++;
      return;
    }
    if (balance.value === null) return manual("bank_balance_unknown", "bank_entry");
    const built = buildBankEntryPayload({
      ...plan.bankEntry,
      openingBalanceMinor: balance.value,
      closingBalanceMinor: balance.value + cand.tx.amountMinor,
    });
    if (!built.ok) return manual(built.error, "bank_entry");
    const input = {
      ...plan.bankEntry,
      openingBalanceMinor: balance.value,
      closingBalanceMinor: balance.value + cand.tx.amountMinor,
    };
    const doc = serializeDoc({
      v: 1,
      stage: "built",
      kind: "bank_entry",
      input,
      builtHash: sha256Hex(built.body),
      then:
        plan.mode === "matched" ? { matchset: plan.matchset, matchsetKey: plan.matchsetKey } : null,
    });
    const r = await claimAndEnqueue(db, {
      matchId: cand.matchId,
      divisionId: cand.divisionId,
      journalCode: cand.map.journalCode,
      kind: "bank_entry",
      idempotencyKey: plan.bankEntryKey,
      payloadJson: doc.json,
      payloadHash: doc.hash,
      status: "pending",
      errorCode: null,
      nowIso: nowIso(),
    });
    if (r === "lost") return;
    counters.claimed++;
    return runClaimed(cand.matchId, ["bank_entry"]);
  }

  /** Runs the rows a fresh claim created (a bank entry, and its MatchSet once the line exists). */
  async function runClaimed(
    matchId: number,
    kinds: readonly ("bank_entry" | "matchset")[],
  ): Promise<void> {
    for (const kind of kinds) {
      const row = await db
        .prepare("SELECT id, status FROM exact_write_outbox WHERE match_id = ?1 AND kind = ?2")
        .bind(matchId, kind)
        .first<{ id: number; status: OutboxStatus }>();
      if (row === null || row.status !== "pending") return;
      await processRow(row.id, ["pending"]);
    }
    // A bank entry that was verified created the MatchSet row: continue with it in this run.
    if (!kinds.includes("matchset")) await continueWithMatchset(matchId);
  }

  const attention = counters.failed + counters.outcomeUnknown + counters.manualRequired;
  const summary = { ...counters, calls, budget };
  if (stop !== null) {
    return { status: "partial", code: stop, summary, callsUsed: calls };
  }
  if (attention > 0) {
    return { status: "partial", code: "attention_needed", summary, callsUsed: calls };
  }
  return { status: "ok", summary, callsUsed: calls };
}
