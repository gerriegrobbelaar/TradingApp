/**
 * Payment settings: parsing, validation and the "is this looser?" test (ADR 0049). Pure.
 *
 * A stored value that is missing or malformed means the DEFAULT, which is the strict choice
 * (four-eyes on, small limits, drafts, EUR only). Settings never fail open.
 */
import {
  DEFAULT_PAYMENT_SETTINGS,
  isPaymentMode,
  PAYMENT_MAX_MINOR,
  type PaymentSettings,
} from "./types";

export const PAYMENT_SETTINGS_KEY = "payments.settings";
/** JSON boolean, default false; only the strict JSON `true` counts. */
export const PAYMENTS_ENABLED_KEY = "payments.enabled";
/** JSON mark { at, by, note, checks } from the verification endpoint. */
export const PAYMENTS_VERIFIED_KEY = "payments.verified";

/**
 * What an admin ticks before the payments switch may go on (ADR 0049, extended by ADR 0050; the live
 * runbook is PAYMENTS_VERIFY_RUNBOOK in ./runbook, printed in docs/DEPLOY.md). One list for the
 * worker and the web. Order = order of the checklist.
 */
export const PAYMENTS_VERIFY_CHECKS = [
  "revolut_plan_known",
  "sandbox_counterparty_roundtrip",
  "counterparty_lookup_probe",
  "sandbox_draft_roundtrip",
  "draft_lifecycle_probe",
  "sandbox_pay_roundtrip",
  "request_id_idempotency_replay",
  "lost_answer_lookup_drill",
  "reference_charset_probe",
  "amount_format_probe",
  "webhook_state_sequence",
  "four_eyes_approver_accounts_checked",
  "first_iban_verified_out_of_band",
  "approval_mapping_verified_in_exact",
  "limits_reviewed_by_finance_lead",
] as const;
export type PaymentsVerifyCheck = (typeof PAYMENTS_VERIFY_CHECKS)[number];

/** Needed only for the `pay` mode (Company plan); in `drafts` mode a mark may leave it out. */
export const PAYMENTS_PAY_ONLY_CHECK: PaymentsVerifyCheck = "sandbox_pay_roundtrip";

/**
 * A mark's check list is valid when it holds every required code once and nothing else. The pay-only
 * check is optional here (a drafts-only installation never ticks it); `verifyCoversMode` decides
 * whether a mark is enough for a mode.
 */
export function sameVerifyChecks(list: readonly unknown[]): boolean {
  const seen = new Set<unknown>(list);
  if (seen.size !== list.length) return false;
  const all: readonly string[] = PAYMENTS_VERIFY_CHECKS;
  if (!list.every((c) => typeof c === "string" && all.includes(c))) return false;
  return all.every((c) => c === PAYMENTS_PAY_ONLY_CHECK || seen.has(c));
}

/** `pay` needs the direct-payment sandbox round trip as well; `drafts` does not. */
export function verifyCoversMode(list: readonly unknown[], mode: "drafts" | "pay"): boolean {
  return sameVerifyChecks(list) && (mode === "drafts" || list.includes(PAYMENTS_PAY_ONLY_CHECK));
}

const isMinor = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= PAYMENT_MAX_MINOR;
const CCY = /^[A-Z]{3}$/;

export type PaymentSettingsError =
  "bad_field" | "bad_limit" | "limits_inconsistent" | "bad_currencies" | "bad_mode";

const FIELDS = [
  "fourEyesEnabled",
  "fourEyesLimitMinor",
  "requireApprovalForNewIban",
  "maxRequestMinor",
  "maxDailyMinor",
  "allowPartial",
  "blockOnInsufficientBalance",
  "allowedCurrencies",
  "mode",
] as const;

