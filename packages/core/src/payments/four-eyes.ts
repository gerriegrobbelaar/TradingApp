/**
 * Four-eyes decisions (CLAUDE.md 4.4, ADR 0049). Pure.
 *
 *  - `requiredApprovals`: does this request/batch need a second person, and why?
 *  - `canApprove`: may THIS user approve it NOW?
 *  - `approvalStillValid`: is a stored approval still good (at submit time)?
 *
 * One second approver suffices; there is no count. An approver can never approve their own request.
 */
import { isAboveLimit, type EurAmount } from "./eur";
import type { IbanState } from "./iban-state";
import {
  APPROVAL_REASONS,
  PAYMENT_STEP_UP_MS,
  PAYMENT_VALIDITY_MS,
  type ApprovalReason,
  type PaymentSettings,
  type PaymentStatus,
} from "./types";

export interface RequiredInput {
  settings: Pick<
    PaymentSettings,
    "fourEyesEnabled" | "fourEyesLimitMinor" | "requireApprovalForNewIban"
  >;
  /**
   * The items: one for a single payment, one per invoice for a batch. `eur` is null when no rate
   * exists. `iban` is the trust state of the item's supplier IBAN.
   */
  items: readonly { eur: EurAmount | null; iban: IbanState }[];
  /** The total in EUR (sum of the items); null when any item has no EUR figure. */
  totalEur: EurAmount | null;
  isBatch: boolean;
}

export function requiredApprovals(input: RequiredInput): ApprovalReason[] {
  const out = new Set<ApprovalReason>();
  const { settings, items } = input;
  if (settings.fourEyesEnabled) {
    if (items.length === 0) out.add("above_limit"); // nothing to judge: never "no approval needed"
    if (items.some((i) => i.eur === null) || input.totalEur === null) {
      out.add("no_eur_rate");
    } else if (input.isBatch) {
      if (isAboveLimit(input.totalEur, settings.fourEyesLimitMinor)) {
        out.add("batch_total_above_limit");
      }
      if (items.some((i) => isAboveLimit(i.eur, settings.fourEyesLimitMinor))) {
        out.add("batch_item_above_limit");
      }
    } else if (isAboveLimit(input.totalEur, settings.fourEyesLimitMinor)) {
      out.add("above_limit");
    }
  }
  // Separate toggle, independent of the master switch and of the amount. An IBAN that is not an
  // established, verified one (including states the pre-check would block) always counts.
  if (settings.requireApprovalForNewIban && items.some((i) => i.iban !== "verified_established")) {
    out.add("new_or_changed_iban");
  }
  return APPROVAL_REASONS.filter((r) => out.has(r));
}

export type ApprovalDenial =
  | "not_pending"
  | "request_expired"
  | "self_approval"
  | "approver_lacks_role"
  | "approver_inactive"
  | "step_up_stale"
  | "payload_changed"
  | "approval_expired";

const norm = (e: string): string => e.trim().toLowerCase();

export interface ApproveInput {
  nowMs: number;
  request: {
    status: PaymentStatus;
    requestedBy: string;
    payloadHash: string;
    expiresAtMs: number;
  };
  /** The hash the approver's screen showed. */
  seenPayloadHash: string;
  approver: {
    email: string;
    roles: readonly string[];
    active: boolean;
    /** Last Google sign-in (auth_time), epoch ms. */
    lastAuthAtMs: number;
  };
}

/** Null = allowed. The first denial in a fixed order, so tests and the API are deterministic. */
export function canApprove(input: ApproveInput): ApprovalDenial | null {
  const { nowMs, request, approver } = input;
  if (request.status !== "pending_approval") return "not_pending";
  if (!(nowMs < request.expiresAtMs)) return "request_expired";
  if (norm(approver.email) === norm(request.requestedBy)) return "self_approval";
  if (!approver.active) return "approver_inactive";
  if (!approver.roles.includes("approver")) return "approver_lacks_role";
  if (
    !Number.isFinite(approver.lastAuthAtMs) ||
    approver.lastAuthAtMs > nowMs + 60_000 ||
    nowMs - approver.lastAuthAtMs > PAYMENT_STEP_UP_MS
  ) {
    return "step_up_stale";
  }
  if (input.seenPayloadHash !== request.payloadHash) return "payload_changed";
  return null;
}

export interface StoredApprovalCheck {
  nowMs: number;
  approval: { approverEmail: string; approvedAtMs: number; payloadHash: string };
  request: { requestedBy: string; payloadHash: string };
  /** The approver as the database knows them NOW (roles can be removed after approving). */
  approverNow: { roles: readonly string[]; active: boolean };
}

/** Re-checked when a request is about to be submitted. Null = the approval still counts. */
export function approvalStillValid(c: StoredApprovalCheck): ApprovalDenial | null {
  if (norm(c.approval.approverEmail) === norm(c.request.requestedBy)) return "self_approval";
  if (c.approval.payloadHash !== c.request.payloadHash) return "payload_changed";
  const age = c.nowMs - c.approval.approvedAtMs;
  if (!Number.isFinite(age) || age < -60_000 || age >= PAYMENT_VALIDITY_MS) {
    return "approval_expired";
  }
  if (!c.approverNow.active) return "approver_inactive";
  if (!c.approverNow.roles.includes("approver")) return "approver_lacks_role";
  return null;
}

/** Fresh sign-in within the step-up window (and not from the future beyond a clock difference). */
export function isStepUpRecent(lastAuthAtMs: number, nowMs: number): boolean {
  return (
    Number.isFinite(lastAuthAtMs) &&
    lastAuthAtMs <= nowMs + 60_000 &&
    nowMs - lastAuthAtMs <= PAYMENT_STEP_UP_MS
  );
}
