/**
 * Bank matching engine (CLAUDE.md 4.2, ADR 0040). Pure and deterministic: no I/O, no clock, no
 * randomness. The same inputs in any item order give the same result.
 */
import { normalizeIban } from "../iban";
import { referenceContainsInvoiceNumber } from "./reference";
import { explainBlock, explainCandidate, itemLabel } from "./explain";
import type {
  Allocation,
  Candidate,
  LedgerPattern,
  MatchConfig,
  MatchItem,
  MatchResult,
  MatchTx,
  Reason,
  ReasonCode,
} from "./types";

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  autoMatchMinScore: 95,
  autoMatchMinGap: 20,
  suggestMinScore: 50,
  maxCandidates: 5,
  amountToleranceMinor: 0n,
  blockAutoOnRecentIbanChangeDays: 90,
  autoLedgerPatterns: false,
  patterns: [],
};

const MAX_GROUP_SIZE = 5;
const MAX_GROUP_HITS = 8;
const DUE_NEAR_DAYS = 7;
const RULE3_CAP = 70;
const MAX_REGEX_INPUT = 500;

const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const reason = (code: ReasonCode, weight: number, detail?: string): Reason =>
  detail === undefined ? { code, weight } : { code, weight, detail };
const clampScore = (n: number, cap = 100): number => Math.max(0, Math.min(cap, Math.round(n)));

/** Days since epoch for 'YYYY-MM-DD', null when malformed. */
function dayNumber(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(t / 86_400_000);
}

/** The direction of money that settles this item (credit notes flip it). */
function settlingDirection(item: MatchItem): "in" | "out" | null {
  if (item.openMinor === 0n) return null;
  return (item.kind === "receivable") === item.openMinor > 0n ? "in" : "out";
}

// ---- name similarity (bonus only) -------------------------------------------------------------

const LEGAL_WORDS = new Set([
  "bv",
  "nv",
  "cv",
  "vof",
  "gmbh",
  "ag",
  "ltd",
  "limited",
  "llc",
  "inc",
  "sa",
  "sarl",
  "plc",
  "corp",
  "co",
  "kg",
  "srl",
]);

function nameTokens(name: string | null): Set<string> {
  if (!name) return new Set();
  const cleaned = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[.'’]/g, "");
  return new Set(
    cleaned.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0 && !LEGAL_WORDS.has(t)),
  );
}

/** 0-5: Jaccard of name tokens (legal forms and diacritics ignored), 0 below 0.5. */
function nameBonus(a: string | null, b: string | null): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const j = inter / (ta.size + tb.size - inter);
  return j < 0.5 ? 0 : Math.max(1, Math.round(5 * j));
}

// ---- per-item facts ---------------------------------------------------------------------------

interface Info {
  item: MatchItem;
  openAbs: bigint;
  sameCur: boolean;
  refHit: boolean;
  ibanHit: boolean;
  eq: boolean;
  relKey: number;
}

interface Ctx {
  tx: MatchTx;
  cfg: MatchConfig;
  txIban: string | null;
  txDay: number | null;
  refText: string;
  claimed: ReadonlySet<number>;
}

function buildInfo(ctx: Ctx, item: MatchItem): Info {
  const { tx, cfg } = ctx;
  const openAbs = abs(item.openMinor);
  const sameCur = item.currency === tx.currency;
  const numbers = [
    item.invoiceNumber,
    item.yourRef,
    item.kind === "payable" ? item.entryNumber : null,
  ];
  const refHit = numbers.some((n) => referenceContainsInvoiceNumber(ctx.refText, n));
  const ibanHit =
    ctx.txIban !== null && item.relationIbans.some((i) => normalizeIban(i) === ctx.txIban);
  const eq = sameCur && abs(openAbs - tx.amountMinor) <= cfg.amountToleranceMinor;
  return { item, openAbs, sameCur, refHit, ibanHit, eq, relKey: item.relationId ?? -item.id };
}

function blocksFor(ctx: Ctx, items: MatchItem[]): string[] {
  const out = new Set<string>();
  const { tx, cfg } = ctx;
  if (tx.frozen) out.add("tx_frozen");
  if (tx.stateConflict) out.add("tx_state_conflict");
  for (const it of items) {
    if (it.closed) out.add("item_closed");
    if (it.hasLiveMatch) out.add("item_has_live_match");
    if (ctx.claimed.has(it.id)) out.add("claimed_by_earlier_transaction");
    if (it.currency !== tx.currency) out.add("currency_mismatch");
    if (it.kind === "payable") {
      if (ctx.txIban !== null && !it.relationIbans.some((i) => normalizeIban(i) === ctx.txIban)) {
        out.add("iban_not_known_for_supplier");
      }
      for (const stamp of [it.relationIbanAddedAt, it.relationIbanChangedAt]) {
        if (stamp === null) continue;
        const d = dayNumber(stamp);
        if (
          d === null ||
          ctx.txDay === null ||
          ctx.txDay - d <= cfg.blockAutoOnRecentIbanChangeDays
        ) {
          out.add("iban_recently_changed");
        }
      }
    }
  }
  return [...out].sort();
}

