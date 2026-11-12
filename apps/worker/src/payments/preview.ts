/**
 * Preview payment: a DRY RUN (Phase 9, P9b, ADR 0050; the sibling of Preview booking, ADR 0044).
 *
 * For one payment or batch it builds the REAL request bodies with the REAL builders
 * (packages/revolut/src/payments.ts), puts them through the gate's own request validation, and
 * returns them with their SHA-256, so an admin can compare them with a sandbox call made by hand
 * before ticking the checklist (`amount_format_probe`, `reference_charset_probe`, ...). It makes NO
 * call: no gate, no client, no network, no lease. It needs neither the payments switch nor the
 * deploy switch, changes no state and stores nothing but one audit row (ids and hashes, no bodies).
 *
 * A body that carries an IBAN is returned with the IBAN masked (the hash is over the real bytes);
 * the full IBAN never leaves iban-store.ts.
 */
import { maskIban, sha256Hex } from "@camelthorn/core";
import {
  buildCreateCounterparty,
  buildPay,
  buildPaymentDraft,
  PAYMENT_JOB_ID,
  type BuiltRequest,
  type PaymentLeg,
} from "@camelthorn/revolut";
import { auditStatement } from "../db/audit";
import { validateRequest } from "../revolut/request";
import { readSendTargets, type SendTarget } from "./iban-store";
import { findPayee } from "./payees";
import type { SubjectKind } from "./transition";

/** Stands in for a payee that does not exist at Revolut yet (the real id comes from the first call). */
export const PREVIEW_PLACEHOLDER_COUNTERPARTY = "00000000-0000-4000-8000-000000000000";

export interface PreviewCall {
  step: "counterparty" | "pay" | "draft";
  method: "POST";
  path: string;
  /** The body as it would be sent, with any IBAN masked. */
  body: string;
  /** SHA-256 of the exact bytes that would be sent. */
  sha256: string;
  /** The gate's own validation accepted this request (path, job class, body keys). */
  gateAccepts: boolean;
  /** The payee does not exist yet: this call would come after creating it. */
  usesPlaceholderPayee: boolean;
}

export type PreviewResult =
  | { ok: true; mode: "drafts" | "pay"; requestId: string; calls: PreviewCall[] }
  | { ok: false; code: string };

function gateAccepts(b: BuiltRequest, ref: string): boolean {
  try {
    validateRequest({
      method: b.method,
      path: b.path,
      body: b.body,
      connectionId: 1,
      priority: "user",
      jobId: PAYMENT_JOB_ID,
      headers: { "Content-Type": "application/json" },
      paymentLease: "preview-lease-not-valid",
      paymentRef: ref,
    });
    return true;
  } catch {
    return false;
  }
}

const show = (b: BuiltRequest, iban?: string): string =>
  iban === undefined ? b.body : b.body.split(iban).join(maskIban(iban));

export async function previewPayment(
  db: D1Database,
  a: { kind: SubjectKind; id: number; actor: string; ibanKey: string | null },
): Promise<PreviewResult> {
  const table = a.kind === "payment" ? "payments" : "payment_batches";
  const head = await db
    .prepare(`SELECT request_id, mode FROM ${table} WHERE id = ?1`)
    .bind(a.id)
    .first<{ request_id: string; mode: "drafts" | "pay" }>();
  if (head === null) return { ok: false, code: "not_found" };
  const targets = await readSendTargets(db, a.kind, a.id, a.ibanKey);
  if (targets === null) return { ok: false, code: "iban_binding_broken" };
  const first = targets[0] as SendTarget;
  const connectionId = first.sourceConnectionId;
  const calls: PreviewCall[] = [];
  const legs: PaymentLeg[] = [];
  const seen = new Set<string>();
  let index = 0;
  try {
    for (const t of targets) {
      const payee = await findPayee(db, connectionId, t.ibanFingerprint);
      if (payee === null && !seen.has(t.ibanFingerprint)) {
        seen.add(t.ibanFingerprint);
        const cp = buildCreateCounterparty({
          name: t.beneficiaryName,
          iban: t.iban,
          currency: t.currency,
        });
        const ref = `cp-${head.request_id}-${index++}`;
        calls.push({
          step: "counterparty",
          method: "POST",
          path: cp.path,
          body: show(cp, t.iban),
          sha256: sha256Hex(cp.body),
          gateAccepts: gateAccepts(cp, ref),
          usesPlaceholderPayee: false,
        });
      }
      legs.push({
        accountId: t.sourceExternalId,
        counterpartyId: payee?.counterpartyId ?? PREVIEW_PLACEHOLDER_COUNTERPARTY,
        ...(payee?.accountId ? { receiverAccountId: payee.accountId } : {}),
        amountMinor: t.amountMinor,
        currency: t.currency,
        reference: t.reference,
      });
    }
    if (head.mode === "pay") {
      if (a.kind === "batch") return { ok: false, code: "batch_pay_unsupported" };
      const t = first;
      const leg = legs[0] as PaymentLeg;
      const pay = buildPay({ ...leg, requestId: t.requestId });
      calls.push({
        step: "pay",
        method: "POST",
        path: pay.path,
        body: pay.body,
        sha256: sha256Hex(pay.body),
        gateAccepts: gateAccepts(pay, t.requestId),
        usesPlaceholderPayee: leg.counterpartyId === PREVIEW_PLACEHOLDER_COUNTERPARTY,
      });
    } else {
      const d = buildPaymentDraft({ requestId: head.request_id, payments: legs });
      calls.push({
        step: "draft",
        method: "POST",
        path: d.path,
        body: d.body,
        sha256: sha256Hex(d.body),
        gateAccepts: gateAccepts(d, head.request_id),
        usesPlaceholderPayee: legs.some(
          (l) => l.counterpartyId === PREVIEW_PLACEHOLDER_COUNTERPARTY,
        ),
      });
    }
  } catch {
    // A builder refused the data (a reference, a name, an amount): that IS the finding.
    return { ok: false, code: "builder_refused" };
  }
  await db.batch([
    auditStatement(db, {
      actorEmail: a.actor,
      action: "payment.previewed",
      entity: a.kind === "payment" ? "payment" : "payment_batch",
      entityId: head.request_id,
      after: { mode: head.mode, hashes: calls.map((c) => ({ step: c.step, sha256: c.sha256 })) },
    }),
  ]);
  return { ok: true, mode: head.mode, requestId: head.request_id, calls };
}
