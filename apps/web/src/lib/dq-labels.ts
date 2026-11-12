/** Words for the Data health and Today screens (Phase 8, D8c). Sentence case, no exclamation marks. */
import {
  DQ_FIX_PATHS,
  type DqArea,
  type DqRuleStatusDto,
  type DqSeverity,
  type TodayItemDto,
  type TodayKind,
} from "@camelthorn/core";
import { ApiError } from "../api";

/** Checks older than this are called out: the hourly job has not run for a while. */
export const CHECKS_STALE_HOURS = 3;

/** True when the last finished check run is older than CHECKS_STALE_HOURS (or unreadable). */
export function checksStale(finishedAt: string | null, nowMs: number = Date.now()): boolean {
  const at = finishedAt === null ? NaN : Date.parse(finishedAt);
  return !Number.isFinite(at) || nowMs - at > CHECKS_STALE_HOURS * 3_600_000;
}

export const AREA_LABEL: Record<DqArea, string> = {
  bank: "Bank",
  payables: "Payables",
  receivables: "Receivables",
  master_data: "Master data",
  fx: "FX",
  ledger: "Ledger",
  integrations: "Integrations",
};

export const SEVERITY_LABEL: Record<DqSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

export const KIND_LABEL: Record<TodayKind, string> = {
  approval: "Approval",
  match: "Match",
  booking: "Booking",
  dq: "Data check",
};

type RuleState = DqRuleStatusDto["status"];

export const RULE_STATE_LABEL: Record<RuleState, string> = {
  ok: "Checked, no issues",
  issues: "Issues found",
  not_available: "Not available",
  not_configured: "Not set up",
  disabled: "Switched off",
  error: "Check failed",
  never_run: "Not run yet",
};

/** Only a rule that was really checked is ever shown as fine. */
export const RULE_STATE_TONE: Record<RuleState, "ok" | "warn" | "gold" | "neutral"> = {
  ok: "ok",
  issues: "warn",
  not_available: "gold",
  not_configured: "gold",
  disabled: "neutral",
  error: "warn",
  never_run: "neutral",
};

/** Reasons a rule could not be checked, from the server's machine codes. */
const REASONS: Record<string, string> = {
  rule_disabled: "An administrator switched this check off.",
  evaluator_failed: "The check failed in the last run. Nothing is known about it.",
  no_comparable_exact_balance:
    "There is no recent Exact balance to compare with the bank balance yet.",
  no_purchase_entries: "No purchase entries have been read from Exact yet.",
  document_flag_not_synced: "Exact has not reported whether bills have a PDF yet.",
  email_log_empty_until_phase_10: "Email delivery is not tracked yet. This arrives with reminders.",
  vat_code_not_synced: "VAT codes are not read from Exact yet.",
  no_closed_period_marker:
    "Locked periods are not recorded yet. This arrives with the close checklist.",
  no_suspense_accounts_configured:
    "No suspense account is chosen yet. An administrator can add its code in the rule settings.",
  no_revolut_connection: "Revolut is not connected.",
  no_exact_connection: "Exact is not connected.",
  source_never_synced: "The Exact sync has never completed for this administration.",
  source_stale: "The Exact data is older than 26 hours, so this check cannot vouch for it.",
};

export function reasonText(reason: string | null): string | null {
  if (reason === null) return null;
  if (Object.prototype.hasOwnProperty.call(REASONS, reason)) return REASONS[reason] as string;
  if (reason.endsWith("_not_loaded")) {
    return "The data for this check could not be read in the last run.";
  }
  // An unknown code is shown plainly rather than hidden.
  const plain = reason.replace(/[^a-z0-9]+/g, " ").trim();
  return plain ? `Reason: ${plain}.` : null;
}

const ERRORS: Record<string, string> = {
  not_open: "This issue is no longer open. The list shows the latest state.",
  already_resolved: "This issue was already resolved. The list shows the latest state.",
  not_found: "That issue no longer exists.",
  until_in_past: "Choose a time in the future.",
  until_too_far: "A snooze can last at most 90 days.",
  bad_until: "Choose how long to snooze.",
  bad_note: "Write a short note, at most 200 characters, without special characters.",
  confirmation_required:
    "Type the confirmation text exactly to lower the checks on a critical rule.",
  conflict: "Somebody changed this rule just now. Close the sheet and open it again.",
  bad_threshold: "That value is not allowed for this rule. Check the range.",
  bad_rev: "This rule changed. Close the sheet and open it again.",
  nothing_to_change: "Nothing was changed.",
  forbidden: "You do not have access to do this.",
};

/** A sentence for the person; never a raw server code. */
export function describeDqError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return ERRORS["forbidden"] as string;
    if (Object.prototype.hasOwnProperty.call(ERRORS, e.code)) return ERRORS[e.code] as string;
    if (e.status === 409) return "This changed in the meantime. The list shows the latest state.";
    if (e.status >= 500) return "The server could not do this. Nothing was changed. Try again.";
    return "Could not do this. Nothing was changed. Try again.";
  }
  return "Could not reach the server. Nothing was changed. Try again.";
}

/** A link target from the server, only if it is a path of this app (no scheme, no host). */
export function safeAppPath(p: string): string {
  return /^\/[A-Za-z0-9/_-]*(\?[A-Za-z0-9=&_-]*)?$/.test(p) && !p.startsWith("//")
    ? p
    : "/overview";
}

/**
 * Where a queue item's "Fix" or "Open" goes: the screen of DQ_FIX_PATHS for its `fix` key (own
 * keys only), never a path the server made up. The server's `fixPath` is used only when it IS that
 * screen with a plain query added (the suggested-matches tab); anything else falls back to the
 * screen itself, and an unknown key to the Overview.
 */
export function todayFixPath(item: Pick<TodayItemDto, "fix" | "fixPath">): string {
  if (!Object.hasOwn(DQ_FIX_PATHS, item.fix)) return "/overview";
  const screen = DQ_FIX_PATHS[item.fix];
  const p = item.fixPath;
  if (p === screen) return screen;
  if (p.startsWith(`${screen}?`) && safeAppPath(p) === p) return p;
  return screen;
}

export const SNOOZE_CHOICES: readonly { days: number; label: string }[] = [
  { days: 1, label: "1 day" },
  { days: 3, label: "3 days" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];
