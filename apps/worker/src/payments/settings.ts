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
  isIbanFingerprintKey,
  verifyCoversMode,
  parsePaymentSettings,
  PAYMENT_SETTINGS_KEY,
  PAYMENTS_ENABLED_KEY,
  PAYMENTS_VERIFIED_KEY,
  type PaymentSettings,
} from "@camelthorn/core";
import { readMappingCheck } from "../read/approvals-routes";
import { parseVerificationMark, type VerificationMark } from "./gate-flag";
import { paymentsProtocolVersion } from "./protocol-version";

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
  | "pay_mode_not_verified"
  | "no_revolut_connection"
  | "no_approver"
  | "iban_key_missing"
  | "payments_disabled";

export type { VerificationMark };

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
  /** The Workers secret PAYMENTS_IBAN_KEY is set and usable (its value is never kept here). */
  ibanKeyPresent: boolean;
}

/** The fingerprint key, or null when the secret is missing or too short (callers fail closed). */
export function ibanKeyOf(env: { PAYMENTS_IBAN_KEY?: string | undefined }): string | null {
  const k = env.PAYMENTS_IBAN_KEY;
  return isIbanFingerprintKey(k) ? k : null;
}

export async function loadPaymentsState(
  db: D1Database,
  ibanKey: string | null | undefined,
): Promise<PaymentsState> {
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
  const verified = parseVerificationMark(byKey.get(PAYMENTS_VERIFIED_KEY));
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
    ibanKeyPresent: isIbanFingerprintKey(ibanKey),
  };
}

/** What stops payments right now (empty = they may run). `submitterAvailable` comes from the submitter. */
export function paymentsBlockers(s: PaymentsState, submitterAvailable: boolean): PaymentsBlocker[] {
  const out: PaymentsBlocker[] = [];
  if (s.verified === null) out.push("not_verified");
  else if (s.protocolChanged) out.push("protocol_changed");
  if (!submitterAvailable) out.push("submitter_unavailable");
  // The direct-payment mode needs its own sandbox round trip in the mark (checklist item
  // sandbox_pay_roundtrip); drafts mode does not.
  if (
    s.settings.mode === "pay" &&
    (s.verified === null || !verifyCoversMode(s.verified.checks, "pay"))
  ) {
    out.push("pay_mode_not_verified");
  }
  if (!s.mappingVerified) out.push("approval_mapping_unverified");
  if (!s.revolutActive) out.push("no_revolut_connection");
  if (s.approverCount < 1) out.push("no_approver");
  if (!s.ibanKeyPresent) out.push("iban_key_missing");
  if (!s.enabled) out.push("payments_disabled");
  return out;
}

/**
 * Switch on AND a verification at the current protocol version AND the fingerprint key (what a
 * request must also see).
 */
export const paymentsPermitted = (
  s: Pick<PaymentsState, "enabled" | "verified" | "protocolChanged" | "ibanKeyPresent">,
): boolean => s.enabled && s.verified !== null && !s.protocolChanged && s.ibanKeyPresent;

export const UPSERT_SETTING = `INSERT INTO settings (key, value_json, updated_by) VALUES (?1, ?2, ?3)
  ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
