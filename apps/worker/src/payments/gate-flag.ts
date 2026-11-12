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
 *      CURRENT paymentsProtocolVersion() (any rule or request-builder change voids it)
 * Reads of payment state (transaction lookup, draft view) do NOT need this: switching payments off
 * must never blind the reconciliation of what is already in flight.
 */
import { sameVerifyChecks } from "@camelthorn/core";
import { paymentsProtocolVersion } from "./protocol-version";

export const PAYMENTS_EXECUTION_VAR_ON = "on";

export interface VerificationMark {
  at: string;
  by: string;
  note: string;
  protocolVersion: string;
  checks: string[];
}

/** The mark from its stored JSON, or null when missing, malformed or incomplete. */
export function parseVerificationMark(raw: string | undefined): VerificationMark | null {
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

export type GateClosedReason =
  "execution_off" | "payments_disabled" | "not_verified" | "protocol_changed";

export type GateFlag = { open: true } | { open: false; reason: GateClosedReason };

export async function paymentWritesOpen(env: {
  DB: D1Database;
  REVOLUT_PAYMENTS_EXECUTION?: string | undefined;
}): Promise<GateFlag> {
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
  return { open: true };
}
