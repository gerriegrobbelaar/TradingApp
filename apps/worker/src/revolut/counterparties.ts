/**
 * Counterparty lookup for matching (Phase 5 review S6, ADR 0034).
 *
 * A leg of a Revolut transaction names its counterparty by id (and sometimes only that), but
 * matching rule 2 needs the counterparty's IBAN. The sync therefore reads `GET /counterparty/{id}`
 * lazily, for ids it has seen and does not know yet, with a tiny budget per run, and keeps the
 * result in `revolut_counterparties` (a bounded cache). The IBAN is stored in full, copied to the
 * unmatched transactions of that counterparty, and never returned by an API or logged.
 *
 * Freshness: an answer (ok / not_found) is read again after COUNTERPARTY_TTL_MS (7 days) when an
 * unmatched row still depends on it, so matching rule 2 and the IBAN-change checks of Phase 9 are
 * not fed a stale IBAN for ever. A refresh that fails keeps the last answer. An IBAN copied from
 * the cache (`counterparty_iban_cached = 1`) follows a changed answer on unmatched rows; an IBAN
 * Revolut sent on the leg itself, and every matched row, are never rewritten.
 *
 * ASSUMPTIONS (verify with the sandbox, ADR 0030): `GET /counterparty/{id}` answers the same record
 * shape as an element of `GET /counterparties` (id, name, profile_type, accounts[{id, currency,
 * type, iban, ...}]); a leg's `counterparty.account_id` is one of that record's account ids.
 */
import { compactIban } from "@camelthorn/core";
import {
  RevolutAuthError,
  type RevolutClient,
  type RevolutCounterpartyRecord,
} from "@camelthorn/revolut";
import { classifyRevolutError } from "./errors";

export const COUNTERPARTY_REF_RE = /^[A-Za-z0-9_-]{1,100}$/;
/** Counterparty reads per sync run (its own budget in the gate). */
export const COUNTERPARTY_LOOKUPS_PER_RUN = 5;
/** Rows kept per connection; the oldest fetches are pruned beyond this. */
export const COUNTERPARTY_CACHE_MAX = 5000;
/**
 * A failed lookup is retried after this long, at most COUNTERPARTY_MAX_ATTEMPTS times in a row;
 * after that once per COUNTERPARTY_TTL_MS (an outage can never park a counterparty for good).
 */
export const COUNTERPARTY_RETRY_MS = 3600_000;
export const COUNTERPARTY_MAX_ATTEMPTS = 5;
/** An answer (ok or not_found) is refreshed after this long, while a row still depends on it. */
export const COUNTERPARTY_TTL_MS = 7 * 86_400_000;
const MAX_ACCOUNTS = 10;
/** Unmatched rows completed from the cache per run. */
const APPLY_LIMIT = 200;

interface CachedAccount {
  a: string | null;
  i: string;
  c: string | null;
}

function parseAccounts(raw: string | null): CachedAccount[] {
  if (raw === null) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as CachedAccount[]) : [];
  } catch {
    return [];
  }
}

/** The IBAN to use for a leg: the counterparty account the leg names, else the preferred one. */
function pickIban(
  iban: string | null,
  accountsJson: string | null,
  accountRef: string | undefined,
): string | null {
  if (accountRef !== undefined) {
    const hit = parseAccounts(accountsJson).find((a) => a.a === accountRef && a.i);
    if (hit) return hit.i;
  }
  return iban;
}

