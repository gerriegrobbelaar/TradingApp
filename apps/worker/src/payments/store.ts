/**
 * Payment requests and batches: create, confirm, approve, reject, cancel, expire (Phase 9, P9a,
 * ADR 0049). NOTHING HERE SENDS MONEY. A confirmed request ends at `ready` and waits; the call
 * boundary is payments/submit.ts and is wired in P9b.
 *
 * Every write is one `db.batch` (change + event + audit, ADR 0013) whose statements are conditional
 * on the row still being in the state the decision was made on. The database repeats the rules with
 * triggers (migration 0028), so a bug in this file cannot skip an approval or move a state backwards.
 */
import {
  batchConfirmPhrase,
  canApprove,
  checkBatch,
  isStepUpRecent,
  maskIban,
  PAYMENT_BATCH_MAX_ITEMS,
  PAYMENT_CANCELLABLE_STATUSES,
  PAYMENT_VALIDITY_MS,
  paymentConfirmPhrase,
  paymentPayloadHash,
  phraseMatches,
  precheckPayment,
  requiredApprovals,
  type ApprovalDenial,
  type ApprovalReason,
  type BatchCheck,
  type BatchItemInput,
  type PaymentBlockCode,
  type PaymentPayload,
  type PaymentStatus,
  type PaymentWarningCode,
  type PayloadItem,
  type PrecheckResult,
} from "@camelthorn/core";
import { auditStatement } from "../db/audit";
import { gatherPrecheck, type Gathered } from "./facts";
import { insertPaymentStatement } from "./iban-store";
import { readBatch, readPayment, type BatchDto, type PaymentDto } from "./read";
import { paymentsPermitted, type PaymentsState } from "./settings";
import {
  childMoveStatements,
  dbErrorCode,
  moveStatements,
  TABLE,
  type SubjectKind,
} from "./transition";

export class PaymentError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 = 409,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ---- expiry ---------------------------------------------------------------------------------------

/**
 * Requests not confirmed, approved or sent within 24 hours become `expired`. Called before every read
 * that decides something (lazy: no job needed). Batches first (their items follow), then the rest.
 */
export async function expireStale(db: D1Database, nowMs: number): Promise<void> {
  const now = iso(nowMs);
  const PRE = "('draft', 'pending_approval', 'ready')";
  const due = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM payments WHERE status IN ${PRE} AND expires_at <= ?1)
            + (SELECT COUNT(*) FROM payment_batches WHERE status IN ${PRE} AND expires_at <= ?1) AS n`,
    )
    .bind(now)
    .first<{ n: number }>();
  if ((due?.n ?? 0) === 0) return;
  await db.batch([
    // events and audit rows first (they read the rows before the update changes them)
    db
      .prepare(
        `INSERT INTO payment_events (batch_id, from_status, to_status, code, actor, at)
         SELECT id, status, 'expired', 'expired', 'system', ?1 FROM payment_batches
          WHERE status IN ${PRE} AND expires_at <= ?1`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO audit_log (actor_email, action, entity, entity_id, before_json, after_json)
         SELECT 'system', 'payment_batch.expired', 'payment_batch', request_id,
                json_object('status', status), json_object('status', 'expired', 'code', 'expired')
           FROM payment_batches WHERE status IN ${PRE} AND expires_at <= ?1`,
      )
      .bind(now),
    db
      .prepare(
        `UPDATE payment_batches SET status = 'expired', status_reason = 'expired', updated_at = ?1
          WHERE status IN ${PRE} AND expires_at <= ?1`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO payment_events (payment_id, from_status, to_status, code, actor, at)
         SELECT id, status, 'expired', 'expired', 'system', ?1 FROM payments
          WHERE status IN ${PRE} AND expires_at <= ?1`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO audit_log (actor_email, action, entity, entity_id, before_json, after_json)
         SELECT 'system', 'payment.expired', 'payment', request_id,
                json_object('status', status), json_object('status', 'expired', 'code', 'expired')
           FROM payments WHERE status IN ${PRE} AND expires_at <= ?1 AND batch_id IS NULL`,
      )
      .bind(now),
    db
      .prepare(
        `UPDATE payments SET status = 'expired', status_reason = 'expired', updated_at = ?1
          WHERE status IN ${PRE} AND expires_at <= ?1`,
      )
      .bind(now),
  ]);
}

