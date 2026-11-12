/**
 * Payments API (Phase 9, P9a, ADR 0049). NOTHING HERE MOVES MONEY: a confirmed request ends at
 * `ready` and waits for P9b's submitter. Every write is audited in the same batch, every state move is
 * repeated by a database trigger, and no response carries a full IBAN (masked + a fingerprint only).
 *
 * Requests
 *  GET  /api/payments?status=open|all|<status>&mine=1&limit=&cursor=   any role
 *  POST /api/payments                {openItemId, sourceAccountId, amountMinor?, clientKey}   finance
 *       201 {payment, replayed:false, warnings} | 200 replay | 422 {error:'blocked', blocks, warnings}
 *  GET  /api/payments/:id                                     any role
 *  POST /api/payments/:id/confirm   {confirm}                 finance (the requester), fresh sign-in
 *  POST /api/payments/:id/approve   {payloadHash, note?}      approver, fresh sign-in, not the requester
 *  POST /api/payments/:id/reject    {payloadHash, note}       approver, fresh sign-in, not the requester
 *  POST /api/payments/:id/cancel    {reason?}                 finance (the requester) or admin
 *  the same under /api/payment-batches (create takes {sourceAccountId, items:[{openItemId, amountMinor?}], clientKey})
 * Supplier IBANs
 *  GET  /api/payments/ibans/:relationId                       finance, approver, admin
 *  POST /api/payments/ibans/verify  {relationId, fingerprint, lastFour}   approver, fresh sign-in
 *  POST /api/payments/ibans/revoke  {relationId}                          approver or admin, fresh sign-in
 * Settings (admin)
 *  GET  /api/settings/payments                                admin, finance, approver
 *  PATCH /api/settings/payments     {fields..., confirm?}     admin; a loosening needs a fresh sign-in AND the phrase
 *  POST /api/settings/payments/verify {confirm, checks, note} admin, fresh sign-in
 *  PUT  /api/settings/payments/switch {enabled, confirm?}     admin; enabling: fresh sign-in, phrase, verification
 */
import {
  APPROVAL_MAPPING_VERIFIED_SETTING,
  applyPaymentSettingsPatch,
  DEFAULT_PAYMENT_SETTINGS,
  isPaymentStatus,
  PAYMENT_BLOCK_CODES,
  PAYMENTS_VERIFY_CHECKS,
  phraseMatches,
  sameVerifyChecks,
} from "@camelthorn/core";
import { isStepUpFresh } from "../auth/session";
import { auditStatement } from "../db/audit";
import { json, type Ctx, type Router } from "../router";
import { actor, idParam, note, readBody, safely } from "./http";
import { ibanStatus, revokeIban, verifyIban } from "./iban-verify";
import { listBatches, listPayments, readBatch, readPayment, type ListFilter } from "./read";
import {
  ENABLE_PHRASE,
  LOOSEN_PHRASE,
  loadPaymentsState,
  paymentsBlockers,
  PAYMENT_SETTINGS_KEY,
  PAYMENTS_ENABLED_KEY,
  PAYMENTS_VERIFIED_KEY,
  UPSERT_SETTING,
  VERIFY_PHRASE,
} from "./settings";
import {
  cancelRequest,
  confirmRequest,
  createBatch,
  createPayment,
  decideRequest,
  expireStale,
  PaymentError,
} from "./store";
import { getSubmitter } from "./submit";
import type { SubjectKind } from "./transition";

const FINANCE = { roles: ["finance"] } as const;
const FINANCE_STEP_UP = { roles: ["finance"], stepUp: true } as const;
const APPROVER_STEP_UP = { roles: ["approver"], stepUp: true } as const;
const ADMIN = { roles: ["admin"] } as const;
const ADMIN_STEP_UP = { roles: ["admin"], stepUp: true } as const;
const ANY = { roles: ["admin", "finance", "approver", "viewer"] } as const;
const READERS = { roles: ["admin", "finance", "approver"] } as const;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function authMs(ctx: Ctx): number {
  const t = Date.parse(ctx.session?.lastAuthAt ?? "");
  return Number.isFinite(t) ? t : 0;
}

function listFilter(ctx: Ctx): ListFilter {
  const q = ctx.url.searchParams;
  const s = q.get("status") ?? "open";
  if (s !== "open" && s !== "all" && !isPaymentStatus(s)) throw new PaymentError("bad_status", 400);
  const rawLimit = q.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^[0-9]{1,3}$/.test(rawLimit)) throw new PaymentError("bad_limit", 400);
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIMIT) throw new PaymentError("bad_limit", 400);
  }
  const rawCursor = q.get("cursor");
  let cursorId: number | null = null;
  if (rawCursor !== null) {
    if (!/^[1-9][0-9]{0,15}$/.test(rawCursor)) throw new PaymentError("bad_cursor", 400);
    cursorId = Number(rawCursor);
  }
  return {
    status: s,
    requestedBy: q.get("mine") === "1" ? actor(ctx) : null,
    limit,
    cursorId,
  };
}