function dueNear(ctx: Ctx, item: MatchItem): Reason[] {
  const d = dayNumber(item.dueDate);
  if (d === null || ctx.txDay === null || Math.abs(ctx.txDay - d) > DUE_NEAR_DAYS) return [];
  return [reason("due_date_near", 2)];
}

interface Draft {
  rule: 1 | 2 | 3;
  kind: "full" | "partial" | "overpayment";
  reasons: Reason[];
  cap?: number;
  extraBlocks?: string[];
}

function itemCandidate(ctx: Ctx, info: Info, d: Draft): Candidate {
  const { tx } = ctx;
  const item = info.item;
  const reasons = [...d.reasons];
  const nb = nameBonus(tx.counterpartyName, item.relationName);
  if (nb > 0) reasons.push(reason("name_similar", nb));
  if (d.rule !== 3) reasons.push(...dueNear(ctx, item));
  const mismatch = !info.sameCur;
  const allocated = mismatch ? 0n : d.kind === "partial" ? tx.amountMinor : info.openAbs;
  const remaining = mismatch
    ? info.openAbs
    : d.kind === "partial"
      ? info.openAbs - tx.amountMinor
      : 0n;
  const blocked = [...blocksFor(ctx, [item]), ...(d.extraBlocks ?? [])];
  if (d.kind !== "full") blocked.push("not_full_payment");
  return {
    itemId: item.id,
    ledgerAccountCode: null,
    score: clampScore(
      reasons.reduce((s, r) => s + r.weight, 0),
      d.cap ?? 100,
    ),
    rule: d.rule,
    kind: d.kind,
    allocatedMinor: allocated,
    remainingMinor: remaining,
    reasons,
    autoEligible: false,
    blockedReasons: [...new Set(blocked)].sort(),
    allocations: mismatch ? [] : [{ itemId: item.id, allocatedMinor: allocated }],
  };
}

// ---- rule 1: group of invoices ----------------------------------------------------------------

function groupCandidates(ctx: Ctx, hits: Info[]): Candidate[] {
  if (hits.length < 2 || hits.length > MAX_GROUP_HITS) return [];
  const sorted = [...hits].sort((a, b) => a.item.id - b.item.id);
  const out: Candidate[] = [];
  for (let mask = 1; mask < 1 << sorted.length; mask++) {
    const pick = sorted.filter((_, i) => (mask & (1 << i)) !== 0);
    if (pick.length < 2 || pick.length > MAX_GROUP_SIZE) continue;
    const sum = pick.reduce((s, p) => s + p.openAbs, 0n);
    if (sum !== ctx.tx.amountMinor) continue;
    const allocations: Allocation[] = pick.map((p) => ({
      itemId: p.item.id,
      allocatedMinor: p.openAbs,
    }));
    const reasons = [
      reason("invoice_number_in_reference", 60, pick.map((p) => itemLabel(p.item)).join(", ")),
      reason("group_sum_equals_amount", 37),
    ];
    const nb = Math.max(
      ...pick.map((p) => nameBonus(ctx.tx.counterpartyName, p.item.relationName)),
    );
    if (nb > 0) reasons.push(reason("name_similar", nb));
    out.push({
      itemId: allocations[0]?.itemId ?? null,
      ledgerAccountCode: null,
      score: clampScore(reasons.reduce((s, r) => s + r.weight, 0)),
      rule: 1,
      kind: "full",
      allocatedMinor: sum,
      remainingMinor: 0n,
      reasons,
      autoEligible: false,
      blockedReasons: blocksFor(
        ctx,
        pick.map((p) => p.item),
      ),
      groupId: `g:${pick.map((p) => p.item.id).join("-")}`,
      allocations,
    });
  }
  return out;
}

// ---- rule 4: ledger patterns ------------------------------------------------------------------

function safeTest(re: string, input: string | null): boolean {
  if (input === null) return false;
  try {
    return new RegExp(re, "iu").test(input.slice(0, MAX_REGEX_INPUT));
  } catch {
    return false;
  }
}