// ---- subjects -------------------------------------------------------------------------------------

interface SubjectRow {
  id: number;
  request_id: string;
  status: PaymentStatus;
  requested_by: string;
  payload_hash: string;
  approvals_required: string;
  currency: string;
  amount_minor: number;
  expires_at: string;
  bank_account_id: number;
  mode: "drafts" | "pay";
  // payments only (null for a batch)
  open_item_id: number | null;
  batch_id: number | null;
  reference: string | null;
  item_count: number | null;
}

async function loadSubject(
  db: D1Database,
  kind: SubjectKind,
  id: number,
): Promise<SubjectRow | null> {
  const sql =
    kind === "payment"
      ? `SELECT id, request_id, status, requested_by, payload_hash, approvals_required, currency,
                amount_minor, expires_at, bank_account_id, mode, open_item_id, batch_id, reference,
                NULL AS item_count FROM payments WHERE id = ?1`
      : `SELECT id, request_id, status, requested_by, payload_hash, approvals_required, currency,
                total_minor AS amount_minor, expires_at, bank_account_id, mode, NULL AS open_item_id,
                NULL AS batch_id, NULL AS reference, item_count FROM payment_batches WHERE id = ?1`;
  return db.prepare(sql).bind(id).first<SubjectRow>();
}

function subjectOrThrow(row: SubjectRow | null, kind: SubjectKind): SubjectRow {
  // A batch item is never addressed on its own: its batch is the unit of every decision.
  if (row === null || (kind === "payment" && row.batch_id !== null)) {
    throw new PaymentError("not_found", 404);
  }
  return row;
}

const storedReasons = (raw: string): ApprovalReason[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as ApprovalReason[]) : [];
  } catch {
    return [];
  }
};

// ---- create ---------------------------------------------------------------------------------------

export interface CreateArgs {
  nowMs: number;
  actor: string;
  state: PaymentsState;
  openItemId: number;
  sourceAccountId: number;
  amountMinor?: number | undefined;
  clientKey: string;
}

export interface Blocked {
  blocked: true;
  blocks: PaymentBlockCode[];
  warnings: PaymentWarningCode[];
}

export type CreateResult =
  | { blocked: false; payment: PaymentDto; replayed: boolean; warnings: PaymentWarningCode[] }
  | Blocked;