const positiveInt = (v: unknown, code: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new PaymentError(code, 400);
  return v;
};

const clientKey = (v: unknown): string => {
  if (typeof v !== "string" || !/^[A-Za-z0-9._:-]{8,100}$/.test(v)) {
    throw new PaymentError("bad_client_key", 400);
  }
  return v;
};

function optionalAmount(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  // Integer minor units only. A float, a string or an unsafe number is refused, never rounded.
  if (typeof v !== "number" || !Number.isSafeInteger(v))
    throw new PaymentError("amount_invalid", 400);
  return v;
}

// ---- requests -------------------------------------------------------------------------------------

function registerSubject(router: Router, kind: SubjectKind, base: string): void {
  const read = kind === "payment" ? readPayment : readBatch;
  const name = kind === "payment" ? "payment" : "batch";

  router.add(
    "GET",
    base,
    ANY,
    safely(async (ctx) => {
      await expireStale(ctx.env.DB, ctx.nowMs);
      const f = listFilter(ctx);
      const r =
        kind === "payment" ? await listPayments(ctx.env.DB, f) : await listBatches(ctx.env.DB, f);
      return json({
        items: r.items,
        nextCursor: r.nextCursor === null ? null : String(r.nextCursor),
      });
    }),
  );

  router.add(
    "GET",
    `${base}/:id`,
    ANY,
    safely(async (ctx) => {
      await expireStale(ctx.env.DB, ctx.nowMs);
      const dto = await read(ctx.env.DB, idParam(ctx));
      // A batch item is part of its batch: it has no page of its own.
      if (dto === null || (dto.kind === "payment" && dto.batchId !== null)) {
        throw new PaymentError("not_found", 404);
      }
      return json({ [name]: dto });
    }),
  );

  router.add(
    "POST",
    `${base}/:id/confirm`,
    FINANCE_STEP_UP,
    safely(async (ctx) => {
      const b = await readBody(ctx, ["confirm"]);
      if (typeof b["confirm"] !== "string") throw new PaymentError("confirmation_required", 400);
      const dto = await confirmRequest(ctx.env.DB, {
        kind,
        id: idParam(ctx),
        nowMs: ctx.nowMs,
        actor: actor(ctx),
        authAtMs: authMs(ctx),
        state: await loadPaymentsState(ctx.env.DB),
        phrase: b["confirm"],
      });
      return json({ [name]: dto });
    }),
  );

  for (const decision of ["approve", "reject"] as const) {
    router.add(
      "POST",
      `${base}/:id/${decision}`,
      APPROVER_STEP_UP,
      safely(async (ctx) => {
        const b = await readBody(ctx, ["payloadHash", "note"]);
        if (typeof b["payloadHash"] !== "string" || !/^[0-9a-f]{64}$/.test(b["payloadHash"])) {
          throw new PaymentError("payload_hash_required", 400);
        }
        const text =
          b["note"] === undefined
            ? decision === "reject"
              ? note(undefined, 3, 200, "note_required")
              : null
            : note(b["note"], decision === "reject" ? 3 : 1, 200, "bad_note");
        const dto = await decideRequest(ctx.env.DB, {
          kind,
          id: idParam(ctx),
          nowMs: ctx.nowMs,
          actor: actor(ctx),
          roles: ctx.session?.roles ?? [],
          authAtMs: authMs(ctx),
          seenPayloadHash: b["payloadHash"],
          decision: decision === "approve" ? "approved" : "rejected",
          note: text,
        });
        return json({ [name]: dto });
      }),
    );
  }

  router.add(
    "POST",
    `${base}/:id/cancel`,
    { roles: ["finance", "admin"] },
    safely(async (ctx) => {
      const b = await readBody(ctx, ["reason"]);
      const reason = b["reason"] === undefined ? null : note(b["reason"], 1, 200, "bad_reason");
      const dto = await cancelRequest(ctx.env.DB, {
        kind,
        id: idParam(ctx),
        nowMs: ctx.nowMs,
        actor: actor(ctx),
        isAdmin: ctx.session?.roles.includes("admin") === true,
        reason,
      });
      return json({ [name]: dto });
    }),
  );
}

// ---- settings -------------------------------------------------------------------------------------

