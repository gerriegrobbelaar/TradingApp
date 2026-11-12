/**
 * THE call boundary to the bank (Phase 9, P9a, ADR 0049). In P9a nothing can pass it:
 *
 *  - `PaymentSubmitter` is the only thing that may talk to Revolut about a payment. The default is
 *    `DisabledSubmitter`: it is not `available`, so `runSubmission` refuses before it claims anything.
 *  - No route calls `runSubmission`; P9b adds the real submitter and the job that calls it.
 *  - The ExactGate/RevolutGate allow-lists keep every payment endpoint unreachable
 *    (revolut/request.ts); a source scan in test/payments-scan.test.ts pins that.
 *
 * `runSubmission` is the state machine around the call, tested here with fake submitters:
 *   claim (single writer, lease) -> `submitting` -> ONE call -> submitted | rejected | outcome_unknown.
 * It never calls twice for the same request: a thrown error, a timeout or an unreadable answer is
 * `outcome_unknown`, which only a person or the reconciliation (by `request_id`, P9b) resolves. A claim
 * whose lease ran out becomes `outcome_unknown` too, never "try again".
 */
import {
  approvalStillValid,
  paymentPayloadHash,
  type PayloadItem,
  type PaymentMode,
} from "@camelthorn/core";
import { storedIbansMatch } from "./iban-store";
import { loadPaymentsState, paymentsBlockers } from "./settings";
import { recheckBeforeSubmit } from "./store";
import {
  childMoveStatements,
  dbErrorCode,
  EVENT_COL,
  moveStatements,
  TABLE,
  type SubjectKind,
} from "./transition";

export type SubmitItem = PayloadItem;

/** What the submitter is given. No IBAN: P9b's submitter reads the one it needs from iban-store. */
export interface SubmitRequest {
  kind: SubjectKind;
  id: number;
  requestId: string;
  mode: PaymentMode;
  sourceAccountId: number;
  currency: string;
  totalMinor: number;
  payloadHash: string;
  items: SubmitItem[];
}

export type SubmitOutcome =
  /** The bank accepted the instruction (drafts: the draft exists; pay: the transfer was created). */
  | { kind: "accepted"; providerId: string }
  /** The bank definitely refused; nothing was or will be paid. */
  | { kind: "rejected"; code: string }
  /** The call may or may not have reached the bank. NEVER retried automatically. */
  | { kind: "unknown" };

export interface PaymentSubmitter {
  /** False for the disabled default: `runSubmission` then refuses before it claims anything. */
  readonly available: boolean;
  submit(req: SubmitRequest): Promise<SubmitOutcome>;
}

export const DisabledSubmitter: PaymentSubmitter = {
  available: false,
  submit: () => Promise.resolve({ kind: "rejected", code: "payments_disabled" }),
};

let current: PaymentSubmitter = DisabledSubmitter;

/** The submitter in force. P9b returns the Revolut one when its own switches allow it. */
export function getSubmitter(): PaymentSubmitter {
  return current;
}

/**
 * TESTS ONLY: lets a test pretend a submitter exists so the enabling SQL can run. No route or job
 * can reach it, and a source scan (test/payments-scan.test.ts) fails if any file in src/ other than
 * this one mentions it.
 */
export function setSubmitterForTests(s: PaymentSubmitter | null): void {
  current = s ?? DisabledSubmitter;
}

/**
 * Reconciliation of an `outcome_unknown` request: ask the bank by `request_id` what happened.
 * Interface only in P9a; P9b implements it (GET /transaction/{request_id}?id_type=request_id) and a job
 * that applies the verdict. Nothing may re-submit on `not_found` automatically.
 */
export type ReconcileVerdict =
  | { found: false }
  | {
      found: true;
      state: "pending" | "completed" | "failed" | "declined" | "reverted";
      providerId: string;
    };
export interface PaymentReconciler {
  lookup(requestId: string): Promise<ReconcileVerdict>;
}

export const SUBMIT_LEASE_MS = 10 * 60_000;

export type SubmissionResult =
  | { status: "refused"; code: string }
  | { status: "already_claimed" }
  | { status: "done"; to: "submitted" | "rejected" | "outcome_unknown"; code: string };

