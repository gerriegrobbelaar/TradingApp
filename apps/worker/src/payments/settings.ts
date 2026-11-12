/**
 * The payments switch and settings (Phase 9, P9a, ADR 0049), fail-closed like booking (ADR 0044).
 *
 *  settings.payments.enabled   JSON boolean, default FALSE; only the strict JSON `true` counts.
 *  settings.payments.verified  JSON { at, by, note, protocolVersion, checks }: an admin recorded that
 *                              the payment path was verified on the Revolut sandbox, with every check of
 *                              PAYMENTS_VERIFY_CHECKS ticked. It counts only while its protocolVersion
 *                              equals the core `paymentsProtocolVersion()` (any rule change voids it).
 *  settings.payments.settings  JSON PaymentSettings (limits, four-eyes, currencies, mode). Missing or
 *                              malformed = the strict defaults.
 *
 * Payments run only when no blocker is left: the switch is on, the verification is current, a
 * submitter exists (P9b; `DisabledSubmitter` has none), the Exact approval mapping is verified, a
 * Revolut connection is active and at least one person holds the approver role.
 */
import {
  parsePaymentSettings,
  PAYMENT_SETTINGS_KEY,
  PAYMENTS_ENABLED_KEY,
  PAYMENTS_VERIFIED_KEY,
  paymentsProtocolVersion,
  sameVerifyChecks,
  type PaymentSettings,
} from "@camelthorn/core";
import { readMappingCheck } from "../read/approvals-routes";

export { PAYMENT_SETTINGS_KEY, PAYMENTS_ENABLED_KEY, PAYMENTS_VERIFIED_KEY };
export {
  PAYMENTS_ENABLE_PHRASE as ENABLE_PHRASE,
  PAYMENTS_LOOSEN_PHRASE as LOOSEN_PHRASE,
  PAYMENTS_VERIFY_PHRASE as VERIFY_PHRASE,
} from "@camelthorn/core";

export type PaymentsBlocker =
  | "not_verified"
  | "protocol_changed"
  | "submitter_unavailable"
  | "approval_mapping_unverified"
  | "no_revolut_connection"
  | "no_approver"
  | "payments_disabled";

export interface VerificationMark {
  at: string;
  by: string;
  note: string;
  protocolVersion: string;
  checks: string[];
}

export interface PaymentsState {
  enabled: boolean;
  settings: PaymentSettings;
  verified: VerificationMark | null;
  protocolVersion: string;
  protocolChanged: boolean;
  mappingVerified: boolean;
  revolutActive: boolean;
  /** The Revolut plan hint on the connection: only 'pay' (Company plan) may use one-click /pay. */
  connectionMode: "drafts" | "pay" | null;
  approverCount: number;
}

function parseVerified(raw: string | undefined): VerificationMark | null {
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const checks = v["checks"];
    if (
      typeof v["at"] === "string" &&
      typeof v["by"] === "string" &&
      typeof v["note"] === "string" &&
      typeof v["protocolVersion"] === "string" &&
      /^[0-9a-f]{64}$/.test(v["protocolVersion"]) &&
      Array.isArray(checks) &&
      sameVerifyChecks(checks)
    ) {
      return {
        at: v["at"],
        by: v["by"],
        note: v["note"],
        protocolVersion: v["protocolVersion"],
        checks: checks as string[],
      };
    }
  } catch {
    // unreadable: not verified
  }
  return null;
}

export async function loadPaymentsState(db: D1Database): Promise<PaymentsState> {
  const [settings, revolut, approvers] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT key, value_json FROM settings WHERE key IN (?1, ?2, ?3)")
      .bind(PAYMENTS_ENABLED_KEY, PAYMENTS_VERIFIED_KEY, PAYMENT_SETTINGS_KEY),
    db.prepare(
      "SELECT status, payments_mode FROM connections WHERE kind = 'revolut' ORDER BY id LIMIT 1",
    ),
    db.prepare(
      `SELECT COUNT(DISTINCT u.id) AS n FROM users u JOIN user_roles r ON r.user_id = u.id
        WHERE r.role = 'approver' AND u.disabled_at IS NULL`,
    ),
  ]);
  const byKey = new Map(
    (settings?.results ?? []).map((r) => [String(r["key"]), String(r["value_json"])]),
  );
  const verified = parseVerified(byKey.get(PAYMENTS_VERIFIED_KEY));
  const protocolVersion = paymentsProtocolVersion();
  const rev = revolut?.results?.[0];
  const mode = rev?.["payments_mode"];
  return {
    enabled: byKey.get(PAYMENTS_ENABLED_KEY) === "true",
    settings: parsePaymentSettings(byKey.get(PAYMENT_SETTINGS_KEY)),
    verified,
    protocolVersion,
    protocolChanged: verified !== null && verified.protocolVersion !== protocolVersion,
    mappingVerified: (await readMappingCheck(db)).verified,
    revolutActive: rev?.["status"] === "active",
    connectionMode: mode === "pay" || mode === "drafts" ? mode : null,
    approverCount: Number(approvers?.results?.[0]?.["n"] ?? 0),
  };
}

/** What stops payments right now (empty = they may run). `submitterAvailable` comes from the submitter. */
export function paymentsBlockers(s: PaymentsState, submitterAvailable: boolean): PaymentsBlocker[] {
  const out: PaymentsBlocker[] = [];
  if (s.verified === null) out.push("not_verified");
  else if (s.protocolChanged) out.push("protocol_changed");
  if (!submitterAvailable) out.push("submitter_unavailable");
  if (!s.mappingVerified) out.push("approval_mapping_unverified");
  if (!s.revolutActive) out.push("no_revolut_connection");
  if (s.approverCount < 1) out.push("no_approver");
  if (!s.enabled) out.push("payments_disabled");
  return out;
}

/** Switch on AND a verification at the current protocol version (what a request must also see). */
export const paymentsPermitted = (
  s: Pick<PaymentsState, "enabled" | "verified" | "protocolChanged">,
): boolean => s.enabled && s.verified !== null && !s.protocolChanged;

export const UPSERT_SETTING = `INSERT INTO settings (key, value_json, updated_by) VALUES (?1, ?2, ?3)
  ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