export async function createPayment(db: D1Database, a: CreateArgs): Promise<CreateResult> {
  await expireStale(db, a.nowMs);
  const existing = await db
    .prepare("SELECT id, open_item_id FROM payments WHERE requested_by = ?1 AND client_key = ?2")
    .bind(a.actor, a.clientKey)
    .first<{ id: number; open_item_id: number }>();
  if (existing !== null) {
    if (existing.open_item_id !== a.openItemId) throw new PaymentError("client_key_reused", 409);
    const p = await readPayment(db, existing.id);
    if (p === null) throw new PaymentError("not_found", 404);
    return { blocked: false, payment: p, replayed: true, warnings: [] };
  }

  const g = await gatherPrecheck(db, {
    nowMs: a.nowMs,
    state: a.state,
    requester: a.actor,
    openItemId: a.openItemId,
    sourceAccountId: a.sourceAccountId,
    requestedAmountMinor: a.amountMinor,
  });
  const pre = precheckPayment(g.input);
  if (!pre.ok || g.item === null || g.supplier === null || g.supplier.iban === null) {
    return { blocked: true, blocks: pre.blocks, warnings: pre.warnings };
  }
  const built = buildItem(g, pre);
  if (built === null) return { blocked: true, blocks: pre.blocks, warnings: pre.warnings };

  const requestId = crypto.randomUUID();
  const item: PayloadItem = { ...built.item, requestId };
  const payload: PaymentPayload = {
    kind: "payment",
    mode: a.state.settings.mode,
    sourceAccountId: a.sourceAccountId,
    currency: item.currency,
    totalMinor: item.amountMinor,
    items: [item],
  };
  const hash = paymentPayloadHash(payload);
  const reasons = requiredApprovals({
    settings: a.state.settings,
    items: [{ eur: pre.eur, iban: pre.ibanState }],
    totalEur: pre.eur,
    isBatch: false,
  });
  const now = iso(a.nowMs);
  try {
    await db.batch([
      insertPaymentStatement(db, {
        requestId,
        divisionId: g.item.divisionId,
        openItemId: g.item.id,
        batchRequestId: null,
        bankAccountId: a.sourceAccountId,
        mode: payload.mode,
        amountMinor: item.amountMinor,
        currency: item.currency,
        eurMinor: pre.eur?.minor ?? null,
        eurRate: pre.eur?.rate ?? null,
        beneficiaryName: g.supplier.name,
        iban: normalisedIban(g.supplier.iban),
        ibanFingerprint: item.ibanFingerprint,
        reference: item.reference,
        payloadHash: hash,
        approvalsRequired: JSON.stringify(reasons),
        requestedBy: a.actor,
        clientKey: a.clientKey,
        expiresAt: iso(a.nowMs + PAYMENT_VALIDITY_MS),
        createdAt: now,
      }),
      db
        .prepare(
          `INSERT INTO payment_events (payment_id, from_status, to_status, code, actor, at)
           SELECT id, NULL, 'draft', 'created', ?2, ?3 FROM payments WHERE request_id = ?1`,
        )
        .bind(requestId, a.actor, now),
      auditStatement(
        db,
        {
          actorEmail: a.actor,
          action: "payment.created",
          entity: "payment",
          entityId: requestId,
          after: {
            status: "draft",
            openItemId: g.item.id,
            amountMinor: item.amountMinor,
            currency: item.currency,
            ibanMasked: maskIban(g.supplier.iban),
            ibanFingerprint: item.ibanFingerprint.slice(0, 16),
            reference: item.reference,
            sourceAccountId: a.sourceAccountId,
            mode: payload.mode,
            approvalsRequired: reasons,
            ibanState: pre.ibanState,
            payloadHash: hash,
          },
        },
        { sql: "EXISTS (SELECT 1 FROM payments WHERE request_id = ?7)", binds: [requestId] },
      ),
    ]);
  } catch (err) {
    const code = dbErrorCode(err);
    if (code === "already_in_request") return blockedWith("already_in_request", pre);
    if (code === "payments_disabled") return blockedWith("payments_disabled", pre);
    if (code === "client_key_reused") throw new PaymentError("client_key_reused", 409);
    throw err;
  }
  const row = await db
    .prepare("SELECT id FROM payments WHERE request_id = ?1")
    .bind(requestId)
    .first<{ id: number }>();
  const dto = row === null ? null : await readPayment(db, row.id);
  if (dto === null) throw new PaymentError("not_found", 404);
  return { blocked: false, payment: dto, replayed: false, warnings: pre.warnings };
}

const blockedWith = (code: PaymentBlockCode, pre: PrecheckResult): Blocked => ({
  blocked: true,
  blocks: [code],
  warnings: pre.warnings,
});

function normalisedIban(iban: string): string {
  return iban
    .normalize("NFKC")
    .replace(/[\s\p{Cf}]+/gu, "")
    .toUpperCase();
}

function buildItem(
  g: Gathered,
  pre: PrecheckResult,
): { item: Omit<PayloadItem, "requestId"> } | null {
  if (
    g.item === null ||
    pre.amountMinor === null ||
    pre.currency === null ||
    pre.reference === null ||
    pre.ibanFingerprint === null
  ) {
    return null;
  }
  return {
    item: {
      openItemId: g.item.id,
      amountMinor: pre.amountMinor,
      currency: pre.currency,
      ibanFingerprint: pre.ibanFingerprint,
      reference: pre.reference,
    },
  };
}

// ---- batches --------------------------------------------------------------------------------------

export interface CreateBatchArgs {
  nowMs: number;
  actor: string;
  state: PaymentsState;
  sourceAccountId: number;
  items: { openItemId: number; amountMinor?: number | undefined }[];
  clientKey: string;
}

export type CreateBatchResult =
  | { blocked: false; batch: BatchDto; replayed: boolean }
  | {
      blocked: true;
      blocks: string[];
      itemBlocks: { openItemId: number; blocks: PaymentBlockCode[] }[];
    };

interface BatchEvaluation {
  check: BatchCheck;
  gathered: Gathered[];
  prechecks: PrecheckResult[];
}

