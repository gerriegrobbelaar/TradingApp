/**
 * Supplier IBAN verification (Phase 9, P9a, ADR 0049; CLAUDE.md 4.4 "new or changed supplier bank
 * details always need a second approver"). An IBAN that arrived from the Exact sync is NOT trusted.
 * An approver confirms the exact IBAN (by its fingerprint, and by typing its last four characters,
 * which proves they looked at it); that is one append-only row. Exact changing the IBAN changes the
 * fingerprint, so the verification no longer covers it.
 */
import {
  assessIban,
  hasValidIbanChecksum,
  ibanFingerprint,
  maskIban,
  normalizeIban,
  PAYMENT_IBAN_MAX_AGE_MS,
  type IbanState,
} from "@camelthorn/core";
import { auditStatement } from "../db/audit";
import { readSupplierById } from "./iban-store";
import { PaymentError } from "./store";

export interface IbanStatusDto {
  relationId: number;
  name: string;
  isSupplier: boolean;
  /** Country, check digits and last four. Never the full IBAN. */
  ibanMasked: string | null;
  /** The identity of the IBAN as Exact holds it now (64 hex); what a verification must repeat. */
  ibanFingerprint: string | null;
  state: IbanState;
  verifiedBy: string | null;
  verifiedAt: string | null;
  /** When a complete bank-account read last saw this IBAN. */
  readAt: string | null;
}

async function latest(db: D1Database, relationId: number) {
  return db
    .prepare(
      `SELECT iban_fingerprint, kind, verified_by, verified_at FROM supplier_iban_verifications
        WHERE relation_id = ?1 ORDER BY id DESC LIMIT 1`,
    )
    .bind(relationId)
    .first<{
      iban_fingerprint: string;
      kind: "verified" | "revoked";
      verified_by: string;
      verified_at: string;
    }>();
}

/** The fingerprint key, or a refusal: without it no IBAN can be identified (fail closed). */
function requireKey(key: string | null): string {
  if (key === null) throw new PaymentError("iban_key_missing", 409);
  return key;
}

export async function ibanStatus(
  db: D1Database,
  relationId: number,
  who: string,
  ibanKey: string | null,
): Promise<IbanStatusDto> {
  const key = requireKey(ibanKey);
  const s = await readSupplierById(db, relationId);
  if (s === null) throw new PaymentError("not_found", 404);
  const v = await latest(db, relationId);
  const fpNow = s.iban === null ? null : ibanFingerprint(s.iban, key);
  const paid =
    fpNow === null
      ? false
      : (
          await db
            .prepare(
              "SELECT EXISTS (SELECT 1 FROM payments WHERE iban_fingerprint = ?1 AND status = 'paid') AS n",
            )
            .bind(fpNow)
            .first<{ n: number }>()
        )?.n === 1;
  const a = assessIban(
    {
      recordIban: s.iban,
      verification:
        v === null
          ? null
          : {
              fingerprint: v.iban_fingerprint,
              verifiedBy: v.verified_by,
              revoked: v.kind === "revoked",
            },
      paidBefore: paid,
      fingerprintKey: key,
    },
    who,
  );
  return {
    relationId,
    name: s.name,
    isSupplier: s.isSupplier,
    ibanMasked: s.iban === null || normalizeIban(s.iban) === "" ? null : maskIban(s.iban),
    ibanFingerprint: a.fingerprint,
    state: a.state,
    verifiedBy: v !== null && a.state.startsWith("verified") ? v.verified_by : null,
    verifiedAt: v !== null && a.state.startsWith("verified") ? v.verified_at : null,
    readAt: s.ibanReadAtMs === null ? null : new Date(s.ibanReadAtMs).toISOString(),
  };
}