/** The cached IBAN of a counterparty (null when unknown, not found, or without an IBAN). */
export async function cachedCounterpartyIban(
  db: D1Database,
  connectionId: number,
  ref: string,
  accountRef?: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT iban, accounts_json FROM revolut_counterparties
       WHERE connection_id = ?1 AND counterparty_ref = ?2 AND status = 'ok'`,
    )
    .bind(connectionId, ref)
    .first<{ iban: string | null; accounts_json: string | null }>();
  return row ? pickIban(row.iban, row.accounts_json, accountRef) : null;
}

/** The accounts of a record with an IBAN, compacted; EUR first for the default. */
export function summariseCounterparty(rec: RevolutCounterpartyRecord): {
  iban: string | null;
  accounts: CachedAccount[];
} {
  const accounts: CachedAccount[] = [];
  for (const a of rec.accounts) {
    const iban = compactIban(a.iban);
    if (iban === null || accounts.length >= MAX_ACCOUNTS) continue;
    accounts.push({ a: a.id ?? null, i: iban, c: a.currency ?? null });
  }
  const preferred = accounts.find((a) => a.c === "EUR") ?? accounts[0];
  return { iban: preferred?.i ?? null, accounts };
}

export interface LookupResult {
  /** Counterparty reads attempted (calls). */
  looked: number;
  /** Cache rows written with an IBAN. */
  resolved: number;
  /** Unmatched transaction rows that got an IBAN from the cache. */
  filled: number;
}

/**
 * Counterparty ids to read: named by an unmatched, non-`self` row whose IBAN is missing or came
 * from the cache, and either never cached, failed (retry due), or answered more than 7 days ago.
 * Never-seen ids first, then retries and refreshes; newest rows first within each.
 */
export async function counterpartiesToLookUp(
  db: D1Database,
  connectionId: number,
  nowMs: number,
  limit: number,
): Promise<string[]> {
  const retryBefore = new Date(nowMs - COUNTERPARTY_RETRY_MS).toISOString();
  const ttlBefore = new Date(nowMs - COUNTERPARTY_TTL_MS).toISOString();
  const rows = (
    await db
      .prepare(
        `SELECT t.counterparty_ref AS ref, MAX(t.id) AS newest, MAX(c.id IS NULL) AS fresh
         FROM bank_transactions t
         LEFT JOIN revolut_counterparties c
           ON c.connection_id = t.connection_id AND c.counterparty_ref = t.counterparty_ref
         WHERE t.connection_id = ?1 AND t.counterparty_ref IS NOT NULL
           AND (t.counterparty_iban IS NULL OR t.counterparty_iban_cached = 1)
           AND t.match_status = 'unmatched'
           AND COALESCE(t.counterparty_account_type, '') <> 'self'
           AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.bank_transaction_id = t.id AND m.undone_at IS NULL)
           AND (c.id IS NULL
                OR (c.checked_at <= CASE WHEN c.attempts < ?3 THEN ?2 ELSE ?4 END
                    AND (c.status = 'error' OR c.fetched_at <= ?4)))
         GROUP BY t.counterparty_ref
         ORDER BY fresh DESC, newest DESC LIMIT ?5`,
      )
      .bind(connectionId, retryBefore, COUNTERPARTY_MAX_ATTEMPTS, ttlBefore, limit)
      .all<{ ref: string }>()
  ).results;
  return rows.map((r) => r.ref).filter((r) => COUNTERPARTY_REF_RE.test(r));
}

async function saveLookup(
  db: D1Database,
  connectionId: number,
  ref: string,
  nowIso: string,
  outcome:
    | {
        status: "ok";
        name: string | null;
        type: string | null;
        iban: string | null;
        accounts: CachedAccount[];
      }
    | { status: "not_found" | "error" },
): Promise<void> {
  if (outcome.status === "error") {
    // A failure never replaces an answer: an ok / not_found row keeps its data and status, only
    // the attempt is counted (so the refresh backs off to hourly, then weekly).
    await db
      .prepare(
        `INSERT INTO revolut_counterparties
           (connection_id, counterparty_ref, status, attempts, fetched_at, checked_at)
         VALUES (?1, ?2, 'error', 1, ?3, ?3)
         ON CONFLICT (connection_id, counterparty_ref) DO UPDATE SET
           attempts = revolut_counterparties.attempts + 1, checked_at = excluded.checked_at`,
      )
      .bind(connectionId, ref, nowIso)
      .run();
    return;
  }
  const ok = outcome.status === "ok";
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO revolut_counterparties
           (connection_id, counterparty_ref, status, name, iban, type, accounts_json, attempts,
            fetched_at, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)
         ON CONFLICT (connection_id, counterparty_ref) DO UPDATE SET
           status = excluded.status, name = excluded.name, iban = excluded.iban,
           type = excluded.type, accounts_json = excluded.accounts_json, attempts = 0,
           fetched_at = excluded.fetched_at, checked_at = excluded.checked_at`,
      )
      .bind(
        connectionId,
        ref,
        outcome.status,
        ok ? outcome.name : null,
        ok ? outcome.iban : null,
        ok ? outcome.type : null,
        ok ? JSON.stringify(outcome.accounts) : null,
        nowIso,
      ),
  ];
  if (ok) {
    // An IBAN that came from an earlier answer follows this one on UNMATCHED rows (the account the
    // leg names, else the preferred account; none left = none). Matched rows and IBANs Revolut
    // sent on the leg itself are never touched.
    statements.push(
      db
        .prepare(
          `UPDATE bank_transactions SET
             counterparty_iban = COALESCE(
               (SELECT json_extract(j.value, '$.i') FROM json_each(?4) j
                WHERE json_extract(j.value, '$.a') = bank_transactions.counterparty_account_ref),
               ?3),
             counterparty_iban_cached = CASE WHEN COALESCE(
               (SELECT json_extract(j.value, '$.i') FROM json_each(?4) j
                WHERE json_extract(j.value, '$.a') = bank_transactions.counterparty_account_ref),
               ?3) IS NULL THEN 0 ELSE 1 END
           WHERE connection_id = ?1 AND counterparty_ref = ?2 AND counterparty_iban_cached = 1
             AND match_status = 'unmatched'
             AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.bank_transaction_id = bank_transactions.id
                               AND m.undone_at IS NULL)`,
        )
        .bind(connectionId, ref, outcome.iban, JSON.stringify(outcome.accounts)),
    );
  }
  await db.batch(statements);
}