async function settingsView(ctx: Ctx): Promise<Record<string, unknown>> {
  const state = await loadPaymentsState(ctx.env.DB);
  const submitter = getSubmitter();
  return {
    settings: state.settings,
    defaults: DEFAULT_PAYMENT_SETTINGS,
    enabled: state.enabled,
    verified: state.verified,
    protocolVersion: state.protocolVersion,
    protocolChanged: state.protocolChanged,
    connectionMode: state.connectionMode,
    approverCount: state.approverCount,
    submitterAvailable: submitter.available,
    blockers: paymentsBlockers(state, submitter.available),
    verifyChecks: PAYMENTS_VERIFY_CHECKS,
    blockCodes: PAYMENT_BLOCK_CODES,
  };
}

async function patchSettings(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const who = actor(ctx);
  const raw = await readBody(ctx, [
    "fourEyesEnabled",
    "fourEyesLimitMinor",
    "requireApprovalForNewIban",
    "maxRequestMinor",
    "maxDailyMinor",
    "allowPartial",
    "blockOnInsufficientBalance",
    "allowedCurrencies",
    "mode",
    "confirm",
    "note",
  ]);
  const { confirm, note: rawNote, ...fields } = raw;
  const why = rawNote === undefined ? null : note(rawNote, 1, 200, "bad_note");
  const state = await loadPaymentsState(db);
  const r = applyPaymentSettingsPatch(state.settings, fields);
  if (!r.ok) throw new PaymentError(r.error, 400);
  if (r.changed.length === 0) return json(await settingsView(ctx));
  if (r.loosened.length > 0) {
    // A control got weaker (a higher limit, four-eyes off, ...): fresh sign-in AND the typed phrase.
    if (!ctx.session || !isStepUpFresh(ctx.session, ctx.nowMs)) {
      throw new PaymentError("step_up_required", 401, { loosened: r.loosened });
    }
    if (typeof confirm !== "string" || !phraseMatches(confirm, LOOSEN_PHRASE)) {
      throw new PaymentError("confirmation_required", 400, { loosened: r.loosened });
    }
  }
  if (r.next.mode === "pay" && state.settings.mode !== "pay") {
    // True one-click /pay: only after the verification, and only if the Revolut plan allows it.
    if (state.verified === null || state.protocolChanged) {
      throw new PaymentError("mode_pay_requires_verification", 409);
    }
    if (state.connectionMode !== "pay") throw new PaymentError("plan_not_company", 409);
  }
  const before = JSON.stringify(state.settings);
  const after = JSON.stringify(r.next);
  const out = await db.batch([
    db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_by)
         SELECT ?1, ?2, ?3 WHERE COALESCE((SELECT value_json FROM settings WHERE key = ?1), ?4) = ?4
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .bind(PAYMENT_SETTINGS_KEY, after, who, await storedOrDefault(db, before)),
    auditStatement(
      db,
      {
        actorEmail: who,
        action: "payments.settings_changed",
        entity: "settings",
        entityId: PAYMENT_SETTINGS_KEY,
        before: state.settings,
        after: {
          ...r.next,
          changed: r.changed,
          loosened: r.loosened,
          ...(why !== null ? { note: why } : {}),
        },
      },
      {
        sql: "(SELECT value_json FROM settings WHERE key = ?7) = ?8",
        binds: [PAYMENT_SETTINGS_KEY, after],
      },
    ),
  ]);
  if ((out[1]?.meta.changes ?? 0) !== 1) throw new PaymentError("conflict", 409);
  return json(await settingsView(ctx));
}

/** The raw stored value (compare-and-swap), or the serialised defaults when nothing is stored. */
async function storedOrDefault(db: D1Database, fallback: string): Promise<string> {
  const r = await db
    .prepare("SELECT value_json FROM settings WHERE key = ?1")
    .bind(PAYMENT_SETTINGS_KEY)
    .first<{ value_json: string }>();
  return r?.value_json ?? fallback;
}

