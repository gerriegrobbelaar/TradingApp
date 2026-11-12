/**
 * Reconciliation of payments that were sent (Phase 9, P9b, ADR 0050). The job `payments.reconcile`
 * (every 5 minutes) asks Revolut what happened to every payment that is `submitted` or
 * `outcome_unknown`, with READ-ONLY calls through the gate, and applies the P9a transitions:
 *
 *   pay mode     GET /transaction/{request_id}?id_type=request_id
 *   drafts mode  GET /payment-drafts/{id} (known id) or GET /payment-drafts + the title marker (lost answer)
 *
 * Rules (each one is a test):
 *  - ONLY final bank states move a payment: completed -> paid; failed, declined, reverted -> failed.
 *    pending leaves `submitted` as it is (and lifts `outcome_unknown` to `submitted`).
 *  - A transaction found by request_id is trusted only when amount, currency and source account are
 *    ours (`transactionMatchesPayment`); anything else is reported (`mismatch`) and nothing moves.
 *  - NOTHING here sends, retries or re-submits. "Not found" is recorded; it never moves a payment by
 *    itself (a person decides, with the typed phrase, after the lookup said so: `resolveNotSent`).
 *  - `paid` is the bank's word (ADR 0049). The Exact side is the standard match: when the payment's
 *    bank line appears (webhook or sync) it is LINKED to the payment (`payment_bank_links`); no second
 *    bank entry is ever created here. `paymentSettlement` says how far the booking is.
 *  - A draft not approved after `payments.draft_expiry_days` becomes `failed` (`draft_expired`); the
 *    draft stays on the watch list for 30 days so an approval after the expiry is raised as an alert.
 *  - It keeps working while payments are switched OFF: switching off must not blind the lookup of
 *    what is already in flight. With nothing in flight it makes no call at all.
 */
import { phraseMatches, PAYMENTS_RESOLVE_PHRASE } from "@camelthorn/core";
import {
  draftTitle,
  type PaymentDraftView,
  type RevolutClient,
  type RevolutTransaction,
} from "@camelthorn/revolut";
import { auditStatement } from "../db/audit";
import { interpretDraft } from "./draft-state";
import { transactionMatchesPayment } from "./tx-match";
import { markStaleSubmissions } from "./submit";
import { childMoveStatements, moveStatements, type SubjectKind } from "./transition";

export { interpretDraft, type DraftVerdict } from "./draft-state";

export const DRAFT_EXPIRY_KEY = "payments.draft_expiry_days";
export const DEFAULT_DRAFT_EXPIRY_DAYS = 5;
export const MAX_DRAFT_EXPIRY_DAYS = 30;
/** A draft that expired locally is still watched this long for a late approval. */
export const EXPIRED_WATCH_DAYS = 30;
const MAX_PER_RUN = 40;
/** A person may call an unknown payment "not sent" only if the lookup said so this recently ... */
export const NOT_FOUND_FRESH_MS = 30 * 60_000;
/** ... and only this long after the call began (Revolut may be slow to show a transfer). */
export const NOT_FOUND_MIN_AGE_MS = 15 * 60_000;

export type ReconcileResult =
  | "pending"
  | "paid"
  | "failed"
  | "not_found"
  | "mismatch"
  | "duplicate"
  | "unreadable"
  | "error"
  | "draft_expired"
  | "approved_after_expiry"
  | "reverted_after_paid"
  | "resolved";

export interface ReconcileSummary {
  checked: number;
  paid: number;
  failed: number;
  pending: number;
  notFound: number;
  alerts: number;
  linked: number;
  errors: number;
}

const empty = (): ReconcileSummary => ({
  checked: 0,
  paid: 0,
  failed: 0,
  pending: 0,
  notFound: 0,
  alerts: 0,
  linked: 0,
  errors: 0,
});

export async function loadDraftExpiryDays(db: D1Database): Promise<number> {
  const r = await db
    .prepare("SELECT value_json FROM settings WHERE key = ?1")
    .bind(DRAFT_EXPIRY_KEY)
    .first<{ value_json: string }>();
  const n = r === null ? NaN : Number(r.value_json);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DRAFT_EXPIRY_DAYS
    ? n
    : DEFAULT_DRAFT_EXPIRY_DAYS;
}

// ---- reading a draft: draft-state.ts (shared with the submitter's prior-attempt check) ----------