function patternMatches(tx: MatchTx, p: LedgerPattern): boolean {
  const t = p.test;
  const hasTest =
    t.counterpartyNameRegex !== undefined ||
    t.referenceRegex !== undefined ||
    t.type !== undefined ||
    t.direction !== undefined ||
    t.maxAmountMinor !== undefined;
  if (!hasTest) return false;
  if (
    t.counterpartyNameRegex !== undefined &&
    !safeTest(t.counterpartyNameRegex, tx.counterpartyName)
  )
    return false;
  if (t.referenceRegex !== undefined) {
    const text = [tx.reference, tx.description].filter((x): x is string => !!x).join(" ");
    if (!safeTest(t.referenceRegex, text || null)) return false;
  }
  if (t.type !== undefined && t.type !== tx.type) return false;
  if (t.direction !== undefined && t.direction !== tx.direction) return false;
  if (t.maxAmountMinor !== undefined && tx.amountMinor > t.maxAmountMinor) return false;
  return true;
}

function patternCandidates(ctx: Ctx): Candidate[] {
  const { tx, cfg } = ctx;
  const out: Candidate[] = [];
  for (const p of cfg.patterns) {
    if (!patternMatches(tx, p)) continue;
    const blocked = blocksFor(ctx, []);
    if (!cfg.autoLedgerPatterns) blocked.push("ledger_auto_disabled");
    out.push({
      itemId: null,
      ledgerAccountCode: p.ledgerAccountCode,
      score: cfg.autoLedgerPatterns ? 95 : 90,
      rule: 4,
      kind: "ledger",
      allocatedMinor: tx.amountMinor,
      remainingMinor: 0n,
      reasons: [reason("pattern", cfg.autoLedgerPatterns ? 95 : 90, p.description)],
      autoEligible: false,
      blockedReasons: blocked.sort(),
      allocations: [],
    });
  }
  return out;
}

// ---- ranking ----------------------------------------------------------------------------------

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.rule !== b.rule) return a.rule - b.rule;
  const ai = a.itemId ?? Number.MAX_SAFE_INTEGER;
  const bi = b.itemId ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  const ac = a.ledgerAccountCode ?? "";
  const bc = b.ledgerAccountCode ?? "";
  if (ac !== bc) return ac < bc ? -1 : 1;
  const ag = a.groupId ?? "";
  const bg = b.groupId ?? "";
  if (ag !== bg) return ag < bg ? -1 : 1;
  return 0;
}

const none = (tx: MatchTx, why: string): MatchResult => ({
  txId: tx.id,
  candidates: [],
  decision: "none",
  chosen: null,
  explanation: [why],
});

