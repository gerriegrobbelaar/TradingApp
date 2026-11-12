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
 *  - A draft not approved after `payments.draft_expiry_days` becomes `failed` (`draft_expired`) ONLY
 *    while Revolut still shows it as pending. A known draft that answers "not found" never moves a
 *    payment (F9a, B3c): it stays `submitted` with a `draft_gone` alert. Only an admin ends it
 *    (`resolveNotSent`), past the expiry and with positive evidence that nothing was paid (a fresh,
 *    complete bank feed without a line of that account, amount and currency since it was sent).
 *    An expired draft stays on the watch list for 30 days so an approval after the expiry is raised.
 *  - A draft that says `completed` without naming a transaction for every payment is NOT `paid`
 *    (F9a, N8): the payment stays `submitted` and `draft_completed_unlinked` is raised.
 *  - Alerts (`mismatch`, `duplicate`, `approved_after_expiry`, `reverted_after_paid`, `draft_gone`,
 *    `draft_completed_unlinked`) are columns of `payment_reconcile`, write an audit row when raised,
 *    and are acknowledged with `ackAlert` (F9a, S1).
 *  - It keeps working while payments are switched OFF: switching off must not blind the lookup of
 *    what is already in flight. With nothing in flight it makes no call at all.
 */
import { phraseMatches, PAYMENTS_RESOLVE_PHRASE } from "@camelthorn/core";
import {
  draftTitle,
  revolutReference,
  type PaymentDraftView,
  type RevolutClient,
  type RevolutTransaction,
} from "@camelthorn/revolut";
import { auditStatement } from "../db/audit";
import { interpretDraft } from "./draft-state";
import { transactionMatchesPayment } from "./tx-match";
import { markStaleSubmissions } from "./submit";
import { childMoveStatements, moveStatements, TABLE, type SubjectKind } from "./transition";

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
  bankAccountId: number;
  updatedAt: string;
  createdAt: string;
  notFoundChecks: number;
  /** Payments in the request: 1, or the batch's item count. */
  itemCount: number;
}