// ---- subjects -----------------------------------------------------------------------------------

interface Subject {
  kind: SubjectKind;
  id: number;
  requestId: string;
  status: "submitted" | "outcome_unknown";
  mode: "drafts" | "pay";
  providerId: string | null;
  amountMinor: number;
  currency: string;
  sourceExternalId: string;
  updatedAt: string;
  createdAt: string;
  notFoundChecks: number;
}

async function loadSubjects(db: D1Database): Promise<Subject[]> {
  const out: Subject[] = [];
  for (const kind of ["payment", "batch"] as const) {
    const table = kind === "payment" ? "payments" : "payment_batches";
    const amount = kind === "payment" ? "s.amount_minor" : "s.total_minor";
    const rows = await db
      .prepare(
        `SELECT s.id, s.request_id, s.status, s.mode, s.provider_id, ${amount} AS amount_minor, s.currency,
                a.external_id, COALESCE(s.updated_at, s.created_at) AS updated_at, s.created_at,
                COALESCE(r.not_found_checks, 0) AS nf
           FROM ${table} s JOIN bank_accounts a ON a.id = s.bank_account_id
           LEFT JOIN payment_reconcile r ON r.subject_kind = ?1 AND r.subject_id = s.id
          WHERE s.status IN ('submitted', 'outcome_unknown') ${kind === "payment" ? "AND s.batch_id IS NULL" : ""}
          ORDER BY COALESCE(r.last_checked_at, '') ASC, s.id ASC LIMIT ?2`,
      )
      .bind(kind, MAX_PER_RUN)
      .all<{
        id: number;
        request_id: string;
        status: "submitted" | "outcome_unknown";
        mode: "drafts" | "pay";
        provider_id: string | null;
        amount_minor: number;
        currency: string;
        external_id: string;
        updated_at: string;
        created_at: string;
        nf: number;
      }>();
    for (const r of rows.results) {
      out.push({
        kind,
        id: r.id,
        requestId: r.request_id,
        status: r.status,
        mode: r.mode,
        providerId: r.provider_id,
        amountMinor: r.amount_minor,
        currency: r.currency,
        sourceExternalId: r.external_id,
        updatedAt: r.updated_at,
        createdAt: r.created_at,
        notFoundChecks: r.nf,
      });
    }
  }
  return out;
}