export async function verifyIban(
  db: D1Database,
  a: {
    relationId: number;
    fingerprint: string;
    lastFour: string;
    actor: string;
    nowMs: number;
    ibanKey: string | null;
  },
): Promise<IbanStatusDto> {
  const key = requireKey(a.ibanKey);
  const s = await readSupplierById(db, a.relationId);
  if (s === null) throw new PaymentError("not_found", 404);
  if (!s.isSupplier) throw new PaymentError("not_a_supplier", 409);
  if (s.iban === null) throw new PaymentError("iban_missing", 409);
  const n = normalizeIban(s.iban);
  const fp = ibanFingerprint(s.iban, key);
  if (fp === null || !hasValidIbanChecksum(n)) throw new PaymentError("iban_invalid", 409);
  // The person looked at THIS IBAN: the fingerprint they saw is the one Exact holds now.
  if (a.fingerprint !== fp) throw new PaymentError("iban_changed", 409);
  if (a.lastFour.length !== 4 || a.lastFour.toUpperCase() !== n.slice(-4)) {
    throw new PaymentError("last_four_mismatch", 400);
  }
  // Never confirm an IBAN from an old read.
  if (s.ibanReadAtMs === null || a.nowMs - s.ibanReadAtMs > PAYMENT_IBAN_MAX_AGE_MS) {
    throw new PaymentError("iban_cache_stale", 409);
  }
  const cur = await latest(db, a.relationId);
  if (cur !== null && cur.kind === "verified" && cur.iban_fingerprint === fp) {
    return ibanStatus(db, a.relationId, a.actor, key); // already verified: nothing to write
  }
  const at = new Date(a.nowMs).toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO supplier_iban_verifications (division_id, relation_id, iban_fingerprint, kind, verified_by, verified_at)
         VALUES (?1, ?2, ?3, 'verified', ?4, ?5)`,
      )
      .bind(s.divisionId, a.relationId, fp, a.actor, at),
    auditStatement(
      db,
      {
        actorEmail: a.actor,
        action: "supplier_iban.verified",
        entity: "supplier_iban",
        entityId: a.relationId,
        before: {
          verifiedFingerprint: cur?.kind === "verified" ? cur.iban_fingerprint.slice(0, 16) : null,
        },
        after: { ibanMasked: maskIban(s.iban), ibanFingerprint: fp.slice(0, 16), supplier: s.name },
      },
      {
        sql: `EXISTS (SELECT 1 FROM supplier_iban_verifications WHERE relation_id = ?7 AND iban_fingerprint = ?8 AND kind = 'verified' AND verified_at = ?9)`,
        binds: [a.relationId, fp, at],
      },
    ),
  ]);
  return ibanStatus(db, a.relationId, a.actor, key);
}

export async function revokeIban(
  db: D1Database,
  a: { relationId: number; actor: string; nowMs: number; ibanKey: string | null },
): Promise<IbanStatusDto> {
  const key = requireKey(a.ibanKey);
  const s = await readSupplierById(db, a.relationId);
  if (s === null) throw new PaymentError("not_found", 404);
  const cur = await latest(db, a.relationId);
  if (cur === null || cur.kind === "revoked") throw new PaymentError("not_verified", 409);
  const at = new Date(a.nowMs).toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO supplier_iban_verifications (division_id, relation_id, iban_fingerprint, kind, verified_by, verified_at)
         VALUES (?1, ?2, ?3, 'revoked', ?4, ?5)`,
      )
      .bind(s.divisionId, a.relationId, cur.iban_fingerprint, a.actor, at),
    auditStatement(
      db,
      {
        actorEmail: a.actor,
        action: "supplier_iban.revoked",
        entity: "supplier_iban",
        entityId: a.relationId,
        before: {
          verifiedFingerprint: cur.iban_fingerprint.slice(0, 16),
          verifiedBy: cur.verified_by,
        },
        after: { supplier: s.name },
      },
      {
        sql: `EXISTS (SELECT 1 FROM supplier_iban_verifications WHERE relation_id = ?7 AND kind = 'revoked' AND verified_at = ?8)`,
        binds: [a.relationId, at],
      },
    ),
  ]);
  return ibanStatus(db, a.relationId, a.actor, key);
}
