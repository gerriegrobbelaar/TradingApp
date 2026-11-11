/**
 * Minimal read of GET /accounts, used by the connect callback to prove the new credentials work.
 * It stands in for the typed client of task R1/R3 (which reads and stores accounts); it keeps
 * nothing but the count. Never logs or returns account data.
 */
import { RevolutApiError, type RevolutTransport } from "@camelthorn/revolut";

/** Number of accounts Revolut lists; throws RevolutApiError if the answer is not a usable list. */
export async function probeAccounts(
  transport: RevolutTransport,
  connectionId: number,
): Promise<number> {
  const res = await transport({
    method: "GET",
    path: "/accounts",
    connectionId,
    priority: "user",
    jobId: "revolut-connect",
  });
  if (res.status < 200 || res.status >= 300) {
    throw new RevolutApiError(res.status, "accounts not readable", "accounts_status");
  }
  let data: unknown;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new RevolutApiError(502, "accounts not readable", "accounts_malformed");
  }
  if (
    !Array.isArray(data) ||
    !data.every((a) => a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string")
  ) {
    throw new RevolutApiError(502, "accounts not readable", "accounts_malformed");
  }
  return data.length;
}