/** Settings from a stored JSON string. Anything unusable falls back field by field to the default. */
export function parsePaymentSettings(raw: string | null | undefined): PaymentSettings {
  const d = DEFAULT_PAYMENT_SETTINGS;
  const out: PaymentSettings = { ...d, allowedCurrencies: [...d.allowedCurrencies] };
  if (typeof raw !== "string") return out;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return out;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return out;
  const r = v as Record<string, unknown>;
  if (typeof r["fourEyesEnabled"] === "boolean") out.fourEyesEnabled = r["fourEyesEnabled"];
  if (isMinor(r["fourEyesLimitMinor"])) out.fourEyesLimitMinor = r["fourEyesLimitMinor"];
  if (typeof r["requireApprovalForNewIban"] === "boolean") {
    out.requireApprovalForNewIban = r["requireApprovalForNewIban"];
  }
  if (isMinor(r["maxRequestMinor"])) out.maxRequestMinor = r["maxRequestMinor"];
  if (isMinor(r["maxDailyMinor"])) out.maxDailyMinor = r["maxDailyMinor"];
  if (typeof r["allowPartial"] === "boolean") out.allowPartial = r["allowPartial"];
  if (typeof r["blockOnInsufficientBalance"] === "boolean") {
    out.blockOnInsufficientBalance = r["blockOnInsufficientBalance"];
  }
  const cur = r["allowedCurrencies"];
  if (
    Array.isArray(cur) &&
    cur.length > 0 &&
    cur.every((c) => typeof c === "string" && CCY.test(c))
  ) {
    out.allowedCurrencies = [...new Set(cur as string[])];
  }
  if (isPaymentMode(r["mode"])) out.mode = r["mode"];
  // An inconsistent stored set (a limit above its ceiling) is tightened, never believed.
  out.maxRequestMinor = Math.min(out.maxRequestMinor, out.maxDailyMinor);
  out.fourEyesLimitMinor = Math.min(out.fourEyesLimitMinor, out.maxRequestMinor);
  return out;
}

export type PaymentSettingsPatchResult =
  | { ok: true; next: PaymentSettings; changed: string[]; loosened: string[] }
  | { ok: false; error: PaymentSettingsError };

/** Applies a partial change to the current settings. Unknown fields are the caller's to reject. */
export function applyPaymentSettingsPatch(
  current: PaymentSettings,
  patch: Record<string, unknown>,
): PaymentSettingsPatchResult {
  const next: PaymentSettings = { ...current, allowedCurrencies: [...current.allowedCurrencies] };
  for (const k of Object.keys(patch)) {
    if (!(FIELDS as readonly string[]).includes(k)) return { ok: false, error: "bad_field" };
  }
  const bool = (
    k:
      | "fourEyesEnabled"
      | "requireApprovalForNewIban"
      | "allowPartial"
      | "blockOnInsufficientBalance",
  ) => {
    const v = patch[k];
    if (v === undefined) return true;
    if (typeof v !== "boolean") return false;
    next[k] = v;
    return true;
  };
  if (
    !bool("fourEyesEnabled") ||
    !bool("requireApprovalForNewIban") ||
    !bool("allowPartial") ||
    !bool("blockOnInsufficientBalance")
  ) {
    return { ok: false, error: "bad_field" };
  }
  for (const k of ["fourEyesLimitMinor", "maxRequestMinor", "maxDailyMinor"] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (!isMinor(v)) return { ok: false, error: "bad_limit" };
    next[k] = v;
  }
  if (patch["allowedCurrencies"] !== undefined) {
    const c = patch["allowedCurrencies"];
    if (
      !Array.isArray(c) ||
      c.length < 1 ||
      c.length > 10 ||
      !c.every((x) => typeof x === "string" && CCY.test(x))
    ) {
      return { ok: false, error: "bad_currencies" };
    }
    next.allowedCurrencies = [...new Set(c as string[])];
  }
  if (patch["mode"] !== undefined) {
    if (!isPaymentMode(patch["mode"])) return { ok: false, error: "bad_mode" };
    next.mode = patch["mode"];
  }
  if (next.fourEyesLimitMinor > next.maxRequestMinor || next.maxRequestMinor > next.maxDailyMinor) {
    return { ok: false, error: "limits_inconsistent" };
  }
  const changed = FIELDS.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
  return { ok: true, next, changed, loosened: loosenedFields(current, next) };
}

/** Fields that moved in the permissive direction. Any of them needs the typed phrase and a fresh sign-in. */
export function loosenedFields(from: PaymentSettings, to: PaymentSettings): string[] {
  const out: string[] = [];
  if (from.fourEyesEnabled && !to.fourEyesEnabled) out.push("fourEyesEnabled");
  if (to.fourEyesLimitMinor > from.fourEyesLimitMinor) out.push("fourEyesLimitMinor");
  if (from.requireApprovalForNewIban && !to.requireApprovalForNewIban) {
    out.push("requireApprovalForNewIban");
  }
  if (to.maxRequestMinor > from.maxRequestMinor) out.push("maxRequestMinor");
  if (to.maxDailyMinor > from.maxDailyMinor) out.push("maxDailyMinor");
  if (!from.allowPartial && to.allowPartial) out.push("allowPartial");
  if (from.blockOnInsufficientBalance && !to.blockOnInsufficientBalance) {
    out.push("blockOnInsufficientBalance");
  }
  if (to.allowedCurrencies.some((c) => !from.allowedCurrencies.includes(c))) {
    out.push("allowedCurrencies");
  }
  if (from.mode === "drafts" && to.mode === "pay") out.push("mode");
  return out;
}
