import { ExactApiError, type ExactTransport } from "@camelthorn/exact";
import type { Env } from "../env";
import type { ExactGate } from "./gate";
import { unwrap, type GateResult } from "./wire";

/** Gate instance name for a division (0 = the "current division" gate used for /current/Me). */
export const gateName = (division: number): string => `exact:${division}`;

type GateNamespace = DurableObjectNamespace<ExactGate>;

/** Production: every ExactGate object lives in the EU jurisdiction (docs/decisions/0018). */
const euNamespace = (ns: GateNamespace): GateNamespace => ns.jurisdiction("eu");
let resolveNamespace: (ns: GateNamespace) => GateNamespace = euNamespace;

/**
 * TEST SEAM ONLY. workerd (Miniflare, the vitest pool) does not implement Durable Object
 * jurisdictions, so the vitest setup file replaces the resolver with the identity function.
 * There is deliberately no environment variable or binding that can switch the jurisdiction off:
 * only code can, and no file under `src/` may call this (a test scans `src/` for it). `null`
 * restores the EU resolver.
 */
export function setGateNamespaceResolverForTests(
  fn: ((ns: GateNamespace) => GateNamespace) | null,
): void {
  resolveNamespace = fn ?? euNamespace;
}

/**
 * The only way to reach an ExactGate instance (division gate `exact:<n>` or token authority
 * `exact-token:<id>`). Durable Object ids depend on the jurisdiction, so every stub must come from
 * the EU namespace (docs/decisions/0018). Never call `EXACT_GATE.idFromName` directly.
 */
export function getExactGate(
  env: Pick<Env, "EXACT_GATE">,
  name: string,
): DurableObjectStub<ExactGate> {
  const ns = resolveNamespace(env.EXACT_GATE);
  return ns.get(ns.idFromName(name));
}

async function viaGate(
  stub: DurableObjectStub<ExactGate>,
  req: Parameters<ExactTransport>[0],
): ReturnType<ExactTransport> {
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
}

/**
 * The transport the Exact client uses from the Worker side: every call is an RPC to the
 * division's ExactGate, which queues, rate-limits and attaches the bearer token. The returned
 * errors are the typed errors from `@camelthorn/exact`. Real divisions only (>= 1); the
 * "current division" has its own transport below.
 */
export function createGateTransport(
  env: Pick<Env, "EXACT_GATE">,
  division: number,
): ExactTransport {
  if (!Number.isSafeInteger(division) || division < 1) throw new Error("invalid division");
  const stub = getExactGate(env, gateName(division));
  return (req) => {
    if (req.division !== division) {
      return Promise.reject(new ExactApiError(400, "wrong gate for division", "division_mismatch"));
    }
    return viaGate(stub, req);
  };
}

/**
 * Division 0 is Exact's "current division" (`/api/v1/current/...`). It exists for `GET /Me` only:
 * this transport refuses everything else, and the gate's own validation (request.ts) refuses
 * division 0 for any other path, so normal divisions are never loosened.
 */
export function createCurrentGateTransport(env: Pick<Env, "EXACT_GATE">): ExactTransport {
  const stub = getExactGate(env, gateName(0));
  return (req) => {
    if (req.division !== 0 || req.api !== "rest" || req.method !== "GET" || req.path !== "/Me") {
      return Promise.reject(new ExactApiError(400, "wrong gate for request", "division_mismatch"));
    }
    return viaGate(stub, req);
  };
}