function matchOne(
  tx: MatchTx,
  items: MatchItem[],
  cfg: MatchConfig,
  claimed: ReadonlySet<number>,
): MatchResult {
  if (!tx.isFinal || tx.state !== "completed") {
    return none(tx, `Transaction is not final (state ${tx.state}), so it is not matched`);
  }
  if (tx.amountMinor <= 0n || (tx.direction !== "in" && tx.direction !== "out")) {
    return none(tx, "Transaction has no positive amount, so it is not matched");
  }
  const ibanRaw = tx.counterpartyIban ? normalizeIban(tx.counterpartyIban) : "";
  const ctx: Ctx = {
    tx,
    cfg,
    txIban: ibanRaw === "" ? null : ibanRaw,
    txDay: dayNumber(tx.bookedAt),
    refText: [tx.reference, tx.description].filter((x): x is string => !!x).join(" "),
    claimed,
  };

  const infos = items
    .filter((i) => settlingDirection(i) === tx.direction)
    .map((i) => buildInfo(ctx, i))
    .sort((a, b) => a.item.id - b.item.id);

  const all: Candidate[] = [];

  const groups = groupCandidates(
    ctx,
    infos.filter((i) => i.refHit && i.sameCur),
  );
  const grouped = new Set<number>();
  for (const g of groups) for (const a of g.allocations) grouped.add(a.itemId);
  all.push(...groups);

  // Per-relation counts for rule 2, pool size for rule 3.
  const relEq = new Map<number, number>();
  for (const i of infos) {
    if (i.ibanHit && i.eq && !i.item.closed) relEq.set(i.relKey, (relEq.get(i.relKey) ?? 0) + 1);
  }
  const pool = infos.filter((i) => i.eq && !i.item.closed).length;

  for (const info of infos) {
    if (grouped.has(info.item.id)) continue;
    const ibanBonus = info.ibanHit ? [reason("iban_matches_relation", 1)] : [];
    if (info.refHit) {
      const inv = reason("invoice_number_in_reference", 60, itemLabel(info.item));
      if (!info.sameCur) {
        all.push(
          itemCandidate(ctx, info, {
            rule: 1,
            kind: "partial",
            reasons: [
              reason("invoice_number_in_reference", 55, itemLabel(info.item)),
              reason("currency_mismatch", 0),
            ],
          }),
        );
      } else if (info.eq) {
        all.push(
          itemCandidate(ctx, info, {
            rule: 1,
            kind: "full",
            reasons: [inv, reason("amount_equals_open", 39), ...ibanBonus],
          }),
        );
      } else if (tx.amountMinor < info.openAbs) {
        all.push(
          itemCandidate(ctx, info, {
            rule: 1,
            kind: "partial",
            reasons: [inv, reason("amount_partial", 28), ...ibanBonus],
          }),
        );
      } else {
        all.push(
          itemCandidate(ctx, info, {
            rule: 1,
            kind: "overpayment",
            reasons: [inv, reason("amount_over", 10), ...ibanBonus],
          }),
        );
      }
    } else if (info.ibanHit && info.sameCur) {
      const iban = reason("iban_matches_relation", 50);
      const eqCount = relEq.get(info.relKey) ?? 0;
      if (info.eq) {
        const unique = eqCount === 1;
        all.push(
          itemCandidate(ctx, info, {
            rule: 2,
            kind: "full",
            reasons: [
              iban,
              reason("amount_equals_open", 30),
              ...(unique ? [reason("unique_for_relation", 16)] : []),
            ],
          }),
        );
      } else if (eqCount === 0) {
        const less = tx.amountMinor < info.openAbs;
        all.push(
          itemCandidate(ctx, info, {
            rule: 2,
            kind: less ? "partial" : "overpayment",
            reasons: [iban, less ? reason("amount_partial", 10) : reason("amount_over", 5)],
          }),
        );
      }
    } else if (info.eq && !info.item.closed) {
      const single = pool === 1;
      all.push(
        itemCandidate(ctx, info, {
          rule: 3,
          kind: "full",
          cap: RULE3_CAP,
          reasons: [
            single
              ? reason("single_amount_candidate", 70)
              : reason("multiple_amount_candidates", 50),
          ],
          extraBlocks: ["suggestion_only"],
        }),
      );
    }
  }

  all.push(...patternCandidates(ctx));

  const ranked = all.filter((c) => c.score >= cfg.suggestMinScore).sort(compareCandidates);
  const top = ranked[0];
  if (!top) return none(tx, "No open item or ledger pattern fits this transaction");

  // Auto-eligibility: only the top candidate can qualify.
  const second = ranked[1];
  ranked.forEach((c, idx) => {
    const b = new Set(c.blockedReasons);
    if (idx > 0) b.add("not_top_candidate");
    if (c.score < cfg.autoMatchMinScore) b.add("score_below_threshold");
    if (c.kind !== "full" && c.kind !== "ledger") b.add("not_full_payment");
    if (idx === 0 && second && second.score > c.score - cfg.autoMatchMinGap)
      b.add("close_second_candidate");
    c.blockedReasons = [...b].sort();
    c.autoEligible = c.blockedReasons.length === 0;
  });

  const candidates = ranked.slice(0, Math.max(0, cfg.maxCandidates));
  const ectx = { tx, items };
  const explanation = explainCandidate(top, ectx);
  if (top.autoEligible) {
    return { txId: tx.id, candidates, decision: "auto", chosen: top, explanation };
  }
  for (const code of top.blockedReasons) explanation.push(explainBlock(code));
  return { txId: tx.id, candidates, decision: "review", chosen: null, explanation };
}

export function matchTransaction(tx: MatchTx, items: MatchItem[], cfg: MatchConfig): MatchResult {
  return matchOne(tx, items, cfg, new Set());
}

/**
 * Match many transactions against one division's items. Transactions are processed in
 * (bookedAt, id) order; an item auto-claimed by an earlier transaction is blocked for later ones
 * (their candidate stays visible, as review, with `claimed_by_earlier_transaction`). Results are
 * returned in the input order.
 */
export function matchBatch(txs: MatchTx[], items: MatchItem[], cfg: MatchConfig): MatchResult[] {
  const order = txs
    .map((tx, idx) => ({ tx, idx }))
    .sort((a, b) =>
      a.tx.bookedAt === b.tx.bookedAt ? a.tx.id - b.tx.id : a.tx.bookedAt < b.tx.bookedAt ? -1 : 1,
    );
  const claimed = new Set<number>();
  const results: MatchResult[] = new Array<MatchResult>(txs.length);
  for (const { tx, idx } of order) {
    const r = matchOne(tx, items, cfg, claimed);
    if (r.decision === "auto" && r.chosen)
      for (const a of r.chosen.allocations) claimed.add(a.itemId);
    results[idx] = r;
  }
  return results;
}