async function verifyHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const who = actor(ctx);
  const b = await readBody(ctx, ["confirm", "checks", "note"]);
  if (typeof b["confirm"] !== "string" || !phraseMatches(b["confirm"], VERIFY_PHRASE)) {
    throw new PaymentError("confirmation_required", 400);
  }
  if (!Array.isArray(b["checks"]) || !sameVerifyChecks(b["checks"])) {
    throw new PaymentError("checks_incomplete", 400);
  }
  const text = note(b["note"], 10, 500, "bad_note");
  const before = await loadPaymentsState(db);
  const mark = {
    at: new Date(ctx.nowMs).toISOString(),
    by: who,
    note: text,
    protocolVersion: before.protocolVersion,
    checks: [...PAYMENTS_VERIFY_CHECKS],
  };
  await db.batch([
    db.prepare(UPSERT_SETTING).bind(PAYMENTS_VERIFIED_KEY, JSON.stringify(mark), who),
    // A new verification always leaves payments OFF: switching on is a separate, typed decision.
    db.prepare(UPSERT_SETTING).bind(PAYMENTS_ENABLED_KEY, "false", who),
    auditStatement(db, {
      actorEmail: who,
      action: "payments.verified",
      entity: "settings",
      entityId: PAYMENTS_VERIFIED_KEY,
      before: { verifiedAt: before.verified?.at ?? null, enabled: before.enabled },
      after: {
        protocolVersion: mark.protocolVersion,
        note: text,
        checks: mark.checks,
        enabled: false,
      },
    }),
  ]);
  return json(await settingsView(ctx));
}

async function switchHandler(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const who = actor(ctx);
  const b = await readBody(ctx, ["enabled", "confirm", "note"]);
  if (typeof b["enabled"] !== "boolean") throw new PaymentError("bad_request", 400);
  const why = b["note"] === undefined ? null : note(b["note"], 1, 200, "bad_note");
  const before = await loadPaymentsState(db);
  if (!b["enabled"]) {
    // The safe direction: admin only, no step-up, no phrase. Audited.
    await db.batch([
      db.prepare(UPSERT_SETTING).bind(PAYMENTS_ENABLED_KEY, "false", who),
      auditStatement(db, {
        actorEmail: who,
        action: "payments.disabled",
        entity: "settings",
        entityId: PAYMENTS_ENABLED_KEY,
        before: { enabled: before.enabled },
        after: { enabled: false, ...(why !== null ? { note: why } : {}) },
      }),
    ]);
    return json(await settingsView(ctx));
  }
  if (!ctx.session || !isStepUpFresh(ctx.session, ctx.nowMs)) {
    throw new PaymentError("step_up_required", 401);
  }
  if (typeof b["confirm"] !== "string" || !phraseMatches(b["confirm"], ENABLE_PHRASE)) {
    throw new PaymentError("confirmation_required", 400);
  }
  const blockers = paymentsBlockers(before, getSubmitter().available).filter(
    (x) => x !== "payments_disabled",
  );
  if (blockers.length > 0) throw new PaymentError("blocked", 409, { blockers });
  // The conditions again, inside the write itself.
  const GUARD = `(SELECT value_json FROM settings WHERE key = ?5) = 'true'`;
  const out = await db.batch([
    db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_by)
         SELECT ?1, 'true', ?2
          WHERE ?5 = ?1 AND EXISTS (SELECT 1 FROM settings WHERE key = ?3 AND json_extract(value_json, '$.protocolVersion') = ?4)
            AND EXISTS (SELECT 1 FROM settings WHERE key = ?6)
            AND EXISTS (SELECT 1 FROM connections WHERE kind = 'revolut' AND status = 'active')
            AND EXISTS (SELECT 1 FROM users u JOIN user_roles r ON r.user_id = u.id
                         WHERE r.role = 'approver' AND u.disabled_at IS NULL)
         ON CONFLICT (key) DO UPDATE SET value_json = 'true', updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .bind(
        PAYMENTS_ENABLED_KEY,
        who,
        PAYMENTS_VERIFIED_KEY,
        before.protocolVersion,
        PAYMENTS_ENABLED_KEY,
        APPROVAL_MAPPING_VERIFIED_SETTING,
      ),
    auditStatement(
      db,
      {
        actorEmail: who,
        action: "payments.enabled",
        entity: "settings",
        entityId: PAYMENTS_ENABLED_KEY,
        before: { enabled: before.enabled },
        after: {
          enabled: true,
          protocolVersion: before.protocolVersion,
          mode: before.settings.mode,
          fourEyesEnabled: before.settings.fourEyesEnabled,
          fourEyesLimitMinor: before.settings.fourEyesLimitMinor,
          ...(why !== null ? { note: why } : {}),
        },
      },
      { sql: GUARD.replace("?5", "?7"), binds: [PAYMENTS_ENABLED_KEY] },
    ),
  ]);
  if ((out[1]?.meta.changes ?? 0) !== 1) {
    throw new PaymentError("blocked", 409, {
      blockers: paymentsBlockers(await loadPaymentsState(db), getSubmitter().available).filter(
        (x) => x !== "payments_disabled",
      ),
    });
  }
  return json(await settingsView(ctx));
}

// ---- registration ---------------------------------------------------------------------------------

