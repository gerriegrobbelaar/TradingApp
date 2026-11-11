/**
 * The matching run (Phase 7, ADR 0042): the `bank.match` job. Reads D1, runs the pure core engine
 * per Exact division, writes suggestions and, only when an admin switched it on
 * (`matching.auto_enabled`), automatic matches. INTERNAL ONLY: no Exact or Revolut call.
 *
 * Handler contract (ADR 0021): safe to run twice (a second run changes nothing: suggestions are
 * rewritten only when their input hash changed, matched lines are not selected again), `ctx.signal`
 * is checked between lines, the summary holds counts and fixed codes only.
 */
import {
  explainBlock,
  explainCandidate,
  matchBatch,
  type Candidate,
  type MatchConfig,
  type MatchItem,
  type MatchResult,
  type MatchTx,
} from "@camelthorn/core";
import { sha256Hex } from "../auth/crypto";
import type { HandlerResult, JobContext } from "../jobs/types";
import { assembleItems, assembleTransactions, loadMappings } from "./assemble";
import { loadMatchConfig } from "./config";
import {
  applyMatch,
  MATCH_ENGINE_VERSION,
  suggestionStatements,
  type AllocInput,
  type SuggestionRow,
} from "./store";

/** Statements per db.batch when writing suggestions (D1 allows far more; this keeps batches small). */
const FLUSH_AT = 80;

const safe = (n: bigint): number | null => {
  const v = Number(n);
  return Number.isSafeInteger(v) ? v : null;
};

const bigintJson = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

export function candidateToRow(
  rank: number,
  c: Candidate,
  explanation: string[],
): SuggestionRow | null {
  const allocated = safe(c.allocatedMinor);
  const remaining = safe(c.remainingMinor);
  const surplus = safe(c.surplusMinor);
  if (allocated === null || remaining === null || surplus === null) return null;
  const allocations: { i: number; a: number }[] = [];
  for (const a of c.allocations) {
    const v = safe(a.allocatedMinor);
    if (v === null) return null;
    allocations.push({ i: a.itemId, a: v });
  }
  return {
    rank,
    openItemId: c.itemId,
    ledgerAccountCode: c.ledgerAccountCode,
    score: c.score,
    rule: c.rule,
    kind: c.kind,
    allocatedMinor: allocated,
    remainingMinor: remaining,
    surplusMinor: surplus,
    allocationsJson: JSON.stringify(allocations),
    // Codes and weights only; the engine's free-text `detail` (invoice numbers, patterns) lives in
    // the cleaned explanation lines.
    reasonsJson: JSON.stringify(c.reasons.map((r) => ({ c: r.code, w: r.weight }))),
    blockedJson: JSON.stringify(c.blockedReasons),
    explanationJson: JSON.stringify(explanation),
    autoEligible: c.autoEligible,
    groupId: c.groupId ?? null,
  };
}

async function configDigest(cfg: MatchConfig): Promise<string> {
  return sha256Hex(JSON.stringify({ v: MATCH_ENGINE_VERSION, cfg }, bigintJson));
}

async function itemsDigest(items: MatchItem[]): Promise<string> {
  return sha256Hex(JSON.stringify(items, bigintJson));
}

function txSnapshot(tx: MatchTx): string {
  return JSON.stringify(tx, bigintJson);
}

export interface RunSummary {
  mapped_accounts: number;
  unmapped_accounts: number;
  divisions: number;
  evaluated: number;
  with_candidates: number;
  suggestions_written: number;
  auto_enabled: boolean;
  auto_matched: number;
  skipped_by_reason: Record<string, number>;
  capped: boolean;
}

const SKIP_BY_CODE: Record<string, string> = {
  tx_not_matchable: "lost_race",
  division_mismatch: "division_mismatch",
  match_not_live: "lost_race",
  item_not_matchable: "item_changed",
  alloc_exceeds_open: "item_changed",
  alloc_exceeds_tx: "amount_mismatch",
  cannot_revive: "lost_race",
};