async function evaluateBatch(
  db: D1Database,
  a: {
    nowMs: number;
    state: PaymentsState;
    actor: string;
    sourceAccountId: number;
    items: { openItemId: number; amountMinor?: number | undefined }[];
    excludeBatchId?: number;
  },
): Promise<BatchEvaluation> {
  const gathered: Gathered[] = [];
  const prechecks: PrecheckResult[] = [];
  for (const it of a.items.slice(0, PAYMENT_BATCH_MAX_ITEMS + 1)) {
    const g = await gatherPrecheck(db, {
      nowMs: a.nowMs,
      state: a.state,
      requester: a.actor,
      openItemId: it.openItemId,
      sourceAccountId: a.sourceAccountId,
      requestedAmountMinor: it.amountMinor,
      ...(a.excludeBatchId !== undefined ? { excludeBatchId: a.excludeBatchId } : {}),
    });
    const pre = precheckPayment(g.input);
    gathered.push(g);
    prechecks.push(pre);
  }
  const inputs: BatchItemInput[] = a.items.slice(0, gathered.length).map((it, i) => ({
    openItemId: it.openItemId,
    sourceAccountId: a.sourceAccountId,
    precheck: prechecks[i] as PrecheckResult,
  }));
  const first = gathered[0];
  const check = checkBatch(inputs, {
    settings: a.state.settings,
    dailyTotalEurMinor: first?.input.dailyTotalEurMinor ?? 0,
  });
  if (a.items.length > PAYMENT_BATCH_MAX_ITEMS && !check.blocks.includes("batch_too_large")) {
    check.blocks.push("batch_too_large");
    check.ok = false;
  }
  return { check, gathered, prechecks };
}