function note(
  db: D1Database,
  s: Pick<Subject, "kind" | "id">,
  nowIso: string,
  result: ReconcileResult,
  extra: { providerState?: string | null; transactionId?: string | null; alert?: boolean } = {},
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO payment_reconcile (subject_kind, subject_id, first_checked_at, last_checked_at, checks,
                                      not_found_checks, last_result, provider_state, transaction_id, alert_at)
       VALUES (?1, ?2, ?3, ?3, 1, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (subject_kind, subject_id) DO UPDATE SET
         last_checked_at = excluded.last_checked_at, checks = checks + 1,
         not_found_checks = not_found_checks + excluded.not_found_checks,
         last_result = excluded.last_result, provider_state = excluded.provider_state,
         transaction_id = COALESCE(excluded.transaction_id, transaction_id),
         alert_at = COALESCE(alert_at, excluded.alert_at)`,
    )
    .bind(
      s.kind,
      s.id,
      nowIso,
      result === "not_found" ? 1 : 0,
      result,
      (extra.providerState ?? null)?.slice(0, 40) ?? null,
      extra.transactionId?.slice(0, 100) ?? null,
      extra.alert === true ? nowIso : null,
    );
}

/** The move plus the bookkeeping row, as one batch. True when the state really moved. */
async function applyMove(
  db: D1Database,
  s: Subject,
  to: "submitted" | "paid" | "failed",
  code: string,
  nowIso: string,
  result: ReconcileResult,
  extra: { providerId?: string | null; providerState?: string | null; alert?: boolean } = {},
): Promise<boolean> {
  const move = {
    kind: s.kind,
    id: s.id,
    requestId: s.requestId,
    from: s.status,
    to,
    actor: "system",
    code,
    nowIso,
    ...(extra.providerId ? { set: { provider_id: extra.providerId.slice(0, 100) } } : {}),
    audit: { action: s.kind === "payment" ? `payment.${to}` : `payment_batch.${to}` },
  };
  try {
    const out = await db.batch([
      ...moveStatements(db, move),
      ...(s.kind === "batch" ? childMoveStatements(db, move) : []),
      note(db, s, nowIso, result, {
        providerState: extra.providerState ?? null,
        transactionId: extra.providerId ?? null,
        ...(extra.alert === true ? { alert: true } : {}),
      }),
    ]);
    return (out[2]?.meta.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

// ---- one subject ---------------------------------------------------------------------------------

async function viaTransaction(
  db: D1Database,
  client: RevolutClient,
  s: Subject,
  nowIso: string,
  sum: ReconcileSummary,
): Promise<void> {
  let tx: RevolutTransaction | null;
  try {
    tx = await client.getTransactionByRequestId(s.requestId);
  } catch {
    sum.errors++;
    await db.batch([note(db, s, nowIso, "error")]);
    return;
  }
  if (tx === null) {
    sum.notFound++;
    await db.batch([note(db, s, nowIso, "not_found")]);
    return;
  }
  const ours = transactionMatchesPayment(tx, {
    requestId: s.requestId,
    amountMinor: s.amountMinor,
    currency: s.currency,
    sourceExternalId: s.sourceExternalId,
  });
  if (!ours) {
    sum.alerts++;
    await db.batch([
      note(db, s, nowIso, "mismatch", {
        providerState: tx.state,
        transactionId: tx.id,
        alert: true,
      }),
    ]);
    return;
  }
  if (tx.state === "completed") {
    if (
      await applyMove(db, s, "paid", "bank_completed", nowIso, "paid", {
        providerId: tx.id,
        providerState: tx.state,
      })
    )
      sum.paid++;
  } else if (tx.state === "failed" || tx.state === "declined" || tx.state === "reverted") {
    if (
      await applyMove(db, s, "failed", `bank_${tx.state}`, nowIso, "failed", {
        providerId: tx.id,
        providerState: tx.state,
      })
    )
      sum.failed++;
  } else {
    // pending (or a state we do not know): not final. An unknown outcome is at least now known to exist.
    if (s.status === "outcome_unknown") {
      await applyMove(db, s, "submitted", "reconciled_pending", nowIso, "pending", {
        providerId: tx.id,
        providerState: tx.state,
      });
    } else {
      await db.batch([
        note(db, s, nowIso, "pending", { providerState: tx.state, transactionId: tx.id }),
      ]);
    }
    sum.pending++;
  }
}

async function viaDraft(
  db: D1Database,
  client: RevolutClient,
  s: Subject,
  nowIso: string,
  nowMs: number,
  expiryDays: number,
  sum: ReconcileSummary,
): Promise<void> {
  let view: PaymentDraftView | null = null;
  try {
    if (s.providerId !== null) {
      view = await client.getPaymentDraft(s.providerId);
    } else {
      const title = draftTitle(s.requestId);
      const hits = (await client.listPaymentDrafts()).filter((d) => d.title === title);
      if (hits.length > 1) {
        sum.alerts++;
        await db.batch([note(db, s, nowIso, "duplicate", { alert: true })]);
        return;
      }
      view = hits[0] ?? null;
    }
  } catch (e) {
    const notFound = (e as { status?: number } | null)?.status === 404;
    if (!notFound) {
      sum.errors++;
      await db.batch([note(db, s, nowIso, "error")]);
      return;
    }
  }
  if (view === null) {
    // Not found (a deleted draft, or one that was never created). Never moves by itself, except the
    // expiry of a draft we know about.
    if (s.providerId !== null && nowMs - Date.parse(s.updatedAt) > expiryDays * 86_400_000) {
      if (await applyMove(db, s, "failed", "draft_expired", nowIso, "draft_expired")) sum.failed++;
      return;
    }
    sum.notFound++;
    await db.batch([note(db, s, nowIso, "not_found")]);
    return;
  }
  let verdict = interpretDraft(view);
  if (verdict.kind === "paid" && verdict.transactionIds.length > 0) {
    // Review P9b: a draft's "completed" (A8) is not taken as the bank's final word when the draft
    // names its transactions: each one is read, and only `completed` on every one is paid.
    const bank = await draftTransactionsState(client, s, verdict.transactionIds);
    if (bank === "error") {
      sum.errors++;
      await db.batch([note(db, s, nowIso, "error")]);
      return;
    }
    if (bank === "mismatch") {
      sum.alerts++;
      await db.batch([
        note(db, s, nowIso, "mismatch", { providerState: "completed", alert: true }),
      ]);
      return;
    }
    if (bank === "pending") verdict = { kind: "pending" };
    else if (bank === "mixed") verdict = { kind: "mixed" };
    else if (bank !== "completed") verdict = { kind: "failed", code: bank };
  }
  if (verdict.kind === "paid") {
    const tx = verdict.transactionId;
    if (
      await applyMove(db, s, "paid", "bank_completed", nowIso, "paid", {
        providerId: s.providerId ?? view.id,
        providerState: "completed",
      })
    ) {
      sum.paid++;
      if (tx !== null) {
        await db.batch([note(db, s, nowIso, "paid", { transactionId: tx })]);
      }
    }
    return;
  }
  if (verdict.kind === "failed") {
    if (
      await applyMove(db, s, "failed", `bank_${verdict.code}`.slice(0, 40), nowIso, "failed", {
        providerId: s.providerId ?? view.id,
        providerState: verdict.code,
      })
    )
      sum.failed++;
    return;
  }
  if (verdict.kind === "mixed") {
    sum.alerts++;
    await db.batch([note(db, s, nowIso, "mismatch", { providerState: "mixed", alert: true })]);
    return;
  }
  // pending: the draft waits for the approval in the Revolut app
  if (s.status === "outcome_unknown") {
    await applyMove(db, s, "submitted", "reconciled_pending", nowIso, "pending", {
      providerId: view.id,
      providerState: view.state ?? "pending",
    });
    sum.pending++;
    return;
  }
  if (nowMs - Date.parse(s.updatedAt) > expiryDays * 86_400_000) {
    if (
      await applyMove(db, s, "failed", "draft_expired", nowIso, "draft_expired", {
        providerState: view.state ?? "pending",
      })
    )
      sum.failed++;
    return;
  }
  sum.pending++;
  await db.batch([note(db, s, nowIso, "pending", { providerState: view.state ?? "pending" })]);
}

/**
 * The bank state behind a "completed" draft: `completed` only when every named transaction is
 * completed (and, for a single payment, is our amount from our account); a refusal state when all
 * are refused; `mixed` when some are; `pending` otherwise. Read-only.
 */
async function draftTransactionsState(
  client: RevolutClient,
  s: Subject,
  ids: string[],
): Promise<
  "completed" | "pending" | "mixed" | "error" | "mismatch" | "failed" | "declined" | "reverted"
> {
  const states: string[] = [];
  for (const id of ids.slice(0, 50)) {
    let tx: RevolutTransaction;
    try {
      tx = await client.getTransaction(id);
    } catch {
      return "error";
    }
    if (
      s.kind === "payment" &&
      !transactionMatchesPayment(tx, {
        requestId: tx.requestId ?? s.requestId,
        amountMinor: s.amountMinor,
        currency: s.currency,
        sourceExternalId: s.sourceExternalId,
      })
    ) {
      return "mismatch";
    }
    states.push(tx.state);
  }
  const done = states.filter((x) => x === "completed").length;
  const bad = states.filter((x) => x === "failed" || x === "declined" || x === "reverted");
  if (done === states.length) return "completed";
  if (bad.length > 0 && done > 0) return "mixed";
  if (bad.length === states.length) return bad[0] as "failed" | "declined" | "reverted";
  return "pending";
}

// ---- the watch on expired drafts, bank links, reversals -----------------------------------------

async function watchExpiredDrafts(
  db: D1Database,
  client: RevolutClient,
  nowMs: number,
  sum: ReconcileSummary,
): Promise<void> {
  const since = new Date(nowMs - EXPIRED_WATCH_DAYS * 86_400_000).toISOString();
  // Single payments and (review P9b) bulk drafts of batches: both stay approvable in the app.
  for (const kind of ["payment", "batch"] as const) {
    const table = kind === "payment" ? "payments" : "payment_batches";
    const rows = await db
      .prepare(
        `SELECT p.id, p.request_id, p.provider_id FROM ${table} p
          WHERE p.mode = 'drafts' AND p.status = 'failed' AND p.status_reason = 'draft_expired'
            AND p.provider_id IS NOT NULL ${kind === "payment" ? "AND p.batch_id IS NULL" : ""}
            AND p.updated_at >= ?1
            AND NOT EXISTS (SELECT 1 FROM payment_reconcile r WHERE r.subject_kind = ?2
                             AND r.subject_id = p.id AND r.last_result = 'approved_after_expiry')
          ORDER BY p.id LIMIT 20`,
      )
      .bind(since, kind)
      .all<{ id: number; request_id: string; provider_id: string }>();
    for (const r of rows.results) {
      try {
        const v = interpretDraft(await client.getPaymentDraft(r.provider_id));
        if (v.kind === "paid" || v.kind === "mixed") {
          const nowIso = new Date(nowMs).toISOString();
          await db.batch([
            note(db, { kind, id: r.id }, nowIso, "approved_after_expiry", { alert: true }),
            auditStatement(db, {
              actorEmail: "system",
              action:
                kind === "payment"
                  ? "payment.approved_after_expiry"
                  : "payment_batch.approved_after_expiry",
              entity: kind === "payment" ? "payment" : "payment_batch",
              entityId: r.request_id,
              after: { providerId: r.provider_id },
            }),
          ]);
          sum.alerts++;
        }
      } catch {
        // a draft that is gone is fine; other failures are tried again next run
      }
    }
  }
}

/** Links paid payments to their bank line (the standard match then books it). Returns links made. */
export async function linkPaidPayments(db: D1Database, nowIso: string): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT p.id, t.id AS tx_id,
              CASE WHEN t.request_id = p.request_id THEN 'request_id' ELSE 'transaction_id' END AS via
         FROM payments p
         LEFT JOIN payment_reconcile r ON r.subject_kind = 'payment' AND r.subject_id = p.id
         JOIN bank_transactions t ON t.bank_account_id = p.bank_account_id
              AND t.currency = p.currency AND t.amount_minor = -p.amount_minor
              AND (t.request_id = p.request_id
                   OR t.external_id = COALESCE(r.transaction_id, p.provider_id))
        WHERE p.status = 'paid' AND p.batch_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM payment_bank_links l WHERE l.payment_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM payment_bank_links l WHERE l.bank_transaction_id = t.id)
        GROUP BY p.id LIMIT 50`,
    )
    .all<{ id: number; tx_id: number; via: string }>();
  let n = 0;
  for (const r of rows.results) {
    try {
      const out = await db.batch([
        db
          .prepare(
            "INSERT INTO payment_bank_links (payment_id, bank_transaction_id, via, linked_at) VALUES (?1, ?2, ?3, ?4)",
          )
          .bind(r.id, r.tx_id, r.via, nowIso),
        auditStatement(
          db,
          {
            actorEmail: "system",
            action: "payment.bank_line_linked",
            entity: "payment",
            entityId: String(r.id),
            after: { bankTransactionId: r.tx_id, via: r.via },
          },
          {
            sql: "EXISTS (SELECT 1 FROM payment_bank_links WHERE payment_id = ?7 AND bank_transaction_id = ?8)",
            binds: [r.id, r.tx_id],
          },
        ),
      ]);
      n += out[0]?.meta.changes ?? 0;
    } catch {
      // the DB refused (another amount or account, a race): leave it for a person
    }
  }
  return n;
}