interface Row {
  id: number;
  request_id: string;
  status: string;
  requested_by: string;
  payload_hash: string;
  approvals_required: string;
  currency: string;
  amount_minor: number;
  expires_at: string;
  bank_account_id: number;
  mode: PaymentMode;
  submit_attempts: number;
}

async function loadRow(db: D1Database, kind: SubjectKind, id: number): Promise<Row | null> {
  const total = kind === "payment" ? "amount_minor" : "total_minor AS amount_minor";
  return db
    .prepare(
      `SELECT id, request_id, status, requested_by, payload_hash, approvals_required, currency, ${total},
              expires_at, bank_account_id, mode, submit_attempts FROM ${TABLE[kind]} WHERE id = ?1`,
    )
    .bind(id)
    .first<Row>();
}

async function loadItems(db: D1Database, kind: SubjectKind, id: number): Promise<SubmitItem[]> {
  const where = kind === "payment" ? "id = ?1" : "batch_id = ?1";
  const rows = await db
    .prepare(
      `SELECT request_id, open_item_id, amount_minor, currency, iban_fingerprint, reference
         FROM payments WHERE ${where} ORDER BY id`,
    )
    .bind(id)
    .all<{
      request_id: string;
      open_item_id: number;
      amount_minor: number;
      currency: string;
      iban_fingerprint: string;
      reference: string;
    }>();
  return rows.results.map((r) => ({
    requestId: r.request_id,
    openItemId: r.open_item_id,
    amountMinor: r.amount_minor,
    currency: r.currency,
    ibanFingerprint: r.iban_fingerprint,
    reference: r.reference,
  }));
}

/** Why a request may not be sent right now, or null. Re-reads everything; trusts no earlier answer. */
async function whyNot(
  db: D1Database,
  kind: SubjectKind,
  row: Row,
  items: SubmitItem[],
  nowMs: number,
): Promise<string | null> {
  if (row.status !== "ready") return "not_ready";
  if (!(nowMs < Date.parse(row.expires_at))) return "expired";
  let hash: string;
  try {
    hash = paymentPayloadHash({
      kind,
      mode: row.mode,
      sourceAccountId: row.bank_account_id,
      currency: row.currency,
      totalMinor: row.amount_minor,
      items,
    });
  } catch {
    return "payload_invalid";
  }
  if (hash !== row.payload_hash) return "payload_tampered";
  let needs: unknown;
  try {
    needs = JSON.parse(row.approvals_required);
  } catch {
    return "approvals_unreadable";
  }
  if (!Array.isArray(needs)) return "approvals_unreadable";
  if (needs.length === 0) return null;
  const col = kind === "payment" ? "payment_id" : "batch_id";
  const a = await db
    .prepare(
      `SELECT a.decision, a.decided_by, a.decided_at, a.payload_hash,
              EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'approver') AS has_role,
              u.disabled_at
         FROM payment_approvals a LEFT JOIN users u ON u.email = a.decided_by
        WHERE a.${col} = ?1`,
    )
    .bind(row.id)
    .first<{
      decision: string;
      decided_by: string;
      decided_at: string;
      payload_hash: string;
      has_role: number | null;
      disabled_at: string | null;
    }>();
  if (a === null || a.decision !== "approved") return "not_approved";
  const denial = approvalStillValid({
    nowMs,
    approval: {
      approverEmail: a.decided_by,
      approvedAtMs: Date.parse(a.decided_at),
      payloadHash: a.payload_hash,
    },
    request: { requestedBy: row.requested_by, payloadHash: row.payload_hash },
    approverNow: {
      roles: a.has_role === 1 ? ["approver"] : [],
      active: a.disabled_at === null && a.has_role !== null,
    },
  });
  return denial === null ? null : `approval_${denial}`;
}

const SAFE_CODE = /[^a-z0-9_:.-]/gi;

export interface SubmissionArgs {
  kind: SubjectKind;
  id: number;
  nowMs: number;
  owner: string;
  /** Workers secret PAYMENTS_IBAN_KEY: binds the stored IBAN to the approved fingerprint. */
  ibanKey: string | null;
}