/** Keeps the cache bounded: the oldest fetches go first. */
async function prune(db: D1Database, connectionId: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM revolut_counterparties
       WHERE connection_id = ?1 AND id NOT IN (
         SELECT id FROM revolut_counterparties WHERE connection_id = ?1
         ORDER BY fetched_at DESC, id DESC LIMIT ?2)`,
    )
    .bind(connectionId, COUNTERPARTY_CACHE_MAX)
    .run();
}

/**
 * Copies cached IBANs to the UNMATCHED transactions of those counterparties that have none yet.
 * A matched (frozen) row is never touched (review S9).
 */
export async function applyCounterpartyCache(
  db: D1Database,
  connectionId: number,
): Promise<number> {
  const rows = (
    await db
      .prepare(
        `SELECT t.id AS id, t.counterparty_account_ref AS account_ref, c.iban AS iban,
                c.accounts_json AS accounts_json
         FROM bank_transactions t
         JOIN revolut_counterparties c
           ON c.connection_id = t.connection_id AND c.counterparty_ref = t.counterparty_ref
         WHERE t.connection_id = ?1 AND t.counterparty_iban IS NULL AND t.match_status = 'unmatched'
           AND c.status = 'ok' AND c.iban IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.bank_transaction_id = t.id AND m.undone_at IS NULL)
         ORDER BY t.id LIMIT ?2`,
      )
      .bind(connectionId, APPLY_LIMIT)
      .all<{ id: number; account_ref: string | null; iban: string; accounts_json: string | null }>()
  ).results;
  if (rows.length === 0) return 0;
  const out = await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `UPDATE bank_transactions SET counterparty_iban = ?2, counterparty_iban_cached = 1
           WHERE id = ?1 AND counterparty_iban IS NULL AND match_status = 'unmatched'
             AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.bank_transaction_id = ?1 AND m.undone_at IS NULL)`,
        )
        .bind(r.id, pickIban(r.iban, r.accounts_json, r.account_ref ?? undefined)),
    ),
  );
  return out.reduce((n, r) => n + r.meta.changes, 0);
}

/**
 * Reads the given counterparty ids (at most `refs.length` calls) and caches the answers. A
 * retryable failure (rate limit, gate, network) ends the loop without recording anything: the id is
 * tried again by the next run. An authentication error propagates. Nothing from a response is
 * logged or put in an error.
 */
export async function lookUpCounterparties(
  db: D1Database,
  client: RevolutClient,
  connectionId: number,
  refs: string[],
  nowMs: number,
  signal: AbortSignal,
): Promise<LookupResult> {
  const result: LookupResult = { looked: 0, resolved: 0, filled: 0 };
  const nowIso = new Date(nowMs).toISOString();
  for (const ref of refs) {
    if (signal.aborted) break;
    result.looked++;
    try {
      const rec = await client.getCounterparty(ref);
      const sum = summariseCounterparty(rec);
      await saveLookup(db, connectionId, ref, nowIso, {
        status: "ok",
        name: rec.name === undefined ? null : rec.name.slice(0, 200),
        type: rec.profileType === undefined ? null : rec.profileType.slice(0, 40),
        iban: sum.iban,
        accounts: sum.accounts,
      });
      if (sum.iban !== null) result.resolved++;
    } catch (e) {
      if (e instanceof RevolutAuthError) throw e;
      const c = classifyRevolutError(e);
      if (c.code === "not_found") {
        await saveLookup(db, connectionId, ref, nowIso, { status: "not_found" });
      } else if (c.retryable) {
        break;
      } else {
        await saveLookup(db, connectionId, ref, nowIso, { status: "error" });
      }
    }
  }
  await prune(db, connectionId);
  result.filled = await applyCounterpartyCache(db, connectionId);
  return result;
}