async function loadSubjects(db: D1Database): Promise<Subject[]> {
  const out: Subject[] = [];
  for (const kind of ["payment", "batch"] as const) {
    const table = kind === "payment" ? "payments" : "payment_batches";
    const amount = kind === "payment" ? "s.amount_minor" : "s.total_minor";
    const rows = await db
      .prepare(
        `SELECT s.id, s.request_id, s.status, s.mode, s.provider_id, ${amount} AS amount_minor, s.currency,
                a.external_id, s.bank_account_id, COALESCE(s.updated_at, s.created_at) AS updated_at, s.created_at,
                COALESCE(r.not_found_checks, 0) AS nf, ${kind === "payment" ? "1" : "s.item_count"} AS item_count
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
        bank_account_id: number;
        updated_at: string;
        created_at: string;
        nf: number;
        item_count: number;
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
        bankAccountId: r.bank_account_id,
        updatedAt: r.updated_at,
        createdAt: r.created_at,
        notFoundChecks: r.nf,
        itemCount: r.item_count,
      });
    }
  }
  return out;
}

export type AlertKind =
  | "mismatch"
  | "duplicate"
  | "approved_after_expiry"
  | "reverted_after_paid"
  | "draft_gone"
  | "draft_completed_unlinked";

/**
 * The bookkeeping row. An alert is raised ONCE: while the current one is open, or acknowledged and of
 * the same kind, a later run leaves `alert_at/kind/ack` as they are; a DIFFERENT kind after an
 * acknowledgement raises again (and clears the acknowledgement). All SET expressions read the old row.
 */
function note(
  db: D1Database,
  s: Pick<Subject, "kind" | "id">,
  nowIso: string,
  result: ReconcileResult,
  extra: { providerState?: string | null; transactionId?: string | null; alert?: AlertKind } = {},
): D1PreparedStatement {
  const raise = `(alert_at IS NULL OR (alert_ack_at IS NOT NULL AND alert_kind IS NOT excluded.alert_kind))`;
  // Review F9a: an ACKNOWLEDGED alert is forgotten once a run sees the subject healthy again (a final
  // or pending answer, never an error or a "not found"), so the same condition coming back later is
  // raised (and audited) again. An alert nobody acknowledged stays open whatever the run sees.
  const clear = `(excluded.alert_kind IS NULL AND alert_ack_at IS NOT NULL
                  AND excluded.last_result IN ('pending', 'paid', 'failed', 'draft_expired', 'resolved'))`;
  return db
    .prepare(
      `INSERT INTO payment_reconcile (subject_kind, subject_id, first_checked_at, last_checked_at, checks,
                                      not_found_checks, last_result, provider_state, transaction_id, alert_at, alert_kind)
       VALUES (?1, ?2, ?3, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (subject_kind, subject_id) DO UPDATE SET
         last_checked_at = excluded.last_checked_at, checks = checks + 1,
         not_found_checks = not_found_checks + excluded.not_found_checks,
         last_result = excluded.last_result, provider_state = excluded.provider_state,
         transaction_id = COALESCE(excluded.transaction_id, transaction_id),
         alert_at = CASE WHEN excluded.alert_kind IS NOT NULL AND ${raise} THEN excluded.alert_at
                         WHEN ${clear} THEN NULL ELSE alert_at END,
         alert_ack_at = CASE WHEN excluded.alert_kind IS NOT NULL AND ${raise} THEN NULL
                             WHEN ${clear} THEN NULL ELSE alert_ack_at END,
         alert_ack_by = CASE WHEN excluded.alert_kind IS NOT NULL AND ${raise} THEN NULL
                             WHEN ${clear} THEN NULL ELSE alert_ack_by END,
         alert_kind = CASE WHEN excluded.alert_kind IS NOT NULL AND ${raise} THEN excluded.alert_kind
                           WHEN ${clear} THEN NULL ELSE alert_kind END`,
    )
    .bind(
      s.kind,
      s.id,
      nowIso,
      result === "not_found" ? 1 : 0,
      result,
      (extra.providerState ?? null)?.slice(0, 40) ?? null,
      extra.transactionId?.slice(0, 100) ?? null,
      extra.alert === undefined ? null : nowIso,
      extra.alert ?? null,
    );
}

/**
 * The bookkeeping row of a RAISED alert plus its audit row, in the order a batch needs. The audit row is
 * written only when this very run raised the alert (alert_at = now and the kind is the kind), so the
 * same open alert is audited once, however many runs see it again (F9a, S1).
 */
function alertStatements(
  db: D1Database,
  s: Pick<Subject, "kind" | "id" | "requestId">,
  nowIso: string,
  result: ReconcileResult,
  kind: AlertKind,
  extra: { providerState?: string | null; transactionId?: string | null } = {},
): D1PreparedStatement[] {
  const prefix = s.kind === "payment" ? "payment" : "payment_batch";
  return [
    note(db, s, nowIso, result, { ...extra, alert: kind }),
    auditStatement(
      db,
      {
        actorEmail: "system",
        action: `${prefix}.${kind}`,
        entity: prefix,
        entityId: s.requestId,
        after: { result, providerState: extra.providerState ?? null },
      },
      {
        sql: `EXISTS (SELECT 1 FROM payment_reconcile WHERE subject_kind = ?7 AND subject_id = ?8
                       AND alert_at = ?9 AND alert_kind = ?10)`,
        binds: [s.kind, s.id, nowIso, kind],
      },
    ),
  ];
}

/** What a completed draft says it paid: one entry per transaction (money that left OUR account). */
interface PaidTx {
  id: string;
  amountMinor: number;
  currency: string;
}

/** The move plus the bookkeeping row, as one batch. True when the state really moved. */
async function applyMove(
  db: D1Database,
  s: Subject,
  to: "submitted" | "paid" | "failed",
  code: string,
  nowIso: string,
  result: ReconcileResult,
  extra: { providerId?: string | null; providerState?: string | null; txs?: PaidTx[] } = {},
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
      }),
      // The transactions a completed draft named (B2): recorded only for a request that is `paid`
      // (the trigger insists), so a failed move writes none of them. A plain INSERT on purpose: if a
      // row is refused, the WHOLE batch is rolled back and the payment stays as it is for the next run
      // (OR IGNORE would skip a refused row silently and leave a paid batch that can never be linked).
      ...(to === "paid" ? (extra.txs ?? []) : []).map((t) =>
        db
          .prepare(
            `INSERT INTO payment_draft_transactions
               (subject_kind, subject_id, transaction_id, amount_minor, currency, recorded_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6
              WHERE EXISTS (SELECT 1 FROM ${TABLE[s.kind]} WHERE id = ?2 AND status = 'paid' AND updated_at = ?6)`,
          )
          .bind(s.kind, s.id, t.id.slice(0, 100), t.amountMinor, t.currency, nowIso),
      ),
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
    await db.batch(
      alertStatements(db, s, nowIso, "mismatch", "mismatch", {
        providerState: tx.state,
        transactionId: tx.id,
      }),
    );
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
        await db.batch(alertStatements(db, s, nowIso, "duplicate", "duplicate"));
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
    if (s.providerId !== null) {
      // A draft WE KNOW that Revolut now calls "not found": deleted in the app, or a lookup that
      // lies. "Not found" never moves a payment (F9a, B3c): the request stays `submitted` and a
      // person is told (`draft_gone`). Review F9a: not even with "evidence" from our own bank feed is
      // it failed automatically (a failed request makes the invoice payable again, and a feed can
      // miss a line); an admin ends it with `resolveNotSent`, which demands that evidence as well.
      sum.alerts++;
      await db.batch(alertStatements(db, s, nowIso, "not_found", "draft_gone"));
      return;
    }
    sum.notFound++;
    await db.batch([note(db, s, nowIso, "not_found")]);
    return;
  }
  let verdict = interpretDraft(view);
  let paidTxs: PaidTx[] = [];
  if (verdict.kind === "paid") {
    // N8: a draft that says "completed" must name one transaction for every payment we asked for.
    // Without them the bank's word is not confirmed and nothing can be linked to a bank line: the
    // request stays as it is and a person is told. It never becomes `paid` silently.
    if (
      verdict.paymentCount !== s.itemCount ||
      verdict.transactionIds.length !== s.itemCount ||
      new Set(verdict.transactionIds).size !== s.itemCount
    ) {
      sum.alerts++;
      await db.batch(
        alertStatements(db, s, nowIso, "mismatch", "draft_completed_unlinked", {
          providerState: "completed",
        }),
      );
      return;
    }
    // Review P9b: a draft's "completed" (A8) is not taken as the bank's final word: each named
    // transaction is read, and only `completed` on every one, in our amounts, is paid.
    const bank = await draftTransactionsState(db, client, s, verdict.transactionIds);
    if (bank.state === "error") {
      sum.errors++;
      await db.batch([note(db, s, nowIso, "error")]);
      return;
    }
    if (bank.state === "mismatch") {
      sum.alerts++;
      await db.batch(
        alertStatements(db, s, nowIso, "mismatch", "mismatch", { providerState: "completed" }),
      );
      return;
    }
    paidTxs = bank.txs;
    if (bank.state === "pending") verdict = { kind: "pending" };
    else if (bank.state === "mixed") verdict = { kind: "mixed" };
    else if (bank.state !== "completed") verdict = { kind: "failed", code: bank.state };
  }
  if (verdict.kind === "paid") {
    const tx = verdict.transactionId;
    if (
      await applyMove(db, s, "paid", "bank_completed", nowIso, "paid", {
        providerId: s.providerId ?? view.id,
        providerState: "completed",
        txs: paidTxs,
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
    await db.batch(
      alertStatements(db, s, nowIso, "mismatch", "mismatch", { providerState: "mixed" }),
    );
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
    // The provider id is kept (review F9a) so the watch on expired drafts can see a late approval.
    if (
      await applyMove(db, s, "failed", "draft_expired", nowIso, "draft_expired", {
        providerId: s.providerId ?? view.id,
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
type DraftBank =
  | { state: "error" | "mismatch"; txs: PaidTx[] }
  | {
      state: "completed" | "pending" | "mixed" | "failed" | "declined" | "reverted";
      txs: PaidTx[];
    };

async function draftTransactionsState(
  db: D1Database,
  client: RevolutClient,
  s: Subject,
  ids: string[],
): Promise<DraftBank> {
  const states: string[] = [];
  const txs: PaidTx[] = [];
  const source = s.sourceExternalId.toLowerCase();
  for (const id of ids) {
    let tx: RevolutTransaction;
    try {
      tx = await client.getTransaction(id);
    } catch {
      return { state: "error", txs: [] };
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
      return { state: "mismatch", txs: [] };
    }
    // The money that left OUR account in this transaction; a transaction without such a leg is not ours.
    const leg = tx.legs.find(
      (l) => l.accountId !== undefined && l.accountId.toLowerCase() === source && l.amountMinor < 0,
    );
    if (leg === undefined) return { state: "mismatch", txs: [] };
    txs.push({ id: tx.id, amountMinor: -leg.amountMinor, currency: leg.currency });
    states.push(tx.state);
  }
  // Review F9a: a transaction another request already recorded as ITS payment is not ours twice.
  if (txs.length === 0) return { state: "mismatch", txs: [] };
  const marks = txs.map((_, i) => `?${i + 3}`).join(", ");
  const taken = await db
    .prepare(
      `SELECT 1 AS n FROM payment_draft_transactions
        WHERE transaction_id IN (${marks}) AND NOT (subject_kind = ?1 AND subject_id = ?2) LIMIT 1`,
    )
    .bind(s.kind, s.id, ...txs.map((t) => t.id.slice(0, 100)))
    .first();
  if (taken !== null) return { state: "mismatch", txs: [] };
  // Our amounts, one for one (a batch: the multiset of its items). Anything else is reported, never believed.
  const expected = await db
    .prepare(
      s.kind === "payment"
        ? "SELECT amount_minor, currency FROM payments WHERE id = ?1"
        : "SELECT amount_minor, currency FROM payments WHERE batch_id = ?1",
    )
    .bind(s.id)
    .all<{ amount_minor: number; currency: string }>();
  const key = (a: number, c: string): string => `${c}:${a}`;
  const want = expected.results.map((r) => key(r.amount_minor, r.currency)).sort();
  const got = txs.map((t) => key(t.amountMinor, t.currency)).sort();
  if (want.length === 0 || want.length !== got.length || want.some((w, i) => w !== got[i])) {
    return { state: "mismatch", txs: [] };
  }
  const done = states.filter((x) => x === "completed").length;
  const bad = states.filter((x) => x === "failed" || x === "declined" || x === "reverted");
  if (done === states.length) return { state: "completed", txs };
  if (bad.length > 0 && done > 0) return { state: "mixed", txs };
  if (bad.length === states.length) {
    return { state: bad[0] as "failed" | "declined" | "reverted", txs };
  }
  return { state: "pending", txs };
}

/**
 * Positive evidence that a draft that Revolut no longer shows was never paid (F9a, B3c; tightened in
 * review F9a). ALL of:
 *  - the account's balance was read in the last 24 hours (`bank_accounts.balance_at`), AND
 *  - a COMPLETE transactions walk of the account's connection started after the draft was first seen
 *    gone (`revolut_sync_state.watermark >= goneSince`) and in the last 24 hours: the balance is read
 *    before the transactions, so a fresh balance alone does not prove the lines were read, AND
 *  - no line of this account and currency since the request was made (one day of slack) carries the
 *    amount of the request (any item of a batch), with or without its fee, unless that line is itself
 *    failed/declined/reverted. Any outgoing line of that amount counts, whoever it went to: a stranger's
 *    payment of the same amount makes this answer "not proven", which is the safe direction.
 * Absence of evidence is not evidence: anything stale or unreadable answers false. This is only ever
 * one of the conditions of a PERSON's decision (`resolveNotSent`), never a reason to fail by itself.
 */
export async function nothingPaidEvidence(
  db: D1Database,
  s: Pick<Subject, "kind" | "id" | "bankAccountId" | "createdAt">,
  nowMs: number,
  goneSince: string,
): Promise<boolean> {
  const dayAgo = new Date(nowMs - 24 * 3_600_000).toISOString();
  const fresh = await db
    .prepare(
      `SELECT 1 AS n FROM bank_accounts a
         JOIN revolut_sync_state st ON st.connection_id = a.connection_id AND st.entity = 'transactions'
        WHERE a.id = ?1 AND a.balance_at >= ?2 AND st.watermark >= ?2 AND st.watermark >= ?3`,
    )
    .bind(s.bankAccountId, dayAgo, goneSince)
    .first();
  if (fresh === null) return false;
  const since = new Date(Date.parse(s.createdAt) - 86_400_000).toISOString();
  const hit = await db
    .prepare(
      `SELECT 1 AS n FROM bank_transactions t JOIN payments p ON ${s.kind === "payment" ? "p.id" : "p.batch_id"} = ?1
        WHERE t.bank_account_id = p.bank_account_id AND t.currency = p.currency AND t.amount_minor < 0
          AND (-t.amount_minor = p.amount_minor
               OR -t.amount_minor = p.amount_minor + ABS(COALESCE(t.fee_minor, 0))
               OR -t.amount_minor + ABS(COALESCE(t.fee_minor, 0)) = p.amount_minor)
          AND t.state NOT IN ('failed', 'declined', 'reverted')
          AND t.booked_at >= ?2 LIMIT 1`,
    )
    .bind(s.id, since)
    .first();
  return hit === null;
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
          await db.batch(
            alertStatements(
              db,
              { kind, id: r.id, requestId: r.request_id },
              nowIso,
              "approved_after_expiry",
              "approved_after_expiry",
            ),
          );
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
                   OR t.external_id = COALESCE(r.transaction_id, p.provider_id)
                   OR t.external_id IN (SELECT d.transaction_id FROM payment_draft_transactions d
                                         WHERE d.subject_kind = 'payment' AND d.subject_id = p.id))
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

/**
 * B2: the items of a PAID batch are linked to their bank lines through the transactions the completed
 * draft named (`payment_draft_transactions`). The pairing is one to one and never guesses: an item
 * and a line are paired when they are the only ones of that amount, or (same amount, several of them)
 * when the line's reference is the item's reference and nobody else has it. Anything else stays
 * unlinked (`awaiting_bank_line`), which the settlement answer and the data-quality rule show. The
 * database repeats the account/currency/amount rule (payment_bank_links_guard_insert).
 */
/** The reference as the request builder sends it (or the stored text when it cannot be sent). */
function sentReference(raw: string): string {
  try {
    return revolutReference(raw);
  } catch {
    return raw;
  }
}

export async function linkBatchItems(db: D1Database, nowIso: string): Promise<number> {
  const batches = await db
    .prepare(
      `SELECT b.id FROM payment_batches b
        WHERE b.status = 'paid'
          AND EXISTS (SELECT 1 FROM payment_draft_transactions d WHERE d.subject_kind = 'batch' AND d.subject_id = b.id)
          AND EXISTS (SELECT 1 FROM payments p WHERE p.batch_id = b.id AND p.status = 'paid'
                       AND NOT EXISTS (SELECT 1 FROM payment_bank_links l WHERE l.payment_id = p.id))
        ORDER BY b.id LIMIT 20`,
    )
    .all<{ id: number }>();
  let n = 0;
  for (const b of batches.results) {
    const items = await db
      .prepare(
        `SELECT p.id, p.amount_minor, p.currency, p.reference FROM payments p
          WHERE p.batch_id = ?1 AND p.status = 'paid'
            AND NOT EXISTS (SELECT 1 FROM payment_bank_links l WHERE l.payment_id = p.id)
          ORDER BY p.id`,
      )
      .bind(b.id)
      .all<{ id: number; amount_minor: number; currency: string; reference: string }>();
    const lines = await db
      .prepare(
        `SELECT DISTINCT t.id, t.amount_minor, t.currency, t.reference
           FROM payment_draft_transactions d
           JOIN payment_batches pb ON pb.id = d.subject_id
           JOIN bank_transactions t ON t.external_id = d.transaction_id AND t.bank_account_id = pb.bank_account_id
                AND t.currency = d.currency AND t.amount_minor = -d.amount_minor
          WHERE d.subject_kind = 'batch' AND d.subject_id = ?1
            AND NOT EXISTS (SELECT 1 FROM payment_bank_links l WHERE l.bank_transaction_id = t.id)
          ORDER BY t.id`,
      )
      .bind(b.id)
      .all<{ id: number; amount_minor: number; currency: string; reference: string | null }>();
    const pairs: { paymentId: number; lineId: number }[] = [];
    const groupKey = (a: number, c: string): string => `${c}:${a}`;
    const groups = new Map<string, { items: typeof items.results; lines: typeof lines.results }>();
    for (const i of items.results) {
      const k = groupKey(i.amount_minor, i.currency);
      const g = groups.get(k) ?? { items: [], lines: [] };
      g.items.push(i);
      groups.set(k, g);
    }
    for (const l of lines.results) {
      const g = groups.get(groupKey(-l.amount_minor, l.currency));
      if (g) g.lines.push(l);
    }
    for (const g of groups.values()) {
      if (g.items.length === 1 && g.lines.length === 1) {
        pairs.push({
          paymentId: (g.items[0] as { id: number }).id,
          lineId: (g.lines[0] as { id: number }).id,
        });
        continue;
      }
      for (const item of g.items) {
        // The bank shows the reference as SENT (sanitised by `revolutReference`), so both forms count;
        // two items whose sent references are the same can never be told apart.
        const sent = sentReference(item.reference);
        const sameRef = g.lines.filter(
          (l) => l.reference !== null && (l.reference === item.reference || l.reference === sent),
        );
        const rivals = g.items.filter((o) => sentReference(o.reference) === sent);
        if (sameRef.length === 1 && rivals.length === 1) {
          pairs.push({ paymentId: item.id, lineId: (sameRef[0] as { id: number }).id });
        }
      }
    }
    for (const p of pairs) {
      try {
        const out = await db.batch([
          db
            .prepare(
              "INSERT INTO payment_bank_links (payment_id, bank_transaction_id, via, linked_at) VALUES (?1, ?2, 'transaction_id', ?3)",
            )
            .bind(p.paymentId, p.lineId, nowIso),
          auditStatement(
            db,
            {
              actorEmail: "system",
              action: "payment.bank_line_linked",
              entity: "payment",
              entityId: String(p.paymentId),
              after: { bankTransactionId: p.lineId, via: "transaction_id", batchId: b.id },
            },
            {
              sql: "EXISTS (SELECT 1 FROM payment_bank_links WHERE payment_id = ?7 AND bank_transaction_id = ?8)",
              binds: [p.paymentId, p.lineId],
            },
          ),
        ]);
        n += out[0]?.meta.changes ?? 0;
      } catch {
        // the database refused (another amount or account, a race): leave it for a person
      }
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
    await db.batch(
      alertStatements(
        db,
        { kind: "payment", id: r.id, requestId: r.request_id },
        nowIso,
        "reverted_after_paid",
        "reverted_after_paid",
      ),
    );
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
  sum.linked += await linkBatchItems(db, nowIso);
  sum.alerts += await flagReversals(db, nowIso);
  return sum;
}

// ---- a person calls an unknown payment "not sent" -----------------------------------------------

export type ResolveResult = { ok: true } | { ok: false; code: string };

/**
 * A person (admin, fresh sign-in, typed phrase) ends a request the bank never made:
 *  - `outcome_unknown` -> `rejected` (`resolved_not_sent`) after a fresh, late-enough "not found";
 *  - review F9a (B3c): a `submitted` DRAFT whose draft Revolut no longer shows (`draft_gone` alert,
 *    the last lookup a fresh "not found") -> `failed` (`draft_expired`), only past the draft expiry and
 *    only with positive evidence from the bank feed (`nothingPaidEvidence`). The reconciliation never
 *    does this on its own. `draft_expired` keeps the request on the watch for a late approval and in
 *    the earlier-attempt check of any new request for the same invoice.
 */
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
      `SELECT s.id, s.request_id, s.status, s.mode, s.provider_id, s.bank_account_id, s.created_at,
              COALESCE(s.updated_at, s.created_at) AS updated_at,
              r.last_result, r.last_checked_at, r.not_found_checks, r.alert_kind, r.alert_at
         FROM ${table} s LEFT JOIN payment_reconcile r ON r.subject_kind = ?2 AND r.subject_id = s.id
        WHERE s.id = ?1 ${a.kind === "payment" ? "AND s.batch_id IS NULL" : ""}`,
    )
    .bind(a.id, a.kind)
    .first<{
      id: number;
      request_id: string;
      status: string;
      mode: string;
      provider_id: string | null;
      bank_account_id: number;
      created_at: string;
      updated_at: string;
      last_result: string | null;
      last_checked_at: string | null;
      not_found_checks: number | null;
      alert_kind: string | null;
      alert_at: string | null;
    }>();
  if (s === null) return { ok: false, code: "not_found" };
  const goneDraft =
    s.status === "submitted" &&
    s.mode === "drafts" &&
    s.provider_id !== null &&
    s.alert_kind === "draft_gone" &&
    s.alert_at !== null;
  if (s.status !== "outcome_unknown" && !goneDraft) return { ok: false, code: "not_unknown" };
  if (
    s.last_result !== "not_found" ||
    (s.not_found_checks ?? 0) < 1 ||
    s.last_checked_at === null ||
    a.nowMs - Date.parse(s.last_checked_at) > NOT_FOUND_FRESH_MS
  ) {
    return { ok: false, code: "lookup_not_fresh" };
  }
  const nowIso = new Date(a.nowMs).toISOString();
  if (goneDraft) {
    const days = await loadDraftExpiryDays(db);
    if (!(a.nowMs - Date.parse(s.updated_at) > days * 86_400_000)) {
      return { ok: false, code: "draft_not_expired" };
    }
    const evidence = await nothingPaidEvidence(
      db,
      { kind: a.kind, id: s.id, bankAccountId: s.bank_account_id, createdAt: s.created_at },
      a.nowMs,
      s.alert_at as string,
    );
    if (!evidence) return { ok: false, code: "no_bank_evidence" };
    const move = {
      kind: a.kind,
      id: a.id,
      requestId: s.request_id,
      from: "submitted" as const,
      to: "failed" as const,
      actor: a.actor,
      code: "draft_expired",
      nowIso,
      audit: {
        action:
          a.kind === "payment"
            ? "payment.draft_gone_resolved"
            : "payment_batch.draft_gone_resolved",
        after: { notFoundChecks: s.not_found_checks, goneSince: s.alert_at },
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
  if (a.nowMs - Date.parse(s.updated_at) < NOT_FOUND_MIN_AGE_MS) {
    return { ok: false, code: "too_soon" };
  }
  // Review P9b: the "not found" must come from a lookup made at least NOT_FOUND_MIN_AGE_MS after the
  // request became unknown (A6: a transfer can show up late); an early "not found" that is still
  // fresh is not enough.
  if (Date.parse(s.last_checked_at) - Date.parse(s.updated_at) < NOT_FOUND_MIN_AGE_MS) {
    return { ok: false, code: "lookup_too_early" };
  }
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
  | "booked"
  /** The request expired locally, but the draft was approved in the Revolut app afterwards: money may have left. */
  | "approved_after_expiry"
  /** The bank line of a paid payment turned failed/reverted/declined afterwards: a person must look. */
  | "reverted_after_paid";

/**
 * CLAUDE.md 4.3: "Paid" in the full sense needs the bank's confirmation AND the match booked in Exact.
 * `payments.status = 'paid'` is the bank's word; this says how far the second fact is. It answers
 * honestly for the two cases where the status alone would mislead (F9a, S1): a draft approved after
 * its request expired (status `failed`, but money may have left) and a paid payment whose bank line
 * was reversed afterwards.
 */
export async function paymentSettlement(db: D1Database, paymentId: number): Promise<Settlement> {
  const p = await db
    .prepare("SELECT status, open_item_id, batch_id FROM payments WHERE id = ?1")
    .bind(paymentId)
    .first<{ status: string; open_item_id: number; batch_id: number | null }>();
  if (p === null) return "not_paid";
  const alert = await db
    .prepare(
      `SELECT alert_kind FROM payment_reconcile
        WHERE ((subject_kind = 'payment' AND subject_id = ?1) OR (subject_kind = 'batch' AND subject_id = ?2))
          AND alert_kind IN ('approved_after_expiry', 'reverted_after_paid')
        ORDER BY alert_at DESC LIMIT 1`,
    )
    .bind(paymentId, p.batch_id ?? 0)
    .first<{ alert_kind: string }>();
  if (p.status !== "paid") {
    return p.status === "failed" && alert?.alert_kind === "approved_after_expiry"
      ? "approved_after_expiry"
      : "not_paid";
  }
  if (alert?.alert_kind === "reverted_after_paid") return "reverted_after_paid";
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

// ---- a person acknowledges an alert ---------------------------------------------------------------

export type AckResult = { ok: true; kind: AlertKind } | { ok: false; code: string };

/**
 * A finance user or admin says they have looked at the OPEN alert of a payment or batch (F9a, S1).
 * It only records who and when (audited in the same batch); it moves no payment and fixes nothing.
 * A different kind of alert raised later is open again (see `note`). Compare-and-swap on the alert
 * that was read, so an alert raised in between is not acknowledged unseen.
 */
export async function ackAlert(
  db: D1Database,
  a: { kind: SubjectKind; id: number; actor: string; nowMs: number; note: string | null },
): Promise<AckResult> {
  const s = await db
    .prepare(`SELECT request_id FROM ${TABLE[a.kind]} WHERE id = ?1`)
    .bind(a.id)
    .first<{ request_id: string }>();
  if (s === null) return { ok: false, code: "not_found" };
  const r = await db
    .prepare(
      `SELECT alert_at, alert_kind, alert_ack_at FROM payment_reconcile
        WHERE subject_kind = ?1 AND subject_id = ?2`,
    )
    .bind(a.kind, a.id)
    .first<{
      alert_at: string | null;
      alert_kind: AlertKind | null;
      alert_ack_at: string | null;
    }>();
  if (r === null || r.alert_at === null || r.alert_kind === null) {
    return { ok: false, code: "no_alert" };
  }
  if (r.alert_ack_at !== null) return { ok: false, code: "already_acknowledged" };
  const nowIso = new Date(a.nowMs).toISOString();
  const prefix = a.kind === "payment" ? "payment" : "payment_batch";
  const out = await db.batch([
    db
      .prepare(
        `UPDATE payment_reconcile SET alert_ack_at = ?3, alert_ack_by = ?4
          WHERE subject_kind = ?1 AND subject_id = ?2 AND alert_at = ?5 AND alert_kind = ?6
            AND alert_ack_at IS NULL`,
      )
      .bind(a.kind, a.id, nowIso, a.actor.toLowerCase(), r.alert_at, r.alert_kind),
    auditStatement(
      db,
      {
        actorEmail: a.actor,
        action: `${prefix}.alert_acknowledged`,
        entity: prefix,
        entityId: s.request_id,
        before: { alertKind: r.alert_kind, alertAt: r.alert_at },
        after: { acknowledgedAt: nowIso, ...(a.note !== null ? { note: a.note } : {}) },
      },
      {
        sql: `changes() = 1 AND EXISTS (SELECT 1 FROM payment_reconcile WHERE subject_kind = ?7 AND subject_id = ?8
                                         AND alert_ack_at = ?9 AND alert_ack_by = ?10)`,
        binds: [a.kind, a.id, nowIso, a.actor.toLowerCase()],
      },
    ),
  ]);
  return (out[1]?.meta.changes ?? 0) === 1
    ? { ok: true, kind: r.alert_kind }
    : { ok: false, code: "conflict" };
}