export function registerPaymentRoutes(router: Router): void {
  // Supplier IBAN verification (declared before the generic /:id routes; the paths cannot clash).
  router.add(
    "GET",
    "/api/payments/ibans/:relationId",
    READERS,
    safely(async (ctx) =>
      json({ iban: await ibanStatus(ctx.env.DB, idParam(ctx, "relationId"), actor(ctx)) }),
    ),
  );
  router.add(
    "POST",
    "/api/payments/ibans/verify",
    APPROVER_STEP_UP,
    safely(async (ctx) => {
      const b = await readBody(ctx, ["relationId", "fingerprint", "lastFour"]);
      if (typeof b["fingerprint"] !== "string" || !/^[0-9a-f]{64}$/.test(b["fingerprint"])) {
        throw new PaymentError("bad_fingerprint", 400);
      }
      if (typeof b["lastFour"] !== "string") throw new PaymentError("last_four_mismatch", 400);
      return json({
        iban: await verifyIban(ctx.env.DB, {
          relationId: positiveInt(b["relationId"], "bad_relation"),
          fingerprint: b["fingerprint"],
          lastFour: b["lastFour"],
          actor: actor(ctx),
          nowMs: ctx.nowMs,
        }),
      });
    }),
  );
  router.add(
    "POST",
    "/api/payments/ibans/revoke",
    { roles: ["approver", "admin"], stepUp: true },
    safely(async (ctx) => {
      const b = await readBody(ctx, ["relationId"]);
      return json({
        iban: await revokeIban(ctx.env.DB, {
          relationId: positiveInt(b["relationId"], "bad_relation"),
          actor: actor(ctx),
          nowMs: ctx.nowMs,
        }),
      });
    }),
  );

  router.add(
    "POST",
    "/api/payments",
    FINANCE,
    safely(async (ctx) => {
      const b = await readBody(ctx, ["openItemId", "sourceAccountId", "amountMinor", "clientKey"]);
      const r = await createPayment(ctx.env.DB, {
        nowMs: ctx.nowMs,
        actor: actor(ctx),
        state: await loadPaymentsState(ctx.env.DB),
        openItemId: positiveInt(b["openItemId"], "bad_open_item"),
        sourceAccountId: positiveInt(b["sourceAccountId"], "bad_source_account"),
        amountMinor: optionalAmount(b["amountMinor"]),
        clientKey: clientKey(b["clientKey"]),
      });
      if (r.blocked) {
        return json({ error: "blocked", blocks: r.blocks, warnings: r.warnings }, 422);
      }
      return json(
        { payment: r.payment, replayed: r.replayed, warnings: r.warnings },
        r.replayed ? 200 : 201,
      );
    }),
  );
  registerSubject(router, "payment", "/api/payments");

  router.add(
    "POST",
    "/api/payment-batches",
    FINANCE,
    safely(async (ctx) => {
      const b = await readBody(ctx, ["sourceAccountId", "items", "clientKey"]);
      if (!Array.isArray(b["items"]) || b["items"].length === 0 || b["items"].length > 200) {
        throw new PaymentError("bad_items", 400);
      }
      const items = (b["items"] as unknown[]).map((x) => {
        if (x === null || typeof x !== "object" || Array.isArray(x))
          throw new PaymentError("bad_items", 400);
        const o = x as Record<string, unknown>;
        if (Object.keys(o).some((k) => k !== "openItemId" && k !== "amountMinor")) {
          throw new PaymentError("bad_items", 400);
        }
        return {
          openItemId: positiveInt(o["openItemId"], "bad_open_item"),
          amountMinor: optionalAmount(o["amountMinor"]),
        };
      });
      const r = await createBatch(ctx.env.DB, {
        nowMs: ctx.nowMs,
        actor: actor(ctx),
        state: await loadPaymentsState(ctx.env.DB),
        sourceAccountId: positiveInt(b["sourceAccountId"], "bad_source_account"),
        items,
        clientKey: clientKey(b["clientKey"]),
      });
      if (r.blocked) {
        return json({ error: "blocked", blocks: r.blocks, itemBlocks: r.itemBlocks }, 422);
      }
      return json({ batch: r.batch, replayed: r.replayed }, r.replayed ? 200 : 201);
    }),
  );
  registerSubject(router, "batch", "/api/payment-batches");

  router.add(
    "GET",
    "/api/settings/payments",
    READERS,
    safely(async (ctx) => json(await settingsView(ctx))),
  );
  router.add("PATCH", "/api/settings/payments", ADMIN, safely(patchSettings));
  router.add("POST", "/api/settings/payments/verify", ADMIN_STEP_UP, safely(verifyHandler));
  router.add("PUT", "/api/settings/payments/switch", ADMIN, safely(switchHandler));
}
