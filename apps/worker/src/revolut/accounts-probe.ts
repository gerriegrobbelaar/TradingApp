/**
 * Reads what a freshly staged Revolut connection can see, for the admin to check BEFORE the
 * connection is used (review R2: account substitution). It proves the credentials work and builds
 * a summary of masked facts only: account names, currencies, account holder names and the last 4
 * characters of each IBAN. No balance amount, no Revolut id and no full IBAN leaves this function.
 * Never logs.
 */
import {
  createRevolutClient,
  RevolutApiError,
  type RevolutAccount,
  type RevolutTransport,
} from "@camelthorn/revolut";
import type { PendingSummary } from "./store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bank details are read for at most this many accounts (one gate call each). */
const MAX_DETAIL_CALLS = 10;
const MAX_LISTED = 20;
const MAX_HOLDERS = 5;

/** Printable text, no control characters, bounded. */
function clean(v: string, max: number): string {
  let out = "";
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0;
    // C0/C1 controls, line/paragraph separators and bidi overrides/isolates are dropped.
    const bad =
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069);
    if (!bad) out += ch;
  }
  return out.trim().slice(0, max);
}

/** Last 4 letters/digits of an IBAN, or null if it does not look like one. */
export function ibanLast4(iban: string | undefined): string | null {
  if (iban === undefined) return null;
  const compact = iban.replace(/[\s\u00a0]/g, "").toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(compact) ? compact.slice(-4) : null;
}

export async function inspectAccounts(
  transport: RevolutTransport,
  connectionId: number,
  previousAccountIds: readonly string[],
  stateEchoed: boolean,
): Promise<PendingSummary> {
  const client = createRevolutClient(transport, {
    connectionId,
    jobId: "revolut-connect",
    priority: "user",
    // The connect callback is a browser request: no backoff sleeps, fail fast.
    sleep: async () => undefined,
  });
  let accounts: RevolutAccount[];
  try {
    accounts = await client.listAccounts();
  } catch (e) {
    if (e instanceof RevolutApiError) throw e;
    throw new RevolutApiError(502, "accounts not readable", "accounts_malformed");
  }
  const holders = new Set<string>();
  const listed: PendingSummary["accounts"] = [];
  let detailCalls = 0;
  // Active accounts first, so the details budget goes to the accounts that matter.
  const ordered = [...accounts].sort(
    (a, b) => Number(b.state === "active") - Number(a.state === "active"),
  );
  for (const a of ordered) {
    let last4: string | null = null;
    if (detailCalls < MAX_DETAIL_CALLS && UUID_RE.test(a.id)) {
      detailCalls++;
      try {
        for (const d of await client.getAccountBankDetails(a.id)) {
          last4 ??= ibanLast4(d.iban);
          if (d.beneficiary !== undefined && holders.size < MAX_HOLDERS) {
            const h = clean(d.beneficiary, 100);
            if (h !== "") holders.add(h);
          }
        }
      } catch {
        /* some account types have no bank details: shown without IBAN */
      }
    }
    if (listed.length < MAX_LISTED) {
      listed.push({
        name: clean(a.name, 100) || "Unnamed account",
        currency: a.currency,
        state: a.state,
        last4,
      });
    }
  }
  const ids = new Set(accounts.map((a) => a.id));
  return {
    accountCount: accounts.length,
    currencies: [...new Set(accounts.map((a) => a.currency))].sort(),
    holders: [...holders],
    accounts: listed,
    previousAccounts: previousAccountIds.length,
    matchingAccounts: previousAccountIds.filter((id) => ids.has(id)).length,
    stateEchoed,
  };
}