export async function createBatch(db: D1Database, a: CreateBatchArgs): Promise<CreateBatchResult> {
  await expireStale(db, a.nowMs);
  const existing = await db
    .prepare(
      "SELECT id, item_count FROM payment_batches WHERE requested_by = ?1 AND client_key = ?2",
    )
    .bind(a.actor, a.clientKey)
    .first<{ id: number; item_count: number }>();
  if (existing !== null) {
    const ids = (
      await db
        .prepare("SELECT open_item_id FROM payments WHERE batch_id = ?1 ORDER BY open_item_id")
        .bind(existing.id)
        .all<{ open_item_id: number }>()
    ).results.map((r) => r.open_item_id);
    const asked = [...new Set(a.items.map((i) => i.openItemId))].sort((x, y) => x - y);
    if (ids.length !== asked.length || ids.some((v, i) => v !== asked[i])) {
      throw new PaymentError("client_key_reused", 409);
    }
    const b = await readBatch(db, existing.id);
    if (b === null) throw new PaymentError("not_found", 404);
    return { blocked: false, batch: b, replayed: true };
  }

  const ev = await evaluateBatch(db, a);
  const { check, gathered, prechecks } = ev;
  const switchBlocks = paymentsPermitted(a.state) ? [] : ["payments_disabled"];
  if (
    !check.ok ||
    switchBlocks.length > 0 ||
    check.totalMinor === null ||
    check.currency === null
  ) {
    return {
      blocked: true,
      blocks: [...switchBlocks, ...check.blocks],
      itemBlocks: check.itemBlocks,
    };
  }

  const batchRequestId = crypto.randomUUID();
  const items: (PayloadItem & { g: Gathered; pre: PrecheckResult })[] = [];
  for (let i = 0; i < gathered.length; i++) {
    const g = gathered[i] as Gathered;
    const pre = prechecks[i] as PrecheckResult;
    const built = buildItem(g, pre);
    if (built === null || g.supplier?.iban == null) {
      return { blocked: true, blocks: ["batch_item_blocked"], itemBlocks: check.itemBlocks };
    }
    items.push({ ...built.item, requestId: crypto.randomUUID(), g, pre });
  }
  const payload: PaymentPayload = {
    kind: "batch",
    mode: a.state.settings.mode,
    sourceAccountId: a.sourceAccountId,
    currency: check.currency,
    totalMinor: check.totalMinor,
    items: items.map((i) => ({
      requestId: i.requestId,
      openItemId: i.openItemId,
      amountMinor: i.amountMinor,
      currency: i.currency,
      ibanFingerprint: i.ibanFingerprint,
      reference: i.reference,
    })),
  };
  const hash = paymentPayloadHash(payload);
  const reasons = requiredApprovals({
    settings: a.state.settings,
    items: items.map((i) => ({ eur: i.pre.eur, iban: i.pre.ibanState })),
    totalEur: check.totalEur,
    isBatch: true,
  });
  const now = iso(a.nowMs);
  const expires = iso(a.nowMs + PAYMENT_VALIDITY_MS);
  const first = items[0] as (typeof items)[number];
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO payment_batches (request_id, division_id, bank_account_id, mode, currency, total_minor,
             item_count, eur_minor, payload_hash, approvals_required, requested_by, client_key, expires_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
        )
        .bind(
          batchRequestId,
          first.g.item?.divisionId ?? 0,
          a.sourceAccountId,
          payload.mode,
          check.currency,
          check.totalMinor,
          items.length,
          check.totalEur?.minor ?? null,
          hash,
          JSON.stringify(reasons),
          a.actor,
          a.clientKey,
          expires,
          now,
        ),
      ...items.map((i) =>
        insertPaymentStatement(db, {
          requestId: i.requestId,
          divisionId: i.g.item?.divisionId ?? 0,
          openItemId: i.openItemId,
          batchRequestId,
          bankAccountId: a.sourceAccountId,
          mode: payload.mode,
          amountMinor: i.amountMinor,
          currency: i.currency,
          eurMinor: i.pre.eur?.minor ?? null,
          eurRate: i.pre.eur?.rate ?? null,
          beneficiaryName: i.g.supplier?.name ?? "",
          iban: normalisedIban(i.g.supplier?.iban ?? ""),
          ibanFingerprint: i.ibanFingerprint,
          reference: i.reference,
          payloadHash: paymentPayloadHash({
            kind: "payment",
            mode: payload.mode,
            sourceAccountId: a.sourceAccountId,
            currency: i.currency,
            totalMinor: i.amountMinor,
            items: [
              {
                requestId: i.requestId,
                openItemId: i.openItemId,
                amountMinor: i.amountMinor,
                currency: i.currency,
                ibanFingerprint: i.ibanFingerprint,
                reference: i.reference,
              },
            ],
          }),
          approvalsRequired: "[]",
          requestedBy: a.actor,
          clientKey: null,
          expiresAt: expires,
          createdAt: now,
        }),
      ),
      db
        .prepare(
          `INSERT INTO payment_events (batch_id, from_status, to_status, code, actor, at)
           SELECT id, NULL, 'draft', 'created', ?2, ?3 FROM payment_batches WHERE request_id = ?1`,
        )
        .bind(batchRequestId, a.actor, now),
      db
        .prepare(
          `INSERT INTO payment_events (payment_id, from_status, to_status, code, actor, at)
           SELECT id, NULL, 'draft', 'created', ?2, ?3 FROM payments
            WHERE batch_id = (SELECT id FROM payment_batches WHERE request_id = ?1)`,
        )
        .bind(batchRequestId, a.actor, now),
      auditStatement(
        db,
        {
          actorEmail: a.actor,
          action: "payment_batch.created",
          entity: "payment_batch",
          entityId: batchRequestId,
          after: {
            status: "draft",
            itemCount: items.length,
            totalMinor: check.totalMinor,
            currency: check.currency,
            sourceAccountId: a.sourceAccountId,
            mode: payload.mode,
            approvalsRequired: reasons,
            openItemIds: items.map((i) => i.openItemId),
            ibanFingerprints: items.map((i) => i.ibanFingerprint.slice(0, 16)),
            payloadHash: hash,
          },
        },
        {
          sql: "EXISTS (SELECT 1 FROM payment_batches WHERE request_id = ?7)",
          binds: [batchRequestId],
        },
      ),
    ]);
  } catch (err) {
    const code = dbErrorCode(err);
    if (code === "already_in_request") {
      return { blocked: true, blocks: ["already_in_request"], itemBlocks: [] };
    }
    if (code === "payments_disabled") {
      return { blocked: true, blocks: ["payments_disabled"], itemBlocks: [] };
    }
    if (code === "client_key_reused") throw new PaymentError("client_key_reused", 409);
    throw err;
  }
  const row = await db
    .prepare("SELECT id FROM payment_batches WHERE request_id = ?1")
    .bind(batchRequestId)
    .first<{ id: number }>();
  const dto = row === null ? null : await readBatch(db, row.id);
  if (dto === null) throw new PaymentError("not_found", 404);
  return { blocked: false, batch: dto, replayed: false };
}