export async function runMatching(ctx: JobContext): Promise<HandlerResult> {
  const db = ctx.env.DB;
  const nowMs = ctx.now();
  const nowIso = new Date(nowMs).toISOString();

  const loaded = await loadMatchConfig(db);
  if (!loaded.settings.enabled) {
    return { status: "skipped", code: "matching_disabled", summary: {} };
  }
  if (!loaded.ok) {
    return {
      status: "error",
      code: loaded.code,
      summary: { problems: loaded.settings.configErrors.length },
    };
  }
  const { config, settings } = loaded;
  const cfgHash = await configDigest(config);

  const { mapped, unmappedAccounts } = await loadMappings(db);
  const summary: RunSummary = {
    mapped_accounts: mapped.length,
    unmapped_accounts: unmappedAccounts,
    divisions: 0,
    evaluated: 0,
    with_candidates: 0,
    suggestions_written: 0,
    auto_enabled: settings.autoEnabled,
    auto_matched: 0,
    skipped_by_reason: {},
    capped: false,
  };
  const skip = (reason: string): void => {
    summary.skipped_by_reason[reason] = (summary.skipped_by_reason[reason] ?? 0) + 1;
  };

  const byDivision = new Map<number, number[]>();
  for (const m of mapped) {
    byDivision.set(m.divisionId, [...(byDivision.get(m.divisionId) ?? []), m.bankAccountId]);
  }
  summary.divisions = byDivision.size;

  let pending: D1PreparedStatement[] = [];
  const flush = async (): Promise<void> => {
    while (pending.length > 0) {
      const chunk = pending.slice(0, FLUSH_AT);
      pending = pending.slice(FLUSH_AT);
      await db.batch(chunk);
    }
  };

  let aborted = false;
  for (const [divisionId, accountIds] of byDivision) {
    if (ctx.signal.aborted) {
      aborted = true;
      break;
    }
    const { txs, status, capped } = await assembleTransactions(db, accountIds, nowMs);
    if (capped) summary.capped = true;
    if (txs.length === 0) continue;
    const items = await assembleItems(db, divisionId);
    const itemsById = new Map(items.map((i) => [i.id, i]));
    const itemsHash = await itemsDigest(items);
    const results = matchBatch(txs, items, config);

    const storedHash = new Map<number, string>();
    {
      const ids = txs.map((t) => t.id);
      for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90);
        const rows = (
          await db
            .prepare(
              `SELECT bank_transaction_id AS id, input_hash FROM match_suggestions
               WHERE rank = 1 AND bank_transaction_id IN (${part.map((_, k) => `?${k + 1}`).join(", ")})`,
            )
            .bind(...part)
            .all<{ id: number; input_hash: string }>()
        ).results;
        for (const r of rows) storedHash.set(r.id, r.input_hash);
      }
    }

    const order = txs
      .map((tx, i) => ({ tx, r: results[i] as MatchResult }))
      .sort((a, b) =>
        a.tx.bookedAt === b.tx.bookedAt
          ? a.tx.id - b.tx.id
          : a.tx.bookedAt < b.tx.bookedAt
            ? -1
            : 1,
      );

    for (const { tx, r } of order) {
      if (ctx.signal.aborted || ctx.now() > ctx.deadlineMs) {
        aborted = true;
        break;
      }
      summary.evaluated++;
      if (r.candidates.length > 0) summary.with_candidates++;
      const currentStatus = status.get(tx.id) ?? "unmatched";

      // Automatic match: opt-in, and only what the engine itself calls automatic.
      if (settings.autoEnabled && r.decision === "auto" && r.chosen !== null) {
        const chosen = r.chosen;
        const allocations: AllocInput[] = [];
        let tooLarge = false;
        for (const a of chosen.allocations) {
          const item = itemsById.get(a.itemId);
          const alloc = safe(a.allocatedMinor < 0n ? -a.allocatedMinor : a.allocatedMinor);
          if (alloc === null || item === undefined) {
            tooLarge = true;
            break;
          }
          const sign = item.openMinor < 0n ? -1n : 1n;
          const after = safe(item.openMinor - sign * BigInt(alloc));
          allocations.push({ openItemId: a.itemId, allocatedMinor: alloc, remainingAfter: after });
        }
        const amount = safe(tx.amountMinor);
        if (tooLarge || amount === null) {
          skip("amount_too_large");
        } else {
          const res = await applyMatch(db, {
            txId: tx.id,
            divisionId,
            txAmountMinor: amount,
            currency: tx.currency,
            source: "auto",
            ledgerAccountCode: chosen.ledgerAccountCode,
            score: chosen.score,
            rule: chosen.rule,
            note: null,
            actor: "system",
            allocations,
            nowIso,
          });
          if (res.ok) summary.auto_matched++;
          else skip(SKIP_BY_CODE[res.code] ?? "other");
          continue;
        }
      }

      // Suggestions: rewrite only when the inputs changed.
      const rows: SuggestionRow[] = [];
      r.candidates.forEach((c, i) => {
        const row = candidateToRow(i + 1, c, explainCandidate(c, { tx, items: itemsById }));
        if (row !== null) rows.push(row);
      });
      const hash = await sha256Hex(`${txSnapshot(tx)}|${itemsHash}|${cfgHash}`);
      const stored = storedHash.get(tx.id);
      if (rows.length === 0) {
        if (currentStatus === "suggested" || stored !== undefined) {
          pending.push(
            ...suggestionStatements(db, tx.id, [], { computedAt: nowIso, inputHash: hash }),
          );
        }
      } else if (stored !== hash || currentStatus !== "suggested") {
        pending.push(
          ...suggestionStatements(db, tx.id, rows, { computedAt: nowIso, inputHash: hash }),
        );
        summary.suggestions_written++;
      }
      if (summary.capped) {
        pending.push(
          db
            .prepare("UPDATE bank_transactions SET match_checked_at = ?2 WHERE id = ?1")
            .bind(tx.id, nowIso),
        );
      }
      if (pending.length >= FLUSH_AT) await flush();
    }
    await flush();
    if (aborted) break;
  }
  await flush();

  return {
    status: aborted ? "partial" : "ok",
    ...(aborted ? { code: "deadline" } : {}),
    summary: { ...summary },
  };
}

/** Plain-English text of a blocked-reason code (core explainBlock, cleaned for unknown codes). */
export const blockedText = (code: string): string => explainBlock(code);
