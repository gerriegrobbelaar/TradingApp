/**
 * A Revolut client for one job run, behind the connection's RevolutGate: the run gets its own call
 * budget in the gate (`startJob`), every call is queued and rate-limited there, and `end()` reports
 * how many calls were really made. The gate refuses a call beyond the budget.
 */
import { createRevolutClient, RevolutApiError, type RevolutClient } from "@camelthorn/revolut";
import { createRevolutGateTransport, getRevolutGate } from "./gate-transport";

export interface JobClient {
  client: RevolutClient;
  /** Ends the run's budget in the gate and returns the calls used (0 if the gate is unreachable). */
  end: () => Promise<number>;
}

export async function startJobClient(
  env: Parameters<typeof getRevolutGate>[0],
  connectionId: number,
  jobId: string,
  budget: number,
  priority: "job" | "user" = "job",
): Promise<JobClient> {
  const gate = getRevolutGate(env, connectionId);
  try {
    await gate.startJob(jobId, budget);
  } catch {
    throw new RevolutApiError(503, "revolut gate unavailable", "gate_unavailable");
  }
  const client = createRevolutClient(createRevolutGateTransport(env, connectionId), {
    connectionId,
    jobId,
    priority,
  });
  let ended = false;
  return {
    client,
    end: async () => {
      if (ended) return 0;
      ended = true;
      try {
        return (await gate.endJob(jobId)).used;
      } catch {
        return 0;
      }
    },
  };
}