// ---- confirm --------------------------------------------------------------------------------------

export interface ConfirmArgs {
  kind: SubjectKind;
  id: number;
  nowMs: number;
  actor: string;
  /** The session's last Google sign-in (the route also demands step-up). */
  authAtMs: number;
  state: PaymentsState;
  phrase: string;
}

/**
 * Draft -> pending_approval (a second person is needed) or ready. The person typed the phrase, the
 * pre-checks are run AGAIN on today's facts, the payload must be byte-for-byte what was shown, and the
 * approval requirement can only have stayed the same or grown. NEVER sends.
 */
export async function confirmRequest(
  db: D1Database,
  a: ConfirmArgs,
): Promise<PaymentDto | BatchDto> {
  await expireStale(db, a.nowMs);
  const row = subjectOrThrow(await loadSubject(db, a.kind, a.id), a.kind);
  if (row.requested_by !== a.actor) throw new PaymentError("not_requester", 403);
  if (row.status !== "draft") throw new PaymentError("not_draft", 409, { status: row.status });
  const expected =
    a.kind === "payment"
      ? paymentConfirmPhrase(row.amount_minor, row.currency)
      : batchConfirmPhrase(row.item_count ?? 0, row.amount_minor, row.currency);
  if (!phraseMatches(a.phrase, expected)) throw new PaymentError("confirmation_required", 400);
  if (!isStepUpRecent(a.authAtMs, a.nowMs)) throw new PaymentError("step_up_required", 401);
  if (!paymentsPermitted(a.state)) {
    throw new PaymentError("blocked", 422, { blocks: ["payments_disabled"] });
  }

  const reasons = await recheck(db, a, row);
  const target: PaymentStatus = reasons.length > 0 ? "pending_approval" : "ready";
  const code = target === "ready" ? "confirmed" : "confirmed_needs_approval";
  const nowIso = iso(a.nowMs);
  const move = {
    kind: a.kind,
    id: row.id,
    requestId: row.request_id,
    from: "draft" as const,
    to: target,
    actor: a.actor,
    code,
    nowIso,
    notExpired: true,
    set: { confirmed_at: nowIso, requester_auth_at: iso(a.authAtMs) },
    audit: {
      action: a.kind === "payment" ? "payment.confirmed" : "payment_batch.confirmed",
      after: { approvalsRequired: reasons, payloadHash: row.payload_hash },
    },
  };
  const stmts = [
    ...moveStatements(db, move),
    ...(a.kind === "batch" ? childMoveStatements(db, move) : []),
  ];
  const out = await runMove(db, stmts);
  if (!out) throw new PaymentError("conflict", 409);
  return (await readSubject(db, a.kind, row.id)) as PaymentDto | BatchDto;
}