export async function runSubmission(
  db: D1Database,
  submitter: PaymentSubmitter,
  a: SubmissionArgs,
): Promise<SubmissionResult> {
  // Layer 1: the switch, the verification, the approval mapping, the connection, an approver, the
  // fingerprint key and a submitter that exists. Any gap: nothing is claimed, nothing is written.
  const state = await loadPaymentsState(db, a.ibanKey);
  if (!state.enabled || paymentsBlockers(state, submitter.available).length > 0) {
    return { status: "refused", code: "payments_disabled" };
  }
  const row = await loadRow(db, a.kind, a.id);
  if (row === null) return { status: "refused", code: "not_found" };
  if (a.kind === "payment") {
    const inBatch = await db
      .prepare("SELECT batch_id FROM payments WHERE id = ?1")
      .bind(a.id)
      .first<{ batch_id: number | null }>();
    if (inBatch?.batch_id != null) return { status: "refused", code: "batch_item" };
  }
  const items = await loadItems(db, a.kind, a.id);
  const why = await whyNot(db, a.kind, row, items, a.nowMs);
  if (why !== null) return { status: "refused", code: why };
  // The pre-checks again with today's facts and today's settings (an invoice paid in Exact since, an
  // IBAN changed, a tightened limit), and the stored IBAN still matches the approved fingerprint.
  const again = await recheckBeforeSubmit(db, {
    kind: a.kind,
    id: a.id,
    nowMs: a.nowMs,
    state,
    ibanKey: a.ibanKey,
  });
  if (again !== null) return { status: "refused", code: again };
  if (!(await storedIbansMatch(db, a.kind, a.id, a.ibanKey))) {
    return { status: "refused", code: "iban_binding_broken" };
  }

  // Layer 2: claim BEFORE the call, in one batch with the move to `submitting`.
  const nowIso = new Date(a.nowMs).toISOString();
  const claim = db
    .prepare(
      `INSERT INTO payment_claims (${EVENT_COL[a.kind]}, owner, claimed_at, lease_until) VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(a.id, a.owner, nowIso, new Date(a.nowMs + SUBMIT_LEASE_MS).toISOString());
  const move = {
    kind: a.kind,
    id: a.id,
    requestId: row.request_id,
    from: "ready" as const,
    to: "submitting" as const,
    actor: a.owner,
    code: "claimed",
    nowIso,
    notExpired: true,
    set: { submit_attempts: row.submit_attempts + 1 },
    audit: {
      action: a.kind === "payment" ? "payment.submitting" : "payment_batch.submitting",
      after: { payloadHash: row.payload_hash },
    },
  };
  let out: D1Result[];
  try {
    out = await db.batch([
      claim,
      ...moveStatements(db, move),
      ...(a.kind === "batch" ? childMoveStatements(db, move) : []),
    ]);
  } catch (err) {
    if (
      /UNIQUE constraint failed: payment_claims/.test(
        String(err instanceof Error ? `${err.message} ${String(err.cause)}` : err),
      )
    ) {
      return { status: "already_claimed" };
    }
    const code = dbErrorCode(err);
    if (code !== null) return { status: "refused", code };
    throw err;
  }
  if ((out[3]?.meta.changes ?? 0) !== 1) return { status: "already_claimed" };

  // Layer 3: ONE call. Anything that is not a clear answer is "unknown", never "try again".
  let outcome: SubmitOutcome;
  try {
    const o = await submitter.submit({
      kind: a.kind,
      id: a.id,
      requestId: row.request_id,
      mode: row.mode,
      sourceAccountId: row.bank_account_id,
      currency: row.currency,
      totalMinor: row.amount_minor,
      payloadHash: row.payload_hash,
      items,
    });
    outcome = isOutcome(o) ? o : { kind: "unknown" };
  } catch {
    outcome = { kind: "unknown" };
  }

  const done = await finish(db, a, row, outcome);
  return done;
}

function isOutcome(o: unknown): o is SubmitOutcome {
  if (o === null || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  if (r["kind"] === "accepted")
    return typeof r["providerId"] === "string" && r["providerId"] !== "";
  if (r["kind"] === "rejected") return typeof r["code"] === "string" && r["code"] !== "";
  return r["kind"] === "unknown";
}

async function finish(
  db: D1Database,
  a: SubmissionArgs,
  row: Row,
  outcome: SubmitOutcome,
): Promise<SubmissionResult> {
  const to =
    outcome.kind === "accepted"
      ? "submitted"
      : outcome.kind === "rejected"
        ? "rejected"
        : "outcome_unknown";
  const code =
    outcome.kind === "accepted"
      ? "accepted"
      : outcome.kind === "rejected"
        ? `provider_rejected:${outcome.code.replace(SAFE_CODE, "").slice(0, 60) || "unspecified"}`
        : "outcome_unknown";
  const nowIso = new Date(a.nowMs).toISOString();
  const move = {
    kind: a.kind,
    id: a.id,
    requestId: row.request_id,
    from: "submitting" as const,
    to: to as "submitted" | "rejected" | "outcome_unknown",
    actor: a.owner,
    code,
    nowIso,
    ...(outcome.kind === "accepted"
      ? { set: { provider_id: outcome.providerId.slice(0, 100) } }
      : {}),
    audit: { action: a.kind === "payment" ? `payment.${to}` : `payment_batch.${to}` },
  };
  const release =
    outcome.kind === "unknown"
      ? []
      : [
          db
            .prepare(
              `UPDATE payment_claims SET released_at = ?2, release_reason = 'finished'
                WHERE ${EVENT_COL[a.kind]} = ?1 AND released_at IS NULL`,
            )
            .bind(a.id, nowIso),
        ];
  let out: D1Result[];
  try {
    out = await db.batch([
      ...moveStatements(db, move),
      ...(a.kind === "batch" ? childMoveStatements(db, move) : []),
      ...release,
    ]);
  } catch {
    // The row stays `submitting`; the lease check turns it into outcome_unknown. Never re-sent.
    return { status: "done", to: "outcome_unknown", code: "finish_failed" };
  }
  if ((out[2]?.meta.changes ?? 0) === 1) return { status: "done", to: move.to, code };
  // The move did not happen: the lease ran out during the call and markStaleSubmissions already
  // made the request `outcome_unknown`. A clear answer that arrived late is still the bank's
  // answer: record it from outcome_unknown (a legal move), so the provider id is not lost. Never
  // a second call.
  if (outcome.kind === "unknown") {
    return { status: "done", to: "outcome_unknown", code: "lease_lost" };
  }
  const late = { ...move, from: "outcome_unknown" as const, code: `${code}:late` };
  try {
    const out2 = await db.batch([
      ...moveStatements(db, late),
      ...(a.kind === "batch" ? childMoveStatements(db, late) : []),
      ...release,
    ]);
    if ((out2[2]?.meta.changes ?? 0) === 1) return { status: "done", to: move.to, code: late.code };
  } catch {
    // fall through: the reconciliation resolves it by request_id
  }
  return { status: "done", to: "outcome_unknown", code: "lease_lost" };
}

/**
 * A claim whose lease ran out (the worker died between the call and the write): the request may have
 * been sent. It becomes `outcome_unknown`, to be reconciled by request_id. Returns how many.
 */
export async function markStaleSubmissions(db: D1Database, nowMs: number): Promise<number> {
  const nowIso = new Date(nowMs).toISOString();
  let n = 0;
  for (const kind of ["payment", "batch"] as const) {
    const col = EVENT_COL[kind];
    const stale = await db
      .prepare(
        `SELECT s.id, s.request_id FROM ${TABLE[kind]} s
          WHERE s.status = 'submitting'
            AND EXISTS (SELECT 1 FROM payment_claims c WHERE c.${col} = s.id AND c.released_at IS NULL AND c.lease_until <= ?1)
            ${kind === "payment" ? "AND s.batch_id IS NULL" : ""}`,
      )
      .bind(nowIso)
      .all<{ id: number; request_id: string }>();
    for (const s of stale.results) {
      const move = {
        kind,
        id: s.id,
        requestId: s.request_id,
        from: "submitting" as const,
        to: "outcome_unknown" as const,
        actor: "system",
        code: "lease_expired",
        nowIso,
        audit: {
          action: kind === "payment" ? "payment.outcome_unknown" : "payment_batch.outcome_unknown",
        },
      };
      const out = await db.batch([
        ...moveStatements(db, move),
        ...(kind === "batch" ? childMoveStatements(db, move) : []),
      ]);
      n += out[2]?.meta.changes ?? 0;
    }
  }
  return n;
}