/** A paid payment whose bank line later turned failed/reverted/declined: raised once, never reverted silently. */
async function flagReversals(db: D1Database, nowIso: string): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT p.id, p.request_id FROM payments p
         JOIN payment_bank_links l ON l.payment_id = p.id
         JOIN bank_transactions t ON t.id = l.bank_transaction_id
        WHERE p.status = 'paid' AND t.state IN ('reverted', 'failed', 'declined')
          AND NOT EXISTS (SELECT 1 FROM payment_reconcile r WHERE r.subject_kind = 'payment'
                           AND r.subject_id = p.id AND r.last_result = 'reverted_after_paid')
        LIMIT 20`,
    )
    .all<{ id: number; request_id: string }>();
  for (const r of rows.results) {
    await db.batch([
      note(db, { kind: "payment", id: r.id }, nowIso, "reverted_after_paid", { alert: true }),
      auditStatement(db, {
        actorEmail: "system",
        action: "payment.reverted_after_paid",
        entity: "payment",
        entityId: r.request_id,
      }),
    ]);
  }
  return rows.results.length;
}

// ---- the run -------------------------------------------------------------------------------------

export interface ReconcileDeps {
  db: D1Database;
  /** Created lazily: with nothing in flight no client (and no call) is needed. */
  client: () => Promise<RevolutClient>;
  nowMs: number;
}

export async function reconcilePayments(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const { db, nowMs } = deps;
  const nowIso = new Date(nowMs).toISOString();
  const sum = empty();
  await markStaleSubmissions(db, nowMs);
  const subjects = await loadSubjects(db);
  const since = new Date(nowMs - EXPIRED_WATCH_DAYS * 86_400_000).toISOString();
  const watch = await db
    .prepare(
      `SELECT 1 AS n WHERE EXISTS (SELECT 1 FROM payments WHERE status = 'failed' AND status_reason = 'draft_expired'
                                     AND provider_id IS NOT NULL AND batch_id IS NULL AND updated_at >= ?1)
                         OR EXISTS (SELECT 1 FROM payment_batches WHERE status = 'failed' AND status_reason = 'draft_expired'
                                     AND provider_id IS NOT NULL AND updated_at >= ?1)`,
    )
    .bind(since)
    .first();
  if (subjects.length > 0 || watch !== null) {
    const client = await deps.client();
    const expiryDays = await loadDraftExpiryDays(db);
    for (const s of subjects) {
      sum.checked++;
      if (s.mode === "pay") await viaTransaction(db, client, s, nowIso, sum);
      else await viaDraft(db, client, s, nowIso, nowMs, expiryDays, sum);
    }
    await watchExpiredDrafts(db, client, nowMs, sum);
  }
  sum.linked = await linkPaidPayments(db, nowIso);
  sum.alerts += await flagReversals(db, nowIso);
  return sum;
}

// ---- a person calls an unknown payment "not sent" -----------------------------------------------

export type ResolveResult = { ok: true } | { ok: false; code: string };

export async function resolveNotSent(
  db: D1Database,
  a: { kind: SubjectKind; id: number; actor: string; nowMs: number; confirm: unknown },
): Promise<ResolveResult> {
  if (typeof a.confirm !== "string" || !phraseMatches(a.confirm, PAYMENTS_RESOLVE_PHRASE)) {
    return { ok: false, code: "confirmation_required" };
  }
  const table = a.kind === "payment" ? "payments" : "payment_batches";
  const s = await db
    .prepare(
      `SELECT s.id, s.request_id, s.status, COALESCE(s.updated_at, s.created_at) AS updated_at,
              r.last_result, r.last_checked_at, r.not_found_checks
         FROM ${table} s LEFT JOIN payment_reconcile r ON r.subject_kind = ?2 AND r.subject_id = s.id
        WHERE s.id = ?1`,
    )
    .bind(a.id, a.kind)
    .first<{
      id: number;
      request_id: string;
      status: string;
      updated_at: string;
      last_result: string | null;
      last_checked_at: string | null;
      not_found_checks: number | null;
    }>();
  if (s === null) return { ok: false, code: "not_found" };
  if (s.status !== "outcome_unknown") return { ok: false, code: "not_unknown" };
  if (
    s.last_result !== "not_found" ||
    (s.not_found_checks ?? 0) < 1 ||
    s.last_checked_at === null ||
    a.nowMs - Date.parse(s.last_checked_at) > NOT_FOUND_FRESH_MS
  ) {
    return { ok: false, code: "lookup_not_fresh" };
  }
  if (a.nowMs - Date.parse(s.updated_at) < NOT_FOUND_MIN_AGE_MS) {
    return { ok: false, code: "too_soon" };
  }
  // Review P9b: the "not found" must come from a lookup made at least NOT_FOUND_MIN_AGE_MS after the
  // request became unknown (A6: a transfer can show up late); an early "not found" that is still
  // fresh is not enough.
  if (Date.parse(s.last_checked_at) - Date.parse(s.updated_at) < NOT_FOUND_MIN_AGE_MS) {
    return { ok: false, code: "lookup_too_early" };
  }
  const nowIso = new Date(a.nowMs).toISOString();
  const move = {
    kind: a.kind,
    id: a.id,
    requestId: s.request_id,
    from: "outcome_unknown" as const,
    to: "rejected" as const,
    actor: a.actor,
    code: "resolved_not_sent",
    nowIso,
    audit: {
      action:
        a.kind === "payment" ? "payment.resolved_not_sent" : "payment_batch.resolved_not_sent",
      after: { notFoundChecks: s.not_found_checks },
    },
  };
  try {
    const out = await db.batch([
      ...moveStatements(db, move),
      ...(a.kind === "batch" ? childMoveStatements(db, move) : []),
    ]);
    return (out[2]?.meta.changes ?? 0) === 1 ? { ok: true } : { ok: false, code: "conflict" };
  } catch {
    return { ok: false, code: "refused" };
  }
}

// ---- how far a paid payment is booked ---------------------------------------------------------

export type Settlement =
  | "not_paid"
  | "awaiting_bank_line"
  | "awaiting_match"
  | "match_other_invoice"
  | "awaiting_booking"
  | "booked";

/**
 * CLAUDE.md 4.3: "Paid" in the full sense needs the bank's confirmation AND the match booked in Exact.
 * `payments.status = 'paid'` is the bank's word; this says how far the second fact is.
 */
export async function paymentSettlement(db: D1Database, paymentId: number): Promise<Settlement> {
  const p = await db
    .prepare("SELECT status, open_item_id FROM payments WHERE id = ?1")
    .bind(paymentId)
    .first<{ status: string; open_item_id: number }>();
  if (p === null || p.status !== "paid") return "not_paid";
  const l = await db
    .prepare("SELECT bank_transaction_id FROM payment_bank_links WHERE payment_id = ?1")
    .bind(paymentId)
    .first<{ bank_transaction_id: number }>();
  if (l === null) return "awaiting_bank_line";
  const m = await db
    .prepare(
      `SELECT m.exact_state, EXISTS (SELECT 1 FROM match_allocations a WHERE a.match_id = m.id AND a.open_item_id = ?2) AS ours
         FROM matches m WHERE m.bank_transaction_id = ?1 AND m.undone_at IS NULL`,
    )
    .bind(l.bank_transaction_id, p.open_item_id)
    .all<{ exact_state: string; ours: number }>();
  if (m.results.length === 0) return "awaiting_match";
  if (!m.results.some((x) => x.ours === 1)) return "match_other_invoice";
  return m.results.some((x) => x.ours === 1 && x.exact_state === "matched_in_exact")
    ? "booked"
    : "awaiting_booking";
}

/**
 * `paymentSettlement` for many payments in ONE query (F9c review: the list pages read up to 100
 * payments, or 100 batches of up to 50 items; one lookup per row would be hundreds of queries).
 * Same rules, same answers (a test compares the two). Ids that are not `paid` are `not_paid`.
 * D1 allows 100 bound parameters: larger inputs are read in chunks.
 */
export async function paymentSettlements(
  db: D1Database,
  ids: readonly number[],
): Promise<Map<number, Settlement>> {
  const out = new Map<number, Settlement>();
  for (const id of ids) out.set(id, "not_paid");
  for (let at = 0; at < ids.length; at += 100) {
    const chunk = ids.slice(at, at + 100);
    const marks = chunk.map((_, i) => `?${i + 1}`).join(", ");
    const rows = await db
      .prepare(
        `SELECT p.id AS pid, l.bank_transaction_id AS bt, m.id AS mid, m.exact_state AS state,
                CASE WHEN m.id IS NULL THEN 0 ELSE EXISTS (
                  SELECT 1 FROM match_allocations a WHERE a.match_id = m.id AND a.open_item_id = p.open_item_id
                ) END AS ours
           FROM payments p
           LEFT JOIN payment_bank_links l ON l.payment_id = p.id
           LEFT JOIN matches m ON m.bank_transaction_id = l.bank_transaction_id AND m.undone_at IS NULL
          WHERE p.id IN (${marks}) AND p.status = 'paid'`,
      )
      .bind(...chunk)
      .all<{
        pid: number;
        bt: number | null;
        mid: number | null;
        state: string | null;
        ours: number;
      }>();
    const per = new Map<number, typeof rows.results>();
    for (const r of rows.results) per.set(r.pid, [...(per.get(r.pid) ?? []), r]);
    for (const [pid, rs] of per) {
      let s: Settlement;
      if (rs.every((r) => r.bt === null)) s = "awaiting_bank_line";
      else if (rs.every((r) => r.mid === null)) s = "awaiting_match";
      else if (!rs.some((r) => r.ours === 1)) s = "match_other_invoice";
      else
        s = rs.some((r) => r.ours === 1 && r.state === "matched_in_exact")
          ? "booked"
          : "awaiting_booking";
      out.set(pid, s);
    }
  }
  return out;
}