/** Fresh pre-checks; returns the approval reasons now. Throws when anything is blocked or changed. */
async function recheck(db: D1Database, a: ConfirmArgs, row: SubjectRow): Promise<ApprovalReason[]> {
  const stored = storedReasons(row.approvals_required);
  const now = (reasons: ApprovalReason[]): ApprovalReason[] => {
    if (reasons.some((r) => !stored.includes(r))) {
      throw new PaymentError("controls_changed", 409);
    }
    return stored;
  };
  if (a.kind === "payment") {
    const g = await gatherPrecheck(db, {
      nowMs: a.nowMs,
      state: a.state,
      requester: a.actor,
      openItemId: row.open_item_id as number,
      sourceAccountId: row.bank_account_id,
      requestedAmountMinor: row.amount_minor,
      excludePaymentId: row.id,
    });
    const pre = precheckPayment(g.input);
    if (!pre.ok)
      throw new PaymentError("blocked", 422, { blocks: pre.blocks, warnings: pre.warnings });
    const built = buildItem(g, pre);
    if (built === null || g.item === null)
      throw new PaymentError("blocked", 422, { blocks: pre.blocks });
    const hash = paymentPayloadHash({
      kind: "payment",
      mode: row.mode,
      sourceAccountId: row.bank_account_id,
      currency: built.item.currency,
      totalMinor: built.item.amountMinor,
      items: [{ ...built.item, requestId: row.request_id }],
    });
    if (hash !== row.payload_hash) throw new PaymentError("payload_changed", 409);
    return now(
      requiredApprovals({
        settings: a.state.settings,
        items: [{ eur: pre.eur, iban: pre.ibanState }],
        totalEur: pre.eur,
        isBatch: false,
      }),
    );
  }
  const items = (
    await db
      .prepare(
        "SELECT open_item_id, amount_minor, request_id FROM payments WHERE batch_id = ?1 ORDER BY id",
      )
      .bind(row.id)
      .all<{ open_item_id: number; amount_minor: number; request_id: string }>()
  ).results;
  const ev = await evaluateBatch(db, {
    nowMs: a.nowMs,
    state: a.state,
    actor: a.actor,
    sourceAccountId: row.bank_account_id,
    items: items.map((i) => ({ openItemId: i.open_item_id, amountMinor: i.amount_minor })),
    excludeBatchId: row.id,
  });
  if (!ev.check.ok || ev.check.totalMinor === null || ev.check.currency === null) {
    throw new PaymentError("blocked", 422, {
      blocks: ev.check.blocks,
      itemBlocks: ev.check.itemBlocks,
    });
  }
  const payloadItems: PayloadItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const built = buildItem(ev.gathered[i] as Gathered, ev.prechecks[i] as PrecheckResult);
    if (built === null) throw new PaymentError("blocked", 422, { blocks: ["batch_item_blocked"] });
    payloadItems.push({
      ...built.item,
      requestId: (items[i] as { request_id: string }).request_id,
    });
  }
  const hash = paymentPayloadHash({
    kind: "batch",
    mode: row.mode,
    sourceAccountId: row.bank_account_id,
    currency: ev.check.currency,
    totalMinor: ev.check.totalMinor,
    items: payloadItems,
  });
  if (hash !== row.payload_hash) throw new PaymentError("payload_changed", 409);
  return now(
    requiredApprovals({
      settings: a.state.settings,
      items: ev.prechecks.map((p) => ({ eur: p.eur, iban: p.ibanState })),
      totalEur: ev.check.totalEur,
      isBatch: true,
    }),
  );
}

/** Runs a move; true when its audit row (index 2) was written, i.e. the state really changed. */
async function runMove(db: D1Database, stmts: D1PreparedStatement[]): Promise<boolean> {
  let out: D1Result[];
  try {
    out = await db.batch(stmts);
  } catch (err) {
    const code = dbErrorCode(err);
    if (code === "approver_role") throw new PaymentError("approver_lacks_role", 403);
    if (code !== null) throw new PaymentError(code, 409);
    throw err;
  }
  return (out[2]?.meta.changes ?? 0) === 1;
}

async function readSubject(
  db: D1Database,
  kind: SubjectKind,
  id: number,
): Promise<PaymentDto | BatchDto | null> {
  return kind === "payment" ? readPayment(db, id) : readBatch(db, id);
}

// ---- approve / reject -----------------------------------------------------------------------------

export interface DecideArgs {
  kind: SubjectKind;
  id: number;
  nowMs: number;
  actor: string;
  roles: readonly string[];
  authAtMs: number;
  seenPayloadHash: string;
  decision: "approved" | "rejected";
  note: string | null;
}

const DENIAL_STATUS: Record<ApprovalDenial, 401 | 403 | 409> = {
  not_pending: 409,
  request_expired: 409,
  self_approval: 403,
  approver_lacks_role: 403,
  approver_inactive: 403,
  step_up_stale: 401,
  payload_changed: 409,
  approval_expired: 409,
};

