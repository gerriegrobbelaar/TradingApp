/**
 * The gate-side payment switch (Phase 9, P9b, ADR 0050). The RevolutGate reads it ITSELF, from D1,
 * at the door and again right before the network call, and never trusts a caller (ADR 0048,
 * invariant 3). It imports nothing but core: the gate must not depend on the payment routes.
 *
 * Payment WRITES through the gate need ALL of:
 *   1. the deploy switch: Workers var REVOLUT_PAYMENTS_EXECUTION is exactly "on"
 *   2. settings.payments.enabled is exactly the JSON value `true` (the one stored form: the P9a
 *      triggers read the same string; the task text said '1', the stored form is 'true')
 *   3. settings.payments.verified is a complete verification mark whose protocolVersion equals the
 *      CURRENT paymentsProtocolVersion() (any rule or request-builder change voids it).
 *      F9a (S3): a PROVISIONAL mark (`provisional: true`, any subset of the checks) is the staging
 *      drill's key: it counts only while EVERY active Revolut connection is in the sandbox, so it can
 *      never let a payment out of a production connection, whatever is stored.
 * Reads of payment state (transaction lookup, draft view) do NOT need this: switching payments off
 * must never blind the reconciliation of what is already in flight.
 */
import { PAYMENTS_VERIFY_CHECKS, sameVerifyChecks, verifyCoversMode } from "@camelthorn/core";
import { paymentsProtocolVersion } from "./protocol-version";

export const PAYMENTS_EXECUTION_VAR_ON = "on";

export interface VerificationMark {
  at: string;
  by: string;
  note: string;
  protocolVersion: string;
  checks: string[];
  /** A staging drill mark: valid only against sandbox Revolut connections (F9a, S3). */
  provisional: boolean;
}

/** Does the mark cover the mode? A provisional mark covers both (it exists only on the sandbox). */
export function markCoversMode(mark: VerificationMark, mode: "drafts" | "pay"): boolean {
  return mark.provisional || verifyCoversMode(mark.checks, mode);
}

/**
 * True when at least one Revolut connection is active and EVERY active one is in the sandbox
 * environment. Anything else (production, unknown, none) is false: a provisional mark then counts
 * for nothing. Read from D1 each time (the connection can change under a stored mark).
 */
export async function revolutIsSandboxOnly(db: D1Database): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN revolut_environment IS 'sandbox' THEN 0 ELSE 1 END) AS other
         FROM connections WHERE kind = 'revolut' AND status = 'active'`,
    )
    .first<{ n: number; other: number | null }>();
  return r !== null && r.n >= 1 && (r.other ?? 1) === 0;
}

/** The mark from its stored JSON, or null when missing, malformed or incomplete. */
export function parseVerificationMark(raw: string | undefined): VerificationMark | null {
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const checks = v["checks"];
    const provisional = v["provisional"] === true;
    const known: readonly string[] = PAYMENTS_VERIFY_CHECKS;
    if (
      typeof v["at"] === "string" &&
      typeof v["by"] === "string" &&
      typeof v["note"] === "string" &&
      typeof v["protocolVersion"] === "string" &&
      /^[0-9a-f]{64}$/.test(v["protocolVersion"]) &&
      Array.isArray(checks) &&
      (provisional
        ? new Set(checks).size === checks.length &&
          checks.every((c) => typeof c === "string" && known.includes(c))
        : sameVerifyChecks(checks))
    ) {
      return {
        at: v["at"],
        by: v["by"],
        note: v["note"],
        protocolVersion: v["protocolVersion"],
        checks: checks as string[],
        provisional,
      };
    }
  } catch {
    // unreadable: not verified
  }
  return null;
}

export type GateClosedReason =
  "execution_off" | "payments_disabled" | "not_verified" | "protocol_changed" | "pay_not_verified";

export type GateFlag = { open: true } | { open: false; reason: GateClosedReason };

/**
 * `forPay`: the request is a `POST /pay` (true one-click payment). Review P9b: the gate then also
 * needs the mark to cover the pay mode (`sandbox_pay_roundtrip`), so a drafts-only verification can
 * never let a direct payment through, whatever a caller or a stale `ready` request says.
 */
export async function paymentWritesOpen(
  env: {
    DB: D1Database;
    REVOLUT_PAYMENTS_EXECUTION?: string | undefined;
  },
  forPay = false,
): Promise<GateFlag> {
  if (env.REVOLUT_PAYMENTS_EXECUTION !== PAYMENTS_EXECUTION_VAR_ON) {
    return { open: false, reason: "execution_off" };
  }
  const rows = await env.DB.prepare(
    "SELECT key, value_json FROM settings WHERE key IN ('payments.enabled', 'payments.verified')",
  ).all<{ key: string; value_json: string }>();
  const by = new Map(rows.results.map((r) => [r.key, r.value_json]));
  if (by.get("payments.enabled") !== "true") return { open: false, reason: "payments_disabled" };
  const mark = parseVerificationMark(by.get("payments.verified"));
  if (mark === null) return { open: false, reason: "not_verified" };
  if (mark.protocolVersion !== paymentsProtocolVersion()) {
    return { open: false, reason: "protocol_changed" };
  }
  // A provisional (staging drill) mark opens nothing outside the sandbox.
  if (mark.provisional && !(await revolutIsSandboxOnly(env.DB))) {
    return { open: false, reason: "not_verified" };
  }
  if (forPay && !markCoversMode(mark, "pay")) {
    return { open: false, reason: "pay_not_verified" };
  }
  return { open: true };
}
