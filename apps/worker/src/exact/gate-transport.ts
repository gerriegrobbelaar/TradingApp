import { ExactApiError, type ExactTransport } from "@camelthorn/exact";
import type { Env } from "../env";
import type { ExactGate } from "./gate";
import { unwrap, type GateResult } from "./wire";

/** Gate instance name for a division (0 = the "current division" gate used for /current/Me). */
export const gateName = (division: number): string => `exact:${division}`;

/**
 * The only way to reach an ExactGate instance (division gate `exact:<n>` or token authority
 * `exact-token:<id>`). Durable Object ids depend on the jurisdiction, so every stub must come from
 * the EU namespace (docs/decisions/0018). Never call `EXACT_GATE.idFromName` directly.
 */
export function getExactGate(
  env: Pick<Env, "EXACT_GATE" | "DO_JURISDICTION_DISABLED">,
  name: string,
): DurableObjectStub<ExactGate> {
  // Fail closed: only the exact test-only value "1" skips the EU jurisdiction.
  const ns =
    env.DO_JURISDICTION_DISABLED === "1" ? env.EXACT_GATE : env.EXACT_GATE.jurisdiction("eu");
  return ns.get(ns.idFromName(name));
}

/**
 * The transport the Exact client uses from the Worker side: every call is an RPC to the
 * division's ExactGate, which queues, rate-limits and attaches the bearer token. The returned
 * errors are the typed errors from `@camelthorn/exact`.
 */
export function createGateTransport(
  env: Pick<Env, "EXACT_GATE" | "DO_JURISDICTION_DISABLED">,
  division: number,
): ExactTransport {
  if (!Number.isSafeInteger(division) || division < 0) throw new Error("invalid division");
  const stub = getExactGate(env, gateName(division));
  return async (req) => {
    if (req.division !== division) {
      throw new ExactApiError(400, "wrong gate for division", "division_mismatch");
    }
    let result: GateResult;
    try {
      result = await stub.call(req);
    } catch {
      // The RPC itself failed: the gate was evicted, reset by a deploy or overloaded while the
      // request waited. Nothing was sent to Exact for a queued request; for one in flight we
      // cannot know, so callers retry with the same idempotency key (CLAUDE.md 5).
      throw new ExactApiError(503, "exact gate unavailable", "gate_unavailable");
    }
    return unwrap(result);
  };
}