export async function decideRequest(db: D1Database, a: DecideArgs): Promise<PaymentDto | BatchDto> {
  await expireStale(db, a.nowMs);
  const row = subjectOrThrow(await loadSubject(db, a.kind, a.id), a.kind);
  const denial = canApprove({
    nowMs: a.nowMs,
    request: {
      status: row.status,
      requestedBy: row.requested_by,
      payloadHash: row.payload_hash,
      expiresAtMs: Date.parse(row.expires_at),
    },
    seenPayloadHash: a.seenPayloadHash,
    // The session was loaded from the database for this request: the user is active and holds
    // exactly these roles now. The insert trigger checks the role again, inside the write.
    approver: { email: a.actor, roles: a.roles, active: true, lastAuthAtMs: a.authAtMs },
  });
  if (denial !== null) {
    throw new PaymentError(
      denial === "step_up_stale" ? "step_up_required" : denial,
      DENIAL_STATUS[denial],
    );
  }
  const target: PaymentStatus = a.decision === "approved" ? "ready" : "rejected";
  const code = a.decision === "approved" ? "approved" : "approver_rejected";
  const nowIso = iso(a.nowMs);
  const col = a.kind === "payment" ? "payment_id" : "batch_id";
  const table = TABLE[a.kind];
  const move = {
    kind: a.kind,
    id: row.id,
    requestId: row.request_id,
    from: "pending_approval" as const,
    to: target,
    actor: a.actor,
    code,
    nowIso,
    notExpired: true,
    audit: {
      action: `${a.kind === "payment" ? "payment" : "payment_batch"}.${a.decision === "approved" ? "approved" : "rejected"}`,
      before: { requestedBy: row.requested_by },
      after: { payloadHash: row.payload_hash, ...(a.note !== null ? { note: a.note } : {}) },
    },
  };
  const [update, event, audit] = moveStatements(db, move) as [
    D1PreparedStatement,
    D1PreparedStatement,
    D1PreparedStatement,
  ];
  const insertApproval = db
    .prepare(
      `INSERT INTO payment_approvals (${col}, decision, payload_hash, requested_by, decided_by, approver_auth_at, note, decided_at)
       SELECT id, ?2, payload_hash, requested_by, ?3, ?4, ?5, ?6 FROM ${table}
        WHERE id = ?1 AND status = 'pending_approval' AND expires_at > ?6 AND payload_hash = ?7`,
    )
    .bind(row.id, a.decision, a.actor, iso(a.authAtMs), a.note, nowIso, a.seenPayloadHash);
  // Order matters: the approval first (the database's ready-guard looks for it), then the move.
  const stmts = [
    insertApproval,
    update,
    event,
    audit,
    ...(a.kind === "batch" ? childMoveStatements(db, move) : []),
  ];
  let out: D1Result[];
  try {
    out = await db.batch(stmts);
  } catch (err) {
    const c = dbErrorCode(err);
    if (c === "approver_role") throw new PaymentError("approver_lacks_role", 403);
    if (c !== null) throw new PaymentError(c, 409);
    throw err;
  }
  if ((out[3]?.meta.changes ?? 0) !== 1) throw new PaymentError("conflict", 409);
  return (await readSubject(db, a.kind, row.id)) as PaymentDto | BatchDto;
}

// ---- cancel ---------------------------------------------------------------------------------------

export interface CancelArgs {
  kind: SubjectKind;
  id: number;
  nowMs: number;
  actor: string;
  isAdmin: boolean;
  reason: string | null;
}

export async function cancelRequest(db: D1Database, a: CancelArgs): Promise<PaymentDto | BatchDto> {
  await expireStale(db, a.nowMs);
  const row = subjectOrThrow(await loadSubject(db, a.kind, a.id), a.kind);
  const byRequester = row.requested_by === a.actor;
  if (!byRequester && !a.isAdmin) throw new PaymentError("not_requester", 403);
  if (!PAYMENT_CANCELLABLE_STATUSES.includes(row.status)) {
    throw new PaymentError("not_cancellable", 409, { status: row.status });
  }
  const code = byRequester ? "cancelled_by_requester" : "cancelled_by_admin";
  const move = {
    kind: a.kind,
    id: row.id,
    requestId: row.request_id,
    from: row.status,
    to: "cancelled" as const,
    actor: a.actor,
    code,
    nowIso: iso(a.nowMs),
    audit: {
      action: a.kind === "payment" ? "payment.cancelled" : "payment_batch.cancelled",
      ...(a.reason !== null ? { after: { reason: a.reason } } : {}),
    },
  };
  const stmts = [
    ...moveStatements(db, move),
    ...(a.kind === "batch" ? childMoveStatements(db, move) : []),
  ];
  if (!(await runMove(db, stmts))) throw new PaymentError("conflict", 409);
  return (await readSubject(db, a.kind, row.id)) as PaymentDto | BatchDto;
}
