/**
 * Job `payments.reconcile` (Phase 9, P9b, ADR 0050): every 5 minutes it resolves payments that were
 * sent but are not final yet (see reconcile.ts). READ-ONLY towards Revolut (transaction lookup and
 * draft views, through the gate, job class `revolut-payment:reconcile`), D1 writes only through the
 * P9a state moves. ENABLED by default and inert while nothing is in flight: with no `submitted` or
 * `outcome_unknown` payment it makes no call to Revolut at all.
 */
import { createRevolutClient, PAYMENT_RECONCILE_JOB_ID } from "@camelthorn/revolut";
import type { HandlerResult, JobContext } from "../jobs/types";
import { revolutClientSleep } from "../revolut/client-timing";
import { createRevolutGateTransport, getRevolutGate } from "../revolut/gate-transport";
import { reconcilePayments } from "./reconcile";

/** Most Revolut calls one run may make (the gate enforces it per job id). */
export const RECONCILE_CALL_BUDGET = 120;

class NoConnection extends Error {}

export async function runPaymentsReconcile(ctx: JobContext): Promise<HandlerResult> {
  const db = ctx.env.DB;
  let connectionId: number | null = null;
  try {
    const summary = await reconcilePayments({
      db,
      nowMs: ctx.now(),
      client: async () => {
        const conn = await db
          .prepare(
            "SELECT id FROM connections WHERE kind = 'revolut' AND status = 'active' ORDER BY id LIMIT 1",
          )
          .first<{ id: number }>();
        if (conn === null) throw new NoConnection();
        connectionId = conn.id;
        await getRevolutGate(ctx.env, conn.id).startJob(
          PAYMENT_RECONCILE_JOB_ID,
          RECONCILE_CALL_BUDGET,
        );
        const sleep = revolutClientSleep();
        return createRevolutClient(createRevolutGateTransport(ctx.env, conn.id), {
          connectionId: conn.id,
          jobId: PAYMENT_RECONCILE_JOB_ID,
          priority: "job",
          ...(sleep ? { sleep } : {}),
        });
      },
    });
    return {
      status: summary.errors > 0 ? "partial" : "ok",
      ...(summary.errors > 0 ? { code: "lookup_errors" } : {}),
      summary: { ...summary },
    };
  } catch (e) {
    if (e instanceof NoConnection)
      return { status: "error", code: "no_revolut_connection", summary: {} };
    throw e;
  } finally {
    if (connectionId !== null) {
      try {
        await getRevolutGate(ctx.env, connectionId).endJob(PAYMENT_RECONCILE_JOB_ID);
      } catch {
        // the budget ends on its own
      }
    }
  }
}
