import { RevolutApiError, type RevolutTransport } from "@camelthorn/revolut";
import type { Env } from "../env";
import { getEuObject } from "../eu-object";
import type { RevolutGate } from "./gate";
import { unwrap, type GateResult } from "./wire";

/** Gate instance name for a Revolut connection. */
export const revolutGateName = (connectionId: number): string => `revolut:${connectionId}`;

/**
 * The only way to reach a RevolutGate instance. Durable Object ids depend on the jurisdiction, so
 * every stub must come from the EU namespace (docs/decisions/0018). Never use the REVOLUT_GATE
 * binding anywhere else (a test scans `src/` for it).
 */
export function getRevolutGate(
  env: Pick<Env, "REVOLUT_GATE">,
  connectionId: number,
): DurableObjectStub<RevolutGate> {
  if (!Number.isSafeInteger(connectionId) || connectionId < 1)
    throw new Error("invalid connection");
  return getEuObject(env.REVOLUT_GATE, revolutGateName(connectionId));
}

/**
 * The transport the Revolut client uses from the Worker side: every call is an RPC to the
 * connection's RevolutGate, which queues, rate-limits and attaches the bearer token. Errors come
 * back as the typed errors from `@camelthorn/revolut`.
 */
export function createRevolutGateTransport(
  env: Pick<Env, "REVOLUT_GATE">,
  connectionId: number,
): RevolutTransport {
  const stub = getRevolutGate(env, connectionId);
  return async (req) => {
    if (req.connectionId !== connectionId) {
      throw new RevolutApiError(400, "wrong gate for connection", "connection_mismatch");
    }
    let result: GateResult;
    try {
      result = await stub.call(req);
    } catch {
      // The RPC itself failed (evicted, reset by a deploy, overloaded): nothing is known about
      // a request in flight, so callers retry with the same idempotency key (CLAUDE.md 5).
      throw new RevolutApiError(503, "revolut gate unavailable", "gate_unavailable");
    }
    return unwrap(result);
  };
}
